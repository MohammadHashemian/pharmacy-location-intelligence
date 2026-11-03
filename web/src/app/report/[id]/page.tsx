import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { group, num } from "@/lib/format";
import { ReportActions } from "@/components/ReportActions";

/**
 * «گزارش منطقه» — everything the tool knows about one town on one page.
 *
 * The numbers are computed by `etl/area_report.py` and stored; this page only lays them out.
 * Nothing here is written by the model: the narrative quotes the same figures the tables show,
 * and every gap in the data is named as a gap.
 */
type Spot = {
  lat: number; lon: number; road: string; gap: number; med_600m: number;
  nearest_pharmacy_m: number; km_from_centre: number; score: number;
};
type Payload = {
  area: { area_id: number; name: string; kind: string; county: string; population: number;
    lat: number; lon: number; footprint_km2: number | null; density: number | null };
  supply: { register: number; mapped: number; pharmacies_per_100k: number | null;
    residents_per_pharmacy: number | null; nearest_km: number | null; within_1500m: number;
    within_3000m: number; capacity: number; remaining: number; coverage_note: string };
  pharmacies: { ref: string; name: string | null; lat: number; lon: number; source: string; km: number }[];
  medical: { mix: Record<string, number>; total: number;
    items: { kind: string; name: string | null; km: number }[] };
  streets: { km_by_class: Record<string, number>; arterial_km: number; collector_km: number;
    local_km: number; corridor_km: number; corridor_count: number; junctions: number;
    classified_arterial: boolean } | null;
  opportunity: { register_gap: number; hot_cells: number; unmet_residents: number };
  spots: Spot[];
  narrative?: string;
};

const KIND_FA: Record<string, string> = {
  pharmacy: "داروخانه", clinic: "درمانگاه", doctors: "مطب پزشک", doctor: "مطب پزشک",
  dentist: "دندان‌پزشکی", hospital: "بیمارستان", laboratory: "آزمایشگاه", lab: "آزمایشگاه",
};

const BENCHMARK = 5408;

function tile(lat: number, lon: number, z = 15) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
  );
  return { z, x, y };
}

