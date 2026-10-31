"use client";

import { Button, Card, SectionTitle, Slider } from "./ui";
import {
  DEFAULT_ECONOMICS,
  DEFAULT_TUNABLES,
  type Tunables,
  type UnitEconomics,
  type Weights,
} from "@/lib/analytics";
import type { OtcAnchors } from "@/lib/data";
import { group, irr, num } from "@/lib/format";

export interface Preset {
  id: string;
  label: string;
  hint: string;
  weights: Weights;
  minPopulation?: number;
}

export const PRESETS: Preset[] = [
  {
    id: "balanced",
    label: "متوازن",
    hint: "وزن‌های پیش‌فرض: بازار، ظرفیت خالی، تحمل ورود، صف متقاضیان، سد اداری و قدرت خرید",
    weights: {
      demand: 25,
      headroom: 10,
      pipeline: 15,
      barrier: 10,
      affluence: 20,
      tolerance: 20,
    },
  },
  {
    id: "bigmarket",
    label: "بازار بزرگ",
    hint: "اولویت جمعیت؛ شهرهای پرجمعیت حتی با رقابت بیشتر",
    weights: {
      demand: 55,
      headroom: 6,
      pipeline: 7,
      barrier: 5,
      affluence: 12,
      tolerance: 15,
    },
    minPopulation: 50_000,
  },
  {
    id: "lowcompetition",
    label: "کمترین رقابت",
    hint: "اولویت شهرهایی که با ورود شما هم نسبت جمعیت به داروخانه‌شان بالاتر می‌مانَد",
    weights: {
      demand: 8,
      headroom: 20,
      pipeline: 6,
      barrier: 4,
      affluence: 12,
      tolerance: 50,
    },
  },
  {
    id: "easyentry",
    label: "ورود آسان",
    hint: "اولویت شهرهایی با حداقل امتیاز پایین‌تر (سد اداری کمتر)",
    weights: {
      demand: 16,
      headroom: 8,
      pipeline: 12,
      barrier: 44,
      affluence: 10,
      tolerance: 10,
    },
  },
  {
    id: "nopipeline",
    label: "بدون صف متقاضی",
    hint: "اولویت شهرهایی که متقاضی درحال‌جریان کمتری دارند",
    weights: {
      demand: 23,
      headroom: 10,
      pipeline: 28,
      barrier: 5,
      affluence: 14,
      tolerance: 20,
    },
  },
  {
    id: "affluent",
    label: "منطقهٔ برخوردار",
    hint: "اولویت قدرت خرید محل — جایی که فروش بدون نسخه (آرایشی، مکمل) بیشتر است",
    weights: {
      demand: 13,
      headroom: 8,
      pipeline: 8,
      barrier: 5,
      affluence: 46,
      tolerance: 20,
    },
  },
];

/** Normalised weight as a whole-number percentage (the six always sum to 100). */
export function wPct(w: Weights, k: keyof Weights): number {
  const sum =
    w.demand +
      w.headroom +
      w.pipeline +
      w.barrier +
      w.affluence +
      w.tolerance || 1;
  return Math.round((w[k] / sum) * 100);
}

