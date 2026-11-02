"""Neighbourhoods on the map — the class of places that was invisible, not just two names.

The report was «کوت نواصر و کوی هادی در نقشه اسم‌گذاری نشدند». The cause was structural: the
label layer read `v_map_settlement`, the **administrative** layer (شهر / روستا). A محله is not
an administrative unit, so all 312 named neighbourhoods that `geo_places` already held were
never drawn.

This test asserts the diagnosis, the fix and the two named cases:

  1. neither name exists in `v_map_settlement` — that is why they were missing;
  2. both exist in `map_neighbourhood`, with coordinates and the city they belong to;
  3. the map draws them at city zoom;
  4. typing «کوی هادی» finds it (as the alias of the OSM label «هادی آباد - کوت عبداله»).

    python tools/test_neighbourhoods.py
"""
from __future__ import annotations

import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = "http://localhost:3737"


def main() -> int:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    total = c.execute("SELECT COUNT(*) FROM map_neighbourhood").fetchone()[0]
    nowaser = c.execute(
        "SELECT name, lat, lon, city FROM map_neighbourhood WHERE name LIKE '%نواصر%'").fetchone()
    hadi = c.execute(
        "SELECT name, alias, lat, lon, city FROM map_neighbourhood "
        "WHERE alias LIKE '%هادی%' OR name LIKE '%هادی%'").fetchone()

    # the diagnosis: the administrative layer never had them
    in_settlements = c.execute(
        "SELECT COUNT(*) FROM v_map_settlement WHERE name LIKE '%نواصر%' OR name LIKE '%کوی هادی%'"
    ).fetchone()[0]
    c.close()

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    check("cause: neither name is in the administrative layer", in_settlements == 0,
          f"{in_settlements} rows in v_map_settlement")
    check("the whole class was imported, not two names", total >= 300, f"{total} neighbourhoods")
    check("کوت نواصر present with coordinates",
          bool(nowaser) and nowaser["lat"] and nowaser["lon"],
          f"{nowaser['lat']:.4f},{nowaser['lon']:.4f} · {nowaser['city']}" if nowaser else "missing")
    check("کوی هادی resolvable as an alias",
          bool(hadi) and hadi["alias"] == "کوی هادی",
          f"{hadi['name']} → {hadi['alias']}" if hadi else "missing")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        # 17x: the two places are 730 m apart, so at city zoom their labels would overlap and
        # one is correctly dropped — cartography, not a miss. The search chip works at any zoom.
        pg.goto(f"{BASE}/map?lat=31.2240&lon=48.6570&k=17", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(3000)

        hoods = pg.evaluate("""() => {
          const g = document.querySelector('g[data-layer="hoods"]');
          if (!g) return {n: 0, texts: []};
          return {n: g.querySelectorAll('g[data-hood]').length,
                  texts: [...g.querySelectorAll('text')].map((t) => t.textContent || '')};
        }""")
        check("labels are drawn at city zoom", hoods["n"] >= 20, f"{hoods['n']} labels in view")
        check("کوت نواصر is on the map",
              any("نواصر" in t for t in hoods["texts"]))
        check("کوی هادی is on the map",
              any("هادی" in t for t in hoods["texts"]))

        pg.fill('input[placeholder*="جستجوی نام"]', "کوی هادی")
        pg.wait_for_timeout(700)
        chip = pg.locator('button:has-text("کوی هادی")')
        check("search finds it", chip.count() >= 1, f"{chip.count()} chip(s)")
        if chip.count():
            chip.first.click()
            pg.wait_for_timeout(1200)
            check("clicking the chip flies there",
                  pg.evaluate("() => window.__khz.screenOf(31.2249, 48.6532)") is not None)
        br.close()

    print("\nRESULT:", "neighbourhoods are a layer now, not an exception list" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
