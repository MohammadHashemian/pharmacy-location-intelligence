"""
Analysis workspace: filtering, scoring and ranking of Iranian cities/villages for
opening a new pharmacy (داروخانه), using the FDA "ظرفیت" dataset.

Everything here is a plain function over a sqlite3 connection, so the same code
backs both the CLI report and the FastAPI app.

THE SCORE (transparent, tunable)
--------------------------------
Each candidate city is scored 0..100 from five components, each normalised to
[0,1] by *percentile rank inside the current filtered universe* (so the ranking
is always relative to the set you are looking at):

  demand       population of the شهر/روستا                     (bigger  = better)
  access_gap   population per existing pharmacy                (bigger  = better)
               = population / max(pharmacies,1)
  spare        estimated spare capacity                        (bigger  = better)
               = floor(population / target_pop_per_pharmacy) - pharmacies
  competition  in-flight applications of other applicants      (fewer   = better)
               = applied_count = CountMoteghaziDarkhastDade
  entry        حداقل امتیاز (minimum score to be eligible)      (lower   = better)
               = HadaghaleEmtiaz  -> normalised inverted

  score = 100 * Σ w_i * norm_i

NOTES / CAVEATS baked into the app UI
-------------------------------------
* `spare` uses a *user-set* planning assumption (target population per pharmacy),
  it is NOT FDA's official ظرفیت خالی. The published ZarfiatKhali* columns are
  stored and displayed as-is (they are 0/empty in the public report - see
  docs/data-dictionary.md).
* HadaghaleEmtiaz is the entry barrier published per city; compare it with the
  applicant's own امتیاز before treating a city as reachable.
* The score ignores things the dataset cannot see: footfall, insurance mix,
  hospital proximity, rent. It ranks where the *regulatory + demographic* odds
  are best, which is the first screen, not the final answer.
"""
from __future__ import annotations

import csv
import io
import json
import math
from typing import Any, Iterable

from db import DB_PATH, connect

DEFAULT_TARGET_POP_PER_PHARMACY = 5000

DEFAULT_WEIGHTS = {
    "demand": 0.30,
    "access_gap": 0.30,
    "spare": 0.10,
    "competition": 0.15,
    "entry": 0.15,
}

SORTS = {
    "score": "score DESC",
    "population": "population DESC",
    "pop_per_pharmacy": "pop_per_pharmacy DESC",
    "pharmacies": "pharmacies DESC",
    "applications_pending": "applications_pending DESC",
    "hadaghale_emtiaz": "hadaghale_emtiaz ASC",
    "spare": "spare DESC",
    "city": "city ASC",
}


# --------------------------------------------------------------------------- #
# filtering
# --------------------------------------------------------------------------- #
FILTER_SQL = """
FROM v_city v
WHERE 1=1
  {province} {county} {org} {kind} {min_pop} {max_dk} {min_dk}
  {q} {only_spare} {with_apps} {min_entry} {max_entry} {ambig}
"""


def build_where(f: dict) -> tuple[str, list]:
    parts, params = [], []

    # default ON: drop the handful of rows whose population is a metropole value
    # shared with a small neighbouring آبادی (falsely huge pop / tiny pharmacy count).
    if f.get("exclude_ambiguous", True):
        parts.append("AND v.pop_ambiguous = 0")
        parts.append("AND COALESCE(v.name_junk,0) = 0")

    if f.get("province_id"):
        parts.append("AND v.province_id = ?")
        params.append(int(f["province_id"]))
    if f.get("county_id"):
        parts.append("AND v.county_id = ?")
        params.append(int(f["county_id"]))
    if f.get("org_id"):
        parts.append("AND v.shahr_id IN (SELECT shahr_id FROM city_universities WHERE org_id = ?)")
        params.append(int(f["org_id"]))
    kind = (f.get("kind") or "").strip()
    if kind in ("shahr", "roosta"):
        parts.append("AND v.kind = ?")
        params.append(kind)
    if f.get("min_pop") not in (None, "", 0):
        parts.append("AND v.population >= ?")
        params.append(int(f["min_pop"]))
    if f.get("max_pop") not in (None, ""):
        parts.append("AND v.population <= ?")
        params.append(int(f["max_pop"]))
    if f.get("max_dk") not in (None, ""):
        parts.append("AND v.pharmacies <= ?")
        params.append(int(f["max_dk"]))
    if f.get("min_dk") not in (None, ""):
        parts.append("AND v.pharmacies >= ?")
        params.append(int(f["min_dk"]))
    if f.get("min_entry") not in (None, ""):
        parts.append("AND v.hadaghale_emtiaz >= ?")
        params.append(int(f["min_entry"]))
    if f.get("max_entry") not in (None, ""):
        parts.append("AND v.hadaghale_emtiaz <= ?")
        params.append(int(f["max_entry"]))
    if f.get("with_apps"):
        parts.append("AND COALESCE(v.applications_pending,0) > 0")
    q = (f.get("q") or "").strip()
    if q:
        parts.append("AND (v.city LIKE ? OR v.county LIKE ? OR v.province LIKE ? OR v.university LIKE ?)")
        params.extend([f"%{q}%"] * 4)

    sql = FILTER_SQL.format(
        province="", county="", org="", kind="", min_pop="", max_dk="", min_dk="",
        q="", only_spare="", with_apps="", min_entry="", max_entry="", ambig="",
    ).replace("WHERE 1=1", "WHERE 1=1 " + " ".join(parts))
    return sql, params


