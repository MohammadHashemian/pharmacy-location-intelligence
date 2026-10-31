"""Verify the /places explorer (all Khuzestan settlements) in a real browser.

    python tools/verify_places.py [http://localhost:3737/places]

Checks: header totals, expand-all row count vs the database, search finds
«ام الطمیر» in both spellings, the detail panel shows its population, and there
are no console errors. Screenshots land in tools/shots/places-*.png.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SHOTS = Path(__file__).resolve().parent / "shots"
DB = ROOT / "db" / "pharmacy.sqlite"


def db_counts() -> tuple[int, int]:
    conn = sqlite3.connect(DB)
    total = conn.execute(
        "SELECT COUNT(*) FROM v_admin_area_current WHERE kind IN "
        "('county','bakhsh','dehestan','city','village')"
    ).fetchone()[0]
    village = conn.execute(
        "SELECT COUNT(*) FROM v_admin_area_current WHERE kind = 'village'"
    ).fetchone()[0]
    return total, village


def main(url: str = "http://localhost:3737/places") -> int:
    SHOTS.mkdir(parents=True, exist_ok=True)
    total, village = db_counts()
    errors: list[str] = []
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'ok  ' if ok else 'FAIL'} {name} {detail}")
        if not ok:
            failures.append(name)

    with sync_playwright() as pw:
        exe = find_local_chromium()
        br = pw.chromium.launch(
            headless=True, executable_path=exe
        ) if exe else pw.chromium.launch(headless=True)
        pg = br.new_page(viewport={"width": 1440, "height": 1000})
        pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        pg.goto(url, wait_until="networkidle", timeout=180_000)
        pg.wait_for_timeout(800)

        body = pg.inner_text("body")
        check("header shows the tree", "همهٔ مکان‌های استان خوزستان" in body)
        check("county count", "۳۱ شهرستان" in body)
        fa = str.maketrans("0123456789,", "۰۱۲۳۴۵۶۷۸۹٬")
        check("village count", f"{village:,}".translate(fa) in body)

        # expand everything and count the rendered rows
        pg.get_by_role("button", name="باز کردن همه").click()
        pg.wait_for_timeout(1200)
        rows = pg.locator('[role="treeitem"]').count()
        check("expanded rows equal the database", rows == total, f"({rows} vs {total})")
        pg.screenshot(path=str(SHOTS / "places-01-all.png"), full_page=False)

        for spelling in ("ام الطمیر", "امالطمیر"):
            box = pg.get_by_placeholder("جست‌وجوی نام: روستا، دهستان، بخش، شهر…")
            box.fill(spelling)
            pg.wait_for_timeout(500)
            chips = pg.locator("div.border-b button")
            names = [chips.nth(i).inner_text() for i in range(chips.count())]
            hit = any("طمیر" in n for n in names)
            check(f"search finds «{spelling}»", hit, f"chips={names[:4]}")
            if hit:
                idx = next(i for i, n in enumerate(names) if "طمیر" in n)
                chips.nth(idx).click()
                pg.wait_for_timeout(400)
                panel = pg.inner_text("body")
                check("detail shows 5,004", "۵٬۰۰۴" in panel)
                check("detail shows its بخش", "اسماعیلیه" in panel)
                pg.screenshot(path=str(SHOTS / "places-02-um-altamir.png"), full_page=False)
            box.fill("")

        br.close()

    print(f"\nconsole errors: {len(errors)}")
    for e in errors[:10]:
        print("   ", e)
    if failures or errors:
        print("failed:", ", ".join(failures) or "console")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:]))
