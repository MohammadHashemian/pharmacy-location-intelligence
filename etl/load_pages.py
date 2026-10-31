#!/usr/bin/env python3
"""Bulk-load the paginated FDA API capture (``data/raw/zarfiat_pages/page_*.json``)
into the project database through the *existing* ETL, so provenance, the
immutable-observation model and the ``v_metrics`` views all keep working.

The pages are the raw responses of

    GET /app/api/TaghsimatKeshvari/GetVaziatShowShahrestanAndOStanQueryAsync
        ?take=5000&skip=<n>&page=1&pageSize=5000&sort[0][field]=ShahrID&sort[0][dir]=asc

captured by ``src/fetch_zarfiat.py``. Every page is registered as its own
``data_sources`` row (its own sha256 + file ref) — the whole nation is one
snapshot in time, so pass a single ``--observed-at`` for all of them.

    python etl/load_pages.py                      # all pages, one snapshot
    python etl/load_pages.py --dry-run            # report only, no writes
    python etl/load_pages.py --observed-at 2026-10-10T12:47:00+03:30
"""
from __future__ import annotations

import argparse
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from load import DEFAULT_DB, INBOUND, connect, ingest, now_iso  # noqa: E402

PAGES_GLOB = os.path.join(ROOT, "data", "raw", "zarfiat_pages", "page_*.json")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--observed-at", default=None,
                    help="ISO timestamp for the whole snapshot (default: now)")
    ap.add_argument("--glob", default=PAGES_GLOB)
    ap.add_argument("--move-to-inbound", action="store_true",
                    help="also copy each page into data/inbound for later re-scans")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pages = sorted(glob.glob(args.glob))
    if not pages:
        print(f"[fail] no pages matched {args.glob}\n"
              f"       run: python src/fetch_zarfiat.py", file=sys.stderr)
        return 2

    observed = args.observed_at or now_iso()
    print(f"[pages] {len(pages)} file(s), snapshot observed_at={observed}")

    if args.dry_run:
        from adapters import read_any
        total = 0
        for p in pages:
            rows = read_any(p, observed, "json")
            total += len(rows)
            provs = {r["province"] for r in rows}
            print(f"  {os.path.basename(p):>18} rows={len(rows):>5} "
                  f"provinces={len(provs)}")
        print(f"[dry-run] {total:,} canonical rows would be ingested")
        return 0

    con = connect(args.db)
    total = ins_sum = upd_sum = 0
    try:
        for p in pages:
            info = ingest(con, p, "json", observed, None,
                          source_ref=os.path.relpath(p, ROOT),
                          notes="paginated API capture (src/fetch_zarfiat.py)")
            total += info["rows"]
            ins_sum += info["inserted"]
            upd_sum += info["updated"]
            print(f"[ok] {os.path.basename(p):>18} rows={info['rows']:>5} "
                  f"new={info['inserted']:>5} upd={info['updated']:>5} "
                  f"({info['scope']})")
            if args.move_to_inbound:
                os.makedirs(INBOUND, exist_ok=True)
                dest = os.path.join(INBOUND, os.path.basename(p))
                if not os.path.exists(dest):
                    with open(p, "rb") as src, open(dest, "wb") as dst:
                        dst.write(src.read())
    finally:
        stats = con.execute(
            """SELECT (SELECT COUNT(*) FROM locations)          AS locations,
                      (SELECT COUNT(*) FROM location_snapshots) AS snapshots,
                      (SELECT COUNT(*) FROM data_sources)       AS sources""").fetchone()
        print(f"\n[load] pages={len(pages)} rows={total:,} "
              f"new_places={ins_sum:,} re-observed={upd_sum:,}")
        print(f"[db]   locations={stats['locations']:,} "
              f"snapshots={stats['snapshots']:,} sources={stats['sources']}")
        print(f"[db]   {args.db}")
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
