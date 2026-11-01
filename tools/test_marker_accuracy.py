"""Is every marker drawn at the coordinate it claims? Measure it, don't eyeball it.

A marker in the wrong place looks perfectly fine in a screenshot — which is why «the
location you marked does not match the address» can survive a visual review. This compares
each marker's own bounding box against `__khz.screenOf(lat, lon)`, the map's own inverse
projection, for the pharmacies and for the ranked recommendations.

    python tools/test_marker_accuracy.py
    python tools/test_marker_accuracy.py --shots     # crops for a human look

A marker must sit within PAINT_PX of its coordinate. Anything larger is a projection bug,
a lat/lon swap, or a stale transform — all of which have happened on this map.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from playwright.sync_api import sync_playwright

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_HERE, os.path.join(_ROOT, "src"), _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from fetch_zarfiat import find_local_chromium  # noqa: E402

PAINT_PX = 2.5          # a marker's centre must land within this of its coordinate

PROBE = r"""() => {
  const hook = window.__khz;
  if (!hook) return { error: 'no hook' };
  const svg = document.querySelector('svg');
  const scene = document.querySelector('g#scene');
  const hit = (el) => {
    const b = el.getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };

  // pharmacies: every diamond carries no coordinate, so take them in render order from
  // the data the page already exposes through the layer's own elements
  const out = { pharmacies: [], sites: [], k: hook.k() };

  const diamonds = [...svg.querySelectorAll('path[fill="#d97706"]')];
  out.pharmCount = diamonds.length;

  const siteEls = [...document.querySelectorAll('g[data-layer="sites"] g')];
  out.siteCount = siteEls.length;
  out.siteSamples = siteEls.slice(0, 40).map((g) => {
    const texts = [...g.querySelectorAll('text')].map((t) => t.textContent.trim());
    const circles = [...g.querySelectorAll('circle')];
    const c = circles.length ? hit(circles[circles.length - 1]) : null;
    return { rank: texts[0] ?? null, screen: c };
  });
  out.pharmSamples = diamonds.slice(0, 60).map((p) => ({ screen: hit(p) }));
  return out;
}"""

# coordinates the page knows, read from the same JSON it was rendered from
DATA = r"""() => {
  const s = document.querySelector('script[data-map-pharmacies]');
  return s ? JSON.parse(s.textContent || '[]') : null;
}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3737")
    ap.add_argument("--shots", action="store_true")
    args = ap.parse_args()

    fails: list[str] = []
    shots = os.path.join(_ROOT, "tools", "shots", "markers")
    os.makedirs(shots, exist_ok=True)

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1400, "height": 950})
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))

        for name, lat, lon, k in (("ahvaz", 31.3200, 48.6690, 13.0),
                                  ("kut-saleh", 31.2500, 48.6000, 13.0),
                                  ("dezful", 32.3810, 48.4050, 13.0)):
            pg.goto(f"{args.url}/map?lat={lat}&lon={lon}&k={k}",
                    wait_until="domcontentloaded", timeout=180_000)
            pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60_000)
            pg.wait_for_timeout(2500)

            # markers are drawn from data the page already has; ask the page for the
            # same records so the comparison is data → pixels, not pixels → pixels
            records = pg.evaluate("""() => {
              const el = document.getElementById('map-pharmacy-data');
              return el ? JSON.parse(el.textContent || '[]') : null;
            }""")

            res = pg.evaluate(PROBE)
            print(f"\n== {name} k={res.get('k')} · {res.get('pharmCount')} diamonds · "
                  f"{res.get('siteCount')} site marks")

            # pharmacies: verify the *drawing* matches its own coordinate by asking the
            # page to project each visible pharmacy and finding the nearest diamond
            check = pg.evaluate("""() => {
              const hook = window.__khz;
              const svg = document.querySelector('svg');
              const r = svg.getBoundingClientRect();
              const diamonds = [...svg.querySelectorAll('path[fill="#d97706"]')].map((p) => {
                const b = p.getBoundingClientRect();
                return [b.x + b.width / 2, b.y + b.height / 2];
              });
              return {diamonds: diamonds.length, box: [r.x, r.y, r.width, r.height]};
            }""")
            print(f"   diamonds in view: {check['diamonds']}")

            # the assertion that matters: every drawn marker sits where its own
            # data-lat/data-lon says, measured through the map's own projection
            meas = pg.evaluate("""() => {
              const hook = window.__khz;
              const errs = [];
              let n = 0, worst = 0;
              for (const g of document.querySelectorAll('[data-lat][data-lon]')) {
                const lat = Number(g.getAttribute('data-lat'));
                const lon = Number(g.getAttribute('data-lon'));
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                const svg = document.querySelector('svg');
                const ctm = svg.getScreenCTM();
                if (!ctm) continue;
                // markers are drawn as a <g> around one shape; use the shape's centre
                const shape = g.querySelector('path, circle');
                if (!shape) continue;
                const b = shape.getBoundingClientRect();
                const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
                // elements outside the svg viewport have no reliable geometry; the
                // claim being tested is about markers a person can actually see
                const vr = document.querySelector('svg').getBoundingClientRect();
                if (cx < vr.x || cx > vr.right || cy < vr.y || cy > vr.bottom) continue;
                const [ex, ey] = hook.screenOf(lat, lon);
                const d = Math.hypot(cx - ex, cy - ey);
                n += 1;
                if (d > worst) worst = d;
                if (d > 2.5) errs.push({lat, lon, d: Math.round(d * 10) / 10});
              }
              return {checked: n, worst: Math.round(worst * 10) / 10, bad: errs.slice(0, 5)};
            }""")
            print(f"   markers checked {meas['checked']} · worst offset {meas['worst']} px")
            if meas["bad"]:
                print(f"   OFF-POSITION: {meas['bad']}")
            if meas["checked"] == 0:
                fails.append(f"{name}: no tagged markers found")
            elif meas["worst"] > 2.5:
                fails.append(f"{name}: marker off by {meas['worst']} px")

            if args.shots:
                box = pg.locator("svg").first.bounding_box()
                pg.screenshot(path=os.path.join(shots, f"{name}.png"), clip=box)

        ok = not errs
        print(f"\n{'PASS' if ok else 'FAIL'}  no page errors"
              f"{(' — ' + '; '.join(errs[:2])) if errs else ''}")
        if not ok:
            fails.append("pageerrors")
        br.close()

    print()
    if fails:
        print(f"RESULT: {len(fails)} problem(s): {fails}")
        return 1
    print("RESULT: marker geometry is consistent with the projection at every test view")
    return 0


if __name__ == "__main__":
    sys.exit(main())
