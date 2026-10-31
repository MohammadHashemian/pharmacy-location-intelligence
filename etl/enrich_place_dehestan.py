"""Attach each mapped place to its دهستان (OSM admin_level=7).

Why a separate step instead of a column in `geo_places`:
`load_geo.py` resolves the شهرستان and the بخش because the FDA comparison needs
them. The دهستان is a display/analysis nicety (village → دهستان → بخش → شهرستان),
so it is computed from the raw Overpass capture straight into the GeoJSON the
atlas reads. No network, no DB write, no re-run of the expensive Wikidata layer.

  in : data/raw/osm/khuzestan_admin7.json   (188 دهستان relations, `out geom`)
       web/public/geo/khuzestan_places.geojson
  out: the same GeoJSON with `dehestan` / `dehestan_method` on every feature

Point-in-polygon is the same even-odd ray cast as `load_geo.py` (imported, not
copied) over all relation member segments, so holes and multipolygons behave.

ponytail: the assignment lives in the export, so `export_geo_map.py` overwrites
it. Re-run this file afterwards (it is in `rebuild_geo.sh`).
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_geo import haversine_km, norm_key, points_inside, relation_segments  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HOME, "data", "raw", "osm", "khuzestan_admin7.json")
GEOJSON = os.path.join(HOME, "web", "public", "geo", "khuzestan_places.geojson")
NEAREST_KM = 12.0          # beyond this a "nearest" guess is worse than "unknown"


def build_polys(elements: list[dict]) -> list[dict]:
    polys = []
    for el in elements:
        segs = relation_segments(el)
        t = el.get("tags") or {}
        name = (t.get("name") or "").strip()
        if segs is None or not name:
            continue
        polys.append({
            "segments": segs,
            "bbox": (segs[:, 0].min(), segs[:, 1].min(),
                     segs[:, 0].max(), segs[:, 1].max()),
            "name": name,
            "name_key": norm_key(name),
            "centroid": (segs[:, 0].mean(), segs[:, 1].mean()),
            "osm_id": el["id"],
        })
    return polys


def main() -> int:
    polys = build_polys(json.load(open(RAW, encoding="utf-8"))["elements"])
    print(f"دهستان polygons: {len(polys)}")
    geo = json.load(open(GEOJSON, encoding="utf-8"))
    feats = geo["features"]
    lonlat = np.array([[f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]]
                       for f in feats], dtype=float)

    hits: list[list[int]] = [[] for _ in feats]
    for pi, poly in enumerate(polys):
        x0, y0, x1, y1 = poly["bbox"]
        pre = np.where((lonlat[:, 0] >= x0) & (lonlat[:, 0] <= x1) &
                       (lonlat[:, 1] >= y0) & (lonlat[:, 1] <= y1))[0]
        if pre.size == 0:
            continue
        inside = points_inside(poly["segments"], lonlat[pre])
        for idx in pre[inside]:
            hits[idx].append(pi)

    n_none = n_multi = n_one = 0
    for i, (f, h) in enumerate(zip(feats, hits)):
        p = f["properties"]
        if len(h) == 1:
            poly, method = polys[h[0]], "polygon"
            n_one += 1
        elif len(h) > 1:      # overlapping polygons: take the most specific (smallest)
            poly = min((polys[k] for k in h),
                       key=lambda q: (q["bbox"][2] - q["bbox"][0]) *
                                     (q["bbox"][3] - q["bbox"][1]))
            method = "polygon-ambiguous"
            n_multi += 1
        else:
            d = [haversine_km(lonlat[i][1], lonlat[i][0],
                              q["centroid"][1], q["centroid"][0]) for q in polys]
            k = int(np.argmin(d))
            if d[k] <= NEAREST_KM:
                poly, method = polys[k], "nearest"
            else:
                poly, method = None, "unknown"
            n_none += 1
        p["dehestan"] = poly["name"] if poly else None
        p["dehestan_method"] = method

    json.dump(geo, open(GEOJSON, "w", encoding="utf-8"), ensure_ascii=False)
    assigned = sum(1 for f in feats if f["properties"].get("dehestan"))
    print(f"  inside exactly one: {n_one:,} | ambiguous: {n_multi} | outside all: {n_none}")
    print(f"  places with a دهستان: {assigned:,}/{len(feats):,} "
          f"({100*assigned/len(feats):.1f}%)")
    print(f"  wrote {GEOJSON}  ({os.path.getsize(GEOJSON)/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
