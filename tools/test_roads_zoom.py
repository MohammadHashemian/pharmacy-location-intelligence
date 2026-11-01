"""Do roads survive every zoom step? Sweep it, don't assume.

The complaint is specific and testable: at a wide view the roads are there, zoom in and
they vanish. Three layers can carry a road at a given zoom —

  roads       motorway…secondary, province-wide, from 1.25x
  connectors  tertiary / unclassified / living_street, from 1.4x
  streets     one city's own network, from 3.2x

— so «the roads jumped» means one of them dropped out while another took over, or the
culler used the wrong box. This walks a zoom ladder at several places and counts painted
polylines at each step.

    python tools/test_roads_zoom.py
    python tools/test_roads_zoom.py --url http://localhost:3737 --shots

Exit 1 if any zoom level renders no road at all where a road exists in the data.
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

ZOOMS = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 16.0, 20.0, 28.0]

# a city centre, a small town, and a rural point on a highway between towns
PLACES = [
    ("ahvaz", 31.3189, 48.6842),
    ("veis", 31.4855, 48.8758),
    ("dezful", 32.3810, 48.4050),
    ("highway", 31.7000, 48.9000),
]

PROBE = r"""() => {
  const svg = document.querySelector('svg');
  const g = document.querySelector('g#scene');
  const m = g.getAttribute('transform').match(/scale\(([\d.]+)\)/);
  const count = (stroke) => {
    const els = [...svg.querySelectorAll('path')].filter(
      (p) => (p.getAttribute('stroke') || '').toLowerCase() === stroke);
    return els.reduce((n, p) => n + ((p.getAttribute('d') || '').match(/M/g) || []).length, 0);
  };
  return {
    k: m ? Number(m[1]) : null,
    roads: count('#8fa0b8') + count('#c3cedd'),
    connectors: count('#9aa8bc'),
    streets: count('#8a9bad'),
    tiles: svg.querySelectorAll('image').length,
  };
}"""



def run_transition(pg, base: str) -> None:
    """No reloads: load once, then wheel-zoom, sampling the road count as it goes."""
    pg.goto(f"{base}/map?lat=31.31&lon=48.67&k=1.6", wait_until="domcontentloaded",
            timeout=180_000)
    pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60_000)
    try:
        pg.wait_for_function(
            """() => { const g = document.querySelector('g[data-layer="connectors"]');
                     return g && g.children.length > 0; }""", timeout=25_000)
    except Exception:
        pass
    pg.wait_for_timeout(500)

    box = pg.locator("svg").first.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    print("\n== wheel transition from 1.6x, no reload")
    print(f"{'step':>5}  {'k':>6}  {'roads':>6} {'connect':>8} {'streets':>8}   verdict")
    for step in range(10):
        d = pg.evaluate(PROBE)
        total = d["roads"] + d["connectors"]
        ok = total > 0
        if not ok:
            fails.append(f"transition@{d['k']}")
        print(f"{step:>5}  {d['k']:>6.1f}  {d['roads']:>6} {d['connectors']:>8} "
              f"{d['streets']:>8}   {'ok' if ok else 'MISSING'}")
        pg.mouse.move(cx, cy)
        pg.mouse.wheel(0, -420)
        pg.wait_for_timeout(260)

    # and back out again
    for step in range(10):
        pg.mouse.move(cx, cy)
        pg.mouse.wheel(0, 420)
        pg.wait_for_timeout(260)
        d = pg.evaluate(PROBE)
        if d["roads"] + d["connectors"] == 0:
            fails.append(f"zoomout@{d['k']}")
    d = pg.evaluate(PROBE)
    print(f"  after zooming back out: {d['k']:.1f}x · roads {d['roads']} · "
          f"connectors {d['connectors']}")


fails: list[str] = []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3737")
    ap.add_argument("--shots", action="store_true")
    ap.add_argument("--transition", action="store_true",
                    help="zoom with the wheel instead of reloading: this is the case "
                         "the user reported — roads present wide, gone when zooming in")
    args = ap.parse_args()

    shots = os.path.join(_ROOT, "tools", "shots", "roads")
    os.makedirs(shots, exist_ok=True)
    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1400, "height": 950})
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))

        if args.transition:
            run_transition(pg, args.url)
            br.close()
            print()
            if fails:
                print(f"RESULT: roads vanished during a zoom transition: {fails}")
                return 1
            print("RESULT: roads stay painted through every wheel zoom")
            return 0

        for name, lat, lon in PLACES:
            print(f"\n== {name} ({lat}, {lon})")
            print(f"{'zoom':>5}  {'roads':>6} {'connect':>8} {'streets':>8}   verdict")
            for k in ZOOMS:
                pg.goto(f"{args.url}/map?lat={lat}&lon={lon}&k={k}",
                        wait_until="domcontentloaded", timeout=180_000)
                # the roads geojson is 1.5 MB and the connectors 3.9 MB: measuring
                # before they land reports «missing» for a map that is merely loading
                pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60_000)
                if k >= 3.2 and name in ("ahvaz", "veis", "dezful"):
                    try:
                        pg.wait_for_function(
                            """() => { const g = document.querySelector('g[data-layer="streets"]');
                                     return g && g.querySelectorAll('path').length > 0; }""",
                            timeout=20_000)
                    except Exception:
                        pass
                if True:
                    try:
                        pg.wait_for_function(
                            """() => {
                              const g = document.querySelector('g[data-layer="connectors"]');
                              return g && g.children.length > 0;
                            }""", timeout=20_000)
                    except Exception:
                        pass
                pg.wait_for_timeout(350)
                d = pg.evaluate(PROBE)
                total = d["roads"] + d["connectors"] + d["streets"]
                # what the data says should exist at this zoom
                want_roads = True          # the province view has roads too
                want_conn = True
                
                want_street = k >= 3.2 and name in ("ahvaz", "veis", "dezful")
                ok = True
                if want_roads and d["roads"] == 0 and d["connectors"] == 0:
                    ok = False
                if want_conn and d["connectors"] == 0:
                    ok = False
                if want_street and d["streets"] == 0:
                    ok = False
                verdict = "ok" if ok else "MISSING"
                if not ok:
                    fails.append(f"{name}@{k}")
                print(f"{d['k']:>5.1f}  {d['roads']:>6} {d['connectors']:>8} "
                      f"{d['streets']:>8}   {verdict}")
                if args.shots and k in (2.0, 6.0, 12.0, 20.0):
                    pg.screenshot(path=os.path.join(shots, f"{name}-k{k:g}.png"))
        check_errs = not errs
        print(f"\n{'PASS' if check_errs else 'FAIL'}  no page errors"
              f"{(' — ' + '; '.join(errs[:2])) if errs else ''}")
        if not check_errs:
            fails.append("pageerrors")
        br.close()

    print()
    if fails:
        print(f"RESULT: roads missing at {len(fails)} zoom level(s): {fails}")
        return 1
    print("RESULT: a road is painted at every zoom, at every place tested")
    return 0


if __name__ == "__main__":
    sys.exit(main())
