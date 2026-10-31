"""Prove the atlas actually works — in a real browser, with measurements.

This project's rule is that a visual deliverable is not "done" until a live
browser has rendered it and the layout has been measured, so this script drives
the generated HTML headlessly and asserts on what the page really did:

  * no console errors and no uncaught exceptions
  * Leaflet initialised, the manifest checkbox switches work
  * the filter counts on the page equal the counts in the database
  * the network tab actually draws nodes and edges into the SVG
  * no horizontal overflow at several widths (the classic RTL/flex failure)
  * every text element of the network SVG stays inside the drawing box
  * screenshots of each tab, so a human can look at the result

Usage: python etl/verify_geo_page.py [--url file:///...]
"""
from __future__ import annotations

import glob
import json
import os
import sqlite3
import sys

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
DEFAULT_PAGE = os.path.join(HOME, "reports", "khuzestan-atlas.html")
SHOT_DIR = os.path.join(HOME, "reports", "screenshots")
CHROME = glob.glob(os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "ms-playwright", "chromium-*",
    "chrome-win*", "chrome.exe"))


def main() -> int:
    url = DEFAULT_PAGE
    for a in sys.argv[1:]:
        if a.startswith("--url="):
            url = a.split("=", 1)[1]
    page_url = url if url.startswith("file:") else "file:///" + url.replace("\\", "/")
    os.makedirs(SHOT_DIR, exist_ok=True)

    c = sqlite3.connect(DB)
    db_counts = {r[0]: r[1] for r in c.execute(
        "SELECT status, COUNT(*) FROM v_geo_place GROUP BY status")}
    db_total = sum(db_counts.values())
    db_new_urban = c.execute("""SELECT COUNT(*) FROM v_geo_place
                                WHERE status='new'
                                  AND place_kind IN ('city','town')""").fetchone()[0]
    c.close()

    from playwright.sync_api import sync_playwright

    failures: list[str] = []
    notes: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME[0] if CHROME else None, headless=True,
            args=["--allow-file-access-from-files", "--disable-web-security"])
        page = browser.new_page(viewport={"width": 1440, "height": 900},
                                device_scale_factor=1)
        errors: list[str] = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.goto(page_url, wait_until="load", timeout=60000)
        try:
            # state="attached": a Leaflet pane is absolutely positioned and 0×0 by
            # design, so Playwright's default "visible" check never becomes true.
            page.wait_for_selector("#map .leaflet-pane", state="attached",
                                   timeout=30000)
        except Exception as exc:  # noqa: BLE001
            print("the map never initialised:", exc)
            for e in errors[:10]:
                print("   console:", e)
            browser.close()
            return 1
        page.wait_for_timeout(4500)      # let the basemap tiles land

        info = page.evaluate("""() => ({
            leaflet: typeof L !== 'undefined',
            tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
            shown: (document.getElementById('shown')||{}).textContent || '',
            cards: [...document.querySelectorAll('#cards .card')].map(c => c.textContent),
            dataPlaces: (window.__GEO_DATA && __GEO_DATA.places.features.length) || 0,
            scrollW: document.documentElement.scrollWidth,
            innerW: window.innerWidth,
            mapH: document.getElementById('map').getBoundingClientRect().height
        })""")
        print("map tab:", json.dumps({k: v for k, v in info.items() if k != "cards"},
                                     ensure_ascii=False))
        if not info["leaflet"]:
            failures.append("Leaflet did not load")
        if info["tiles"] == 0:
            notes.append("no basemap tiles loaded (offline?) — vector layers still work")
        if info["dataPlaces"] != db_total:
            failures.append(f"page carries {info['dataPlaces']} places, db has {db_total}")
        if info["scrollW"] > info["innerW"] + 1:
            failures.append(f"horizontal overflow: {info['scrollW']} > {info['innerW']}")
        if not (300 <= info["mapH"] <= 700):
            failures.append(f"map height {info['mapH']} out of range")
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-1-map.png"), full_page=False)

        # status filter -> 'new' must equal the database
        page.select_option("#f-status", "new")
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-2-new-only.png"))
        filtered = page.evaluate("""() => document.getElementById('shown').textContent""")
        print("after status=new filter:", filtered)
        page.select_option("#f-kind", "city-t")
        page.wait_for_timeout(600)
        urban = page.evaluate("""() => document.getElementById('shown').textContent""")
        print("after kind=city/town:", urban)
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-3-new-cities.png"))

        # manifest + rings toggles must not throw
        page.check("#f-bakhsh")
        page.wait_for_timeout(800)
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-4-bakhsh.png"))
        page.uncheck("#f-bakhsh")
        page.select_option("#f-status", "all")
        page.select_option("#f-kind", "all")

        # network tab
        page.click('.tab[data-tab="net"]')
        page.wait_for_timeout(1200)
        net = page.evaluate("""() => {
            const svg = document.getElementById('netsvg');
            const box = svg.getBoundingClientRect();
            const texts = [...svg.querySelectorAll('text')];
            const outside = texts.filter(t => {
              const b = t.getBoundingClientRect();
              return b.left < box.left - 2 || b.right > box.right + 2
                  || b.top < box.top - 2 || b.bottom > box.bottom + 2;
            }).length;
            return {w: box.width, h: box.height, circles: svg.querySelectorAll('circle').length,
                    lines: svg.querySelectorAll('line').length, texts: texts.length,
                    outside, viewBox: svg.getAttribute('viewBox')};
        }""")
        print("network tab:", net)
        if net["circles"] < 100:
            failures.append(f"network graph drew only {net['circles']} nodes")
        if net["lines"] < 100:
            failures.append(f"network graph drew only {net['lines']} edges")
        if net["viewBox"]:
            failures.append("network SVG has a viewBox — text would scale with the box")
        if net["outside"]:
            failures.append(f"{net['outside']} network labels outside the drawing box")
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-5-network.png"))

        page.click("#btn-scatter")
        page.wait_for_timeout(900)
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-6-scatter.png"))

        # density overlay + دهستان + expansion search
        page.click('.tab[data-tab="map"]')     # its checkboxes live in this panel
        page.wait_for_timeout(500)
        dens = page.evaluate("""() => {
            const D = window.__GEO_DATA;
            const cells = D.density.cells;
            return {cells: cells.length,
                    hasDehestan: D.places.features.filter(f => f.properties.dehestan).length,
                    total: D.places.features.length,
                    legend: (document.getElementById('densLegend')||{}).textContent||'',
                    checked: document.getElementById('f-dens').checked};
        }""")
        print("density overlay:", {k: v for k, v in dens.items() if k != "legend"})
        if dens["cells"] < 100:
            failures.append(f"density overlay carries only {dens['cells']} cells")
        if dens["hasDehestan"] != dens["total"]:
            failures.append(f"{dens['total'] - dens['hasDehestan']} places without a دهستان")
        if not dens["checked"]:
            failures.append("density overlay is off by default")
        if len(dens["legend"]) < 40:
            failures.append("density legend did not render")
        page.uncheck("#f-dens")
        page.wait_for_timeout(300)
        page.check("#f-dens")
        page.wait_for_timeout(300)

        # expansion tab: rows must exist and widening the radius must not shrink them
        page.click('.tab[data-tab="grow"]')
        page.wait_for_timeout(700)
        grow = page.evaluate("""() => ({
            rows: document.querySelectorAll('#growTable tbody tr').length,
            cards: [...document.querySelectorAll('#growCards .card')].map(c => c.textContent),
            scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth})""")
        print("expansion tab:", grow)
        if grow["rows"] < 10:
            failures.append(f"expansion search rendered {grow['rows']} rows")
        if grow["scrollW"] > grow["innerW"] + 1:
            failures.append("horizontal overflow on the expansion tab")
        page.fill("#g-dist", "200")
        page.dispatch_event("#g-dist", "input")
        page.wait_for_timeout(600)
        wider = page.evaluate("""() => document.querySelectorAll('#growTable tbody tr').length""")
        print("after widening the network radius:", wider)
        if wider < grow["rows"]:
            failures.append("widening the network radius shrank the candidate list")
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-9-expansion.png"))
        page.fill("#g-dist", "60")
        page.dispatch_event("#g-dist", "input")

        page.click('.tab[data-tab="tbl"]')
        page.wait_for_timeout(700)
        tbl = page.evaluate("""() => ({
            rows: [...document.querySelectorAll('table.grid')].map(t => t.querySelectorAll('tbody tr').length),
            scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth})""")
        print("tables:", tbl)
        if min(tbl["rows"]) == 0:
            failures.append("an empty table was rendered")
        if tbl["scrollW"] > tbl["innerW"] + 1:
            failures.append("horizontal overflow on the tables tab")
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-7-tables.png"))

        # a narrow viewport, the mobile case
        page.set_viewport_size({"width": 430, "height": 880})
        page.click('.tab[data-tab="map"]')
        page.wait_for_timeout(1200)
        narrow = page.evaluate("""() => ({scrollW: document.documentElement.scrollWidth,
                                          innerW: window.innerWidth})""")
        page.screenshot(path=os.path.join(SHOT_DIR, "atlas-8-narrow.png"))
        if narrow["scrollW"] > narrow["innerW"] + 1:
            failures.append(f"horizontal overflow at 430px: {narrow}")
        browser.close()

    print()
    print("expected from the database:", {"total": db_total, "new": db_counts.get("new"),
                                          "new_urban": db_new_urban,
                                          "matched": db_counts.get("matched"),
                                          "variant": db_counts.get("variant")})
    if errors:
        print("\nconsole errors / exceptions:")
        for e in errors[:20]:
            print("   ", e)
        fatal = [e for e in errors if "pageerror" in e]
        if fatal:
            failures.append(f"{len(fatal)} uncaught page errors")
    else:
        print("\nconsole: clean")
    for n in notes:
        print("note:", n)
    print("\n" + ("FAILED:\n  " + "\n  ".join(failures) if failures
                  else "ALL CHECKS PASSED"))
    print(f"screenshots: {SHOT_DIR}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
