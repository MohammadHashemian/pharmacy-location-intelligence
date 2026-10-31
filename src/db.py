"""
SQLite schema + loader for the FDA Iran "ظرفیت داروخانه" (pharmacy capacity) dataset.

Source: https://pharmacy.fda.gov.ir/nemayeshZarfiatShahrSearch
Endpoint: GET /app/api/TaghsimatKeshvari/GetVaziatShowShahrestanAndOStanQueryAsync
Raw pages live in data/raw/zarfiat_pages/page_*.json (see src/fetch_zarfiat.py).

Grain of the API: ONE ROW PER (شهر/روستا, دانشگاه) COMBINATION.
Verified on the live data: every measure (Jamiat, CountDaroukhaneh, EmtiazShahr,
HadaghaleEmtiaz, ...) is identical for all rows sharing a ShahrID; only
OrganizationID differs when more than one medical university is mapped to a city.
So the clean analytical grain is ShahrID.

Tables
------
raw_rows            verbatim API rows (audit trail, nothing dropped)
universities        OrganizationID -> name (دانشگاه علوم پزشکی)
provinces           OstanID      -> name (استان)
counties            ShahrestanID -> name (شهرستان) + province
districts           BakhsID      -> name (بخش) + county
cities              ShahrID      -> name (شهر/روستا), kind, geography, primary university
city_universities   ShahrID x OrganizationID (many-to-many)
city_stats          one row per ShahrID with all numeric measures (analysis table)
v_city              flattened view for the app: city + geo names + metrics + derived ratios
meta                scrape/snapshot bookkeeping
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "pharmacy.sqlite"
PAGES = ROOT / "data" / "raw" / "zarfiat_pages"

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS raw_rows (
    row_hash  TEXT PRIMARY KEY,
    OstanID        INTEGER,
    ShahrID        INTEGER,
    BakhsID        INTEGER,
    ShahrestanID   INTEGER,
    OrganizationID INTEGER,
    payload   TEXT NOT NULL,
    source_page TEXT,
    loaded_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_raw_shahr ON raw_rows(ShahrID);

CREATE TABLE IF NOT EXISTS universities (
    id   INTEGER PRIMARY KEY,
    name TEXT
);

CREATE TABLE IF NOT EXISTS provinces (
    id   INTEGER PRIMARY KEY,
    name TEXT
);

CREATE TABLE IF NOT EXISTS counties (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    province_id INTEGER
);

CREATE TABLE IF NOT EXISTS districts (
    id        INTEGER PRIMARY KEY,
    name      TEXT,
    county_id INTEGER
);

CREATE TABLE IF NOT EXISTS cities (
    id            INTEGER PRIMARY KEY,          -- ShahrID
    name          TEXT,                         -- shahrRoustaOnvan
    kind          TEXT,                         -- 'shahr' | 'roosta' (inferred from the name)
    province_id   INTEGER,
    county_id     INTEGER,
    district_id   INTEGER,
    org_id        INTEGER,                      -- primary (lowest-id) university
    n_universities INTEGER DEFAULT 1,
    -- the source contains a handful of placeholder rows (name "**", "-", empty)
    -- that carry a full metropole population; flag them so they never top a ranking
    name_junk     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_cities_county  ON cities(county_id);
CREATE INDEX IF NOT EXISTS ix_cities_prov    ON cities(province_id);

CREATE TABLE IF NOT EXISTS city_universities (
    shahr_id INTEGER,
    org_id   INTEGER,
    PRIMARY KEY (shahr_id, org_id)
);

CREATE TABLE IF NOT EXISTS city_stats (
    shahr_id            INTEGER PRIMARY KEY,
    jamiat              INTEGER,   -- جمعیت شهر/روستا  (population)
    dk_haghighi         INTEGER,   -- تعداد داروخانه حقیقی (private/physical-person pharmacies)
    dk_hoghoghi         INTEGER,   -- تعداد داروخانه حقوقی (legal-entity pharmacies)
    dk_total            INTEGER,   -- derived: haghighi + hoghoghi
    zarib_haghighi      REAL,      -- نسبت داروخانه حقیقی به جمعیت × ۱٫۰۰۰٫۰۰۰
    zarib_hoghoghi      REAL,
    emtiaz_shahr        INTEGER,   -- امتیاز شهر
    sum_emtiaz          INTEGER,   -- مجموع امتیاز متقاضیان
    hadaghale_emtiaz    INTEGER,   -- حداقل امتیاز لازم برای ورود به آن شهر
    moteghazi           INTEGER,   -- تعداد کل درخواستهای ثبتشده
    moteghazi_dade      INTEGER,   -- درخواستهای در جریان
    moteghazi_taeed     INTEGER,   -- موافقت اصولی صادرشده
    tedad_rouzaneh      INTEGER,
    tedad_shabaneh      INTEGER,
    zk_rouzaneh         INTEGER,   -- ظرفیت خالی روزانه (as published)
    zk_shabaneh         INTEGER,
    zk_rouzaneh_sum     INTEGER,
    zk_shabaneh_sum     INTEGER,
    shahr_jamiat_id     TEXT,
    shahr_emtiaz_id     TEXT,
    tarikh_ejra_jamiat  TEXT,
    tarikh_ejra_emtiaz  TEXT,
    zarib               TEXT,
    -- data-quality guard: how many ShahrIDs nationwide share this exact Jamiat
    -- (only meaningful for large values; 2+ means a metropole population may have
    --  been attached to a small neighbour, e.g. تهران بزرگ / شهر تجريش = 8,154,051)
    pop_shared_big      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS city_extra_fields (
    shahr_id INTEGER,
    field    TEXT,
    value    TEXT,
    PRIMARY KEY (shahr_id, field)
);

DROP VIEW IF EXISTS v_city;
CREATE VIEW v_city AS
SELECT
    c.id                AS shahr_id,
    c.name              AS city,
    c.kind              AS kind,
    COALESCE(c.name_junk,0) AS name_junk,
    p.name              AS province,
    c.province_id       AS province_id,
    co.name             AS county,
    c.county_id         AS county_id,
    d.name              AS district,
    u.name              AS university,
    c.org_id            AS org_id,
    s.jamiat            AS population,
    s.dk_haghighi       AS dk_haghighi,
    s.dk_hoghoghi       AS dk_hoghoghi,
    s.dk_total          AS pharmacies,
    s.zarib_haghighi    AS zarib_haghighi,
    s.emtiaz_shahr      AS emtiaz_shahr,
    s.hadaghale_emtiaz  AS hadaghale_emtiaz,
    s.moteghazi         AS applications_total,
    s.moteghazi_dade    AS applications_pending,
    s.moteghazi_taeed   AS applications_approved,
    s.zk_rouzaneh_sum   AS zk_rouzaneh,
    s.zk_shabaneh_sum   AS zk_shabaneh,
    s.tedad_rouzaneh    AS tedad_rouzaneh,
    s.tedad_shabaneh    AS tedad_shabaneh,
    COALESCE(s.pop_shared_big,0) AS pop_shared_big,
    CASE WHEN COALESCE(s.pop_shared_big,0) >= 2 THEN 1 ELSE 0 END AS pop_ambiguous,
    CASE WHEN s.dk_total > 0 THEN CAST(s.jamiat AS REAL) / s.dk_total END AS pop_per_pharmacy
FROM cities c
LEFT JOIN provinces p  ON p.id  = c.province_id
LEFT JOIN counties  co ON co.id = c.county_id
LEFT JOIN districts d  ON d.id  = c.district_id
LEFT JOIN universities u ON u.id = c.org_id
LEFT JOIN city_stats s ON s.shahr_id = c.id;
"""

