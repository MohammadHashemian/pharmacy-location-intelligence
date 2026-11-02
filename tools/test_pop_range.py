"""Population filter: a range, not a floor.

The old control was «هر جمعیتی / ≥ ۱٬۰۰۰ / ≥ ۵٬۰۰۰ / ≥ ۲۰٬۰۰۰» — a floor only, so «شهرهای
بین ۵ تا ۲۰ هزار نفر», which is where second-tier towns live, could not be asked.

    python tools/test_pop_range.py
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
FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789")


def strip(s: str) -> str:
    return s.translate(FA).replace("٬", "").replace(",", "")


def main() -> int:
    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    # what the database says a 5,000..20,000 window contains (plotted settlements only)
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    n_range = c.execute("""SELECT COUNT(*) FROM v_map_settlement
                            WHERE lat IS NOT NULL AND population BETWEEN 5000 AND 20000""").fetchone()[0]
    n_floor = c.execute("""SELECT COUNT(*) FROM v_map_settlement
                            WHERE lat IS NOT NULL AND population >= 5000""").fetchone()[0]
    c.close()
    print(f"  db: 5,000-20,000 → {n_range} · ≥5,000 → {n_floor}")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(f"{BASE}/map?lat=31.32&lon=48.67&k=8", wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        panel = pg.locator("div:has(> div:has-text('گزینه در سطح آبادی'))").last
        count = lambda: int(strip(panel.locator("span:has-text('مورد')").first.inner_text()
                                  .split("مورد")[0].strip()) or 0)
        before = count()

        lo = pg.locator('[data-range="pop-min"]')
        hi = pg.locator('[data-range="pop-max"]')
        check("the filter has both ends", lo.count() == 1 and hi.count() == 1)

        lo.fill("5000")
        pg.wait_for_timeout(900)
        only_floor = count()
        hi.fill("20000")
        pg.wait_for_timeout(900)
        closed = count()
        print(f"  counts: none {before} · ≥5000 {only_floor} · 5000-20000 {closed}")

        check("a ceiling narrows the list", closed < only_floor, f"{only_floor} → {closed}")
        # pick a row that is on screen right now, then move the ceiling under it
        rows = pg.locator('table[data-table="candidates"] tbody tr')
        check("the table has rows inside the window", rows.count() > 0, f"{rows.count()} rows")
        name = rows.first.locator("td").first.inner_text().strip()
        c = sqlite3.connect(DB)
        c.row_factory = sqlite3.Row
        pop = c.execute("SELECT population FROM v_map_settlement WHERE name = ? LIMIT 1",
                        (name,)).fetchone()
        c.close()
        if pop is None:
            check("the first row is a real settlement", False, name)
        else:
            pg.locator('[data-range="pop-max"]').fill(str(int(pop["population"]) - 1))
            pg.wait_for_timeout(900)
            table = pg.locator('table[data-table="candidates"]')
            check("raising the ceiling under a row removes it", name not in table.inner_text(),
                  f"{name} · {pop['population']:,}")
            pg.locator('[data-range="pop-max"]').fill("20000")
            pg.wait_for_timeout(700)

        check("a floor alone keeps more rows", only_floor > closed, f"{only_floor} ≥ {closed}")

        # ---- crossing the ends is corrected, not silently empty
        lo.fill("30000")
        pg.wait_for_timeout(700)
        check("a minimum above the maximum raises the maximum",
              int(hi.input_value() or 0) == 30000, hi.input_value())

        # ---- clearing restores everything
        pg.locator('[data-range="pop-clear"]').click()
        pg.wait_for_timeout(900)
        check("clearing returns the full list", count() == before, f"{count()} vs {before}")
        pg.screenshot(path="tools/shots/pop-range.png")
        br.close()

    print("\nRESULT:", "the population filter is a range" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
