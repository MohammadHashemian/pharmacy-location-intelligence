"""Proof for the urban layers: streets in the basemap, ratio mode, population surface.

    python tools/probe_urban.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = ROOT / "tools" / "shots"
URL = "http://localhost:3737/map?lat=31.335&lon=48.665&k=9"

JS = r"""() => {
  const svg = document.querySelector('svg');
  const r = svg.getBoundingClientRect();
  const paths = [...svg.querySelectorAll('path')];
  const streets = paths.filter(p => p.getAttribute('stroke') === '#9fb0c0').length;
  const streetSegs = paths
    .filter(p => p.getAttribute('stroke') === '#9fb0c0')
    .map(p => (p.getAttribute('d') || '').length);
  const cells = [...svg.querySelectorAll('rect')].map(c => {
    const b = c.getBoundingClientRect();
    return {x: b.x + b.width / 2, y: b.y + b.height / 2, f: c.getAttribute('fill')};
  }).filter(c => c.x > r.x && c.x < r.right && c.y > r.y && c.y < r.bottom);
  const centre = cells.filter(c => Math.abs(c.x - (r.x + r.width / 2)) < 80
                                && Math.abs(c.y - (r.y + r.height / 2)) < 80);
  const t = document.body.innerText;
  return {
    streets, streetPathChars: streetSegs.reduce((a, b) => a + b, 0),
    cells: cells.length,
    centreFills: centre.slice(0, 4).map(c => c.f),
    legendRatio: t.indexOf('نفر به ازای هر داروخانه') >= 0,
  };
}"""

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
    pg = br.new_page(viewport={"width": 1568, "height": 980})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=180_000)
    pg.wait_for_timeout(3500)
    print("initial:", pg.evaluate(JS))
    pg.screenshot(path=str(OUT / "map-urban-streets.png"))

    # switch to the ratio mode
    pg.get_by_role("button", name="نفر به ازای داروخانه").first.click()
    pg.wait_for_timeout(2500)
    print("ratio  :", pg.evaluate(JS))
    legend = pg.evaluate(
        """() => { const t = document.body.innerText; const i = t.indexOf('آبی = پوشش');
           return i >= 0 ? t.slice(Math.max(0, i - 60), i + 40) : 'missing'; }"""
    )
    print("legend :", legend.replace("\n", " ")[:120])
    pg.screenshot(path=str(OUT / "map-ratio-mode.png"))
    print("errors :", errs[:3])
    br.close()
