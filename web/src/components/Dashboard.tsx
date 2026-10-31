"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DashboardData } from "@/lib/data";
import {
  DEFAULT_ECONOMICS,
  DEFAULT_TUNABLES,
  exclusionReason,
  scorePlaces,
  suspectPlaces,
  type ScoredPlace,
  type Tunables,
  type UnitEconomics,
} from "@/lib/analytics";
import { suggestPerCapita } from "@/lib/otc";
import { group, irr, num, shortPlace } from "@/lib/format";
import { jalaliFromIso } from "@/lib/jalali";
import { Controls, PRESETS, wPct, type Preset } from "./Controls";
import { DensityHistogram, ScatterChart, TopBars } from "./Charts";
import { CountyView, WhiteSpace } from "./CountyView";
import { DetailPanel } from "./DetailPanel";
import { PlacesTable } from "./PlacesTable";
import { PopulationSwitch } from "./PopulationSwitch";
import { CompareBar, SourcePanel } from "./SourcePanel";
import { Badge, Button, Card, Stat, Tabs } from "./ui";

type TabId = "rank" | "whitespace" | "counties" | "charts" | "data";
const ALL = "__all__";

export function Dashboard({ data }: { data: DashboardData }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("rank");
  const [tunables, setTunables] = useState<Tunables>(DEFAULT_TUNABLES);
  /* The OTC level is derived from the yearbook anchor when it is loaded (2% of
     measured per-person consumption, carried to today's prices); without it the
     documented fallback applies. Either way it is only a STARTING value — the
     inputs in the model panel replace it. */
  const [economics, setEconomics] = useState<UnitEconomics>(() => ({
    ...DEFAULT_ECONOMICS,
    otcPerCapitaIRR: suggestPerCapita(data.otcAnchors),
    ruralToUrbanRatio:
      data.otcAnchors?.rural_to_urban_ratio ??
      DEFAULT_ECONOMICS.ruralToUrbanRatio,
  }));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [province, setProvince] = useState<string>(ALL);
  const [activePreset, setActivePreset] = useState<string | null>("balanced");
  const [showSettings, setShowSettings] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  /* `scoredAll` scores every in-scope place with NO population floor, so the
     four component scores stay stable while you drag the population slider —
     that filter only narrows the visible list. */
  const scoredAll = useMemo(
    () =>
      scorePlaces(data.places, { ...tunables, minPopulation: 0 }, economics),
    [data.places, tunables, economics],
  );

  const {
    rows: visible,
    unwrapped: unwrappedIds,
  } = useMemo(() => {
    const q = query.trim();
    const rows = scoredAll.filter((p) => {
      if (province !== ALL && p.province !== province) return false;
      // Suspect rows are shown by default and badged; this switch is the only
      // thing that hides them, and it is the user's explicit choice.
      if (!tunables.showFlagged && p.warnings.length > 0) return false;
      // The population floor applies only to rows that have a usable
      // population — a row published with 0 people must not vanish because of a
      // floor it can never clear. Cities are exempt: a small city is still a
      // city, and hiding it is how the list looked incomplete.
      if (
        p.scorable &&
        p.place_kind !== "city" &&
        (p.population ?? 0) < tunables.minPopulation
      )
        return false;
      if (q) {
        const hit =
          p.place.includes(q) ||
          p.county.includes(q) ||
          p.district.includes(q) ||
          (p.university ?? "").includes(q);
        if (!hit) return false;
      }
      return true;
    });

    /* Unwrap the county family. For every city-county already on screen, pull in
       its market-scope siblings as ordinary rows. The population floor is
       deliberately not applied to them — clearing it is the entire point, since
       that floor is what kept them hidden inside the detail panel. Villages are
       excluded: this is about the city family, not the whole county. */
    let all = rows;
    let extra: ScoredPlace[] = [];
    if (tunables.unwrapSiblings) {
      const seen = new Set(rows.map((p) => p.location_id));
      const families = new Set(
        rows
          .filter((p) => p.is_market === 1)
          .map((p) => `${p.province}|${p.county}`),
      );
      extra = scoredAll.filter(
        (p) =>
          p.is_market === 1 &&
          !seen.has(p.location_id) &&
          families.has(`${p.province}|${p.county}`) &&
          (tunables.showFlagged || p.warnings.length === 0) &&
          (province === ALL || p.province === province) &&
          (!q ||
            p.place.includes(q) ||
            p.county.includes(q) ||
            p.district.includes(q)),
      );
      all = [...rows, ...extra];
    }

    const arr = [...all].sort(
      (a, b) => b.scores.opportunity - a.scores.opportunity,
    );
    arr.forEach((r, i) => (r.rank = i + 1));
    return {
      rows: arr,
      unwrapped: new Set(extra.map((p) => p.location_id)),
    };
  }, [
    scoredAll,
    province,
    tunables.minPopulation,
    tunables.showFlagged,
    tunables.unwrapSiblings,
    query,
  ]);

  const selected = useMemo(
    () =>
      visible.find((s) => s.location_id === selectedId) ??
      scoredAll.find((s) => s.location_id === selectedId) ??
      null,
    [visible, scoredAll, selectedId],
  );

  const siblings = useMemo(() => {
    if (!selected) return [];
    return data.places
      .filter((p) => p.county === selected.county)
      .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
      .slice(0, 12);
  }, [data.places, selected]);

  /* Held-out rows, for the transparency banner: a flagged place must never be
     silently dropped, and the user must be able to see the reason. */
  const heldOut = useMemo(() => {
    const runtime = new Map(
      suspectPlaces(data.places).map((s) => [s.location_id, s.reason]),
    );
    const out: {
      place: string;
      county: string;
      reason: string;
      important: boolean;
    }[] = [];
    for (const p of data.places) {
      const reason = exclusionReason(p) ?? runtime.get(p.location_id) ?? null;
      if (!reason) continue;
      out.push({
        place: p.place,
        county: p.county,
        reason,
        important: p.n_pharmacy_total >= 3 || (p.population ?? 0) >= 100_000,
      });
    }
    return out.sort((a, b) => Number(b.important) - Number(a.important));
  }, [data.places]);

  const targetAuto = scoredAll[0]?.targetPopPerPharmacy ?? 0;

  const applyPreset = (p: Preset) => {
    setActivePreset(p.id);
    setTunables((t) => ({
      ...t,
      weights: p.weights,
      minPopulation: p.minPopulation ?? t.minPopulation,
    }));
  };

  const setTunablesManual = (t: Tunables) => {
    setActivePreset(null);
    setTunables(t);
  };

  const togglePin = (id: number) =>
    setPinned((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-4),
    );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ------------------------------------------------------------- empty --- */
  if (!data.ready) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <Card className="space-y-4">
          <h1 className="text-xl font-bold text-ink">
            پایگاه دادهٔ داروخانه خالی است
          </h1>
          <p className="text-sm leading-6 text-ink-soft">
            دادهٔ سازمان غذا و دارو هنوز بارگذاری نشده است. ساده‌ترین راه،
            بازسازی کامل پایگاه داده از فایل‌های موجود در{" "}
            <span dir="ltr" className="tnum">
              data/raw/
            </span>{" "}
            است.
          </p>
          <pre
            dir="ltr"
            className="tnum overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[12px] text-ink"
          >{`bash etl/rebuild.sh`}</pre>
          <Button variant="primary" onClick={() => router.refresh()}>
            دوباره بررسی کن
          </Button>
        </Card>
      </main>
    );
  }

  const top = visible.slice(0, 5);
  const totalPopCities = visible.reduce((a, p) => a + (p.population ?? 0), 0);
  const totalPhCities = visible.reduce((a, p) => a + p.n_pharmacy_total, 0);
  const totalOtc = visible.reduce((a, p) => a + p.otc.market, 0);
  const avgProsperity =
    visible.length > 0
      ? visible.reduce((a, p) => a + p.prosperity, 0) / visible.length
      : 0;
  const avgDensity =
    totalPopCities > 0 ? (totalPhCities / totalPopCities) * 100_000 : 0;
  const importantHeldOut = heldOut.filter((h) => h.important);
  /** Rows carrying at least one warning, in the current dataset (any province). */
  const flagCount = scoredAll.filter((p) => p.warnings.length > 0).length;

  return (
    <main className="mx-auto max-w-[1560px] px-3 py-5 sm:px-5 sm:py-7">
      {/* ---------------------------------------------------------- header -- */}
      <header className="mb-4">
        <div className="rounded-2xl border border-line bg-linear-to-l from-brand/[0.10] via-accent/[0.07] to-transparent px-4 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_-16px_rgba(15,23,42,0.25)] sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-[20px] font-extrabold tracking-tight text-ink sm:text-[23px]">
                انتخاب موقعیت داروخانه — سراسر کشور
              </h1>
              <p className="mt-1 max-w-3xl text-[12.5px] leading-5 text-muted">
                بر پایهٔ دادهٔ ظرفیت داروخانهٔ سازمان غذا و دارو برای تمام ۳۱
                استان. هر شهر با شش مؤلفه سنجیده می‌شود: اندازهٔ بازار، ظرفیت
                خالی، تحمل داروخانهٔ جدید (نسبت جمعیت به داروخانه پس از ورود
                شما)، صف متقاضیان، سد اداری و قدرت خرید — وزن‌ها را خودتان
                تعیین می‌کنید.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <Badge tone="brand">{group(data.scope.provinces)} استان</Badge>
                <Badge tone="accent">
                  {group(data.scope.marketPlaces)} آبادی در دامنهٔ تحلیل
                </Badge>
                <Badge tone="muted">
                  {group(data.scope.totalPlaces)} رکورد خام
                </Badge>
              </div>
              <div className="flex items-center gap-1.5">
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
                <Link
                  href="/map"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/15"
                >
                  نقشهٔ خوزستان و فاصله‌ها
                </Link>
                <Link
                  href="/places"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand-ink transition hover:bg-brand/15"
                >
                  همهٔ مکان‌ها و روستاها
                </Link>
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
            <Stat
              label="بهترین گزینهٔ فعلی"
              value={top[0] ? shortPlace(top[0].place) : "—"}
              sub={
                top[0]
                  ? `${top[0].province.replace(/^استان\s+/, "")} · امتیاز ${num(
                      top[0].scores.opportunity,
                      1,
                    )}`
                  : undefined
              }
              tone="good"
            />
            <Stat
              label="در حال مقایسه"
              value={group(visible.length)}
              sub={`از ${group(scoredAll.length)} آبادی واجد شرط`}
              tone="brand"
            />
            <Stat
              label="میانگین اشباع مجموعه"
              value={num(avgDensity, 1)}
              sub="داروخانه در ۱۰۰ هزار نفر"
              tone="accent"
            />
            <Stat
              label="بازار بدون نسخه (سالانه)"
              value={irr(totalOtc)}
              sub={`میانگین برخورداری ${num(avgProsperity, 0)} از ۱۰۰`}
            />
            <Stat
              label="جمعیت مقایسه‌شده"
              value={group(totalPopCities)}
              sub={`${group(totalPhCities)} داروخانهٔ فعال`}
            />
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------ data notes -- */}
      {importantHeldOut.length ? (
        <details className="no-print mb-3 rounded-xl border border-warn/30 bg-warn-soft/50 px-3.5 py-2.5">
          <summary className="cursor-pointer text-[12px] font-semibold text-warn">
            ⚠ {group(importantHeldOut.length)} آبادی به‌دلیل مشکل داده امتیاز
            نمی‌گیرند — ولی همچنان در فهرست هستند. چرا؟
          </summary>
          <div className="mt-2 space-y-1.5 text-[11.5px] leading-5 text-ink-soft">
            <p>
              منبع، دادهٔ عملیاتی زنده است نه دادهٔ پالایش‌شده. ردیف‌هایی که از
              نظر داده ناسالم‌اند همچنان در فهرست می‌مانند و با نشان هشدار
              مشخص می‌شوند — اما <b>امتیاز نمی‌گیرند</b>، چون در غیر این صورت
              صدر جدول را با عددی اشتباه اشغال می‌کنند. اگر عدد درست را
              بدانید، از پنل جزئیات ویرایش کنید تا رتبه‌بندی شود:
            </p>
            <ul className="ms-4 list-disc space-y-0.5">
              <li>
                <b>جمعیت مشکوک:</b> جمعیت کلان‌شهر روی یک آبادی کوچک نشسته است —
                مثلاً «شهر تجریش» با جمعیت ۸٬۱۵۴٬۰۵۱ (جمعیت تهران) و فقط ۱
                داروخانه.
              </li>
              <li>
                <b>جمعیت صفر:</b> شهرهایی که جمعیت‌شان صفر ثبت شده و نسبت
                داروخانه‌به‌جمعیت برای‌شان بی‌معناست.
              </li>
              <li>
                <b>نام ناقص:</b> ردیف‌هایی با نام «**» یا «-».
              </li>
              <li>
                <b>بدون هیچ سابقهٔ داروخانه:</b> آبادی بزرگی که نه داروخانه دارد
                و نه متقاضی. این‌ها کنار گذاشته <i>نمی‌شوند</i> — فقط با علامت ⚠
                نشان‌دار می‌شوند تا خودتان میدانی بررسی کنید. نمونه: «مشکین دشت»
                با ۵۳٬۴۴۰ نفر و صفر داروخانه در منبع.
              </li>
            </ul>
            <div className="mt-2 flex flex-wrap gap-1">
              {importantHeldOut.slice(0, 12).map((h, i) => (
                <Badge key={i} tone="warn" title={h.reason}>
                  {shortPlace(h.place)} · {h.county.replace(/^شهرستان\s+/, "")}
                </Badge>
              ))}
            </div>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() =>
                setTunables({
                  ...tunables,
                  showFlagged: !tunables.showFlagged,
                })
              }
            >
              {tunables.showFlagged
                ? "پنهان‌کردن این ردیف‌ها از فهرست"
                : "نمایش دوبارهٔ این ردیف‌ها"}
            </Button>
          </div>
        </details>
      ) : null}

      {/* ------------------------------------------------------- controls -- */}
      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              {
                id: "rank",
                label: "رتبه‌بندی و مرتب‌سازی",
                badge: group(visible.length),
              },
              { id: "whitespace", label: "فضای خالی بازار" },
              {
                id: "counties",
                label: "شهرستان‌ها",
                badge: group(data.counties.length),
              },
              { id: "charts", label: "نمودارها" },
              { id: "data", label: "داده و منبع" },
            ]}
          />
          <div className="no-print flex flex-wrap items-center gap-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="جستجوی شهر یا شهرستان…  (کلید / )"
              className="w-52 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-faint focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            <Button
              variant="outline"
              onClick={() => setShowSettings((s) => !s)}
              title="نمایش/پنهان‌کردن پنل تنظیمات مدل"
            >
              {showSettings ? "▲ پنهان‌کردن مدل" : "▼ تنظیم مدل"}
            </Button>
          </div>
        </div>

        {showSettings ? (
          <Controls
            tunables={tunables}
            setTunables={setTunablesManual}
            economics={economics}
            setEconomics={setEconomics}
            activePreset={activePreset}
            onPreset={applyPreset}
            onReset={() => {
              setTunables({ ...DEFAULT_TUNABLES });
              setActivePreset("balanced");
            }}
            peerCount={visible.length}
            targetAuto={targetAuto}
            scopePlaces={scoredAll.length}
            otcAnchors={data.otcAnchors}
          />
        ) : null}

        {/* Always-visible scoping bar: the two controls that change WHICH places
            are compared, plus the one-click presets. */}
        <Card className="no-print mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-2 py-2.5">
          <span className="text-[11px] font-medium text-muted">استان:</span>
          <select
            value={province}
            onChange={(e) => setProvince(e.target.value)}
            className="max-w-52 rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11.5px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          >
            <option value={ALL}>
              همهٔ {group(data.scope.provinces)} استان (
              {group(scoredAll.length)})
            </option>
            {data.provinces.map((p) => (
              <option key={p.province} value={p.province}>
                {p.province.replace(/^استان\s+/, "")} ({group(p.n_places)})
              </option>
            ))}
          </select>

          <span className="mx-1 hidden h-4 w-px bg-line-strong sm:block" />

          {/* Nothing is hidden by default. This is the user's explicit choice to
              narrow the list, not a silent filter. */}
          <button
            type="button"
            onClick={() =>
              setTunables({ ...tunables, showFlagged: !tunables.showFlagged })
            }
            aria-pressed={tunables.showFlagged}
            title={
              tunables.showFlagged
                ? "همهٔ آبادی‌ها نمایش داده می‌شوند؛ موارد مشکوک با نشان هشدار مشخص‌اند"
                : "آبادی‌های دارای هشدار پنهان شده‌اند — با کلیک دوباره برگردانید"
            }
            className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
              tunables.showFlagged
                ? "border-warn/40 bg-warn-soft/60 text-warn"
                : "border-line bg-surface text-muted hover:border-line-strong"
            }`}
          >
            {tunables.showFlagged ? "◉" : "◌"} نمایش موارد مشکوک
          </button>
          {flagCount > 0 ? (
            <span className="tnum text-[11px] text-faint">
              ({group(flagCount)} ردیف نشان‌دار)
            </span>
          ) : null}

          {/* Unwrap: a city's county family lives only inside its detail panel by
              default. This pulls the whole family into the table as ordinary rows
              so every city can be compared at once. */}
          <button
            type="button"
            onClick={() =>
              setTunables({
                ...tunables,
                unwrapSiblings: !tunables.unwrapSiblings,
              })
            }
            aria-pressed={tunables.unwrapSiblings}
            title={
              tunables.unwrapSiblings
                ? "همهٔ شهرهای هم‌شهرستان نمایش داده می‌شوند — با کلیک دوباره ببندید"
                : "شهرهای هم‌شهرستان (خانوادهٔ هر شهر) را به‌جای پنل، به‌صورت ردیف در همین جدول باز کن تا همه را کنار هم مقایسه کنی"
            }
            className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
              tunables.unwrapSiblings
                ? "border-brand/40 bg-brand-soft text-brand-ink"
                : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
            }`}
          >
            {tunables.unwrapSiblings ? "⊟" : "⊞"} بازکردن همهٔ شهرهای
            هم‌شهرستان
          </button>
          {tunables.unwrapSiblings ? (
            <span className="tnum text-[11px] text-faint">
              ({group(unwrappedIds.size)} شهر هم‌خانواده به جدول افزوده شد)
            </span>
          ) : null}

          <span className="mx-1 hidden h-4 w-px bg-line-strong sm:block" />

          <span className="text-[11px] font-medium text-muted">
            مبنای مقایسه:
          </span>
          <div className="flex gap-1">
            {(
              [
                ["national", "کل کشور"],
                ["province", "داخل هر استان"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTunables({ ...tunables, basis: id })}
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                  tunables.basis === id
                    ? "border-brand/40 bg-brand-soft text-brand-ink"
                    : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="mx-1 hidden h-4 w-px bg-line-strong sm:block" />

          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.hint}
                onClick={() => applyPreset(p)}
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                  activePreset === p.id
                    ? "border-brand/40 bg-brand-soft text-brand-ink"
                    : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <span className="tnum text-[11px] text-faint">
            · بازار {num(wPct(tunables.weights, "demand"), 0)}٪ · ظرفیت{" "}
            {num(wPct(tunables.weights, "headroom"), 0)}٪ · تحمل{" "}
            {num(wPct(tunables.weights, "tolerance"), 0)}٪ · صف{" "}
            {num(wPct(tunables.weights, "pipeline"), 0)}٪ · سد اداری{" "}
            {num(wPct(tunables.weights, "barrier"), 0)}٪ · برخورداری{" "}
            {num(wPct(tunables.weights, "affluence"), 0)}٪ · حداقل جمعیت{" "}
            {group(tunables.minPopulation)}
          </span>

          {!showSettings ? (
            <Button
              variant="outline"
              className="ms-auto"
              onClick={() => setShowSettings(true)}
            >
              تنظیم دقیق مدل
            </Button>
          ) : null}
        </Card>
      </div>

      {/* Population basis: the FDA figure vs the corroborated census figure.
          Changing it re-derives every population-dependent metric and score. */}
      <PopulationSwitch
        mode={tunables.populationMode}
        setMode={(m) => setTunables({ ...tunables, populationMode: m })}
        places={data.places}
        reference={data.reference}
      />

      {/* ----------------------------------------------------------- body -- */}
      <div className="space-y-4">
        {tab === "rank" ? (
          <Card padded={false} className="p-4 sm:p-5">
            <PlacesTable
              rows={visible}
              economics={economics}
              selectedId={selectedId}
              showProvince={province === ALL}
              onSelect={setSelectedId}
              unwrappedIds={unwrappedIds}
            />
          </Card>
        ) : null}

        {tab === "whitespace" ? (
          <WhiteSpace
            rows={visible}
            allCities={scoredAll}
            onSelect={setSelectedId}
          />
        ) : null}

        {tab === "counties" ? (
          <CountyView
            counties={data.counties}
            scoredAll={scoredAll}
            onSelect={setSelectedId}
          />
        ) : null}

        {tab === "charts" ? (
          <div className="space-y-4">
            <ScatterChart
              rows={visible}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <TopBars
                rows={visible}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              <DensityHistogram rows={visible} />
            </div>
          </div>
        ) : null}

        {tab === "data" ? (
          <SourcePanel data={data} scored={scoredAll} heldOut={heldOut} />
        ) : null}

        <CompareBar
          pinned={pinned}
          scored={scoredAll}
          onRemove={(id) => setPinned((p) => p.filter((x) => x !== id))}
          onClear={() => setPinned([])}
          onSelect={setSelectedId}
        />

        <Card className="no-print">
          <p className="text-[11px] leading-5 text-faint">
            <b className="text-muted">راهنما:</b> کلید <kbd>/</kbd> جستجو · کلید{" "}
            <kbd>Esc</kbd> بستن پنل جزئیات · کلیک روی سطر جدول = جزئیات کامل ·
            دکمهٔ «‎+ مقایسه» در پنل جزئیات تا ۴ گزینه را کنار هم می‌گذارد.
            <br />
            امتیازها «رتبهٔ صدکی درون مجموعهٔ مقایسه» هستند، نه مقدار مطلق. با
            «کل کشور» هر شهر با تمام کشور سنجیده می‌شود؛ با «داخل هر استان» فقط
            با شهرهای همان استان. همهٔ فرمول‌ها در{" "}
            <span dir="ltr" className="tnum">
              etl/views.sql
            </span>{" "}
            و{" "}
            <span dir="ltr" className="tnum">
              web/src/lib/analytics.ts
            </span>{" "}
            مستندشده‌اند.
          </p>
        </Card>
      </div>

      <DetailPanel
        place={selected}
        siblings={siblings}
        tunables={tunables}
        economics={economics}
        peerCount={scoredAll.length}
        pinned={pinned}
        onTogglePin={togglePin}
        onClose={() => setSelectedId(null)}
        onSelect={setSelectedId}
      />
    </main>
  );
}
