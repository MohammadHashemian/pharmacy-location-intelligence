"""What actually changes when the reference population is switched on?

Reports the corrections that matter for site selection: places whose published
population was materially wrong and whose ranking therefore moves.
"""
from __future__ import annotations

import os
import sqlite3

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

print("=== coverage ===")
for r in c.execute("SELECT * FROM v_reference_coverage"):
    print("  ", dict(r))

print("\n=== corroborated vs corrected ===")
r = c.execute("""
    SELECT
      SUM(CASE WHEN ref_ratio BETWEEN 0.99 AND 1.01 THEN 1 ELSE 0 END) AS same,
      SUM(CASE WHEN ref_ratio < 0.99 OR ref_ratio > 1.01 THEN 1 ELSE 0 END) AS differs,
      SUM(CASE WHEN ref_ratio >= 2 OR ref_ratio <= 0.5 THEN 1 ELSE 0 END) AS material
    FROM v_population_choice WHERE has_reference = 1 AND is_market = 1
""").fetchone()
print(f"   reference matches FDA exactly : {r['same']:,}")
print(f"   reference corrects FDA        : {r['differs']:,}")
print(f"   of which materially (>=2x)    : {r['material']:,}")

print("\n=== biggest under-counts fixed (FDA too low) ===")
for r in c.execute("""
    SELECT place, county, fda_population, ref_population, ref_census_year_sh,
           ref_source, ref_match_score AS match_score, round(ref_ratio,1) ratio
    FROM v_population_choice
    WHERE is_market = 1 AND ref_ratio >= 3
    ORDER BY ref_ratio DESC LIMIT 14
"""):
    print(f"   {r['place'][:26]:<26} {r['county'][:16]:<16} "
          f"{r['fda_population']:>9,} -> {r['ref_population']:>10,} "
          f"({r['ratio']}x, {r['ref_census_year_sh']}, {r['ref_source'][:9]}, {r['match_score']})")

print("\n=== biggest over-counts fixed (FDA too high) ===")
for r in c.execute("""
    SELECT place, county, fda_population, ref_population, ref_census_year_sh,
           ref_source, ref_match_score AS match_score, round(ref_ratio,2) ratio
    FROM v_population_choice
    WHERE is_market = 1 AND ref_ratio IS NOT NULL AND ref_ratio <= 1/3.0
    ORDER BY ref_ratio ASC LIMIT 10
"""):
    print(f"   {r['place'][:26]:<26} {r['county'][:16]:<16} "
          f"{r['fda_population']:>9,} -> {r['ref_population']:>10,} "
          f"({r['ratio']}x, {r['ref_census_year_sh']}, {r['ref_source'][:9]}, {r['match_score']})")

print("\n=== cities published with population 0, rescued by the reference ===")
for r in c.execute("""
    SELECT place, county, fda_population, ref_population, n_pharmacy_total
    FROM v_population_choice
    WHERE is_market = 1 AND (fda_population IS NULL OR fda_population = 0)
      AND ref_population > 0
    ORDER BY ref_population DESC LIMIT 12
"""):
    print(f"   {r['place'][:26]:<26} {r['county'][:16]:<16} "
          f"0 -> {r['ref_population']:>9,}  ({r['n_pharmacy_total']} pharmacies)")
c.close()
