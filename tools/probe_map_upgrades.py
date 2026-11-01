"""Probe for the map upgrades: fullscreen, one labelling ring, density resolution,
pharmacy marker growth.

    python tools/probe_map_upgrades.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = ROOT / "tools" / "shots"
OUT.mkdir(parents=True, exist_ok=True)

MEASURE = """() => {
  const svg = document.querySelector('svg');
  const k = (() => {
    const g = svg.querySelector('g#scene');
    const tr = g && g.getAttribute('transform');
    const m = tr && tr.match(/scale\\(([\\d.]+)\\)/);
    return m ? Number(m[1]) : 1;
  })();
  const pharm = [...svg.querySelectorAll('path')].filter(p => (p.getAttribute('d')||'').startsWith('M') && (p.getAttribute('fill')||'').toLowerCase() === '#d97706');
  let pharmPx = null;
  if (pharm.length) {
    const r = pharm[0].getBoundingClientRect();
    pharmPx = Math.round(r.width * 10) / 10;
  }
  const dashed = [...svg.querySelectorAll('circle')].filter(c => (c.getAttribute('stroke-dasharray')||'').length > 0);
  const ringTexts = [...svg.querySelectorAll('text')].map(t => t.textContent.trim()).filter(t => t.includes('کیلومتر از'));
  return {
    k, pharmCount: pharm.length, pharmPx,
    dashedCircles: dashed.length,
    ringLabels: ringTexts,
    rects: svg.querySelectorAll('rect').length,
    texts: svg.querySelectorAll('text').length,
    fullscreen: !!document.fullscreenElement,
  };
}"""

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
    pg = br.new_page(viewport={"width": 1568, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:3737/map", wait_until="networkidle", timeout=180_000)
    pg.wait_for_timeout(1200)
    print("z1  ", pg.evaluate(MEASURE))

    # zoom in through the real wheel handler so the same code path is exercised
    svg = pg.locator("svg").first
    box = svg.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    for i, label in enumerate(["z3", "z6", "z12"]):
        pg.mouse.move(cx, cy)
        pg.mouse.wheel(0, -600)
        pg.wait_for_timeout(700)
        print(label, " ", pg.evaluate(MEASURE))

    # fullscreen
    pg.get_by_role("button", name="تمام‌صفحه").click()
    pg.wait_for_timeout(800)
    print("full  ", pg.evaluate(MEASURE))
    pg.screenshot(path=str(OUT / "map-fullscreen.png"))
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(500)
    print("after ", pg.evaluate(MEASURE))
    print("errors:", errs[:3])
    br.close()
