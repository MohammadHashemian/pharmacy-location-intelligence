"""Fetch the Khuzestan administrative hierarchy (county + district polygons).

The FDA feed identifies every settlement by استان / شهرستان / بخش / آبادی. OSM
place objects carry only a point, so the county and district have to be attached
geometrically: point-in-polygon against the OSM administrative boundaries.

  admin_level 4 = استان  (province)  — fetched as the outline
  admin_level 6 = شهرستان (county/shahrestan)
  admin_level 7 = بخش     (district/bakhsh)

Everything is kept raw on disk (`out geom;` gives each relation's member ways
inline), and the polygons are simplified on load rather than here so the raw
capture stays lossless.
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osm_client import KHUZESTAN_AREA, cached_fetch  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(HOME, "data", "raw", "osm")

Q_ADMIN = """
[out:json][timeout:900];
area({area})->.khz;
rel["boundary"="administrative"]["admin_level"="{level}"](area.khz);
out geom;
""".format(area=KHUZESTAN_AREA, level="{level}")


def main() -> int:
    force = "--force" in sys.argv
    for level, label in (("6", "شهرستان county"), ("7", "بخش district")):
        print(f"OSM admin_level={level} ({label}):")
        payload = cached_fetch(
            Q_ADMIN.replace("{level}", level),
            os.path.join(OUT_DIR, f"khuzestan_admin{level}.json"),
            force=force,
        )
        els = payload["elements"]
        with_geom = [e for e in els if e.get("members")]
        print(f"  {len(els):,} relations, {len(with_geom):,} with geometry")
        names = sorted(e["tags"].get("name", "?") for e in els)
        print(f"  {len(names)} names, e.g. {names[:6]}")
        print("  admin_level tags:", dict(Counter(e["tags"].get("admin_level")
                                                  for e in els)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
