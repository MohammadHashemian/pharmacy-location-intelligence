"""The half of the street network we never shipped.

`52,773 of OSM's 104,986 residential ways sit outside every city disc` — village lanes and
town outskirts. They are already in `data/derived/tiles/`, they cost nothing to fetch, and
no file contained them, which is why whole districts rendered as bare imagery.

This writes them **per county**, so the map downloads one small file on demand instead of a
9 MB blob on first paint.

    python etl/build_rural_streets.py
    python etl/build_rural_streets.py --check     # self-test, no writes

Output:

    web/public/geo/rural_<slug>.json    {county, features:[…]}
    web/public/geo/rural_index.json     [{county, slug, lat, lon, r_km, ways, bbox}]

Assignment: each way goes to the county of the **nearest settlement**, which we already
hold for all 3,677 of them — cheaper and more robust than point-in-polygon over 31 county
shapes, and a lane between two counties belongs to the one whose village it serves.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import math
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_urban_detail import rdp  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
TILES = os.path.join(HOME, "data", "derived", "tiles")
GEO = os.path.join(HOME, "web", "public", "geo")
CLASSES = {"residential", "living_street"}     # tertiary/unclassified are in the connector layer
TOLERANCE = 0.00045                            # ~50 m: a lane is context, not navigation


def hav(a: float, b: float, c: float, d: float) -> float:
    R = 6371.0088
    p1, p2 = math.radians(a), math.radians(c)
    dp = p2 - p1
    dl = math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def slug_of(county: str) -> str:
    return "rural-" + hashlib.sha1(county.encode("utf-8")).hexdigest()[:8]


class Nearest:
    """Nearest settlement → county, on a coarse grid."""

    def __init__(self, rows: list[tuple[str, float, float]], step: float = 0.08):
        self.step = step
        self.cells: dict[tuple[int, int], list[tuple[str, float, float]]] = {}
        for county, lat, lon in rows:
            self.cells.setdefault((round(lat / step), round(lon / step)), []).append(
                (county, lat, lon))

    def county(self, lat: float, lon: float) -> str | None:
        ki, kj = round(lat / self.step), round(lon / self.step)
        best, bestd = None, 1e9
        # widen until something is found: خوزستان has stretches >27 km from any
        # settlement, and a 3-cell search dropped 38,952 ways (37 % of the province)
        for r in (1, 2, 3, 5, 8, 12, 16, 24):
            for i in range(ki - r, ki + r + 1):
                for j in range(kj - r, kj + r + 1):
                    for county, la, lo in self.cells.get((i, j), ()):
                        d = hav(lat, lon, la, lo)
                        if d < bestd:
                            best, bestd = county, d
            if best:
                return best
        return None


def check() -> int:
    n = Nearest([("شهرستان اهواز", 31.3189, 48.6842), ("شهرستان دزفول", 32.381, 48.405)])
    assert n.county(31.32, 48.69) == "شهرستان اهواز"
    assert n.county(32.39, 48.41) == "شهرستان دزفول"
    assert abs(hav(31.3189, 48.6842, 31.3189, 48.6842)) < 1e-9
    print("check: nearest-county lookup OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        return check()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    rows = [(r["county"], r["lat"], r["lon"]) for r in c.execute(
        "SELECT county, lat, lon FROM v_map_settlement WHERE lat IS NOT NULL AND county IS NOT NULL")]
    nearest = Nearest(rows)
    print(f"settlements for county lookup: {len(rows):,}")

    # ways already inside a city file are drawn by that file; skip them so the two layers
    # never paint the same line twice
    cities = {os.path.basename(p) for p in glob.glob(os.path.join(GEO, "streets_city-*.json"))}
    in_city: set[tuple] = set()
    for p in glob.glob(os.path.join(GEO, "streets_city-*.json")):
        d = json.load(open(p, encoding="utf-8"))
        for f in d.get("features", []):
            co = f["geometry"]["coordinates"]
            in_city.add((round(co[0][0], 4), round(co[0][1], 4),
                         round(co[-1][0], 4), round(co[-1][1], 4)))
    print(f"city files: {len(cities)} · ways already covered: {len(in_city):,}")

    by_county: dict[str, list[dict]] = {}
    skipped_in_city = 0
    total = 0
    for f in sorted(glob.glob(os.path.join(TILES, "*.json"))):
        for el in json.load(open(f, encoding="utf-8")):
            if (el.get("tags") or {}).get("highway") not in CLASSES:
                continue
            pts = [(float(p["lat"]), float(p["lon"])) for p in (el.get("geometry") or [])
                   if p.get("lat") is not None]
            if len(pts) < 2:
                continue
            total += 1
            key = (round(pts[0][1], 4), round(pts[0][0], 4),
                   round(pts[-1][1], 4), round(pts[-1][0], 4))
            if key in in_city:
                skipped_in_city += 1
                continue
            mid = pts[len(pts) // 2]
            county = nearest.county(mid[0], mid[1])
            if not county:
                continue
            simple = rdp(pts, TOLERANCE)
            if len(simple) < 2:
                continue
            by_county.setdefault(county, []).append({
                "type": "Feature",
                "properties": {"c": (el.get("tags") or {}).get("highway")},
                "geometry": {"type": "LineString",
                             "coordinates": [[round(lo, 5), round(la, 5)] for la, lo in simple]},
            })

    index = []
    written = 0
    for county, feats in sorted(by_county.items(), key=lambda kv: -len(kv[1])):
        slug = slug_of(county)
        path = os.path.join(GEO, f"{slug}.json")
        json.dump({"county": county, "features": feats}, open(path, "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
        # A 4 MB county file is one slow request on a phone. Split anything over
        # ~1.2 MB into 0.25° tiles, which is what the client's distance test already
        # understands — one file per screen instead of one per county.
        if os.path.getsize(path) > 1_200_000:
            os.remove(path)
            tiles: dict[tuple[int, int], list[dict]] = {}
            for f in feats:
                co = f["geometry"]["coordinates"][len(f["geometry"]["coordinates"]) // 2]
                tiles.setdefault((round(co[1] / 0.25), round(co[0] / 0.25)), []).append(f)
            for (ti, tj), tf in tiles.items():
                sub = f"{slug}-{ti}_{tj}"
                spath = os.path.join(GEO, f"{sub}.json")
                json.dump({"county": county, "features": tf}, open(spath, "w", encoding="utf-8"),
                          ensure_ascii=False, separators=(",", ":"))
                la = [p[1] for g in tf for p in g["geometry"]["coordinates"]]
                lo = [p[0] for g in tf for p in g["geometry"]["coordinates"]]
                clat, clon = sum(la) / len(la), sum(lo) / len(lo)
                index.append({
                    "county": county, "slug": sub, "lat": round(clat, 5), "lon": round(clon, 5),
                    "r_km": round(max(hav(clat, clon, a, b) for a, b in zip(la, lo)), 1),
                    "ways": len(tf), "kb": round(os.path.getsize(spath) / 1024),
                })
            print(f"  {county[:28]:30s} {len(feats):>6,} ways · split into {len(tiles)} tiles")
            continue
        lats = [p[1] for f in feats[:400] for p in f["geometry"]["coordinates"]]
        lons = [p[0] for f in feats[:400] for p in f["geometry"]["coordinates"]]
        for f in feats:
            for lo, la in f["geometry"]["coordinates"]:
                lats.append(la)
                lons.append(lo)
        clat, clon = sum(lats) / len(lats), sum(lons) / len(lons)
        r = max(hav(clat, clon, la, lo) for la, lo in zip(lats, lons))
        index.append({
            "county": county, "slug": slug, "lat": round(clat, 5), "lon": round(clon, 5),
            "r_km": round(r, 1), "ways": len(feats),
            "kb": round(os.path.getsize(path) / 1024),
        })
        written += 1
        print(f"  {county[:28]:30s} {len(feats):>6,} ways · {index[-1]['kb']:>5} KB")

    json.dump(index, open(os.path.join(GEO, "rural_index.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    size = sum(i["kb"] for i in index) / 1024
    print(f"\n{written} counties · {sum(i['ways'] for i in index):,} ways · {size:.1f} MB total "
          f"(largest {max(i['kb'] for i in index)} KB)")
    print(f"residential ways seen {total:,} · already in a city file {skipped_in_city:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
