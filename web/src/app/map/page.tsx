import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { KhuzestanMap } from "@/components/KhuzestanMap";
import { loadMapData } from "@/lib/map";
import { group } from "@/lib/format";

/**
 * Live boundary: `node:sqlite` reads are synchronous, so under `cacheComponents`
 * the payload would be baked into the prerender. `await connection()` forces it
 * to request time — a fresh `python etl/build_map_layer.py` shows up on the very
 * next page load, no dev-server restart.
 */
async function LiveMap() {
  await connection();
  const data = loadMapData();
  const t = data.totals;

  return (
    <>
      <header className="mb-3">
        <div className="rounded-2xl border border-line bg-linear-to-l from-brand/[0.10] via-accent/[0.07] to-transparent px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_-16px_rgba(15,23,42,0.25)] sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-[17px] font-extrabold tracking-tight text-ink sm:text-[20px]">
                نقشهٔ استان خوزستان — سکونتگاه، جمعیت و تراکم داروخانه
              </h1>
              <p className="mt-1 max-w-3xl text-[11.5px] leading-[1.6] text-muted">
                هر شهر و روستایی که مختصات دارد، با نام شهرستان / بخش / دهستان،
                جمعیت و تعداد داروخانهٔ ثبت‌شده‌اش. رنگ روی نقشه فقط داخل محدودهٔ
                مسکونی رسم می‌شود، و فاصلهٔ هر نقطه از اهواز روی یک گراف شبکه‌ای
                پیموده می‌شود تا جستجوی محل تأسیس از نزدیک شروع و حلقه‌به‌حلقه
                گسترش پیدا کند.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <span className="rounded-md border border-brand/20 bg-brand-soft px-2 py-1 text-[11px] font-medium text-brand-ink">
                  {group(t.counties)} شهرستان
                </span>
                <span className="rounded-md border border-accent/20 bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent">
                  {group(t.cities)} شهر
                </span>
                <span className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[11px] font-medium text-muted">
                  {group(t.villages)} روستا
                </span>
                <span className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[11px] font-medium text-muted">
                  {group(t.plotted)} نقطه روی نقشه
                </span>
                <span className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[11px] font-medium text-muted">
                  {group(t.pharmacies)} داروخانه
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Link
                  href="/"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-soft transition hover:border-brand hover:text-brand-ink"
                >
                  ← داشبورد رتبه‌بندی
                </Link>
                <Link
                  href="/places"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand-ink transition hover:bg-brand/15"
                >
                  فهرست کامل مکان‌ها
                </Link>
              </div>
            </div>
          </div>
        </div>
      </header>
      <KhuzestanMap data={data} />
    </>
  );
}

function Loading() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-24 rounded-2xl bg-line/60" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="h-[60vh] rounded-2xl bg-line/50" />
        <div className="h-[60vh] rounded-2xl bg-line/40" />
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <main className="mx-auto max-w-[1240px] px-3 py-5 sm:px-5 sm:py-6">
      <Suspense fallback={<Loading />}>
        <LiveMap />
      </Suspense>
    </main>
  );
}
