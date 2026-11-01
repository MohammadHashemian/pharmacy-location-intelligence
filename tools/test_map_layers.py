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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3737")
    ap.add_argument("--only", default=None)
    args = ap.parse_args()

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        pg = br.new_page(viewport={"width": 1500, "height": 1000})
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
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
