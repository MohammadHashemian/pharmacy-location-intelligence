"""
Smoke-verify the workspace UI in a real browser: console errors, table rows,
drawer, charts. Screenshots land in tools/shots/.

    python tools/verify_ui.py [http://127.0.0.1:8765]
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SHOTS = Path(__file__).resolve().parent / "shots"


def main(url: str = "http://127.0.0.1:8765") -> int:
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as pw:
        exe = find_local_chromium()
        br = pw.chromium.launch(headless=True, executable_path=exe) if exe else pw.chromium.launch(headless=True)
        pg = br.new_page(viewport={"width": 1600, "height": 1000})
        pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        pg.goto(url, wait_until="networkidle", timeout=60_000)
        pg.wait_for_selector("#rows tr td.city-cell", timeout=30_000)
        rows = pg.locator("#rows tr").count()
        status = pg.inner_text("#status")
        print(f"[ui] ranking rows rendered: {rows}")
        print(f"[ui] status: {status}")
        pg.screenshot(path=str(SHOTS / "01-ranking.png"), full_page=False)

        # drawer
        pg.locator("#rows tr").first.click()
        pg.wait_for_selector("#drawer.on", timeout=10_000)
        pg.wait_for_timeout(700)
        print(f"[ui] drawer title: {pg.inner_text('#drawerBody h2')}")
        pg.screenshot(path=str(SHOTS / "02-drawer.png"))
        pg.click("#drawerClose"); pg.wait_for_timeout(400)

        # charts
        pg.click('.tabs button[data-v="charts"]'); pg.wait_for_timeout(900)
        svgs = pg.locator("#v-charts svg").count()
        print(f"[ui] chart svgs: {svgs}")
        pg.screenshot(path=str(SHOTS / "03-charts.png"), full_page=True)

        # provinces
        pg.click('.tabs button[data-v="prov"]')
        pg.wait_for_selector("#provRows tr", timeout=15_000)
        print(f"[ui] province rows: {pg.locator('#provRows tr').count()}")
        pg.screenshot(path=str(SHOTS / "04-provinces.png"))

        # filter interaction: province = Tehran (id 1?) via first non-empty option
        pg.click('.tabs button[data-v="rank"]')
        opts = pg.eval_on_selector_all("#fProvince option", "els=>els.map(e=>[e.value,e.textContent])")
        print(f"[ui] provinces in filter: {len(opts) - 1}")
        if len(opts) > 1:
            pg.select_option("#fProvince", opts[1][0])
            pg.wait_for_timeout(1500)
            print(f"[ui] after province filter -> {pg.inner_text('#status')}")
            pg.screenshot(path=str(SHOTS / "05-filtered.png"))

        # method tab
        pg.click("#btnMethod"); pg.wait_for_timeout(500)
        pg.screenshot(path=str(SHOTS / "06-method.png"), full_page=True)

        # ---- layout measurements (no overlap / no horizontal overflow) -------
        m = pg.evaluate("""() => {
          const out = {};
          out.docScrollW = document.documentElement.scrollWidth;
          out.winW = window.innerWidth;
          const drawer = document.querySelector('#drawer');
          const r = drawer.getBoundingClientRect();
          out.drawerClosedRects = [r.left, r.right, r.width, getComputedStyle(drawer).visibility];
          // does a closed drawer sit inside the viewport (=> would swallow clicks)?
          out.drawerOverlapsViewport = !(r.right <= 0 || r.left >= out.winW);
          const main = document.querySelector('main').getBoundingClientRect();
          out.main = [main.left, main.right, main.width];
          // any table cell with clipped content?
          out.clipped = [...document.querySelectorAll('#rows td')].filter(td => td.scrollWidth > td.clientWidth + 1).length;
          // sidebar vs main overlap
          const aside = document.querySelector('aside').getBoundingClientRect();
          out.asideRightVsMainLeft = [aside.right, main.left];
          out.overlapAsideMain = !(aside.right <= main.left || aside.left >= main.right);
          // KPI strip fits
          const k = document.querySelector('.kpis').getBoundingClientRect();
          out.kpis = [k.left, k.right, k.width];
          out.bodyFont = getComputedStyle(document.body).fontFamily;
          return out;
        }""")
        print("\n[ui] measurements:")
        for k, v in m.items():
            print(f"   {k}: {v}")
        br.close()

    print(f"\n[ui] console errors: {len(errors)}")
    for e in errors[:20]:
        print("   ", e)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:]))
