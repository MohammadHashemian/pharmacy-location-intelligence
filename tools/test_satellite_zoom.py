"""Zoom in as far as the imagery goes, and check nothing else breaks on the way.

Deep zoom is a whole-map change: the tiles need a higher zoom, the density grid has to
survive a viewport measured in metres, the streets layer has to stay culled, and the
markers must keep their size. This walks the ladder to the new ceiling and asserts the
layers that carry a decision still render.

    python tools/test_satellite_zoom.py
    python tools/test_satellite_zoom.py --shots      # crops at 12x / 120x / 300x / 600x

Exit 1 if a zoom level renders no tiles, gaps, or loses the density/street/marker layers.
"""
from __future__ import annotations

import argparse
import os
import sys

from playwright.sync_api import sync_playwright

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_HERE, os.path.join(_ROOT, "src"), _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from fetch_zarfiat import find_local_chromium  # noqa: E402

ZOOMS = [8.0, 20.0, 40.0, 80.0, 150.0, 300.0, 450.0, 600.0]
PLACE = (31.3189, 48.6842)          # اهواز: has z18 imagery

PROBE = r"""() => {
  const svg = document.querySelector('svg');
  const g = document.querySelector('g#scene');
  const m = g.getAttribute('transform').match(/scale\(([\d.]+)\)/);
  const r = svg.getBoundingClientRect();

  const tiles = [...svg.querySelectorAll('image')];
  const shown = tiles.filter((i) => {
    const b = i.getBoundingClientRect();
    return b.width > 0 && b.right > r.x && b.left < r.right && b.bottom > r.y && b.top < r.bottom;
  }).map((i) => {
    const b = i.getBoundingClientRect();
    const href = i.getAttribute('href') || '';
    const z = Number((href.match(/tile\/(\d+)\//) || [0, 0])[1]);
    return {b, z};
  });
  let cover = 0;
  if (shown.length) {
    const x0 = Math.min(...shown.map((t) => t.b.left)), x1 = Math.max(...shown.map((t) => t.b.right));
    const y0 = Math.min(...shown.map((t) => t.b.top)), y1 = Math.max(...shown.map((t) => t.b.bottom));
    cover = (Math.min(x1, r.right) - Math.max(x0, r.x)) * (Math.min(y1, r.bottom) - Math.max(y0, r.y))
      / (r.width * r.height);
  }
  const cells = [...svg.querySelectorAll('rect')].filter((x) => /^rgb\(/.test(x.getAttribute('fill') || '')).length;
  const streets = [...svg.querySelectorAll('path')].filter((p) => {
    const s = (p.getAttribute('stroke') || '').toLowerCase();
    return s === '#8a9bad' || s.startsWith('#8a9');
  }).length;
  const pharm = svg.querySelectorAll('path[fill="#d97706"]').length;
  const labels = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim()).length;
  return {
    k: m ? Number(m[1]) : null, tiles: tiles.length, shown: shown.length,
    z: shown.length ? Math.max(...shown.map((t) => t.z)) : null,
    cover: Math.round(cover * 100), cells, streets, pharm, labels,
    mpu: (() => {
      // metres per screen pixel: the number that says «can I see the roof»
      const scene = g.querySelector('[data-layer="streets"]') || g;
      return null;
    })(),
  };
}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3737")
    ap.add_argument("--shots", action="store_true")
    args = ap.parse_args()
    lat, lon = PLACE
    shots = os.path.join(_ROOT, "tools", "shots", "satzoom")
    os.makedirs(shots, exist_ok=True)
    fails: list[str] = []

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1400, "height": 950}, device_scale_factor=1)
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))

        print(f"{'zoom':>6} {'tiles':>6} {'z':>3} {'cover':>6} {'cells':>6} {'streets':>8} "
              f"{'pharm':>6} {'labels':>7}  verdict")
        for k in ZOOMS:
            pg.goto(f"{args.url}/map?lat={lat}&lon={lon}&k={k}",
                    wait_until="domcontentloaded", timeout=180_000)
            pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60_000)
            pg.wait_for_timeout(1200)
            # satellite is off by default
            pg.get_by_text("لایه‌های نقشه").first.click()
            pg.wait_for_timeout(200)
            pg.get_by_label("تصویر ماهواره‌ای").check()
            pg.wait_for_timeout(4200)
            pg.locator("summary", has_text="لایه‌های نقشه").first.click()
            pg.wait_for_timeout(500)

            d = pg.evaluate(PROBE)
            ok_tiles = d["shown"] > 0
            ok_cover = d["cover"] >= 95
            ok_layers = d["cells"] > 0 and d["pharm"] > 0 and d["labels"] > 0
            ok_streets = d["streets"] > 0 or k < 3.2
            ok_zoom = abs((d["k"] or 0) - k) < 1
            ok = ok_tiles and ok_cover and ok_layers and ok_streets and ok_zoom
            if not ok:
                fails.append(f"k={k}")
            print(f"{d['k']:>6.0f} {d['shown']:>6} {str(d['z']):>3} {d['cover']:>5}% "
                  f"{d['cells']:>6} {d['streets']:>8} {d['pharm']:>6} {d['labels']:>7}  "
                  f"{'ok' if ok else 'FAIL'}")

            if args.shots and k in (12.0, 120.0, 300.0, 600.0, 40.0, 600.0):
                box = pg.locator("svg").first.bounding_box()
                pg.screenshot(path=os.path.join(shots, f"k{int(k)}.png"), clip=box)

        ok = not errs
        print(f"\n{'PASS' if ok else 'FAIL'}  no page errors"
              f"{(' — ' + '; '.join(errs[:2])) if errs else ''}")
        if not ok:
            fails.append("pageerrors")
        br.close()

    print()
    if fails:
        print(f"RESULT: {len(fails)} zoom level(s) failed: {fails}")
        return 1
    print("RESULT: tiles, density, streets, markers and labels survive every zoom to 600x")
    return 0


if __name__ == "__main__":
    sys.exit(main())
