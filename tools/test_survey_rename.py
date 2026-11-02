"""Rename a surveyed area without losing the polygon.

Reported: «برای اصلاح نام باید محدوده را حذف و دوباره بکشم». The API had a PATCH nobody
called. Now the ✎ button (or a double click on the name) opens an inline field; Enter saves,
Escape cancels, and the shape, the area and the date are untouched.

    python tools/test_survey_rename.py
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
    sweep(api, "/api/surveys")

    poly = [[31.30, 48.66], [31.31, 48.66], [31.31, 48.67], [31.30, 48.67]]
    made = api("/api/surveys", {"name": f"{PREFIX} محدوده", "points": poly, "note": "probe"}, "POST")
    sid = made["id"]
    area_before = made["areaKm2"]

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat=31.305&lon=48.665&k=14", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2200)

        panel = pg.locator('div[data-panel="survey"]')
        check("the area is listed", f"{PREFIX} محدوده" in panel.inner_text())

        # ---- the ✎ button opens the field with the current name
        panel.locator(f'[data-editbtn="survey-{sid}"]').click()
        field = panel.locator(f'[data-edit="survey-{sid}"]')
        check("✎ opens an inline field", field.count() == 1)
        check("the field starts from the current name",
              field.input_value() == f"{PREFIX} محدوده", field.input_value())

        field.fill("کوی منتظری — شمال خیابان")
        field.press("Enter")
        pg.wait_for_timeout(2200)

        c = sqlite3.connect(DB)
        c.row_factory = sqlite3.Row
        row = c.execute("SELECT name, points, area_km2, created_at FROM survey_area WHERE id = ?",
                        (sid,)).fetchone()
        c.close()
        check("the new name is in the database", row["name"] == "کوی منتظری — شمال خیابان",
              row["name"])
        check("the polygon is untouched", json.loads(row["points"]) == poly)
        check("the area is untouched", abs((row["area_km2"] or 0) - area_before) < 0.01,
              f"{row['area_km2']} km²")
        check("the list shows the new name",
              "کوی منتظری — شمال خیابان" in panel.inner_text())

        # ---- Escape cancels
        panel.locator(f'[data-editbtn="survey-{sid}"]').click()
        field = panel.locator(f'[data-edit="survey-{sid}"]')
        field.fill("این نباید ذخیره شود")
        field.press("Escape")
        pg.wait_for_timeout(1200)
        c = sqlite3.connect(DB)
        name2 = c.execute("SELECT name FROM survey_area WHERE id = ?", (sid,)).fetchone()[0]
        c.close()
        check("Escape leaves the name alone", name2 == "کوی منتظری — شمال خیابان", name2)

        # ---- too short a name is refused, not written
        resp = urllib.request.Request(
            BASE + "/api/surveys",
            data=json.dumps({"id": sid, "name": "x"}).encode(),
            headers={"Content-Type": "application/json"},
            method="PATCH",
        )
        try:
            urllib.request.urlopen(resp, timeout=30)
            status = 200
        except urllib.error.HTTPError as e:
            status = e.code
        check("a one-letter name is rejected", status == 400, str(status))
        br.close()

    api(f"/api/surveys?id={sid}", method="DELETE")
    print("\nRESULT:", "areas can be renamed in place" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
