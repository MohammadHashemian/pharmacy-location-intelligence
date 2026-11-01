"""Proof for the pharmacy/clinic layer: click a marker, read the panel.

    python tools/probe_places.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = ROOT / "tools" / "shots"
URL = "http://localhost:3737/map"

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
    pg = br.new_page(viewport={"width": 1568, "height": 980})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=180_000)
    pg.wait_for_timeout(1000)

    base = pg.evaluate(
        """() => {
          const svg = document.querySelector('svg');
          return {
            med: svg.querySelectorAll('path[fill="#7c3aed"], circle[fill="#7c3aed"], circle[fill="#0ea5e9"]').length,
            pharm: svg.querySelectorAll('path[fill="#d97706"]').length,
          };
        }"""
    )
    print("at zoom 1:", base)

    # pick a pharmacy that is already inside the visible map, then zoom AT it so it
    # stays under the cursor instead of drifting out of view
    target = pg.evaluate(
        """() => {
          const svg = document.querySelector('svg');
          const r = svg.getBoundingClientRect();
          for (const c of svg.querySelectorAll('path[fill="#d97706"]')) {
            const b = c.getBoundingClientRect();
            const x = b.x + b.width / 2, y = b.y + b.height / 2;
            if (x > r.x + 30 && x < r.right - 30 && y > r.y + 30 && y < r.bottom - 30)
              return {x, y};
          }
          return null;
        }"""
    )
    print("anchor marker:", target)
    if target:
        pg.mouse.move(target["x"], target["y"])
        for _ in range(3):
            pg.mouse.wheel(0, -600)
            pg.wait_for_timeout(600)

    mid = pg.evaluate(
        """() => {
          const svg = document.querySelector('svg');
          const meds = [...svg.querySelectorAll('path[fill="#7c3aed"], circle[fill="#7c3aed"], circle[fill="#0ea5e9"]')];
          const ph = [...svg.querySelectorAll('path[fill="#d97706"]')];
          const r = svg.getBoundingClientRect();
          const inside = ph.filter((c) => {
            const b = c.getBoundingClientRect();
            const x = b.x + b.width / 2, y = b.y + b.height / 2;
            return x > r.x + 10 && x < r.right - 10 && y > r.y + 10 && y < r.bottom - 10;
          });
          return {med: meds.length, pharm: ph.length, pharmInView: inside.length};
        }"""
    )
    print("zoomed:", mid)

    clicked = pg.evaluate(
        """() => {
          const svg = document.querySelector('svg');
          const r = svg.getBoundingClientRect();
          const ph = [...svg.querySelectorAll('path[fill="#d97706"]')];
          for (const c of ph) {
            const b = c.getBoundingClientRect();
            const x = b.x + b.width / 2, y = b.y + b.height / 2;
            if (x > r.x + 20 && x < r.right - 20 && y > r.y + 20 && y < r.bottom - 20) return {x, y};
          }
          return null;
        }"""
    )
    print("marker at:", clicked)
    if clicked:
        pg.mouse.move(clicked["x"], clicked["y"])
        pg.wait_for_timeout(300)
        pg.mouse.click(clicked["x"], clicked["y"])
        pg.wait_for_timeout(1400)
        panel = pg.evaluate(
            """() => {
              const t = document.body.innerText;
              const i = t.indexOf('رقابت در شعاع');
              return {found: i >= 0, snippet: i >= 0 ? t.slice(Math.max(0, i - 320), i + 220) : ''};
            }"""
        )
        print("panel:", panel["found"])
        print(" | ".join(panel["snippet"].split()))
        img = pg.evaluate(
            """() => {
              const im = [...document.querySelectorAll('img')].find(i => i.src.includes('/api/place-photo'));
              return im ? {src: im.getAttribute('src').slice(0, 90), w: im.naturalWidth, h: im.naturalHeight} : null;
            }"""
        )
        print("photo:", img)
        pg.screenshot(path=str(OUT / "map-pharmacy-panel.png"))

    print("errors:", errs[:3])
    br.close()
