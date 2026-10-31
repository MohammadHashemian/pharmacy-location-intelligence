"""Put the admin-only settlements of Khuzestan into the main place list.

The dashboard lists places from `locations` (the FDA feed). Every city and every
village above the market threshold that the feed simply never listed — ام‌الطمیر
is the example the user named — is therefore absent, even though we know it
exists and how many people live there.

This script materialises those places into `locations` + one snapshot:

  * pharmacy counts stay NULL (we do not know them, and 0 would be a lie);
  * dq_flags carries `no_fda_data`, which is what the dashboard badges;
  * the admin layer stays the source: `external_ids` points back at
    `admin_area.id`, and nothing in `admin_area` is modified.

Idempotent: re-running only fills in places that appeared since the last run.

    python etl/link_admin_places.py [--min-village 5000] [--dry-run]
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from normalize import loc_key, norm_key, norm_text  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROVINCE = "استان خوزستان"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "db", "pharmacy.sqlite"))
    ap.add_argument("--min-village", type=int, default=5000,
                    help="villages at least this large enter the main list")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    rows = conn.execute("""
        SELECT c.area_id, c.kind, c.name, c.county, c.bakhsh, c.dehestan,
               c.population, c.latitude, c.longitude
        FROM v_admin_area_current c
        WHERE c.kind IN ('city', 'village')
          AND c.county IS NOT NULL
          AND (c.kind = 'city' OR COALESCE(c.population, 0) >= ?)
          AND NOT EXISTS (SELECT 1 FROM admin_area_link l
                          WHERE l.area_id = c.area_id AND l.layer = 'fda')
        ORDER BY c.county, c.kind, c.population DESC
    """, (args.min_village,)).fetchall()

    known = conn.execute("""
        SELECT id, county, place, place_kind FROM locations
        WHERE province_key LIKE '%خوزستان%'
    """).fetchall()

    # The feed spells the same town several ways (مسجدسلیمان / مسجد سلیمان,
    # هندیجان / بندر هندیجان). Compare on folded, space-stripped names first;
    # only fall back to similarity when nothing matches, so a genuinely new
    # place is added and a re-spelling is not duplicated.
    # Same town, two transliterations from our own sources.
    NAME_ALIASES = {"صالحمشطت": "صالحمشتت", "صالحمشط": "صالحمشتت"}

    def squash(s: str) -> str:
        key = re.sub(r"[^\w]", "", norm_key(s))
        return NAME_ALIASES.get(key, key)

    by_county: dict[tuple[str, str], int] = {}
    by_county_squash: dict[tuple[str, str], int] = {}
    glob: dict[str, list[tuple[str, int]]] = {}
    for r in known:
        ck, pk = norm_key(r["county"] or ""), norm_key(r["place"] or "")
        by_county[(ck, pk)] = r["id"]
        by_county_squash[(ck, squash(r["place"] or ""))] = r["id"]
        glob.setdefault(squash(r["place"] or ""), []).append(
            (ck, r["id"], r["place_kind"]))

    def find_existing(county: str, place: str, kind: str) -> int | None:
        ck, pk = norm_key(county), squash(place)
        hit = by_county.get((ck, norm_key(place))) or by_county_squash.get((ck, pk))
        if hit:
            return hit
        if len(glob.get(pk, [])) == 1:
            return glob[pk][0][1]
        same_kind = [h for h in glob.get(pk, [])
                     if h[2] == ("city" if kind == "city" else "village")]
        if len(same_kind) == 1:
            return same_kind[0][1]

        # «بندر هندیجان» vs «هندیجان»: the extra token is a qualifier, not a
        # different place. Only the *short* name's tokens must all appear.
        tokens = set(norm_key(place).split())
        for name_key, hits in glob.items():
            other = set(name_key.split())
            if tokens and (tokens <= other or other <= tokens) and len(name_key) >= 6:
                if len(hits) == 1:
                    return hits[0][1]
        # last resort: high-similarity name in the same county
        best, score = None, 0.0
        for (c2, k2), lid in by_county_squash.items():
            if c2 != ck:
                continue
            r = difflib.SequenceMatcher(None, pk, k2).ratio()
            if r > score:
                best, score = lid, r
        return best if score >= 0.88 else None

    seen: dict[str, int] = {}

    src = conn.execute("""
        SELECT id FROM data_sources WHERE kind = 'admin_layer' AND ref = 'admin_area'
        ORDER BY id LIMIT 1
    """).fetchone()
    if src is None:
        if args.dry_run:
            source_id = None
        else:
            cur = conn.execute("""
                INSERT INTO data_sources (kind, ref, sha256, parser_version, observed_at,
                    ingested_at, row_count, rows_inserted, scope_label, status, notes)
                VALUES ('admin_layer', 'admin_area', NULL, '1', ?, ?, 0, 0, ?, 'ok',
                        'Places from etl/schema_admin.sql that the FDA feed never lists; pharmacy counts deliberately NULL')
            """, (now, now, PROVINCE))
            source_id = cur.lastrowid
    else:
        source_id = src["id"]

    added = updated = 0
    added_names: list[str] = []
    claimed: list[tuple[str, str]] = []   # (county, squashed name) added in this run
    for r in rows:
        district = norm_text(r["bakhsh"] or r["dehestan"] or "")
        base = r["name"]
        prefix = "شهر " if r["kind"] == "city" else "روستای "
        place = norm_text(base if re.match(r"^(شهر|روستا|روستای|شهرک)\s", base)
                          else prefix + base)
        existing = find_existing(r["county"], place, r["kind"])
        if existing is None and squash(place) in seen:
            existing = seen[squash(place)]
        if existing is not None:
            # The feed already knows this place under another spelling; its
            # snapshot stays authoritative, so nothing is written here.
            continue

        lk = loc_key(PROVINCE, r["county"], district, place)
        if conn.execute("SELECT 1 FROM locations WHERE loc_key = ?", (lk,)).fetchone():
            continue
        if any(c2 == norm_key(r["county"]) and
               difflib.SequenceMatcher(None, squash(place), k2).ratio() >= 0.92
               for c2, k2 in claimed):
            continue
        if args.dry_run:
            added += 1
            added_names.append(place)
            claimed.append((norm_key(r["county"]), squash(place)))
            continue
        cur = conn.execute("""
            INSERT INTO locations (loc_key, province, county, district, place, place_kind,
                university, province_key, county_key, first_seen_at, last_seen_at,
                lat, lon, external_ids)
            VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)
        """, (lk, PROVINCE, r["county"], district, place,
              "city" if r["kind"] == "city" else "village",
              norm_key(PROVINCE), norm_key(r["county"]), now, now,
              r["latitude"], r["longitude"],
              json.dumps({"source": "admin_area", "area_id": r["area_id"]},
                         ensure_ascii=False)))
        loc_id = cur.lastrowid
        conn.execute("""
            INSERT INTO location_snapshots
                (location_id, source_id, observed_at, population, dq_flags, extra)
            VALUES (?,?,?,?, 'no_fda_data', ?)
        """, (loc_id, source_id, now, r["population"],
              json.dumps({"admin_area_id": r["area_id"]}, ensure_ascii=False)))
        seen[squash(place)] = loc_id
        added += 1
        added_names.append(place)
        claimed.append((norm_key(r["county"]), squash(place)))

    if not args.dry_run:
        conn.execute("""
            UPDATE data_sources SET row_count = row_count + ?, rows_inserted = rows_inserted + ?,
                   observed_at = ? WHERE id = ?
        """, (added, added, now, source_id))
        conn.commit()

    print(json.dumps({"candidates": len(rows), "added": added, "refreshed": updated,
                      "min_village": args.min_village, "dry_run": args.dry_run,
                      "names": added_names[:40]}, ensure_ascii=False))
    for r in conn.execute("""
        SELECT place_kind, COUNT(*) n FROM locations
        WHERE province_key LIKE '%خوزستان%' GROUP BY 1
    """):
        print("  khuzestan", r["place_kind"], r["n"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
