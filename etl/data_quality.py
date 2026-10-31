import sqlite3

c = sqlite3.connect("db/pharmacy.sqlite")
c.row_factory = sqlite3.Row
q = lambda s, *a: [dict(r) for r in c.execute(s, a).fetchall()]

print("=== rows with population > 2,000,000 (implausible for one 'city' row?) ===")
for r in q("""select place, county, district, province, population, n_pharmacy_real,
              n_pharmacy_legal, n_req_approved, pharmacies_per_100k, place_kind
              from v_metrics where population > 2000000 order by population desc"""):
    print(f"  {r['place'][:28]:<28} {r['county'][:18]:<18} {r['province'][:14]:<14} "
          f"pop={r['population']:>10,} ph={r['n_pharmacy_real']}+{r['n_pharmacy_legal']:<3} "
          f"/100k={r['pharmacies_per_100k']} kind={r['place_kind']}")

print("\n=== how many places repeat the same population value? (top offenders) ===")
for r in q("""select population, count(*) n, group_concat(distinct place) places
              from v_latest_snapshot where population > 1000000
              group by population having count(*) > 1 order by population desc limit 10"""):
    print(f"  pop {r['population']:>10,} x{r['n']}: {r['places'][:110]}")

print("\n=== 'other' kind with significant population (top 20) ===")
for r in q("""select place, county, province, population, n_pharmacy_real+n_pharmacy_legal ph,
              city_score, pharmacies_per_100k
              from v_metrics where place_kind='other' order by population desc limit 20"""):
    print(f"  {r['place'][:34]:<34} {r['county'][:16]:<16} {r['province'][:12]:<12} "
          f"pop={r['population']:>9,} ph={r['ph']:>3} score={r['city_score']}")

print("\n=== 'other' rows that HAVE pharmacies but are NOT cities ===")
print("  count:", q("""select count(*) n from v_metrics
   where place_kind='other' and (n_pharmacy_real+n_pharmacy_legal) > 0""")[0]["n"])
print("  sum pharmacies:", q("""select sum(n_pharmacy_real+n_pharmacy_legal) n from v_metrics
   where place_kind='other'""")[0]["n"])

print("\n=== does the source use a different marker in other provinces? ===")
for r in q("""select substr(place,1,12) pfx, count(*) n,
              sum(n_pharmacy_real+n_pharmacy_legal) ph
              from v_metrics where place_kind='other'
              group by 1 order by ph desc limit 15"""):
    print(f"  {r['pfx']!r:<16} n={r['n']:>5} pharmacies={r['ph']}")

print("\n=== sanity: Tehran ===")
for r in q("""select place, county, population, n_pharmacy_real, n_pharmacy_legal,
              n_req_approved, min_score, city_score, pharmacies_per_100k
              from v_metrics where county like '%تهران%' order by population desc limit 12"""):
    print("  ", r)

print("\n=== place_kind counts by province (does Khuzestan pattern hold?) ===")
for r in q("""select province, place_kind, count(*) n
              from v_latest_snapshot
              where province in ('استان خوزستان','استان تهران','استان اصفهان','استان فارس')
              group by 1,2 order by 1,2"""):
    print(f"  {r['province'][:20]:<20} {r['place_kind']:<8} {r['n']}")

print("\n=== national totals ===")
for r in q("""select count(*) places,
              sum(population) pop,
              sum(n_pharmacy_real) real_ph,
              sum(n_pharmacy_legal) legal_ph,
              sum(n_req_registered) reg,
              sum(n_req_inprogress) prog,
              sum(n_req_approved) appr
              from v_latest_snapshot"""):
    for k, v in r.items():
        print(f"  {k:<12} {v:,}" if isinstance(v, int) else f"  {k:<12} {v}")
