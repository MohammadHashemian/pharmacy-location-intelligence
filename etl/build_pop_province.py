"""A population surface for the whole province, not just the surveyed cities.

`build_pop_surface.py` gives a 250 m surface for cities whose street network we
fetched (اهواز today, more as the fetcher runs). Everywhere else the map only knew
«settlement X holds N people at this one point», which is exactly the smearing the
density layer was built to avoid.

This builds a 1 km grid over all of خوزستان and spreads each settlement's census
population over its built-up disc with a weight that mixes three signals we already
hold province-wide:

  * a distance kernel `(1 - d/r)^2` — people thin out towards the edge of a town;
  * **mapped POIs** on the cell (pharmacies, clinics, hospitals) — a pharmacy does not
    stand in a field, so a cell with three of them is built-up land;
  * street metres, where a city's street file exists (fallback for the rest).

Cells inside a city that already has the finer 250 m surface are skipped, so the two
files never describe the same ground.

    python etl/build_pop_province.py
    python etl/build_pop_province.py --cell-km 1.5

Output `web/public/geo/pop_province.json`:
    {"cell_km":1, "cities":[...], "cells":[[lat, lon, population], ...]}
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
GEO = os.path.join(HOME, "web", "public", "geo")
URBAN = os.path.join(GEO, "urban_pop.json")
OUT = os.path.join(GEO, "pop_province.json")


def hav(alat: float, alon: float, blat: float, blon: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(alat), math.radians(blat)
    dp = p2 - p1
    dl = math.radians(blon - alon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def mask_km(pop: float) -> float:
    """Same built-up proxy the map uses: a city is an area, not a dot."""
    return max(2.5, min(12.0, 0.9 * math.sqrt(max(pop, 0) / 1000)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell-km", type=float, default=0.5)
    ap.add_argument("--poi-boost", type=float, default=0.15,
                    help="weight added per mapped POI, when no street raster covers the cell")
    ap.add_argument("--street-floor", type=float, default=40.0,
                    help="metres of street credited to a cell with none mapped, times (1-d/r)^2")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    settlements = [dict(r) for r in c.execute("""
        SELECT area_id, name, lat, lon, population, pharmacy_total
        FROM v_map_settlement WHERE lat IS NOT NULL
    """)]
    pois = [(r["lat"], r["lon"]) for r in c.execute(
        "SELECT lat, lon FROM map_pharmacy UNION ALL SELECT lat, lon FROM map_medical")]

    # Ground already described by the finer 250 m surface is skipped *cell by cell*
    # (not by disc). A disc test looked right and was disastrous: 86 cities × the
    # 12 km street radius covers 39,000 km² of a 68,000 km² province, which left 9 %
    # of the population to place.
    fine_cells: set[tuple[int, int]] = set()
    if os.path.exists(URBAN):
        u = json.load(open(URBAN, encoding="utf-8"))
        for la, lo, *_ in u.get("cells", []):
            fine_cells.add((round(la / 0.01), round(lo / 0.01)))
        print(f"finer surface owns {len(fine_cells):,} cells "
              f"({len(u.get('cities', []))} cities)")

    raster: dict[tuple[int, int], float] = {}
    raster_path = os.path.join(HOME, "data", "derived", "street_raster.json")
    if os.path.exists(raster_path):
        raw = json.load(open(raster_path, encoding="utf-8"))
        rcell = float(raw.get("cell_km", 0.5)) / args.cell_km
        for la, lo, m in raw["cells"]:
            raster[(round(la / (0.5 / 110.57)), round(lo / (0.5 / 111.0)))] = m
        print(f"street raster: {len(raster):,} cells at {raw.get('cell_km')} km, "
              f"scaled to {args.cell_km} km grid (factor {rcell:.2f})")
    else:
        print("no street raster — falling back to the kernel + POI weights")

    step = args.cell_km
    lats = [s["lat"] for s in settlements]
    lons = [s["lon"] for s in settlements]
    lat0, lat1 = min(lats) - 0.1, max(lats) + 0.1
    lon0, lon1 = min(lons) - 0.1, max(lons) + 0.1
    dlat = step / 110.57
    dlon = step / (111.32 * math.cos(math.radians((lat0 + lat1) / 2)))

    # bucket POIs so a cell can ask "how many mapped places are on me" in O(1)
    def ckey(la: float, lo: float) -> tuple[int, int]:
        return (round(la / dlat), round(lo / dlon))

    poi_cells: dict[tuple[int, int], int] = {}
    for pla, plo in pois:
        k = ckey(pla, plo)
        poi_cells[k] = poi_cells.get(k, 0) + 1

    acc: dict[tuple[int, int], float] = {}
    total = 0.0
    skipped_covered = 0
    skipped_town = 0
    for s in settlements:
        pop = float(s["population"] or 0)
        if pop <= 0:
            continue
        total += pop
        r = mask_km(pop)
        ila0, ila1 = round((s["lat"] - r / 110.57) / dlat), round((s["lat"] + r / 110.57) / dlat)
        ilo0, ilo1 = round((s["lon"] - r / (111.32 * math.cos(math.radians(s["lat"])))) / dlon), \
                     round((s["lon"] + r / (111.32 * math.cos(math.radians(s["lat"])))) / dlon)
        cells: list[tuple[tuple[int, int], float]] = []
        wsum = 0.0
        considered = 0
        for i in range(min(ila0, ila1), max(ila0, ila1) + 1):
            for j in range(min(ilo0, ilo1), max(ilo0, ilo1) + 1):
                la, lo = i * dlat, j * dlon
                d = hav(s["lat"], s["lon"], la, lo)
                if d > r:
                    continue
                considered += 1
                if (round(la / 0.01), round(lo / 0.01)) in fine_cells:
                    skipped_covered += 1
                    continue
                kernel = (1 - d / r) ** 2
                # 500 m raster lookup (average of the sub-cells under this one)
                metres = 0.0
                if raster:
                    sub = 0
                    got = 0
                    for si in range(2):
                        for sj in range(2):
                            key_r = (round((la + (si - 0.5) * step / 2) / (0.5 / 110.57)),
                                     round((lo + (sj - 0.5) * step / 2) / (0.5 / 111.0)))
                            m = raster.get(key_r)
                            if m:
                                got += 1
                                sub += m
                    metres = sub / got if got else 0.0
                if metres > 0:
                    w = metres + args.street_floor * kernel
                else:
                    w = args.street_floor * kernel + args.poi_boost * 10 * poi_cells.get((i, j), 0)
                if w <= 0:
                    continue
                cells.append(((i, j), w))
                wsum += w
        if wsum <= 0:
            continue
        # Only the share of a settlement whose ground this file actually owns. A city
        # already described by the 250 m surface keeps a handful of cells, and handing
        # it the whole census put 343,270 people in one square; skipping it outright
        # instead dropped 716 villages.
        share = len(cells) / considered if considered else 0.0
        if share < 0.02:
            skipped_town += 1
            continue
        pop = pop * share
        for (i, j), w in cells:
            acc[(i, j)] = acc.get((i, j), 0.0) + pop * w / wsum

    # A 0.5 km cell holding 29,713 people is a computation, not a place: dense Iranian
    # blocks top out around 25,000/km2, so 6,000 per cell is already generous. Clipping
    # keeps the surface honest and says how much was clipped.
    CAP = 6000.0
    clipped = sum(1 for v in acc.values() if v > CAP)
    cells_out = [[round(i * dlat, 4), round(j * dlon, 4), round(min(v, CAP), 1)]
                 for (i, j), v in acc.items() if v >= 1.0]
    assigned = sum(x[2] for x in cells_out)
    payload = {
        "generated_by": "etl/build_pop_province.py",
        "cell_km": step,
        "method": "census population per settlement spread over its built-up disc by "
                  "OSM street metres per cell (fallback: (1-d/r)^2 kernel + POIs)",
        "settlements": len(settlements),
        "population": round(total),
        "assigned": round(assigned),
        "skipped_cells_covered_by_fine_surface": skipped_covered,
        "clipped_cells": clipped,
        "settlements_left_to_the_fine_surface": skipped_town,
        "cells": cells_out,
    }
    json.dump(payload, open(OUT, "w", encoding="utf-8"), separators=(",", ":"))
    print(f"settlements {len(settlements):,} · population {total:,.0f} · "
          f"cells {len(cells_out):,} · assigned {assigned:,.0f} "
          f"({assigned / max(1, total) * 100:.1f} %)")
    print(f"wrote {OUT}: {os.path.getsize(OUT) / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
