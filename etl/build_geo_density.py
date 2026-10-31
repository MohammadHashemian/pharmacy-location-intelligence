"""Pharmacy-density surface for خوزستان, computed only where people live.

The FDA feed gives a pharmacy count per settlement; it does not say *where the
pressure is*. This derives that surface from the map layer already in
`web/public/geo/khuzestan_places.geojson`:

  * a ~3.3 km grid over the province bounding box,
  * every cell is kept only if a settlement (city/town/village/hamlet/…) is
    within MASK_KM — that is the "residential mask". Desert, salt flats, the
    Zagros ridges and the marshes get no cell, so a density colour can never
    appear where nobody lives,
  * each kept cell carries the population and pharmacy count within RADIUS_KM,
    the ratio per 10 000 residents, and the gap against the provincial median
    residents-per-pharmacy (positive = undersupplied).

Output: data/derived/geo_density.json — small on purpose, it ships inside the
atlas HTML.

Usage: python etl/build_geo_density.py [--check]
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON = os.path.join(HOME, "web", "public", "geo", "khuzestan_places.geojson")
OUT = os.path.join(HOME, "data", "derived", "geo_density.json")

LAT0 = 31.4                      # projection origin: mid-province
STEP_LAT = 0.030                 # ~3.3 km
STEP_LON = 0.033
RADIUS_KM = 10.0                 # window over which density is measured
MASK_KM = 2.5                    # a cell must be this close to a settlement
RESIDENT_KINDS = {"city", "town", "village", "hamlet", "isolated_dwelling",
                  "neighbourhood"}


def km_xy(lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    k = math.cos(math.radians(LAT0))
    return (lon - 48.0) * 111.32 * k, (lat - LAT0) * 110.57


def main() -> int:
    geo = json.load(open(GEOJSON, encoding="utf-8"))
    lat = np.array([f["geometry"]["coordinates"][1] for f in geo["features"]])
    lon = np.array([f["geometry"]["coordinates"][0] for f in geo["features"]])
    props = [f["properties"] for f in geo["features"]]
    kind = np.array([p.get("place_kind") or "" for p in props])
    pop = np.array([float(p.get("population_best") or 0) for p in props])
    ph = np.array([float(p.get("n_pharmacy_total") or 0) for p in props])
    # The map's own population tag carries two absurd values (دُب حردان 1,000,000
    # and کوله جاز 450,000, both flagged pop_outlier). Left in, they swallow the
    # whole province in any 10 km window and fake a huge "gap" around اهواز.
    bad = np.array(["pop_outlier" in (p.get("dq_flags") or "") for p in props])
    pop[bad] = 0.0

    resident = np.isin(kind, list(RESIDENT_KINDS))
    resident_idx = np.where(resident)[0]
    x, y = km_xy(lat, lon)
    tree = cKDTree(np.c_[x[resident], y[resident]])
    # nearest city/town: orients a cell ("10 km from شوش") far better than the
    # nearest settlement, which in an urban cell is just the closest neighbourhood
    urban_idx = np.where(np.isin(kind, ["city", "town"]))[0]
    urban_tree = cKDTree(np.c_[x[urban_idx], y[urban_idx]])

    prov_pop, prov_ph = pop[pop > 0].sum(), ph.sum()
    per_pharm = prov_pop / prov_ph if prov_ph else 0.0

    # grid over the residential places' own extent
    lon_lo, lon_hi = lon[resident].min(), lon[resident].max()
    lat_lo, lat_hi = lat[resident].min(), lat[resident].max()
    lats = np.arange(lat_lo - 0.03, lat_hi + 0.03, STEP_LAT)
    lons = np.arange(lon_lo - 0.03, lon_hi + 0.03, STEP_LON)
    glat, glon = np.meshgrid(lats, lons, indexing="ij")
    gpx, gpy = km_xy(glat.ravel(), glon.ravel())
    mask_d, _ = tree.query(np.c_[gpx, gpy], k=1)
    keep = mask_d <= MASK_KM

    cells = []
    for i in np.where(keep)[0]:
        near = resident_idx[tree.query_ball_point([gpx[i], gpy[i]], RADIUS_KM)]
        w_pop = float(pop[near].sum()) if near.size else 0.0
        w_ph = float(ph[near].sum()) if near.size else 0.0
        if w_pop <= 0:
            continue                     # nobody there: not a residential cell
        j = int(tree.query([gpx[i], gpy[i]], k=1)[1])    # nearest settlement
        u = int(urban_tree.query([gpx[i], gpy[i]], k=1)[1])
        cells.append({
            "lat": round(float(glat.ravel()[i]), 4),
            "lon": round(float(glon.ravel()[i]), 4),
            "pop": int(round(w_pop)),
            "ph": int(round(w_ph)),
            "dens": round(w_ph / w_pop * 1e4, 3),          # pharmacies per 10 000
            "gap": round(w_pop / per_pharm - w_ph, 1) if per_pharm else 0.0,
            "name": props[resident_idx[j]]["name"],
            "county": props[resident_idx[j]].get("county"),
            "dehestan": props[resident_idx[j]].get("dehestan"),
            "city": props[urban_idx[u]]["name"],
        })

    meta = {
        "step_lat": STEP_LAT, "step_lon": STEP_LON, "radius_km": RADIUS_KM,
        "mask_km": MASK_KM, "residents_per_pharmacy": round(per_pharm),
        "province_population": int(prov_pop), "province_pharmacies": int(prov_ph),
        "cells": len(cells), "grid_cells": int(len(gpx)), "kept_before_pop": int(keep.sum()),
    }
    json.dump({"meta": meta, "cells": cells}, open(OUT, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print(f"grid {len(gpx):,} cells -> residential mask {int(keep.sum()):,} "
          f"-> with population {len(cells):,}")
    print(f"provincial median basis: {per_pharm:,.0f} people per pharmacy")
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)")

    if "--check" in sys.argv:
        # One runnable assertion per property that would silently ruin the map.
        assert cells, "no cells produced"
        assert all(c["pop"] > 0 for c in cells), "a cell without population slipped in"
        assert max(c["dens"] for c in cells) < 200, "density looks like a units bug"
        assert 29.0 <= min(c["lat"] for c in cells), "latitude below the province"
        assert max(c["lat"] for c in cells) <= 33.5, "latitude above the province"
        covered = sum(c["pop"] for c in cells)          # windows overlap, so > province pop
        assert covered > prov_pop, "windows do not even cover the province"
        print("check: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
