"""P1.5 — a decision has to be shareable.

Loads `/map?m=gap&r=120&t=6000&site=3`, asserts the page actually adopts that state, then
changes the mode through the UI and asserts the URL follows. A link that opens someone
else's screen mid-decision is the whole point.

    python tools/test_url_state.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "http://localhost:3737"
FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹٬", "0123456789,")


def main() -> int:
    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat=31.33&lon=48.60&k=9&m=gap&r=120&t=6000&site=3",
                wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        body = pg.inner_text("body").translate(FA)
        check("mode adopted", "شکاف ظرفیت" in body and "6,000" in body,
              "gap mode + target 6000")
        check("radius adopted", "120" in body, "radius 120 km")
        check("candidate opened from the link",
              pg.locator('div.absolute.bottom-2.right-2').count() == 1,
              "site popup open")
        check("badge marked from the link",
              pg.locator('g[data-rank="3"][data-selected="1"]').count() == 1)

        url0 = pg.url
        check("url kept the parameters", "m=gap" in url0 and "site=3" in url0, url0[-60:])

        pg.get_by_role("button", name="تراکم داروخانه").click()
        pg.wait_for_timeout(700)
        check("changing mode updates the url", "m=dens" in pg.url, pg.url[-60:])
        br.close()

    print("\nRESULT:", "the URL carries the decision" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