NUM_INT = ["Jamiat", "CountDaroukhaneh", "CountDaroukhanehHoghoghi", "EmtiazShahr",
           "SumEmtiaz", "HadaghaleEmtiaz", "CountMoteghazi",
           "CountMoteghaziDarkhastDade", "CountMoteghaziDarkhastTaeedShode",
           "TedadRouzaneh", "TedadShabanehRoozi", "ZarfiatKhaliRozaneh",
           "ZarfiatKhaliShabaneh", "ZarfiatKhaliRozanehSum", "ZarfiatKhaliShabanehSum"]
NUM_REAL = ["ZaribHaghighi", "ZaribHoghoghi"]


def _to_int(v):
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _to_real(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):      # e.g. "inf" / "#DIV/0!" style strings
        return None


def _kind(name: str | None) -> str:
    n = (name or "").strip()
    return "roosta" if n.startswith("روستا") else "shahr"


def _name_junk(name: str | None) -> int:
    """1 for placeholder names ("**", "-", "", "??") that must never top a ranking."""
    n = (name or "").strip()
    if not n or "*" in n:
        return 1
    has_letter = any(("\u0600" <= ch <= "\u06FF") or ch.isalpha() for ch in n)
    return 0 if has_letter else 1


def connect(db_path: Path | str = DB_PATH) -> sqlite3.Connection:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    return con


