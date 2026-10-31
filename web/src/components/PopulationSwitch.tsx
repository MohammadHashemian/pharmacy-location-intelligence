"use client";

import { useMemo } from "react";
import type { PlaceMetrics, PopulationMode } from "@/lib/analytics";
import type { ReferenceCoverage } from "@/lib/data";
import { group } from "@/lib/format";
import { Card, SectionTitle } from "./ui";

/**
 * The population-source switch.
 *
 * The FDA feed's جمعیت is wrong for a minority of settlements — sometimes by two
 * orders of magnitude (روستاي ملاشيه is published with 169 people; the 1395
 * census counts 16,575 and the place sustains 3 pharmacies). This control swaps
 * in the corroborated reference figure and recalculates every derived metric.
 *
 * Nothing is overwritten: 'سازمان' always shows the feed's own number, and the
 * source of each substituted value is shown per row and in the detail panel.
 */
export function PopulationSwitch({
  mode,
  setMode,
  places,
  reference,
}: {
  mode: PopulationMode;
  setMode: (m: PopulationMode) => void;
  places: PlaceMetrics[];
  reference: ReferenceCoverage | null;
}) {
  const impact = useMemo(() => {
    let withRef = 0;
    let materially = 0;
    let rescued = 0;
    let correctedDown = 0;
    let manual = 0;
    for (const p of places) {
      if (p.has_manual === 1) manual++;
      const ref = p.ref_population;
      if (ref == null || ref <= 0) continue;
      withRef++;
      const fda = p.fda_population ?? 0;
      if (fda <= 0) {
        rescued++;
        continue;
      }
      const r = ref / fda;
      if (r >= 2 || r <= 0.5) materially++;
      if (r < 1) correctedDown++;
    }
    return { withRef, materially, rescued, correctedDown, manual };
  }, [places]);

  const pct = places.length
    ? Math.round((impact.withRef / places.length) * 1000) / 10
    : 0;

  const opt = (id: PopulationMode, title: string, sub: string) => {
    const on = mode === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => setMode(id)}
        aria-pressed={on}
        className={`flex-1 rounded-xl border px-3 py-2 text-right transition ${
          on
            ? "border-brand/50 bg-brand-soft shadow-sm"
            : "border-line bg-surface hover:border-line-strong"
        }`}
      >
        <span
          className={`block text-[12.5px] font-semibold ${
            on ? "text-brand-ink" : "text-ink-soft"
          }`}
        >
          {title}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-faint">
          {sub}
        </span>
      </button>
    );
  };

  return (
    <Card className="no-print">
      <SectionTitle
        title="جمعیت مبنای محاسبه"
        hint="شاخص‌های هر آبادی — تراکم، ظرفیت قابل جذب، فشار صف متقاضیان و امتیاز نهایی — با جمعیت انتخابی بازمحاسبه می‌شوند. (جمع‌بندی شهرستان‌ها همچنان بر پایهٔ عدد سازمان است، چون همهٔ آبادی‌های یک شهرستان عدد مرجع ندارند.)"
        right={
          <span className="tnum rounded-lg border border-line bg-surface-2 px-2 py-1 text-[11px] font-medium text-ink-soft">
            پوشش مرجع: {group(impact.withRef)} از {group(places.length)} (
            {group(pct)}٪)
          </span>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row">
        {opt(
          "fda",
          "دادهٔ سازمان غذا و دارو",
          "عدد منتشرشده در سامانهٔ سازمان — دست‌نخورده و مرجع اصلی عرضهٔ داروخانه",
        )}
        {opt(
          "reference",
          "جمعیت اصلاح‌شده (سرشماری)",
          "جای‌گزینی عدد مرجع برای آبادی‌هایی که عدد سازمان در آن‌ها نادرست است",
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Chip
          label="دارای جمعیت مرجع"
          value={group(impact.withRef)}
          tone="neutral"
        />
        <Chip
          label="اختلاف بیش از دو برابر"
          value={group(impact.materially)}
          tone="warn"
        />
        <Chip
          label="نجات‌یافته از جمعیت صفر"
          value={group(impact.rescued)}
          tone="good"
        />
        <Chip
          label="اصلاح روبه‌پایین (پرادعا)"
          value={group(impact.correctedDown)}
          tone="neutral"
        />
        <Chip
          label="ویرایش دستی شما (همیشه اعمال می‌شود)"
          value={group(impact.manual)}
          tone={impact.manual > 0 ? "good" : "neutral"}
        />
      </div>

      <p className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[11.5px] leading-5 text-ink-soft">
        {mode === "reference" ? (
          <>
            <b className="text-brand-ink">حالت اصلاح‌شده فعال است.</b> در این
            حالت، هر آبادی که جمعیت مرجع دارد با آن بازمحاسبه می‌شود؛ آبادی‌های
            بدون مرجع با عدد سازمان می‌مانند. این کار مشکل‌هایی مانند{" "}
            <b>«روستاي ملاشيه»</b> (عدد سازمان: ۱۶۹ نفر) را رفع می‌کند که در
            سرشماری ۱۳۹۵ برابر ۱۶٬۵۷۵ نفر ثبت شده است.
          </>
        ) : (
          <>
            <b>حالت دادهٔ سازمان فعال است.</b> اعداد همان‌طور که سازمان منتشر
            کرده نمایش داده می‌شوند. اگر عدد سازمان برای آبادی‌های کوچک یا
            حاشیهٔ کلان‌شهرها مشکل دارد، گزینهٔ «جمعیت اصلاح‌شده» را انتخاب
            کنید.
          </>
        )}
        {reference && reference.coverage_pct != null && (
          <>
            {" "}
            جمعیت مرجع از <b>ویکی‌داده</b> (منبع: سرشماری مرکز آمار ایران) و در
            صورت نبود آن از متن مقالهٔ ویکی‌پدیای همان آبادی برداشت شده است؛
            هم‌خوانی شهرستان و مختصات جغرافیایی برای هر ردیف بررسی و درجهٔ
            اطمینان ثبت شده است.
          </>
        )}
      </p>
    </Card>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "warn" | "good";
}) {
  const cls =
    tone === "warn"
      ? "border-amber-300/60 bg-amber-50 text-amber-900"
      : tone === "good"
        ? "border-emerald-300/60 bg-emerald-50 text-emerald-900"
        : "border-line bg-surface-2 text-ink-soft";
  return (
    <div className={`rounded-xl border px-2.5 py-2 ${cls}`}>
      <div className="tnum text-[15px] font-semibold leading-5">{value}</div>
      <div className="mt-0.5 text-[10.5px] leading-4 opacity-80">{label}</div>
    </div>
  );
}
