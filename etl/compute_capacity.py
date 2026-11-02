"""How much of the map is actually served by the pharmacies we have.

The old number — residents per pharmacy, settlement by settlement — treated one pharmacy as
the provider for an entire آبادی: 40 km² around a single shop counted as «density 1». A
pharmacy serves a walk, not a district, so this computes the two things that number hid:

  * **occupied area** — the union of a service disc around every pharmacy (1.5 km, roughly a
    20-minute walk in a شهر; 3 km as the generous rural read). Rasterised on a 0.005° grid over
    the populated mask, so overlapping discs are counted once.
  * **populated mask** — every 0.5 km cell within 2.5 km of a mapped settlement. Cells with no
    settlement anywhere near them are empty desert and are not «unserved»: nobody lives there.

Then the capacity side, per pharmacy:

    catchment  = settlements whose nearest pharmacy it is (≤ 8 km; beyond that, unserved)
    capacity   = 5,408 residents (the calibration constant, i.e. the current provincial ratio)
    remaining  = capacity − catchment     (negative means saturated)

And per settlement: footprint (its Voronoi cell clipped to the populated mask) so
`population / footprint` is a real residents-per-km² number rather than a guess.

    python etl/compute_capacity.py [--benchmark 5408] [--cell 0.005]
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
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(31.5))   # Khuzestan's latitude

URBAN_KM = 1.5       # a شهر pharmacy is a walk away
RURAL_KM = 3.0       # a روستا pharmacy is a drive away
MAX_SERVICE_KM = 8.0
VILLAGE_SERVICE_KM = 5.0  # a village is served by a shop in the next town, not the next street  # farther than this from any pharmacy is «unserved», not «remote»
MASK_KM = 1.0        # a village cell this far from its settlement still counts as inhabited
URBAN_MIN_POP = 20000  # above this a settlement is a شهر, and its built-up area comes from streets


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", type=float, default=5408.0,
                    help="residents one pharmacy can carry (default: the provincial ratio)")
    ap.add_argument("--cell", type=float, default=0.005, help="grid step in degrees")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    settlements = [
        dict(r) for r in c.execute("""
            SELECT area_id, name, kind, lat, lon, population, pharmacy_total
              FROM v_map_settlement
             WHERE lat IS NOT NULL AND lon IS NOT NULL AND population > 0
        """)
    ]
    pharmacies = [
        dict(r) for r in c.execute("""
            SELECT ref, name, lat, lon, nearest_area_id FROM (
              SELECT 'poi/' || osm_id AS ref, name, lat, lon, nearest_area_id FROM map_pharmacy
               WHERE lat IS NOT NULL
              UNION ALL
              SELECT 'manual/' || id, name, lat, lon, nearest_area_id FROM manual_place
               WHERE kind = 'pharmacy' AND lat IS NOT NULL
            )
        """)
    ]
    if not settlements or not pharmacies:
        print("nothing to compute")
        return 1

    S = np.array([[s["lat"], s["lon"]] for s in settlements], dtype=np.float64)
    spop = np.array([s["population"] or 0 for s in settlements], dtype=np.float64)
    P = np.array([[p["lat"], p["lon"]] for p in pharmacies], dtype=np.float64)

    cell = args.cell
    cell_km2 = (cell * KM_PER_DEG_LAT) * (cell * KM_PER_DEG_LON)
    lat0, lat1 = S[:, 0].min() - 0.05, S[:, 0].max() + 0.05
    lon0, lon1 = S[:, 1].min() - 0.05, S[:, 1].max() + 0.05
    ny = int((lat1 - lat0) / cell) + 1
    nx = int((lon1 - lon0) / cell) + 1
    print(f"grid {ny} x {nx} = {ny * nx:,} cells of {cell_km2:.3f} km²")

    # ---- occupied area: stamp a disc per pharmacy, union by counting each cell once
    occupied15: set[tuple[int, int]] = set()
    occupied30: set[tuple[int, int]] = set()
    for plat, plon in P:
        for radius, sink in ((URBAN_KM, occupied15), (RURAL_KM, occupied30)):
            dy = int(radius / (cell * KM_PER_DEG_LAT)) + 1
            dx = int(radius / (cell * KM_PER_DEG_LON)) + 1
            iy = int((plat - lat0) / cell)
            ix = int((plon - lon0) / cell)
            for yy in range(max(0, iy - dy), min(ny, iy + dy + 1)):
                la = lat0 + (yy + 0.5) * cell
                for xx in range(max(0, ix - dx), min(nx, ix + dx + 1)):
                    lo = lon0 + (xx + 0.5) * cell
                    d = math.hypot((la - plat) * KM_PER_DEG_LAT, (lo - plon) * KM_PER_DEG_LON)
                    if d <= radius:
                        sink.add((yy, xx))

    # ---- built-up mask: the streets we already cached for 87 cities
    def ix_of(lon: float) -> int:
        return int((lon - lon0) / cell)

    def iy_of(lat: float) -> int:
        return int((lat - lat0) / cell)

    urban_cells: set[tuple[int, int]] = set()
    street_files = sorted(glob.glob(os.path.join(HOME, "web", "public", "geo", "streets_city-*.json")))
    for fp in street_files:
        try:
            fc = json.load(open(fp, encoding="utf-8"))
        except Exception:
            continue
        for feat in fc.get("features", []):
            geom = feat.get("geometry") or {}
            if geom.get("type") != "LineString":
                continue
            for lon, lat in geom.get("coordinates", []):
                if lon0 <= lon <= lon1 and lat0 <= lat <= lat1:
                    urban_cells.add((iy_of(lat), ix_of(lon)))
    print(f"built-up mask from {len(street_files)} street files: "
          f"{len(urban_cells):,} cells = {len(urban_cells) * cell_km2:,.0f} km²")

    # ---- populated mask + settlement footprints (Voronoi inside the mask)
    footprints: dict[int, float] = {}
    mask_cells: set[tuple[int, int]] = set(urban_cells)
    for i, (slat, slon) in enumerate(S):
        if (settlements[i]["population"] or 0) >= URBAN_MIN_POP:
            continue
        dy = int(MASK_KM / (cell * KM_PER_DEG_LAT)) + 1
        dx = int(MASK_KM / (cell * KM_PER_DEG_LON)) + 1
        iy = int((slat - lat0) / cell)
        ix = int((slon - lon0) / cell)
        for yy in range(max(0, iy - dy), min(ny, iy + dy + 1)):
            la = lat0 + (yy + 0.5) * cell
            for xx in range(max(0, ix - dx), min(nx, ix + dx + 1)):
                lo = lon0 + (xx + 0.5) * cell
                d = math.hypot((la - slat) * KM_PER_DEG_LAT, (lo - slon) * KM_PER_DEG_LON)
                if d > MASK_KM:
                    continue
                mask_cells.add((yy, xx))
    print(f"populated mask {len(mask_cells):,} cells = {len(mask_cells) * cell_km2:,.0f} km²")

    # who owns each mask cell: nearest settlement, computed only among settlements that can win
    arr = np.array(sorted(mask_cells), dtype=np.int32)
    clat = lat0 + (arr[:, 0] + 0.5) * cell
    clon = lon0 + (arr[:, 1] + 0.5) * cell
    owner = np.full(len(arr), -1, dtype=np.int32)
    best = np.full(len(arr), 1e9)
    for chunk in range(0, len(arr), 40000):
        sl = slice(chunk, chunk + 40000)
        d = np.hypot((clat[sl, None] - S[None, :, 0]) * KM_PER_DEG_LAT,
                     (clon[sl, None] - S[None, :, 1]) * KM_PER_DEG_LON)
        idx = d.argmin(axis=1)
        owner[sl] = idx
        best[sl] = d[np.arange(len(idx)), idx]
    # a street cell belongs to the city it sits in even if the centre is 5 km away
    is_urban = np.array([(a, b) in urban_cells for a, b in arr], dtype=bool)
    own = owner[(best <= MASK_KM) | is_urban]
    uniq, counts = np.unique(own, return_counts=True)
    for i, n in zip(uniq, counts):
        footprints[int(i)] = float(n) * cell_km2

    # ---- settlement → nearest pharmacy (exact, small)
    d = np.hypot((S[:, None, 0] - P[None, :, 0]) * KM_PER_DEG_LAT,
                 (S[:, None, 1] - P[None, :, 1]) * KM_PER_DEG_LON)
    nearest = d.argmin(axis=1)
    nearest_km = d[np.arange(len(S)), nearest]
    within15 = (d <= URBAN_KM).sum(axis=1)
    within30 = (d <= RURAL_KM).sum(axis=1)
    within50 = (d <= VILLAGE_SERVICE_KM).sum(axis=1)

    # ---- catchment per pharmacy
    catch = np.zeros(len(P))
    for i, k in enumerate(nearest):
        if nearest_km[i] <= MAX_SERVICE_KM:
            catch[k] += spop[i]

    served_pop = float(spop[nearest_km <= MAX_SERVICE_KM].sum())
    pop15 = float(spop[nearest_km <= URBAN_KM].sum())
    pop30 = float(spop[nearest_km <= RURAL_KM].sum())
    total_pop = float(spop.sum())
    mask_km2 = len(mask_cells) * cell_km2
    occ15 = len(occupied15 & mask_cells) * cell_km2
    occ30 = len(occupied30 & mask_cells) * cell_km2

    metrics = {
        "populated_km2": (mask_km2, "مساحت ساخته‌شده: خیابان‌های شهرها + شعاع ۱ کیلومتر روستاها"),
        "builtup_km2": (len(urban_cells) * cell_km2, "مساحت ساخته‌شدهٔ شهرها از روی خیابان‌ها"),
        "occupied_km2_1500": (occ15, "مساحت پوشیده‌شده در شعاع ۱٫۵ کیلومتر از یک داروخانه"),
        "occupied_km2_3000": (occ30, "مساحت پوشیده‌شده در شعاع ۳ کیلومتر از یک داروخانه"),
        "occupied_share_1500": (occ15 / mask_km2 * 100 if mask_km2 else 0, "درصد مساحت مسکونی پوشیده‌شده"),
        "occupied_share_built": (occ15 / (len(urban_cells) * cell_km2) * 100
                                 if urban_cells else 0,
                                 "درصد مساحت ساخته‌شدهٔ شهرها در شعاع ۱٫۵ کیلومتر یک داروخانه"),
        "population_total": (total_pop, "جمعیت سکونتگاه‌های ترسیم‌شده"),
        "population_served": (served_pop, "جمعیت با دسترسی به داروخانه تا ۸ کیلومتر"),
        "population_within_1500": (pop15, "جمعیت در شعاع ۱٫۵ کیلومتری یک داروخانه"),
        "population_within_3000": (pop30, "جمعیت در شعاع ۳ کیلومتری یک داروخانه"),
        "population_share_1500": (pop15 / total_pop * 100 if total_pop else 0,
                                  "درصد جمعیت با داروخانه در ۱٫۵ کیلومتری"),
        "population_share_3000": (pop30 / total_pop * 100 if total_pop else 0,
                                  "درصد جمعیت با داروخانه در ۳ کیلومتری"),
        "residents_per_pharmacy": (total_pop / len(P), "نفر به ازای هر داروخانهٔ نقشه‌یابی‌شده"),
        "population_unserved": (total_pop - served_pop, "جمعیت بدون دسترسی تا ۸ کیلومتر"),
        "population_density": (total_pop / mask_km2 if mask_km2 else 0, "نفر بر کیلومتر مربع مساحت مسکونی"),
        "pharmacy_count": (float(len(P)), "داروخانه روی نقشه"),
        "saturated_count": (float((catch > args.benchmark).sum()), "داروخانه‌های اشباع‌شده"),
        "benchmark": (args.benchmark, "ظرفیت یک داروخانه (نفر)"),
    }
    for k, (v, note) in metrics.items():
        print(f"  {k:22s} {v:14,.2f}  {note}")

    # ---- write
    c.execute("DROP TABLE IF EXISTS service_metric")
    c.execute("CREATE TABLE service_metric (key TEXT PRIMARY KEY, value REAL, note TEXT)")
    c.executemany("INSERT INTO service_metric VALUES (?,?,?)",
                  [(k, float(v), note) for k, (v, note) in metrics.items()])

    c.execute("DROP TABLE IF EXISTS pharmacy_catchment")
    c.execute("""CREATE TABLE pharmacy_catchment (
        ref TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL,
        catchment INTEGER, capacity INTEGER, remaining INTEGER, saturated INTEGER)""")
    c.executemany(
        "INSERT INTO pharmacy_catchment VALUES (?,?,?,?,?,?,?,?)",
        [(p["ref"], p["name"], p["lat"], p["lon"], int(round(catch[i])), int(args.benchmark),
          int(round(args.benchmark - catch[i])), int(catch[i] > args.benchmark))
         for i, p in enumerate(pharmacies)])

    c.execute("DROP TABLE IF EXISTS settlement_service")
    c.execute("""CREATE TABLE settlement_service (
        area_id INTEGER PRIMARY KEY, nearest_km REAL, nearest_ref TEXT,
        pharmacies_1500 INTEGER, pharmacies_3000 INTEGER,
        footprint_km2 REAL, density REAL,
        demand INTEGER, supply INTEGER, capacity INTEGER, remaining INTEGER,
        supply_known INTEGER)""")
    # supply credit: a شهر counts the pharmacies standing inside its built-up footprint — its
    # streets, not a 3 km disc around one point — and a village counts what it can reach (5 km).
    cell_owner: dict[tuple[int, int], int] = {}
    for (yy, xx), own_i in zip(arr[best <= MASK_KM].tolist() if False else arr.tolist(), owner.tolist()):
        cell_owner[(yy, xx)] = own_i
    for (yy, xx), is_u, own_i in zip(arr.tolist(), is_urban.tolist(), owner.tolist()):
        if is_u:
            cell_owner[(yy, xx)] = own_i

    city_supply: dict[int, int] = {}
    for plat, plon in P:
        oi = cell_owner.get((iy_of(plat), ix_of(plon)))
        if oi is None:
            # not in a mapped street cell: fall back to the settlement it is nearest to
            oi = int(np.hypot((S[:, 0] - plat) * KM_PER_DEG_LAT,
                              (S[:, 1] - plon) * KM_PER_DEG_LON).argmin())
        city_supply[oi] = city_supply.get(oi, 0) + 1

    rows = []
    for i, s in enumerate(settlements):
        fp = footprints.get(i, 0.0)
        pop = float(s["population"] or 0)
        is_city = (s["kind"] == "city") or (s["population"] or 0) >= URBAN_MIN_POP
        # the FDA register is the complete count (894 shops); the map has 436 pins. Take the
        # register where it is bigger — an unmapped pharmacy still exists.
        fda_total = int(s["pharmacy_total"] or 0)
        mapped = int(city_supply.get(i, 0)) if is_city else int(within50[i])
        supply = max(fda_total, mapped)
        cap = int(round(args.benchmark * supply))
        # unmet demand: this settlement's residents minus what the shops reaching it can carry
        # a big city with no register row is a data gap, not an empty market: say unknown
        # rather than claim 100k residents have nowhere to go.
        known = 0 if (is_city and fda_total == 0) else 1
        room = (int(round(pop)) - cap) if known else None
        rows.append((s["area_id"],
                     round(float(nearest_km[i]), 2),
                     pharmacies[int(nearest[i])]["ref"],
                     int(within15[i]), int(within30[i]),
                     round(fp, 2),
                     round(pop / fp, 1) if fp else None,
                     int(round(pop)), supply, cap, room, known))
    c.executemany("INSERT INTO settlement_service VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    c.execute("DROP VIEW IF EXISTS v_settlement_capacity")
    c.execute("""CREATE VIEW v_settlement_capacity AS
        SELECT s.area_id, s.name, s.kind, s.county, s.lat, s.lon, s.population,
               ss.nearest_km, ss.pharmacies_1500, ss.pharmacies_3000,
               ss.footprint_km2, ss.density, ss.demand, ss.supply, ss.capacity,
               ss.remaining, ss.supply_known
          FROM v_map_settlement s JOIN settlement_service ss ON ss.area_id = s.area_id
         WHERE s.lat IS NOT NULL""")

    c.commit()
    c.close()
    print(f"\nwritten: service_metric, pharmacy_catchment ({len(pharmacies)}), "
          f"settlement_service ({len(settlements)}), v_settlement_capacity")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
