"""Re-classify what is already on the map with `classify_poi`, and repair it.

The importers used to trust Google's `types`; rows that reached the database before
that rule changed are still there (a tire shop in the medical layer, a bag shop, an
agricultural service in the pharmacy layer). This pass reads the stored names and
rewrites them:

    python etl/reclassify_places.py            # report only
    python etl/reclassify_places.py --apply    # delete the wrong, fix the kinds

Rules, deliberately conservative:

* `irrelevant`  → delete (tire shop, supermarket, insurance desk…). Nothing is kept
  «just in case», because a wrong pin misleads a site decision;
* medical row whose name says another medical role → fix `kind` (a `hospital` that
  is named «کلینیک …» becomes a clinic);
* `unknown` → kept but counted, because dropping a real clinic is worse than an
  extra row we can name later. The count is what an LLM pass would work on.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_poi import (  # noqa: E402
    DOCTOR, IRRELEVANT, MEDICAL_ROLES, PHARMACY, UNKNOWN, classify,
)

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                  "db", "pharmacy.sqlite")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    med = c.execute("SELECT id, kind, name, address FROM map_medical").fetchall()
    drop_med, fix_med, unknown_med = [], [], []
    for r in med:
        res = classify(r["name"], (), r["address"] or "")
        role = res["role"]
        if role == IRRELEVANT:
            drop_med.append((r, res))
        elif role in MEDICAL_ROLES and role != r["kind"]:
            fix_med.append((r, role, res))
        elif role not in MEDICAL_ROLES:
            unknown_med.append((r, res))

    pharm = c.execute(
        "SELECT osm_type, osm_id, name, street, source, lat, lon, nearest_area_id,"
        " nearest_km, county FROM map_pharmacy").fetchall()
    drop_ph, move_ph, unknown_ph = [], [], []
    for r in pharm:
        res = classify(r["name"], (), r["street"] or "")
        role = res["role"]
        if role == IRRELEVANT:
            drop_ph.append((r, res))
        elif role in MEDICAL_ROLES:
            # a doctor's office or a clinic sitting in the pharmacy table: move it
            # to the layer it belongs to instead of throwing the coordinate away
            move_ph.append((r, role, res))
        elif role != PHARMACY:
            unknown_ph.append((r, res))

    print(f"medical rows: {len(med):,} · delete {len(drop_med)} · "
          f"re-kind {len(fix_med)} · uncertain {len(unknown_med)}")
    for r, res in drop_med[:12]:
        print(f"  DEL [{r['kind']}] {r['name'][:44]:46s} {res['why']}")
    for r, role, res in fix_med[:8]:
        print(f"  FIX [{r['kind']} → {role}] {r['name'][:40]:42s} {res['why']}")

    print(f"pharmacy rows: {len(pharm):,} · delete {len(drop_ph)} · "
          f"move to medical {len(move_ph)} · uncertain {len(unknown_ph)}")
    for r, res in drop_ph[:12]:
        print(f"  DEL [{r['source']}] {r['name'][:44]:46s} {res['why']}")
    for r, role, res in move_ph[:8]:
        print(f"  MOV [{role}] {r['name'][:44]:46s} {res['why']}")

    if not args.apply:
        print("\n(report only — pass --apply to write)")
        return 0

    c.executemany("DELETE FROM map_medical WHERE id = ?", [(r["id"],) for r, _ in drop_med])
    c.executemany("UPDATE map_medical SET kind = ? WHERE id = ?",
                  [(role, r["id"]) for r, role, _ in fix_med])
    for r, role, _ in move_ph:
        c.execute("""
            INSERT OR IGNORE INTO map_medical
              (kind, name, lat, lon, nearest_area_id, nearest_km, county, address,
               source, external_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (role, r["name"], r["lat"], r["lon"], r["nearest_area_id"],
              r["nearest_km"], r["county"], r["street"], r["source"],
              f"{r['osm_type']}/{r['osm_id']}"))
    c.executemany("DELETE FROM map_pharmacy WHERE osm_type = ? AND osm_id = ?",
                  [(r["osm_type"], r["osm_id"]) for r, _ in drop_ph]
                  + [(r["osm_type"], r["osm_id"]) for r, _, _ in move_ph])
    c.commit()
    print(f"\napplied: -{len(drop_med)} medical, {len(fix_med)} re-kinded, "
          f"-{len(drop_ph)} pharmacies")
    left = c.execute("SELECT count(*), sum(kind='clinic'), sum(kind='doctor'), "
                     "sum(kind='hospital'), sum(kind='dentist') FROM map_medical").fetchone()
    print("map_medical now:", tuple(left))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
