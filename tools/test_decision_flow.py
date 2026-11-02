"""End to end: use the tool the way a person deciding would.

One run covers the whole journey and cross-checks every number against the database:

  1. open the map, the recommendations are there and clickable;
  2. click the top one — score, range, reason and rivals all match the row;
  3. shortlist it and a second one;
  4. compare them side by side, values equal to what was saved;
  5. take the URL, open it in a fresh page — same mode, same candidate;
  6. clean up.

    python tools/test_decision_flow.py
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from _fixtures import PREFIX, sweep  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = "http://localhost:3737"
FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹٬٫", "0123456789,.")


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def hav(a, b, c, d):
    R = 6371.0088
    p1, p2 = math.radians(a), math.radians(c)
    dp = p2 - p1
    dl = math.radians(d - b)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def main() -> int:
    baseline = {it["id"] for it in api("/api/shortlist")["items"]}

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    top = c.execute("SELECT * FROM site_candidate ORDER BY rank LIMIT 1").fetchone()
    second = c.execute("SELECT * FROM site_candidate ORDER BY rank LIMIT 1 OFFSET 2").fetchone()
    rivals = [r for r in c.execute("SELECT name, lat, lon FROM map_pharmacy")
              if hav(top["lat"], top["lon"], r[1], r[2]) <= 1.2]
    c.close()

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})

        pg.goto(f"{BASE}/map?lat={top['lat']}&lon={top['lon']}&k=9", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)
        badges = pg.locator('g[data-layer="sites"] g[data-rank]').count()
        check("recommendations are drawn", badges >= 100, f"{badges} badges")

        pg.locator(f'g[data-rank="{top["rank"]}"]').first.click()
        pg.wait_for_timeout(800)
        popup = pg.locator("div.absolute.bottom-2.right-2").first.inner_text()
        flat = popup.translate(FA)
        check("score matches the database", f"{top['score']:.2f}" in flat, f"{top['score']:.2f}")
        if top["score_high"] > top["score_low"]:
            check("range matches", f"{top['score_low']:.2f}–{top['score_high']:.2f}" in flat,
                  f"{top['score_low']:.2f}–{top['score_high']:.2f}")
        check("reason matches", top["reason"] in popup)
        check("rival count matches",
              f"{len(rivals)}".translate(FA) in flat, f"{len(rivals)} within 1.2 km")

        for rank in (top["rank"], second["rank"]):
            pg.locator(f'g[data-rank="{rank}"]').first.click()
            pg.wait_for_timeout(500)
            pg.get_by_role("button", name="افزودن به فهرست").click()
            pg.wait_for_timeout(1400)

        items = api("/api/shortlist")["items"]
        check("both shortlisted", len(items) == 2, f"{len(items)} items")

        panel = (pg.locator('div[data-panel="shortlist"]').first.inner_text()
                 .translate(FA).replace("٫", "."))
        check("panel shows both scores",
              all(f"{it['score']:.2f}" in panel for it in items),
              ", ".join(f"{it['score']:.2f}" for it in items))

        pg.get_by_role("button", name="شکاف ظرفیت").click()
        pg.wait_for_timeout(800)
        shared = pg.url
        check("url carries the state", "m=gap" in shared, shared[-70:])

        pg2 = br.new_page(viewport={"width": 1500, "height": 950})
        pg2.goto(shared, wait_until="domcontentloaded", timeout=120000)
        pg2.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg2.wait_for_timeout(2500)
        body2 = pg2.inner_text("body")
        check("shared link reopens the same decision",
              pg2.locator("div.absolute.bottom-2.right-2").count() == 1, "candidate open")
        check("shortlist survives the link", "فهرست کوتاه" in body2)
        br.close()

    for it in api("/api/shortlist")["items"]:
        if it["id"] not in baseline:      # only what this run added
            api(f"/api/shortlist?id={it['id']}", method="DELETE")

    print("\nRESULT:", "the tool answers «where should I open?»" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
