"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DashboardData } from "@/lib/data";
import type { ScoredPlace } from "@/lib/analytics";
import type { VisibleSummary } from "@/lib/dashboardStats";
import { group, irr, num, shortPlace } from "@/lib/format";
import { jalaliFromIso } from "@/lib/jalali";
import { Badge, Button, Stat } from "../ui";

const NAV = {
  neutral:
    "border-line-strong bg-surface text-ink-soft hover:border-brand hover:text-brand-ink",
  accent:
    "border-accent/30 bg-accent-soft text-accent hover:bg-accent/15",
  brand: "border-brand/30 bg-brand-soft text-brand-ink hover:bg-brand/15",
} as const;

const NAV_LINKS: { href: string; label: string; tone: keyof typeof NAV }[] = [
  { href: "/settings", label: "تنظیمات", tone: "neutral" },
  { href: "/map", label: "نقشهٔ خوزستان و فاصله‌ها", tone: "accent" },
  { href: "/places", label: "همهٔ مکان‌ها و روستاها", tone: "brand" },
];

/** Title, scope badges, navigation and the five headline stats. */
export function DashboardHeader({
  data,
  top,
  summary,
  candidateCount,
  visibleCount,
}: {
  data: DashboardData;
  /** Best-ranked visible row, or undefined when nothing is visible. */
  top: ScoredPlace | undefined;
  summary: VisibleSummary;
  /** Every scorable place in scope (before the list filters). */
  candidateCount: number;
  visibleCount: number;
}) {
  const router = useRouter();
  const provinces = group(data.scope.provinces);

  return (
    <header className="mb-4">
      <div className="rounded-2xl border border-line bg-linear-to-l from-brand/[0.10] via-accent/[0.07] to-transparent px-4 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_-16px_rgba(15,23,42,0.25)] sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-extrabold tracking-tight text-ink sm:text-[23px]">
              انتخاب موقعیت داروخانه — سراسر کشور
            </h1>
            <p className="mt-1 max-w-3xl text-[12.5px] leading-5 text-muted">
              بر پایهٔ دادهٔ ظرفیت داروخانهٔ سازمان غذا و دارو برای تمام{" "}
              {provinces} استان. هر شهر با شش مؤلفه سنجیده می‌شود: اندازهٔ
              بازار، ظرفیت خالی، تحمل داروخانهٔ جدید (نسبت جمعیت به داروخانه
              پس از ورود شما)، صف متقاضیان، سد اداری و قدرت خرید — وزن‌ها را
              خودتان تعیین می‌کنید.
            </p>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Badge tone="brand">{provinces} استان</Badge>
              <Badge tone="accent">
                {group(data.scope.marketPlaces)} آبادی در دامنهٔ تحلیل
              </Badge>
              <Badge tone="muted">{group(data.scope.totalPlaces)} رکورد خام</Badge>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <span className="tnum text-[10.5px] text-faint">
                عکس لحظه‌ای: {jalaliFromIso(data.observedAt)}
              </span>
              <Button
                variant="outline"
                onClick={() => router.refresh()}
                title="خواندن دوبارهٔ پایگاه داده (پس از اجرای ETL)"
              >
                ↻ به‌روزرسانی
              </Button>
              {NAV_LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${NAV[l.tone]}`}
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
          <Stat
            label="بهترین گزینهٔ فعلی"
            value={top ? shortPlace(top.place) : "—"}
            sub={
              top
                ? `${top.province.replace(/^استان\s+/, "")} · امتیاز ${num(
                    top.scores.opportunity,
                    1,
                  )}`
                : undefined
            }
            tone="good"
          />
          <Stat
            label="در حال مقایسه"
            value={group(visibleCount)}
            sub={`از ${group(candidateCount)} آبادی واجد شرط`}
            tone="brand"
          />
          <Stat
            label="میانگین اشباع مجموعه"
            value={num(summary.densityPer100k, 1)}
            sub="داروخانه در ۱۰۰ هزار نفر"
            tone="accent"
          />
          <Stat
            label="بازار بدون نسخه (سالانه)"
            value={irr(summary.otcMarket)}
            sub={`میانگین برخورداری ${num(summary.avgProsperity, 0)} از ۱۰۰`}
          />
          <Stat
            label="جمعیت مقایسه‌شده"
            value={group(summary.population)}
            sub={`${group(summary.pharmacies)} داروخانهٔ فعال`}
          />
        </div>
      </div>
    </header>
  );
}
