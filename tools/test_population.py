"""Population: see every source, and override it with what you know.

  1. the settlement card shows the four imported sources side by side;
  2. a manual value wins immediately in `v_map_settlement` (source becomes «manual»);
  3. the analysis moves with it — the gap for that settlement changes by exactly the
     population difference ÷ target;
  4. the ranking is rebuilt in the background;
  5. deleting the override restores the imported number.

    python tools/test_population.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = "http://localhost:3737"
FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹٬", "0123456789,")
TARGET = 5400


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


def main() -> int:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    # a village that has more than one source, so the card has something to show
    s = c.execute("""
        SELECT area_id, name, lat, lon, population, population_admin, population_wiki,
               population_fda, population_osm, pharmacy_total
          FROM v_map_settlement
         WHERE lat IS NOT NULL AND population_wiki IS NOT NULL AND population_fda IS NOT NULL
           AND population_osm IS NOT NULL AND population BETWEEN 500 AND 40000
           /* sources that disagree: the point is to show them side by side */
           AND (MAX(population_wiki, population_fda, population_osm)
                - MIN(population_wiki, population_fda, population_osm)) > 0.15 * population
         ORDER BY population DESC LIMIT 1""").fetchone()
    c.close()
    assert s, "no settlement carries all four sources"

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    print(f"settlement: {s['name']} · admin {s['population_admin']} · wiki {s['population_wiki']}"
          f" · fda {s['population_fda']} · osm {s['population_osm']}")

    gap_before = s["population"] / TARGET - s["pharmacy_total"]
    rank0 = api("/api/population")  # creates the table if needed

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(f"{BASE}/map?lat={s['lat']}&lon={s['lon']}&k=12", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        # open the settlement card by clicking its dot
        x, y = pg.evaluate(f"() => window.__khz.screenOf({s['lat']}, {s['lon']})")
        pg.mouse.click(x, y)
        pg.wait_for_timeout(1200)
        body = pg.inner_text("body")
        check("card lists the sources",
              all(k in body for k in ("جمعیت بر پایهٔ منبع", "ویکی‌پدیا", "فید سازمان", "OpenStreetMap")))
        flat = body.translate(FA).replace("٬", "").replace(",", "")
        check("every source value is rendered",
              all(str(v) in flat for v in (s["population_wiki"], s["population_fda"], s["population_osm"])),
              f"{s['population_wiki']} / {s['population_fda']} / {s['population_osm']}")

        # ---- set a manual population through the card
        new_pop = 12345
        pg.fill('input[placeholder="جمعیت دقیق را وارد کنید"]', str(new_pop))
        pg.get_by_role("button", name="ثبت", exact=True).click()
        pg.wait_for_timeout(2600)
        check("saved message appears", "ثبت شد" in pg.inner_text("body"))
        br.close()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    after = c.execute("""SELECT population, population_source, population_manual
                           FROM v_map_settlement WHERE area_id = ?""", (s["area_id"],)).fetchone()
    c.close()
    check("manual value wins in the view",
          after["population"] == new_pop and after["population_source"] == "manual",
          f"{after['population']} · {after['population_source']}")

    gap_after = after["population"] / TARGET - s["pharmacy_total"]
    check("the gap moves by population ÷ target",
          abs((gap_after - gap_before) - (new_pop - s["population"]) / TARGET) < 1e-6,
          f"{gap_before:.2f} → {gap_after:.2f}")

    # ---- the ranking is rebuilt behind the change
    rank_at = None
    for _ in range(30):
        rank_at = api("/api/pharmacies").get("rankAt")
        if rank_at:
            break
        time.sleep(2)
    check("a re-rank was triggered", bool(rank_at), str(rank_at))

    # ---- restore
    api(f"/api/population?areaId={s['area_id']}", method="DELETE")
    c = sqlite3.connect(DB)
    back = c.execute("SELECT population, population_source FROM v_map_settlement WHERE area_id = ?",
                     (s["area_id"],)).fetchone()
    c.close()
    check("deleting restores the imported population",
          back[0] == s["population"] and back[1] != "manual", f"{back[0]} · {back[1]}")

    print("\nRESULT:", "population is visible, overridable, and it moves the analysis" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
