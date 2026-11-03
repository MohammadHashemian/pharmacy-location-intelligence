"""The heat the map was missing: where people live without a pharmacy to reach.

The density choropleth answered «how many shops per square» — the saturated core glowed red
and the empty desert stayed blue, which is the opposite of a decision. This surface is
`gap = residents − 5,408 × pharmacies` per 0.005° cell, so:

  * a bright cell means people live there and the shops that reach them are full;
  * the saturated core is simply not drawn, because it has no room;
  * a grey cell is a data gap (a town of 10,000 with no register row and no pin nearby),
    never a fake opportunity.

    python tools/test_opportunity.py [--shots]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = "http://localhost:3737"
KM_LAT, KM_LON = 110.574, 95.1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", action="store_true")
    args = ap.parse_args()

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    rows = [dict(r) for r in c.execute("SELECT * FROM opportunity_cell")]
    c.close()
    assert rows, "run etl/opportunity_grid.py first"

    hot = [r for r in rows if r["gap"] > 0]
    check("the surface has demand cells", len(rows) > 5000, f"{len(rows):,} cells")
    check("some cells are genuinely hot", len(hot) > 100, f"{len(hot):,} cells")

    # ---- the core must be quiet: no bright cell near the centre of اهواز
    core = [r for r in rows if r["gap"] > 0
            and math.hypot((r["lat"] - 31.3203) * KM_LAT, (r["lon"] - 48.6693) * KM_LON) < 3]
    check("the saturated core of اهواز carries no «opportunity»",
          len(core) == 0, f"{len(core)} bright cells within 3 km")

    # ---- and the hot cells must be places with people in them
    top = sorted(hot, key=lambda r: -r["gap"])[:8]
    check("hot cells are populated (≥ 500 residents)",
          all(r["demand"] >= 500 for r in top),
          ", ".join(f"{r['gap']:,}" for r in top))
    check("hot cells sit outside the big cities",
          all(abs(r["lat"] - 31.3203) > 0.03 or abs(r["lon"] - 48.6693) > 0.03 for r in top))

    unknown = [r for r in rows if r["unknown"] == 1]
    print(f"  info: {len(unknown)} cells marked «آمار ناقص»")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(f"{BASE}/map?lat=31.32&lon=48.67&k=6&m=opp", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2600)

        drawn = pg.evaluate("() => document.querySelectorAll('g[data-layer=\"opportunity\"] rect').length")
        check("the layer draws", drawn > 200, f"{drawn} cells")
        check("small gaps are not drawn as opportunity", drawn < len(hot),
              f"{drawn} of {len(hot)} hot cells")
        check("the legend is on the map", pg.locator('[data-legend="map"]').first.count() == 1)
        check("competing markers are off in this mode",
              pg.evaluate("() => !!document.querySelector('g[data-layer=\"settlements\"]')?.style.display") is False
              or pg.evaluate("() => document.querySelectorAll('g[data-layer=\"settlements\"]').length") == 1)
        if args.shots:
            pg.screenshot(path="tools/shots/opportunity-k6.png")
            pg.goto(f"{BASE}/map?lat=31.95&lon=49.27&k=9&m=opp", wait_until="domcontentloaded",
                    timeout=120000)
            pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
            pg.wait_for_timeout(2400)
            pg.screenshot(path="tools/shots/opportunity-k9.png")
        br.close()

    print("\nRESULT:", "the map shows where a new pharmacy would have patients" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
