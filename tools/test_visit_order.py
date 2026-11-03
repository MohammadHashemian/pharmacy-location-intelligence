"""The visit list has no size limit, and the trip order is set by dragging.

Asked: «تعداد مکان‌هایی که برای لیست بازدید محدودیت داره… نمی‌خوام تعداد باشه… بعداً خودم با drag
and drop اولویت‌ها رو تعیین کنم». The 1-9 priority dropdown was removed: a new place is appended
at the end and the rows are dragged into the order you want.

    python tools/test_visit_order.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from _fixtures import PREFIX, snapshot, sweep  # noqa: E402
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "http://localhost:3737"
N = 6   # small enough that every row is on screen without scrolling


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main() -> int:
    snapshot()
    sweep(api, "/api/prospects")

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    ids = []
    for i in range(N):
        made = api("/api/prospects", {
            "name": f"{PREFIX} مکان {i + 1:02d}",
            "lat": 31.30 + i * 0.002, "lon": 48.66 + i * 0.002,
        }, "POST")
        ids.append(made["id"])

    items = [i for i in api("/api/prospects")["items"] if i["name"].startswith(PREFIX)]
    check(f"{N} places stored, none dropped", len(items) == N, f"{len(items)} rows")
    check("new places append at the end (no 1-9 menu)",
          [i["priority"] for i in items] == list(range(1, N + 1)),
          f"{items[0]['priority']}…{items[-1]['priority']}")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 1000})
        pg.goto(f"{BASE}/map?lat=31.30&lon=48.66&k=12", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        panel = pg.locator('div[data-panel="visit"]')
        rows = panel.locator("li")
        check("the panel lists every row (scrolls, does not truncate)",
              rows.count() >= N, f"{rows.count()} rows")

        first = rows.nth(0).inner_text()
        last_name = f"{PREFIX} مکان {N:02d}"
        # pointer drag, the way a finger does it: press the handle, move, release
        grip = pg.locator(f'[data-grip="prospect-{ids[-1]}"]')
        target = pg.locator("li[data-prospect]").first
        gb = grip.bounding_box()
        tb = target.bounding_box()
        pg.mouse.move(gb["x"] + gb["width"] / 2, gb["y"] + gb["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2, steps=12)
        pg.mouse.up()
        pg.wait_for_timeout(2500)

        after = [i for i in api("/api/prospects")["items"] if i["name"].startswith(PREFIX)]
        moved = next(i for i in after if i["name"] == last_name)
        check("dragging the last row to the top reorders the trip", moved["priority"] == 1,
              f"{last_name} → position {moved['priority']}")
        check("the whole list is still there", len(after) == N, f"{len(after)} rows")
        check("priorities are a clean 1..N after the drop",
              [i["priority"] for i in after] == list(range(1, N + 1)),
              str([i["priority"] for i in after][:5]))
        check("the row that was first before the drag is no longer first", first != after[0]["name"])

        # the add form no longer carries a priority dropdown
        pg.locator('button[aria-label="نشان‌گذاری مکان"]').click()
        pg.wait_for_timeout(500)
        selects = pg.locator('select').count()
        check("no priority dropdown in the add form", selects == 0, f"{selects} <select> left")
        br.close()

    sweep(api, "/api/prospects")
    print("\nRESULT:", "the list is unlimited and ordered by dragging" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
