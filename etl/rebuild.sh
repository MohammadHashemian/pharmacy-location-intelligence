#!/usr/bin/env bash
# Full rebuild of db/pharmacy.sqlite from every artifact in data/raw.
#
#   bash etl/rebuild.sh
#
# The offline Khuzestan HTML capture and the national API crawl are loaded as two
# separate observations. The crawl's 13 pages share ONE observed_at taken from
# zarfiat_manifest.json, so a re-run updates in place instead of stacking up
# parallel snapshots.
#
# --reset empties the fact tables in place rather than deleting the .sqlite file,
# so this works even while a dev server (or another agent) holds it open.
set -euo pipefail
cd "$(dirname "$0")/.."

python etl/load.py --reset \
  --source data/raw/fda-zarfiat.html \
  --manifest data/raw/zarfiat_manifest.json

python etl/verify_db.py
