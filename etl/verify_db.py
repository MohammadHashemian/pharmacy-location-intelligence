"""Post-load verification. Run after every ingest (rebuild.sh calls it).

Fails loudly on the conditions that would make the dashboard lie:
  * a snapshot timestamp that is not UTC-normalised
  * a place whose "latest" observation came from the older capture
  * an analytics payload with no data-quality flags computed
"""
import sqlite3, sys, os

DB = os.environ.get("PHARMACY_DB", "db/pharmacy.sqlite")
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
one = lambda s, *a: c.execute(s, a).fetchone()[0]

problems = []

print("=== shape ===")
locs = one("select count(*) from locations")
snaps = one("select count(*) from location_snapshots")
srcs = one("select count(*) from data_sources")
print(f"  locations   {locs:,}")
print(f"  snapshots   {snaps:,}")
print(f"  sources     {srcs:,}")

print("\n=== timestamps must all be UTC 'Z' (lexicographic MAX == chronological) ===")
bad_ts = one("select count(*) from location_snapshots where observed_at not like '%Z'")
bad_ts += one("select count(*) from data_sources where observed_at not like '%Z'")
print(f"  non-UTC timestamps: {bad_ts}")
if bad_ts:
    problems.append(f"{bad_ts} timestamps are not UTC-normalised")

print("\n=== latest observation per place ===")
latest = one("select count(*) from v_latest_snapshot")
print(f"  places with a latest snapshot: {latest:,}")
if latest != locs:
    problems.append(f"v_latest_snapshot has {latest} rows but locations has {locs}")

print("\n=== national totals (plausibility) ===")
row = c.execute("""select sum(population) pop,
                          sum(n_pharmacy_real+n_pharmacy_legal) ph,
                          sum(n_req_registered) reg,
                          sum(n_req_inprogress) prog,
                          sum(n_req_approved) appr
                   from v_latest_snapshot""").fetchone()
for k in row.keys():
    print(f"  {k:<6} {row[k]:,}")
if not (70_000_000 <= row["pop"] <= 100_000_000):
    problems.append(f"national population {row['pop']:,} outside 70-100M")
if not (14_000 <= row["ph"] <= 26_000):
    problems.append(f"national pharmacy count {row['ph']:,} outside 14k-26k")

print("\n=== analysis scope (is_market) ===")
row = c.execute("""select sum(is_market) n,
                          sum(case when is_market = 1
                                   then n_pharmacy_real + n_pharmacy_legal else 0 end) ph
                   from v_metrics""").fetchone()
tot = one("select sum(n_pharmacy_real + n_pharmacy_legal) from v_metrics")
print(f"  market places        {row['n']:,} of {one('select count(*) from v_metrics'):,}")
print(f"  pharmacies covered   {row['ph']:,} / {tot:,} ({100*row['ph']/tot:.1f}%)")
if row["n"] < 1000:
    problems.append(f"is_market scope is suspiciously small ({row['n']})")
if 100 * row["ph"] / tot < 90:
    problems.append(f"is_market covers only {100*row['ph']/tot:.1f}% of pharmacies")

print("\n=== Tehran present in scope? (the prefix-only rule used to drop it) ===")
t = c.execute("""select place, population, n_pharmacy_total, is_market
                 from v_metrics where place = 'تهران بزرگ'""").fetchone()
if t:
    print(f"  {t['place']}: pop={t['population']:,} pharmacies={t['n_pharmacy_total']:,} "
          f"is_market={t['is_market']}")
    if not t["is_market"]:
        problems.append("تهران بزرگ excluded from is_market")
else:
    problems.append("تهران بزرگ not found at all")
if "تهران بزرگ" not in {r[0] for r in c.execute(
        "select place from v_metrics where is_market=1")}:
    problems.append("تهران بزرگ missing from the is_market set")

print("\n=== data-quality flags ===")
rows = list(c.execute("select * from v_dq_summary"))
if not rows:
    problems.append("no data-quality flags computed — did the dq_flags migration run?")
for r in rows:
    print(f"  {r['dq_flags']:<24} places={r['n_places']:<6} "
          f"pharmacies={r['n_pharmacy_total']}")
print("  flagged and inside the market scope:")
for r in c.execute("""select place, county, population, n_pharmacy_total, dq_flags
                      from v_metrics where dq_flags is not null and is_market = 1
                      order by population desc limit 10"""):
    print(f"    {r['place'][:26]:<26} {r['county'][:16]:<16} "
          f"pop={r['population']:>9,} ph={r['n_pharmacy_total']:>4} {r['dq_flags']}")

print("\n=== county rollup ===")
print("  counties:", one("select count(*) from v_county_rollup"))
print("  provinces:", one("select count(distinct province) from v_latest_snapshot"))

print("\n=== analytics spot checks ===")
print("  distinct provinces in is_market:",
      one("select count(distinct province) from v_metrics where is_market=1"))
print("  distinct counties in is_market:",
      one("select count(distinct county) from v_metrics where is_market=1"))
mx = c.execute("""select place, county, province, population, n_pharmacy_total
                  from v_metrics where is_market=1 order by population desc limit 3""")
for r in mx:
    print(f"    largest: {r['place'][:22]:<22} {r['province'][:14]:<14} "
          f"pop={r['population']:>9,} ph={r['n_pharmacy_total']}")

print()
if problems:
    print("VERIFY FAILED:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("VERIFY OK")
