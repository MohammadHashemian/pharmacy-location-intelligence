"use client";

/**
 * Shared chart primitives.
 *
 * WHY THIS EXISTS: the first version of these charts drew a fixed `viewBox` and
 * stretched it with `w-full`. An SVG viewBox scales EVERYTHING — including
 * `font-size`, which is specified in user units — so the effective type size
 * became `fontSize × (containerWidth / viewBoxWidth)`. Measured on the running
 * app at a 1680 px window:
 *
 *   scatter   viewBox 760  -> rendered 1478 px  -> scale 1.95 -> 19–21 px text
 *   histogram viewBox 620  -> rendered  710 px  -> scale 1.15 -> 11–12 px text
 *
 * Two charts in the same card stack, 1.8× apart in type size, and both drifting
 * with the window (the scatter's axis labels were 8 px on a 620 px window and
 * 21 px on a 1680 px one). The fix is to stop scaling: measure the container
 * and draw in CSS pixels, so 11 means 11 px at every width.
 */

import { useEffect, useRef, useState } from "react";

/**
 * Content width of a container, in CSS pixels. Starts at `fallback` (the
 * server render has no layout) and settles on the real value in an effect.
 */
export function useMeasure<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Linear-interpolated quantile of an ASCENDING array. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** 1 / 2 / 5 × 10ⁿ — the nice step NEAREST to `raw` (so an axis is not padded
 *  up to the next step when the closer one fits). */
export function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const n = raw / mag;
  const s = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return s * mag;
}

/**
 * A robust upper bound for a heavy-tailed axis.
 *
 * Pharmacy density is extremely skewed — in the default universe (348 places,
 * ≥ 20k people) the median is 28 per 100k but the single highest value is 293.
 * Scaling the y-axis to that one point pushed every other bubble into the
 * bottom 15 % of the plot. Clipping at the 99th percentile leaves ~3 outliers,
 * which are drawn at the top edge with an explicit marker and counted in the
 * footer, so nothing is hidden and nothing is compressed.
 */
export function robustMax(
  values: number[],
  { q = 0.99, pad = 1.05, floor = 10 }: { q?: number; pad?: number; floor?: number } = {},
): { max: number; step: number; p: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const p = sorted.length ? quantile(sorted, q) : floor;
  const target = Math.max(p * pad, floor);
  const step = niceStep(target / 6);
  return { max: Math.ceil(target / step) * step, step, p };
}

/** Log-spaced tick candidates for a population-style x-axis. */
export function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  for (let e = 3; e <= 8; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}
