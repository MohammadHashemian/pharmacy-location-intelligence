#!/usr/bin/env python3
"""Load FDA pharmacy-capacity snapshots into the project SQLite database.

Idempotent and agent-friendly:

    python etl/load.py --source data/raw/fda-zarfiat.html
    python etl/load.py --scan-inbound                  # pick up everything
    python etl/load.py --source https://.../api.json --kind json --url-fetch

Re-running the same file is a no-op for `locations` and an in-place update for
`location_snapshots` (keyed by location + observed_at), so nothing is ever
duplicated and history is preserved.
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import json
import os
import sqlite3
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from adapters import PARSER_VERSION, read_any  # noqa: E402

DEFAULT_DB = os.path.join(ROOT, "db", "pharmacy.sqlite")
SCHEMA = os.path.join(HERE, "schema.sql")
VIEWS = os.path.join(HERE, "views.sql")
INBOUND = os.path.join(ROOT, "data", "inbound")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def now_iso() -> str:
    """Current time as ISO-8601 UTC with a trailing Z."""
    return dt.datetime.now(dt.timezone.utc).replace(
        microsecond=0).isoformat().replace("+00:00", "Z")


def to_utc_iso(value: str | None) -> str:
    """Normalise any ISO-8601 instant to UTC `...Z`.

    Snapshots are ordered with a lexicographic `MAX(observed_at)`, so every
    stored timestamp must share ONE timezone. Mixing `+03:30` and `+00:00`
    strings makes MAX() compare text, not time: '2026-10-10T12:09:01+03:30'
    sorts after '2026-10-10T09:16:48Z' even though it happened 38 minutes
    EARLIER. Anything unparseable is passed through untouched.
    """
    if not value:
        return now_iso()
    s = str(value).strip().replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(s)
    except ValueError:
        return str(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).replace(
        microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def mtime_iso(path: str) -> str:
    """File mtime as ISO-8601 UTC."""
    return dt.datetime.fromtimestamp(
        os.path.getmtime(path), dt.timezone.utc).replace(
        microsecond=0).isoformat().replace("+00:00", "Z")


def connect(db_path: str) -> sqlite3.Connection:
    """Open (creating if needed) and bring the database fully up to date.

    Order matters: tables -> additive column migrations -> views. A view that
    selects a column added by a migration cannot be created before the ALTER
    has run.
    """
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.executescript(open(SCHEMA, encoding="utf-8").read())
    applied = migrate(con)
    if applied:
        print(f"[migrate] added column(s): {', '.join(applied)}")
    con.executescript(open(VIEWS, encoding="utf-8").read())
    return con


def reset_tables(con: sqlite3.Connection) -> None:
    """Empty the fact + master tables in place.

    Deleting rows rather than the .sqlite file means a rebuild works even while
    another process (a running dev server, a sibling agent's script) holds the
    database open — Windows refuses to unlink a file that has an open handle.
    """
    con.executescript(
        """
        DELETE FROM location_snapshots;
        DELETE FROM locations;
        DELETE FROM data_sources;
        DELETE FROM scoring_models;
        -- the reference layer keys on location_id, so a rebuild invalidates it:
        -- leaving these rows would orphan them against re-created locations.
        -- Re-run etl/enrich_population.py after a rebuild.
        DELETE FROM population_reference;
        """
    )
    con.commit()


def reindex(con: sqlite3.Connection) -> None:
    """Recreate the analytic views (run after any load)."""
    con.executescript(open(VIEWS, encoding="utf-8").read())


def fetch_url(url: str, dest: str) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "pharmacy-etl/2.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as fh:
        fh.write(resp.read())
    return dest


# ---------------------------------------------------------------------------
# fetch manifest support
# ---------------------------------------------------------------------------
MANIFEST = os.path.join(ROOT, "data", "raw", "zarfiat_manifest.json")


def manifest_sources(path: str = MANIFEST) -> tuple[list[str], str, dict]:
    """Expand a fetcher manifest into (page paths, observed_at, meta).

    A multi-page API crawl is ONE logical snapshot, so every page shares the
    manifest's `updated_at` as its observation time. Deriving `observed_at` from
    per-file mtimes instead would register each page as a different capture and
    silently create a parallel snapshot set rather than updating in place.
    """
    with open(path, encoding="utf-8-sig") as fh:
        man = json.load(fh)

    base = os.path.dirname(path)
    pages_dir = os.path.join(base, "zarfiat_pages")
    files = []
    for _skip, info in sorted(man.get("pages", {}).items(), key=lambda kv: int(kv[0])):
        fname = info.get("file")
        if not fname:
            continue
        cand = os.path.join(pages_dir, fname)
        if not os.path.exists(cand):
            cand = os.path.join(base, fname)
        if os.path.exists(cand):
            files.append(cand)

    observed = man.get("updated_at") or man.get("fetched_at") or now_iso()
    meta = {
        "endpoint": man.get("endpoint"),
        "sort": man.get("sort"),
        "pages": len(files),
        "total_count": man.get("total_count"),
    }
    return files, observed, meta


def warn_on_stale_reingest(con: sqlite3.Connection, ref: str,
                           digest: str, observed: str) -> None:
    """Catch the classic 'same file, different observed_at' duplicate-capture bug."""
    hits = con.execute(
        "SELECT observed_at FROM data_sources WHERE ref=? AND sha256=? AND observed_at<>?",
        (ref, digest, observed),
    ).fetchall()
    if hits:
        other = ", ".join(sorted({h[0] for h in hits})[:3])
        print(
            f"[warn] {os.path.basename(ref)} was previously ingested at {other} "
            f"but is now being ingested at {observed}.\n"
            f"       That writes a SECOND snapshot instead of updating in place. "
            f"Pass --observed-at {hits[0][0]!r} to update the existing one.",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# core upsert
# ---------------------------------------------------------------------------
LOC_INSERT = """
INSERT INTO locations
    (loc_key, province, county, district, place, place_kind, university,
     province_key, county_key, first_seen_at, last_seen_at)
VALUES (:loc_key, :province, :county, :district, :place, :place_kind, :university,
        :province_key, :county_key, :observed_at, :observed_at)
ON CONFLICT (loc_key) DO UPDATE SET
    last_seen_at = MAX(locations.last_seen_at, excluded.last_seen_at),
    place_kind   = excluded.place_kind,
    university   = COALESCE(excluded.university, locations.university)
RETURNING id
"""

SNAP_UPSERT = """
INSERT INTO location_snapshots
    (location_id, source_id, observed_at, population, city_score, min_score,
     n_pharmacy_real, n_pharmacy_legal, n_req_registered, n_req_inprogress,
     n_req_approved, density_reported, extra, dq_flags)
VALUES (:location_id, :source_id, :observed_at, :population, :city_score,
        :min_score, :n_pharmacy_real, :n_pharmacy_legal, :n_req_registered,
        :n_req_inprogress, :n_req_approved, :density_reported, :extra, :dq_flags)
ON CONFLICT (location_id, observed_at) DO UPDATE SET
    source_id        = excluded.source_id,
    population       = excluded.population,
    city_score       = excluded.city_score,
    min_score        = excluded.min_score,
    n_pharmacy_real  = excluded.n_pharmacy_real,
    n_pharmacy_legal = excluded.n_pharmacy_legal,
    n_req_registered = excluded.n_req_registered,
    n_req_inprogress = excluded.n_req_inprogress,
    n_req_approved   = excluded.n_req_approved,
    density_reported = excluded.density_reported,
    extra            = excluded.extra,
    dq_flags         = excluded.dq_flags
"""

# Columns added after the schema first shipped; applied on connect so an existing
# database picks them up without a manual migration step.
ADDITIVE_MIGRATIONS = (
    ("location_snapshots", "dq_flags", "TEXT"),
    ("locations", "university", "TEXT"),
)


def migrate(con: sqlite3.Connection) -> list[str]:
    applied = []
    for table, column, decl in ADDITIVE_MIGRATIONS:
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
            applied.append(f"{table}.{column}")
    if applied:
        con.commit()
    return applied


def ingest(con: sqlite3.Connection, path: str, kind: str, observed_at: str,
           default_province: str | None, source_ref: str | None = None,
           notes: str | None = None) -> dict:
    from normalize import loc_key as make_loc_key, norm_key

    observed_at = to_utc_iso(observed_at)
    rows = read_any(path, observed_at, kind, default_province)
    if not rows:
        raise ValueError(f"adapter produced 0 usable rows from {path}")

    ref = source_ref or os.path.abspath(path)
    digest = sha256_file(path)
    warn_on_stale_reingest(con, ref, digest, observed_at)
    provinces = sorted({r["province"] for r in rows})
    scope = ", ".join(provinces) if len(provinces) <= 3 else \
        f"{len(provinces)} provinces"

    cur = con.cursor()
    cur.execute(
        """INSERT INTO data_sources
             (kind, ref, sha256, parser_version, observed_at, ingested_at,
              row_count, scope_label, status, notes)
           VALUES (?,?,?,?,?,?,?,?, 'ok', ?)
           ON CONFLICT (kind, ref, sha256, observed_at) DO UPDATE SET
              ingested_at = excluded.ingested_at,
              row_count   = excluded.row_count
           RETURNING id""",
        (kind, ref, digest, PARSER_VERSION, observed_at, now_iso(),
         len(rows), scope, notes),
    )
    source_id = cur.fetchone()[0]

    ins = upd = 0
    loc_cols = ("loc_key", "province", "county", "district", "place",
                "place_kind", "university", "province_key", "county_key",
                "observed_at")
    snap_cols = ("location_id", "source_id", "observed_at", "population",
                 "city_score", "min_score", "n_pharmacy_real", "n_pharmacy_legal",
                 "n_req_registered", "n_req_inprogress", "n_req_approved",
                 "density_reported", "extra", "dq_flags")
    for r in rows:
        r["loc_key"] = make_loc_key(r["province"], r["county"], r["district"],
                                    r["place"])
        r["province_key"] = norm_key(r["province"])
        r["county_key"] = norm_key(r["county"])
        cur.execute(LOC_INSERT, {k: r[k] for k in loc_cols})
        loc_id = cur.fetchone()[0]

        r["location_id"] = loc_id
        r["source_id"] = source_id
        existed = cur.execute(
            "SELECT 1 FROM location_snapshots WHERE location_id=? AND observed_at=?",
            (loc_id, observed_at)).fetchone()
        cur.execute(SNAP_UPSERT, {k: r.get(k) for k in snap_cols})
        if existed:
            upd += 1
        else:
            ins += 1

    cur.execute(
        "UPDATE data_sources SET rows_inserted=?, rows_updated=? WHERE id=?",
        (ins, upd, source_id))

    # an ingest that overlaps its own observed_at must not leave two rows for
    # the same place/time; UNIQUE(location_id, observed_at) already guards it.
    con.commit()
    return {"source_id": source_id, "rows": len(rows), "inserted": ins,
            "updated": upd, "scope": scope, "sha256": digest[:12],
            "observed_at": observed_at}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", action="append", default=[],
                    help="file (or URL with --url-fetch) to ingest; repeatable")
    ap.add_argument("--scan-inbound", action="store_true",
                    help=f"ingest every *.html/*.json in {INBOUND}")
    ap.add_argument("--kind", default="auto", choices=["auto", "html", "json"])
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--observed-at", default=None,
                    help="ISO timestamp of the snapshot (default: file mtime)")
    ap.add_argument("--province", default=None,
                    help="fallback province when the source omits it")
    ap.add_argument("--url-fetch", action="store_true",
                    help="treat --source values as URLs and download first")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reset", action="store_true",
                    help="empty locations/snapshots/sources first, for a clean rebuild")
    ap.add_argument("--manifest", default=None,
                    help="fetcher manifest (zarfiat_manifest.json); expands to every "
                         "page file and uses the crawl's updated_at as observed_at")
    args = ap.parse_args()

    # (path, observed_at_override) — the override keeps a multi-page crawl as ONE
    # logical snapshot instead of one per file mtime.
    plan: list[tuple[str, str | None]] = [(s, None) for s in args.source]

    if args.scan_inbound:
        for ext in ("html", "htm", "json"):
            plan += [(p, None) for p in sorted(glob.glob(os.path.join(INBOUND, f"*.{ext}")))]

    if args.manifest:
        mfiles, observed, meta = manifest_sources(args.manifest)
        print(f"[manifest] {meta['pages']} page(s) | endpoint={meta['endpoint']} | "
              f"sort={meta['sort']} | total_count={meta['total_count']} | "
              f"observed_at={observed}")
        plan += [(p, observed) for p in mfiles]

    if not plan:
        ap.error("nothing to ingest: pass --source, --manifest or --scan-inbound")

    con = connect(args.db)
    if args.reset and not args.dry_run:
        reset_tables(con)
        print("[reset] cleared locations, snapshots, sources, scoring_models")
    failures = 0
    for src, override in plan:
        try:
            path = src
            if args.url_fetch or src.startswith(("http://", "https://")):
                fname = os.path.basename(src.split("?")[0]) or "download.json"
                path = os.path.join(INBOUND, fname)
                fetch_url(src, path)
            if args.observed_at:
                observed = args.observed_at
            elif override:
                observed = override
            elif os.path.exists(path):
                observed = mtime_iso(path)
            else:
                observed = now_iso()
            kind = args.kind
            if kind == "auto":
                kind = "json" if path.lower().endswith((".json", ".jsonl")) \
                    else "html"
            if args.dry_run:
                rows = read_any(path, observed, kind, args.province)
                print(f"[dry-run] {src}: {len(rows)} rows, "
                      f"provinces={sorted({r['province'] for r in rows})}")
                continue
            info = ingest(con, path, kind, observed, args.province,
                          source_ref=src)
            print(f"[ok] {os.path.basename(src)}\n     rows={info['rows']} "
                  f"inserted={info['inserted']} updated={info['updated']} "
                  f"scope={info['scope']} observed_at={info['observed_at']}")
        except Exception as exc:  # noqa: BLE001 — keep going through the batch
            failures += 1
            print(f"[FAIL] {src}: {type(exc).__name__}: {exc}", file=sys.stderr)

    if not args.dry_run:
        reindex(con)
        stats = con.execute(
            """SELECT (SELECT COUNT(*) FROM locations)  AS locs,
                      (SELECT COUNT(*) FROM location_snapshots) AS snaps,
                      (SELECT COUNT(*) FROM data_sources) AS srcs""").fetchone()
        summary = {k: stats[k] for k in stats.keys()}
        print(f"\nDB {args.db}\n  locations={summary['locs']} "
              f"snapshots={summary['snaps']} sources={summary['srcs']}")
        print(json.dumps(summary))
        con.close()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
