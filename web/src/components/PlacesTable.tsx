"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ScoredPlace, UnitEconomics } from "@/lib/analytics";
import { group, irr, num, shortCounty, shortPlace } from "@/lib/format";
import {
  filterActive,
  parseNum,
  passes,
  type ColFilter,
  type FilterMap,
} from "@/lib/tableFilter";
import { Badge, Button, Empty, Meter, type Tone } from "./ui";

type SortKey =
  | "rank"
  | "place"
  | "province"
  | "county"
  | "university"
  | "population"
  | "n_pharmacy_total"
  | "n_pharmacy_committed"
  | "n_req_pipeline"
  | "pharmacies_per_100k"
  | "population_per_pharmacy"
  | "postEntryPopPerPharmacy"
  | "min_score"
  | "capacityGap"
  | "estScriptsForEntrant"
  | "estRevenue"
  | "prosperity"
  | "otcForEntrant"
  | "opportunity";

interface Row extends ScoredPlace {
  estRevenue: number;
  otcForEntrant: number;
}

interface Col {
  key: SortKey;
  label: string;
  hint: string;
  numeric: boolean;
  /** Reveal only on extra-large screens (>= 1280px). */
  hideXl?: boolean;
  /** Only rendered when the province column is not shown (scoped to one province). */
  onlyAll?: boolean;
}

const BASE_COLUMNS: Col[] = [
  {
    key: "rank",
    label: "رتبه",
    hint: "رتبه در مجموعهٔ مقایسه بر اساس امتیاز فرصت",
    numeric: true,
  },
  {
    key: "place",
    label: "شهر / آبادی",
    hint: "نام از ستون «شهر/روستا» سازمان غذا و دارو",
    numeric: false,
  },
  { key: "province", label: "استان", hint: "استان", numeric: false },
  { key: "county", label: "شهرستان", hint: "شهرستان تابع", numeric: false },
  { key: "population", label: "جمعیت", hint: "جمعیت ثبت‌شده", numeric: true },
  {
    key: "prosperity",
    label: "برخورداری",
    hint:
      "رتبهٔ صدکی قدرت خرید منطقه در مجموعهٔ مقایسه (۱۰۰ = برخوردارترین). از شهر/روستا بودن، شهرنشینی شهرستان، بعد خانوار و اندازهٔ آبادی ساخته می‌شود — اندازه‌گیری درآمد نیست.",
    numeric: true,
  },
  {
    key: "n_pharmacy_total",
    label: "داروخانه",
    hint: "داروخانهٔ فعال: حقیقی + حقوقی",
    numeric: true,
  },
  {
    key: "n_pharmacy_committed",
    label: "با موافقت‌اصولی",
    hint: "داروخانه فعلی + موافقت‌اصولی صادرشده (عرضهٔ قطعی آینده)",
    numeric: true,
    hideXl: true,
  },
  {
    key: "pharmacies_per_100k",
    label: "در ۱۰۰ هزار",
    hint: "سنجهٔ اشباع؛ کمتر = ظرفیت خالی بیشتر",
    numeric: true,
  },
  {
    key: "population_per_pharmacy",
    label: "نفر/داروخانه (امروز)",
    hint: "معکوس سنجهٔ اشباع: چند نفر به هر داروخانه می‌رسد — وضعیت امروز، بدون احتساب ورود شما",
    numeric: true,
  },
  {
    key: "postEntryPopPerPharmacy",
    label: "نفر/داروخانه با شما",
    hint:
      "جمعیت ÷ (داروخانهٔ موجود + موافقت‌اصولی + ۱ شما): نسبت جمعیت به داروخانه اگر خودتان هم تاسیس کنید، با احتساب داروخانه‌هایی که مجوز اصولی دارند و قطعاً باز می‌شوند. هرچه بالاتر، شهر داروخانهٔ تازه را بهتر تحمل می‌کند — شهر ۱‌داروخانه‌ای ۵٬۰۰۰ نفری اینجا ۲٬۵۰۰ می‌شود. ستون «تحمل» در امتیاز فرصت همین است.",
    numeric: true,
  },
  {
    key: "n_req_pipeline",
    label: "صف متقاضیان",
    hint: "ثبت‌شده + درحال‌جریان + موافقت‌اصولی",
    numeric: true,
  },
  {
    key: "min_score",
    label: "حداقل امتیاز",
    hint: "سد اداری؛ بالاتر = سخت‌تر",
    numeric: true,
  },
  {
    key: "capacityGap",
    label: "ظرفیت جذب",
    hint: "جمعیت ÷ هدف − (موجود + موافقت‌اصولی)",
    numeric: true,
  },
  {
    key: "estScriptsForEntrant",
    label: "نسخهٔ برآوردی",
    hint:
      "نسخهٔ سالانهٔ برآوردی برای شما: جمعیت × نسخه‌سرانه ÷ (موجود + موافقت‌اصولی + ۱)",
    numeric: true,
    hideXl: true,
  },
  {
    key: "estRevenue",
    label: "درآمد برآوردی",
    hint: "نسخهٔ برآوردی × حاشیه سود هر نسخه",
    numeric: true,
    hideXl: true,
  },
  {
    key: "otcForEntrant",
    label: "فروش بدون نسخه",
    hint:
      "برآورد فروش سالانهٔ بدون نسخه (آرایشی، بهداشتی، مکمل، داروهای آزاد) برای شما: بازار محلی بدون نسخه ÷ (موجود + موافقت‌اصولی + ۱)",
    numeric: true,
  },
  {
    key: "opportunity",
    label: "امتیاز فرصت",
    hint: "ترکیب وزنی شش مؤلفه (۰–۱۰۰)",
    numeric: true,
  },
];

