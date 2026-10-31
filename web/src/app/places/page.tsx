import { Suspense } from "react";
import { connection } from "next/server";
import { AdminExplorer } from "@/components/AdminExplorer";
import { loadAdminData } from "@/lib/admin";
import { group } from "@/lib/format";

/**
 * Live boundary: `node:sqlite` is synchronous, so under `cacheComponents` the
 * read would be folded into the prerender. `await connection()` forces it to
 * request time — a fresh `etl/load_admin.py` shows up on the next page load.
 */
async function LivePlaces() {
  await connection();
  const data = loadAdminData();
  return (
    <>
      <header className="mb-3">
        <div className="rounded-2xl border border-line bg-linear-to-l from-brand/[0.10] via-accent/[0.07] to-transparent px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_-16px_rgba(15,23,42,0.25)] sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-[20px] font-extrabold tracking-tight text-ink sm:text-[23px]">
                همهٔ مکان‌های استان خوزستان
              </h1>
              <p className="mt-1 max-w-3xl text-[12px] leading-5 text-muted">
                شهرستان → بخش → دهستان → شهر و روستا، مستقل از فید داروخانه. هر
                ردیف جمعیت و تعداد داروخانه‌اش را نشان می‌دهد؛ ردیف را انتخاب
                کنید تا همهٔ ارقام و منبع هرکدام را ببینید.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="rounded-md border border-brand/20 bg-brand-soft px-2 py-1 text-[11px] font-medium text-brand-ink">
                {group(data.totals.county)} شهرستان
              </span>
              <span className="rounded-md border border-accent/20 bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent">
                {group(data.totals.city)} شهر
              </span>
              <span className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[11px] font-medium text-muted">
                {group(data.totals.village)} روستا و آبادی
              </span>
              <span className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[11px] font-medium text-muted">
                {group(data.totals.withPharmacy)} دارای داروخانه
              </span>
            </div>
          </div>
        </div>
      </header>
      <AdminExplorer data={data} />
    </>
  );
}

function Loading() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-24 rounded-2xl bg-line/60" />
      <div className="h-[70vh] rounded-2xl bg-line/50" />
    </div>
  );
}

export default function Page() {
  return (
    <main className="mx-auto max-w-[1560px] px-3 py-5 sm:px-5 sm:py-6">
      <Suspense fallback={<Loading />}>
        <LivePlaces />
      </Suspense>
    </main>
  );
}
