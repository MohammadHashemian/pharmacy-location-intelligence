"""«I already surveyed this place» — stored per user, survives a refresh.

Covers both kinds of place: a settlement (area_id) and a neighbourhood (OSM id).

  1. the settlement card toggles the mark and the row lands in `place_check` with the user id;
  2. after a full page reload the mark is still there (tick on the map, chip in the header);
  3. a neighbourhood marked through the API shows a ✓ in its label;
  4. a second user's marks are invisible to the owner;
  5. unticking removes the row.

    python tools/test_checks.py
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


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main() -> int:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    s = c.execute("""SELECT area_id, name, lat, lon FROM v_map_settlement
                      WHERE name = 'چمران' AND lat IS NOT NULL LIMIT 1""").fetchone()
    hood = c.execute("""SELECT osm_id, name FROM map_neighbourhood
                         WHERE name LIKE '%نواصر%' LIMIT 1""").fetchone()
    c.execute("DELETE FROM place_check")
    c.commit()
    c.close()
    assert s and hood, "fixtures missing"

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        url = f"{BASE}/map?lat={s['lat']}&lon={s['lon']}&k=12&settle={s['area_id']}"
        pg.goto(url, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        btn = pg.get_by_role("button", name="علامت‌گذاری به‌عنوان بررسی‌شده")
        check("card offers the mark", btn.count() == 1)
        btn.click()
        pg.wait_for_timeout(2200)

        c = sqlite3.connect(DB)
        c.row_factory = sqlite3.Row
        row = c.execute("SELECT user_id, kind, ref FROM place_check").fetchone()
        c.close()
        check("stored in the database with the user id",
              bool(row) and row["user_id"] == 1 and row["ref"] == str(s["area_id"]),
              f"{row['kind']}:{row['ref']} · user {row['user_id']}" if row else "no row")
        check("tick appears on the settlement",
              pg.locator(f'g[data-settlement="{s["area_id"]}"][data-checked="1"]').count() == 1)

        # ---- survives a full reload
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2200)
        check("still marked after refresh",
              pg.locator(f'g[data-settlement="{s["area_id"]}"][data-checked="1"]').count() == 1)
        check("header counts it", "بررسی‌شده" in pg.inner_text("body"))
        check("button now offers to undo",
              pg.get_by_role("button", name="بررسی‌شده — برداشتن علامت").count() == 1)

        # ---- a neighbourhood, marked through the API, shows a tick in its label
        api("/api/checks", {"kind": "hood", "ref": str(hood["osm_id"])}, "POST")
        pg.goto(f"{BASE}/map?lat=31.2240&lon=48.6570&k=17", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)
        labels = pg.evaluate("""() => {
          const g = document.querySelector('g[data-layer="hoods"]');
          return g ? [...g.querySelectorAll('text')].map((t) => t.textContent || '') : [];
        }""")
        check("neighbourhood label carries a tick",
              any(t.startswith("✓") and "نواصر" in t for t in labels),
              next((t for t in labels if "نواصر" in t), "not drawn"))

        # ---- per-user scoping
        c = sqlite3.connect(DB)
        uid2 = c.execute("SELECT COALESCE(MAX(id),0)+1 FROM app_user").fetchone()[0]
        c.execute("INSERT INTO app_user (id, username, display_name, role) VALUES (?,?,?,?)",
                  (uid2, f"probe{uid2}", "کاربر آزمون", "member"))
        c.execute("INSERT INTO place_check (user_id, kind, ref) VALUES (?,?,?)",
                  (uid2, "settlement", "999999"))
        c.commit()
        c.close()
        mine = api("/api/checks")["items"]
        check("another user's marks are invisible",
              all(i["ref"] != "999999" for i in mine), f"{len(mine)} marks for owner")

        # ---- untick through the UI
        pg.goto(url, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2200)
        pg.get_by_role("button", name="بررسی‌شده — برداشتن علامت").click()
        pg.wait_for_timeout(2200)
        c = sqlite3.connect(DB)
        left = c.execute("SELECT COUNT(*) FROM place_check WHERE user_id = 1 AND kind = 'settlement'").fetchone()[0]
        c.execute("DELETE FROM place_check WHERE user_id = ?", (uid2,))
        c.execute("DELETE FROM app_user WHERE id = ?", (uid2,))
        c.execute("DELETE FROM place_check")
        c.commit()
        c.close()
        check("unticking removes the row", left == 0, f"{left} settlement marks left")
        br.close()

    print("\nRESULT:", "survey marks are per-user and persistent" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
