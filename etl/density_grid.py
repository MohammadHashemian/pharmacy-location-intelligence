"""Fine-grained pharmacy density: residents per pharmacy within a short walk.

Two things were wrong with the coarse layer.

  * The cell was a whole settlement, so one number described a 40 km² آبادی. A pharmacy serves
    a few streets; the map has to be at that scale.
  * Supply was counted per settlement, so a block with five pharmacies three doors apart
    inherited the whole town's shop count and read as «saturated» — which is not what a person
    standing in that block sees.

This writes a 0.002° grid (≈ 200 m) over the built-up mask, with two windowed quantities per
cell over an 800 m walking radius:

    pop800 = residents living within 800 m of the cell
    ph800  = pharmacies standing within 800 m of the cell
    ratio  = pop800 / ph800          residents per pharmacy *at this corner*
             (ph800 = 0 → ratio = pop800 and the cell is flagged as unserved)

Population is disaggregated onto built-up cells only — street geometry, not a blob around the
settlement point — so a village's 900 people spread across its actual lanes, and a city's
1.2 M across its blocks.

    python etl/density_grid.py [--cell 0.002] [--radius 0.8]
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sqlite3

import numpy as np

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")

KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(31.5))


def window_sum(a: np.ndarray, r: int) -> np.ndarray:
    """Sum of `a` inside a square window of half-width r, via an integral image."""
    p = np.zeros((a.shape[0] + 1, a.shape[1] + 1), dtype=np.float64)
    p[1:, 1:] = a.cumsum(0).cumsum(1)
    y0 = np.clip(np.arange(a.shape[0]) - r, 0, a.shape[0])
    y1 = np.clip(np.arange(a.shape[0]) + r + 1, 0, a.shape[0])
    x0 = np.clip(np.arange(a.shape[1]) - r, 0, a.shape[1])
    x1 = np.clip(np.arange(a.shape[1]) + r + 1, 0, a.shape[1])
    return (p[np.ix_(y1, x1)] - p[np.ix_(y0, x1)] - p[np.ix_(y1, x0)] + p[np.ix_(y0, x0)])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", type=float, default=0.002)
    ap.add_argument("--radius", type=float, default=0.8, help="walking radius in km")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    settlements = [dict(r) for r in c.execute("""
        SELECT s.area_id, s.name, s.lat, s.lon, s.population,
               COALESCE(ss.footprint_km2, 0.8) AS footprint_km2,
               COALESCE(ss.supply, 0)          AS supply
          FROM v_map_settlement s
          LEFT JOIN settlement_service ss ON ss.area_id = s.area_id
         WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL AND s.population > 0""")]
    pins = [dict(r) for r in c.execute("""
        SELECT lat, lon FROM map_pharmacy WHERE lat IS NOT NULL
        UNION ALL
        SELECT lat, lon FROM manual_place WHERE kind = 'pharmacy' AND lat IS NOT NULL""")]
    if not settlements:
        print("nothing to do")
        return 1

    cell = args.cell
    lat0 = min(s["lat"] for s in settlements) - 0.05
    lat1 = max(s["lat"] for s in settlements) + 0.05
    lon0 = min(s["lon"] for s in settlements) - 0.05
    lon1 = max(s["lon"] for s in settlements) + 0.05
    ny = int((lat1 - lat0) / cell) + 1
    nx = int((lon1 - lon0) / cell) + 1
    print(f"grid {ny} x {nx} = {ny * nx:,} cells of "
          f"{(cell * KM_PER_DEG_LAT) * (cell * KM_PER_DEG_LON):.3f} km²")

    def iy_of(lat: float) -> int:
        return int((lat - lat0) / cell)

    def ix_of(lon: float) -> int:
        return int((lon - lon0) / cell)

    # ---- built-up mask: a street vertex marks a built cell
    built = np.zeros((ny, nx), dtype=bool)
    files = sorted(glob.glob(os.path.join(HOME, "web", "public", "geo", "streets_city-*.json")))
    for fp in files:
        try:
            fc = json.load(open(fp, encoding="utf-8"))
        except Exception:
            continue
        for feat in fc.get("features", []):
            geom = feat.get("geometry") or {}
            if geom.get("type") != "LineString":
                continue
            for lon, lat in geom.get("coordinates", []):
                if lat0 <= lat <= lat1 and lon0 <= lon <= lon1:
                    built[iy_of(lat), ix_of(lon)] = True

    # villages have no street file: give them a disc the size of their footprint
    for s in settlements:
        if (s["population"] or 0) >= 20000:
            continue
        r_km = min(2.0, max(0.25, math.sqrt(max(0.3, float(s["footprint_km2"])) / math.pi)))
        dy = int(r_km / (cell * KM_PER_DEG_LAT)) + 1
        dx = int(r_km / (cell * KM_PER_DEG_LON)) + 1
        iy, ix = iy_of(s["lat"]), ix_of(s["lon"])
        for y in range(max(0, iy - dy), min(ny, iy + dy + 1)):
            for x in range(max(0, ix - dx), min(nx, ix + dx + 1)):
                clat = lat0 + (y + 0.5) * cell
                clon = lon0 + (x + 0.5) * cell
                if math.hypot((clat - s["lat"]) * KM_PER_DEG_LAT,
                              (clon - s["lon"]) * KM_PER_DEG_LON) <= r_km:
                    built[y, x] = True

    # nearest settlement per built cell, then its population shared evenly across its cells
    ys, xs = np.nonzero(built)
    print(f"built cells {len(ys):,} = "
          f"{len(ys) * (cell * KM_PER_DEG_LAT) * (cell * KM_PER_DEG_LON):,.0f} km²")
    S = np.array([[s["lat"], s["lon"]] for s in settlements])
    spop = np.array([float(s["population"]) for s in settlements])
    owner = np.zeros(len(ys), dtype=np.int32)
    for i in range(0, len(ys), 60000):
        sl = slice(i, i + 60000)
        clat = lat0 + (ys[sl] + 0.5) * cell
        clon = lon0 + (xs[sl] + 0.5) * cell
        d = np.hypot((clat[:, None] - S[None, :, 0]) * KM_PER_DEG_LAT,
                     (clon[:, None] - S[None, :, 1]) * KM_PER_DEG_LON)
        owner[sl] = d.argmin(axis=1)

    pop = np.zeros((ny, nx), dtype=np.float64)
    counts = np.bincount(owner, minlength=len(settlements)).astype(np.float64)
    share = np.where(counts > 0, spop / np.maximum(counts, 1), 0.0)
    np.add.at(pop, (ys, xs), share[owner])

    # Supply: the FDA register spread over each settlement's own built cells, plus every live
    # pin on top. Counting pins alone made a city with 341 registered pharmacies look like it
    # had five, which is what produced the absurd «90,000 residents per pharmacy» cells.
    ph = np.zeros((ny, nx), dtype=np.float64)
    mapped_per_owner = np.bincount(owner, minlength=len(settlements)).astype(np.float64)
    reg = np.array([float(s["supply"]) for s in settlements])
    # how many of the register's shops are already represented by a pin near that settlement
    pin_owner = np.zeros(len(pins), dtype=np.int32)
    for i, p in enumerate(pins):
        pin_owner[i] = int(np.hypot((S[:, 0] - p["lat"]) * KM_PER_DEG_LAT,
                                    (S[:, 1] - p["lon"]) * KM_PER_DEG_LON).argmin())
    pin_count = np.bincount(pin_owner, minlength=len(settlements)).astype(np.float64)
    residual = np.clip(reg - pin_count, 0.0, None)
    per_cell_supply = np.where(mapped_per_owner > 0, residual / np.maximum(mapped_per_owner, 1), 0.0)
    np.add.at(ph, (ys, xs), per_cell_supply[owner])
    for p in pins:
        y, x = iy_of(p["lat"]), ix_of(p["lon"])
        if 0 <= y < ny and 0 <= x < nx:
            ph[y, x] += 1.0

    r_cells = max(1, int(round(args.radius / ((cell * KM_PER_DEG_LAT + cell * KM_PER_DEG_LON) / 2))))
    pop800 = window_sum(pop, r_cells)
    ph800 = window_sum(ph, r_cells)
    # a fractional shop from the register spread is still a shop; below a twentieth of one
    # the window has no pharmacy at all
    service = np.where(ph800 < 0.5, 0.0, ph800)
    ratio = np.where(service > 0, pop800 / np.maximum(service, 1e-9), pop800)
    ratio = np.minimum(ratio, 99999)

    keep = (pop800 >= 250) & built
    ys2, xs2 = np.nonzero(keep)
    print(f"cells kept {len(ys2):,}  ·  radius covers {r_cells} cells")

    c.execute("DROP TABLE IF EXISTS density_cell")
    c.execute("""CREATE TABLE density_cell (
        cy INTEGER, cx INTEGER, lat REAL, lon REAL,
        pop_800 INTEGER, ph_800 INTEGER, ratio INTEGER, unserved INTEGER,
        PRIMARY KEY (cy, cx))""")
    rows = [(int(y), int(x),
             round(lat0 + (y + 0.5) * cell, 5), round(lon0 + (x + 0.5) * cell, 5),
             int(round(pop800[y, x])), int(round(service[y, x])), int(round(ratio[y, x])),
             int(round(service[y, x]) == 0))
            for y, x in zip(ys2, xs2)]
    c.executemany("INSERT INTO density_cell VALUES (?,?,?,?,?,?,?,?)", rows)

    n_bad = int((ratio[keep] > 5408).sum())
    print(f"unserved cells {int((service[keep] == 0).sum()):,}")
    print(f"cells above 5,408 residents per pharmacy: {n_bad:,}")
    print(f"median ratio {float(np.median(ratio[keep])):,.0f} · "
          f"p90 {float(np.percentile(ratio[keep], 90)):,.0f}")
    c.execute("DELETE FROM service_metric WHERE key LIKE 'density_%'")
    c.executemany("INSERT INTO service_metric VALUES (?,?,?)", [
        ("density_cells", len(rows), "سلول‌های ۲۰۰ متری با سکونت و داروخانه"),
        ("density_median", float(np.median(ratio[keep])), "نفر به ازای داروخانه در ۸۰۰ متر"),
        ("density_over", n_bad, "سلول‌هایی با بیش از ۵٬۴۰۸ نفر به ازای هر داروخانه"),
    ])
    c.commit()
    c.close()
    print(f"\nwritten: density_cell ({len(rows):,} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