def init_db(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    con.commit()


def page_files(pages_dir: Path = PAGES) -> list[Path]:
    return sorted(pages_dir.glob("page_*.json"))


def iter_records(pages_dir: Path = PAGES):
    for f in page_files(pages_dir):
        payload = json.loads(f.read_text(encoding="utf-8"))
        for rec in payload.get("data", {}).get("records", []):
            yield rec, f.name


def load(con: sqlite3.Connection, pages_dir: Path = PAGES, verbose: bool = True) -> dict:
    """Load every page into raw_rows + build the normalised tables. Idempotent."""
    init_db(con)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    rows = []
    for rec, src in iter_records(pages_dir):
        payload = json.dumps(rec, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha1(f"{rec.get('ShahrID')}|{rec.get('OrganizationID')}|{payload}"
                         .encode("utf-8")).hexdigest()
        rows.append((h, rec.get("OstanID"), rec.get("ShahrID"), rec.get("BakhsID"),
                     rec.get("ShahrestanID"), rec.get("OrganizationID"), payload, src, now))

    con.executemany(
        "INSERT OR REPLACE INTO raw_rows(row_hash,OstanID,ShahrID,BakhsID,ShahrestanID,"
        "OrganizationID,payload,source_page,loaded_at) VALUES (?,?,?,?,?,?,?,?,?)", rows)
    con.commit()

    # ---- dimensions -------------------------------------------------------- #
    universities, provinces, counties, districts = {}, {}, {}, {}
    cities, city_orgs, stats = {}, {}, {}

    for h, o, sh, bk, st, org, payload, src, ts in rows:
        r = json.loads(payload)
        if st is not None:
            counties.setdefault(st, (r.get("ShahrestanOnvan"), r.get("OstanID")))
        if bk is not None:
            districts.setdefault(bk, (r.get("bakhshOnvan"), st))
        if o is not None:
            provinces.setdefault(o, r.get("OstanOnvan"))
        if org is not None:
            universities.setdefault(org, r.get("OrganOnvan"))
        if sh is None:
            continue
        cur_org = cities.get(sh, (10**9,))
        cities[sh] = (
            r.get("shahrRoustaOnvan"), r.get("OstanID"), r.get("ShahrestanID"),
            r.get("BakhsID"), min(cur_org[4] if len(cur_org) > 4 else 10**9, org or 10**9),
        )
        if org is not None:
            city_orgs[(sh, org)] = 1
        if sh not in stats:                       # measures are ShahrID-invariant
            stats[sh] = (
                sh,
                _to_int(r.get("Jamiat")),
                _to_int(r.get("CountDaroukhaneh")),
                _to_int(r.get("CountDaroukhanehHoghoghi")),
                (_to_int(r.get("CountDaroukhaneh")) or 0) + (_to_int(r.get("CountDaroukhanehHoghoghi")) or 0),
                _to_real(r.get("ZaribHaghighi")),
                _to_real(r.get("ZaribHoghoghi")),
                _to_int(r.get("EmtiazShahr")),
                _to_int(r.get("SumEmtiaz")),
                _to_int(r.get("HadaghaleEmtiaz")),
                _to_int(r.get("CountMoteghazi")),
                _to_int(r.get("CountMoteghaziDarkhastDade")),
                _to_int(r.get("CountMoteghaziDarkhastTaeedShode")),
                _to_int(r.get("TedadRouzaneh")),
                _to_int(r.get("TedadShabanehRoozi")),
                _to_int(r.get("ZarfiatKhaliRozaneh")),
                _to_int(r.get("ZarfiatKhaliShabaneh")),
                _to_int(r.get("ZarfiatKhaliRozanehSum")),
                _to_int(r.get("ZarfiatKhaliShabanehSum")),
                r.get("ShahrJamiatID"), r.get("ShahrEmtiazID"),
                r.get("TarikhEjraShahrJamiat"), r.get("TarikhEjraShahrEmtiaz"),
                r.get("Zarib"),
            )

    con.executemany("INSERT OR REPLACE INTO universities(id,name) VALUES (?,?)",
                    [(k, v) for k, v in universities.items()])
    con.executemany("INSERT OR REPLACE INTO provinces(id,name) VALUES (?,?)",
                    [(k, v) for k, v in provinces.items()])
    con.executemany("INSERT OR REPLACE INTO counties(id,name,province_id) VALUES (?,?,?)",
                    [(k, v[0], v[1]) for k, v in counties.items()])
    con.executemany("INSERT OR REPLACE INTO districts(id,name,county_id) VALUES (?,?,?)",
                    [(k, v[0], v[1]) for k, v in districts.items()])

    city_rows = []
    for sh, v in cities.items():
        name, prov, cty, dst, org = (list(v) + [None] * 5)[:5]
        city_rows.append((sh, name, _kind(name), prov, cty, dst,
                          None if org == 10**9 else org, 0, _name_junk(name)))
    con.executemany(
        "INSERT OR REPLACE INTO cities(id,name,kind,province_id,county_id,district_id,org_id,"
        "n_universities,name_junk) VALUES (?,?,?,?,?,?,?,?,?)", city_rows)

    con.executemany("INSERT OR REPLACE INTO city_universities(shahr_id,org_id) VALUES (?,?)",
                    list(city_orgs.keys()))
    con.execute("UPDATE cities SET n_universities = "
                "(SELECT COUNT(*) FROM city_universities cu WHERE cu.shahr_id = cities.id)")
    con.executemany(
        "INSERT OR REPLACE INTO city_stats(shahr_id,jamiat,dk_haghighi,dk_hoghoghi,dk_total,"
        "zarib_haghighi,zarib_hoghoghi,emtiaz_shahr,sum_emtiaz,hadaghale_emtiaz,moteghazi,"
        "moteghazi_dade,moteghazi_taeed,tedad_rouzaneh,tedad_shabaneh,zk_rouzaneh,zk_shabaneh,"
        "zk_rouzaneh_sum,zk_shabaneh_sum,shahr_jamiat_id,shahr_emtiaz_id,tarikh_ejra_jamiat,"
        "tarikh_ejra_emtiaz,zarib) VALUES (" + ",".join("?" * 24) + ")", stats.values())

    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('loaded_at',?)", (now,))
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('pages_loaded',?)",
                (str(len(page_files(pages_dir))),))

    # data-quality guard: mark cities whose population value is shared with another
    # city (metropole population attached to a small neighbour). Only big values matter.
    con.execute("DROP TABLE IF EXISTS _pop_share")
    con.execute("CREATE TEMP TABLE _pop_share (jamiat INTEGER PRIMARY KEY, n INTEGER)")
    con.execute("INSERT INTO _pop_share SELECT jamiat, COUNT(*) FROM city_stats "
                "WHERE jamiat >= 100000 GROUP BY jamiat")
    con.execute("UPDATE city_stats SET pop_shared_big = COALESCE("
                "(SELECT n FROM _pop_share p WHERE p.jamiat = city_stats.jamiat), 0)")
    con.commit()

    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("raw_rows", "cities", "city_stats", "counties", "provinces",
                        "districts", "universities")}
    if verbose:
        print("[db] " + "  ".join(f"{k}={v}" for k, v in counts.items()))
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('counts',?)",
                (json.dumps(counts),))
    con.commit()
    return counts


if __name__ == "__main__":
    con = connect()
    load(con)
