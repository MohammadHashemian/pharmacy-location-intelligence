"""Fetch the Khuzestan settlement inventory from OpenStreetMap (Overpass API).

Source: OSM place objects (city | town | village | hamlet | isolated_dwelling |
neighbourhood) inside the administrative area of استان خوزستان (ISO 3166-2
IR-06, OSM relation 3661581 -> Overpass area 3603661581), plus the province
outline itself for display.

The raw response is kept verbatim under data/raw/osm/ so the load step is
re-runnable without touching the API — same contract as every other source in
this project (provenance first, parse second).
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

# place=* values that describe a settlement a pharmacy could serve. `town` and
# `city` are the urban forms, `village`/`hamlet`/`isolated_dwelling` the rural
# ones, `neighbourhood` the intra-city districts that OSM tags as settlements in
# Iranian cities (and which the FDA feed also carries as separate rows).
PLACE_KINDS = ("city", "town", "village", "hamlet", "isolated_dwelling", "neighbourhood")

Q_PLACES = """
[out:json][timeout:600];
area({area})->.khz;
(
  node["place"~"^({kinds})$"](area.khz);
  way["place"~"^({kinds})$"](area.khz);
  relation["place"~"^({kinds})$"](area.khz);
);
out center tags;
""".format(area=KHUZESTAN_AREA, kinds="|".join(PLACE_KINDS))

Q_PROVINCE_OUTLINE = """
[out:json][timeout:300];
rel({rel});
out geom;
""".format(rel=3661581)


def main() -> int:
    force = "--force" in sys.argv
    print("OSM place inventory (Khuzestan):")
    payload = cached_fetch(Q_PLACES, os.path.join(OUT_DIR, "khuzestan_places.json"),
                           force=force)
    el = payload["elements"]
    print(f"  {len(el):,} elements")
    print("   by type:", dict(Counter(e["type"] for e in el)))
    print("   by place:", dict(Counter(e["tags"]["place"] for e in el
                                        if e.get("tags", {}).get("place"))))
    named = [e for e in el if e.get("tags", {}).get("name")]
    print(f"  with a name: {len(named):,}")

    # No separate province-outline fetch: `rel(3661581); out geom;` is heavy
    # enough that every mirror 500s on it, and the province outline is exactly
    # the union of its admin_level=6 counties — which fetch_osm_admin.py already
    # pulls for the county assignment. The map draws those instead.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
