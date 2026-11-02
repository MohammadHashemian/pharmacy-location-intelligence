"use client";

/**
 * «How much of this is already taken?»
 *
 * Residents per pharmacy, computed per settlement, said nothing useful: one shop in a 40 km²
 * آبادی read as «density 1». This card answers the question the number hid —
 *
 *   how much of the built-up land falls inside a 1.5 km walk of a pharmacy,
 *   how much population that is,
 *   and how many pharmacies are already above the capacity we are willing to pay for.
 *
 * The benchmark is a dial, not a measurement: 5,408 is the provincial ratio today.
 */
import { useEffect, useMemo, useState } from "react";

type Metric = { key: string; value: number; note: string };
type Row = {
  area_id: number; name: string; kind?: string; population: number;
  nearest_km?: number | null; pharmacies_1500?: number; density?: number | null;
  supply?: number; capacity: number; remaining: number;
};

const FA = "۰۱۲۳۴۵۶۷۸۹";
const pd = (v: number | string) =>
  String(v).replace(/[0-9]/g, (d) => FA[Number(d)]).replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
const num = (v: number, digits = 0) =>
  pd(Number(v).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })).replace(/\./g, "٫");

export function CapacityPanel({ initial }: { initial: Metric[] }) {
  const [metrics, setMetrics] = useState<Metric[]>(initial);
  const [benchmark, setBenchmark] = useState(() =>
    Math.round(initial.find((m) => m.key === "benchmark")?.value ?? 5408));
  const [draft, setDraft] = useState(String(benchmark));
  const [room, setRoom] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const m = useMemo(() => Object.fromEntries(metrics.map((x) => [x.key, x.value])), [metrics]);

  useEffect(() => {
    fetch("/api/capacity").then((r) => r.json()).then((d) => setRoom(d.room ?? []));
  }, []);

  const apply = async () => {
    const v = Math.round(Number(draft.replace(/[^\d]/g, "")));
    if (!v) return;
    setBusy(true);
    const r = await fetch("/api/capacity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ benchmark: v }),
    });
    if (r.ok) {
      const d = await r.json();
      setMetrics(d.metrics ?? metrics);
      setBenchmark(v);
      const again = await fetch("/api/capacity").then((x) => x.json());
      setRoom(again.room ?? []);
    }
    setBusy(false);
  };

  return (
    <div data-panel="capacity" className="rounded-2xl border border-line bg-surface p-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[12px] font-semibold text-ink"
      >
        <span>پوشش و ظرفیت خدمت</span>
        <span className="text-[10.5px] font-normal text-muted">{open ? "بستن" : "جزئیات"}</span>
      </button>

      <div className="mt-1.5 space-y-1 text-[10.5px]">
        <Line label="مساحت ساخته‌شدهٔ شهرها" value={`${num(m.builtup_km2 ?? 0)} km²`} />
        <Line
          label="در شعاع ۱٫۵ کیلومتری یک داروخانه"
          value={`${num(m.occupied_km2_1500 ?? 0)} km² — ${num(m.occupied_share_built ?? 0, 1)}٪`}
          tone="warn"
        />
        <Line
          label="جمعیت با داروخانه در ۱٫۵ کیلومتری"
          value={`${num(m.population_share_1500 ?? 0, 1)}٪`}
          tone="good"
        />
        <Line
          label="بدون دسترسی تا ۸ کیلومتر"
          value={`${num(m.population_unserved ?? 0)} نفر`}
          tone={(m.population_unserved ?? 0) > 500000 ? "bad" : undefined}
        />
        <Line label="نفر به ازای هر داروخانهٔ نقشه‌یابی‌شده" value={num(m.residents_per_pharmacy ?? 0)} />
        <Line
          label={`داروخانهٔ اشباع‌شده (بالای ${num(benchmark)} نفر)`}
          value={num(m.saturated_count ?? 0)}
          tone={(m.saturated_count ?? 0) > 0 ? "bad" : "good"}
        />
      </div>

      <div className="mt-1 text-[9px] leading-4 text-muted">
        پوشش: شعاع ۱٫۵ کیلومتر · دسترسی: ۸ کیلومتر · ظرفیت: عدد قابل تغییر
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[9.5px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#dc2626]" /> اشباع
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#16a34a]" /> جای رشد
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#f59e0b]" /> بدون داروخانه
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#94a3b8]" /> آمار ناقص
        </span>
      </div>

      {open ? (
        <>
          <div className="mt-2 flex items-center gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              inputMode="numeric"
              aria-label="ظرفیت یک داروخانه (نفر)"
              className="w-full rounded-md border border-line px-1.5 py-1 text-[10.5px] tabular-nums"
            />
            <button
              type="button"
              onClick={apply}
              disabled={busy}
              className="shrink-0 rounded-md border border-brand/40 bg-brand-soft px-2 py-1 text-[10.5px] font-medium text-brand-ink disabled:opacity-50"
            >
              {busy ? "…" : "اعمال"}
            </button>
          </div>
          <div className="mt-1 text-[9.5px] leading-4 text-muted">
            ظرفیت یک داروخانه را عوض کنید: نقشه و فهرست‌ها با همان عدد بازمحاسبه می‌شوند.
          </div>

          <div className="mt-2 text-[10px] font-semibold text-ink">
            بیشترین تقاضای بدون پوشش (جای داروخانهٔ تازه)
          </div>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto">
            {room.slice(0, 8).map((r) => (
              <li key={r.area_id} className="flex items-center justify-between gap-1 text-[10px]">
                <a href={`/map?settle=${r.area_id}`} className="truncate text-ink hover:underline">
                  {r.name}
                </a>
                <span className="shrink-0 tabular-nums text-good">
                  +{num(r.remaining)}
                  {typeof r.supply === "number" ? (
                    <span className="ms-1 text-[9px] text-muted">({num(r.supply)} داروخانه)</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Line({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const cls = tone === "good" ? "text-good" : tone === "bad" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={`shrink-0 tabular-nums font-medium ${cls}`}>{value}</span>
    </div>
  );
}
