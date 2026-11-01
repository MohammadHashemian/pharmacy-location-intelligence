"""Turn building footprints into a population surface, then export it for the map.

`etl/fetch_urban_detail.py` counts the buildings standing on each 250 m cell. A cell
with 40 buildings holds more people than a cell with 3, so each city's census
population is distributed in proportion to those counts — with a floor, because a
street block whose buildings were never mapped is not a desert.

    python etl/build_pop_surface.py            # fills urban_cell.population
    python etl/build_pop_surface.py --check    # report only

Writes `web/public/geo/urban_pop.json`:
    {"cities":[...], "cells":[[lat, lon, population, buildings], ...]}

The floor is 20 % of the city's mean cell weight, so an unmapped block still gets a
share; without it a district with no OSM footprints would read as zero residents,
which no city looks like.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT = os.path.join(HOME, "web", "public", "geo", "urban_pop.json")
CITY_POP_SQL = """
    SELECT name, MAX(COALESCE(population, 0)) AS pop
    FROM v_admin_area_current
    WHERE kind = 'city'
    GROUP BY name
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--floor", type=float, default=0.2,
                    help="share of the mean cell weight given to a cell with no building")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    rows = c.execute(
        "SELECT city, lat, lon, buildings, street_m, population FROM urban_cell").fetchall()
    if not rows:
        print("urban_cell is empty — run etl/fetch_urban_detail.py first")
        return 1

    pops = {r["name"]: r["pop"] for r in c.execute(CITY_POP_SQL)}
    by_city: dict[str, list[dict]] = {}
    for r in rows:
        by_city.setdefault(r["city"], []).append(dict(r))

    written = 0
    cells_out: list[list] = []
    cities_meta: list[dict] = []
    for city, cells in by_city.items():
        pop = float(pops.get(city) or 0)
        if pop <= 0:
            print(f"  {city}: no census population — skipped")
            continue
        # Street metres are the built-up proxy: OSM has 3.8k footprints for a 1.2 M
        # city (308 people per building — meaningless), while its street cover is
        # dense and tracks built land closely. Buildings are the fallback for cities
        # whose streets were not fetched.
        mean_street = sum(x["street_m"] or 0 for x in cells) / len(cells)
        use_street = mean_street > 1.0
        base = (lambda x: x["street_m"] or 0) if use_street else (lambda x: x["buildings"])
        mean_w = sum(base(x) for x in cells) / len(cells)
        floor = max(0.02, mean_w * args.floor)
        weights = [base(x) + floor for x in cells]
        total_w = sum(weights)
        if total_w <= 0:
            continue
        scale = pop / total_w
        acc = 0.0
        for x, w in zip(cells, weights):
            v = w * scale
            acc += v
            if not args.check:
                c.execute("UPDATE urban_cell SET population = ? WHERE city = ? AND lat = ? AND lon = ?",
                          (round(v, 2), city, x["lat"], x["lon"]))
            cells_out.append([x["lat"], x["lon"], round(v, 2), x["buildings"]])
        written += 1
        cities_meta.append({
            "city": city,
            "population": int(pop),
            "cells": len(cells),
            "buildings": sum(x["buildings"] for x in cells),
            "mean_buildings": round(sum(x["buildings"] for x in cells) / len(cells), 2),
            "basis": "street_m" if use_street else "buildings",
            "pop_per_building": round(pop / max(1, sum(x["buildings"] for x in cells)), 2),
        })
        print(f"  {city}: {len(cells):,} cells · {int(pop):,} people · basis "
              f"{cities_meta[-1]['basis']} · {cities_meta[-1]['pop_per_building']} "
              f"people/building")
    c.commit()

    if not args.check:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        payload = {
            "generated_by": "etl/build_pop_surface.py",
            "method": "census population distributed over OSM building counts, floor "
                      f"{args.floor:.0%} of the mean cell",
            "cell_km": 0.25,
            "cities": cities_meta,
            "cells": cells_out,
        }
        json.dump(payload, open(OUT, "w", encoding="utf-8"), separators=(",", ":"))
        print(f"wrote {OUT}: {len(cells_out):,} cells · "
              f"{os.path.getsize(OUT)/1024:.0f} KB")
    print(f"cities covered: {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
