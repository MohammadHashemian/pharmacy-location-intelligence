"""Audit the geographic layer: is the "new location" set real?

Three questions, answered from the database rather than by assumption:

  1. For every place the loader called **new**, what is the closest name in the
     FDA feed *ignoring the county constraint*? If a near-identical name exists
     in a different county, either it is genuinely a different village with the
     same name (the county rule was right) or the county resolution is wrong
     (the rule hid a real match). Both cases are listed, with the county on each
     side, so the reader can judge.
  2. How well do the two independent county routes agree?
  3. Sanity: known places must land where they belong (اهواز, دزفول, آبادان,
     ملاشیه), and the distance ladder must reproduce known road distances.

Usage: python etl/audit_geo.py [--top 30]
"""
from __future__ import annotations

import difflib
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_geo import fold_name  # noqa: E402
from normalize import norm_key  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")


def main() -> int:
    top = 30
    for a in sys.argv[1:]:
        if a.startswith("--top="):
            top = int(a.split("=", 1)[1])
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    fda = [dict(r) for r in c.execute(
        "SELECT m.place, m.county, m.place_kind, m.population FROM v_metrics m "
        "JOIN locations l ON l.id = m.location_id "
        "WHERE l.province_key LIKE '%خوزستان%'")]
    for r in fda:
        r["key"] = fold_name(norm_key(r["place"]))
    fda_keys = [r["key"] for r in fda]

    print("=" * 78)
    print("1. NEW PLACES vs THE CLOSEST FDA NAME ANYWHERE (county constraint OFF)")
    print("=" * 78)
    news = [dict(r) for r in c.execute("""
        SELECT name, county, place_kind, population_best, distance_km, dq_flags
        FROM v_geo_new_places
        WHERE place_kind IN ('city','town','village')
        ORDER BY COALESCE(population_best, 0) DESC, distance_km""")]
    print(f"places called new (city/town/village): {len(news):,}\n")
    would_be_matches = 0
    for r in news[:top]:
        fk = fold_name(norm_key(r["name"]))
        best, ratio = None, 0.0
        for row, k in zip(fda, fda_keys):
            if not k:
                continue
            ratio_ = difflib.SequenceMatcher(None, fk, k).ratio()
            if ratio_ > ratio:
                best, ratio = row, ratio_
        flag = "  <-- REVIEW" if ratio >= 0.86 else ""
        if ratio >= 0.86:
            would_be_matches += 1
        print(f"  {r['name'][:24]:<24} {(r['county'] or '-')[:20]:<20} "
              f"pop={r['population_best'] or 0:>8,}  {r['distance_km'] or 0:>6.1f}km"
              f"  closest FDA={best['place'][:22]:<22} ({best['county'][:16]})"
              f"  sim={ratio:.2f}{flag}")
    print(f"\n  of the top {min(top, len(news))}: {would_be_matches} have a name "
          f"≥0.86 similar somewhere in the FDA feed\n")

    print("=" * 78)
    print("2. THE VARIANT QUEUE (similar name, same county, not confirmed)")
    print("=" * 78)
    for r in c.execute("""SELECT name, place_kind, county, fda_place, fda_county,
                                 fda_population, n_pharmacy_total, match_score,
                                 match_method
                          FROM v_geo_variants
                          ORDER BY fda_population DESC LIMIT 25"""):
        print(f"  map {r['name'][:22]:<22} {r['place_kind']:8s} {(r['county'] or '-')[:18]:<18}"
              f" ~ FDA {r['fda_place'][:22]:<22} pop={r['fda_population'] or 0:>7,}"
              f" ph={r['n_pharmacy_total'] or 0:>3} score={r['match_score']:.2f}")

    print()
    print("=" * 78)
    print("3. COUNTY: the two independent routes, and the rows they disagree on")
    print("=" * 78)
    for r in c.execute("""SELECT county, county_alt, COUNT(*) n
                          FROM v_geo_place WHERE county_alt IS NOT NULL
                          GROUP BY 1,2 ORDER BY n DESC LIMIT 15"""):
        print(f"  {r['n']:>3}  own Wikidata P131: {r['county'][:26]:<26} "
              f"vs بakhsh polygon: {r['county_alt']}")
    if not c.execute("SELECT 1 FROM v_geo_place WHERE county_alt IS NOT NULL").fetchone():
        print("  (none)")

    print()
    print("=" * 78)
    print("4. SPOT CHECKS")
    print("=" * 78)
    for nm in ("اهواز", "دزفول", "آبادان", "خرمشهر", "ملاشیه یک", "هفتکل",
               "بهبهان", "شادگان", "ایذه", "گتوند"):
        r = c.execute("""SELECT name, county, status, fda_place, distance_km,
                                road_km, road_minutes, population_best
                         FROM v_geo_place WHERE name = ?""", (nm,)).fetchone()
        if not r:
            print(f"  {nm:<14} NOT IN THE MAP LAYER")
            continue
        print(f"  {r['name'][:14]:<14} {r['status']:8s} {(r['county'] or '-')[:20]:<20}"
              f" fda={str(r['fda_place'])[:18]:<18} {r['distance_km']:>6.1f}km gc"
              f" {r['road_km'] if r['road_km'] is not None else '-'!s:>6} km road"
              f"  pop={r['population_best'] or 0:,}")

    print()
    print("=" * 78)
    print("5. STATUS SUMMARY")
    print("=" * 78)
    for r in c.execute("""SELECT status, COUNT(*) n,
                                 SUM(CASE WHEN place_kind IN ('city','town') THEN 1 ELSE 0 END) urban,
                                 SUM(CASE WHEN dq_flags LIKE '%pop_outlier%' THEN 1 ELSE 0 END) susp
                          FROM v_geo_place GROUP BY 1 ORDER BY 2 DESC"""):
        print(f"  {r['status']:8s} {r['n']:>5}  (urban {r['urban']:>3}, "
              f"suspect population {r['susp']:>2})")
    print()
    for r in c.execute("""SELECT metric, value, detail FROM v_geo_coverage"""):
        print(f"  {r['metric']:<28} {r['value']:>8,.0f}  {r['detail']}")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
