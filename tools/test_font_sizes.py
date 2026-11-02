"""Type size must not depend on the container.

Reported: in full screen some labels become huge and overlap. The cause was unit maths —
text is drawn in scene units and counter-scaled by the zoom, which is only correct while the
SVG renders at its natural size. Full screen stretches the viewBox across the screen, so
`12 / k` units became 2-3x that many pixels.

This measures the *rendered* height of every text layer at several zooms, in a normal window
and in full screen, and asserts:

  * every label sits in a readable band (6-18 px tall);
  * switching to full screen does not change it by more than 25 %;
  * zooming does not change it either.

    python tools/test_font_sizes.py [--shots]
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../src")
from fetch_zarfiat import find_local_chromium  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "http://localhost:3737"
LAYERS = ["labels", "hoods", "sites", "surveys", "measures", "prospects"]
ZOOMS = [2, 6, 12, 20, 40]

JS = """(layers) => {
  const out = {};
  for (const name of layers) {
    const texts = [...document.querySelectorAll(`g[data-layer="${name}"] text`)];
    const hs = texts
      .map((t) => t.getBoundingClientRect().height)
      .filter((h) => h > 0.5 && h < 200);
    out[name] = hs.length ? { n: hs.length, median: +statistics(hs) } : { n: 0 };
  }
  return out;
  function statistics(a) {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }
}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", action="store_true")
    args = ap.parse_args()

    ok = True
    seen: list[tuple[str, int, str, float]] = []

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True, executable_path=find_local_chromium())
        for mode, viewport in (("normal", {"width": 1200, "height": 900}),
                               ("wide", {"width": 1900, "height": 1000})):
            pg = br.new_page(viewport=viewport)
            for k in ZOOMS:
                pg.goto(f"{BASE}/map?lat=31.30&lon=48.66&k={k}", wait_until="domcontentloaded",
                        timeout=120000)
                pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
                pg.wait_for_timeout(1600)
                got = pg.evaluate(JS, LAYERS)
                for layer, v in got.items():
                    if not v["n"]:
                        continue
                    seen.append((mode, k, layer, v["median"]))
                    print(f"  {mode:6s} k={k:<3d} {layer:9s} n={v['n']:<4d} median {v['median']:.1f} px")

                if args.shots and mode == "wide":
                    pg.screenshot(path=f"tools/shots/font-k{k}.png")

            # real full screen, if this browser grants it
            pg.goto(f"{BASE}/map?lat=31.30&lon=48.66&k=12", wait_until="domcontentloaded",
                    timeout=120000)
            pg.wait_for_selector('g#scene[data-ready="1"]', timeout=60000)
            pg.wait_for_timeout(1500)
            pg.locator('button[aria-label="تمام‌صفحه"]').click()
            pg.wait_for_timeout(1500)
            is_full = pg.evaluate("() => !!document.fullscreenElement")
            got = pg.evaluate(JS, LAYERS)
            for layer, v in got.items():
                if not v["n"]:
                    continue
                seen.append(("full", 12, layer, v["median"]))
                print(f"  full   k=12  {layer:9s} n={v['n']:<4d} median {v['median']:.1f} px")
            print(f"  fullscreen granted by the browser: {is_full}")
            if args.shots:
                pg.screenshot(path="tools/shots/font-full.png")
            pg.close()
        br.close()

    print()
    med = [s[3] for s in seen]
    check("every text layer renders in a readable band", all(6 <= m <= 18 for m in med),
          f"{min(med):.1f}-{max(med):.1f} px across {len(med)} measurements")
    check("no layer is wildly larger than the others",
          max(med) / min(med) <= 2.6, f"ratio {max(med) / min(med):.2f}")

    # zoom independence, per layer and mode
    for layer in LAYERS:
        rows = [s for s in seen if s[2] == layer]
        if len(rows) < 3:
            continue
        vals = [r[3] for r in rows]
        check(f"{layer}: size does not follow the zoom",
              max(vals) / min(vals) <= 1.35, f"{min(vals):.1f}-{max(vals):.1f} px")

    # full screen vs the same zoom in a window
    for layer in LAYERS:
        normal = [s[3] for s in seen if s[2] == layer and s[0] == "wide" and s[1] == 12]
        full = [s[3] for s in seen if s[2] == layer and s[0] == "full"]
        if not normal or not full:
            continue
        ratio = full[0] / normal[0]
        check(f"{layer}: full screen is not larger", ratio <= 1.25,
              f"{normal[0]:.1f} → {full[0]:.1f} px ({ratio:.2f}x)")

    print("\nRESULT:", "type size is container-independent" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
