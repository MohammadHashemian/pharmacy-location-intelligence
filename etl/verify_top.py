import json, glob, sys, os
sys.path.insert(0, "etl")
from normalize import norm_text

TARGETS = ["مشکین دشت", "ملك آباد", "ملک آباد"]

files = sorted(glob.glob("data/raw/zarfiat_pages/*.json"))
hits = []
for f in files:
    d = json.load(open(f, encoding="utf-8-sig"))
    recs = d["data"]["records"] if isinstance(d["data"], dict) else d["data"]
    for r in recs:
        nm = norm_text(r.get("shahrRoustaOnvan"))
        if any(t in nm for t in TARGETS):
            hits.append((os.path.basename(f), r))

print(f"raw records matching: {len(hits)}\n")
for f, r in hits:
    print(f"--- {f} ---")
    print(f"  ShahrID     {r.get('ShahrID')}")
    print(f"  place       {r.get('shahrRoustaOnvan')!r}")
    print(f"  county      {r.get('ShahrestanOnvan')!r}")
    print(f"  bakhsh      {r.get('bakhshOnvan')!r}")
    print(f"  Jamiat      {r.get('Jamiat')!r}")
    print(f"  real/legal  {r.get('CountDaroukhaneh')!r} / {r.get('CountDaroukhanehHoghoghi')!r}")
    print(f"  empreq      {r.get('CountMoteghazi')!r} / {r.get('CountMoteghaziDarkhastDade')!r} / {r.get('CountMoteghaziDarkhastTaeedShode')!r}")
    print(f"  EmtiazShahr {r.get('EmtiazShahr')!r}  minEmtiaz {r.get('HadaghaleEmtiaz')!r}")
    print(f"  ZaribHaghighi {r.get('ZaribHaghighi')!r}")
    print(f"  OrganOnvan  {r.get('OrganOnvan')!r}")
    print()

# how many places nationwide report ZERO pharmacies while having a real population?
import sqlite3
c = sqlite3.connect("db/pharmacy.sqlite")
c.row_factory = sqlite3.Row
print("=== market-scope places reporting ZERO pharmacies, with population over 20k ===")
rows = list(c.execute("""
  select place, county, province, population, place_kind, city_score, min_score
  from v_metrics
  where is_market = 1 and (n_pharmacy_real + n_pharmacy_legal) = 0
    and population >= 20000
  order by population desc limit 25"""))
for r in rows:
    print(f"  {r['place'][:24]:<24} {r['county'][:16]:<16} {r['province'][:14]:<14} "
          f"pop={r['population']:>7,} kind={r['place_kind']:<7} score={r['city_score']}")
print(f"  total such places: {len(rows)}")
print("\n  count of ALL market places with zero pharmacies:",
      c.execute("select count(*) from v_metrics where is_market=1 and (n_pharmacy_real+n_pharmacy_legal)=0").fetchone()[0])
