"""Density is measured in area served, not in settlements per shop.

Before: «residents per pharmacy» was computed per settlement, so one shop in a 40 km² آبادی
read as «density 1» and a whole district looked occupied by a single counter. Now:

  * `service_metric` — built-up area (from street geometry), the share of it inside a 1.5 km
    walk of a pharmacy, the population that share holds, and how many pharmacies are over
    capacity;
  * `settlement_service` — per settlement: nearest pharmacy, pharmacies within a walk, its own
    built footprint, residents/km², and capacity vs population;
  * `/api/capacity` — the same numbers, plus a dial for «residents one pharmacy can carry».

    python tools/test_capacity.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = "http://localhost:3737"
FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789")


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


def main() -> int:
    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    d = api("/api/capacity")
    m = {x["key"]: x["value"] for x in d["metrics"]}
    print("  metrics:", {k: round(v, 1) for k, v in m.items()})

    check("built-up area comes from street geometry, not a guess",
          1000 < m["builtup_km2"] < 6000, f"{m['builtup_km2']:,.0f} km²")
    check("coverage is an area share, with a real denominator",
          2 < m["occupied_share_built"] < 60, f"{m['occupied_share_built']:.1f}% of built-up")
    check("population coverage is reported separately",
          40 < m["population_share_1500"] < 99, f"{m['population_share_1500']:.1f}% within 1.5 km")
    check("unserved population is a number, not silence",
          m["population_unserved"] > 0, f"{m['population_unserved']:,.0f}")

    # ---- per settlement: density must be population over its own footprint
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    row = c.execute("""
        SELECT v.name, v.population, ss.footprint_km2, ss.density
          FROM v_settlement_capacity ss JOIN v_map_settlement v ON v.area_id = ss.area_id
         WHERE ss.footprint_km2 > 1 AND v.population > 5000
         ORDER BY v.population DESC LIMIT 1""").fetchone()
    c.close()
    expect = row["population"] / row["footprint_km2"]
    check("density is population / footprint",
          abs(row["density"] - expect) / expect < 0.02,
          f"{row['name']}: {row['population']:,} / {row['footprint_km2']} km² = "
          f"{row['density']:.0f} (expected {expect:.0f})")
    check("a city footprint is bigger than one pharmacy's disc",
          row["footprint_km2"] > 7, f"{row['footprint_km2']} km²")

    # ---- the tool must not call a saturated city «room for a new pharmacy»
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    ahvaz = c.execute("""
        SELECT supply, remaining FROM v_settlement_capacity
         WHERE name = 'اهواز' AND population > 500000 LIMIT 1""").fetchone()
    unknown = c.execute("SELECT COUNT(*) FROM settlement_service WHERE supply_known = 0").fetchone()[0]
    c.close()
    check("a 1.2M city is saturated, not «open here»",
          ahvaz is not None and ahvaz["remaining"] < 0,
          f"supply {ahvaz['supply']} → {ahvaz['remaining']:,}" if ahvaz else "missing")
    check("cities with no register row are marked unknown, not zero",
          unknown > 0, f"{unknown} settlements")
    room = [r for r in d["room"] if r["name"] == "اهواز"]
    check("the «room» list excludes the capital", not room)

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(f"{BASE}/map?lat={row and 31.32}&lon=48.67&k=12", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        card = pg.locator('div[data-panel="capacity"]')
        check("the card is on the page", card.count() == 1)
        text = card.inner_text().translate(FA).replace("٫", ".")
        check("the card shows the covered area share",
              f"{m['occupied_share_built']:.1f}" in text, text.splitlines()[1] if text else "")
        check("the card shows the unserved population",
              f"{round(m['population_unserved']):,}" in text)

        # ---- the dial
        card.get_by_role("button", name="جزئیات").click()
        pg.wait_for_timeout(400)
        box = card.get_by_label("ظرفیت یک داروخانه (نفر)")
        box.fill("20000")
        card.get_by_role("button", name="اعمال").click()
        pg.wait_for_timeout(2500)
        after = {x["key"]: x["value"] for x in api("/api/capacity")["metrics"]}
        check("raising the benchmark empties the saturated list",
              after["saturated_count"] < m["saturated_count"],
              f"{m['saturated_count']:.0f} → {after['saturated_count']:.0f}")

        # ---- the layer
        check("the mode chip exists",
              pg.get_by_role("button", name="ظرفیت باقی‌مانده").count() == 1)
        pg.goto(f"{BASE}/map?lat=31.32&lon=48.67&k=12&m=cap", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2200)
        fills = dict(pg.evaluate("""() => {
          const out = new Map();
          document.querySelectorAll('g[data-layer="settlements"] circle').forEach((c) => {
            const f = c.getAttribute('fill') || 'none';
            out.set(f, (out.get(f) || 0) + 1);
          });
          return [...out.entries()];
        }"""))
        print("  fills:", {k: v for k, v in fills.items() if k in ("#dc2626", "#16a34a", "#f59e0b")})
        check("saturated settlements are red, spare ones green",
              (fills.get("#dc2626", 0) > 0) and (fills.get("#16a34a", 0) > 0),
              str({k: v for k, v in fills.items() if k in ("#dc2626", "#16a34a", "#f59e0b")}))
        pg.screenshot(path="tools/shots/capacity.png")
        br.close()

    api("/api/capacity", {"benchmark": 5408}, "POST")
    restored = {x["key"]: x["value"] for x in api("/api/capacity")["metrics"]}
    check("the benchmark is restored", restored["benchmark"] == 5408,
          f"saturated {restored['saturated_count']:.0f}")

    print("\nRESULT:", "coverage and capacity are measured, not assumed" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
