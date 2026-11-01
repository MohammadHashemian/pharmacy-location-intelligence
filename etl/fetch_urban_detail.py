"""Urban detail for the map: street geometry + a population surface built from it.

Two things the settlement layer cannot give, both fetched from OSM per city:

1. **streets** — `highway=tertiary|residential|unclassified|living_street` inside a
   city's footprint, simplified, written to `web/public/geo/streets_<slug>.json` and
   only drawn above 5x. The province file has motorway…secondary only, which is why
   a city looked like an empty polygon.

2. **built density → population** — building footprints (`out center`) aggregated on
   a 250 m grid; each city's census population is then distributed over those cells
   in proportion to the buildings standing on them, with a small floor so a street
   block with no mapped building is not zero. The result is
   `web/public/geo/urban_pop.json`: the closest thing to "how many people actually
   live on this block" that open data supports here.

    python etl/fetch_urban_detail.py --cities 4
    python etl/fetch_urban_detail.py --only اهواز --refresh
    python etl/fetch_urban_detail.py --streets-only

Every answer is cached in `data/derived/urban/<slug>.json`, so a re-run is free and
an interrupted run resumes. Overpass is slow (60-150 s a query); the script says
which city it is on and commits after each one.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
GEO = os.path.join(HOME, "web", "public", "geo")
CACHE = os.path.join(HOME, "data", "derived", "urban")
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
# measured 2026-11: overpass-api.de 502 / kumi + private.coffee time out;
# osm.ch answers in ~1 s. Slow mirrors are kept as fallbacks, last.
HOSTS = [
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
STREET_CLASSES = "tertiary|residential|unclassified|living_street"
CELL_KM = 0.25            # grid the buildings are counted on
MIN_BUILDINGS = 25        # below this a city's OSM footprints are too sparse to trust


def overpass(query: str, timeout: int = 240) -> dict:
    last = ""
    for host in HOSTS:
        try:
            data = urllib.parse.urlencode({"data": query}).encode()
            req = urllib.request.Request(
                host, data=data, headers={**UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — try the next mirror
            last = f"{host}: {e}"
            print(f"    {last[:100]}")
    raise RuntimeError(last)


def slug(name: str) -> str:
    """Persian names have no ASCII to slugify, so the slug is a short hash: stable
    across runs and unique per city (a bare «city» would collide for all of them)."""
    ascii_part = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    digest = hashlib.md5(name.encode("utf-8")).hexdigest()[:8]
    return f"{ascii_part}-{digest}" if ascii_part else f"city-{digest}"


def rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Ramer–Douglas–Peucker, iterative — a street that bends twice does not need 40
    vertices at this scale."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-12
        best, best_i = eps, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > best:
                best, best_i = d, i
        if best_i > 0:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    return [p for p, k in zip(points, keep) if k]


def city_radius_km(pop: float) -> float:
    return max(3.0, min(12.0, 0.9 * math.sqrt(max(pop, 0) / 1000)))


def bbox_around(lat: float, lon: float, km: float) -> str:
    dlat = km / 110.57
    dlon = km / (111.32 * math.cos(math.radians(lat)))
    return f"{lat - dlat:.5f},{lon - dlon:.5f},{lat + dlat:.5f},{lon + dlon:.5f}"


def fetch_buildings(lat: float, lon: float, km: float) -> list[tuple[float, float]]:
    box = bbox_around(lat, lon, km)
    res = overpass(f"""[out:json][timeout:180];
(way["building"]({box});relation["building"]({box}););
out center;""")
    pts: list[tuple[float, float]] = []
    for el in res.get("elements", []):
        c = el.get("center") or {}
        if c.get("lat") is not None:
            pts.append((float(c["lat"]), float(c["lon"])))
    return pts


def fetch_streets(lat: float, lon: float, km: float) -> list[dict]:
    box = bbox_around(lat, lon, km)
    res = overpass(f"""[out:json][timeout:240];
