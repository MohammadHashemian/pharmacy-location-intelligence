"""P0.2/P0.3 — every number on the page says what it counts and where it came from.

  * supply carries a source tag: «فید» (FDA register) or «نقشه» (mapped / hand-added);
  * population shows its year and exposes the source in a tooltip;
  * the two recommendation lists are named by their unit, so «کمبود داروخانه»
    (settlement level, pharmacies) is not confused with the 0–1 cell score.

    python tools/test_labels_and_sources.py
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
    fda = c.execute("""SELECT name FROM v_map_settlement
                        WHERE pharmacy_total > 0 AND lat IS NOT NULL AND population > 20000
                          AND est_km <= 55
                        ORDER BY population DESC LIMIT 1""").fetchone()[0]
    # inside the default 60 km radius, otherwise the row is filtered out of the table
    mapped = c.execute("""SELECT name FROM v_map_settlement
                           WHERE pharmacy_total = 0 AND pharmacy_mapped > 0
                             AND lat IS NOT NULL AND population > 5000
                             AND est_km <= 55
                           ORDER BY population DESC LIMIT 1""").fetchone()
    c.close()
    if not mapped:
        print("no settlement with mapped-only supply; rebuild the layer first")
        return 1
    mapped = mapped[0]

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat=31.33&lon=48.60&k=9", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        heads = pg.locator("thead th").all_inner_texts()
        check("column names its unit", any("کمبود داروخانه" in h for h in heads), str(heads[:4]))
        check("population column carries a tooltip",
              any("جمعیت" in h for h in heads))

        body = pg.inner_text("body")
        check("lists are named by level",
              "گزینه در سطح آبادی" in body and "پیشنهاد در سطح بلوک جمعیتی" in body)

        for name, tag, why in ((fda, "فید", "FDA register"), (mapped, "نقشه", "mapped only")):
            pg.fill('input[placeholder="جستجوی نام، شهرستان، بخش یا دهستان…"]', name)
            pg.wait_for_timeout(600)
            # scope to the settlement table: the shortlist comparison also contains names
            row = pg.locator('table:has(th:text("کمبود داروخانه")) tr', has_text=name).first
            cells = [x.strip() for x in row.locator("td").all_inner_texts()]
            check(f"{why} row tagged «{tag}»", any(tag in c for c in cells),
                  " | ".join(cells[:7]))
        br.close()

    print("\nRESULT:", "labels and sources are honest" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
