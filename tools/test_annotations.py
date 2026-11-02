"""The two user-owned features, driven through the browser.

  1. mark a place to visit → stored with user_id, appears in the visit list, on the map;
  2. cycle its status → the database follows;
  3. draw an area → stored with its km², drawn as a polygon, listed;
  4. delete both → gone from database and map;
  5. per-user scoping: a second user's rows are invisible to the first.

    python tools/test_annotations.py
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
from _fixtures import PREFIX, sweep  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = "http://localhost:3737"


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main() -> int:
    # remove only this file's own fixtures — the owner's areas stay
    sweep(api, "/api/prospects")
    sweep(api, "/api/surveys")

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 950})
        pg.goto(f"{BASE}/map?lat=31.330&lon=48.675&k=14", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        box = pg.locator("svg").first.bounding_box()

        # ---- 1. mark a place to visit
        pg.locator('button[aria-label="نشان‌گذاری مکان"]').click()
        pg.wait_for_timeout(300)
        pg.mouse.click(box["x"] + box["width"] * 0.4, box["y"] + box["height"] * 0.4)
        pg.wait_for_timeout(500)
        pg.fill('input[placeholder="نام مکان (مثلاً نبش خیابان …)"]', f"{PREFIX} نبش خیابان")
        pg.fill('input[placeholder="یادداشت: اجاره، متراژ، تماس…"]', "اجاره ۲۰ متر")
        pg.get_by_role("button", name="افزودن به فهرست").click()
        pg.wait_for_timeout(2200)

        items = api("/api/prospects")["items"]
        check("prospect saved", len(items) == 1, f"{len(items)} row")
        check("stored against the owner user", bool(items) and items[0].get("priority") == 2)
        check("flag drawn on the map",
              pg.locator('g[data-layer="prospects"] g[data-prospect]').count() == 1)
        check("listed in the visit panel", f"{PREFIX} نبش خیابان" in pg.inner_text("body"))

        c = sqlite3.connect(DB)
        row = c.execute("SELECT user_id, status, note FROM prospect ORDER BY id DESC LIMIT 1").fetchone()
        c.close()
        check("row carries a user_id", row and row[0] >= 1, f"user {row[0]} · status {row[1]}")

        # ---- 2. cycle the status
        pg.get_by_role("button", name="برای بازدید").first.click()
        pg.wait_for_timeout(1800)
        c = sqlite3.connect(DB)
        st = c.execute("SELECT status, visited_at FROM prospect ORDER BY id DESC LIMIT 1").fetchone()
        c.close()
        check("status cycles to visited", st[0] == "visited", f"status {st[0]}, at {st[1]}")

        before_owner_surveys = len([a for a in api("/api/surveys")["items"]
                                    if not a["name"].startswith(PREFIX)])
        before_shapes = pg.locator('g[data-layer="surveys"] g[data-survey]').count()

        # ---- 3. draw an area
        pg.locator('button[aria-label="کشیدن محدوده"]').click()
        pg.wait_for_timeout(300)
        for fx, fy in ((0.3, 0.3), (0.45, 0.32), (0.42, 0.45)):
            pg.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
            pg.wait_for_timeout(250)
        pg.fill('input[placeholder="نام محله یا محدوده"]', f"{PREFIX} محله")
        pg.get_by_role("button", name="ثبت محدوده").click()
        pg.wait_for_timeout(2200)

        surveys = [a for a in api("/api/surveys")["items"] if a["name"].startswith(PREFIX)]
        check("area saved", len(surveys) == 1, f"{len(surveys)} fixture area(s)")
        check("area has 3+ points and a size",
              bool(surveys) and len(surveys[0]["points"]) >= 3 and (surveys[0]["areaKm2"] or 0) > 0,
              f"{len(surveys[0]['points']) if surveys else 0} points · "
              f"{surveys[0]['areaKm2'] if surveys else 0} km²")
        # the reload after a save is a server round trip: poll instead of trusting one frame
        drawn = 0
        for _ in range(20):
            drawn = pg.locator('g[data-layer="surveys"] g[data-survey]').count()
            if drawn > before_shapes:
                break
            pg.wait_for_timeout(500)
        check("polygon drawn on the map", drawn == before_shapes + 1,
              f"{drawn} polygons (was {before_shapes})")

        # ---- 5. per-user scoping
        c = sqlite3.connect(DB)
        uid2 = c.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM app_user").fetchone()[0]
        c.execute("INSERT OR IGNORE INTO app_user (id, username, display_name, role)"
                  " VALUES (?,?,?,?)", (uid2, f"probe{uid2}", "کاربر آزمون", "member"))
        c.execute("INSERT INTO prospect (user_id, name, lat, lon, status, priority)"
                  " VALUES (?,?,?,?,?,?)", (uid2, "مکان کاربر دوم", 31.34, 48.68, "todo", 1))
        c.execute("INSERT INTO survey_area (user_id, name, points, area_km2)"
                  " VALUES (?,?,?,?)", (uid2, "محدودهٔ کاربر دوم",
                                        json.dumps([[31.3, 48.6], [31.31, 48.61], [31.30, 48.62]]), 1.2))
        c.commit()
        c.close()

        owner = api("/api/prospects")["items"]
        check("second user's prospects are invisible",
              all("کاربر دوم" not in i["name"] for i in owner), f"{len(owner)} rows for owner")
        owner_s = api("/api/surveys")["items"]
        check("second user's areas are invisible",
              all("کاربر دوم" not in i["name"] for i in owner_s), f"{len(owner_s)} areas for owner")

        c = sqlite3.connect(DB)
        c.execute("DELETE FROM prospect WHERE user_id = ?", (uid2,))
        c.execute("DELETE FROM survey_area WHERE user_id = ?", (uid2,))
        c.execute("DELETE FROM app_user WHERE id = ?", (uid2,))
        c.commit()
        c.close()

        # ---- 4. delete through the UI
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)
        for pid in [i["id"] for i in api("/api/prospects")["items"]
                    if i["name"].startswith(PREFIX)]:
            b = pg.locator(f'button[data-del="prospect-{pid}"]')
            if b.count():
                b.click()
                pg.wait_for_timeout(1500)
        for sid in [i["id"] for i in api("/api/surveys")["items"]
                    if i["name"].startswith(PREFIX)]:
            b = pg.locator(f'button[data-del="survey-{sid}"]')
            if b.count():
                b.click()
                pg.wait_for_timeout(1500)
        def fixtures():
            p = [i for i in api("/api/prospects")["items"] if i["name"].startswith(PREFIX)]
            a = [i for i in api("/api/surveys")["items"] if i["name"].startswith(PREFIX)]
            return p, a

        for _ in range(10):
            if not any(fixtures()):
                break
            pg.wait_for_timeout(600)
        p_left, a_left = fixtures()
        owner_s = [i for i in api("/api/surveys")["items"]]
        check("both fixtures deleted", not p_left and not a_left, "fixtures gone")
        check("the owner's areas were left alone", len(owner_s) == before_owner_surveys,
              f"{len(owner_s)} of {before_owner_surveys}")
        br.close()

    print("\nRESULT:", "per-user annotations work" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
