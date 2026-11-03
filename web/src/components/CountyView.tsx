"use client";

import { useMemo, useState } from "react";
import type { CountyMetrics, ScoredPlace } from "@/lib/analytics";
import {
  group,
  num,
  shortCounty,
  shortPlace,
} from "@/lib/format";
import { scoreColor } from "./Charts";
import { Badge, Card, Empty, Meter, SectionTitle, Stat } from "./ui";

/* -------------------------------------------------------------------------- */
/* County rollup                                                              */
/* -------------------------------------------------------------------------- */

type CKey =
  | "county"
  | "population"
  | "n_cities"
  | "n_villages"
  | "n_pharmacy_total"
  | "pharmacies_per_100k"
  | "population_per_pharmacy"
  | "n_req_inprogress"
  | "n_req_approved"
  | "pipeline_ratio"
  | "best_opportunity";

interface CRow extends CountyMetrics {
  pipeline_ratio: number;
  best_opportunity: number;
  best_place: string;
}

export function CountyView({
  counties,
  scoredAll,
  onSelect,
}: {
  counties: CountyMetrics[];
  scoredAll: ScoredPlace[];
  onSelect: (id: number) => void;
}) {
  const [sort, setSort] = useState<{ key: CKey; dir: "asc" | "desc" }>({
    key: "population",
    dir: "desc",
  });

  const rows: CRow[] = useMemo(() => {
    // attach "best city in this county" from the unscored-conditioned peer set
    const best = new Map<string, ScoredPlace>();
    scoredAll.forEach((s) => {
      const cur = best.get(s.county);
      if (!cur || s.scores.opportunity > cur.scores.opportunity)
        best.set(s.county, s);
    });
    return counties.map((c) => {
      const b = best.get(c.county);
      const active = c.n_pharmacy_total;
      return {
        ...c,
        pipeline_ratio:
          active > 0
            ? (c.n_req_inprogress + c.n_req_approved) / active
            : c.n_req_inprogress + c.n_req_approved,
        best_opportunity: b ? b.scores.opportunity : 0,
        best_place: b ? b.place : "",
      };
    });
  }, [counties, scoredAll]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp =
        typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv, "fa")
          : Number(av) - Number(bv);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, sort]);

  const toggle = (key: CKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "desc" ? "asc" : "desc" }
        : { key, dir: key === "county" ? "asc" : "desc" },
    );

  const cols: { key: CKey; label: string; hint: string; num: boolean }[] = [
    { key: "county", label: "شهرستان", hint: "نام شهرستان", num: false },
    { key: "population", label: "جمعیت", hint: "جمعیت کل شهرستان", num: true },
    { key: "n_cities", label: "تعداد شهر", hint: "شهرهای شهرستان", num: true },
    {
      key: "n_villages",
      label: "تعداد روستا",
      hint: "روستاها و آبادی‌ها",
      num: true,
    },
    {
      key: "n_pharmacy_total",
      label: "داروخانه",
      hint: "مجموع داروخانه‌های شهرستان",
      num: true,
    },
    {
      key: "pharmacies_per_100k",
      label: "در ۱۰۰ هزار",
      hint: "داروخانه در ۱۰۰ هزار نفر",
      num: true,
    },
    {
      key: "population_per_pharmacy",
      label: "نفر/داروخانه",
      hint: "جمعیت به‌ازای هر داروخانه",
      num: true,
    },
    {
      key: "n_req_inprogress",
      label: "درحال‌جریان",
      hint: "درخواست‌های درحال‌جریان",
      num: true,
    },
    {
      key: "n_req_approved",
      label: "موافقت‌اصولی",
      hint: "موافقت اصولی صادرشده",
      num: true,
    },
    {
      key: "pipeline_ratio",
      label: "نسبت صف",
      hint: "صف ÷ داروخانهٔ فعال",
      num: true,
    },
    {
      key: "best_opportunity",
      label: "بهترین شهر",
      hint: "بالاترین امتیاز فرصت در شهرستان (از مجموعهٔ فیلترشده)",
      num: true,
    },
  ];

  const totalPop = rows.reduce((a, c) => a + c.population, 0);
  const totalPh = rows.reduce((a, c) => a + c.n_pharmacy_total, 0);
  const activeCounties = rows.filter((c) => c.n_cities > 0).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat
          label="شهرستان"
          value={group(rows.length)}
          sub="سطح درخواست و مجوز"
          tone="brand"
        />
        <Stat
          label="جمعیت استان (نمونه)"
          value={group(totalPop)}
          sub="مجموع جمعیت ثبت‌شده"
        />
        <Stat label="داروخانهٔ استان" value={group(totalPh)} tone="accent" />
        <Stat
          label="شهرستان دارای شهر"
          value={group(activeCounties)}
          sub="شهرستان‌های فاقد شهر در فهرست"
        />
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-3">
          <SectionTitle
            title="تجمیع در سطح شهرستان"
            hint="مجوز تأسیس در سطح شهرستان و شهر بررسی می‌شود؛ این جدول تصویر کلان هر شهرستان است."
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-surface-2">
                {cols.map((c) => {
                  const active = sort.key === c.key;
                  return (
                    <th
                      key={c.key}
                      title={c.hint}
                      onClick={() => toggle(c.key)}
                      className={`cursor-pointer select-none whitespace-nowrap border-y border-line px-2.5 py-2 font-semibold ${
                        c.num ? "text-left" : "text-right"
                      } ${active ? "text-brand-ink" : "text-ink-soft"} bg-surface-2`}
                    >
                      {c.label}
                      <span
                        className={`ms-1 text-[9px] ${active ? "" : "opacity-25"}`}
                      >
                        {active ? (sort.dir === "desc" ? "▼" : "▲") : "▼"}
                      </span>
                    </th>
                  );
                })}
                <th className="border-y border-line bg-surface-2 px-2.5 py-2 text-right font-semibold text-ink-soft">
                  بهترین گزینه
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const best = scoredAll.find(
                  (s) => s.county === c.county && s.place === c.best_place,
                );
                return (
                  <tr
                    key={c.county}
                    className="border-b border-line/70 last:border-0 hover:bg-surface-2"
                  >
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-medium text-ink">
                      {shortCounty(c.county)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {group(c.population)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {group(c.n_cities)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left text-muted">
                      {group(c.n_villages)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {group(c.n_pharmacy_total)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {num(c.pharmacies_per_100k, 1)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left text-muted">
                      {group(c.population_per_pharmacy)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {c.n_req_inprogress ? (
                        <Badge tone="warn">{group(c.n_req_inprogress)}</Badge>
                      ) : (
                        <span className="text-faint">۰</span>
                      )}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {group(c.n_req_approved)}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {num(c.pipeline_ratio, 2)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <Meter value={c.best_opportunity} width={40} />
                        <span className="tnum text-[11.5px] font-semibold text-brand-ink">
                          {num(c.best_opportunity, 1)}
                        </span>
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      {best ? (
                        <button
                          type="button"
                          onClick={() => onSelect(best.location_id)}
                          className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11.5px] font-medium text-brand-ink hover:bg-brand/20"
                        >
                          {shortPlace(best.place)}
                        </button>
                      ) : (
                        <span className="text-[11px] text-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* White-space finder                                                         */
/* -------------------------------------------------------------------------- */

export function WhiteSpace({
  rows,
  allCities,
  onSelect,
}: {
  rows: ScoredPlace[];
  allCities: ScoredPlace[];
  onSelect: (id: number) => void;
}) {
  // Under-served = fewer pharmacies per head than the provincial median, and a
  // meaningful population so the gap is actually worth money.
  const [minPop, setMinPop] = useState(30_000);

  const { gapRows, zeroPharmacy, medianDensity } = useMemo(() => {
    const dens = allCities
      .map((c) => c.pharmacies_per_100k ?? 0)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const med = dens[Math.floor(dens.length / 2)] ?? 0;
    const pool = rows.filter((r) => (r.population ?? 0) >= minPop);
    const gapRows = pool
      .map((r) => {
        const d = r.pharmacies_per_100k ?? 0;
        return {
          ...r,
          deficit: med > 0 ? (med - d) / med : 0,
          medDensity: med,
        };
      })
      .filter((r) => r.deficit > 0)
      .sort(
        (a, b) =>
          b.deficit * (b.population ?? 0) - a.deficit * (a.population ?? 0),
      );
    const zeroPharmacy = pool
      .filter((r) => r.n_pharmacy_total === 0)
      .sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    return { gapRows, zeroPharmacy, medianDensity: med };
  }, [rows, allCities, minPop]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat
          label="میانهٔ اشباع شهرهای استان"
          value={num(medianDensity, 1)}
          sub="داروخانه در ۱۰۰ هزار نفر"
          tone="accent"
        />
        <Stat
          label="شهر کم‌داروخانه‌تر از میانه"
          value={group(gapRows.length)}
          sub={`با جمعیت بالای ${group(minPop)}`}
          tone="brand"
        />
        <Stat
          label="شهر بدون هیچ داروخانه"
          value={group(zeroPharmacy.length)}
          sub="پیشتاز مطلق — ریسک بالا"
          tone="warn"
        />
        <Stat
          label="بزرگ‌ترین شکاف"
          value={gapRows[0] ? shortPlace(gapRows[0].place) : "—"}
          sub={
            gapRows[0]
              ? `${num(gapRows[0].deficit * 100, 0)}٪ کمتر از میانهٔ استان`
              : undefined
          }
          tone="good"
        />
      </div>

      <Card>
        <SectionTitle
          title="فضای خالی بازار — شهرهایی که نسبت به هم‌رده‌های خود کم‌داروخانه‌اند"
          hint="شکاف = چند درصد از میانهٔ اشباع استان کمتر هستند. مرتب‌شده بر اساس «شکاف × جمعیت» تا هم اندازهٔ بازار و هم شدت کمبود لحاظ شود."
          right={
            <label className="flex items-center gap-2 text-[11px] text-muted">
              حداقل جمعیت
              <input
                type="range"
                min={0}
                max={100_000}
                step={5_000}
                value={minPop}
                onChange={(e) => setMinPop(Number(e.target.value))}
                className="w-32"
              />
              <b className="tnum text-brand-ink">{group(minPop)}</b>
            </label>
          }
        />
        {gapRows.length === 0 ? (
          <Empty>
            در این آستانهٔ جمعیت، شهری زیر میانهٔ اشباع استان پیدا نشد.
          </Empty>
        ) : (
          <div className="space-y-1.5">
            {gapRows.slice(0, 20).map((r) => (
              <button
                key={r.location_id}
                type="button"
                onClick={() => onSelect(r.location_id)}
                className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-right transition hover:border-brand/40 hover:bg-surface-2"
              >
                <span className="w-32 shrink-0 truncate text-[12.5px] font-semibold text-ink">
                  {shortPlace(r.place)}
                </span>
                <span className="hidden w-24 shrink-0 truncate text-[11px] text-muted sm:block">
                  {shortCounty(r.county)}
                </span>
                <span className="tnum w-20 shrink-0 text-[11px] text-muted">
                  {group(r.population)} نفر
                </span>
                <span className="tnum w-24 shrink-0 text-[11px] text-muted">
                  {group(r.n_pharmacy_total)} داروخانه
                </span>
                <span className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.min(100, r.deficit * 100)}%`,
                      background: scoreColor(60 + r.deficit * 40),
                    }}
                  />
                </span>
                <span className="tnum w-14 shrink-0 text-left text-[11.5px] font-semibold text-good">
                  −{num(r.deficit * 100, 0)}٪
                </span>
                <Badge tone="muted">
                  +{group(r.absorbablePharmacies)} ظرفیت
                </Badge>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle
          title="شهرهای بدون داروخانه"
          hint="فرصت پیشتاز مطلق، اما ریسک: بدون داروخانهٔ موجود یعنی تقاضای اثبات‌نشده. جمعیت را با دقت بررسی کنید."
        />
        {zeroPharmacy.length === 0 ? (
          <Empty>هیچ شهر بی‌داروخانه‌ای در این آستانه پیدا نشد.</Empty>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {zeroPharmacy.slice(0, 40).map((r) => (
              <button
                key={r.location_id}
                type="button"
                onClick={() => onSelect(r.location_id)}
                title={`${shortCounty(r.county)} — ${group(r.population)} نفر`}
                className="tnum rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] text-ink-soft transition hover:border-brand/40 hover:bg-brand-soft"
              >
                {shortPlace(r.place)}
                <span className="ms-1 text-faint">{group(r.population)}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

