"""The roads between towns — the layer that made a small city look unconnected.

`fetch_province_streets.py` keeps only what falls inside each city's disc, so a town's
own lanes are there but the tertiary road leaving it is not: ویس has 287 ways inside
6 km and looked stranded. The province roads file carries motorway…secondary only.

This builds one small file from the cached tiles: every tertiary / unclassified /
living_street way in خوزستان, simplified to ~20 m. 19,693 ways in, ~2 MB of GeoJSON
out, drawn from 1.4x as context under the city streets.

    python etl/build_connectors.py
"""
from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_urban_detail import rdp  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(HOME, "data", "derived", "tiles")
OUT = os.path.join(HOME, "web", "public", "geo", "streets_connectors.json")
CLASSES = {"tertiary", "unclassified", "living_street"}


def main() -> int:
    feats: list[dict] = []
    for f in sorted(glob.glob(os.path.join(TILES, "*.json"))):
        for el in json.load(open(f, encoding="utf-8")):
            cls = (el.get("tags") or {}).get("highway")
            if cls not in CLASSES:
                continue
            pts = [(float(p["lat"]), float(p["lon"])) for p in (el.get("geometry") or [])
                   if p.get("lat") is not None]
            if len(pts) < 2:
                continue
            simple = rdp(pts, 0.0003)          # ~33 m: context, not navigation; 3.9 → ~2.6 MB
            if len(simple) < 2:
                continue
            feats.append({
                "type": "Feature",
                "properties": {"c": cls},
                "geometry": {"type": "LineString",
                             "coordinates": [[round(lo, 5), round(la, 5)] for la, lo in simple]},
            })

    payload = {"type": "FeatureCollection", "generated_by": "etl/build_connectors.py",
               "classes": sorted(CLASSES), "features": feats}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT) / 1e6
    pts = sum(len(f["geometry"]["coordinates"]) for f in feats)
    print(f"{len(feats):,} ways · {pts:,} points · {size:.1f} MB → {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
