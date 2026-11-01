"""Streets for the whole province, in 16 requests instead of 200.

`fetch_urban_detail.py` asks Overpass once per city. That was fine for one city and
hopeless for a hundred: the public mirrors rate-limit within seconds (`osm.ch` is a
Swiss extract and answers every Iranian bbox with an empty 200, `kumi` and
`private.coffee` time out, `overpass-api.de` is the only one that works, at ~45 s a
query). A hundred sequential per-city queries is then six hours of waiting for data
that is already one query away.

So: tile خوزستان into a 4×4 grid, ask for every residential-class way in each tile,
and sort the answers into cities locally. Sixteen requests, ~12 minutes, resumable
per tile.

    python etl/fetch_province_streets.py --fetch      # tiles → data/derived/tiles/
    python etl/fetch_province_streets.py --split      # tiles → per-city files + cells
    python etl/fetch_province_streets.py              # both

Writes, per city: `web/public/geo/streets_<slug>.json`, an entry in
`streets_index.json`, and `urban_cell(lat, lon, street_m)` — the weight the
population surface uses.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_urban_detail import (  # noqa: E402
    CELL_KM, GEO, STREET_CLASSES, city_radius_km, rdp, slug, street_cells,
)

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
TILES = os.path.join(HOME, "data", "derived", "tiles")
HOSTS = ["https://overpass-api.de/api/interpreter"]
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
# خوزستان, a little wide so no town is cut at the edge
BOX = (29.70, 47.30, 33.30, 50.90)
GRID = 4
STREET_KM_MAX = 12.0   # a city is an area: 6 km clipped اهواز in half
# A 20k town has a 4 km built-up radius, but the roads that *connect* it leave town
# well inside that — ویس had 229 segments and looked unconnected. Every town gets at
# least this much ground.
STREET_KM_MIN = 6.0


def hav(alat, alon, blat, blon):
    r = 6371.0088
    p1, p2 = math.radians(alat), math.radians(blat)
    dp, dl = p2 - p1, math.radians(blon - alon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def ask(query: str, timeout: int = 300, tries: int = 4) -> dict:
    for host in HOSTS:
        for attempt in range(tries):
            try:
                req = urllib.request.Request(
                    host, data=urllib.parse.urlencode({"data": query}).encode(), headers=UA)
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.loads(r.read())
            except Exception as e:  # noqa: BLE001
                wait = 20 * (attempt + 1)
                print(f"    {host.split('//')[1][:24]}: {str(e)[:70]} — retry in {wait}s",
                      flush=True)
                time.sleep(wait)
    return {}


def fetch_tiles() -> None:
    os.makedirs(TILES, exist_ok=True)
    la0, lo0, la1, lo1 = BOX
    dla, dlo = (la1 - la0) / GRID, (lo1 - lo0) / GRID
    for i in range(GRID):
        for j in range(GRID):
            path = os.path.join(TILES, f"tile_{i}{j}.json")
            if os.path.exists(path) and os.path.getsize(path) > 500:
                print(f"tile {i}{j}: cached", flush=True)
                continue
            box = f"{la0 + i * dla:.4f},{lo0 + j * dlo:.4f},{la0 + (i + 1) * dla:.4f},{lo0 + (j + 1) * dlo:.4f}"
            t = time.time()
            print(f"tile {i}{j}: {box} …", flush=True)
            res = ask(f'[out:json][timeout:300];'
                      f'way["highway"~"^({STREET_CLASSES})$"]({box});out geom;')
            els = res.get("elements") or []
            json.dump(els, open(path, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"    {len(els):,} ways in {time.time() - t:.0f}s "
                  f"({os.path.getsize(path) / 1e6:.1f} MB)", flush=True)
            time.sleep(4)          # be a good citizen; the mirror has a queue


def split_tiles(cities: list[dict]) -> None:
    buckets: dict[str, list[dict]] = {c["name"]: [] for c in cities}
    radii = {c["name"]: min(max(city_radius_km(c["pop"]), STREET_KM_MIN), STREET_KM_MAX)
             for c in cities}
    # cities on a coarse grid so a way only tests the towns near it, not all 100
    grid: dict[tuple[int, int], list[dict]] = {}
    for c in cities:
        grid.setdefault((round(c["lat"] / 0.25), round(c["lon"] / 0.25)), []).append(c)
    tiles = sorted(f for f in os.listdir(TILES) if f.startswith("tile_"))
    if not tiles:
        print("no tiles — run --fetch first")
        return
    total_ways = 0
    raster: dict[tuple[float, float], float] = {}
    for tf in tiles:
        els = json.load(open(os.path.join(TILES, tf), encoding="utf-8"))
        kept = 0
        for el in els:
            geom = el.get("geometry") or []
            pts = [(float(p["lat"]), float(p["lon"])) for p in geom if p.get("lat") is not None]
            if len(pts) < 2:
                continue
            la = sum(p[0] for p in pts) / len(pts)
            lo = sum(p[1] for p in pts) / len(pts)
            # distance from the way's *nearest* vertex, not its midpoint: a street
            # running along the edge of a town has a far midpoint and was dropped
            near = [pts[0], pts[len(pts) // 2], pts[-1]] if len(pts) < 8 else                 [pts[int(i * (len(pts) - 1) / 7)] for i in range(8)]
            gi, gj = round(la / 0.25), round(lo / 0.25)
            cand = [c for oi in (-1, 0, 1) for oj in (-1, 0, 1)
                    for c in grid.get((gi + oi, gj + oj), [])]
            # a street between two towns belongs to both, so every city whose radius
            # contains it gets it; the nearest-only rule starved small towns
            owners = []
            for c in cand or cities:
                d = min(hav(pla, plo, c["lat"], c["lon"]) for pla, plo in near)
                if d <= radii[c["name"]]:
                    owners.append(c)
            simple = rdp(pts, 0.00008)
            seg = {
                "c": (el.get("tags") or {}).get("highway", "residential"),
                "p": [[round(a, 5), round(b, 5)] for a, b in simple],
            }
            for c in owners:
                buckets[c["name"]].append(seg)
            if owners:
                kept += 1
            # raster: metres per 500 m cell over the whole province, for the villages
            for (a1, b1), (a2, b2) in zip(simple, simple[1:]):
                mla, mlo = (a1 + a2) / 2, (b1 + b2) / 2
                dlat, dlon = 0.5 / 110.57, 0.5 / (111.32 * math.cos(math.radians(mla)))
                kk = (round(round(mla / dlat) * dlat, 4), round(round(mlo / dlon) * dlon, 4))
                raster[kk] = raster.get(kk, 0.0) + hav(a1, b1, a2, b2) * 1000
        total_ways += kept
        print(f"{tf}: {len(els):,} ways → {kept:,} assigned", flush=True)

    c = sqlite3.connect(DB)
    index_path = os.path.join(GEO, "streets_index.json")
    index = {r["city"]: r for r in json.load(open(index_path, encoding="utf-8"))} \
        if os.path.exists(index_path) else {}
    written = 0
    for city in cities:
        name = city["name"]
        segs = buckets[name]
        if not segs:
            continue
        sl = slug(name)
        fc = {"type": "FeatureCollection", "city": name, "lat": city["lat"], "lon": city["lon"],
              "features": [{"type": "Feature", "properties": {"c": s["c"]},
                            "geometry": {"type": "LineString",
                                         "coordinates": [[p[1], p[0]] for p in s["p"]]}}
                           for s in segs]}
        json.dump(fc, open(os.path.join(GEO, f"streets_{sl}.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
        cells = street_cells(segs)
        c.execute("DELETE FROM urban_cell WHERE city = ?", (name,))
        c.executemany(
            "INSERT OR REPLACE INTO urban_cell (city, lat, lon, buildings, population, street_m)"
            " VALUES (?,?,?,?,?,?)",
            [(name, k[0], k[1], 0, None, round(v, 1)) for k, v in cells.items()])
        c.commit()
        index[name] = {"city": name, "slug": sl, "lat": city["lat"], "lon": city["lon"],
                       "r_km": round(min(max(city_radius_km(city["pop"]), STREET_KM_MIN),
                                         STREET_KM_MAX), 1),
                       "streets": len(segs), "buildings": 0, "cells": len(cells)}
        written += 1
        print(f"  {name}: {len(segs):,} segments · {len(cells):,} cells", flush=True)
    json.dump(list(index.values()), open(index_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    rpath = os.path.join(HOME, "data", "derived", "street_raster.json")
    os.makedirs(os.path.dirname(rpath), exist_ok=True)
    json.dump({"cell_km": 0.5,
               "cells": [[k[0], k[1], round(v, 1)] for k, v in raster.items() if v >= 20]},
              open(rpath, "w", encoding="utf-8"), separators=(",", ":"))
    print(f"street raster: {len(raster):,} cells → {rpath} "
          f"({os.path.getsize(rpath) / 1e6:.1f} MB)")
    print(f"\n{written} cities written · {total_ways:,} ways assigned · index {len(index)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--split", action="store_true")
    args = ap.parse_args()
    both = not (args.fetch or args.split)

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    cities = [dict(r) for r in c.execute("""
        SELECT a.name, p.lat, p.lon, COALESCE(a.population, 0) AS pop
        FROM v_admin_area_current a JOIN map_point p ON p.area_id = a.area_id
        WHERE a.kind = 'city' ORDER BY COALESCE(a.population, 0) DESC
    """)]
    print(f"cities: {len(cities)}")

    if args.fetch or both:
        fetch_tiles()
    if args.split or both:
        split_tiles(cities)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
