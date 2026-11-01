"""Screenshots of /map at the widths we design for (desktop, laptop, tablet, phone).

    python tools/shot_map.py            # all sizes
    python tools/shot_map.py 1264 569   # one size

Writes tools/shots/map-<w>x<h>.png (full page) and -card.png (map card only).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

URL = "http://localhost:3737/map"
OUT = ROOT / "tools" / "shots"
SIZES = [(1264, 569), (1568, 900), (768, 1024), (390, 844)]

if len(sys.argv) == 3:
    SIZES = [(int(sys.argv[1]), int(sys.argv[2]))]

OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
    for w, h in SIZES:
        pg = br.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(URL, wait_until="networkidle", timeout=180_000)
        pg.wait_for_timeout(1200)
        tag = f"map-{w}x{h}"
        pg.screenshot(path=str(OUT / f"{tag}.png"))
        card = pg.locator("div[style*='max-width']").first
        card.screenshot(path=str(OUT / f"{tag}-card.png"))
        box = pg.evaluate(
            """() => {
              const svg = document.querySelector('svg').getBoundingClientRect();
              const d = document.documentElement;
              return {svgW: Math.round(svg.width), svgH: Math.round(svg.height),
                      overflowX: d.scrollWidth - d.clientWidth,
                      docH: d.scrollHeight};
            }"""
        )
        print(tag, box, "errors:", errs[:2])
        pg.close()
    br.close()
