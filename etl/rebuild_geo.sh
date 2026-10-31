#!/usr/bin/env bash
# Rebuild the geographic layer end to end.
#
# Order matters: load_geo.py DELETEs and re-creates geo_places (structure,
# matching, distance), so the population enrichment must run after it and the
# exports after that. Running load_geo.py again wipes the enriched populations —
# re-run all three.
#
#   fetch_osm.py            Overpass: places + admin boundaries  (network, cached)
#   load_geo.py             admin resolution, dedupe, FDA matching, OSRM distance
#   enrich_geo_population.py  Wikidata P1082 + fa.wikipedia census sentences
#   export_geo_map.py       GeoJSON for the map + the network graph JSON
#   enrich_place_dehestan.py  دهستان (admin_level=7) onto every place
#   build_geo_density.py    residential-masked pharmacy density surface
#   build_geo_pages.py      the self-contained atlas HTML
#   audit_geo.py            the checks that decide whether to trust the numbers
set -euo pipefail
cd "$(dirname "$0")/.."

python etl/fetch_osm.py
python etl/fetch_osm_admin.py
python etl/load_geo.py
python etl/enrich_geo_population.py
python etl/enrich_geo_road.py
python etl/export_geo_map.py
python etl/enrich_place_dehestan.py
python etl/build_geo_density.py
python etl/build_geo_pages.py
python etl/report_geo.py
python etl/audit_geo.py --top=30
echo
echo "atlas: reports/khuzestan-atlas.html (full) + reports/khuzestan-atlas-widget.html"
