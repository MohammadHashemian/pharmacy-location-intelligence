"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import type {
  PlaceMetrics,
  ScoredPlace,
  Tunables,
  UnitEconomics,
  Weights,
} from "@/lib/analytics";
import { EditableField } from "./EditableField";
import {
  irr,
  group,
  num,
  shortCounty,
  shortDistrict,
  shortPlace,
} from "@/lib/format";
import { scoreColor } from "./Charts";
import { Badge, Button, ScoreBar, SectionTitle, type Tone } from "./ui";

const DIMENSIONS: {
  key: keyof Weights;
  label: string;
  explain: string;
  color: string;
  weightLabel: (w: Weights) => string;
}[] = [
  {
    key: "demand",
    label: "اندازه بازار",
    explain: "رتبهٔ صدکی جمعیت نسبت به شهرهای دیگر مجموعه.",
    color: "#0d9488",
    weightLabel: (w) => `${w.demand}`,
  },
  {
    key: "headroom",
    label: "ظرفیت خالی",
    explain:
      "۱۰۰ منهای رتبهٔ صدکی اشباع؛ یعنی چند درصد شهرها پرمصرف‌تر از این شهر هستند.",
    color: "#6366f1",
    weightLabel: (w) => `${w.headroom}`,
  },
  {
    key: "pipeline",
    label: "کم‌بودن صف متقاضی",
    explain: "۱۰۰ منهای رتبهٔ صدکی نسبت متقاضیان به داروخانه‌های موجود.",
    color: "#d97706",
    weightLabel: (w) => `${w.pipeline}`,
  },
  {
    key: "barrier",
    label: "سهولت ورود",
    explain:
      "۱۰۰ منهای رتبهٔ صدکی «حداقل امتیاز»؛ امتیاز پایین‌تر یعنی مجوز آسان‌تر.",
    color: "#e11d48",
    weightLabel: (w) => `${w.barrier}`,
  },
];

function RawRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/70 py-1.5 last:border-0">
      <span className="text-[11.5px] text-muted" title={hint}>
        {label}
      </span>
      <span className="tnum text-[12.5px] font-medium text-ink">{value}</span>
    </div>
  );
}