def _rows(con, sql: str, params: Iterable[Any] = ()) -> list[dict]:
    return [dict(r) for r in con.execute(sql, list(params))]


def _percentile(values: list[float]) -> dict[float, float]:
    """Average-rank percentile in [0,1] for the given values."""
    if not values:
        return {}
    s = sorted(values)
    n = len(s)
    out: dict[float, float] = {}
    i = 0
    while i < n:
        j = i
        while j + 1 < n and s[j + 1] == s[i]:
            j += 1
        rank = (i + j) / 2.0
        p = rank / (n - 1) if n > 1 else 1.0
        out[s[i]] = p
        i = j + 1
    return out


def _norm_key(v) -> float:
    """Percentile key: treat None as 0 (worst) without losing the real zeros."""
    if v is None:
        return -1.0
    try:
        x = float(v)
    except (TypeError, ValueError):
        return -1.0
    return x if not math.isnan(x) else -1.0


# --------------------------------------------------------------------------- #
# main query
# --------------------------------------------------------------------------- #
def query(con, filters: dict | None = None, weights: dict | None = None,
          target_pop_per_pharmacy: float = DEFAULT_TARGET_POP_PER_PHARMACY,
          sort: str = "score", limit: int = 100, offset: int = 0,
          with_score: bool = True) -> dict:
    """Filtered + optionally scored city list. Returns {total, rows, params}."""
    filters = filters or {}
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    where, params = build_where(filters)

    rows = _rows(con, f"SELECT v.* {where}", params)
    total = len(rows)

    if not with_score:
        order = SORTS.get(sort, SORTS["score"]).replace("score", "population")
        out = _rows(con, f"SELECT v.* {where} ORDER BY {order} LIMIT ? OFFSET ?",
                    params + [limit, offset])
        return {"total": total, "rows": out, "filters": filters}

    for r in rows:
        pop = r.get("population") or 0
        dk = r.get("pharmacies") or 0
        r["pop_per_pharmacy"] = round(pop / dk, 1) if dk > 0 else (pop if pop else None)
        r["est_target_pharmacies"] = int(pop // target_pop_per_pharmacy) if pop else 0
        r["spare"] = int(r["est_target_pharmacies"] - dk)
        r["pharmacies_per_100k"] = round(dk * 100000.0 / pop, 2) if pop else None
        r["_demand"] = _norm_key(pop)
        r["_access"] = _norm_key(r["pop_per_pharmacy"])
        r["_spare"] = _norm_key(r["spare"])
        r["_comp"] = _norm_key(r.get("applications_pending") or 0)
        r["_entry"] = _norm_key(r.get("hadaghale_emtiaz"))

    p_demand = _percentile([r["_demand"] for r in rows])
    p_access = _percentile([r["_access"] for r in rows])
    p_spare = _percentile([r["_spare"] for r in rows])
    p_comp = _percentile([r["_comp"] for r in rows])
    p_entry = _percentile([r["_entry"] for r in rows])

    for r in rows:
        demand = p_demand.get(r["_demand"], 0.0)
        access = p_access.get(r["_access"], 0.0)
        spare = p_spare.get(r["_spare"], 0.0)
        comp = 1.0 - p_comp.get(r["_comp"], 0.0)
        entry = 1.0 - p_entry.get(r["_entry"], 0.0)
        r["score_components"] = {
            "demand": round(demand * 100, 1),
            "access_gap": round(access * 100, 1),
            "spare": round(spare * 100, 1),
            "competition": round(comp * 100, 1),
            "entry": round(entry * 100, 1),
        }
        r["score"] = round(100 * (
            weights["demand"] * demand + weights["access_gap"] * access +
            weights["spare"] * spare + weights["competition"] * comp +
            weights["entry"] * entry), 1)
        for k in ("_demand", "_access", "_spare", "_comp", "_entry"):
            r.pop(k, None)

    order = SORTS.get(sort, SORTS["score"])
    col, direction = order.split()
    rows.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=(direction == "DESC"))

    return {"total": total, "rows": rows[offset:offset + limit],
            "weights": weights, "target_pop_per_pharmacy": target_pop_per_pharmacy}


