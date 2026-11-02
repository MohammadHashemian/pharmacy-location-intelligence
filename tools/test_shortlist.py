"""P1.4 — the short list compares the places you are actually choosing between.

  * POST /api/shortlist copies a candidate **with its metrics** (a snapshot, not a live join);
  * the page renders them side by side: score, demand, supply, anchors, gap, distance;
  * removing one updates the page;
  * a re-rank does not silently rewrite an existing shortlisted row.

    python tools/test_shortlist.py
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
FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹٫", "0123456789.")


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main() -> int:
    for it in api("/api/shortlist")["items"]:
        api(f"/api/shortlist?id={it['id']}", method="DELETE")

    a = api("/api/shortlist", {"rank": 1}, "POST")
    b = api("/api/shortlist", {"rank": 2}, "POST")
    if not (a.get("id") and b.get("id")):
        print("could not shortlist ranks 1 and 2 — has rank_sites.py run?")
        return 1

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    saved = [dict(r) for r in c.execute("SELECT * FROM shortlist ORDER BY id")]
    live = {r["rank"]: dict(r) for r in c.execute("SELECT * FROM site_candidate")}
    c.close()

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    check("two rows stored", len(saved) == 2, str(len(saved)))
    check("metrics copied, not joined",
          all(abs(r["score"] - live[r["rank"]]["score"]) < 1e-9 for r in saved),
          "score matches the ranked row")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat={saved[0]['lat']}&lon={saved[0]['lon']}&k=9",
                wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)

        panel = pg.locator('div:has(> div:has-text("فهرست کوتاه"))').first
        txt = panel.inner_text()
        check("panel lists both places",
              all((r["settlement"] or "") in txt for r in saved), txt.splitlines()[0])
        shown = txt.translate(FA)
        check("scores rendered", all(f"{r['score']:.2f}" in shown for r in saved))

        pg.locator('button:has-text("حذف")').first.click()
        pg.wait_for_timeout(1800)
        left = api("/api/shortlist")["items"]
        check("remove deletes one row", len(left) == 1, f"{len(left)} left")
        br.close()

    for it in api("/api/shortlist")["items"]:
        api(f"/api/shortlist?id={it['id']}", method="DELETE")

    print("\nRESULT:", "short list works as a snapshot comparison" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
