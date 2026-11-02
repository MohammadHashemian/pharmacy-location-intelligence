"""Warm the local satellite store, so panning does not depend on the internet.

The `/api/tile` route already caches every tile it is asked for, so anything the user looks
at lands on disk automatically. This prefetches the parts we know will be looked at: the
province at the zooms you see before entering a city, and each of the 86 city discs at the
zoom where streets become readable.

    python etl/prefetch_sat.py --zooms 8-13            # province-wide
    python etl/prefetch_sat.py --cities 13-15 --only ahvaz
    python etl/prefetch_sat.py --report                # what is already on disk

Sizes are printed before anything is downloaded; nothing is guessed.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT = os.path.join(HOME, "data", "tiles", "sat")
SRC = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
PROVINCE = (47.4, 29.7, 50.7, 33.2)          # west, south, east, north — خوزستان + margin


def tile_of(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) /
             math.pi) / 2 * n)
    return x, y


def range_of(bbox: tuple[float, float, float, float], z: int) -> tuple[int, int, int, int]:
    w, s, e, n = bbox
    x0, y0 = tile_of(n, w, z)
    x1, y1 = tile_of(s, e, z)
    return x0, y0, x1, y1


def path_of(z: int, x: int, y: int) -> str:
    return os.path.join(OUT, str(z), str(x), f"{y}.jpg")


def existing(z: int, x: int, y: int) -> bool:
    return os.path.exists(path_of(z, x, y))


def fetch(z: int, x: int, y: int) -> tuple[bool, int]:
    p = path_of(z, x, y)
    if os.path.exists(p):
        return False, 0
    req = urllib.request.Request(SRC.format(z=z, x=x, y=y),
                                 headers={"User-Agent": "pharmacy-location-intelligence/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            buf = r.read()
    except Exception:
        return False, 0
    if len(buf) < 4000 or buf[:2] == b"\x89P":     # placeholder, as z19 returns over ایران
        return False, 0
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.tmp"
    with open(tmp, "wb") as f:
        f.write(buf)
    os.replace(tmp, p)
    return True, len(buf)


def report() -> int:
    total = size = 0
    per_z: dict[int, list[int]] = {}
    for z in sorted(os.listdir(OUT)) if os.path.isdir(OUT) else []:
        if not z.isdigit():
            continue
        zs = [0, 0]
        for root, _, files in os.walk(os.path.join(OUT, z)):
            for f in files:
                if f.endswith(".jpg"):
                    zs[0] += 1
                    zs[1] += os.path.getsize(os.path.join(root, f))
        per_z[int(z)] = zs
        total += zs[0]
        size += zs[1]
    for z, (n, b) in sorted(per_z.items()):
        print(f"  z{z}: {n:>7,} tiles · {b / 1e6:>7.1f} MB")
    print(f"total {total:,} tiles · {size / 1e6:.1f} MB in {OUT}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zooms", default="", help="e.g. 8-13")
    ap.add_argument("--cities", default="", help="zoom range for city discs, e.g. 13-15")
    ap.add_argument("--only", default="", help="substring of the city name")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    if args.report:
        return report()

    jobs: list[tuple[int, int, int]] = []
    if args.zooms:
        a, _, b = args.zooms.partition("-")
        for z in range(int(a), int(b or a) + 1):
            x0, y0, x1, y1 = range_of(PROVINCE, z)
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    if not existing(z, x, y):
                        jobs.append((z, x, y))
    if args.cities:
        a, _, b = args.cities.partition("-")
        c = sqlite3.connect(DB)
        c.row_factory = sqlite3.Row
        rows = c.execute("""SELECT city AS name, lat, lon FROM urban_cell
                            ORDER BY population DESC""").fetchall()
        for r in rows:
            if args.only and args.only not in (r["name"] or ""):
                continue
            rad = 6.0            # the disc a city's streets were fetched for
            bbox = (r["lon"] - rad / 88.0, r["lat"] - rad / 111.0,
                    r["lon"] + rad / 88.0, r["lat"] + rad / 111.0)
            for z in range(int(a), int(b or a) + 1):
                x0, y0, x1, y1 = range_of(bbox, z)
                for x in range(x0, x1 + 1):
                    for y in range(y0, y1 + 1):
                        if not existing(z, x, y):
                            jobs.append((z, x, y))

    jobs = sorted(set(jobs))
    print(f"tiles to fetch: {len(jobs):,} (≈ {len(jobs) * 0.035:.0f} MB at ~35 KB each)")
    if not jobs:
        return report()
    got = bytes_ = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, (ok, n) in enumerate(pool.map(lambda j: fetch(*j), jobs), 1):
            if ok:
                got += 1
                bytes_ += n
            if i % 500 == 0:
                print(f"  {i:,}/{len(jobs):,} · stored {got:,} · {bytes_ / 1e6:.0f} MB", flush=True)
    print(f"stored {got:,} tiles · {bytes_ / 1e6:.1f} MB")
    return report()


if __name__ == "__main__":
    sys.exit(main())
