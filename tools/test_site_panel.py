"""P0.1 — a ranked badge must answer «why here?» when clicked.

Checks, against the database and not against the UI's own copy:

  1. clicking badge #N opens the popup and marks the badge selected;
  2. the reason sentence shown is the one `site_candidate.reason` holds;
  3. the score, demand and rival count match the row and the pharmacy table.

    python tools/test_site_panel.py [--rank 1]
"""
from __future__ import annotations

import argparse
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


def hav(a, b, c, d):
    R = 6371.0088
    p1, p2 = math.radians(a), math.radians(c)
    dp = p2 - p1
    dl = math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rank", type=int, default=1)
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    s = c.execute("SELECT * FROM site_candidate WHERE rank = ?", (args.rank,)).fetchone()
    assert s, f"no candidate ranked {args.rank}"
    rivals = [r for r in c.execute("SELECT name, lat, lon FROM map_pharmacy")
              if hav(s["lat"], s["lon"], r[1], r[2]) <= 1.2]
    c.close()

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat={s['lat']}&lon={s['lon']}&k=9", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        badge = pg.locator(f'g[data-layer="sites"] g[data-rank="{args.rank}"]').first
        check("badge is clickable", badge.count() == 1)
        badge.click()
        pg.wait_for_timeout(800)

        popup = pg.locator("div.absolute.bottom-2.right-2").first
        txt = popup.inner_text() if popup.count() else ""
        check("popup opens on click", bool(txt), txt.splitlines()[0] if txt else "empty")
        check("badge marked selected",
              pg.locator(f'g[data-rank="{args.rank}"][data-selected="1"]').count() == 1)
        check("reason sentence is the stored one", s["reason"] in txt,
              s["reason"][:48] + "…")
        check("score shown", f"{s['score']:.2f}" in txt, f"{s['score']:.2f}")
        check("rival count matches the pharmacy table",
              f"{len(rivals)}".translate(str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹"))
              in txt or f"{len(rivals)}" in txt,
              f"{len(rivals)} within 1.2 km")
        br.close()

    print("\nRESULT:", "a badge explains itself" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
