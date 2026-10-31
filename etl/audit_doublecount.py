"""Is the national pharmacy total inflated by duplicate places?

The API fans out one row per affiliated university, and my loc_key is
(province|county|district|place). If a city is listed under two different
bakhsh/district values, it becomes two locations and its pharmacies get counted
twice. Measure the exposure before trusting the totals.
"""
import sqlite3, json, glob, os, sys, collections
sys.path.insert(0, "etl")
from normalize import norm_text

c = sqlite3.connect("db/pharmacy.sqlite")
c.row_factory = sqlite3.Row

print("=== (province, county, place) appearing as MORE THAN ONE location ===")
rows = list(c.execute("""
  select province, county, place, count(*) n_loc,
         sum(n_pharmacy_total) ph_sum,
         group_concat(district, ' || ') districts,
         group_concat(n_pharmacy_total, ' + ') ph_each
  from v_metrics
  group by province, county, place
  having count(*) > 1
  order by ph_sum desc"""))
print(f"  duplicated (province,county,place) groups: {len(rows)}")
tot_extra = 0
for r in rows[:20]:
    print(f"  {r['place'][:22]:<22} {r['county'][:16]:<16} n={r['n_loc']} "
          f"ph={r['ph_each']}  districts={r['districts'][:70]}")
print()
print("=== exposure: pharmacies counted more than once ===")
for r in c.execute("""
  select sum(excess) as excess_pharmacies, count(*) as groups_affected from (
    select province, county, place,
           sum(n_pharmacy_total) - max(n_pharmacy_total) as excess
    from v_metrics group by province, county, place having count(*) > 1)"""):
    print(f"  groups affected            : {r['groups_affected']}")
    print(f"  excess pharmacies (upper)  : {r['excess_pharmacies']}")
national = c.execute(
    "select sum(n_pharmacy_real+n_pharmacy_legal) from v_latest_snapshot").fetchone()[0]
print(f"  national total as loaded   : {national:,}")
print(f"  de-duplicated upper bound  : {national - (r['excess_pharmacies'] or 0):,}")

print("\n=== the شهر گلستان case, straight from the raw API ===")
for f in sorted(glob.glob("data/raw/zarfiat_pages/*.json")):
    d = json.load(open(f, encoding="utf-8-sig"))
    recs = d["data"]["records"] if isinstance(d["data"], dict) else d["data"]
    for x in recs:
        if norm_text(x.get("shahrRoustaOnvan")) == "شهر گلستان" and \
           "بهارستان" in norm_text(x.get("ShahrestanOnvan")):
            print(f"  {os.path.basename(f)}")
            print(f"     ShahrID={x.get('ShahrID')} BakhsID={x.get('BakhsID')} "
                  f"Org={x.get('OrganizationID')}")
            print(f"     bakhsh={x.get('bakhshOnvan')!r}")
            print(f"     Jamiat={x.get('Jamiat')} real={x.get('CountDaroukhaneh')} "
                  f"legal={x.get('CountDaroukhanehHoghoghi')} "
                  f"appr={x.get('CountMoteghaziDarkhastTaeedShode')}")

print("\n=== how many raw rows repeat the SAME ShahrID but differ in BakhsID? ===")
seen = collections.defaultdict(set)
vals = collections.defaultdict(set)
for f in sorted(glob.glob("data/raw/zarfiat_pages/*.json")):
    d = json.load(open(f, encoding="utf-8-sig"))
    recs = d["data"]["records"] if isinstance(d["data"], dict) else d["data"]
    for x in recs:
        sid = x.get("ShahrID")
        seen[sid].add(x.get("BakhsID"))
        vals[sid].add((x.get("Jamiat"), x.get("CountDaroukhaneh"),
                       x.get("CountDaroukhanehHoghoghi")))
multi_bakhsh = {k: v for k, v in seen.items() if len(v) > 1}
conflict = {k: v for k, v in vals.items() if len(v) > 1}
print(f"  ShahrIDs appearing under >1 BakhsID : {len(multi_bakhsh)}")
print(f"  ShahrIDs whose duplicate rows DISAGREE on (pop, real, legal): {len(conflict)}")
for k in list(conflict)[:5]:
    print(f"     ShahrID {k}: {sorted(conflict[k])}")
