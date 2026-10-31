"""
Verify the Next.js dashboard (web/) against the shared ETL database.

    python tools/verify_web.py [http://localhost:3000]

Prints the visible headline numbers and layout measurements, writes screenshots
to tools/shots/web-*.png. Read-only: it never posts into the app.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SHOTS = Path(__file__).resolve().parent / "shots"


def main(url: str = "http://localhost:3000") -> int:
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as pw:
        exe = find_local_chromium()
        br = pw.chromium.launch(headless=True, executable_path=exe) if exe else pw.chromium.launch(headless=True)
        pg = br.new_page(viewport={"width": 1680, "height": 1150})
        pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        pg.goto(url, wait_until="networkidle", timeout=120_000)
        pg.wait_for_timeout(1500)

        info = pg.evaluate("""() => {
          const txt = s => [...document.querySelectorAll(s)].map(e=>e.innerText.trim());
          return {
            title: document.title,
            headings: txt('h1,h2,h3').slice(0, 10),
            kpis: txt('[class*=kpi], [class*=stat], [class*=card]').slice(0, 12),
            tables: document.querySelectorAll('table').length,
            tableRows: document.querySelectorAll('tbody tr').length,
            svgs: document.querySelectorAll('svg').length,
            bodyText: document.body.innerText.slice(0, 1200),
            hScroll: document.documentElement.scrollWidth > window.innerWidth,
            docHeight: document.documentElement.scrollHeight,
            buttons: txt('button').slice(0, 20),
          };
        }""")
        for k, v in info.items():
            print(f"{k}: {v}")
        pg.screenshot(path=str(SHOTS / "web-01-overview.png"), full_page=True)

        # click through the tabs the app exposes, screenshot each
        for i, label in enumerate(info["buttons"][:6]):
            try:
                pg.get_by_role("button", name=label, exact=True).first.click(timeout=4000)
                pg.wait_for_timeout(1200)
                pg.screenshot(path=str(SHOTS / f"web-{i+2:02d}-{i+1}.png"))
                print(f"[tab {i+1}] clicked {label!r} -> rows="
                      f"{pg.locator('tbody tr').count()} svgs={pg.locator('svg').count()}")
            except Exception as e:  # noqa: BLE001
                print(f"[tab {i+1}] {label!r} not clickable: {type(e).__name__}")

        br.close()

    print(f"\nconsole errors: {len(errors)}")
    for e in errors[:15]:
        print("   ", e)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:]))
