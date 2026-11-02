"""Put every pharmacy we already paid for onto the map.

The importer reports «wrote 340 rows» while the table grows by 40. Rather than guess why,
this takes the cached provider answers — which cost real API calls — and inserts whatever is
not already on the map within 60 m. Idempotent: run it twice, nothing changes.

    python etl/sync_from_cache.py            # report
    python etl/sync_from_cache.py --apply    # insert
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_pharmacies import point_id  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
DERIVED = os.path.join(HOME, "data", "derived")


def hav(a: float, b: float, c: float, d: float) -> float:
    R = 6371.0088
    p1, p2 = math.radians(a), math.radians(c)
    dp = p2 - p1
    dl = math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    have = [(r["lat"], r["lon"]) for r in c.execute("SELECT lat, lon FROM map_pharmacy")]
    settlements = [dict(r) for r in c.execute("""
        SELECT p.area_id, p.lat, p.lon, a.county FROM map_point p
        JOIN v_admin_area_current a ON a.area_id = p.area_id""")]

    points: dict[tuple[float, float], dict] = {}
    for path in glob.glob(os.path.join(DERIVED, "*_poi_cache.json")):
        try:
            cache = json.load(open(path, encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"{os.path.basename(path)}: unreadable, skipped")
            continue
        for batch in cache.values():
            for p in batch:
                if p.get("lat") is None or p.get("lon") is None:
                    continue
                points[(round(p["lat"], 5), round(p["lon"], 5))] = p
    print(f"cached distinct pharmacies: {len(points):,}")

    rows = []
    for (lat, lon), p in points.items():
        if any(hav(lat, lon, a, b) <= 0.06 for a, b in have):
            continue
        best = min(settlements, key=lambda s: hav(lat, lon, s["lat"], s["lon"]))
        km = hav(lat, lon, best["lat"], best["lon"])
        if km > 3.0:
            continue
        name = (p.get("name") or "").strip()
        if len(name) < 3:
            continue
        rows.append(("poi", point_id(lat, lon, p.get("hash")), name, None, lat, lon,
                     best["area_id"], round(km, 2), best["county"],
                     p.get("address"), "google", p.get("hash")))

    print(f"missing from the map: {len(rows):,}")
    for r in rows[:8]:
        print(f"   {r[2][:44]:46s} {r[4]:.4f},{r[5]:.4f}")
    if not args.apply:
        print("(report only — pass --apply)")
        return 0

    c.executemany("""
        INSERT OR REPLACE INTO map_pharmacy
          (osm_type, osm_id, name, name_en, lat, lon, nearest_area_id, nearest_km,
           county, street, source, external_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
    c.commit()
    after = c.execute("SELECT count(*) FROM map_pharmacy").fetchone()[0]
    print(f"inserted {len(rows):,} · map_pharmacy now {after:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
