"""The visit list has no size limit, and it stays usable when it grows.

Reported: «I only can add 3 places to visit». There was no row limit — priority was clamped
to 1..3, which read as «three places allowed». Now priority runs 1-9, the list holds any
number, and the panel gained status filters, a search box and a click-to-reorder badge.

    python tools/test_visitlist.py
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
N = 14


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main() -> int:
    for it in api("/api/prospects")["items"]:
        api(f"/api/prospects?id={it['id']}", method="DELETE")

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    # ---- 14 places, priorities spanning 1..9, three of them already visited
    for i in range(N):
        api("/api/prospects", {
            "name": f"مکان بازدید {i + 1}",
            "lat": 31.30 + i * 0.001,
            "lon": 48.66 + i * 0.001,
            "note": "اجاره/متراژ",
            "priority": (i % 9) + 1,
            "status": "visited" if i < 3 else "todo",
        }, "POST")

    items = api("/api/prospects")["items"]
    check(f"{N} places stored", len(items) == N, f"{len(items)} rows")
    check("priority accepts 1..9, not just 1..3",
          max(i["priority"] for i in items) >= 7,
          f"max {max(i['priority'] for i in items)}")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(f"{BASE}/map?lat=31.305&lon=48.665&k=12", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        panel = pg.locator('div[data-panel="visit"]').first
        head = panel.inner_text()
        check("panel counts every place", f"{N}" in head.translate(
            str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789")), head.splitlines()[0])

        rows = panel.locator("li").count()
        check("all rows are rendered (scrolls, not truncated)", rows >= N, f"{rows} rows")

        # ---- filter to the visited ones
        panel.locator('button:has-text("بازدید‌شده")').first.click()
        pg.wait_for_timeout(600)
        after = panel.locator("li").count()
        check("status filter narrows the list", after == 3, f"{after} rows for «بازدیدشده»")
        panel.locator('button:has-text("همه")').first.click()
        pg.wait_for_timeout(600)

        # ---- reorder by clicking the priority badge
        first = panel.locator("li").first
        # buttons: [priority, name/focus, status, delete]
        before = first.locator("button").nth(0).inner_text().strip()
        name = first.locator("button").nth(1).inner_text().splitlines()[0].strip()
        first.locator("button").first.click()
        pg.wait_for_timeout(1600)
        c = sqlite3.connect(DB)
        c.row_factory = sqlite3.Row
        row = c.execute("SELECT priority FROM prospect WHERE name LIKE ?", (f"%{name}%",)).fetchone()
        c.close()
        check("clicking the priority badge reorders the trip",
              row is not None and str(row["priority"]) != before.strip(),
              f"{before} → {row['priority'] if row else '?'}")

        # ---- one more, added while the page is open
        api("/api/prospects", {"name": "مکان تازه‌وارد", "lat": 31.31, "lon": 48.67,
                               "priority": 1}, "POST")
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2000)
        check("a new place appears after reload", "مکان تازه‌وارد" in pg.inner_text("body"))
        br.close()

    for it in api("/api/prospects")["items"]:
        api(f"/api/prospects?id={it['id']}", method="DELETE")

    print("\nRESULT:", "the watch list has no cap and stays usable" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
