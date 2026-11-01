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
    ap.add_argument("--cell-km", type=float, default=1.0)
    ap.add_argument("--poi-boost", type=float, default=0.6,
                    help="weight added per mapped POI on a cell, relative to the kernel")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    settlements = [dict(r) for r in c.execute("""
        SELECT area_id, name, lat, lon, population, pharmacy_total
        FROM v_map_settlement WHERE lat IS NOT NULL
    """)]
    pois = [(r["lat"], r["lon"]) for r in c.execute(
        "SELECT lat, lon FROM map_pharmacy UNION ALL SELECT lat, lon FROM map_medical")]

    # Cities that already have the finer 250 m surface: their ground is not rebuilt
    # here, so the two files never describe the same cell.
    covered: list[tuple[float, float, float]] = []
    for row in c.execute("""
        SELECT city, AVG(lat) AS la, AVG(lon) AS lo,
               MAX(ABS(lat - (SELECT AVG(lat) FROM urban_cell WHERE city = u.city))) AS dla
        FROM urban_cell u GROUP BY city
    """):
        pass
    # radius from the actual cell extents (the sub-select above is awkward in SQLite,
    # so it is done in python where it is readable)
    cells_by_city: dict[str, list[tuple[float, float]]] = {}
    for r in c.execute("SELECT city, lat, lon FROM urban_cell"):
        cells_by_city.setdefault(r["city"], []).append((r["lat"], r["lon"]))
    for city, pts in cells_by_city.items():
        cla = sum(p[0] for p in pts) / len(pts)
        clo = sum(p[1] for p in pts) / len(pts)
        rad = max(hav(cla, clo, a, b) for a, b in pts) * 1.05
        covered.append((cla, clo, rad))
    print(f"covered by the fine surface: {[(round(a,3), round(b,3), round(r,1)) for a,b,r in covered]}")

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
        for i in range(min(ila0, ila1), max(ila0, ila1) + 1):
            for j in range(min(ilo0, ilo1), max(ilo0, ilo1) + 1):
                la, lo = i * dlat, j * dlon
                d = hav(s["lat"], s["lon"], la, lo)
                if d > r:
                    continue
                if any(hav(la, lo, cla, clo) < cr * 1.02 for cla, clo, cr in covered if cr > 0):
                    skipped_covered += 1
                    continue
                kernel = (1 - d / r) ** 2
                w = kernel + args.poi_boost * poi_cells.get((i, j), 0)
                if w <= 0:
                    continue
                cells.append(((i, j), w))
                wsum += w
        if wsum <= 0:
            continue
        for (i, j), w in cells:
            acc[(i, j)] = acc.get((i, j), 0.0) + pop * w / wsum

    cells_out = [[round(i * dlat, 4), round(j * dlon, 4), round(v, 1)]
                 for (i, j), v in acc.items() if v >= 1.0]
    assigned = sum(x[2] for x in cells_out)
    payload = {
        "generated_by": "etl/build_pop_province.py",
        "cell_km": step,
        "method": "census population per settlement spread over its built-up disc by "
                  "(1-d/r)^2 kernel + mapped POIs per cell",
        "settlements": len(settlements),
        "population": round(total),
        "assigned": round(assigned),
        "skipped_cells_covered_by_fine_surface": skipped_covered,
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
