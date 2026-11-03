"""Density at street scale — and no absurd numbers.

Two complaints, both true:

  * the cell was a settlement, so one square described a whole آبادی;
  * supply was counted per settlement, so a block with several pharmacies read as «saturated»
    while a city with 341 registered shops showed «90,000 people per pharmacy».

Now: 200 m cells (≈ 0.002°), and for each cell the residents and the pharmacies within an
800 m walk, with the FDA register disaggregated over each settlement's own built cells instead
of trusting the few pins we happen to have mapped.

    python tools/test_density_fine.py [--shots]
"""
from __future__ import annotations

import argparse
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


def get(url: str) -> dict:
    return json.loads(urllib.request.urlopen(url, timeout=120).read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", action="store_true")
    args = ap.parse_args()
    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    # ---- the surface itself
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    n = c.execute("SELECT COUNT(*) FROM density_cell").fetchone()[0]
    core = c.execute("""SELECT ratio, ph_800, pop_800 FROM density_cell
                         WHERE lat BETWEEN 31.31 AND 31.33 AND lon BETWEEN 48.66 AND 48.69
                         ORDER BY ratio DESC LIMIT 1""").fetchone()
    absurd = c.execute("SELECT COUNT(*) FROM density_cell WHERE ratio > 60000").fetchone()[0]
    unserved = c.execute("SELECT COUNT(*) FROM density_cell WHERE unserved = 1").fetchone()[0]
    mismatch = c.execute("SELECT COUNT(*) FROM density_cell WHERE ph_800 = 0 AND unserved = 0").fetchone()[0]
    c.close()

    check("the grid is street-scale", n > 40000, f"{n:,} cells")
    check("the centre of اهواز is not absurd",
          core is not None and core["ratio"] < 12000,
          f"{core['ratio']:,} residents per pharmacy with {core['ph_800']} shops in 800 m"
          if core else "missing")
    check("nobody reports more than 60,000 residents per pharmacy", absurd == 0, f"{absurd} cells")
    check("unserved cells exist and carry no shops", unserved > 1000, f"{unserved:,} cells")
    check("the flag and the count agree", mismatch == 0, f"{mismatch} rows")

    # ---- the viewport endpoint
    d = get(f"{BASE}/api/density?bbox=31.25,48.60,31.40,48.75")
    check("the endpoint answers for a viewport", d["total"] > 500, f"{d['total']} cells")
    ratios = [c[2] for c in d["cells"]]
    check("no absurd ratio reaches the browser", max(ratios) <= 100000, f"max {max(ratios):,}")
    check("the payload stays small", d["total"] < 15000, f"{d['total']} rows")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(f"{BASE}/map?lat=31.32&lon=48.67&k=8&m=dens", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(3500)
        drawn = pg.evaluate("() => document.querySelectorAll('g[data-layer=\"density-fine\"] rect').length")
        check("the fine layer draws", drawn > 500, f"{drawn} cells")
        legend = pg.locator('[data-legend="map"]')
        check("the legend is on the map", legend.count() == 1)
        text = legend.inner_text()
        check("the legend names the radius and the cell size",
              "۸۰۰" in text and "۲۰۰" in text, text.splitlines()[0])
        bands = legend.locator("li").count()
        check("every band is a row of its own", bands >= 4, f"{bands} rows")

        # the card sits over the map, so it has to be closable and stay closed
        legend.locator("button").first.click()
        pg.wait_for_timeout(400)
        pill = pg.locator('[data-legend="map"]')
        check("the legend collapses to a pill",
              pill.get_attribute("data-legend-open") == "0", pill.inner_text().splitlines()[-1])
        check("the pill is a usable tap target",
              (pill.bounding_box() or {}).get("height", 0) >= 32,
              str(round((pill.bounding_box() or {}).get("height", 0))))
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(1800)
        check("it stays closed after a reload",
              pg.locator('[data-legend="map"]').get_attribute("data-legend-open") == "0")
        pg.locator('[data-legend="map"]').click()
        pg.wait_for_timeout(400)
        check("and opens again",
              pg.locator('[data-legend="map"]').get_attribute("data-legend-open") == "1")
        fills = pg.evaluate("""() => {
          const out = new Map();
          document.querySelectorAll('g[data-layer="density-fine"] rect').forEach((r) => {
            const f = r.getAttribute('fill') || 'none';
            out.set(f, (out.get(f) || 0) + 1);
          });
          return [...out.entries()];
        }""")
        check("more than one band is present", len(fills) >= 3, str(fills))
        if args.shots:
            pg.screenshot(path="tools/shots/density-fine.png")
        br.close()

    print("\nRESULT:", "density is measured per street, not per settlement" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
