"""Fetch every mapped pharmacy in خوزستان from OSM (once, cached).

The FDA dashboard publishes a COUNT of pharmacies per settlement and no
coordinates; OSM publishes the point of each pharmacy that a mapper surveyed.
Neither is complete on its own: OSM has ~220 of the ~890 pharmacies the FDA
counts, concentrated in the well-mapped cities. This layer is therefore drawn as
"mapped pharmacies", never as "all pharmacies".

    python etl/fetch_osm_pharmacies.py [--refresh]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HOME, "data", "raw", "osm", "khuzestan_pharmacies.json")
URL = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
QUERY = """
[out:json][timeout:180];
(
  nwr["amenity"="pharmacy"](29.9,47.6,33.1,50.4);
  nwr["healthcare"="pharmacy"](29.9,47.6,33.1,50.4);
  nwr["shop"="chemist"](29.9,47.6,33.1,50.4);
  nwr["shop"="pharmacy"](29.9,47.6,33.1,50.4);
);
out center tags;
"""


def main() -> int:
    if os.path.exists(OUT) and "--refresh" not in sys.argv:
        print(f"cached: {OUT} — --refresh to refetch")
        return 0
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(URL, data=data, headers={**UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=240) as r:
        payload = json.loads(r.read().decode("utf-8"))
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"wrote {OUT}: {len(payload.get('elements', []))} pharmacies")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
