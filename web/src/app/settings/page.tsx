import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { LlmSettings } from "@/components/LlmSettings";
import { SettingsForm } from "@/components/SettingsForm";
import { llmStatus } from "@/lib/llm";
import { listStatus } from "@/lib/settings";

/**
 * Settings — the only page that writes anything besides manual overrides.
 *
 * The key is stored in `db/pharmacy.sqlite` (`app_setting`), never returned to
 * the browser: this server component passes only the masked status down.
 */
async function LiveSettings() {
  await connection();
  const providers = listStatus();
  const llm = llmStatus();

  return (
    <>
      <header className="mb-3">
        <div className="rounded-2xl border border-line bg-linear-to-l from-brand/[0.10] via-accent/[0.07] to-transparent px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_-16px_rgba(15,23,42,0.25)] sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-[20px] font-extrabold tracking-tight text-ink sm:text-[23px]">
                تنظیمات و کلیدهای دسترسی
              </h1>
              <p className="mt-1 max-w-3xl text-[12px] leading-5 text-muted">
                کلیدهای نقشه و مدل زبانی در پایگاه‌دادهٔ محلی{" "}
                <code className="text-[11px]">db/pharmacy.sqlite</code> ذخیره می‌شوند، جایی
                که فقط سرور آن‌ها را می‌خواند؛ مرورگر همیشه نسخهٔ پوشانده (۴ نویسهٔ آخر)
                را می‌بیند. «تست» هر کلید را با یک درخواست واقعی می‌سنجد: برای نشان و
                گوگل جستجوی «داروخانه» در ۵ کیلومتری اهواز، و برای مدل زبانی یک پیام
                کوتاه به همان دروازه.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Link
                href="/map"
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/15"
              >
                نقشهٔ خوزستان
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-soft transition hover:border-brand hover:text-brand-ink"
              >
                ← داشبورد رتبه‌بندی
              </Link>
            </div>
          </div>
        </div>
      </header>

      <LlmSettings initial={llm} />

      <div className="mt-3">
        <SettingsForm initial={providers} />
      </div>

      <div className="mt-3 rounded-2xl border border-line bg-surface p-4 text-[11px] leading-5 text-muted">
        <b className="text-ink">این کلید کجا مصرف می‌شود؟</b> اسکریپت وارد‌کنندهٔ
        داروخانه‌ها (<code className="text-[10.5px]">etl/import_pharmacies.py</code>)
        همین کلید را از SQLite می‌خواند، برای هر شهرستان «داروخانه» را جستجو می‌کند
        و نقاط را در جدول <code className="text-[10.5px]">map_pharmacy</code>{" "}
        می‌نویسد؛ نقشه همان لایه را بدون تغییر نشان می‌دهد. بخش{" "}
        <b className="text-ink">مدل زبانی</b> برای قضاوت نام‌هایی است که قاعده‌ها
        نمی‌توانند تعیین کنند: اسکریپت{" "}
        <code className="text-[10.5px]">etl/classify_with_llm.py</code> همین
        ارائه‌دهنده، Base URL، مدل و کلید را از جدول{" "}
        <code className="text-[10.5px]">app_setting</code> می‌خواند (کلیدهای{" "}
        <code className="text-[10.5px]">llm_provider</code>،{" "}
        <code className="text-[10.5px]">llm_base_url</code>،{" "}
        <code className="text-[10.5px]">llm_model</code>،{" "}
        <code className="text-[10.5px]">llm_api_key</code>) و فقط ردیف‌های مبهم را
        برچسب می‌زند (داروخانه، مطب، کلینیک، نامرتبط)؛ نتیجه در{" "}
        <code className="text-[10.5px]">poi_classification</code> می‌ماند تا اجرای
        دوباره هزینه‌ای نداشته باشد. کلیدهای قدیمی OpenRouter هم هنوز خوانده
        می‌شوند تا نصب‌های قبلی نشکنند. اگر پایگاه‌داده را از صفر بسازید کلیدها هم
        پاک می‌شوند — دوباره همین‌جا واردشان کنید.
      </div>
    </>
  );
}

function Loading() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-24 rounded-2xl bg-line/60" />
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="h-48 rounded-2xl bg-line/50" />
        <div className="h-48 rounded-2xl bg-line/40" />
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <main className="mx-auto max-w-[1240px] px-3 py-5 sm:px-5 sm:py-6">
      <Suspense fallback={<Loading />}>
        <LiveSettings />
      </Suspense>
    </main>
  );
}
