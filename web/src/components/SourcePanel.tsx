"use client";

import type { DashboardData } from "@/lib/data";
import type { ScoredPlace } from "@/lib/analytics";
import { group, num, shortCounty, shortPlace } from "@/lib/format";
import { scoreColor } from "./Charts";
import { Badge, Button, Card, Empty, SectionTitle, Stat } from "./ui";

/* -------------------------------------------------------------------------- */
/* Data / source tab — provenance + how the other agent updates it            */
/* -------------------------------------------------------------------------- */

export function SourcePanel({
  data,
  scored,
  heldOut,
}: {
  data: DashboardData;
  scored: ScoredPlace[];
  /** Rows held out of the ranking, with the reason, so nothing is hidden. */
  heldOut: {
    place: string;
    county: string;
    reason: string;
    important: boolean;
  }[];
}) {
  const totalPop = data.places.reduce((a, p) => a + (p.population ?? 0), 0);
  const totalPharmacies = scored.reduce((a, p) => a + p.n_pharmacy_total, 0);
  void totalPop;
  void totalPharmacies;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat
          label="رکورد خام بارگذاری‌شده"
          value={group(data.scope.totalPlaces)}
          sub={`${group(data.scope.totalPharmacies)} داروخانه`}
        />
        <Stat
          label="در دامنهٔ تحلیل (بازار داروخانه)"
          value={group(data.scope.marketPlaces)}
          sub={`${group(data.scope.marketPharmacies)} داروخانه — پوشش ${num(
            (100 * data.scope.marketPharmacies) /
              Math.max(data.scope.totalPharmacies, 1),
            1,
          )}٪`}
          tone="brand"
        />
        <Stat
          label="خارج از دامنه"
          value={group(data.scope.nonMarketPlaces)}
          sub={`${group(data.scope.nonMarketPharmacies)} داروخانه در آبادی‌های کوچک`}
        />
        <Stat
          label="کنارگذاشته از رتبه‌بندی"
          value={group(heldOut.length)}
          sub={`از این تعداد، ${group(heldOut.filter((h) => h.important).length)} مورد مهم`}
          tone={heldOut.length ? "warn" : "good"}
        />
      </div>

      {/* ------------------------------------------------------ quality -- */}
      <Card>
        <SectionTitle
          title="کیفیت داده — چه چیزی کنار گذاشته شد و چرا"
          hint="منبع یک سامانهٔ عملیاتی زنده است، نه دادهٔ پالایش‌شده. این‌ها ردیف‌هایی هستند که رتبه‌بندی‌شان گمراه‌کننده می‌شد. هیچ ردیفی بی‌صدا حذف نمی‌شود."
        />
        <div className="mb-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead>
              <tr className="bg-surface-2 text-ink-soft">
                <th className="border-b border-line px-2.5 py-1.5 text-right font-semibold">
                  نشانه
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-right font-semibold">
                  معنی
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  تعداد
                </th>
              </tr>
            </thead>
            <tbody className="text-ink-soft">
              {(
                [
                  [
                    "pop_zero",
                    "جمعیت صفر یا خالی — نسبت داروخانه‌به‌جمعیت بی‌معنا می‌شود",
                    true,
                  ],
                  [
                    "pop_outlier",
                    "جمعیت کلان‌شهر روی آبادی کوچک نشسته (تجریش با جمعیت تهران)",
                    true,
                  ],
                  ["bad_name", "نام آبادی ناقص است («**» یا «-»)", true],
                  [
                    "no_activity",
                    "جمعیت قابل‌توجه اما نه داروخانه و نه متقاضی — احتمالاً داروخانه‌ها زیر نام شهر مجاور ثبت شده‌اند. کنار گذاشته نشد، فقط نشان‌دار شد تا خودتان بررسی کنید",
                    false,
                  ],
                ] as [string, string, boolean][]
              ).map(([flag, mean, hard]) => {
                const row = data.dq.find((d) =>
                  (d.dq_flags ?? "").includes(flag),
                );
                return (
                  <tr
                    key={flag}
                    className="border-b border-line/70 last:border-0"
                  >
                    <td className="tnum px-2.5 py-1.5 font-medium" dir="ltr">
                      {flag}
                    </td>
                    <td className="px-2.5 py-1.5 text-muted">
                      <Badge tone={hard ? "danger" : "warn"}>
                        {hard ? "کنارگذاری قطعی" : "فقط هشدار"}
                      </Badge>{" "}
                      {mean}
                    </td>
                    <td className="tnum px-2.5 py-1.5 text-left">
                      {group(row?.n_places ?? 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {heldOut.slice(0, 60).map((h, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5"
            >
              <span className="text-[12px] font-medium text-ink">
                {shortPlace(h.place)}
              </span>
              <span className="text-[11px] text-faint">
                {h.county.replace(/^شهرستان\s+/, "")}
              </span>
              <Badge tone={h.important ? "warn" : "muted"}>{h.reason}</Badge>
            </div>
          ))}
        </div>
      </Card>

      {/* -------------------------------------------------- universities -- */}
      <Card>
        <SectionTitle
          title="دانشگاه علوم پزشکی متولی"
          hint="مجوز تأسیس داروخانه در حیطهٔ یک دانشگاه علوم پزشکی صادر می‌شود، نه فقط بر اساس جغرافیا؛ پس صف متقاضیان در دو شهر هم‌استان می‌تواند متفاوت باشد."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12px]">
            <thead>
              <tr className="bg-surface-2 text-ink-soft">
                <th className="border-b border-line px-2.5 py-1.5 text-right font-semibold">
                  دانشگاه
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  آبادی در دامنه
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  جمعیت
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  داروخانه
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  در ۱۰۰ هزار
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  صف متقاضیان
                </th>
              </tr>
            </thead>
            <tbody className="text-ink-soft">
              {data.universities.slice(0, 45).map((u) => (
                <tr
                  key={u.university}
                  className="border-b border-line/70 last:border-0"
                >
                  <td className="px-2.5 py-1.5 font-medium text-ink">
                    {(u.university ?? "").replace(
                      /^دانشگاه علوم پزشکي و خدمات بهداشتی درمانی\s*/,
                      "",
                    )}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {group(u.n_market_places)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {group(u.population)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {group(u.n_pharmacy_total)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {num(u.pharmacies_per_100k, 1)}
                  </td>
                  <td className="tnum px-2.5 py-1.5 text-left">
                    {group(u.n_req_pipeline)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="منابع بارگذاری‌شده (Provenance)"
          hint="هر بارگذاری با اثر انگشت SHA-256 و زمان دقیق ثبت می‌شود تا هر عدد قابل ردیابی باشد."
        />
        {data.sources.length === 0 ? (
          <Empty>هیچ منبعی ثبت نشده است.</Empty>
        ) : (
          <div className="space-y-2">
            {data.sources.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface-2 px-3 py-2"
              >
                <Badge tone="brand">{s.kind}</Badge>
                <span className="text-[12px] font-medium text-ink" dir="ltr">
                  {s.ref.split(/[/\\]/).pop()}
                </span>
                <span className="tnum text-[11px] text-muted">
                  {group(s.row_count)} رکورد
                </span>
                {s.scope_label ? (
                  <Badge tone="accent">{s.scope_label}</Badge>
                ) : null}
                <span className="tnum ms-auto text-[11px] text-faint">
                  ثبت: {s.observed_at}
                </span>
                <span className="tnum text-[10.5px] text-faint" dir="ltr">
                  sha256:{s.sha256?.slice(0, 12) ?? "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle
          title="به‌روزرسانی داده‌ها"
          hint="لایهٔ داده مستقل از این داشبورد است؛ هر ابزار یا عاملی می‌تواند فایل تازه را بارگذاری کند."
        />
        <div className="space-y-3 text-[12.5px] leading-6 text-ink-soft">
          <div>
            <div className="mb-1 font-semibold text-ink">
              ۱) بازسازی کامل از همهٔ فایل‌های موجود در data/raw
            </div>
            <pre
              dir="ltr"
              className="tnum overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-ink"
            >{`bash etl/rebuild.sh

# این کار معادل است با:
python etl/load.py --reset \\
  --source data/raw/fda-zarfiat.html \\
  --manifest data/raw/zarfiat_manifest.json
python etl/verify_db.py`}</pre>
          </div>
          <div>
            <div className="mb-1 font-semibold text-ink">
              ۲) بارگذاری دادهٔ تازه از API بدون بازسازی
            </div>
            <pre
              dir="ltr"
              className="tnum overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-ink"
            >{`# فایل JSON را در data/inbound/ بگذارید
python etl/load.py --scan-inbound

# یا مستقیم از URL
python etl/load.py --source "https://pharmacy.fda.gov.ir/api/..." --kind json

# یا کل یک خزش صفحه‌بندی‌شده، با زمان واحد
python etl/load.py --manifest data/raw/zarfiat_manifest.json`}</pre>
          </div>
          <div>
            <div className="mb-1 font-semibold text-ink">
              ۳) چرا{" "}
              <span dir="ltr" className="tnum">
                --manifest
              </span>{" "}
              مهم است
            </div>
            <p className="text-muted">
              یک خزش صفحه‌بندی‌شده <b>یک</b> عکس لحظه‌ای است، پس همهٔ صفحه‌ها
              باید یک{" "}
              <span dir="ltr" className="tnum">
                observed_at
              </span>{" "}
              مشترک بگیرند (زمان{" "}
              <span dir="ltr" className="tnum">
                updated_at
              </span>{" "}
              مانیفست). اگر به‌جای آن از زمان تغییر فایل استفاده شود، هر صفحه یک
              عکس جداگانه ثبت می‌شود و به‌جای به‌روزرسانی، مجموعه‌ای موازی از
              ردیف‌ها ساخته می‌شود. بارگذار این حالت را تشخیص می‌دهد و هشدار
              می‌دهد.
            </p>
          </div>
          <div>
            <div className="mb-1 font-semibold text-ink">
              ۴) بارگذاری مجدد (idempotent)
            </div>
            <p className="text-muted">
              بارگذاری مجدد همان فایل، رکورد تکراری نمی‌سازد: رکوردها با کلید
              مکان + زمان مشاهده به‌روز می‌شوند. هر عکس لحظه‌ای جدید یک ردیف
              تازه در{" "}
              <span dir="ltr" className="tnum">
                location_snapshots
              </span>{" "}
              اضافه می‌کند و تاریخچه حفظ می‌شود — یعنی با چند بارگذاری در طول
              زمان، روند رشد رقابت هم در دسترس خواهد بود.
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[11.5px] leading-5 text-ink-soft">
            <b className="text-ink">دامنهٔ فعلی داده:</b> تمام ۳۱ استان،{" "}
            {group(data.scope.totalPlaces)} آبادی،{" "}
            {group(data.scope.totalPharmacies)} داروخانه. از این میان{" "}
            {group(data.scope.marketPlaces)} آبادی در دامنهٔ تحلیل‌اند (شهرها و
            آبادی‌هایی که دست‌کم ۳ داروخانه دارند) و{" "}
            {num(
              (100 * data.scope.marketPharmacies) /
                Math.max(data.scope.totalPharmacies, 1),
              1,
            )}
            ٪ داروخانه‌ها را پوشش می‌دهند.
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="ساختار پایگاه داده"
          hint="سه جدول اصلی + دو نمای محاسباتی. تعریف هر سنجه در schema.sql مستند شده است."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead>
              <tr className="bg-surface-2 text-ink-soft">
                <th className="border-b border-line px-2.5 py-1.5 text-right font-semibold">
                  جدول / نما
                </th>
                <th className="border-b border-line px-2.5 py-1.5 text-right font-semibold">
                  نقش
                </th>
              </tr>
            </thead>
            <tbody className="text-ink-soft">
              {[
                [
                  "data_sources",
                  "ثبت هر بارگذاری: نوع، مسیر، SHA-256، زمان، تعداد رکورد",
                ],
                [
                  "locations",
                  "فهرست ثابت مکان‌ها با کلید پایدار loc_key (کلید طبیعی)",
                ],
                [
                  "location_snapshots",
                  "مقادیر خام هر مشاهده؛ سری زمانی بدون بازنویسی",
                ],
                ["v_latest_snapshot", "آخرین مشاهدهٔ هر مکان"],
                ["v_metrics", "سنجه‌های مشتق: اشباع، نفر/داروخانه، نسبت صف، …"],
                ["v_county_rollup", "تجمیع در سطح شهرستان"],
                [
                  "scoring_models",
                  "محل نگهداری وزن‌های مدل امتیازدهی (قابل نسخه‌بندی)",
                ],
              ].map(([a, b]) => (
                <tr key={a} className="border-b border-line/70 last:border-0">
                  <td className="px-2.5 py-1.5 font-medium" dir="ltr">
                    {a}
                  </td>
                  <td className="px-2.5 py-1.5 text-muted">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Compare bar — pinned candidates side by side                               */
/* -------------------------------------------------------------------------- */

export function CompareBar({
  pinned,
  scored,
  onRemove,
  onClear,
  onSelect,
}: {
  pinned: number[];
  scored: ScoredPlace[];
  onRemove: (id: number) => void;
  onClear: () => void;
  onSelect: (id: number) => void;
}) {
  const rows = pinned
    .map((id) => scored.find((s) => s.location_id === id))
    .filter((r): r is ScoredPlace => !!r);
  if (!rows.length) return null;

  /* Each metric carries BOTH a display string and a raw number, so "which
     value is best" is computed from data rather than by parsing Persian-digit
     display text back into a number. */
  const metrics: {
    label: string;
    get: (r: ScoredPlace) => string;
    raw: (r: ScoredPlace) => number;
    best: "high" | "low" | "none";
  }[] = [
    {
      label: "امتیاز فرصت",
      get: (r) => num(r.scores.opportunity, 1),
      raw: (r) => r.scores.opportunity,
      best: "high",
    },
    {
      label: "جمعیت",
      get: (r) => group(r.population),
      raw: (r) => r.population ?? 0,
      best: "high",
    },
    {
      label: "داروخانه",
      get: (r) => group(r.n_pharmacy_total),
      raw: (r) => r.n_pharmacy_total,
      best: "none",
    },
    {
      label: "در ۱۰۰ هزار",
      get: (r) => num(r.pharmacies_per_100k, 1),
      raw: (r) => r.pharmacies_per_100k ?? 0,
      best: "low",
    },
    {
      label: "نفر/داروخانه",
      get: (r) => group(r.population_per_pharmacy),
      raw: (r) => r.population_per_pharmacy ?? 0,
      best: "high",
    },
    {
      label: "صف متقاضیان",
      get: (r) => group(r.n_req_pipeline),
      raw: (r) => r.n_req_pipeline,
      best: "low",
    },
    {
      label: "حداقل امتیاز",
      get: (r) => group(r.min_score),
      raw: (r) => r.min_score ?? 0,
      best: "low",
    },
    {
      label: "ظرفیت قابل جذب",
      get: (r) => `+${group(r.absorbablePharmacies)}`,
      raw: (r) => r.absorbablePharmacies,
      best: "high",
    },
  ];

  return (
    <Card className="no-print">
      <SectionTitle
        title={`مقایسهٔ ${group(rows.length)} گزینهٔ منتخب`}
        hint="بهترین مقدار در هر ردیف با رنگ سبز مشخص شده است."
        right={
          <Button variant="outline" onClick={onClear}>
            پاک‌کردن
          </Button>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[12.5px]">
          <thead>
            <tr>
              <th className="border-b border-line px-2 py-1.5 text-right font-semibold text-ink-soft">
                سنجه
              </th>
              {rows.map((r) => (
                <th
                  key={r.location_id}
                  className="border-b border-line px-2 py-1.5 text-right"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: scoreColor(r.scores.opportunity) }}
                    />
                    <button
                      type="button"
                      onClick={() => onSelect(r.location_id)}
                      className="text-[12px] font-semibold text-ink hover:text-brand-ink"
                    >
                      {shortPlace(r.place)}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(r.location_id)}
                      className="text-[11px] text-faint hover:text-danger"
                      title="حذف از مقایسه"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="text-[10.5px] font-normal text-faint">
                    {shortCounty(r.county)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const vals = rows.map((r) => m.get(r));
              let bestIdx = -1;
              if (m.best !== "none") {
                const nums = rows.map((r) => m.raw(r));
                const target =
                  m.best === "high" ? Math.max(...nums) : Math.min(...nums);
                bestIdx = nums.indexOf(target);
              }
              return (
                <tr
                  key={m.label}
                  className="border-b border-line/70 last:border-0"
                >
                  <td className="px-2 py-1.5 text-muted">{m.label}</td>
                  {vals.map((v, i) => (
                    <td
                      key={i}
                      className={`tnum px-2 py-1.5 font-medium ${
                        i === bestIdx ? "text-good" : "text-ink"
                      }`}
                    >
                      {v}
                      {i === bestIdx ? " ✓" : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
