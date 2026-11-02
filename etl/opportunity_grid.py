"""Where is there still room for a pharmacy — cell by cell.

The settlement table answers «which آبادی has the fewest shops», which is not «where would a new
pharmacy have patients». This writes a continuous surface on the same 0.005° grid:

    each settlement's population is spread uniformly over the cells inside its own built
    footprint (the Voronoi area compute_capacity.py measured), so a village of 900 does not
    dump 900 people into one square;

    each settlement's pharmacy supply — the FDA register count — is spread over the same cells,
    and every live pin also covers the cells within 1.5 km of it;

    gap(cell) = demand(cell) − benchmark × supply(cell)     [residents]

Positive: people live here and the pharmacies reaching them are already full. Negative: the
shops here carry more capacity than the residents need. That is the heat the map was missing —
the saturated core goes quiet by construction, which is the point.

    python etl/opportunity_grid.py [--benchmark 5408] [--cell 0.005]
"""
from __future__ import annotations

import argparse
import math
import os
import sqlite3

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")

KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(31.5))

PIN_R_KM = 1.5          # a pin is supply for the streets around it
MIN_POP = 200           # below this a settlement is not a market for a shop


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", type=float, default=5408.0)
    ap.add_argument("--cell", type=float, default=0.005)
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    settlements = [dict(r) for r in c.execute("""
        SELECT s.area_id, s.name, s.lat, s.lon, s.population,
               COALESCE(ss.footprint_km2, 0.8) AS footprint_km2,
               COALESCE(ss.supply, 0)          AS supply
          FROM v_map_settlement s
          LEFT JOIN settlement_service ss ON ss.area_id = s.area_id
         WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL AND s.population >= ?""", (MIN_POP,))]
    pins = [dict(r) for r in c.execute("""
        SELECT lat, lon FROM (
          SELECT lat, lon FROM map_pharmacy WHERE lat IS NOT NULL
          UNION ALL
          SELECT lat, lon FROM manual_place WHERE kind = 'pharmacy' AND lat IS NOT NULL)""")]
    if not settlements:
        print("nothing to do")
        return 1

    cell = args.cell
    grid: dict[tuple[int, int], list[float]] = {}

    def pins_within(lat: float, lon: float, radius_km: float) -> int:
        n = 0
        for p in pins:
            if math.hypot((p["lat"] - lat) * KM_PER_DEG_LAT,
                          (p["lon"] - lon) * KM_PER_DEG_LON) <= radius_km:
                n += 1
        return n

    def add(lat: float, lon: float, radius_km: float, demand: float, supply: float,
            unknown: float = 0.0) -> None:
        span = int(radius_km / (cell * KM_PER_DEG_LAT)) + 1
        iy0, ix0 = int(lat / cell), int(lon / cell)
        inside: list[tuple[int, int]] = []
        for iy in range(iy0 - span, iy0 + span + 1):
            for ix in range(ix0 - span, ix0 + span + 1):
                clat = (iy + 0.5) * cell
                clon = (ix + 0.5) * cell
                d = math.hypot((clat - lat) * KM_PER_DEG_LAT, (clon - lon) * KM_PER_DEG_LON)
                if d <= radius_km:
                    inside.append((iy, ix))
        if not inside:
            inside = [(iy0, ix0)]
        for key in inside:
            slot = grid.setdefault(key, [0.0, 0.0, 0.0])
            slot[0] += demand / len(inside)
            slot[1] += supply / len(inside)
            slot[2] = max(slot[2], unknown)

    capped = 0
    for s in settlements:
        area = max(0.7, float(s["footprint_km2"] or 0.8))
        radius = math.sqrt(area / math.pi)
        if radius > 5.0:
            capped += 1
        # a 52 km² footprint around one point would be an 8 km circle; cap so it stays inside
        # the settlement instead of reaching the next town
        # a town of 10,000 with no register row and no pin anywhere near is a data gap, not
        # an empty market: mark it unknown instead of lighting it up as an opportunity.
        pop = float(s["population"])
        unknown = 1.0 if (s["supply"] == 0 and pop >= 5000
                          and pins_within(s["lat"], s["lon"], 5.0) == 0) else 0.0
        add(s["lat"], s["lon"], min(radius, 5.0), pop, float(s["supply"]), unknown)

    for p in pins:
        add(p["lat"], p["lon"], PIN_R_KM, 0.0, 1.0)

    rows = []
    for (iy, ix), (demand, supply, unknown) in grid.items():
        if demand < 20:
            continue
        gap = demand - args.benchmark * supply
        rows.append((iy, ix,
                     round((iy + 0.5) * cell, 5), round((ix + 0.5) * cell, 5),
                     round(demand), round(supply, 2), round(gap), int(unknown)))
    rows = [r for r in rows if abs(r[6]) >= 25 or r[7]]

    c.execute("DROP TABLE IF EXISTS opportunity_cell")
    c.execute("""CREATE TABLE opportunity_cell (
        cy INTEGER, cx INTEGER, lat REAL, lon REAL,
        demand INTEGER, supply REAL, gap INTEGER, unknown INTEGER,
        PRIMARY KEY (cy, cx))""")
    c.executemany("INSERT INTO opportunity_cell VALUES (?,?,?,?,?,?,?,?)", rows)

    total_dem = sum(r[4] for r in rows)
    unmet = sum(max(0, r[6]) for r in rows)
    hot = [r for r in rows if r[6] > 0]
    print(f"cells kept        {len(rows):,}")
    print(f"demand covered    {total_dem:,.0f} residents")
    print(f"unmet demand      {unmet:,.0f} residents in {len(hot):,} cells")
    print(f"deepest cell      {max((r[6] for r in hot), default=0):,.0f} residents")
    print(f"capped footprints {capped}")
    for r in sorted(rows, key=lambda x: -x[6])[:6]:
        print(f"   {r[2]:.4f},{r[3]:.4f}  demand {r[4]:>7,}  supply {r[5]:>6.2f}  gap {r[6]:>8,}")

    c.execute("DELETE FROM service_metric WHERE key LIKE 'opportunity_%'")
    c.executemany("INSERT INTO service_metric VALUES (?,?,?)", [
        ("opportunity_cells", len(rows), "سلول‌هایی که تقاضای واقعی دارند"),
        ("opportunity_unmet", unmet, "جمعیت بیشتر از ظرفیت داروخانه‌های همان سلول"),
        ("opportunity_hot_cells", len(hot), "سلول‌هایی با تقاضای بدون پوشش"),
    ])
    c.commit()
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
