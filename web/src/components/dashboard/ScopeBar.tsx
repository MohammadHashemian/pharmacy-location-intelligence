"use client";

import type { DashboardData } from "@/lib/data";
import type { Tunables, Weights } from "@/lib/analytics";
import { group, num } from "@/lib/format";
import { Button, Card } from "../ui";
import { PRESETS, wPct, type Preset } from "../Controls";

/** Sentinel for "every province" in the province select. */
export const ALL_PROVINCES = "__all__";

const BASIS = [
  { id: "national", label: "کل کشور" },
  { id: "province", label: "داخل هر استان" },
] as const;

const WEIGHTS: { key: keyof Weights; label: string }[] = [
  { key: "demand", label: "بازار" },
  { key: "headroom", label: "ظرفیت" },
  { key: "tolerance", label: "تحمل" },
  { key: "pipeline", label: "صف" },
  { key: "barrier", label: "سد اداری" },
  { key: "affluence", label: "برخورداری" },
];

/* One chip style for every toggle in the bar; `warn` marks the flagged-rows
   switch so its "on" state reads as a caution, not a selection. */
function chip(on: boolean, tone: "brand" | "warn" = "brand") {
  const onStyle =
    tone === "warn"
      ? "border-warn/40 bg-warn-soft/60 text-warn"
      : "border-brand/40 bg-brand-soft text-brand-ink";
  return `rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
    on
      ? onStyle
      : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
  }`;
}

const Divider = () => (
  <span className="mx-1 hidden h-4 w-px bg-line-strong sm:block" />
);

/**
 * The always-visible scoping bar: which places are compared (province, flags,
 * sibling unwrap), against what (basis), and the one-click presets. The second
 * row reads back the live weights so the presets are never a black box.
 */
export function ScopeBar({
  provinces,
  provinceCount,
  candidateCount,
  province,
  onProvince,
  tunables,
  onTunables,
  activePreset,
  onPreset,
  flagCount,
  unwrappedCount,
  showSettings,
  onOpenSettings,
}: {
  provinces: DashboardData["provinces"];
  provinceCount: number;
  candidateCount: number;
  province: string;
  onProvince: (p: string) => void;
  tunables: Tunables;
  onTunables: (t: Tunables) => void;
  activePreset: string | null;
  onPreset: (p: Preset) => void;
  flagCount: number;
  unwrappedCount: number;
  showSettings: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <Card className="no-print mt-2 space-y-2 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <label htmlFor="scope-province" className="text-[11px] font-medium text-muted">
          استان:
        </label>
        <select
          id="scope-province"
          value={province}
          onChange={(e) => onProvince(e.target.value)}
          className="max-w-52 rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11.5px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        >
          <option value={ALL_PROVINCES}>
            همهٔ {group(provinceCount)} استان ({group(candidateCount)})
          </option>
          {provinces.map((p) => (
            <option key={p.province} value={p.province}>
              {p.province.replace(/^استان\s+/, "")} ({group(p.n_places)})
            </option>
          ))}
        </select>

        <Divider />

        {/* Nothing is hidden by default. This is the user's explicit choice to
            narrow the list, not a silent filter. */}
        <button
          type="button"
          onClick={() =>
            onTunables({ ...tunables, showFlagged: !tunables.showFlagged })
          }
          aria-pressed={tunables.showFlagged}
          title={
            tunables.showFlagged
              ? "همهٔ آبادی‌ها نمایش داده می‌شوند؛ موارد مشکوک با نشان هشدار مشخص‌اند"
              : "آبادی‌های دارای هشدار پنهان شده‌اند — با کلیک دوباره برگردانید"
          }
          className={chip(tunables.showFlagged, "warn")}
        >
          {tunables.showFlagged ? "◉" : "◌"} نمایش موارد مشکوک
        </button>
        {flagCount > 0 ? (
          <span className="tnum text-[11px] text-faint">
            ({group(flagCount)} ردیف نشان‌دار)
          </span>
        ) : null}

        {/* Unwrap: a city's county family lives only inside its detail panel by
            default. This pulls the family into the table as ordinary rows. */}
        <button
          type="button"
          onClick={() =>
            onTunables({ ...tunables, unwrapSiblings: !tunables.unwrapSiblings })
          }
          aria-pressed={tunables.unwrapSiblings}
          title={
            tunables.unwrapSiblings
              ? "همهٔ شهرهای هم‌شهرستان نمایش داده می‌شوند — با کلیک دوباره ببندید"
              : "شهرهای هم‌شهرستان (خانوادهٔ هر شهر) را به‌جای پنل، به‌صورت ردیف در همین جدول باز کن تا همه را کنار هم مقایسه کنی"
          }
          className={chip(tunables.unwrapSiblings)}
        >
          {tunables.unwrapSiblings ? "⊟" : "⊞"} بازکردن همهٔ شهرهای هم‌شهرستان
        </button>
        {tunables.unwrapSiblings ? (
          <span className="tnum text-[11px] text-faint">
            ({group(unwrappedCount)} شهر هم‌خانواده به جدول افزوده شد)
          </span>
        ) : null}

        <Divider />

        <span className="text-[11px] font-medium text-muted">مبنای مقایسه:</span>
        <div className="flex gap-1" role="group" aria-label="مبنای مقایسه">
          {BASIS.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={tunables.basis === b.id}
              onClick={() => onTunables({ ...tunables, basis: b.id })}
              className={chip(tunables.basis === b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>

        <Divider />

        <div className="flex flex-wrap gap-1" role="group" aria-label="پیش‌تنظیم‌ها">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              aria-pressed={activePreset === p.id}
              onClick={() => onPreset(p)}
              className={chip(activePreset === p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {!showSettings ? (
          <Button variant="outline" className="ms-auto" onClick={onOpenSettings}>
            تنظیم دقیق مدل
          </Button>
        ) : null}
      </div>

      <div className="tnum flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-[11px] text-faint">
        <span className="text-muted">وزن‌های فعال:</span>
        {WEIGHTS.map((w) => (
          <span key={w.key}>
            {w.label} {num(wPct(tunables.weights, w.key), 0)}٪
          </span>
        ))}
        <span>حداقل جمعیت {group(tunables.minPopulation)}</span>
      </div>
    </Card>
  );
}
