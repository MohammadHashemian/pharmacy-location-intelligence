"""Fetch the major-road network of خوزستان from Overpass (once, cached).

The map draws these as context so a site can be judged against the road it sits
on; nothing else in the project needs them. Cached in data/raw/osm/, so the
build never depends on the network.

    python etl/fetch_osm_roads.py [--refresh]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HOME, "data", "raw", "osm", "khuzestan_roads.json")
URL = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
QUERY = """
[out:json][timeout:180];
way["highway"~"motorway|trunk|primary|secondary"](29.9,47.6,33.1,50.4);
out geom;
"""


def main() -> int:
    if os.path.exists(OUT) and "--refresh" not in sys.argv:
        print(f"cached: {OUT} ({os.path.getsize(OUT)/1e6:.1f} MB) — --refresh to refetch")
        return 0
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(URL, data=data, headers={**UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=240) as r:
        payload = json.loads(r.read().decode("utf-8"))
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"wrote {OUT}: {len(payload.get('elements', [])):,} ways "
          f"({os.path.getsize(OUT)/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