# --------------------------------------------------------------------------- #
# aggregates / detail
# --------------------------------------------------------------------------- #
def meta(con) -> dict:
    m = {}
    for r in con.execute("SELECT key,value FROM meta"):
        m[r["key"]] = r["value"]
    m["provinces"] = _rows(con, "SELECT id, name FROM provinces ORDER BY name")
    m["universities"] = _rows(con, "SELECT id, name FROM universities ORDER BY name")
    m["counties"] = _rows(con, "SELECT id, name, province_id FROM counties ORDER BY name")
    m["totals"] = {
        "cities": con.execute("SELECT COUNT(*) FROM cities").fetchone()[0],
        "shahr": con.execute("SELECT COUNT(*) FROM cities WHERE kind='shahr'").fetchone()[0],
        "roosta": con.execute("SELECT COUNT(*) FROM cities WHERE kind='roosta'").fetchone()[0],
        "population": con.execute("SELECT SUM(jamiat) FROM city_stats").fetchone()[0],
        "pharmacies": con.execute("SELECT SUM(dk_total) FROM city_stats").fetchone()[0],
        "raw_rows": con.execute("SELECT COUNT(*) FROM raw_rows").fetchone()[0],
        "zk_rouzaneh_sum": con.execute("SELECT SUM(zk_rouzaneh_sum) FROM city_stats").fetchone()[0],
        "zk_shabaneh_sum": con.execute("SELECT SUM(zk_shabaneh_sum) FROM city_stats").fetchone()[0],
        "excluded_ambiguous": con.execute(
            "SELECT COUNT(*) FROM v_city WHERE pop_ambiguous = 1").fetchone()[0],
        "excluded_name_junk": con.execute(
            "SELECT COUNT(*) FROM v_city WHERE COALESCE(name_junk,0) = 1").fetchone()[0],
        "cities_without_pharmacy": con.execute(
            "SELECT COUNT(*) FROM v_city WHERE kind='shahr' AND COALESCE(pharmacies,0)=0").fetchone()[0],
    }
    return m


