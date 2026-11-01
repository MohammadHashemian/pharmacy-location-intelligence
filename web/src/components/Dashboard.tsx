"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DashboardData } from "@/lib/data";
import {
  DEFAULT_ECONOMICS,
  DEFAULT_TUNABLES,
  scorePlaces,
  type ScoredPlace,
  type Tunables,
  type UnitEconomics,
} from "@/lib/analytics";
import { suggestPerCapita } from "@/lib/otc";
import { group } from "@/lib/format";
import { heldOutRows, summarize } from "@/lib/dashboardStats";
import { Controls, type Preset } from "./Controls";
import { DensityHistogram, ScatterChart, TopBars } from "./Charts";
import { CountyView, WhiteSpace } from "./CountyView";
import { DetailPanel } from "./DetailPanel";
import { PlacesTable } from "./PlacesTable";
import { PopulationSwitch } from "./PopulationSwitch";
import { CompareBar, SourcePanel } from "./SourcePanel";
import { Button, Card, Tabs } from "./ui";
import { DashboardHeader } from "./dashboard/Header";
import { DataNotes } from "./dashboard/DataNotes";
import { ALL_PROVINCES, ScopeBar } from "./dashboard/ScopeBar";

type TabId = "rank" | "whitespace" | "counties" | "charts" | "data";

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
  const [province, setProvince] = useState<string>(ALL_PROVINCES);
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

  const { rows: visible, unwrapped: unwrappedIds } = useMemo(() => {
    const q = query.trim();
    const rows = scoredAll.filter((p) => {
      if (province !== ALL_PROVINCES && p.province !== province) return false;
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
          (province === ALL_PROVINCES || p.province === province) &&
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

  /* Held-out rows: one pass, shared by the banner (important subset) and the
     data-source panel (all rows). A flagged place is never silently dropped. */
  const heldOut = useMemo(() => heldOutRows(data.places), [data.places]);
  const importantHeldOut = useMemo(
    () => heldOut.filter((h) => h.important),
    [heldOut],
  );

  const summary = useMemo(() => summarize(visible), [visible]);
  /** Rows carrying at least one warning, in the current dataset (any province). */
  const flagCount = useMemo(
    () => scoredAll.filter((p) => p.warnings.length > 0).length,
    [scoredAll],
  );
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

  return (
    <main className="mx-auto max-w-[1560px] px-3 py-5 sm:px-5 sm:py-7">
      <DashboardHeader
        data={data}
        top={visible[0]}
        summary={summary}
        candidateCount={scoredAll.length}
        visibleCount={visible.length}
      />

      <DataNotes
        rows={importantHeldOut}
        showFlagged={tunables.showFlagged}
        onToggleFlagged={() =>
          setTunables({ ...tunables, showFlagged: !tunables.showFlagged })
        }
      />

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
              aria-label="جستجوی شهر یا شهرستان"
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

        <ScopeBar
          provinces={data.provinces}
          provinceCount={data.scope.provinces}
          candidateCount={scoredAll.length}
          province={province}
          onProvince={setProvince}
          tunables={tunables}
          onTunables={setTunables}
          activePreset={activePreset}
          onPreset={applyPreset}
          flagCount={flagCount}
          unwrappedCount={unwrappedIds.size}
          showSettings={showSettings}
          onOpenSettings={() => setShowSettings(true)}
        />
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
              showProvince={province === ALL_PROVINCES}
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
