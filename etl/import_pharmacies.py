"""Import pharmacy points from a commercial POI provider into `map_pharmacy`.

Why this exists: the FDA feed counts pharmacies per settlement and OSM maps only
~100 of them. نشان (Neshan) and Google Places know the rest, with coordinates.
The key is read from the app's own settings table — the one entered at /settings —
so nothing is copied into a script or a shell history.

    python etl/import_pharmacies.py --provider neshan [--limit 20] [--dry-run]

It writes `map_pharmacy` rows with `source='neshan'`, matched to the nearest
administrative settlement exactly like the OSM rows. `build_map_layer.py` only
replaces `source='osm'`, so an import survives an ETL rebuild. The /map page
picks the points up on the next request; no rebuild needed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import sys
import urllib.parse
import urllib.request

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT_GEO = os.path.join(HOME, "web", "public", "geo")
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
NESHAN_SEARCH = "https://api.neshan.org/v1/search"


def haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def setting(c: sqlite3.Connection, key: str) -> str | None:
    try:
        row = c.execute("SELECT value FROM app_setting WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    except sqlite3.OperationalError:
        return None


def inside_outline(lat: float, lon: float) -> bool:
    path = os.path.join(OUT_GEO, "khuzestan_outline.geojson")
    if not os.path.exists(path):
        return True
    fc = json.load(open(path, encoding="utf-8"))
    hit = False
    for poly in fc["features"][0]["geometry"]["coordinates"]:
        for ring in poly:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                    hit = not hit
    return hit


def neshan_search(key: str, lat: float, lon: float, radius: int) -> list[dict]:
    url = f"{NESHAN_SEARCH}?" + urllib.parse.urlencode(
        {"term": "داروخانه", "lat": lat, "lng": lon, "radius": radius}
    )
    req = urllib.request.Request(url, headers={**UA, "Api-Key": key})
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.loads(r.read().decode("utf-8"))
    return payload.get("items") or []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="neshan", choices=["neshan"])
    ap.add_argument("--radius", type=int, default=8000, help="search radius per city, metres")
    ap.add_argument("--limit", type=int, default=0, help="only the first N cities (pilot)")
    ap.add_argument("--dry-run", action="store_true", help="search + report, write nothing")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    key = setting(c, "neshan_api_key")
    if not key:
        print("no neshan_api_key in app_setting — enter it at /settings first")
        return 2

    cities = c.execute("""
        SELECT a.area_id, a.name, a.county, p.lat, p.lon
        FROM v_admin_area_current a
        JOIN map_point p ON p.area_id = a.area_id
        WHERE a.kind = 'city'
        ORDER BY a.population DESC NULLS LAST
    """).fetchall()
    if args.limit:
        cities = cities[: args.limit]
    settlements = c.execute("""
        SELECT p.area_id, p.lat, p.lon, a.county FROM map_point p
        JOIN v_admin_area_current a ON a.area_id = p.area_id
    """).fetchall()

    found: dict[str, dict] = {}
    errors = 0
    for area_id, name, county, lat, lon in cities:
        try:
            items = neshan_search(key, lat, lon, args.radius)
        except Exception as e:  # network / 401 / 429
            errors += 1
            print(f"  {name}: {e}")
            continue
        print(f"  {name}: {len(items)} · {county}")
        for it in items:
            loc = it.get("location") or {}
            x, y = loc.get("x"), loc.get("y")
            if x is None or y is None:
                continue
            llat, llon = float(y), float(x)
            if not inside_outline(llat, llon):
                continue
            title = (it.get("title") or "").strip() or "داروخانه"
            # a stable id per point: 5 decimals ≈ 1 m
            oid = int(hashlib.sha1(f"{llat:.5f},{llon:.5f}".encode()).hexdigest()[:12], 16) % 2_000_000_000
            found[f"{llat:.5f},{llon:.5f}"] = {
                "osm_type": "neshan",
                "osm_id": oid,
                "name": title,
                "name_en": it.get("title_en"),
                "lat": round(llat, 6),
                "lon": round(llon, 6),
                "address": it.get("address"),
            }

    print(f"\n{len(found)} unique pharmacies from {len(cities)} cities · {errors} failed requests")
    if args.dry_run:
        for i, p in enumerate(list(found.values())[:10]):
            print("  ", p["name"], p["lat"], p["lon"], p.get("address"))
        return 0

    rows, matched = [], 0
    for p in found.values():
        best_id, best_d, best_county = None, 1e9, None
        for area_id, slat, slon, county in settlements:
            d = haversine_km(p["lat"], p["lon"], slat, slon)
            if d < best_d:
                best_id, best_d, best_county = area_id, d, county
        rows.append((
            p["osm_type"], p["osm_id"], p["name"], p["name_en"], p["lat"], p["lon"],
            best_id, round(best_d, 2), best_county, p.get("address"),
        ))
        matched += best_d <= 3.0
    c.executemany("""
        INSERT OR REPLACE INTO map_pharmacy
          (osm_type, osm_id, name, name_en, lat, lon, nearest_area_id, nearest_km,
           county, street, source)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'neshan')
    """, rows)
    c.commit()
    print(f"wrote {len(rows)} rows to map_pharmacy (source='neshan'), "
          f"{matched} within 3 km of a settlement")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
