"use client";

import { useMemo, useState } from "react";
import type { ScoredPlace, UnitEconomics } from "@/lib/analytics";
import { group, irr, num, shortCounty, shortPlace } from "@/lib/format";
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
    label: "نفر/داروخانه",
    hint: "معکوس سنجهٔ اشباع: چند نفر به هر داروخانه می‌رسد",
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

  const sorted = useMemo(() => {
    const arr = [...enriched];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (
        key === "place" ||
        key === "county" ||
        key === "province" ||
        key === "university"
      ) {
        av = (a[key] as string | null) ?? "";
        bv = (b[key] as string | null) ?? "";
      } else if (key === "opportunity") {
        av = a.scores.opportunity;
        bv = b.scores.opportunity;
      } else {
        av = (a[key] as number | null) ?? Number.NEGATIVE_INFINITY;
        bv = (b[key] as number | null) ?? Number.NEGATIVE_INFINITY;
      }
      const cmp =
        typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv, "fa")
          : Number(av) - Number(bv);
      return dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [enriched, sort]);

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

  if (!sorted.length) {
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
        <p className="text-[11px] text-faint">
          {group(sorted.length)} آبادی · برای مرتب‌سازی روی عنوان ستون بزنید ·
          روی هر ردیف بزنید تا جزئیات باز شود
        </p>
        <Button variant="outline" onClick={downloadCsv}>
          خروجی CSV
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[1540px] border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-surface-2">
              {columns.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    title={c.hint}
                    onClick={() => toggle(c.key)}
                    className={`sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-line bg-surface-2 px-2.5 py-2 font-semibold ${
                      c.numeric ? "text-left" : "text-right"
                    } ${active ? "text-brand-ink" : "text-ink-soft"} ${
                      c.hideXl ? "hidden xl:table-cell" : ""
                    } ${c.key === "opportunity" ? "left-0 z-30" : ""}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      <span
                        className={`text-[9px] ${active ? "opacity-100" : "opacity-25"}`}
                      >
                        {active ? (sort.dir === "desc" ? "▼" : "▲") : "▼"}
                      </span>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
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
