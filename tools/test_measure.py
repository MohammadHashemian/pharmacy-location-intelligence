"""Area measurement: draw a neighbourhood, get its size, its inhabited footprint and its
estimated population — then compare two of them.

The user's example is «کوی منتظری» against «کوت نواصر»: two polygons, one table. This test
draws both through the browser, checks the numbers against the database and against each
other, and verifies the arithmetic the table claims:

    density == population / residential area      (within rounding)
    residential area <= total area
    population inside a small box < population inside a large box that contains it

    python tools/test_measure.py
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
FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹٬٫", "0123456789,.")


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


def main() -> int:
    sweep(api, "/api/measure")

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    # ---- the arithmetic, straight from the endpoint
    lat, lon = 31.2375, 48.6783          # کوی منتظری
    small = [[lat - 0.004, lon - 0.004], [lat + 0.004, lon - 0.004],
             [lat + 0.004, lon + 0.004], [lat - 0.004, lon + 0.004]]
    big = [[lat - 0.012, lon - 0.012], [lat + 0.012, lon - 0.012],
           [lat + 0.012, lon + 0.012], [lat - 0.012, lon + 0.012]]
    ms = api("/api/measure", {"points": small})["metrics"]
    mb = api("/api/measure", {"points": big})["metrics"]
    print(f"  small: {ms['areaKm2']} km² · {ms['population']} people · {ms['density']}/km²")
    print(f"  big:   {mb['areaKm2']} km² · {mb['population']} people · {mb['density']}/km²")

    check("area is plausible for a neighbourhood", 0.3 < ms["areaKm2"] < 6, f"{ms['areaKm2']} km²")
    check("residential area never exceeds total", ms["residentialKm2"] <= ms["areaKm2"] + 1e-6)
    # density is computed from the unrounded footprint and the test only sees 2 decimals
    want = ms["population"] / max(ms["residentialKm2"], 0.001)
    check("density equals population / residential",
          abs(ms["density"] - want) <= max(5, want * 0.01),
          f"{ms['density']} vs {want:.0f}")
    check("a larger polygon holds more people", mb["population"] > ms["population"],
          f"{mb['population']} > {ms['population']}")

    baseline_measures = len(api("/api/measure")["items"])

    # ---- draw and save two areas through the UI
    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(f"{BASE}/map?lat={lat}&lon={lon}&k=14", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)
        box = pg.locator("svg").first.bounding_box()

        def draw(name: str, corners: list[tuple[float, float]]) -> None:
            pg.locator('button[aria-label="اندازه‌گیری مساحت"]').click()
            pg.wait_for_timeout(300)
            for fx, fy in corners:
                pg.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
                pg.wait_for_timeout(300)
            pg.wait_for_timeout(1200)          # the endpoint runs on a 350 ms debounce
            shown = pg.inner_text("body")
            if "جمعیت تخمینی" not in shown:
                print("    (metrics not rendered yet)")
            pg.fill('input[placeholder="نام محدوده (مثلاً کوی منتظری)"]', name)
            pg.get_by_role("button", name="ذخیره برای مقایسه").click()
            pg.wait_for_timeout(2200)

        draw(f"{PREFIX} کوی منتظری", [(0.38, 0.42), (0.46, 0.42), (0.46, 0.50), (0.38, 0.50)])
        draw(f"{PREFIX} کوت نواصر", [(0.55, 0.55), (0.64, 0.55), (0.64, 0.63), (0.55, 0.63)])

        items = [m for m in api("/api/measure")["items"] if m["name"].startswith(PREFIX)]
        check("two measurements saved", len(items) == 2,
              ", ".join(f"{i['name']} {i['areaKm2']}km²" for i in items))
        check("each carries a population estimate",
              all(i["population"] > 0 for i in items),
              " · ".join(str(i["population"]) for i in items))
        check("polygons drawn on the map",
              pg.locator('g[data-layer="measures"] g[data-measure]').count() >= 2,
              f"{pg.locator('g[data-layer=\"measures\"] g[data-measure]').count()} polygons")

        table = pg.locator('div:has(> div:has-text("مقایسهٔ مساحت‌ها"))').first.inner_text()
        flat = table.translate(FA)
        check("comparison table lists both names",
              all(i["name"] in table for i in items), table.splitlines()[0])
        check("comparison shows the areas",
              all(f"{i['areaKm2']:.2f}" in flat for i in items),
              " · ".join(f"{i['areaKm2']:.2f}" for i in items))

        # delete one through the panel
        first = items[0]
        pg.locator(f'button[data-del="measure-{first["id"]}"]').first.click()
        pg.wait_for_timeout(1800)
        check("delete removes one measurement",
              len([m for m in api("/api/measure")["items"] if m["name"].startswith(PREFIX)]) == 1)
        br.close()

    sweep(api, "/api/measure")

    print("\nRESULT:", "areas can be measured and compared" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
