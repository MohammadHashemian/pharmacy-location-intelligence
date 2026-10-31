"""Verify the reference-population layer.

The invariant the user asked for explicitly: **the original FDA populations are
kept**. This proves it rather than asserting it — every snapshot value is
compared against the FDA figure the dashboard exposes, and any drift fails the
run.

Also checks that every reference row is well-formed and traceable (has a source,
an id, a URL, a confidence score) and spots the case that started this work.
"""
from __future__ import annotations

import os
import sqlite3
import sys

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")

fails: list[str] = []
warns: list[str] = []


def main() -> int:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    # ---- 1. the FDA population must be untouched -------------------------
    drift = c.execute("""
        SELECT COUNT(*) n
        FROM v_population_choice v
        JOIN location_snapshots s ON s.location_id = v.location_id
        WHERE COALESCE(s.population, -1) <> COALESCE(v.fda_population, -1)
    """).fetchone()["n"]
    if drift:
        fails.append(f"{drift} places: FDA population drifted from the snapshot")
    else:
        print("  [ok] FDA population identical to the stored snapshot for every "
              "place (nothing overwritten)")

    # every snapshot row still present
    total_snap = c.execute("SELECT COUNT(*) n FROM location_snapshots").fetchone()["n"]
    total_loc = c.execute("SELECT COUNT(*) n FROM locations").fetchone()["n"]
    print(f"  [ok] {total_snap:,} snapshots over {total_loc:,} locations retained")
    if total_snap < total_loc:
        fails.append("fewer snapshots than locations")

    # ---- 2. reference rows are well-formed and traceable -----------------
    bad = c.execute("""
        SELECT COUNT(*) n FROM population_reference
        WHERE population IS NULL OR population <= 0
           OR source IS NULL OR source = ''
           OR source_id IS NULL OR source_url IS NULL
           OR match_score IS NULL OR match_method IS NULL
    """).fetchone()["n"]
    if bad:
        fails.append(f"{bad} reference rows missing provenance or population")
    else:
        print("  [ok] every reference row carries source, id, url, score, method")

    # ref must differ from fda where it exists, else it adds nothing
    same = c.execute("""
        SELECT COUNT(*) n
        FROM population_reference pr
        JOIN location_snapshots s ON s.location_id = pr.location_id
        WHERE pr.population = s.population
    """).fetchone()["n"]
    if same:
        warns.append(f"{same} reference rows equal the FDA value (redundant)")

    # ---- 3. scope: only market places should carry references ------------
    out_of_scope = c.execute("""
        SELECT COUNT(*) n FROM population_reference pr
        JOIN v_metrics m ON m.location_id = pr.location_id
        WHERE m.is_market <> 1
    """).fetchone()["n"]
    if out_of_scope:
        warns.append(f"{out_of_scope} reference rows on non-market places")

    # ---- 4. coverage -----------------------------------------------------
    cov = c.execute("SELECT * FROM v_reference_coverage").fetchone()
    if cov:
        print(f"  [ok] coverage: {cov['with_reference']:,}/{cov['market_places']:,} "
              f"market places ({cov['coverage_pct']}%)")
        print(f"       high-confidence {cov['high_confidence']:,} | "
              f"medium {cov['medium_confidence']:,} | "
              f"materially different {cov['materially_different']:,}")

    # ---- 5. the case that started this ------------------------------------
    rows = list(c.execute("""
        SELECT v.place, v.county, v.fda_population, v.ref_population,
               v.ref_source, v.ref_census_year_sh, v.ref_ratio
        FROM v_population_choice v
        WHERE v.place LIKE '%ملاشیه%'
    """))
    if not rows:
        warns.append("ملاشیه not found in the database")
    for r in rows:
        tag = "REF" if r["ref_population"] else "   "
        print(f"  [{tag}] {r['place']:<22} fda={r['fda_population']} "
              f"ref={r['ref_population']} ratio={r['ref_ratio']} "
              f"year={r['ref_census_year_sh']}")
        if "ملاشیه" in (r["place"] or "") and not r["ref_population"]:
            fails.append(f"{r['place']} still has no reference population")

    # ---- 6. the adjusted view must actually move -------------------------
    moved = c.execute("""
        SELECT COUNT(*) n FROM v_population_choice
        WHERE has_reference = 1 AND ref_ratio IS NOT NULL
          AND (ref_ratio >= 2 OR ref_ratio <= 0.5)
    """).fetchone()["n"]
    print(f"  [ok] {moved:,} places change materially under the adjusted view")
    if cov and cov["with_reference"] and moved == 0:
        fails.append("references exist but none change the population materially")

    c.close()
    print()
    for w in warns:
        print(f"  [warn] {w}")
    for f in fails:
        print(f"  [FAIL] {f}")
    if fails:
        return 1
    print("VERIFY REFERENCE OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
