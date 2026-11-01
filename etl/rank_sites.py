"""Rank places to open a pharmacy, and say why.

Everything the map shows is descriptive: where people live, where the pharmacies are,
where the doctors are. This turns it into a decision — a score per candidate with its
components exposed, so the answer can be argued with instead of trusted.

Demand comes from the population surfaces (250 m cells inside the surveyed cities, 500 m
elsewhere), competition from the mapped pharmacies *plus* the FDA residual (pharmacies
that exist but were never geocoded — a town with 9 licensed and 2 mapped is not a gap,
it is a mapping gap), anchors from doctors/clinics/hospitals, and access from the road
distance to اهواز.

    python etl/rank_sites.py                 # rank + write site_candidate
    python etl/rank_sites.py --min-pop 2000
    python etl/rank_sites.py --check         # self-test, no writes

Score components are written next to the score, never folded away:

    gap       residents per *accounted* pharmacy within 1.2 km  (the money)
    anchors   clinics + doctors + 2·hospitals within 1.2 km     (prescriptions)
    access    1 / (1 + road_km / 60)                            (supply chain)
    density   demand cells per km²                              (walk-in trade)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
GEO = os.path.join(HOME, "web", "public", "geo")
RADIUS_KM = 1.2            # a pharmacy's realistic catchment in an Iranian town
ANCHOR_W = {"doctor": 1.0, "clinic": 1.4, "hospital": 2.0, "dentist": 0.6, "lab": 0.5}


def hav(a: float, b: float, c: float, d: float) -> float:
    R = 6371.0088
    p1, p2 = math.radians(a), math.radians(c)
    dp = p2 - p1
    dl = math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


class Bucket:
    """Grid index: every query is 'what is within R km of this point'."""

    def __init__(self, step: float = 0.02):
        self.step = step
        self.cells: dict[tuple[int, int], list] = {}

    def key(self, lat: float, lon: float) -> tuple[int, int]:
        return round(lat / self.step), round(lon / self.step)

    def add(self, lat: float, lon: float, payload) -> None:
        self.cells.setdefault(self.key(lat, lon), []).append((lat, lon, payload))

    def near(self, lat: float, lon: float, km: float):
        n = int(km / 2.2) + 1
        ki, kj = self.key(lat, lon)
        for i in range(ki - n, ki + n + 1):
            for j in range(kj - n, kj + n + 1):
                for la, lo, p in self.cells.get((i, j), ()):
                    if hav(lat, lon, la, lo) <= km:
                        yield la, lo, p


def load_demand() -> list[tuple[float, float, float]]:
    out: list[tuple[float, float, float]] = []
    for name in ("urban_pop.json", "pop_province.json"):
        path = os.path.join(GEO, name)
        if not os.path.exists(path):
            continue
        for c in json.load(open(path, encoding="utf-8")).get("cells", []):
            if len(c) >= 3 and c[2] > 0:
                out.append((float(c[0]), float(c[1]), float(c[2])))
    return out


def check() -> int:
    b = Bucket(0.02)
    b.add(31.3189, 48.6842, "x")
    assert any(True for _ in b.near(31.3190, 48.6843, 1.0)), "own point must be found"
    assert not any(True for _ in b.near(32.3810, 48.4050, 1.0)), "Dezful is 130 km away"
    assert abs(hav(31.3189, 48.6842, 31.3189, 48.6842)) < 1e-9
    print("check: bucket + haversine OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-pop", type=float, default=1200.0,
                    help="ignore candidates whose 1.2 km demand is below this")
    ap.add_argument("--top", type=int, default=120, help="how many to keep")
    ap.add_argument("--per-county", type=int, default=6, help="cap per county, so it is not all اهواز")
    ap.add_argument("--min-gap-km", type=float, default=3.0,
                    help="keep recommendations this far apart; 800 m apart is one "
                         "opportunity listed three times")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        return check()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    demand = load_demand()
    print(f"demand cells: {len(demand):,}")

    pharm = Bucket()
    for r in c.execute("SELECT lat, lon, name FROM map_pharmacy"):
        if "دامپزشک" in (r["name"] or "") or "دامی" in (r["name"] or ""):
            continue
        pharm.add(r["lat"], r["lon"], 1)

    # pharmacies the FDA knows about but that were never geocoded: a town with 9
    # licensed and 2 mapped is a mapping gap, not an opportunity
    settlements = [dict(r) for r in c.execute("""
        SELECT name, county, lat, lon, COALESCE(population, 0) AS pop,
               COALESCE(pharmacy_total, 0) AS fda, COALESCE(pharmacy_mapped, 0) AS mapped,
               COALESCE(road_km, est_km) AS road_km
        FROM v_map_settlement WHERE lat IS NOT NULL ORDER BY pop DESC
    """)]
    residual: list[tuple[float, float, float]] = []
    for s in settlements:
        extra = max(0, int(s["fda"]) - int(s["mapped"]))
        if extra <= 0:
            continue
        # spread the un-geocoded licences around the settlement centre, they are
        # somewhere in the town and pretending they are not would inflate every gap
        for i in range(min(extra, 40)):
            ang = (i * 2.399963) % (2 * math.pi)      # golden angle: no clustering
            rr = 0.25 + 0.9 * ((i % 5) / 5)
            residual.append((s["lat"] + rr * math.cos(ang) / 110.57,
                             s["lon"] + rr * math.sin(ang) / (111.32 * math.cos(math.radians(s["lat"]))),
                             1.0))
    print(f"FDA residual placements: {len(residual):,} (licences we could not geocode)")

    med = Bucket()
    for r in c.execute("SELECT lat, lon, kind FROM map_medical"):
        w = ANCHOR_W.get(r["kind"], 0.4)
        med.add(r["lat"], r["lon"], w)

    dem_bucket = Bucket()
    for la, lo, pop in demand:
        dem_bucket.add(la, lo, pop)

    # candidates: every demand cell that is a local maximum of its own catchment
    candidates = []
    seen = set()
    for la, lo, pop in demand:
        if pop < 40:
            continue
        k = (round(la, 2), round(lo, 2))
        if k in seen:
            continue
        seen.add(k)
        near_pop = sum(p for _, _, p in dem_bucket.near(la, lo, RADIUS_KM))
        if near_pop < args.min_pop:
            continue
        supply = sum(1 for _ in pharm.near(la, lo, RADIUS_KM))
        resid = sum(w for _, _, w in pharm.near(la, lo, RADIUS_KM * 1.6)
                    if False)  # placeholder: residual handled below
        anchors = sum(w for _, _, w in med.near(la, lo, RADIUS_KM))
        candidates.append({"lat": la, "lon": lo, "demand": near_pop,
                           "supply": supply, "anchors": anchors})

    # add the FDA residual into the supply of each candidate
    res_bucket = Bucket()
    for la, lo, w in residual:
        res_bucket.add(la, lo, w)
    for cand in candidates:
        cand["supply_mapped"] = cand["supply"]
        cand["supply_expected"] = sum(w for _, _, w in res_bucket.near(cand["lat"], cand["lon"], RADIUS_KM))

    if not candidates:
        print("no candidates")
        return 1

    # access by nearest settlement's road distance to اهواز
    set_bucket = Bucket(0.05)
    for s in settlements:
        set_bucket.add(s["lat"], s["lon"], s)

    def access_of(lat: float, lon: float) -> tuple[float, float, str, str]:
        best = None
        for _, _, s in set_bucket.near(lat, lon, 25.0):
            d = hav(lat, lon, s["lat"], s["lon"])
            if best is None or d < best[0]:
                best = (d, s)
        if not best:
            return 0.0, 0.0, "", ""
        s = best[1]
        road = float(s["road_km"] or 0)
        return 1 / (1 + road / 60), road, s["name"], s["county"] or ""

    for cand in candidates:
        cand["access"], cand["road_km"], cand["settlement"], cand["county"] = access_of(
            cand["lat"], cand["lon"])
        # residents per accounted pharmacy: mapped + expected-but-unmapped
        supply = cand["supply_mapped"] + 0.85 * cand["supply_expected"]
        cand["gap"] = cand["demand"] / max(0.6, supply)
        cand["density"] = cand["demand"] / (math.pi * RADIUS_KM ** 2)

    def norm(key: str) -> dict[int, float]:
        vals = sorted(c[key] for c in candidates)
        lo, hi = vals[int(len(vals) * 0.05)], vals[int(len(vals) * 0.95)]
        span = max(1e-9, hi - lo)
        return {id(c): max(0.0, min(1.0, (c[key] - lo) / span)) for c in candidates}

    n_gap, n_anchor = norm("gap"), norm("anchors")
    n_access, n_density = norm("access"), norm("density")
    for cand in candidates:
        i = id(cand)
        cand["score"] = (0.45 * n_gap[i] + 0.25 * n_anchor[i]
                         + 0.15 * n_density[i] + 0.15 * n_access[i])

    candidates.sort(key=lambda d: -d["score"])
    # county cap: a list of ten اهواز districts is not a recommendation, it is a
    # restatement of where the people already are
    per_county: dict[str, int] = {}
    kept: list[dict] = []
    for cand in candidates:
        cnt = cand["county"] or "?"
        if per_county.get(cnt, 0) >= args.per_county:
            continue
        if any(hav(cand["lat"], cand["lon"], k["lat"], k["lon"]) < args.min_gap_km
               for k in kept):
            continue
        per_county[cnt] = per_county.get(cnt, 0) + 1
        kept.append(cand)
        if len(kept) >= args.top:
            break

    c.execute("""CREATE TABLE IF NOT EXISTS site_candidate (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rank INTEGER, score REAL, lat REAL, lon REAL,
        settlement TEXT, county TEXT, demand REAL, demand_km2 REAL,
        supply_mapped REAL, supply_expected REAL, anchors REAL, road_km REAL,
        gap REAL, reason TEXT,
        generated_at TEXT DEFAULT (datetime('now'))
    )""")
    c.execute("DELETE FROM site_candidate")
    for i, cand in enumerate(kept, 1):
        reason = (
            f"{int(cand['demand']):,} نفر در ۱٫۲ کم · "
            f"{cand['supply_mapped']:.0f} داروخانه (+{cand['supply_expected']:.0f} مجوز ثبت‌نشده) · "
            f"{cand['anchors']:.1f} امتیاز درمانی · {cand['road_km']:.0f} کم از اهواز"
        )
        c.execute("""INSERT INTO site_candidate
            (rank, score, lat, lon, settlement, county, demand, demand_km2,
             supply_mapped, supply_expected, anchors, road_km, gap, reason)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (i, round(cand["score"], 4), round(cand["lat"], 5), round(cand["lon"], 5),
             cand["settlement"], cand["county"], round(cand["demand"]),
             round(cand["density"], 1), cand["supply_mapped"],
             round(cand["supply_expected"], 1), round(cand["anchors"], 2),
             round(cand["road_km"], 1), round(cand["gap"], 1), reason))
    c.commit()

    print(f"\ncandidates {len(candidates):,} → kept {len(kept)} "
          f"({len(per_county)} counties)")
    for i, cand in enumerate(kept[:12], 1):
        print(f"{i:3d}. {cand['score']:.3f}  {cand['settlement'][:18]:20s} "
              f"{cand['county'][:16]:18s} demand {int(cand['demand']):>6,} · "
              f"ph {cand['supply_mapped']:.0f}+{cand['supply_expected']:.0f} · "
              f"anch {cand['anchors']:.1f} · {cand['road_km']:.0f} km")
    return 0


if __name__ == "__main__":
    sys.exit(main())