function toneForOpportunity(v: number): Tone {
  if (v >= 75) return "good";
  if (v >= 55) return "brand";
  if (v >= 35) return "muted";
  return "warn";
}

const TEXT_COLS = new Set<SortKey>(["place", "province", "county", "university"]);

/** The row's number for a column; null when the cell renders «—». */
function numericValue(r: Row, key: SortKey): number | null {
  if (key === "opportunity") return r.scores.opportunity;
  if (key === "estRevenue") return r.estRevenue;
  if (key === "otcForEntrant") return r.otcForEntrant;
  const v = (r as unknown as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The raw text a text column filters on (what the cell shortens, not replaces). */
function textValue(r: Row, key: SortKey): string {
  const v = (r as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

/** A value as the reader sees it in that column, for the pick list. */
function displayValue(key: SortKey, v: string): string {
  if (key === "place") return shortPlace(v);
  if (key === "county") return shortCounty(v);
  if (key === "province") return v.replace(/^استان\s+/u, "");
  return v;
}

/**
 * The panel a column header opens.
 *
 * Clicking the header used to sort, which left no room for a filter; sorting
 * moved onto the arrow button and into this panel so both live on the same
 * header. Rendered through a portal with `position: fixed`: the table sits in
 * an `overflow-x-auto` box, which would clip an absolutely positioned panel.
 */
function FilterPanel({
  col,
  filter,
  anchor,
  sort,
  bounds,
  values,
  onSort,
  onChange,
  onClear,
  onClose,
}: {
  col: Col;
  filter: ColFilter;
  anchor: DOMRect;
  sort: { key: SortKey; dir: "asc" | "desc" };
  /** data min/max, for the «کمینه/بیشینه» line and the placeholders */
  bounds: [number | null, number | null];
  /** distinct text values with counts, largest first */
  values: [string, number][];
  onSort: (dir: "asc" | "desc") => void;
  onChange: (f: ColFilter) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t)) return;
      /* A header click is the panel's own toggle; closing here would race it
         closed and immediately re-open. */
      if (t.closest("[data-filter-anchor]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const W = 284;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - 360));
  const sorted = sort.key === col.key;
  const pick = filter.pick ?? [];

  const togglePick = (v: string) => {
    const next = new Set(pick);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange({ ...filter, pick: [...next] });
  };

  const box =
    "tnum mt-1 w-full rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-[12.5px] outline-none placeholder:text-faint focus:border-brand focus:ring-2 focus:ring-brand/20";

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`فیلتر ${col.label}`}
      data-filter-panel={col.key}
      dir="rtl"
      style={{ left, top, width: W }}
      className="fixed z-50 rounded-xl border border-line-strong bg-surface p-3 text-right shadow-xl"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-ink">{col.label}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="بستن"
          className="rounded px-1 text-[13px] leading-none text-faint hover:bg-surface-2 hover:text-ink"
        >
          ✕
        </button>
      </div>
      <p className="mt-1 text-[10.5px] leading-4 text-faint">{col.hint}</p>

      <div className="mt-2.5 flex gap-1">
        {(["desc", "asc"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onSort(d)}
            className={`flex-1 rounded-lg border px-2 py-1 text-[11.5px] font-medium ${
              sorted && sort.dir === d
                ? "border-brand/40 bg-brand-soft text-brand-ink"
                : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
            }`}
          >
            {d === "desc" ? "مرتب‌سازی ▼" : "مرتب‌سازی ▲"}
          </button>
        ))}
      </div>

      {col.numeric ? (
        <div className="mt-2.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] text-ink-soft">از</span>
              <input
                autoFocus
                value={filter.min ?? ""}
                onChange={(e) => onChange({ ...filter, min: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onClose();
                }}
                inputMode="decimal"
                aria-label={`کمینهٔ ${col.label}`}
                placeholder={bounds[0] == null ? "—" : group(bounds[0])}
                className={box}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-soft">تا</span>
              <input
                value={filter.max ?? ""}
                onChange={(e) => onChange({ ...filter, max: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onClose();
                }}
                inputMode="decimal"
                aria-label={`بیشینهٔ ${col.label}`}
                placeholder={bounds[1] == null ? "—" : group(bounds[1])}
                className={box}
              />
            </label>
          </div>
          {bounds[0] != null || bounds[1] != null ? (
            <p className="mt-1.5 flex justify-between gap-2 text-[10px] text-faint">
              <span>کمینه {group(bounds[0])}</span>
              <span>بیشینه {group(bounds[1])}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-2.5">
          <label className="block">
            <span className="text-[11px] text-ink-soft">شامل</span>
            <input
              autoFocus
              value={filter.q ?? ""}
              onChange={(e) => onChange({ ...filter, q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") onClose();
              }}
              aria-label={`متن ${col.label}`}
              placeholder="بخشی از نام…"
              className={`${box} tnum-none`}
            />
          </label>
          {values.length > 0 && values.length <= 40 ? (
            <div className="mt-2 max-h-40 space-y-px overflow-auto rounded-lg border border-line p-1">
              {values.map(([v, n]) => (
                <label
                  key={v}
                  className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11.5px] hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={pick.includes(v)}
                    onChange={() => togglePick(v)}
                    className="accent-brand"
                  />
                  <span className="flex-1 truncate text-ink" title={v}>
                    {displayValue(col.key, v)}
                  </span>
                  <span className="tnum text-[10px] text-faint">{group(n)}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2">
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:border-line-strong hover:text-ink"
        >
          پاک‌کردن این ستون
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
        >
          تمام
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function PlacesTable({
  rows,
  economics,
  selectedId,
  showProvince,
  onSelect,
  unwrappedIds,
}: {
  rows: ScoredPlace[];
  economics: UnitEconomics;
  selectedId: number | null;
  /** False when the board is already scoped to a single province. */
  showProvince: boolean;
  onSelect: (id: number) => void;
  /**
   * Places the "unwrap county family" toggle pulled into the table. Marked so a
   * row that only appears because of that toggle is never mistaken for one that
   * passed the population floor on its own.
   */
  unwrappedIds?: Set<number>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "opportunity",
    dir: "desc",
  });
  /** Per-column filters, keyed by column. Empty object = the whole board. */
  const [filters, setFilters] = useState<FilterMap>({});
  /** The open header panel, with the rect it was opened from. */
  const [open, setOpen] = useState<{ key: SortKey; rect: DOMRect } | null>(null);

  const columns = useMemo(
    () => BASE_COLUMNS.filter((c) => showProvince || c.key !== "province"),
    [showProvince],
  );

  const enriched: Row[] = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        estRevenue: r.estScriptsForEntrant * economics.netMarginPerScriptIRR,
        otcForEntrant: r.otc.forEntrant,
      })),
    [rows, economics.netMarginPerScriptIRR],
  );

  /* Column filters narrow the board; they never touch the score, so the rank in
     the «رتبه» column stays the rank of the whole compared set. */
  const filtered = useMemo(() => {
    const keys = (Object.keys(filters) as SortKey[]).filter((k) =>
      filterActive(filters[k]),
    );
    if (!keys.length) return enriched;
    return enriched.filter((r) =>
      keys.every((k) =>
        passes(
          filters[k],
          TEXT_COLS.has(k)
            ? { text: textValue(r, k) }
            : { num: numericValue(r, k) },
        ),
      ),
    );
  }, [enriched, filters]);

  const panelCol = useMemo(
    () => (open ? (columns.find((c) => c.key === open.key) ?? null) : null),
    [open, columns],
  );

  /** The data's own min/max, so the «از / تا» boxes say what the range is. */
  const panelBounds = useMemo<[number | null, number | null]>(() => {
    if (!open || !panelCol?.numeric) return [null, null];
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of enriched) {
      const v = numericValue(r, open.key);
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return Number.isFinite(lo) ? [lo, hi] : [null, null];
  }, [open, panelCol, enriched]);

  const panelValues = useMemo<[string, number][]>(() => {
    if (!open || panelCol?.numeric) return [];
    const m = new Map<string, number>();
    for (const r of enriched) {
      const v = textValue(r, open.key);
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fa"),
    );
  }, [open, panelCol, enriched]);

  const activeCols = useMemo(
    () => columns.filter((c) => filterActive(filters[c.key])),
    [columns, filters],
  );

  const setFilter = (key: SortKey, f: ColFilter) =>
    setFilters((m) => {
      const next = { ...m };
      if (filterActive(f)) next[key] = f;
      else delete next[key];
      return next;
    });

  const chip = (c: Col, f: ColFilter): string => {
    if (c.numeric) {
      const lo = parseNum(f.min);
      const hi = parseNum(f.max);
      if (lo !== null && hi !== null)
        return `${group(Math.min(lo, hi))} تا ${group(Math.max(lo, hi))}`;
      if (lo !== null) return `از ${group(lo)}`;
      if (hi !== null) return `تا ${group(hi)}`;
    }
    const parts: string[] = [];
    if (f.q?.trim()) parts.push(`شامل «${f.q.trim()}»`);
    if (f.pick?.length) parts.push(`${group(f.pick.length)} مقدار`);
    return parts.join(" · ");
  };

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const { key, dir } = sort;
    const isText =
      key === "place" ||
      key === "county" ||
      key === "province" ||
      key === "university";
    arr.sort((a, b) => {
      /* A row the board will not score has no honest number in ANY numeric
         column, so it must not be ordered among the real ones — least of all at
         the top. «شهر تجریش» carries Tehran's 8.15 M population against one
         pharmacy, which is 4,077,026 patients per pharmacy after entry: sorted
         by that column it took first place and the visible cells read «—».
         Same rule as the default opportunity board: unscoreable rows last, in
         both directions. Text sorts stay pure alphabetical. */
      if (!isText && a.scorable !== b.scorable) return a.scorable ? -1 : 1;

      let av: number | string;
      let bv: number | string;
      if (isText) {
        av = (a[key] as string | null) ?? "";
        bv = (b[key] as string | null) ?? "";
      } else if (key === "opportunity") {
        av = a.scores.opportunity;
        bv = b.scores.opportunity;
      } else {
        av = (a[key] as number | null) ?? Number.NEGATIVE_INFINITY;
        bv = (b[key] as number | null) ?? Number.NEGATIVE_INFINITY;
      }
      const cmp = isText
        ? (av as string).localeCompare(bv as string, "fa")
        : Number(av) - Number(bv);
      if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      /* Equal values (every 5,000-patient row, every «—») keep the board's own
         order instead of shuffling between renders. */
      return a.rank - b.rank;
    });
    return arr;
  }, [filtered, sort]);

  const sortBy = (key: SortKey, dir: "asc" | "desc") => setSort({ key, dir });

  const toggle = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "desc" ? "asc" : "desc" }
        : {
            key,
            dir:
              key === "place" ||
              key === "county" ||
              key === "province" ||
              key === "university"
                ? "asc"
                : "desc",
          },
    );

  const downloadCsv = () => {
    const head = [
      "rank",
      "city",
      "province",
      "county",
      "district",
      "university",
      "dq_flags",
      "population",
      "buying_power_index",
      "prosperity_0_100",
      "prosperity_band",
      "pharmacies_current",
      "pharmacies_with_approval",
      "pharmacies_per_100k",
      "population_per_pharmacy",
      "post_entry_pop_per_pharmacy",
      "entry_dilution_pct",
      "requests_registered",
      "requests_inprogress",
      "requests_approved",
      "requests_pipeline",
      "min_score",
      "capacity_gap",
      "absorbable_pharmacies",
      "est_scripts_for_entrant",
      "est_revenue_irr",
      "otc_per_capita_irr",
      "otc_market_irr",
      "otc_per_pharmacy_irr",
      "otc_for_entrant_irr",
      "score_demand",
      "score_headroom",
      "score_pipeline",
      "score_barrier",
      "score_affluence",
      "score_tolerance",
      "score_opportunity",
      "observed_at",
    ];
    const body = sorted.map((r) =>
      [
        r.rank,
        shortPlace(r.place),
        r.province,
        r.county,
        r.district,
        r.university ?? "",
        r.dq_flags ?? "",
        r.population ?? "",
        r.buying_power.toFixed(3),
        r.prosperity.toFixed(1),
        r.prosperity_band,
        (r.dq_flags ?? "").includes("no_fda_data") ? "" : r.n_pharmacy_total,
        (r.dq_flags ?? "").includes("no_fda_data") ? "" : r.n_pharmacy_committed,
        (r.dq_flags ?? "").includes("no_fda_data") ? "" : (r.pharmacies_per_100k ?? ""),
        (r.dq_flags ?? "").includes("no_fda_data") ? "" : (r.population_per_pharmacy ?? ""),
        r.postEntryPopPerPharmacy,
        r.entryDilutionPct,
        r.n_req_registered,
        r.n_req_inprogress,
        r.n_req_approved,
        r.n_req_pipeline,
        r.min_score ?? "",
        r.capacityGap,
        r.absorbablePharmacies,
        r.estScriptsForEntrant,
        Math.round(r.estRevenue),
        r.otc.perCapita,
        r.otc.market,
        r.otc.perPharmacy,
        r.otc.forEntrant,
        r.scores.demand.toFixed(1),
        r.scores.headroom.toFixed(1),
        r.scores.pipeline.toFixed(1),
        r.scores.barrier.toFixed(1),
        r.scores.affluence.toFixed(1),
        r.scores.tolerance.toFixed(1),
        r.scores.opportunity.toFixed(2),
        r.observed_at,
      ]
        .map((v) => {
          const s = String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    );
    const csv = "\uFEFF" + [head.join(","), ...body].join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `pharmacy-locations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!enriched.length) {
    return (
      <Empty>
        هیچ شهری با این فیلترها پیدا نشد. «حداقل جمعیت» را کم کنید یا استان
        دیگری انتخاب کنید.
      </Empty>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-faint" data-testid="table-count">
          {activeCols.length
            ? `${group(sorted.length)} از ${group(enriched.length)} آبادی با ${group(activeCols.length)} فیلتر ·`
            : `${group(sorted.length)} آبادی ·`}{" "}
          برای فیلتر روی عنوان ستون بزنید، با پیکان ▼ مرتب کنید ·
          ردیف‌های بی‌امتیاز در هر مرتب‌سازی عددی آخر می‌مانند ·
          روی هر ردیف بزنید تا جزئیات باز شود
        </p>
        <div className="flex items-center gap-1.5">
          {activeCols.length ? (
            <Button
              variant="ghost"
              onClick={() => setFilters({})}
              title="همهٔ فیلترهای ستون‌ها را بردار"
            >
              پاک‌کردن فیلترها
            </Button>
          ) : null}
          <Button variant="outline" onClick={downloadCsv}>
            خروجی CSV
          </Button>
        </div>
      </div>

      {activeCols.length ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          data-testid="filter-chips"
        >
          {activeCols.map((c) => (
            <span
              key={c.key}
              data-chip={c.key}
              className="inline-flex items-center gap-1 rounded-lg border border-brand/30 bg-brand-soft px-1.5 py-0.5 text-[11px] text-brand-ink"
            >
              <b className="font-semibold">{c.label}</b>
              <bdi>{chip(c, filters[c.key] ?? {})}</bdi>
              <button
                type="button"
                onClick={() => setFilter(c.key, {})}
                aria-label={`حذف فیلتر ${c.label}`}
                className="rounded px-0.5 text-[12px] leading-none hover:bg-brand/10"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[1540px] border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-surface-2">
              {columns.map((c) => {
                const active = sort.key === c.key;
                const filtering = filterActive(filters[c.key]);
                return (
                  <th
                    key={c.key}
                    data-col={c.key}
                    data-filter-anchor=""
                    title={`${c.hint}\n— برای فیلتر این ستون کلیک کنید`}
                    onClick={(e) => {
                      /* Read the rect now: `currentTarget` is cleared once the
                         handler returns, and the state updater runs later. */
                      const rect = e.currentTarget.getBoundingClientRect();
                      setOpen((o) =>
                        o?.key === c.key ? null : { key: c.key, rect },
                      );
                    }}
                    aria-sort={
                      active
                        ? sort.dir === "desc"
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                    className={`sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-line bg-surface-2 px-2.5 py-2 font-semibold ${
                      c.numeric ? "text-left" : "text-right"
                    } ${active || filtering ? "text-brand-ink" : "text-ink-soft"} ${
                      c.hideXl ? "hidden xl:table-cell" : ""
                    } ${c.key === "opportunity" ? "left-0 z-30" : ""}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>{c.label}</span>
                      {/* Sorting stays one click away, on the arrow, so the
                          header itself is free to open the filter panel. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(c.key);
                        }}
                        aria-label={`مرتب‌سازی بر اساس ${c.label}`}
                        title="مرتب‌سازی"
                        className="rounded px-0.5 leading-none hover:bg-line/60"
                      >
                        <span
                          className={`text-[9px] ${
                            active ? "opacity-100" : "opacity-30"
                          }`}
                        >
                          {active ? (sort.dir === "desc" ? "▼" : "▲") : "▼"}
                        </span>
                      </button>
                      <svg
                        width="9"
                        height="9"
                        viewBox="0 0 10 10"
                        aria-hidden="true"
                        className={filtering ? "text-brand" : "opacity-30"}
                      >
                        <path
                          d="M0.8 1.2H9.2L6 5.4V8.8L4 7.6V5.4Z"
                          fill="currentColor"
                        />
                      </svg>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-[12.5px] text-muted"
                >
                  هیچ ردیفی با این فیلترها نماند.
                  <button
                    type="button"
                    onClick={() => setFilters({})}
                    className="mx-1.5 rounded-lg border border-line px-2 py-1 text-[11.5px] hover:border-line-strong hover:text-ink"
                  >
                    پاک‌کردن فیلترها
                  </button>
                </td>
              </tr>
            ) : null}
            {sorted.map((r) => {
              const sel = r.location_id === selectedId;
              /* Every reason this row deserves a second look, in one badge. Rows
                 are never removed for having warnings — only the user's
                 "نمایش موارد مشکوک" switch hides them. */
              const warnings = r.warnings ?? [];
              const flagged = warnings.length > 0;
              const hardWarning = !r.scorable;
              /* No FDA row at all: every pharmacy figure is UNKNOWN, not zero. */
              const noFda = (r.dq_flags ?? "").includes("no_fda_data");
              return (
                <tr
                  key={r.location_id}
                  onClick={() => onSelect(r.location_id)}
                  className={`cursor-pointer border-b border-line/70 bg-surface transition last:border-0 ${
                    sel ? "bg-brand-soft/60" : "hover:bg-surface-2"
                  }`}
                >
                  <td className="tnum px-2.5 py-1.5 text-left font-semibold text-muted">
                    {group(r.rank)}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-medium text-ink">
                    <span className="inline-flex items-center gap-1.5">
                      {shortPlace(r.place)}
                      {r.has_reference === 1 ? (
                        <span
                          title={[
                            `جمعیت مرجع: ${group(r.ref_population)}${
                              r.ref_census_year_sh
                                ? ` (سرشماری ${group(r.ref_census_year_sh)})`
                                : ""
                            }`,
                            `جمعیت سازمان: ${group(r.fda_population)}`,
                            `منبع: ${
                              r.ref_source === "wikidata"
                                ? "ویکی‌داده — سرشماری مرکز آمار ایران"
                                : "مقالهٔ ویکی‌پدیای فارسی"
                            }`,
                            `درجهٔ اطمینان تطبیق: ${num((r.ref_match_score ?? 0) * 100, 0)}٪`,
                            ...(r.ref_ratio != null &&
                            (r.ref_ratio >= 5 || r.ref_ratio <= 0.2)
                              ? [
                                  "",
                                  "⚠ اختلاف بیش از پنج برابر با عدد سازمان.",
                                  "ممکن است عدد سازمان یک رقم کم داشته باشد یا",
                                  "منبع، جمعیت شهرستان را به‌جای خودِ آبادی آورده باشد.",
                                  "پیش از تصمیم، هر دو عدد را بررسی کنید.",
                                ]
                              : []),
                          ].join("\n")}
                          className={`cursor-help whitespace-nowrap rounded border px-1 py-px text-[9.5px] font-semibold ${
                            r.ref_ratio != null &&
                            (r.ref_ratio >= 5 || r.ref_ratio <= 0.2)
                              ? "border-amber-400/60 bg-amber-50 text-amber-900"
                              : "border-brand/30 bg-brand-soft text-brand-ink"
                          }`}
                        >
                          {r.ref_ratio != null &&
                          (r.ref_ratio >= 5 || r.ref_ratio <= 0.2)
                            ? "مرجع ⚠"
                            : "مرجع"}
                        </span>
                      ) : null}
                      {flagged ? (
                        <span
                          title={warnings.join("\n")}
                          className={`cursor-help text-[11px] ${
                            hardWarning ? "text-danger" : "text-warn"
                          }`}
                        >
                          {hardWarning ? "⚠" : "◦"}
                        </span>
                      ) : null}
                      {unwrappedIds?.has(r.location_id) ? (
                        <span
                          title="این شهر فقط چون «بازکردن همهٔ شهرهای هم‌شهرستان» روشن است در جدول آمده؛ از فیلتر حداقل جمعیت رد نشده است"
                          className="cursor-help whitespace-nowrap rounded border border-line-strong bg-surface-2 px-1 py-px text-[9.5px] font-semibold text-muted"
                        >
                          ⊞ هم‌خانواده
                        </span>
                      ) : null}
                      {r.has_manual === 1 ? (
                        <span
                          title={[
                            "مقدار این ردیف با ویرایش دستی شما تنظیم شده است",
                            r.manual_note ? `یادداشت: ${r.manual_note}` : "",
                            r.manual_updated_at
                              ? `آخرین ویرایش: ${r.manual_updated_at.slice(0, 10)}`
                              : "",
                          ]
                            .filter(Boolean)
                            .join("\n")}
                          className="cursor-help whitespace-nowrap rounded border border-line-strong bg-surface-2 px-1 py-px text-[9.5px] font-semibold text-ink-soft"
                        >
                          ✎ ویرایش من
                        </span>
                      ) : null}
                    </span>
                  </td>
                  {showProvince ? (
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                      {r.province.replace(/^استان\s+/, "")}
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                    {shortCounty(r.county)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {group(r.population)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    <span
                      title={[
                        `برخورداری: رتبهٔ ${num(r.prosperity, 0)} از ۱۰۰ در مجموعهٔ مقایسه — ${r.prosperity_band}`,
                        `قدرت خرید نسبت به میانگین کشور: ${num(r.buying_power, 2)} برابر`,
                        `شهر/روستا: ${num(r.affluence_factors.urbanity, 2)} · شهرنشینی شهرستان: ${num(r.affluence_factors.countyUrban, 2)} · بعد خانوار: ${num(r.affluence_factors.household, 2)} · اندازهٔ آبادی: ${num(r.affluence_factors.agglomeration, 2)}`,
                      ].join("\n")}
                      className={`cursor-help ${
                        r.prosperity >= 75
                          ? "font-semibold text-good"
                          : r.prosperity < 35
                            ? "text-danger"
                            : ""
                      }`}
                    >
                      {num(r.prosperity, 0)}
                    </span>
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {noFda ? (
                      <span className="text-faint" title="دادهٔ FDA ندارد">
                        —
                      </span>
                    ) : (
                      group(r.n_pharmacy_total)
                    )}
                  </td>
                  <td className="tnum hidden px-2.5 py-1.5 text-left text-muted xl:table-cell">
                    {noFda ? "—" : group(r.n_pharmacy_committed)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {noFda ? (
                      <span className="text-faint">—</span>
                    ) : r.pharmacies_per_100k == null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span
                        className={
                          r.pharmacies_per_100k < 20
                            ? "font-semibold text-good"
                            : r.pharmacies_per_100k > 35
                              ? "font-semibold text-danger"
                              : ""
                        }
                      >
                        {num(r.pharmacies_per_100k, 1)}
                      </span>
                    )}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left text-muted">
                    {noFda ? "—" : group(r.population_per_pharmacy)}
                  </td>
                  <td
                    className="tnum px-2.5 py-1.5 text-left"
                    title={[
                      `جمعیت ÷ (${r.n_pharmacy_total} موجود + ${r.n_req_approved} موافقت‌اصولی + ۱ شما = ${r.n_pharmacy_committed + 1}): نسبت پس از ورود شما`,
                      r.n_pharmacy_committed > 0
                        ? `سهم شما از سبد هر داروخانه: ${num(r.entryDilutionPct, 0)}٪`
                        : "امروز هیچ داروخانه‌ای ندارد — تمام بازار از آنِ شما",
                      `داروخانه در ۱۰۰ هزار نفر پس از ورود شما: ${num(r.postEntryDensity, 1)}`,
                      `تحمل ورود (صدک، ۱۰۰=بهترین): ${num(r.scores.tolerance, 1)}`,
                    ].join("\n")}
                  >
                    {r.scorable ? (
                      <span
                        className={
                          r.postEntryPopPerPharmacy >= r.targetPopPerPharmacy
                            ? "font-semibold text-good"
                            : r.postEntryPopPerPharmacy <
                                r.targetPopPerPharmacy * 0.6
                              ? "text-danger"
                              : ""
                        }
                      >
                        {group(r.postEntryPopPerPharmacy)}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {r.n_req_pipeline ? (
                      <Badge tone={r.n_req_pipeline > 20 ? "warn" : "muted"}>
                        {group(r.n_req_pipeline)}
                      </Badge>
                    ) : (
                      <span className="text-faint">۰</span>
                    )}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left text-muted">
                    {group(r.min_score)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {r.absorbablePharmacies > 0 ? (
                      <span className="font-semibold text-good">
                        +{group(r.absorbablePharmacies)}
                      </span>
                    ) : (
                      <span className="text-faint">
                        {num(r.capacityGap, 1)}
                      </span>
                    )}
                  </td>
                  <td className="tnum hidden px-2.5 py-1.5 text-left text-muted xl:table-cell">
                    {group(r.estScriptsForEntrant)}
                  </td>
                  <td className="tnum hidden px-2.5 py-1.5 text-left font-medium xl:table-cell">
                    {group(r.estRevenue)}
                  </td>
                  <td
                    className="tnum px-2.5 py-1.5 text-left font-medium"
                    title={[
                      `بازار محلی بدون نسخه: ${irr(r.otc.market)} در سال`,
                      `سرانه: ${irr(r.otc.perCapita)} برای هر نفر در سال`,
                      `میانگین هر داروخانهٔ موجود: ${irr(r.otc.perPharmacy)}`,
                      `سهم شما با یک داروخانهٔ تازه: ${irr(r.otc.forEntrant)}`,
                    ].join("\n")}
                  >
                    {irr(r.otcForEntrant)}
                  </td>
                  <td className="sticky left-0 z-[5] bg-inherit px-2.5 py-1.5">
                    <div className="flex items-center justify-end gap-1.5">
                      {r.scorable ? (
                        <>
                          <Meter value={r.scores.opportunity} />
                          <span className="tnum w-9 text-left font-semibold text-brand-ink">
                            {num(r.scores.opportunity, 1)}
                          </span>
                          <Badge tone={toneForOpportunity(r.scores.opportunity)}>
                            {r.scores.opportunity >= 75
                              ? "عالی"
                              : r.scores.opportunity >= 55
                                ? "خوب"
                                : r.scores.opportunity >= 35
                                  ? "متوسط"
                                  : "ضعیف"}
                          </Badge>
                        </>
                      ) : (
                        /* No population means no honest score. Showing a number
                           here — even zero — invites reading it as a ranking. */
                        <Badge tone="warn" title={(r.warnings ?? []).join("\n")}>
                          امتیاز ندارد
                        </Badge>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && panelCol ? (
        <FilterPanel
          col={panelCol}
          filter={filters[open.key] ?? {}}
          anchor={open.rect}
          sort={sort}
          bounds={panelBounds}
          values={panelValues}
          onSort={(dir) => sortBy(open.key, dir)}
          onChange={(f) => setFilter(open.key, f)}
          onClear={() => setFilter(open.key, {})}
          onClose={() => setOpen(null)}
        />
      ) : null}

      <p className="text-[11px] leading-4 text-faint">
        «داروخانه (فعلی)» = حقیقی + حقوقی. «با موافقت‌اصولی» = داروخانه فعلی +
        موافقت‌اصولی صادرشده، یعنی عرضهٔ قطعی آینده که رقیب شما خواهد بود.
        «ظرفیت قابل جذب» = جمعیت ÷ هدفِ جمعیت‌به‌ازای‌هر‌داروخانه − (داروخانه
        موجود + موافقت‌اصولی)؛ عدد نامنفی یعنی شهر پس از ورود داروخانه‌های در راه
        هنوز جا دارد. «درآمد برآوردی» بر پایهٔ فرض‌های اقتصادی شما محاسبه می‌شود و
        فقط برای مقایسهٔ نسبی است، نه پیش‌بینی.
        <br />
        <b className="text-muted">«نفر/داروخانه با شما»</b> نسبت جمعیت به
        داروخانه است اگر خودتان هم در آن آبادی تاسیس کنید: جمعیت ÷ (موجود +
        موافقت‌اصولی + ۱). داروخانه‌ای که موافقت‌اصولی گرفته قطعاً باز می‌شود، پس
        رقیب قطعی است نه احتمالی. ستون «نفر/داروخانه» وضعیت امروز را نشان می‌دهد
        و این ستون وضعیتی را که در آن کار می‌کنید — شهری با ۵٬۰۰۰ نفر و ۱
        داروخانه امروز ایده‌آل به‌نظر می‌رسد ولی با ورود شما ۲٬۵۰۰ می‌شود، در
        حالی که شهر ۲۰٬۰۰۰ نفری با ۴ داروخانه فقط به ۴٬۰۰۰ می‌رسد.
        <br />
        <b className="text-muted">«برخورداری»</b> قدرت خرید نسبی همان آبادی است
        (۰ تا ۱۰۰؛ ۵۰ = میانگین وزنی کشور) و <b className="text-muted">
        «فروش بدون نسخه»</b> برآورد فروش سالانهٔ آرایشی، بهداشتی، مکمل و داروهای
        آزاد برای داروخانهٔ تازهٔ شماست — بخشی از درآمد که بیمه پرداختش نمی‌کند و
        مستقیماً به توان مالی مردم محل بستگی دارد. ستون‌های عددی را می‌توانید با
        کلیک روی عنوان مرتب کنید.
      </p>
    </div>
  );
}
