"""Assert the invariants of the Khuzestan administrative layer.

    python etl/verify_admin.py [--db db/pharmacy.sqlite]

Exits non-zero on the first broken invariant. Cheap enough to run after every
load; it is the only check that matters when the question is "did a re-ingest
corrupt the tree?".
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

CHECKS = [
    ("one open version per area", """
        SELECT COUNT(*) FROM (
          SELECT area_id FROM admin_area_version WHERE valid_to IS NULL
          GROUP BY area_id HAVING COUNT(*) > 1)""", 0),
    ("version interval sane", """
        SELECT COUNT(*) FROM admin_area_version
        WHERE valid_to IS NOT NULL AND valid_to <= valid_from""", 0),
    ("every area has a version", """
        SELECT COUNT(*) FROM admin_area a
        WHERE NOT EXISTS (SELECT 1 FROM admin_area_version v WHERE v.area_id = a.id)""", 0),
    ("every settlement has a parent", """
        SELECT COUNT(*) FROM admin_area a WHERE a.kind IN ('city','village')
          AND a.parent_area_id IS NULL""", 0),
    ("no self-parent", """
        SELECT COUNT(*) FROM admin_area WHERE parent_area_id = id""", 0),
    ("population positive", """
        SELECT COUNT(*) FROM admin_population WHERE population IS NOT NULL AND population <= 0""", 0),
    ("population linked to an area", """
        SELECT COUNT(*) FROM admin_population p
        WHERE NOT EXISTS (SELECT 1 FROM admin_area a WHERE a.id = p.area_id)""", 0),
    ("links point at real FDA rows", """
        SELECT COUNT(*) FROM admin_area_link l WHERE l.layer = 'fda'
          AND NOT EXISTS (SELECT 1 FROM locations x WHERE x.id = l.ref_id)""", 0),
    ("links point at real OSM rows", """
        SELECT COUNT(*) FROM admin_area_link l WHERE l.layer = 'osm'
          AND NOT EXISTS (SELECT 1 FROM geo_places x WHERE x.id = l.ref_id)""", 0),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "db", "pharmacy.sqlite"))
    args = ap.parse_args()
    conn = sqlite3.connect(args.db)
    failed = 0
    for name, sql, expected in CHECKS:
        got = conn.execute(sql).fetchone()[0]
        ok = got == expected
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}: {got}")
    for r in conn.execute("SELECT kind, n, n_with_population FROM v_admin_coverage ORDER BY kind"):
        print(f"     {r[0]:9s} {r[1]:6d}  with population {r[2]:6d}")
    if failed:
        print(f"\n{failed} invariant(s) broken", file=sys.stderr)
        return 1
    print("\nall invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
