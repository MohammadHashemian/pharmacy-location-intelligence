"""Layer validity, visibility and paint order — asserted, not eyeballed.

The map is hand-drawn SVG, so "the streets disappeared" can mean four different
things: the layer is off, the component returned null for this zoom, the city's
street file never loaded, or something opaque is painted on top. This test tells
them apart and prints which one happened, at every zoom a user actually stops at.

    python tools/test_map_layers.py                 # all cases + screenshots
    python tools/test_map_layers.py --url http://localhost:3737
    python tools/test_map_layers.py --only ahvaz

Exit code 1 on any FAIL, so it can gate a commit.
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

SHOTS = os.path.join(_ROOT, "tools", "shots", "layers")

PROBE = r"""() => {
  const svg = document.querySelector('svg');
  const scene = document.querySelector('g#scene');
  const tagged = [...scene.querySelectorAll('[data-layer]')].map((el) => el.getAttribute('data-layer'));
  const kids = [...scene.children].map((el) => {
    const tag = el.tagName.toLowerCase();
    const fill = (el.getAttribute('fill') || '').toLowerCase();
    const stroke = (el.getAttribute('stroke') || '').toLowerCase();
    const imgs = el.querySelectorAll('image').length;
    const rects = el.querySelectorAll('rect').length;
    const paths = el.querySelectorAll('path').length;
    const texts = el.querySelectorAll('text').length;
    let kind = 'other';
    if (imgs > 0) kind = 'satellite';
    else if (texts > 0 && paths === 0 && rects === 0) kind = 'labels';
    else if (rects > 20) kind = 'density';
    else if (stroke === '#8a9bad' || stroke.startsWith('#8a9') || stroke === '#ffffff') {
      if (paths > 0 && rects === 0 && stroke !== '') kind = 'casing-or-street';
    }
    return { tag, kind, imgs, rects, paths, texts, fill, stroke, op: el.getAttribute('opacity') };
  });

  const streetEls = [...svg.querySelectorAll('path')].filter((p) => {
    const s = (p.getAttribute('stroke') || '').toLowerCase();
    return s === '#8a9bad' || s.startsWith('#8a9');
  });
  const streetPaths = streetEls.length;
  const streetSegs = streetEls.reduce((n, p) => n + ((p.getAttribute('d') || '').match(/M/g) || []).length, 0);
  const roadPaths = [...svg.querySelectorAll('path')].filter((p) => {
    const s = (p.getAttribute('stroke') || '').toLowerCase();
    return s === '#94a3b8' || s === '#cbd5e1' || s === '#e2e8f0';
  }).length;
  const cells = [...svg.querySelectorAll('rect')].filter((r) => /^rgb\(/.test(r.getAttribute('fill') || '')).length;
  const pharm = svg.querySelectorAll('path[fill="#d97706"]').length;
  const med = [...svg.querySelectorAll('path,circle')].filter((n) => {
    const f = (n.getAttribute('fill') || '').toLowerCase();
    return f === '#7c3aed' || f === '#0ea5e9';
  }).length;
  const labels = [...svg.querySelectorAll('text')].map((t) => t.textContent.trim()).filter(Boolean);
  const tiles = [...svg.querySelectorAll('image')].map((i) => i.getAttribute('href') || '');
  const g = document.querySelector('g#scene').getAttribute('transform') || '';
  const m = g.match(/scale\(([\d.]+)\)/);
  return {
    k: m ? Number(m[1]) : null,
    streetPaths, streetSegs, roadPaths, cells, pharm, med,
    labels: labels.length,
    labelSample: labels.slice(0, 4),
    tiles: tiles.length,
    tileZoom: tiles.length ? Number((tiles[0].match(/tile\/(\d+)\//) || [0, 0])[1]) : null,
    order: tagged.length ? tagged : kids.map((c) => c.kind).filter((k) => k !== 'other'),
    empty: tagged.filter((name, i) => {
      const g = scene.querySelectorAll('[data-layer]')[i];
      return g.children.length === 0;
    }),
    kids: kids.length,
  };
}"""

# city, lat, lon, zoom, expect streets? (a city with a street file vs open desert)
CASES = [
    ("province",     31.3189, 48.6842,  1.0, False),
    ("ahvaz-3x",     31.3189, 48.6842,  3.3, True),
    ("ahvaz-4x",     31.3189, 48.6842,  4.0, True),
    ("ahvaz-6x",     31.3189, 48.6842,  6.0, True),
    ("ahvaz-12x",    31.3200, 48.6690, 12.0, True),
    ("dezful-9x",    32.3810, 48.4050,  9.0, True),
    ("ramhormoz-9x", 31.2790, 49.6040,  9.0, True),
    ("behbahan-9x",  30.5960, 50.2420,  9.0, True),
    ("desert-9x",    31.9000, 48.1000,  9.0, False),
]


FULLSCREEN_PROBE = r"""() => {
  const svg = document.querySelector('svg');
  const scene = document.querySelector('g#scene');
  const vb = svg.viewBox.baseVal;
  const r = svg.getBoundingClientRect();
  const cells = [...svg.querySelectorAll('rect')].filter((x) => /^rgb\(/.test(x.getAttribute('fill') || ''));
  const inside = cells.filter((c) => {
    const b = c.getBoundingClientRect();
    return b.x > r.x - 2 && b.x < r.right && b.y > r.y - 2 && b.y < r.bottom;
  }).length;
  let cellCover = 0;
  if (cells.length) {
    const bs = cells.map((c) => c.getBoundingClientRect());
    const x0 = Math.min(...bs.map((b) => b.left)), x1 = Math.max(...bs.map((b) => b.right));
    const y0 = Math.min(...bs.map((b) => b.top)), y1 = Math.max(...bs.map((b) => b.bottom));
    cellCover = ((Math.min(x1, r.right) - Math.max(x0, r.x)) * (Math.min(y1, r.bottom) - Math.max(y0, r.y)))
      / (r.width * r.height);
  }
  const streetEls = [...svg.querySelectorAll('path')].filter((p) => {
    const s = (p.getAttribute('stroke') || '').toLowerCase();
    return s === '#8a9bad' || s.startsWith('#8a9');
  });
  const host = svg.parentElement.getBoundingClientRect();
  const imgs = [...svg.querySelectorAll('image')];
  const drawn = imgs.map((i) => i.getBoundingClientRect())
    .filter((b) => b.width > 0 && b.right > r.x && b.left < r.right && b.bottom > r.y && b.top < r.bottom);
  let covered = 0;
  if (drawn.length) {
    const x0 = Math.min(...drawn.map((b) => b.left)), x1 = Math.max(...drawn.map((b) => b.right));
    const y0 = Math.min(...drawn.map((b) => b.top)), y1 = Math.max(...drawn.map((b) => b.bottom));
    covered = ((Math.min(x1, r.right) - Math.max(x0, r.x)) * (Math.min(y1, r.bottom) - Math.max(y0, r.y)))
      / (r.width * r.height);
  }
  return {
    fullscreen: !!document.fullscreenElement,
    hostW: Math.round(host.width), hostH: Math.round(host.height),
    tileCover: Math.round(covered * 100) / 100,
    cellCover: Math.round(cellCover * 100) / 100,
    svgW: Math.round(r.width), svgH: Math.round(r.height),
    vw: window.innerWidth, vh: window.innerHeight,
    aspect: svg.getAttribute('preserveAspectRatio'),
    viewBox: [vb.width, vb.height],
    tagged: [...scene.querySelectorAll('[data-layer]')].map((g) => g.getAttribute('data-layer')),
    cells: cells.length, cellsInView: inside,
    streets: streetEls.reduce((n, p) => n + ((p.getAttribute('d') || '').match(/M/g) || []).length, 0),
    tiles: svg.querySelectorAll('image').length,
    pharm: svg.querySelectorAll('path[fill="#d97706"]').length,
    labels: [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim()).length,
  };
}"""

fails: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        fails.append(label)


def run_case(pg, base: str, name: str, lat: float, lon: float, k: float,
             expect_streets: bool, sat: bool) -> None:
    url = f"{base}/map?lat={lat}&lon={lon}&k={k}"
    pg.goto(url, wait_until="networkidle", timeout=180_000)
    pg.reload(wait_until="networkidle")
    pg.wait_for_selector("g#scene", timeout=120_000)
    pg.wait_for_timeout(1500)

    # satellite is a checkbox in the layer popover
    pg.get_by_text("لایه‌های نقشه").first.click()
    pg.wait_for_timeout(250)
    box = pg.get_by_label("تصویر ماهواره‌ای")
    if sat:
        box.check()
    else:
        box.uncheck()
    pg.wait_for_timeout(4500 if sat else 1200)
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(400)

    d = pg.evaluate(PROBE)
    tag = f"[{name} k={d['k']} sat={'on' if sat else 'off'}]"
    print(f"\n{tag}")

    # the zoom must be what the deep link asked for, or every other check is moot
    check("zoom applied", abs((d["k"] or 0) - k) < 0.6, f"asked {k}, got {d['k']}")

    # layers that must always draw
    check("labels render", d["labels"] > 0, f"{d['labels']} labels")
    check("pharmacy markers render", d["pharm"] > 0, f"{d['pharm']} diamonds")

    # density is on by default and must paint cells at every zoom
    check("density cells render", d["cells"] > 0, f"{d['cells']} cells")

    # streets only exist above 4.5x and only where a city file was fetched
    if expect_streets:
        check("street layer draws", d["streetSegs"] > 50,
              f"{d['streetSegs']} polylines in {d['streetPaths']} paths at k={d['k']}")
    else:
        print(f"  note  streets not expected here ({d['streetPaths']} paths drawn)")

    if sat:
        check("satellite tiles render", d["tiles"] > 0, f"{d['tiles']} tiles z={d['tileZoom']}")
        if expect_streets:
            check("streets survive satellite", d["streetPaths"] > 0,
                  f"{d['streetPaths']} street paths over imagery")

    # paint order: imagery under the data, labels on top. Anything else and a layer
    # is invisible at some zoom without anyone noticing.
    order = d["order"]
    print(f"  paint order: {' → '.join(order[:8])}{' …' if len(order) > 8 else ''}")
    if sat and "satellite" in order:
        sat_i = order.index("satellite")
        check("imagery is painted first", sat_i <= 1, f"index {sat_i}")
    if "labels" in order:
        check("labels are painted last", order.index("labels") >= len(order) - 2,
              f"index {order.index('labels')} of {len(order)}")

    os.makedirs(SHOTS, exist_ok=True)
    shot = os.path.join(SHOTS, f"{name}-sat{sat}.png")
    pg.screenshot(path=shot)




def run_fullscreen(pg, base: str, name: str, lat: float, lon: float, k: float,
                   sat: bool) -> None:
    """Full screen is a different layout: `slice` crops, the element is resized, and
    every layer that caches geometry from client pixels has to recompute."""
    page_url = f"{base}/map?lat={lat}&lon={lon}&k={k}"
    pg.goto(page_url, wait_until="networkidle", timeout=180_000)
    pg.reload(wait_until="networkidle")
    pg.wait_for_selector("g#scene", timeout=120_000)
    pg.wait_for_timeout(1500)

    # Satellite is toggled BEFORE entering full screen: closing the layer popover with
    # Escape also exits full screen (the component listens for Escape), which is how
    # the first version of this test ended up asserting a non-full-screen layout.
    pg.get_by_text("لایه‌های نقشه").first.click()
    pg.wait_for_timeout(250)
    box = pg.get_by_label("تصویر ماهواره‌ای")
    box.check() if sat else box.uncheck()
    pg.wait_for_timeout(4500 if sat else 1200)
    pg.locator("summary", has_text="لایه‌های نقشه").first.click()
    pg.wait_for_timeout(300)

    pg.locator('button[title*="تمام‌صفحه"]').first.click()
    pg.wait_for_timeout(3000)

    d = pg.evaluate(FULLSCREEN_PROBE)
    print(f"[FULLSCREEN {name} k={k} sat={'on' if sat else 'off'}]")
    check("entered full screen", d["fullscreen"])
    check("map fills its container", d["svgW"] >= d["hostW"] - 6 and d["svgH"] >= d["hostH"] - 6,
          f"{d['svgW']}x{d['svgH']} in {d['hostW']}x{d['hostH']}")
    check("cropping mode is slice", d["aspect"] == "xMidYMid slice", str(d["aspect"]))
    check("density cells render", d["cells"] > 0, f"{d['cells']} cells")
    if k >= 1.2:
        check("cells cover the screen (no unloaded band)", d["cellCover"] >= 0.9,
              f"grid spans {int(d['cellCover'] * 100)}% of the map · {d['cellsInView']}/{d['cells']} in view")
    else:
        # province view uses the ETL 3.3 km cells, which only exist where people live
        print(f"  note  province grid is settlement-bounded ({int(d['cellCover'] * 100)}% of the map)")
    if k >= 3.2:
        check("street layer draws", d["streets"] > 50, f"{d['streets']} polylines")
    else:
        print(f"  note  streets start at 3.2x ({d['streets']} polylines here)")
    check("pharmacy markers render", d["pharm"] > 0, f"{d['pharm']} diamonds")
    check("labels render", d["labels"] > 0, f"{d['labels']} labels")
    if sat:
        check("satellite tiles render", d["tiles"] > 0, f"{d['tiles']} tiles")
        check("imagery covers the map (no gaps)", d["tileCover"] >= 0.98,
              f"{int(d['tileCover'] * 100)}% covered")
    print(f"  layers tagged: {' → '.join(d['tagged'])}")

    os.makedirs(SHOTS, exist_ok=True)
    pg.screenshot(path=os.path.join(SHOTS, f"fullscreen-{name}-sat{sat}.png"))

    # Full screen on a different screen is a resize, and every layer that caches
    # geometry from client pixels has to recompute. Same-size full screen proved
    # nothing about that, which is why the bug the user saw never failed here.
    pg.set_viewport_size({"width": 1740, "height": 1180})
    pg.wait_for_timeout(3500)
    d2 = pg.evaluate(FULLSCREEN_PROBE)
    print(f"  after resize to {d2['vw']}x{d2['vh']}:")
    check("still full screen after resize", d2["fullscreen"])
    check("map refills after resize",
          d2["svgW"] >= d2["hostW"] - 6 and d2["svgH"] >= d2["hostH"] - 6,
          f"{d2['svgW']}x{d2['svgH']} in {d2['hostW']}x{d2['hostH']}")
    check("density cells survive resize", d2["cells"] > 0, f"{d2['cells']} cells")
    check("streets survive resize", d2["streets"] > 50 or k < 3.2, f"{d2['streets']} polylines")
    check("markers survive resize", d2["pharm"] > 0, f"{d2['pharm']} diamonds")
    if sat:
        check("imagery covers the resized map", d2["tileCover"] >= 0.98,
              f"{int(d2['tileCover'] * 100)}% covered · {d2['tiles']} tiles")
    pg.screenshot(path=os.path.join(SHOTS, f"fullscreen-{name}-resized.png"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3737")
    ap.add_argument("--only", default=None)
    ap.add_argument("--fullscreen", action="store_true", help="full-screen cases only")
    args = ap.parse_args()

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 1000})
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        if args.fullscreen:
            for name, lat, lon, k, _streets, sat in (
                ("ahvaz-12x", 31.3200, 48.6690, 12.0, True, False),
                ("ahvaz-12x", 31.3200, 48.6690, 12.0, True, True),
                ("dezful-9x", 32.3810, 48.4050, 9.0, True, True),
                ("province", 31.3189, 48.6842, 1.0, False, True),
            ):
                run_fullscreen(pg, args.url, name, lat, lon, k, sat)
        else:
            for name, lat, lon, k, streets in CASES:
                if args.only and args.only not in name:
                    continue
                run_case(pg, args.url, name, lat, lon, k, streets, sat=False)
                if name in ("ahvaz-3x", "ahvaz-12x", "dezful-9x", "province"):
                    run_case(pg, args.url, name, lat, lon, k, streets, sat=True)
        check("no page errors", not errs, "; ".join(errs[:2]))
        br.close()

    print()
    if fails:
        print(f"RESULT: {len(fails)} check(s) FAILED — {sorted(set(fails))}")
        return 1
    print("RESULT: every layer draws, in the right order, at every test zoom")
    return 0


if __name__ == "__main__":
    sys.exit(main())
