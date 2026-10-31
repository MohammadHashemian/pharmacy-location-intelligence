"""
Build the SQLite analysis database from the raw pages in data/raw/zarfiat_pages.

    python src/load_db.py            # build / refresh data/pharmacy.sqlite
    python src/load_db.py --rebuild  # drop the file first
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import db  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(db.DB_PATH))
    ap.add_argument("--pages", default=str(db.PAGES))
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()

    pages = Path(args.pages)
    files = db.page_files(pages)
    if not files:
        print(f"[load] no page_*.json under {pages} — run src/fetch_zarfiat.py first")
        return 2
    if args.rebuild and Path(args.db).exists():
        Path(args.db).unlink()
        print(f"[load] removed {args.db}")

    n = 0
    for f in files:
        import json
        n += len(json.loads(f.read_text(encoding="utf-8"))["data"]["records"])

    print(f"[load] {len(files)} page(s), {n:,} raw rows -> {args.db}")
    con = db.connect(args.db)
    try:
        counts = db.load(con, pages)
    finally:
        con.close()
    print(f"[load] done: {counts['cities']:,} cities/villages, "
          f"{counts['city_stats']:,} stat rows, {counts['raw_rows']:,} raw rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
