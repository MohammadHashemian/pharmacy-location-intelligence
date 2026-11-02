"""A pharmacy somebody adds must move the analysis, not just the map.

Reported: «I add 2 new pharmacies in عین دو but the بیشترین شکاف table does not change and
the gap is the same». The cause was two tables deep — `v_map_pharmacy_mapped` counted only
`map_pharmacy`, so every live view built on it (gap, density, ratio) ignored hand-added pins.

This test proves the whole loop, in the browser, against the real database:

  1. read the settlement's gap on the page;
  2. POST a manual pharmacy at that settlement;
  3. wait for the background re-rank to move `site_candidate.generated_at`;
  4. reload — the gap must drop by exactly one pharmacy;
  5. delete it, wait, reload — the gap must come back.

    python tools/test_live_analytics.py           # full run
    python tools/test_live_analytics.py --keep    # leave the test pin in place

Exit code 0 only if every assertion holds.
"""
from __future__ import annotations

import argparse
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
TARGET_PER_PHARM = 5400


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def gap_of(name: str) -> tuple[int, float]:
    """(mapped pharmacies, gap) straight from the view the page renders."""
    c = sqlite3.connect(DB)
    pop, ph = c.execute(
        "SELECT population, pharmacy_mapped FROM v_map_settlement WHERE name = ? LIMIT 1",
        (name,),
    ).fetchone()
    c.close()
    return ph, round((pop or 0) / TARGET_PER_PHARM - ph, 2)


FA = str.maketrans("۰۱۲۳۴۵۶۷۸۹٫−", "0123456789.-")


def row_gap_on_page(pg, name: str) -> float:
    """The gap as the user sees it in the suggestions table (Persian digits and all)."""
    pg.fill('input[placeholder*="جستجوی نام"]', name)
    pg.wait_for_timeout(700)
    row = pg.locator("tr", has_text=name).first
    cells = [c.strip() for c in row.locator("td").all_inner_texts()]
    print("   row:", " | ".join(cells))
    txt = cells[-1].translate(FA).replace("٬", "").replace(",", "").strip()
    return float(txt)


def wait_rank(before: str | None, timeout: float = 60.0) -> str | None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        at = api("/api/pharmacies").get("rankAt")
        if at and at != before:
            return at
        time.sleep(2)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--name", default="عین دو")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    lat, lon = c.execute(
        "SELECT lat, lon FROM v_map_settlement WHERE name = ? AND lat IS NOT NULL LIMIT 1",
        (args.name,),
    ).fetchone()
    c.close()
    print(f"settlement {args.name}: {lat:.4f},{lon:.4f}")

    # leftovers from an interrupted earlier run would inflate the baseline
    c = sqlite3.connect(DB)
    stale = [r[0] for r in c.execute(
        "SELECT id FROM manual_place WHERE note = 'created by tools/test_live_analytics.py'")]
    for sid in stale:
        c.execute("DELETE FROM manual_place WHERE id = ?", (sid,))
    c.commit()
    c.close()
    if stale:
        print("removed", len(stale), "leftover test pins")

    ph0, gap0 = gap_of(args.name)
    rank0 = api("/api/pharmacies").get("rankAt")
    print(f"before: mapped {ph0} · gap {gap0} · rankAt {rank0}")

    # the 60 m duplicate rule is real: walk outward until a free spot is found
    created: dict = {}
    for dy, dx in ((0.0015, 0.0015), (0.003, 0.003), (-0.004, 0.004), (0.006, -0.006),
                   (0.010, 0.010), (-0.012, 0.012)):
        try:
            created = api("/api/pharmacies", {
                "kind": "pharmacy",
                "name": f"آزمون زنده‌بودن تحلیل {int(time.time()) % 10000}",
                "lat": lat + dy,
                "lon": lon + dx,
                "note": "created by tools/test_live_analytics.py",
            }, "POST")
            break
        except urllib.error.HTTPError as e:
            body = json.loads(e.read() or b"{}")
            print(f"  spot {dy:+.4f},{dx:+.4f} taken: {body.get('error', e.code)}")
            continue
    if not created.get("id"):
        print("could not place a test pin near this settlement")
        return 1
    mid = created.get("id")
    print("created manual pharmacy:", mid, created.get("settlement"))

    new_rank = wait_rank(rank0)
    print("re-rank finished:", new_rank)
    ph1, gap1 = gap_of(args.name)
    print(f"after add: mapped {ph1} · gap {gap1}")

    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    check("live view counts the new pin", ph1 == ph0 + 1, f"{ph0} → {ph1}")
    check("gap drops by exactly one pharmacy", abs((gap0 - gap1) - 1.0) < 0.02,
          f"{gap0} → {gap1}")
    check("background re-rank ran", bool(new_rank) and new_rank != rank0,
          f"{rank0} → {new_rank}")

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 950})
        pg.goto(f"{BASE}/map?lat={lat}&lon={lon}&k=12&r=120", wait_until="domcontentloaded",
                timeout=120000)
        pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
        pg.wait_for_timeout(2500)
        shown = row_gap_on_page(pg, args.name)
        print(f"page shows gap {shown}")
        check("the page renders the new gap", abs(shown - gap1) < 0.05, f"row {shown} vs {gap1}")
        br.close()

    if not args.keep:
        api(f"/api/pharmacies?id={mid}", method="DELETE")
        wait_rank(new_rank)
        ph2, gap2 = gap_of(args.name)
        print(f"after delete: mapped {ph2} · gap {gap2}")
        check("deleting restores the gap", abs(gap2 - gap0) < 0.02, f"{gap2} vs {gap0}")
    else:
        print(f"kept id {mid} (delete later with DELETE /api/pharmacies?id={mid})")

    print("\nRESULT:", "live analytics follow manual changes" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
