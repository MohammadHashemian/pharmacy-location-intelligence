"""P1.6 — a score with a range, because the inputs are estimates.

A point score on an estimated population and an incomplete pharmacy register invites a
confidence it does not have. `rank_sites.py` now also scores two ordinary scenarios — one
more competitor opens, and the population estimate is off by a fifth — and the popup shows
the span.

    python tools/test_score_range.py
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
    rows = c.execute("SELECT rank, score, score_low, score_high, lat, lon FROM site_candidate"
                     " ORDER BY rank").fetchall()
    c.close()

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    check("every row has a range", all(r[2] is not None and r[3] is not None for r in rows),
          f"{len(rows)} rows")
    check("score sits inside its own range",
          all(r[2] - 1e-6 <= r[1] <= r[3] + 1e-6 for r in rows))
    spread = max(r[3] - r[2] for r in rows)
    check("the range is not decorative", spread > 0.1, f"widest {spread:.2f}")

    wide = max(rows, key=lambda r: r[3] - r[2])
    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat={wide[4]}&lon={wide[5]}&k=9&site={wide[0]}",
                wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)
        txt = pg.locator("div.absolute.bottom-2.right-2").first.inner_text()
        want = f"{wide[2]:.2f}–{wide[3]:.2f}"
        check("popup shows the span", want in txt, want)
        br.close()

    print("\nRESULT:", "the score states its uncertainty" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
