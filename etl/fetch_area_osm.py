"""One Overpass call for a town: its road network and its health POIs.

The cached `streets_city-*.json` extract for کوت عبدالله carries **no** primary or secondary
road at all, which makes «کدام خیابان شریان است» unanswerable from it. This fetches the actual
network for a small bbox and stores it next to the other layers, plus every amenity that can
generate a prescription (pharmacy, clinic, doctors, dentist, hospital, laboratory).

    python etl/fetch_area_osm.py --area-id 212 --radius 4

Writes `web/public/geo/streets_area-<id>.json` and rows in `area_poi`.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import urllib.request

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
GEO = os.path.join(HOME, "web", "public", "geo")

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

HEALTH = ["pharmacy", "clinic", "doctors", "dentist", "hospital", "laboratory"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--area-id", type=int, required=True)
    ap.add_argument("--radius", type=float, default=4.0)
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT name, lat, lon FROM v_map_settlement WHERE area_id = ?",
                    [args.area_id]).fetchone()
    if not row or row["lat"] is None:
        print("no coordinates for that area")
        return 1
    lat, lon = row["lat"], row["lon"]
    dlat = args.radius / 110.574
    dlon = args.radius / (111.320 * math.cos(math.radians(lat)))
    bbox = f"{lat - dlat:.5f},{lon - dlon:.5f},{lat + dlat:.5f},{lon + dlon:.5f}"

    health = "|".join(f'"{a}"' for a in HEALTH)
    q = f"""
[out:json][timeout:120];
(
  way["highway"]({bbox});
  node["amenity"~"^({health})$"]({bbox});
  way["amenity"~"^({health})$"]({bbox});
);
out tags center;
"""
    data = None
    for url in ENDPOINTS:
        try:
            req = urllib.request.Request(
                url, data=q.encode(), headers={"User-Agent": "pharmacy-location-intelligence/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.loads(r.read())
            print(f"overpass: {url.split('/')[2]} answered")
            break
        except Exception as e:                                  # noqa: BLE001
            print(f"  {url.split('/')[2]} failed: {e}")
    if not data:
        print("no Overpass endpoint answered")
        return 1

    streets = []
    pois = []
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        if tags.get("highway") and el.get("type") == "way":
            centre = el.get("center") or {}
            if "lat" in centre:
                # one vertex is enough to draw a road *class* map; Overpass `out center` is cheap
                streets.append({"type": "Feature",
                                "properties": {"c": tags["highway"], "n": tags.get("name")},
                                "geometry": {"type": "LineString",
                                             "coordinates": [[centre["lon"], centre["lat"]]]}})
        amenity = tags.get("amenity")
        if amenity in HEALTH:
            plat = el.get("lat") or (el.get("center") or {}).get("lat")
            plon = el.get("lon") or (el.get("center") or {}).get("lon")
            if plat is None:
                continue
            pois.append((args.area_id, amenity, tags.get("name"), plat, plon,
                         tags.get("name:en"), "osm"))

    fc = {"type": "FeatureCollection", "city": row["name"], "lat": lat, "lon": lon,
          "features": streets}
    out = os.path.join(GEO, f"streets_area-{args.area_id}.json")
    json.dump(fc, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"streets: {len(streets)} ways → {os.path.basename(out)}")

    c.execute("""CREATE TABLE IF NOT EXISTS area_poi (
        area_id INTEGER, kind TEXT, name TEXT, lat REAL, lon REAL,
        name_en TEXT, source TEXT)""")
    c.execute("DELETE FROM area_poi WHERE area_id = ?", [args.area_id])
    c.executemany("INSERT INTO area_poi VALUES (?,?,?,?,?,?,?)", pois)
    c.commit()
    kinds: dict[str, int] = {}
    for p in pois:
        kinds[p[1]] = kinds.get(p[1], 0) + 1
    print(f"health POIs: {len(pois)} {kinds}")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