async function LiveReport({ id }: { id: string }) {
  await connection();
  const areaId = Number(id);
  if (!Number.isInteger(areaId)) notFound();
  const row = one<{ payload: string; generated_at: string }>(
    "SELECT payload, generated_at FROM area_report WHERE area_id = ?", [areaId]);
  if (!row) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-[16px] font-extrabold text-ink">گزارشی برای این منطقه ساخته نشده است</h1>
        <p className="mt-2 text-[12px] text-muted">
          این گزارش با «ساخت تحلیل» ساخته می‌شود: اعداد از پایگاه داده، متن از مدل.
        </p>
        <div className="mt-3">
          <ReportActions areaId={areaId} hasNarrative={false} />
        </div>
        <Link href={`/map?settle=${areaId}`} className="mt-4 inline-block text-[11.5px] text-brand-ink underline">
          بازگشت به نقشه
        </Link>
      </main>
    );
  }
  const p = JSON.parse(row.payload) as Payload;
  const t = tile(p.area.lat, p.area.lon);
  const ratio = p.supply.residents_per_pharmacy;
  const vsBench = ratio ? Math.round((ratio / BENCHMARK) * 100) : null;

  return (
    <main className="mx-auto max-w-6xl p-3 sm:p-5">
      {/* header */}
      <div className="rounded-2xl border border-line bg-linear-to-l from-brand/[0.10] via-accent/[0.07] to-transparent px-3 py-2.5 shadow-sm sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-[11px] text-muted">
              {p.area.county} · {p.area.kind === "city" ? "شهر" : "آبادی"}
            </div>
            <h1 className="text-[19px] font-extrabold tracking-tight text-ink">{p.area.name}</h1>
            <div className="mt-0.5 text-[10.5px] text-faint">
              ساخته‌شده در <bdi dir="ltr">{row.generated_at}</bdi> · جمعیت {group(p.area.population)} نفر
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <ReportActions areaId={p.area.area_id} hasNarrative={!!p.narrative} />
            <div className="flex gap-1.5">
              <Link href={`/map?settle=${p.area.area_id}`}
                className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[10.5px] text-ink">
                باز کردن روی نقشه
              </Link>
              <Link href={`/map?lat=${p.area.lat}&lon=${p.area.lon}&k=14&m=dens`}
                className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[10.5px] text-ink">
                تراکم این محدوده
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="جمعیت" value={group(p.area.population)} />
        <Kpi label="نفر بر کیلومتر مربع" value={num(p.area.density ?? 0, 0)} />
        <Kpi label="داروخانهٔ ثبتی" value={group(p.supply.register)}
          hint={`${group(p.supply.mapped)} پین روی نقشه`} />
        <Kpi label="نفر به ازای هر داروخانه" value={group(ratio ?? 0)}
          hint={vsBench ? `${num(vsBench, 0)}٪ میانگین استان` : undefined}
          tone={vsBench !== null && vsBench < 100 ? "good" : "bad"} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {/* satellite + map */}
        <section className="rounded-2xl border border-line bg-surface p-2.5">
          <h2 className="mb-1.5 text-[12px] font-semibold text-ink">تصویر ماهواره‌ای مرکز</h2>
          <div className="overflow-hidden rounded-lg border border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/tile/${t.z}/${t.x}/${t.y}`}
              alt={`تصویر ماهواره‌ای ${p.area.name}`}
              width={512}
              height={512}
              className="h-auto w-full"
            />
          </div>
          <div className="mt-1 text-[9px] text-faint">تصویر: Esri · Maxar · Earthstar Geographics</div>
          <div className="mt-2 space-y-1 text-[10.5px]">
            <Row label="بافت ساخته‌شده" value={`${num(p.area.footprint_km2 ?? 0, 2)} کم²`} />
            <Row label="نزدیک‌ترین داروخانه" value={`${num(p.supply.nearest_km ?? 0, 2)} کیلومتر`} />
            <Row label="داروخانه در ۱٫۵ کیلومتری" value={group(p.supply.within_1500m)} />
            <Row label="ظرفیت باقی‌مانده" value={p.supply.remaining < 0
              ? `−${group(Math.abs(p.supply.remaining))}`
              : group(p.supply.remaining)} />
          </div>
          <p className="mt-1.5 rounded-md bg-warn-soft px-1.5 py-1 text-[9.5px] leading-4 text-warn">
            {p.supply.coverage_note}
          </p>
        </section>

        {/* narrative */}
        <section className="rounded-2xl border border-line bg-surface p-3 lg:col-span-2">
          <h2 className="mb-1.5 text-[12px] font-semibold text-ink">
            تحلیل نوشته‌شده <span className="text-[9.5px] font-normal text-faint">(فقط بر پایهٔ همین اعداد)</span>
          </h2>
          {p.narrative ? (
            <div className="space-y-2 text-[11.5px] leading-6 text-ink-soft">
              {p.narrative.split(/\n{2,}/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted">
              هنوز متنی ساخته نشده. با «ساخت تحلیل با مدل» نوشته می‌شود؛ اعداد همین صفحه تغییری
              نمی‌کند.
            </p>
          )}
        </section>
      </div>

      {/* streets + medical */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-surface p-2.5">
          <h2 className="mb-1.5 text-[12px] font-semibold text-ink">شبکهٔ خیابان</h2>
          {p.streets ? (
            <>
              <Bar label="شریان درجهٔ یک (OSM)" value={p.streets.arterial_km}
                total={p.streets.arterial_km + p.streets.collector_km + p.streets.local_km} color="#dc2626" />
              <Bar label="جمع‌کننده" value={p.streets.collector_km}
                total={p.streets.arterial_km + p.streets.collector_km + p.streets.local_km} color="#f59e0b" />
              <Bar label="محلی" value={p.streets.local_km}
                total={p.streets.arterial_km + p.streets.collector_km + p.streets.local_km} color="#94a3b8" />
              <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
                <Mini label="کریدور ≥ ۴۰۰ متر" value={`${num(p.streets.corridor_km, 1)} کم`} />
                <Mini label="تقاطع‌ها" value={group(p.streets.junctions)} />
                <Mini label="کریدور شمرده‌شده" value={group(p.streets.corridor_count)} />
              </div>
              {!p.streets.classified_arterial ? (
                <p className="mt-2 rounded-md bg-warn-soft px-1.5 py-1 text-[9.5px] leading-4 text-warn">
                  دادهٔ OSM این محدوده هیچ خیابان درجه‌یک/درجه‌دو ندارد؛ رتبه‌بندی خیابان‌ها از
                  طول قطعه‌ها سنجیده شده، نه از برچسب.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-[10.5px] text-muted">دادهٔ خیابان برای این محدوده ذخیره نشده است.</p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-surface p-2.5">
          <h2 className="mb-1.5 text-[12px] font-semibold text-ink">
            مراکز درمانی <span className="text-[9.5px] font-normal text-faint">({group(p.medical.total)} مورد در ۳ کیلومتری)</span>
          </h2>
          {Object.keys(p.medical.mix).length ? (
            <div className="space-y-1">
              {Object.entries(p.medical.mix).map(([k, v]) => (
                <Row key={k} label={KIND_FA[k] ?? k} value={group(v)} />
              ))}
            </div>
          ) : (
            <p className="text-[10.5px] text-muted">هیچ مرکز درمانی نقشه‌یابی‌شده‌ای در این شعاع نیست.</p>
          )}
          <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-auto">
            {p.medical.items.slice(0, 12).map((m, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-[10px]">
                <span className="truncate text-ink">{m.name ?? "بی‌نام"}</span>
                <span className="shrink-0 text-faint">{KIND_FA[m.kind] ?? m.kind} · {num(m.km, 2)} کم</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* spots */}
      <section className="mt-3 rounded-2xl border border-line bg-surface p-2.5">
        <h2 className="mb-1.5 text-[12px] font-semibold text-ink">
          نقاط پیشنهادی <span className="text-[9.5px] font-normal text-faint">(روی کریدور، دور از داروخانهٔ موجود، نزدیک تقاضا)</span>
        </h2>
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] border-collapse text-[10.5px]">
            <thead>
              <tr className="text-[9.5px] text-faint">
                <th className="px-1 py-1 text-right">#</th>
                <th className="px-1 py-1 text-right">فاصله از مرکز</th>
                <th className="px-1 py-1 text-right">نزدیک‌ترین داروخانه</th>
                <th className="px-1 py-1 text-right">مرکز درمانی در ۶۰۰ م</th>
                <th className="px-1 py-1 text-right">شکاف ثبت سازمان</th>
                <th className="px-1 py-1 text-right">امتیاز</th>
                <th className="px-1 py-1 text-right">نقشه</th>
              </tr>
            </thead>
            <tbody>
              {p.spots.map((s, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="px-1 py-1 text-faint">{group(i + 1)}</td>
                  <td className="px-1 py-1">{num(s.km_from_centre, 2)} کم</td>
                  <td className="px-1 py-1">{group(s.nearest_pharmacy_m)} متر</td>
                  <td className="px-1 py-1">{group(s.med_600m)}</td>
                  <td className="px-1 py-1">{s.gap > 0 ? group(s.gap) : "—"}</td>
                  <td className="px-1 py-1 font-medium text-brand-ink">{num(s.score, 1)}</td>
                  <td className="px-1 py-1">
                    <Link href={`/map?lat=${s.lat}&lon=${s.lon}&k=16`} className="text-brand-ink underline">
                      باز کن
                    </Link>
                  </td>
                </tr>
              ))}
              {!p.spots.length ? (
                <tr><td colSpan={7} className="px-1 py-2 text-center text-[10px] text-faint">
                  نقطه‌ای با شرایط لازم پیدا نشد.
                </td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* pharmacies */}
      <section className="mt-3 rounded-2xl border border-line bg-surface p-2.5">
        <h2 className="mb-1.5 text-[12px] font-semibold text-ink">
          داروخانه‌های نقشه‌یابی‌شده در ۳ کیلومتری ({group(p.pharmacies.length)})
        </h2>
        <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {p.pharmacies.map((ph) => (
            <li key={ph.ref} className="flex items-center justify-between gap-2 rounded-lg border border-line/70 px-1.5 py-1 text-[10px]">
              <span className="truncate text-ink">{ph.name ?? "بی‌نام"}</span>
              <span className="shrink-0 text-faint">
                {num(ph.km, 2)} کم · {ph.source === "google" ? "گوگل" : ph.source === "osm" ? "OSM" : "دستی"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  const cls = tone === "good" ? "text-good" : tone === "bad" ? "text-danger" : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-surface px-2.5 py-2">
      <div className="text-[9.5px] text-faint">{label}</div>
      <div className={`mt-0.5 text-[15px] font-extrabold tabular-nums ${cls}`}>{value}</div>
      {hint ? <div className="text-[9px] text-muted">{hint}</div> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="shrink-0 tabular-nums font-medium text-ink">{value}</span>
    </div>
  );
}

function Bar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const empty = !(value > 0);
  const pct = empty ? 0 : Math.max(2, Math.round((value / total) * 100));
  return (
    <div className="mb-0.5">
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums text-ink">{empty ? "—" : `${num(value, 1)} کم`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        {empty ? null
          : <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />}
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-1 py-1">
      <div className="text-[8.5px] text-faint">{label}</div>
      <div className="text-[11px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveReport id={id} />;
}
