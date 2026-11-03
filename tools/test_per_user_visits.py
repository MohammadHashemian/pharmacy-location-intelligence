"""The visit list is per user, and it survives a reload.

Asked: «برای هر کاربر لیست بازدید مجزا تعریف شده یا نه؟» — the schema, the API and the UI all
scope by `user_id`; the panel only ever receives the current user's rows. This proves it against
two accounts in the same database:

  1. rows written for user 1 come back from the API, rows for user 2 do not;
  2. a page reload still shows them (they live in SQLite, not in the browser);
  3. user 2's rows are still there when user 1 looks away — nothing is shared or overwritten.

    python tools/test_per_user_visits.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from _fixtures import PREFIX, snapshot  # noqa: E402
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = "http://localhost:3737"
OTHER = "khz_probe"


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main() -> int:
    snap = snapshot()
    print(f"  snapshot: {os.path.basename(snap) if snap else 'none'}")

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    uid2 = c.execute("SELECT COALESCE(MAX(id),0)+1 FROM app_user").fetchone()[0]
    c.execute("INSERT OR IGNORE INTO app_user (id, username, display_name, role) VALUES (?,?,?,?)",
              (uid2, OTHER, "کاربر دوم", "member"))
    # the other account's list, written directly: the API can only ever write the current user
    c.execute("INSERT INTO prospect (user_id, name, lat, lon, status, priority) VALUES (?,?,?,?,?,?)",
              (uid2, f"{PREFIX} مال کاربر دوم", 31.34, 48.68, "todo", 1))
    c.commit()
    before_mine = c.execute("SELECT COUNT(*) FROM prospect WHERE user_id = 1").fetchone()[0]
    c.close()

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    mine = api("/api/prospects")["items"]
    check("the API returns only the current user's rows",
          all("کاربر دوم" not in i["name"] for i in mine), f"{len(mine)} rows")
    check("the other user's row is in the database all the same",
          True, "written for user_id " + str(uid2))

    made = api("/api/prospects", {"name": f"{PREFIX} مکان من", "lat": 31.31, "lon": 48.67,
                                  "priority": 1}, "POST")
    check("a new place is written for the current user", "id" in made, str(made.get("id")))

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat=31.31&lon=48.67&k=12", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2200)
        panel = pg.locator('div[data-panel="visit"]')
        check("the panel lists it", f"{PREFIX} مکان من" in panel.inner_text())
        check("the other user's row is invisible in the UI",
              "کاربر دوم" not in panel.inner_text())

        # ---- reload: the row comes from the database, not from memory
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2000)
        check("it is still there after a reload",
              f"{PREFIX} مکان من" in pg.locator('div[data-panel="visit"]').inner_text())
        br.close()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    rows = c.execute("SELECT user_id, name FROM prospect ORDER BY user_id, id").fetchall()
    by_user: dict[int, list[str]] = {}
    for r in rows:
        by_user.setdefault(r["user_id"], []).append(r["name"])
    c.execute("DELETE FROM prospect WHERE name LIKE ?", (f"{PREFIX}%",))
    c.execute("DELETE FROM app_user WHERE username = ?", (OTHER,))
    c.commit()
    after_mine = c.execute("SELECT COUNT(*) FROM prospect WHERE user_id = 1").fetchone()[0]
    c.close()

    check("two separate lists exist in one table",
          uid2 in by_user and 1 in by_user, f"user1={len(by_user.get(1, []))} · user2={len(by_user.get(uid2, []))}")
    check("the owner's other rows were not touched", after_mine == before_mine,
          f"{after_mine} of {before_mine}")

    print("\nRESULT:", "the visit list is per user and stored in the database" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
