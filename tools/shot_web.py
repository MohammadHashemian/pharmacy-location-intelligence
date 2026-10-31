"""Snapshot the live Next.js dashboard's top-of-page view (proof of the data)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

JS_ROWS = """els => els.slice(0,4).map(tr => Array.from(tr.querySelectorAll('td'))
    .map(td => td.innerText.split('\\n')[0].trim()).join(' | '))"""

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
    pg = br.new_page(viewport={"width": 1680, "height": 1150})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto("http://localhost:3737/", wait_until="networkidle", timeout=120_000)
    pg.wait_for_timeout(1500)
    print("H1   :", pg.inner_text("h1"))
    print("ROWS :", pg.locator("tbody tr").count())
    for r in pg.eval_on_selector_all("tbody tr", JS_ROWS):
        print("  ", r[:150])
    pg.screenshot(path=str(ROOT / "tools" / "shots" / "web-final-top.png"),
                  clip={"x": 0, "y": 0, "width": 1680, "height": 1050})
    print("errors:", errs[:4])
    br.close()
