import sqlite3
c = sqlite3.connect("db/pharmacy.sqlite")
c.row_factory = sqlite3.Row
q = lambda s: [dict(r) for r in c.execute(s)]

print("university populated:",
      c.execute("select count(*) from locations where university is not null").fetchone()[0],
      "of", c.execute("select count(*) from locations").fetchone()[0])

print("\n=== top universities by pharmacy count ===")
for r in q("select * from v_university_rollup limit 15"):
    print(f"  {r['university'][:52]:<52} places={r['n_market_places']:>4} "
          f"ph={r['n_pharmacy_total']:>5} /100k={r['pharmacies_per_100k']}")

print("\n=== distinct universities ===", c.execute(
    "select count(distinct university) from locations where university is not null").fetchone()[0])

print("\n=== null university rows ===", c.execute(
    "select count(*) from locations where university is null").fetchone()[0])

print("\n=== a few places with university ===")
for r in q("""select place, county, province, university from v_latest_snapshot
              where is_market=1 order by population desc limit 6"""):
    print(f"  {r['place'][:18]:<18} {r['province'][:16]:<16} -> {r['university']}")
