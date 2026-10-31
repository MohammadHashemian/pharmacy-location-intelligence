"use client";

import { useMemo, useState } from "react";
import type { ScoredPlace } from "@/lib/analytics";
import { group, num, shortPlace, tick } from "@/lib/format";
import {
  clamp,
  logTicks,
  quantile,
  robustMax,
  useMeasure,
} from "./chartkit";
import { Card, Legend, SectionTitle } from "./ui";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Linear colour ramp: red (low) -> amber -> teal -> green (high). */
export function scoreColor(v: number, alpha = 1): string {
  const t = Math.max(0, Math.min(1, v / 100));
  const stops: [number, number[]][] = [
    [0.0, [225, 29, 72]],
    [0.35, [217, 119, 6]],
    [0.6, [13, 148, 136]],
    [1.0, [5, 150, 105]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const k = (t - a[0]) / span;
  const c = a[1].map((av, i) => Math.round(av + (b[1][i] - av) * k));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/**
 * One typographic scale for every chart, in CSS pixels. Deliberately sits one
 * notch below the dashboard's body copy (12.5 px) so a chart never shouts
 * louder than the table it summarises.
 */
const TYPE = {
  tick: 11,
  caption: 11.5,
  note: 11,
  strong: 11.5,
} as const;

/** A city large enough to sustain a real urban pharmacy market. */
const URBAN_POP = 100_000;

/* -------------------------------------------------------------------------- */
/* 1. Population vs density scatter — the core "where is the white space" plot */
/* -------------------------------------------------------------------------- */

export function ScatterChart({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ScoredPlace[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const [hover, setHover] = useState<ScoredPlace | null>(null);
  const [wrapRef, cw] = useMeasure<HTMLDivElement>(1160);

  const W = Math.max(300, cw);
  const H = Math.round(clamp(W * 0.36, 340, 520));
  const M = { top: 22, right: 26, bottom: 44, left: 58 };
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;

  const geo = useMemo(() => {
    const pts = rows.filter((r) => (r.population ?? 0) > 0);
    if (!pts.length || pw <= 0) return null;

    const pops = pts.map((r) => r.population as number);
    const dens = pts.map((r) => r.pharmacies_per_100k ?? 0);

    const lo = Math.min(...pops);
    const hi = Math.max(...pops);
    // A hair of padding in log space only — enough that a marker is not sliced
    // by the frame, small enough that the top decade's tick label stays inside.
    const pad = 0.025;
    const logMin = Math.log10(lo) - pad;
    const logMax = Math.log10(hi) + pad;

    // Robust y-domain: the raw maximum (293/100k) is a 10× outlier that would
    // flatten every other bubble onto the axis. Clip near the top and say so.
    const y = robustMax(dens);

    const pipeMax = Math.max(...pts.map((r) => r.n_req_pipeline), 1);
    const median = quantile([...dens].sort((a, b) => a - b), 0.5);

    const over = pts.filter((r) => (r.pharmacies_per_100k ?? 0) > y.max);
    const white = pts.filter(
      (r) =>
        (r.population as number) >= URBAN_POP &&
        (r.pharmacies_per_100k ?? 0) < median,
    );

    // Big bubbles first, so a 1-applicant village is never buried under a
    // 12-applicant city.
    const draw = [...pts].sort(
      (a, b) => (b.n_req_pipeline ?? 0) - (a.n_req_pipeline ?? 0),
    );

    return { pts, draw, logMin, logMax, y, pipeMax, median, over, white };
  }, [rows, pw]);

  if (!geo) {
    return (
      <Card>
        <SectionTitle title="نمودار پراکندگی" hint="دادهای برای نمایش نیست" />
      </Card>
    );
  }

  const { pts, draw, logMin, logMax, y, pipeMax, median, over, white } = geo;
  const span = Math.max(logMax - logMin, 1e-9);
  const xOf = (v: number) =>
    M.left + ((Math.log10(Math.max(v, 1)) - logMin) / span) * pw;
  const yOf = (d: number) =>
    M.top + ph - (clamp(d, 0, y.max) / y.max) * ph;

  /**
   * Radius, LOG-scaled. The applicant queue runs 1 → 1,932 (Tehran) with a
   * median of 12, so a linear or square-root ramp made 347 of 348 bubbles the
   * same 3.5 px dot and the chart's third dimension said nothing. A log ramp
   * keeps every decade distinguishable while staying monotonic.
   */
  const logPipe = Math.max(Math.log10(1 + pipeMax), 1e-6);
  const rOf = (pipe: number) =>
    3 + (Math.log10(1 + Math.max(pipe, 0)) / logPipe) * 8;
  /** Decade ladder for the size legend. */
  const pipeLegend = [1, 10, 100, 1000].filter((v) => v <= pipeMax);

  const xTicks = logTicks(Math.pow(10, logMin), Math.pow(10, logMax));
  const yTicks: number[] = [];
  for (let t = 0; t <= y.max + 1e-9; t += y.step) yTicks.push(Number(t.toFixed(6)));

  const regionX = xOf(URBAN_POP);
  const showRegion = regionX > M.left + 90 && regionX < M.left + pw - 60;

  return (
    <Card padded={false} className="p-4 sm:p-5">
      <SectionTitle
        title="جمعیت در برابر اشباع (داروخانه در ۱۰۰ هزار نفر)"
        hint="هدف، ناحیهٔ راست‌پایین است: بازار بزرگ با عرضهٔ کمتر از میانه. اندازهٔ دایره = صف متقاضیان، رنگ = امتیاز فرصت."
        right={
          <Legend
            items={[
              { label: "فرصت بالا", color: scoreColor(90) },
              { label: "میانه", color: scoreColor(50) },
              { label: "فرصت پایین", color: scoreColor(12) },
            ]}
          />
        }
      />

      <div ref={wrapRef} className="relative" dir="ltr">
        <svg
          width={W}
          height={H}
          role="img"
          aria-label="نمودار پراکندگی جمعیت و اشباع داروخانه"
        >
          {/* plot frame */}
          <rect
            x={M.left}
            y={M.top}
            width={pw}
            height={ph}
            fill="var(--color-surface-2)"
            stroke="var(--color-line)"
            rx={8}
          />

          {/* the quadrant the tool exists to find: big market, thin supply */}
          {showRegion ? (
            <rect
              x={regionX}
              y={yOf(median)}
              width={M.left + pw - regionX}
              height={M.top + ph - yOf(median)}
              fill="var(--color-good)"
              fillOpacity={0.07}
              stroke="var(--color-good)"
              strokeOpacity={0.35}
              strokeDasharray="5 4"
              rx={6}
            />
          ) : null}

          {/* y gridlines */}
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={M.left}
                x2={M.left + pw}
                y1={yOf(t)}
                y2={yOf(t)}
                stroke="var(--color-line)"
                strokeDasharray="3 3"
              />
              <text
                x={M.left - 8}
                y={yOf(t) + 3.8}
                textAnchor="end"
                fontSize={TYPE.tick}
                fill="var(--color-faint)"
                className="tnum"
              >
                {tick(t)}
              </text>
            </g>
          ))}

          {/* x gridlines + labels. The outermost labels are pinned to the plot
              edge (start/end) so the leftmost one cannot grow under the y-axis
              numbers and the rightmost cannot run past the frame. */}
          {xTicks.map((t, i) => (
            <g key={`x${t}`}>
              <line
                x1={xOf(t)}
                x2={xOf(t)}
                y1={M.top}
                y2={M.top + ph}
                stroke="var(--color-line)"
                strokeDasharray="3 3"
              />
              <text
                x={xOf(t)}
                y={M.top + ph + 17}
                textAnchor={
                  i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"
                }
                fontSize={TYPE.tick}
                fill="var(--color-faint)"
                className="tnum"
              >
                {tick(t)}
              </text>
            </g>
          ))}

          {/* median density of the comparison set */}
          {median > 0 && median <= y.max ? (
            <g>
              <line
                x1={M.left}
                x2={M.left + pw}
                y1={yOf(median)}
                y2={yOf(median)}
                stroke="var(--color-accent)"
                strokeWidth={1.4}
                strokeDasharray="6 4"
              />
            </g>
          ) : null}

          {/* axis captions */}
          <text
            x={M.left + pw / 2}
            y={H - 8}
            textAnchor="middle"
            fontSize={TYPE.caption}
            fill="var(--color-muted)"
          >
            جمعیت (مقیاس لگاریتمی)
          </text>
          <text
            x={13}
            y={M.top + ph / 2}
            textAnchor="middle"
            fontSize={TYPE.caption}
            fill="var(--color-muted)"
            transform={`rotate(-90 13 ${M.top + ph / 2})`}
          >
            داروخانه در ۱۰۰ هزار نفر
          </text>

          {/* markers are clipped to the plot rect: a bubble sitting at density
              ≈ 0 must not spill across the axis and onto the tick labels */}
          <clipPath id="scatter-plot-clip">
            <rect x={M.left} y={M.top} width={pw} height={ph} rx={8} />
          </clipPath>

          {/* points */}
          <g clipPath="url(#scatter-plot-clip)">
            {draw.map((r) => {
              const cx = xOf(r.population as number);
              const d = r.pharmacies_per_100k ?? 0;
              const sel = r.location_id === selectedId;

              // Above the clipped axis: mark the position honestly at the top
              // edge instead of drawing it at a y it does not have.
              if (d > y.max) {
                return (
                  <polygon
                    key={r.location_id}
                    points={`${cx},${M.top + 9} ${cx - 5},${M.top + 1} ${cx + 5},${M.top + 1}`}
                    fill={scoreColor(r.scores.opportunity, 0.85)}
                    stroke={sel ? "var(--color-ink)" : "rgba(255,255,255,0.9)"}
                    strokeWidth={sel ? 2 : 0.8}
                    className="cursor-pointer"
                    onClick={() => onSelect(r.location_id)}
                  >
                    <title>{`${shortPlace(r.place)} — ${num(d, 1)} داروخانه در ۱۰۰ هزار (فراتر از محور)، جمعیت ${group(r.population)}`}</title>
                  </polygon>
                );
              }

              const rad = rOf(r.n_req_pipeline);
              return (
                <circle
                  key={r.location_id}
                  cx={cx}
                  cy={yOf(d)}
                  r={sel ? rad + 1.5 : rad}
                  fill={scoreColor(r.scores.opportunity, sel ? 0.95 : 0.55)}
                  stroke={sel ? "var(--color-ink)" : "rgba(255,255,255,0.85)"}
                  strokeWidth={sel ? 2 : 0.8}
                  className="cursor-pointer"
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onSelect(r.location_id)}
                >
                  <title>{`${shortPlace(r.place)} — جمعیت ${group(
                    r.population,
                  )}، ${num(d, 1)} داروخانه در ۱۰۰هزار، امتیاز ${num(
                    r.scores.opportunity,
                    1,
                  )}`}</title>
                </circle>
              );
            })}
          </g>

          {/* in-plot annotations, drawn AFTER the cloud so the halo wins */}
          {median > 0 && median <= y.max ? (
            <text
              x={M.left + 6}
              y={yOf(median) - 6}
              textAnchor="start"
              fontSize={TYPE.note}
              fontWeight={600}
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth={3}
              paintOrder="stroke"
              className="tnum"
            >
              {`میانهٔ مجموعهٔ مقایسه: ${num(median, 1)}`}
            </text>
          ) : null}
          {showRegion ? (
            <text
              x={M.left + pw - 10}
              y={yOf(median) + 16}
              textAnchor="end"
              fontSize={TYPE.note}
              fontWeight={600}
              fill="var(--color-good)"
              stroke="var(--color-surface)"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {`فضای خالی بازار: ${group(white.length)} آبادی بالای ${tick(URBAN_POP)} با عرضهٔ زیر میانه`}
            </text>
          ) : null}

          {/* selected label, nudged inside the frame when the point sits high */}
          {(() => {
            const r = pts.find((p) => p.location_id === selectedId);
            if (!r) return null;
            const cx = clamp(xOf(r.population as number), M.left + 40, M.left + pw - 40);
            const cy = yOf(r.pharmacies_per_100k ?? 0);
            const up = cy - rOf(r.n_req_pipeline) - 8 > M.top + 12;
            return (
              <text
                x={cx}
                y={up ? cy - rOf(r.n_req_pipeline) - 7 : cy + rOf(r.n_req_pipeline) + 14}
                textAnchor="middle"
                fontSize={TYPE.strong}
                fontWeight={600}
                fill="var(--color-ink)"
                stroke="var(--color-surface)"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {shortPlace(r.place)}
              </text>
            );
          })()}
        </svg>

        {/* hover readout — an opaque chip, not loose text over the cloud */}
        {hover ? (
          <div
            className="pointer-events-none absolute rounded-lg border border-line bg-surface/95 px-2.5 py-1.5 shadow-sm backdrop-blur-sm"
            style={{ left: M.left + 10, top: M.top + 8, maxWidth: pw - 20 }}
            dir="rtl"
          >
            <div className="text-[12px] font-semibold text-ink">
              {hover.place} · {hover.county}
            </div>
            <div className="tnum mt-0.5 text-[11px] text-muted">
              {`جمعیت ${group(hover.population)} · ${num(
                hover.pharmacies_per_100k,
                1,
              )} در ۱۰۰هزار · ${group(hover.n_pharmacy_total)} داروخانه · صف ${group(
                hover.n_req_pipeline,
              )} · امتیاز ${num(hover.scores.opportunity, 1)}`}
            </div>
          </div>
        ) : null}
      </div>

      {/* read-me strip: what the circle size means, and what the axis cut off */}
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-2.5 text-[11.5px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="text-faint">
            اندازهٔ دایره = صف متقاضیان (مقیاس لگاریتمی):
          </span>
          {pipeLegend.map((v) => (
            <span key={v} className="flex items-center gap-1">
              <span
                className="inline-block rounded-full border border-line bg-surface-2 align-middle"
                style={{ width: rOf(v) * 2, height: rOf(v) * 2 }}
              />
              <span className="tnum">{group(v)}</span>
            </span>
          ))}
        </span>
        {over.length ? (
          <span className="flex items-center gap-1 text-warn">
            <svg width="11" height="10" viewBox="0 0 11 10" aria-hidden>
              <polygon points="5.5,9.5 0,0.5 11,0.5" fill="currentColor" />
            </svg>
            <span className="tnum">{group(over.length)}</span> آبادی فراتر از
            محور (تا{" "}
            <b className="tnum">
              {num(Math.max(...over.map((r) => r.pharmacies_per_100k ?? 0)), 1)}
            </b>{" "}
            در ۱۰۰ هزار) — روی خط بالای محور نشان داده شده‌اند
          </span>
        ) : null}
        <span className="tnum ms-auto text-faint">
          {group(pts.length)} آبادی · بیشترین صف {group(pipeMax)} · محور عمودی
          تا {tick(y.max)}
        </span>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Top-N bars                                                              */
/* -------------------------------------------------------------------------- */

export function TopBars({
  rows,
  selectedId,
  onSelect,
  n = 15,
}: {
  rows: ScoredPlace[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  n?: number;
}) {
  const top = rows.slice(0, n);
  if (!top.length) return null;
  const max = Math.max(...top.map((r) => r.scores.opportunity), 1);

  return (
    <Card>
      <SectionTitle
        title={`${group(n)} آبادی برتر بر اساس امتیاز فرصت`}
        hint="طول میله = امتیاز فرصت (۰–۱۰۰). برای جزئیات کلیک کنید."
      />
      <div className="space-y-1.5">
        {top.map((r) => {
          const sel = r.location_id === selectedId;
          return (
            <button
              key={r.location_id}
              type="button"
              onClick={() => onSelect(r.location_id)}
              className={`group flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-right transition ${
                sel ? "bg-brand-soft" : "hover:bg-surface-2"
              }`}
            >
              <span className="tnum w-5 shrink-0 text-[11px] font-semibold text-faint">
                {group(r.rank)}
              </span>
              <span className="w-28 shrink-0 truncate text-[12px] font-medium text-ink">
                {shortPlace(r.place)}
              </span>
              <span className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-line">
                <span
                  className="block h-full rounded transition-all"
                  style={{
                    width: `${(r.scores.opportunity / max) * 100}%`,
                    background: scoreColor(r.scores.opportunity),
                  }}
                />
              </span>
              <span className="tnum w-9 shrink-0 text-left text-[11.5px] font-semibold text-brand-ink">
                {num(r.scores.opportunity, 1)}
              </span>
              <span className="tnum hidden w-24 shrink-0 text-left text-[11px] text-muted sm:block">
                {group(r.population)}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Density histogram                                                       */
/* -------------------------------------------------------------------------- */

export function DensityHistogram({ rows }: { rows: ScoredPlace[] }) {
  const [wrapRef, cw] = useMeasure<HTMLDivElement>(560);

  const W = Math.max(260, cw);
  const H = Math.round(clamp(W * 0.4, 250, 320));
  // The top margin is a dedicated annotation band: the median callout lives on
  // its own baseline above the row of bar-count labels, so the two can never
  // collide even when the median falls inside the tallest bin.
  const M = { top: 42, right: 14, bottom: 44, left: 42 };
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;

  const bins = useMemo(() => {
    // Same universe as the scatter: a place published with 0 people has no
    // meaningful density, and letting those rows in added a fake spike at the
    // left edge of the axis plus a median that disagreed with the scatter's.
    const usable = rows.filter((r) => (r.population ?? 0) > 0);
    const vals = usable
      .map((r) => r.pharmacies_per_100k ?? 0)
      .filter((v) => v >= 0);
    if (!vals.length || pw <= 0) return null;

    // Same heavy tail as the scatter: 12 equal bins over 0..293 puts 90 % of
    // the set in the first two columns. Bin over the robust range instead and
    // give everything above it one explicit overflow column.
    const { max: edge } = robustMax(vals);
    const nBins = 12;
    const binW = edge / nBins; // bin width in VALUE units
    const counts = new Array(nBins + 1).fill(0) as number[];
    const edges = new Array(nBins + 1).fill(0) as number[];
    for (let i = 0; i <= nBins; i++) edges[i] = i * binW;
    vals.forEach((v) => {
      const i =
        v >= edge ? nBins : Math.min(nBins - 1, Math.floor(v / Math.max(binW, 1e-9)));
      counts[i]++;
    });

    const sorted = [...vals].sort((a, b) => a - b);
    const med = quantile(sorted, 0.5);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return {
      counts,
      edges,
      binW,
      edge,
      nBins,
      med,
      mean,
      n: vals.length,
      dropped: rows.length - vals.length,
      overflow: vals.filter((v) => v >= edge).length,
      peak: Math.max(...counts, 1),
    };
  }, [rows, pw]);

  if (!bins) return null;

  const pxW = pw / (bins.nBins + 1); // column width in PIXELS
  const peak = bins.peak;

  return (
    <Card>
      <SectionTitle
        title="توزیع اشباع در مجموعهٔ مقایسه"
        hint="ستون خط‌چین = میانه. اگر آبادی شما چپِ میانه باشد، نسبت به هم‌رده‌هایش کم‌داروخانه‌تر است."
      />
      <div ref={wrapRef} dir="ltr">
        <svg width={W} height={H} role="img" aria-label="توزیع اشباع داروخانه">
          {bins.counts.map((c, i) => {
            const h = (c / peak) * ph;
            const x = M.left + i * pxW;
            const isOver = i === bins.nBins;
            const lo = isOver ? bins.edge : bins.edges[i];
            const hi = isOver ? null : bins.edges[i + 1];
            return (
              <g key={i}>
                <rect
                  x={x + 1.5}
                  y={M.top + ph - h}
                  width={Math.max(pxW - 3, 1)}
                  height={h}
                  rx={3}
                  fill={isOver ? "var(--color-warn)" : "var(--color-brand)"}
                  opacity={isOver ? 0.75 : 0.8}
                >
                  <title>
                    {isOver
                      ? `بیش از ${tick(lo)}: ${group(c)} آبادی`
                      : `${tick(Math.round(lo))}–${tick(Math.round(hi as number))}: ${group(c)} آبادی`}
                  </title>
                </rect>
                {c ? (
                  <text
                    x={x + pxW / 2}
                    y={M.top + ph - h - 5}
                    textAnchor="middle"
                    fontSize={TYPE.tick}
                    fill="var(--color-muted)"
                    className="tnum"
                  >
                    {group(c)}
                  </text>
                ) : null}
              </g>
            );
          })}

          <line
            x1={M.left}
            x2={M.left + pw}
            y1={M.top + ph}
            y2={M.top + ph}
            stroke="var(--color-line-strong)"
          />

          {/* x ticks ride the bin EDGES, so a label always sits on a boundary */}
          {bins.edges.map((e, i) =>
            i % 3 === 0 && i < bins.nBins ? (
              <text
                key={`t${i}`}
                x={M.left + i * pxW}
                y={M.top + ph + 16}
                textAnchor="middle"
                fontSize={TYPE.tick}
                fill="var(--color-faint)"
                className="tnum"
              >
                {tick(Math.round(e))}
              </text>
            ) : null,
          )}
          <text
            x={M.left + bins.nBins * pxW + pxW / 2}
            y={M.top + ph + 16}
            textAnchor="middle"
            fontSize={TYPE.tick}
            fill="var(--color-warn)"
            className="tnum"
          >
            {`${tick(Math.round(bins.edge))}+`}
          </text>

          {bins.med > 0 && bins.med <= bins.edge ? (
            <g>
              <line
                x1={M.left + (bins.med / bins.binW) * pxW}
                x2={M.left + (bins.med / bins.binW) * pxW}
                y1={M.top}
                y2={M.top + ph}
                stroke="var(--color-accent)"
                strokeDasharray="5 4"
                strokeWidth={1.4}
              />
              <text
                x={clamp(
                  M.left + (bins.med / bins.binW) * pxW,
                  M.left + 26,
                  M.left + pw - 26,
                )}
                y={M.top - 22}
                textAnchor="middle"
                fontSize={TYPE.note}
                fill="var(--color-accent)"
                className="tnum"
              >
                {`میانه ${num(bins.med, 1)}`}
              </text>
            </g>
          ) : null}

          <text
            x={M.left + pw / 2}
            y={H - 8}
            textAnchor="middle"
            fontSize={TYPE.caption}
            fill="var(--color-muted)"
          >
            داروخانه در ۱۰۰ هزار نفر
          </text>
        </svg>
      </div>
      <p className="mt-1.5 border-t border-line pt-2 text-[11.5px] leading-4 text-faint">
        میانگین: <b className="tnum">{num(bins.mean, 1)}</b> · میانه:{" "}
        <b className="tnum">{num(bins.med, 1)}</b> · تعداد آبادی:{" "}
        <b className="tnum">{group(bins.n)}</b>
        {bins.overflow ? (
          <>
            {" "}
            · <b className="tnum text-warn">{group(bins.overflow)}</b> آبادی
            فراتر از {tick(Math.round(bins.edge))} (ستون نارنجی)
          </>
        ) : null}
        {bins.dropped ? (
          <> · {group(bins.dropped)} ردیف بدون جمعیت قابل استفاده کنار گذاشته شد</>
        ) : null}
      </p>
    </Card>
  );
}
