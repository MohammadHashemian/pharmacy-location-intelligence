"""Guard the inputs of the out-of-pocket (OTC) model.

`etl/sanity_model.py` checks the MODEL; this checks the DATA behind it, because a
view that silently stops returning rows would leave the dashboard printing a
confident zero instead of an error.

Run after applying etl/views.sql (rebuild.sh does both):

    python etl/verify_otc.py
"""
import sqlite3, sys

con = sqlite3.connect("db/pharmacy.sqlite")
con.row_factory = sqlite3.Row
fail: list[str] = []


def check(ok: bool, message: str, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {message}" + (f"  [{detail}]" if detail else ""))
    if not ok:
        fail.append(message)


# --- v_place_prosperity ------------------------------------------------------
print("v_place_prosperity")
n_all = con.execute("SELECT COUNT(*) FROM v_population_choice").fetchone()[0]
n_pros = con.execute("SELECT COUNT(*) FROM v_place_prosperity").fetchone()[0]
check(n_pros == n_all, "one prosperity row per place", f"{n_pros}/{n_all}")

orphans = con.execute("""
    SELECT COUNT(*) FROM v_population_choice m
    LEFT JOIN v_place_prosperity p ON p.location_id = m.location_id
    WHERE p.location_id IS NULL
""").fetchone()[0]
check(orphans == 0, "every place joins to a prosperity row", f"{orphans} orphan(s)")

bad_share = con.execute("""
    SELECT COUNT(*) FROM v_place_prosperity
    WHERE county_urban_share IS NOT NULL
      AND (county_urban_share < 0 OR county_urban_share > 1)
""").fetchone()[0]
check(bad_share == 0, "county_urban_share stays inside 0…1", f"{bad_share} bad")

missing_share = con.execute("""
    SELECT COUNT(*) FROM v_place_prosperity
    WHERE county_population > 50000 AND county_urban_share IS NULL
""").fetchone()[0]
check(missing_share == 0, "no large county is left without an urban share",
      f"{missing_share} missing")

# Every county's own places must agree on the county figure — a county-level
# number that differs per row means the join is fanning out.
disagree = con.execute("""
    SELECT COUNT(*) FROM (
        SELECT province, county, COUNT(DISTINCT county_urban_share) AS n
        FROM v_place_prosperity
        WHERE county_urban_share IS NOT NULL
        GROUP BY province, county
        HAVING n > 1
    )
""").fetchone()[0]
check(disagree == 0, "the county figure is identical for all its places", f"{disagree} county")

hh = con.execute("""
    SELECT SUM(hh_size IS NOT NULL), COUNT(*) FROM v_place_prosperity
""").fetchone()
print(f"  info  hh_size resolved for {hh[0]}/{hh[1]} places "
      f"(needs etl/enrich_population.py; NULL is treated as unknown, not average)")

# --- v_otc_anchors -----------------------------------------------------------
print("v_otc_anchors")
row = con.execute("SELECT * FROM v_otc_anchors").fetchone()
if row is None:
    check(False, "the yearbook anchor is missing")
else:
    d = dict(row)
    check(d["urban_hh_expenditure"] is not None and d["rural_hh_expenditure"] is not None,
          "both expenditure figures loaded",
          f"{d['urban_hh_expenditure']:,.0f} / {d['rural_hh_expenditure']:,.0f}")
    check(bool(d["rural_to_urban_ratio"]) and 0.3 < d["rural_to_urban_ratio"] < 1,
          "rural spending is below urban but not implausibly so",
          f"ratio={d['rural_to_urban_ratio']}")
    check(bool(d["urban_consumption_per_capita"]) and d["urban_consumption_per_capita"] > 100_000,
          "per-person consumption is a rial-scale figure",
          f"{d['urban_consumption_per_capita']:,.0f} rial/person/yr (1403)")
    check(d["year_sh"] == 1403, "the anchor is tagged with its own year", str(d["year_sh"]))

print()
if fail:
    print(f"FAILED — {len(fail)} check(s): {', '.join(fail)}")
    sys.exit(1)
print("OTC inputs verified.")