export function Controls({
  tunables,
  setTunables,
  economics,
  setEconomics,
  activePreset,
  onPreset,
  onReset,
  peerCount,
  targetAuto,
  scopePlaces,
  otcAnchors,
}: {
  tunables: Tunables;
  setTunables: (t: Tunables) => void;
  economics: UnitEconomics;
  setEconomics: (e: UnitEconomics) => void;
  activePreset: string | null;
  onPreset: (p: Preset) => void;
  onReset: () => void;
  peerCount: number;
  targetAuto: number;
  /** Total analysis-scope places, before the population filter narrows the view. */
  scopePlaces: number;
  /** Yearbook anchor behind the OTC defaults; null when it is not loaded. */
  otcAnchors: OtcAnchors | null;
}) {
  const setW = (k: keyof Weights, v: number) =>
    setTunables({ ...tunables, weights: { ...tunables.weights, [k]: v } });

  return (
    <Card className="no-print space-y-4">
      {/* ------------------------------------------------------- presets -- */}
      <div>
        <SectionTitle
          title="مدل امتیازدهی"
          hint="وزن هر مؤلفه را تغییر دهید؛ رتبه‌بندی بی‌درنگ بازمحاسبه می‌شود."
          right={
            <Button onClick={onReset} title="بازگشت به مقادیر پیش‌فرض">
              بازنشانی
            </Button>
          }
        />
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              onClick={() => onPreset(p)}
              className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition ${
                activePreset === p.id
                  ? "border-brand/40 bg-brand-soft text-brand-ink"
                  : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------- weights -- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Slider
          label="اندازه بازار (جمعیت)"
          value={tunables.weights.demand}
          min={0}
          max={100}
          onChange={(v) => setW("demand", v)}
          display={`${wPct(tunables.weights, "demand")}٪`}
          hint="هرچه جمعیت بیشتر، تقاضای نسخه بیشتر."
        />
        <Slider
          label="ظرفیت خالی (رقابت کمتر)"
          value={tunables.weights.headroom}
          min={0}
          max={100}
          onChange={(v) => setW("headroom", v)}
          display={`${wPct(tunables.weights, "headroom")}٪`}
          hint="نسبت داروخانه به جمعیت پایین‌تر از هم‌رده‌ها — وضعیت امروز."
        />
        <Slider
          label="تحمل داروخانهٔ جدید (وضعیت پس از ورود شما)"
          value={tunables.weights.tolerance}
          min={0}
          max={100}
          onChange={(v) => setW("tolerance", v)}
          display={`${wPct(tunables.weights, "tolerance")}٪`}
          hint="جمعیت ÷ (موجود + موافقت‌اصولی + ۱ شما): شهری که ۵٬۰۰۰ نفر و یک داروخانه دارد امروز عالی به‌نظر می‌رسد، اما با ورود شما ۲٬۵۰۰ نفر سهم هر داروخانه می‌شود. شهری با ۲۰٬۰۰۰ نفر و ۴ داروخانه کم‌تر آب می‌رود."
        />
        <Slider
          label="صف متقاضیان (ضد رقیب)"
          value={tunables.weights.pipeline}
          min={0}
          max={100}
          onChange={(v) => setW("pipeline", v)}
          display={`${wPct(tunables.weights, "pipeline")}٪`}
          hint="متقاضی درحال‌جریان یا موافقت‌اصولی که پیش از شما وارد می‌شوند."
        />
        <Slider
          label="سد اداری (حداقل امتیاز)"
          value={tunables.weights.barrier}
          min={0}
          max={100}
          onChange={(v) => setW("barrier", v)}
          display={`${wPct(tunables.weights, "barrier")}٪`}
          hint="هرچه «حداقل امتیاز» بالاتر، گرفتن مجوز سخت‌تر."
        />
        <Slider
          label="قدرت خرید محل (فروش بدون نسخه)"
          value={tunables.weights.affluence}
          min={0}
          max={100}
          onChange={(v) => setW("affluence", v)}
          display={`${wPct(tunables.weights, "affluence")}٪`}
          hint="برخورداری منطقه: هرچه بالاتر، خرید آرایشی، بهداشتی و مکمل بیشتر — که حاشیهٔ سودش از نسخهٔ بیمه‌ای بیشتر است."
        />
      </div>

      {/* -------------------------------------------------------- market -- */}
      <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-xs font-medium text-ink-soft">
              دامنهٔ تحلیل
            </div>
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[11.5px] leading-5 text-ink-soft">
              از پیش تعیین شده: آبادی‌هایی که <b>بازار داروخانه</b> دارند — یعنی
              برچسب «شهر» دارند یا همین حالا دست‌کم ۳ داروخانه دارند. این دامنه{" "}
              <b className="tnum">{group(peerCount)}</b> آبادی از{" "}
              <b className="tnum">{group(scopePlaces)}</b> رکورد خام را در بر
              می‌گیرد.
              <p className="mt-1.5 text-faint">
                فیلتر بر اساس نام کافی نیست: «تهران بزرگ» با ۳٬۰۵۷ داروخانه —
                بزرگ‌ترین بازار کشور — برچسب «شهر» ندارد و با فیلتر نامی حذف
                می‌شد. بنابراین معیار، خودِ بازار است نه برچسب.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <Slider
            label="حداقل جمعیت"
            value={tunables.minPopulation}
            min={0}
            max={200_000}
            step={5_000}
            onChange={(v) => setTunables({ ...tunables, minPopulation: v })}
            display={group(tunables.minPopulation)}
            hint="آبادی‌های کوچک‌تر از این مقدار از فهرست دیده‌شده کنار می‌روند (امتیازها ثابت می‌مانند)."
          />
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-ink-soft">
                هدف جمعیت به‌ازای هر داروخانه
              </span>
              <span className="tnum text-xs font-semibold text-brand-ink">
                {tunables.targetPopulationPerPharmacy > 0
                  ? group(tunables.targetPopulationPerPharmacy)
                  : `خودکار (${group(targetAuto)})`}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={20_000}
                step={500}
                value={tunables.targetPopulationPerPharmacy}
                onChange={(e) =>
                  setTunables({
                    ...tunables,
                    targetPopulationPerPharmacy: Number(e.target.value),
                  })
                }
                className="w-full"
              />
            </div>
            <p className="mt-1 text-[11px] leading-4 text-faint">
              مبنای محاسبه «ظرفیت قابل جذب». مقدار خودکار = میانه نسبت
              جمعیت/داروخانه در میان شهرهای همین مجموعه.
            </p>
          </div>
        </div>
      </div>

      {/* ----------------------------------------------------- economics -- */}
      <details className="border-t border-line pt-4">
        <summary className="cursor-pointer text-xs font-medium text-ink-soft">
          فرض‌های اقتصادی (اختیاری — برای برآورد درآمد، قابل جایگزینی با اعداد
          خودتان)
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-ink-soft">
              نسخه به‌ازای هر نفر در سال
            </span>
            <input
              type="number"
              step={0.5}
              min={0}
              value={economics.scriptsPerCapitaPerYear}
              onChange={(e) =>
                setEconomics({
                  ...economics,
                  scriptsPerCapitaPerYear: Number(e.target.value),
                })
              }
              className="tnum mt-1 w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-soft">
              حاشیه سود هر نسخه (ریال)
            </span>
            <input
              type="number"
              step={10_000}
              min={0}
              value={economics.netMarginPerScriptIRR}
              onChange={(e) =>
                setEconomics({
                  ...economics,
                  netMarginPerScriptIRR: Number(e.target.value),
                })
              }
              className="tnum mt-1 w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-soft">
              فروش بدون نسخه به‌ازای هر نفر در سال (ریال)
            </span>
            <input
              type="number"
              step={1_000_000}
              min={0}
              value={economics.otcPerCapitaIRR}
              onChange={(e) =>
                setEconomics({
                  ...economics,
                  otcPerCapitaIRR: Number(e.target.value),
                })
              }
              className="tnum mt-1 w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-soft">
              کشش درآمدی فروش بدون نسخه
            </span>
            <input
              type="number"
              step={0.1}
              min={0}
              max={3}
              value={economics.otcElasticity}
              onChange={(e) =>
                setEconomics({
                  ...economics,
                  otcElasticity: Number(e.target.value),
                })
              }
              className="tnum mt-1 w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-faint">
          این اعداد اندازه‌گیری‌شده نیستند؛ مقادیر پیش‌فرض فقط برای فعال کردن
          ستون‌های «درآمد برآوردی» و «فروش بدون نسخه» است. با اعداد واقعی خودتان
          جایگزین کنید تا مقایسه معنا پیدا کند. برآورد نسخه = جمعیت × نسخه‌سرانه ÷
          (تعداد داروخانه + ۱) × حاشیه سود. برآورد بدون نسخه = جمعیت × (فروش سرانه
          × قدرت خرید<sup>کشش</sup>) ÷ (تعداد داروخانه + ۱).
        </p>
        <div className="mt-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[11px] leading-5 text-ink-soft">
          <b>لنگر رسمی مدل بدون نسخه:</b>{" "}
          {otcAnchors?.urban_hh_expenditure ? (
            <>
              هزینهٔ سالانهٔ هر خانوار شهری در سالنامهٔ آماری استان ۱۴۰۳:{" "}
              <b className="tnum">{irr(otcAnchors.urban_hh_expenditure)}</b> · روستایی:{" "}
              <b className="tnum">{irr(otcAnchors.rural_hh_expenditure)}</b> · یعنی
              روستا حدود{" "}
              <b className="tnum">{num((otcAnchors.rural_to_urban_ratio ?? 0) * 100, 0)}٪</b>{" "}
              شهر مصرف می‌کند. همین نسبت، ضریب روستا در مدل است — اندازه‌گیری‌شده،
              نه فرضی.
              {otcAnchors.urban_consumption_per_capita ? (
                <>
                  {" "}
                  مصرف سرانهٔ شهری ≈{" "}
                  <b className="tnum">
                    {irr(otcAnchors.urban_consumption_per_capita)}
                  </b>
                  ؛ پیش‌فرض بالا ۲٪ آن با فرض رشد قیمت تا امروز است.
                </>
              ) : null}
            </>
          ) : (
            <>
              سالنامهٔ استانی بارگذاری نشده است، بنابراین نسبت روستا/شهر و سطح
              پولی از مقادیر پیش‌فرضِ مستند در{" "}
              <span dir="ltr" className="tnum">
                lib/otc.ts
              </span>{" "}
              می‌آید، نه از دادهٔ رسمی.
            </>
          )}
        </div>
        <Button
          className="mt-2"
          onClick={() => setEconomics(DEFAULT_ECONOMICS)}
          variant="outline"
        >
          بازگردانی فرض‌های پیش‌فرض
        </Button>
      </details>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[11px] text-faint">
        <span>
          مجموعه مقایسه (شهرهای واجد شرط):{" "}
          <b className="tnum text-brand-ink">{peerCount}</b>
        </span>
        <span className="text-line-strong">|</span>
        <Button
          variant="ghost"
          onClick={() => setTunables({ ...DEFAULT_TUNABLES })}
          title="وزن‌ها، فیلترها و آستانه‌ها را به حالت اولیه برگردان"
        >
          تنظیمات پیش‌فرض
        </Button>
      </div>
    </Card>
  );
}