def province_summary(con, filters: dict | None = None, target: float = DEFAULT_TARGET_POP_PER_PHARMACY) -> list[dict]:
    filters = filters or {}
    where, params = build_where(filters)
    sql = f"""
    SELECT v.province_id, v.province,
           COUNT(*)                                  AS cities,
           SUM(v.population)                         AS population,
           SUM(COALESCE(v.pharmacies,0))             AS pharmacies,
           SUM(COALESCE(v.applications_pending,0))   AS applications_pending,
           SUM(COALESCE(v.applications_total,0))     AS applications_total,
           SUM(CASE WHEN COALESCE(v.pharmacies,0)=0 AND COALESCE(v.population,0)>0 THEN 1 ELSE 0 END) AS cities_without_pharmacy
    {where}
    GROUP BY v.province_id, v.province
    ORDER BY population DESC
    """
    out = _rows(con, sql, params)
    for r in out:
        pop = r["population"] or 0
        dk = r["pharmacies"] or 0
        r["population"] = pop
        r["pharmacies"] = dk
        r["pop_per_pharmacy"] = round(pop / dk, 1) if dk else None
        r["pharmacies_per_100k"] = round(dk * 100000.0 / pop, 2) if pop else None
        r["est_spare"] = int(pop // target) - dk
    return out


def history(con, shahr_id: int) -> list[dict]:
    """Every raw API row ever seen for one city (audit / change detection)."""
    return _rows(con, "SELECT source_page, loaded_at, payload FROM raw_rows "
                      "WHERE ShahrID = ? ORDER BY loaded_at", [shahr_id])


def city_detail(con, shahr_id: int) -> dict | None:
    r = _rows(con, "SELECT * FROM v_city WHERE shahr_id = ?", [shahr_id])
    if not r:
        return None
    city = r[0]
    city["universities"] = _rows(
        con, "SELECT u.id, u.name FROM city_universities cu JOIN universities u ON u.id=cu.org_id "
             "WHERE cu.shahr_id = ?", [shahr_id])
    if city.get("county_id"):
        city["county_peers"] = _rows(con, """
            SELECT city, population, pharmacies, applications_pending, hadaghale_emtiaz
            FROM v_city WHERE county_id = ? AND shahr_id <> ?
            ORDER BY population DESC LIMIT 15""", [city["county_id"], shahr_id])
    return city


# --------------------------------------------------------------------------- #
# export
# --------------------------------------------------------------------------- #
EXPORT_COLS = [
    ("shahr_id", "کد شهر"), ("city", "شهر/روستا"), ("kind", "نوع"), ("county", "شهرستان"),
    ("province", "استان"), ("university", "دانشگاه"), ("population", "جمعیت"),
    ("pharmacies", "داروخانه (کل)"), ("dk_haghighi", "داروخانه حقیقی"),
    ("dk_hoghoghi", "داروخانه حقوقی"), ("pop_per_pharmacy", "جمعیت به ازای هر داروخانه"),
    ("pharmacies_per_100k", "داروخانه در ۱۰۰ هزار نفر"),
    ("applications_pending", "درخواست در جریان"), ("applications_total", "کل درخواست‌ها"),
    ("hadaghale_emtiaz", "حداقل امتیاز"), ("emtiaz_shahr", "امتیاز شهر"),
    ("est_target_pharmacies", "داروخانه هدف (تخمین)"), ("spare", "ظرفیت خالی تخمینی"),
    ("score", "امتیاز فرصت"),
]


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([fa for _, fa in EXPORT_COLS])
    for r in rows:
        w.writerow([r.get(k, "") if r.get(k) is not None else "" for k, _ in EXPORT_COLS])
    return "\ufeff" + buf.getvalue()          # BOM so Excel opens Persian correctly


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Rank Iranian cities for a new pharmacy")
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--province", type=int)
    ap.add_argument("--county", type=int)
    ap.add_argument("--org", type=int)
    ap.add_argument("--kind", choices=["shahr", "roosta"])
    ap.add_argument("--min-pop", type=int, default=0)
    ap.add_argument("--max-dk", type=int)
    ap.add_argument("--max-entry", type=int)
    ap.add_argument("--target", type=float, default=DEFAULT_TARGET_POP_PER_PHARMACY)
    ap.add_argument("--sort", default="score", choices=list(SORTS))
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--csv", help="write the full ranked list to this CSV path")
    args = ap.parse_args()

    con = connect(args.db)
    filters = {"province_id": args.province, "county_id": args.county, "org_id": args.org,
               "kind": args.kind, "min_pop": args.min_pop, "max_dk": args.max_dk,
               "max_entry": args.max_entry}
    res = query(con, filters, target_pop_per_pharmacy=args.target,
                sort=args.sort, limit=10 ** 9)
    rows = res["rows"]
    print(f"# {res['total']} candidates match the filters\n")
    hdr = ("rank", "city", "county", "province", "pop", "dk", "pend", "minScore", "spare", "score")
    print("{:>4} {:<26} {:<20} {:<14} {:>9} {:>5} {:>5} {:>8} {:>6} {:>6}".format(*hdr))
    for i, r in enumerate(rows[: args.top], 1):
        print("{:>4} {:<26} {:<20} {:<14} {:>9,} {:>5} {:>5} {:>8} {:>6} {:>6}".format(
            i, (r["city"] or "")[:26], (r["county"] or "")[:20], (r["province"] or "")[:14],
            r["population"] or 0, r["pharmacies"] or 0, r["applications_pending"] or 0,
            r["hadaghale_emtiaz"] or 0, r["spare"], r["score"]))
    if args.csv:
        with open(args.csv, "w", encoding="utf-8", newline="") as fh:
            fh.write(to_csv(rows))
        print(f"\n[export] {len(rows)} rows -> {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