way["highway"~"^({STREET_CLASSES})$"]({box});
out geom;""")
    feats = []
    for el in res.get("elements", []):
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        pts = [(float(p["lat"]), float(p["lon"])) for p in geom if p.get("lat") is not None]
        if len(pts) < 2:
            continue
        simple = rdp(pts, 0.00008)          # ~9 m: sub-street accuracy, quarter the size
        feats.append({
            "c": (el.get("tags") or {}).get("highway", "residential"),
            "p": [[round(la, 5), round(lo, 5)] for la, lo in simple],
        })
    return feats



def street_cells(streets: list[dict], cell_km: float = CELL_KM) -> dict[tuple[float, float], float]:
    """Metres of street inside each cell.

    OSM has 3.8k building footprints for a 1.2 M city, which is far too sparse to
    weight a population surface (it reads as "308 people per building"). Street
    cover does exist for these cities and tracks built-up land closely, so the
    population is spread by street metres, with buildings as the fallback.
    """
    out: dict[tuple[float, float], float] = {}
    for seg in streets:
        pts = seg.get("p") or []
        for (la1, lo1), (la2, lo2) in zip(pts, pts[1:]):
            dlat = math.radians(la2 - la1)
            dlon = math.radians(lo2 - lo1)
            a = (math.sin(dlat / 2) ** 2
                 + math.cos(math.radians(la1)) * math.cos(math.radians(la2))
                 * math.sin(dlon / 2) ** 2)
            metres = 2 * 6371008.8 * math.asin(math.sqrt(a))
            if metres <= 0:
                continue
            mla, mlo = (la1 + la2) / 2, (lo1 + lo2) / 2
            dlatc = cell_km / 110.57
            dlonc = cell_km / (111.32 * math.cos(math.radians(mla)))
            key_cell = (round(round(mla / dlatc) * dlatc, 5),
                        round(round(mlo / dlonc) * dlonc, 5))
            out[key_cell] = out.get(key_cell, 0.0) + metres
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cities", type=int, default=6, help="how many cities, biggest first")
    ap.add_argument("--only", default=None, help="one city name")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--streets-only", action="store_true")
    ap.add_argument("--street-km", type=float, default=6.0,
                    help="radius for streets (public Overpass chokes on more)")
    ap.add_argument("--buildings-only", action="store_true")
    ap.add_argument("--rebuild-cells", action="store_true",
                    help="recompute the cell table from the caches, no network")
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(GEO, exist_ok=True)
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    q = """
        SELECT a.name, p.lat, p.lon, COALESCE(a.population, 0) AS pop
        FROM v_admin_area_current a
        JOIN map_point p ON p.area_id = a.area_id
        WHERE a.kind = 'city'
        ORDER BY COALESCE(a.population, 0) DESC
    """
    cities = c.execute(q).fetchall()
    if args.only:
        cities = [r for r in cities if r["name"] == args.only]
    else:
        cities = cities[: args.cities]
    if not cities:
        print("no city matched")
        return 1

    if args.rebuild_cells:
        urban_dir = CACHE
        total = 0
        for row in cities:
            name = row["name"]
            path = os.path.join(urban_dir, f"{slug(name)}.json")
            if not os.path.exists(path):
                continue
            cache = json.load(open(path, encoding="utf-8"))
            sc = street_cells(cache.get("streets") or [])
            cells: dict[tuple[float, float], int] = {}
            for bla, blo in (cache.get("buildings") or []):
                dlat = CELL_KM / 110.57
                dlon = CELL_KM / (111.32 * math.cos(math.radians(bla)))
                kk = (round(round(bla / dlat) * dlat, 5), round(round(blo / dlon) * dlon, 5))
                cells[kk] = cells.get(kk, 0) + 1
            keys = set(cells) | set(sc)
            if not keys:
                continue
            c.execute("DELETE FROM urban_cell WHERE city = ?", (name,))
            c.executemany(
                "INSERT OR REPLACE INTO urban_cell"
                " (city, lat, lon, buildings, population, street_m) VALUES (?,?,?,?,?,?)",
                [(name, k[0], k[1], cells.get(k, 0), None, round(sc.get(k, 0.0), 1))
                 for k in keys])
            c.commit()
            total += len(keys)
            print(f"  {name}: {len(keys):,} cells · {len(sc):,} with streets")
        print(f"rebuilt {total:,} cells from cache")
        return 0

    manifest: list[dict] = []
    for i, row in enumerate(cities, 1):
        name, lat, lon, pop = row["name"], row["lat"], row["lon"], row["pop"]
        km = city_radius_km(pop)
        sl = slug(name)
        cache_file = os.path.join(CACHE, f"{sl}.json")
        cache = {}
        if os.path.exists(cache_file) and not args.refresh:
            try:
                cache = json.load(open(cache_file, encoding="utf-8"))
            except json.JSONDecodeError:
                cache = {}

        if not args.streets_only and "buildings" not in cache:
            print(f"[{i}/{len(cities)}] {name}: buildings inside {km:.1f} km …", flush=True)
            try:
                cache["buildings"] = fetch_buildings(lat, lon, km)
                json.dump(cache, open(cache_file, "w", encoding="utf-8"), ensure_ascii=False)
                print(f"    {len(cache['buildings']):,} building centres", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"    buildings failed: {str(e)[:120]}", flush=True)

        skm = min(km, args.street_km)
        if not args.buildings_only and "streets" not in cache:
            print(f"[{i}/{len(cities)}] {name}: streets inside {skm:.1f} km …", flush=True)
            try:
                got = fetch_streets(lat, lon, skm)
                if not got:
                    # a mirror can answer with an empty/HTML body; never cache that,
                    # otherwise the city is «done» for good and never retried
                    raise RuntimeError("empty answer")
                cache["streets"] = got
                json.dump(cache, open(cache_file, "w", encoding="utf-8"), ensure_ascii=False)
                print(f"    {len(cache['streets']):,} street segments", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"    streets failed: {str(e)[:120]}", flush=True)

        cells: dict[tuple[float, float], int] = {}
        for bla, blo in (cache.get("buildings") or []):
            dlat = CELL_KM / 110.57
            dlon = CELL_KM / (111.32 * math.cos(math.radians(bla)))
            key_cell = (round(round(bla / dlat) * dlat, 5),
                        round(round(blo / dlon) * dlon, 5))
            cells[key_cell] = cells.get(key_cell, 0) + 1
        def write_cells() -> int:
            sc = street_cells(cache.get("streets") or [])
            keys = set(cells) | set(sc)
            if not keys:
                return 0
            c.execute("DELETE FROM urban_cell WHERE city = ?", (name,))
            c.executemany(
                "INSERT OR REPLACE INTO urban_cell"
                " (city, lat, lon, buildings, population, street_m) VALUES (?,?,?,?,?,?)",
                [(name, k[0], k[1], cells.get(k, 0), None, round(sc.get(k, 0.0), 1))
                 for k in keys])
            c.commit()
            return len(keys)

        n_cells = write_cells()
        if n_cells:
            print(f"    {n_cells:,} cells · {len(cache.get('buildings') or []):,} buildings · "
                  f"{sum(1 for v in street_cells(cache.get('streets') or []).values()):,} with streets",
                  flush=True)

        # --- streets file (client fetches it per city, only when zoomed in) ----
        streets = cache.get("streets") or []
        if streets:
            out = {
                "type": "FeatureCollection",
                "city": name,
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "features": [
                    {"type": "Feature",
                     "properties": {"c": f["c"]},
                     "geometry": {"type": "LineString",
                                  "coordinates": [[p[1], p[0]] for p in f["p"]]}}
                    for f in streets if len(f["p"]) >= 2
                ],
            }
            path = os.path.join(GEO, f"streets_{sl}.json")
            json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False,
                      separators=(",", ":"))
            size = os.path.getsize(path) / 1024
            print(f"    streets_{sl}.json: {len(out['features']):,} segments · {size:.0f} KB",
                  flush=True)

        n_cells = write_cells()          # streets just arrived: rewrite with them
        manifest.append({"city": name, "slug": sl, "lat": round(lat, 5),
                         "lon": round(lon, 5), "r_km": round(km, 2),
                         "streets": len(streets), "buildings": len(cache.get("buildings") or []),
                         "cells": len(cells)})
        # write the index after every city: the client reads it to decide which
        # streets file to fetch, and a long run must not leave it empty
        json.dump(manifest, open(os.path.join(GEO, "streets_index.json"), "w",
                                 encoding="utf-8"), ensure_ascii=False, indent=1)
        time.sleep(1.0)

    json.dump(manifest, open(os.path.join(GEO, "streets_index.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("\nindex:", ", ".join(f"{m['city']} ({m['streets']} st / {m['buildings']} b)"
                                for m in manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