export function DetailPanel({
  place,
  siblings,
  tunables,
  economics,
  onClose,
  onSelect,
  pinned,
  onTogglePin,
  peerCount,
}: {
  place: ScoredPlace | null;
  /** Other places in the same county, for context. */
  siblings: PlaceMetrics[];
  tunables: Tunables;
  economics: UnitEconomics;
  onClose: () => void;
  onSelect: (id: number) => void;
  pinned: number[];
  onTogglePin: (id: number) => void;
  peerCount: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  if (!place) return null;

  const w = tunables.weights;
  const wSum = w.demand + w.headroom + w.pipeline + w.barrier || 1;
  const opp = place.scores.opportunity;
  const tone: Tone =
    opp >= 75 ? "good" : opp >= 55 ? "brand" : opp >= 35 ? "muted" : "warn";
  const estRevenue =
    place.estScriptsForEntrant * economics.netMarginPerScriptIRR;

  return (
    <div className="fixed inset-0 z-50 flex" dir="rtl">
      <button
        type="button"
        aria-label="بستن"
        onClick={onClose}
        className="flex-1 cursor-default bg-ink/25 backdrop-blur-[1px]"
      />
      <aside className="h-full w-full max-w-[440px] overflow-y-auto border-l border-line bg-surface shadow-2xl">
        {/* header */}
        <div className="sticky top-0 z-10 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-[17px] font-bold text-ink">
                {shortPlace(place.place)}
              </h2>
              <p className="mt-0.5 text-[11.5px] text-muted">
                {shortCounty(place.county)} · {shortDistrict(place.district)}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant={
                  pinned.includes(place.location_id) ? "primary" : "outline"
                }
                onClick={() => onTogglePin(place.location_id)}
                title="افزودن به مقایسه"
              >
                {pinned.includes(place.location_id) ? "✓ مقایسه" : "+ مقایسه"}
              </Button>
              <Button variant="outline" onClick={onClose} title="بستن (Esc)">
                ✕
              </Button>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span
              className="tnum rounded-lg px-2.5 py-1 text-[15px] font-bold text-white"
              style={{ background: scoreColor(opp) }}
            >
              {num(opp, 1)}
            </span>
            <Badge tone={tone}>
              رتبهٔ {group(place.rank)} از {group(peerCount)}
            </Badge>
            <Badge tone="accent">
              {place.place_kind === "city"
                ? "شهر"
                : place.place_kind === "village"
                  ? "روستا"
                  : "سایر"}
            </Badge>
          </div>

          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[10.5px] text-faint">
              <span>ترکیب وزنی امتیاز فرصت</span>
              <span>مجموع وزن‌ها: {group(Math.round(wSum))}</span>
            </div>
            <ScoreBar
              parts={DIMENSIONS.map((d) => ({
                label: d.label,
                value: place.scores[d.key] * (w[d.key] / wSum),
                color: d.color,
              }))}
            />
          </div>
        </div>

        <div className="space-y-5 p-4">
          {/* ------------------------------------------------ dimensions -- */}
          <section>
            <SectionTitle
              title="تفکیک مؤلفه‌ها"
              hint="هر مؤلفه یک رتبهٔ صدکی درون مجموعهٔ مقایسه است (۱۰۰ = بهترین)."
            />
            <div className="space-y-2.5">
              {DIMENSIONS.map((d) => {
                const v = place.scores[d.key];
                const share = Math.round((w[d.key] / wSum) * 100);
                return (
                  <div key={d.key}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-medium text-ink-soft">
                        {d.label}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-[10.5px] text-faint">
                          وزن {d.weightLabel(w)} ({share}٪)
                        </span>
                        <span className="tnum text-[12px] font-semibold text-ink">
                          {num(v, 1)}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${v}%`, background: d.color }}
                        />
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10.5px] leading-4 text-faint">
                      {d.explain}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ------------------------------------------------- warnings -- */}
          {/* Shown, never hidden: this is the whole point of listing a suspect
              row instead of dropping it. */}
          {(place.warnings ?? []).length > 0 ? (
            <section>
              <div
                className={`rounded-xl border px-3 py-2 ${
                  place.scorable
                    ? "border-warn/40 bg-warn-soft/50"
                    : "border-danger/40 bg-danger-soft/40"
                }`}
              >
                <div
                  className={`text-[12px] font-semibold ${
                    place.scorable ? "text-warn" : "text-danger"
                  }`}
                >
                  {place.scorable
                    ? "◦ این ردیف هشدار داده دارد"
                    : "⚠ این ردیف قابل امتیازدهی نیست"}
                </div>
                <ul className="ms-4 mt-1 list-disc space-y-0.5 text-[11.5px] leading-5 text-ink-soft">
                  {place.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                {!place.scorable ? (
                  <p className="mt-1.5 text-[11px] leading-5 text-ink-soft">
                    بدون جمعیت معتبر، «تراکم» و «ظرفیت جذب» بی‌معنا می‌شوند. این
                    ردیف در فهرست می‌مانَد ولی امتیاز نمی‌گیرد. اگر عدد درست را
                    می‌دانید، همین‌جا ویرایش کنید تا وارد رتبه‌بندی شود.
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* ---------------------------------------------------- market -- */}
          <section>
            <SectionTitle title="بازار و رقابت" />
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-1">
              <RawRow
                label="دانشگاه علوم پزشکی متولی"
                value={(place.university ?? "—").replace(
                  /^دانشگاه علوم پزشکي و خدمات بهداشتی درمانی\s*/,
                  "",
                )}
                hint="مجوز تأسیس در حیطهٔ همین دانشگاه بررسی می‌شود"
              />
              <RawRow
                label="استان"
                value={place.province.replace(/^استان\s+/, "")}
              />
              <EditableField
                place={place}
                field="population"
                label="جمعیت (مبنای محاسبه)"
                value={place.population}
                sourceValue={place.fda_population}
                hint="همهٔ شاخص‌های وابسته به جمعیت از این عدد ساخته می‌شوند"
              />
              {place.has_reference === 1 ? (
                <RawRow
                  label="جمعیت سازمان (اصلی)"
                  value={group(place.fda_population)}
                  hint="عدد منتشرشدهٔ سامانهٔ سازمان — هرگز بازنویسی نمی‌شود"
                />
              ) : null}
              <EditableField
                place={place}
                field="n_pharmacy_real"
                label="داروخانهٔ حقیقی"
                value={place.n_pharmacy_real}
                sourceValue={place.src_pharmacy_real}
                hint="داروخانه‌های متعلق به شخص حقیقی، بر پایهٔ منبع"
              />
              <EditableField
                place={place}
                field="n_pharmacy_legal"
                label="داروخانهٔ حقوقی"
                value={place.n_pharmacy_legal}
                sourceValue={place.src_pharmacy_legal}
              />
              <RawRow
                label="مجموع داروخانهٔ فعال"
                value={group(place.n_pharmacy_total)}
              />
              <RawRow
                label="داروخانه در ۱۰۰ هزار نفر"
                value={num(place.pharmacies_per_100k, 1)}
                hint="مجموع داروخانه ÷ جمعیت × ۱۰۰٬۰۰۰"
              />
              <RawRow
                label="نفر به‌ازای هر داروخانه"
                value={group(place.population_per_pharmacy)}
              />
              <RawRow
                label="نسبت منتشرشدهٔ سازمان"
                value={num(place.density_reported, 1)}
                hint="(حقیقی + حقوقی + موافقت‌اصولی) ÷ جمعیت × ۱٬۰۰۰٬۰۰۰"
              />
            </div>
          </section>

          {/* ------------------------------------------ population source -- */}
          {place.has_reference === 1 ? (
            <section>
              <SectionTitle
                title="منبع جمعیت اصلاح‌شده"
                hint="هر مقدار مرجع با شمارهٔ شناسه، سال سرشماری و معیار تطبیق ثبت شده است تا قابل بازبینی باشد."
              />
              <div className="rounded-xl border border-line bg-surface-2 px-3 py-1">
                <RawRow
                  label="جمعیت مرجع"
                  value={group(place.ref_population)}
                  hint={`نسبت به عدد سازمان: ${num(place.ref_ratio, 2)} برابر`}
                />
                <RawRow
                  label="منبع"
                  value={
                    place.ref_source === "wikidata"
                      ? "ویکی‌داده (سرشماری مرکز آمار ایران)"
                      : "متن مقالهٔ ویکی‌پدیای فارسی (سرشماری)"
                  }
                />
                <RawRow
                  label="شناسهٔ منبع"
                  value={place.ref_source_id ?? "—"}
                />
                <RawRow
                  label="سال سرشماری"
                  value={
                    place.ref_census_year_sh
                      ? `${group(place.ref_census_year_sh)} (شمسی)`
                      : "—"
                  }
                />
                <RawRow label="خانوار" value={group(place.ref_households)} />
                <RawRow
                  label="درجهٔ اطمینان تطبیق"
                  value={num((place.ref_match_score ?? 0) * 100, 0) + "٪"}
                  hint={place.ref_match_method ?? undefined}
                />
              </div>
              {place.ref_source_url ? (
                <a
                  href={place.ref_source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 inline-block text-[11.5px] text-brand-ink underline decoration-dotted hover:decoration-solid"
                >
                  مشاهدهٔ منبع ↗
                </a>
              ) : null}
            </section>
          ) : null}
          {/* -------------------------------------------------- pipeline -- */}
          <section>
            <SectionTitle
              title="صف متقاضیان (رقیب‌های آیندهٔ شما)"
              hint="از سازمان غذا و دارو — این‌ها پیش از شما در صف هستند."
            />
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-1">
              <RawRow
                label="درخواست ثبت‌شده"
                value={group(place.n_req_registered)}
              />
              <RawRow
                label="درخواست درحال‌جریان"
                value={group(place.n_req_inprogress)}
              />
              <RawRow
                label="موافقت اصولی صادرشده"
                value={group(place.n_req_approved)}
                hint="مجوز اولیه گرفته‌اند؛ داروخانه‌شان به‌زودی باز می‌شود"
              />
              <RawRow label="مجموع صف" value={group(place.n_req_pipeline)} />
              <RawRow
                label="نسبت صف به داروخانهٔ موجود"
                value={num(place.pipeline_ratio, 3)}
              />
              <RawRow
                label="عرضهٔ قطعی آینده (با موافقت‌اصولی)"
                value={group(place.n_pharmacy_committed)}
              />
            </div>
          </section>

          {/* --------------------------------------------------- sizing --- */}
          <section>
            <SectionTitle
              title="ظرفیت و برآورد درآمد"
              hint={`هدف جمعیت به‌ازای هر داروخانه: ${group(place.targetPopPerPharmacy)} نفر`}
            />
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-1">
              <RawRow
                label="ظرفیت قابل جذب (تعداد داروخانه)"
                value={
                  place.absorbablePharmacies > 0 ? (
                    <span className="font-semibold text-good">
                      +{group(place.absorbablePharmacies)}
                    </span>
                  ) : (
                    <span className="text-danger">
                      {num(place.capacityGap, 1)} (اشباع)
                    </span>
                  )
                }
                hint="جمعیت ÷ هدف − داروخانهٔ فعلی"
              />
              <RawRow
                label="نسخهٔ برآوردی سهم شما (سالانه)"
                value={group(place.estScriptsForEntrant)}
                hint={`جمعیت × ${economics.scriptsPerCapitaPerYear} نسخه ÷ (${place.n_pharmacy_total} + ۱)`}
              />
              <RawRow
                label="درآمد برآوردی سالانه"
                value={irr(estRevenue)}
                hint={`بر پایه حاشیهٔ سود ${group(economics.netMarginPerScriptIRR)} ریال به‌ازای هر نسخه`}
              />
            </div>
          </section>

          {/* --------------------------------------------------- county --- */}
          {siblings.length > 1 ? (
            <section>
              <SectionTitle
                title={`سایر شهرهای ${shortCounty(place.county)}`}
                hint="برای مقایسهٔ درون‌شهرستانی"
              />
              <div className="space-y-1">
                {siblings.map((s) => (
                  <button
                    key={s.location_id}
                    type="button"
                    onClick={() => onSelect(s.location_id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-right transition ${
                      s.location_id === place.location_id
                        ? "border-brand/40 bg-brand-soft"
                        : "border-line bg-surface hover:border-line-strong"
                    }`}
                  >
                    <span className="text-[12px] font-medium text-ink">
                      {shortPlace(s.place)}
                    </span>
                    <span className="tnum text-[11px] text-muted">
                      {group(s.population)} نفر · {group(s.n_pharmacy_total)}{" "}
                      داروخانه
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <p className="text-[10.5px] leading-4 text-faint">
            داده‌ها از سامانهٔ سازمان غذا و دارو در تاریخ ثبت زیر بارگذاری
            شده‌اند و یک «عکس لحظه‌ای» هستند؛ پیش از تصمیم نهایی وضعیت جاری شهر
            را دوباره بررسی کنید.
            <br />
            زمان ثبت: <span className="tnum">{place.observed_at}</span>
          </p>
        </div>
      </aside>
    </div>
  );
}
