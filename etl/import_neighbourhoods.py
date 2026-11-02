"""Bring the neighbourhoods onto the map — the layer that was never imported.

Diagnosis first. The map's labels come from `v_map_settlement`, which is the **administrative**
layer: شهر and روستا. A محله is not an administrative unit, so it was never in that table —
while `geo_places` has held **312 named neighbourhoods** all along. «کوت نواصر» and «کوی هادی»
were not special cases; the whole class was invisible.

This writes `map_neighbourhood` (one row per named neighbourhood, with the city it sits in and
the distance to that city) and reads `etl/neighbourhood_aliases.json` for the names people
actually use — «کوی هادی» for the OSM label «هادی آباد - کوت عبداله».

    python etl/import_neighbourhoods.py
    python etl/import_neighbourhoods.py --check
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
ALIASES = os.path.join(HOME, "etl", "neighbourhood_aliases.json")
KINDS = ("neighbourhood", "suburb", "quarter", "city_district")


def hav(a: float, b: float, c: float, d: float) -> float:
    R = 6371.0088
    p1, p2 = math.radians(a), math.radians(c)
    dp = p2 - p1
    dl = math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def check() -> int:
    assert hav(31.22, 48.66, 31.22, 48.66) == 0
    assert hav(31.0, 48.0, 32.0, 48.0) > 110
    print("check: distance helper OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        return check()

    aliases: dict[str, str] = {}
    if os.path.exists(ALIASES):
        aliases = json.load(open(ALIASES, encoding="utf-8"))
        print(f"aliases: {len(aliases)}")

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.execute("""CREATE TABLE IF NOT EXISTS map_neighbourhood (
        osm_id   INTEGER PRIMARY KEY,
        name     TEXT NOT NULL,
        alias    TEXT,
        lat      REAL NOT NULL,
        lon      REAL NOT NULL,
        city     TEXT,
        county   TEXT,
        city_km  REAL,
        place    TEXT
    )""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_nb_latlon ON map_neighbourhood(lat, lon)")

    cities = [dict(r) for r in c.execute(
        """SELECT a.name, p.lat, p.lon, a.county
             FROM map_point p JOIN v_admin_area_current a ON a.area_id = p.area_id
            WHERE a.kind = 'city' AND p.lat IS NOT NULL""")]

    rows = c.execute(
        f"""SELECT osm_id, name, lat, lon, county, place_kind
              FROM geo_places
             WHERE place_kind IN ({','.join('?' * len(KINDS))}) AND lat IS NOT NULL""",
        KINDS,
    ).fetchall()

    out = []
    for r in rows:
        best, bestd = None, 1e9
        for city in cities:
            d = hav(r["lat"], r["lon"], city["lat"], city["lon"])
            if d < bestd:
                best, bestd = city, d
        alias = aliases.get(r["name"])
        out.append((r["osm_id"], r["name"], alias, r["lat"], r["lon"],
                    best["name"] if best else None,
                    r["county"] or (best["county"] if best else None),
                    round(bestd, 1) if best else None,
                    r["place_kind"]))

    c.execute("DELETE FROM map_neighbourhood")
    c.executemany("""INSERT OR REPLACE INTO map_neighbourhood
                     (osm_id, name, alias, lat, lon, city, county, city_km, place)
                     VALUES (?,?,?,?,?,?,?,?,?)""", out)
    c.commit()

    print(f"neighbourhoods: {len(out)}")
    for name in ("کوت نواصر", "هادی آباد - کوت عبداله", "کوی هادی"):
        hit = [o for o in out if o[1] == name or o[2] == name]
        print(f"  {name:24s} {'✓ ' + str(hit[0][3:6]) if hit else '— missing'}")
    per_city: dict[str, int] = {}
    for o in out:
        per_city[o[5] or "?"] = per_city.get(o[5] or "?", 0) + 1
    top = sorted(per_city.items(), key=lambda kv: -kv[1])[:6]
    print("by city:", ", ".join(f"{k} {v}" for k, v in top))
    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
