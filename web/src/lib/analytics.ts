/** Domain types + the transparent scoring model. */

export type PlaceKind = "city" | "village" | "other";

/** Which population the derived metrics are computed from. */
export type PopulationMode = "fda" | "reference" | "manual";

/** Everything we know about one place, straight out of `v_population_choice`. */
export interface PlaceMetrics {
  location_id: number;
  loc_key: string;
  province: string;
  county: string;
  district: string;
  place: string;
  place_kind: PlaceKind;
  /** Administering university of medical sciences (دانشگاه علوم پزشکی). */
  university: string | null;
  observed_at: string;

  /* ---- population: the FDA figure and the corroborated reference ---- */
  /** The FDA feed's own جمعیت. NEVER modified by this application. */
  fda_population: number | null;
  /** Corroborated external population (Wikidata / census), or null. */
  ref_population: number | null;
  ref_source: string | null;
  ref_source_id: string | null;
  ref_source_url: string | null;
  ref_census_year_sh: number | null;
  ref_households: number | null;
  ref_match_score: number | null;
  ref_match_method: string | null;
  has_reference: number;
  /** ref_population / fda_population, when both are usable. */
  ref_ratio: number | null;

  /* ---- manual overrides: the user's own evidence, highest precedence ---- */
  manual_population: number | null;
  manual_pharmacy_real: number | null;
  manual_pharmacy_legal: number | null;
  manual_note: string | null;
  manual_updated_at: string | null;
  has_manual: number;
  /**
   * The pharmacy counts as published by the source, BEFORE any override. Kept
   * separately so the editor can show what is being overridden and so clearing
   * an override provably restores the original.
   */
  src_pharmacy_real: number;
  src_pharmacy_legal: number;

  /* ---- county-level corroboration from the provincial yearbook ---- */
  /** Yearbook's own pharmacy count for this place's county (1403). */
  salname_pharmacies_1403: number | null;
  /** Yearbook's 1395 census population for this place's county. */
  salname_county_population_1395: number | null;
  /**
   * FDA county pharmacy sum ÷ yearbook county count. ~1.0 means the two
   * independent sources agree; far from 1 means one of them needs a look.
   */
  county_pharmacy_ratio: number | null;
  /**
   * Set by `applyPopulationMode()`. Everything downstream reads THIS, which is
   * what makes the dashboard's population switch a live recalculation rather
   * than a cosmetic relabel.
   */
  population: number | null;

  city_score: number | null;
  min_score: number | null;

  n_pharmacy_real: number;
  n_pharmacy_legal: number;
  n_pharmacy_total: number;
  n_pharmacy_committed: number;

  n_req_registered: number;
  n_req_inprogress: number;
  n_req_approved: number;
  n_req_pipeline: number;

  /** Recomputed by `applyPopulationMode()` from the selected population. */
  pharmacies_per_100k: number | null;
  population_per_pharmacy: number | null;
  pipeline_ratio: number;

  /** Density as published by the FDA: (real+legal+approved)/pop*1e6 */
  density_reported: number | null;

  /**
   * 1 when the place sustains an urban pharmacy market (city-labelled, or
   * already >= 3 pharmacies). See etl/views.sql — a name-prefix-only rule
   * silently drops «تهران بزرگ», the largest market in the country.
   */
  is_market: number;
  /** Comma-separated ingest-time warnings: pop_outlier | pop_zero | bad_name. */
  dq_flags: string | null;
}

export interface CountyMetrics {
  province: string;
  county: string;
  n_places: number;
  n_cities: number;
  n_villages: number;
  population: number;
  n_pharmacy_total: number;
  n_req_registered: number;
  n_req_inprogress: number;
  n_req_approved: number;
  pharmacies_per_100k: number | null;
  population_per_pharmacy: number | null;
  max_entry_threshold: number | null;
}

export interface SourceInfo {
  id: number;
  kind: string;
  ref: string;
  sha256: string | null;
  observed_at: string;
  ingested_at: string;
  row_count: number;
  scope_label: string | null;
  status: string;
}

/* ------------------------------------------------------------------------- */
/* Scoring model                                                              */
/* ------------------------------------------------------------------------- */

/**
 * The four dimensions of "is this a good place to open a pharmacy".
 * Weights are relative — only their ratios matter. They are deliberately NOT
 * hard-coded into SQL so the dashboard can re-rank live.
 */
export interface Weights {
  /** Market size. More people == more prescriptions. */
  demand: number;
  /** Competitive head-room. Fewer pharmacies per capita == more room. */
  headroom: number;
  /** Applicant pipeline. Many queued permits == someone beats you to it. */
  pipeline: number;
  /** Administrative barrier (`min_score`). Higher == harder to win a permit. */
  barrier: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  demand: 30,
  headroom: 40,
  pipeline: 20,
  barrier: 10,
};

export interface Tunables {
  /** Places with fewer people than this are excluded from the visible list. */
  minPopulation: number;
  /**
   * Which population drives every derived metric.
   *   'fda'       — the FDA feed's own جمعیت (the default; the source of truth
   *                 for pharmacy supply, but wrong for some settlements).
   *   'reference' — substitute the corroborated external figure where one
   *                 exists, and recompute density, capacity, scripts and score.
   * Places with no reference value keep their FDA population in either mode.
   */
  populationMode: PopulationMode;
  /** Target patients per pharmacy used to size the capacity gap. */
  targetPopulationPerPharmacy: number;
  /**
   * Whose cities a place is ranked against.
   *   'national' — percentiles across every place in scope. Answers "best in the country".
   *   'province' — percentiles within the place's own province. Answers "best in
   *                the province I would actually practise in", and stops a
   *                province's thin markets from being flattened by Tehran's scale.
   */
  basis: "national" | "province";
  /**
   * Show rows whose data is suspect instead of removing them.
   *
   * Defaults to TRUE: hiding a place silently is how a real opportunity gets
   * missed. Suspect rows are listed with a warning badge and the reason, and
   * this switch is the only way they disappear — explicitly, by the user.
   */
  showFlagged: boolean;
  /**
   * Unwrap each city's county family into the main table.
   *
   * A city's relatives — the other cities of its شهرستان, which is what the
   * detail panel's «سایر شهرهای …» list shows — are otherwise reachable only one
   * panel at a time. With this on, every city-county already represented in the
   * view brings all of its market-scope siblings into the table as ordinary rows
   * (bypassing the population floor, since that floor is what hid them), so the
   * whole family can be compared side by side. Villages are never pulled in by
   * this: it is about the city family, not the whole county.
   */
  unwrapSiblings: boolean;
  weights: Weights;
}

/*
 * NOTE: there is deliberately no place-kind filter here.
 *
 * Scope is owned by `is_market` in etl/views.sql (city-labelled OR >= 3
 * pharmacies) and applied in lib/data.ts, because a name-prefix filter is
 * unsafe: «تهران بزرگ» — 3,057 pharmacies, the largest market in the country —
 * carries no «شهر» prefix and would be dropped by `place_kind = 'city'`.
 */
export const DEFAULT_TUNABLES: Tunables = {
  minPopulation: 20_000,
  populationMode: "fda",
  targetPopulationPerPharmacy: 0, // 0 => auto (median of the peer set)
  basis: "national",
  showFlagged: true,
  unwrapSiblings: false,
  weights: DEFAULT_WEIGHTS,
};

/* ------------------------------------------------------------------------- */
/* Population mode                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Recalculate every population-derived metric from the selected population, and
 * apply manual corrections.
 *
 * Precedence, highest first:
 *   1. the user's own override (manual_override) — they may hold a census page,
 *      a yearbook table or field knowledge the sources lack;
 *   2. the corroborated reference value (Wikidata / fa.wikipedia census), in
 *      'reference' or 'manual' mode;
 *   3. the FDA feed's own جمعیت.
 *
 * Nothing is overwritten on disk — this function only decides which number the
 * current view derives its metrics from. Pharmacy-count overrides win in every
 * mode, because a corrected count is a correction, not a source preference.
 */
export function applyPopulationMode(
  places: PlaceMetrics[],
  mode: PopulationMode,
): PlaceMetrics[] {
  return places.map((p) => {
    const manualPop =
      p.manual_population != null && p.manual_population > 0
        ? p.manual_population
        : null;
    const refPop =
      p.ref_population != null && p.ref_population > 0
        ? p.ref_population
        : null;

    let population: number | null;
    /* A manual population override wins in EVERY mode. It is not a source
       preference — it is a correction the user made deliberately, and it would
       be a nasty surprise for it to silently stop applying depending on which
       basis happens to be selected. The switch decides what to do when there is
       no override: prefer the corroborated reference, or the FDA figure. */
    if (manualPop != null) population = manualPop;
    else if (mode === "reference" || mode === "manual")
      population = refPop ?? p.fda_population;
    else population = p.fda_population;

    const real =
      p.manual_pharmacy_real != null
        ? p.manual_pharmacy_real
        : p.n_pharmacy_real;
    const legal =
      p.manual_pharmacy_legal != null
        ? p.manual_pharmacy_legal
        : p.n_pharmacy_legal;
    const ph = real + legal;

    return {
      ...p,
      n_pharmacy_real: real,
      n_pharmacy_legal: legal,
      n_pharmacy_total: ph,
      population,
      pharmacies_per_100k:
        population && population > 0
          ? Math.round(((ph * 100000) / population) * 100) / 100
          : null,
      population_per_pharmacy:
        ph > 0 && population && population > 0
          ? Math.round(population / ph)
          : null,
      pipeline_ratio:
        ph > 0
          ? Math.round(((p.n_req_inprogress + p.n_req_approved) / ph) * 1000) /
            1000
          : p.n_req_inprogress + p.n_req_approved,
    };
  });
}

/** Population actually used for this place under the given mode. */
export function effectivePopulation(
  p: PlaceMetrics,
  mode: PopulationMode,
): number | null {
  const manual =
    p.manual_population != null && p.manual_population > 0
      ? p.manual_population
      : null;
  const ref =
    p.ref_population != null && p.ref_population > 0 ? p.ref_population : null;
  // Mirrors applyPopulationMode exactly: a manual correction always wins.
  if (manual != null) return manual;
  if (mode === "reference" || mode === "manual") return ref ?? p.fda_population;
  return p.fda_population;
}

/**
 * What is wrong with this row — as a LIST OF WARNINGS, not a way to delete it.
 *
 * This used to be `exclusionReason()` and it silently removed rows from the
 * ranking. That is the behaviour the user objected to: a place they could name
 * (زرگان) was simply absent, with no way to tell whether it was excluded for bad
 * data or never in the source. Warnings are now attached to the row and shown;
 * whether the row is *displayed* is the user's `showFlagged` switch, and whether
 * it is *ranked* is decided per-row below (an unusable population means no
 * score, not no row).
 */
export function warningsFor(
  p: PlaceMetrics,
  mode: PopulationMode = "fda",
): string[] {
  const out: string[] = [];
  const f = p.dq_flags ?? "";

  if (p.is_market !== 1) {
    out.push("خارج از دامنهٔ بازار شهری (کمتر از ۳ داروخانه و بدون برچسب شهر)");
  }
  if (f.includes("bad_name")) out.push("نام آبادی در منبع ناقص است");
  if (f.includes("no_activity")) {
    out.push("در منبع هیچ داروخانه و هیچ متقاضی‌ای ثبت نشده");
  }

  /* A manual override or a corroborated reference supersedes the FDA's own
     population defects: once the real figure is known, a published 0 or a
     mis-joined metro value stops being a reason to distrust the row. */
  const resolved = effectivePopulation(p, mode);
  const hasOverride = p.manual_population != null && p.manual_population > 0;
  const hasRef = p.has_reference === 1 && (p.ref_population ?? 0) > 0;
  const fixed = hasOverride || (mode !== "fda" && hasRef);

  if ((resolved ?? 0) <= 0) {
    out.push("جمعیت نامعتبر است (صفر) — بدون جمعیت، تراکم و امتیاز بی‌معناست");
  } else if (!fixed && f.includes("pop_outlier")) {
    out.push("جمعیت مشکوک: احتمالاً جمعیت کلان‌شهر روی این آبادی نشسته است");
  }

  if (p.n_pharmacy_real + p.n_pharmacy_legal === 0) {
    out.push("در منبع داروخانه‌ای ثبت نشده");
  }

  /* County-level disagreement with the province's own yearbook. This is the
     cross-check the provincial annual makes possible, and it is about the
     county, not this settlement — so it warns rather than disqualifies. */
  if (
    p.county_pharmacy_ratio != null &&
    (p.county_pharmacy_ratio >= 1.35 || p.county_pharmacy_ratio <= 0.75)
  ) {
    out.push(
      "تعداد داروخانهٔ این شهرستان با سالنامهٔ رسمی استان ناهمخوان است — هر دو عدد را ببینید",
    );
  }
  return out;
}

/** Back-compat shim: the first warning, or null. Prefer `warningsFor()`. */
export function exclusionReason(
  p: PlaceMetrics,
  mode: PopulationMode = "fda",
): string | null {
  const w = warningsFor(p, mode);
  return w.length ? w[0] : null;
}

/**
 * A row whose population is a mis-joined metro figure (تجریش carrying Tehran's
 * 8.15 M against 1 pharmacy) — and nothing has fixed it yet.
 *
 * Such rows stay VISIBLE and badged, but they must not be ranked: left scorable
 * they inherit the top demand percentile and land in the top three, which is
 * precisely the "misleading" outcome to avoid. So they are excluded from the
 * percentile baseline, not from the list. A manual override or a corroborated
 * reference clears the flag, because then the figure is no longer wrong.
 */
export function isUnresolvedOutlier(
  p: PlaceMetrics,
  mode: PopulationMode = "fda",
): boolean {
  if (!(p.dq_flags ?? "").includes("pop_outlier")) return false;
  const hasOverride = p.manual_population != null && p.manual_population > 0;
  const hasRef =
    mode !== "fda" && p.has_reference === 1 && (p.ref_population ?? 0) > 0;
  return !(hasOverride || hasRef);
}

/**
 * Human-readable Persian text for each ingest-time flag.
 *
 * HARD flags (pop_outlier, pop_zero, bad_name) remove a row from the ranking —
 * a wrong population makes its density, and therefore its entire score,
 * meaningless. SOFT flags (no_activity) only badge it: the row is still a real
 * candidate, but the user has to check it on the ground before trusting it.
 */
export const DQ_LABELS: Record<string, string> = {
  pop_outlier:
    "جمعیت مشکوک: احتمالاً جمعیت کلان‌شهر روی این آبادی نشسته است (سد: کنار گذاشته شد)",
  pop_zero: "جمعیت صفر یا خالی در منبع (سد: کنار گذاشته شد)",
  bad_name: "نام آبادی در منبع ناقص است، مثل «**» (سد: کنار گذاشته شد)",
  no_activity:
    "در منبع هیچ داروخانه و هیچ متقاضی‌ای ثبت نشده؛ پیش از اعتماد میدانی بررسی کنید",
};

export const SOFT_FLAGS = new Set(["no_activity"]);

export function dqFlagList(
  flags: string | null,
): { code: string; text: string; soft: boolean }[] {
  return (flags ?? "")
    .split(",")
    .filter(Boolean)
    .map((code) => ({
      code,
      text: DQ_LABELS[code] ?? code,
      soft: SOFT_FLAGS.has(code),
    }));
}

/** Component scores, each 0..100 (100 = most attractive). */
export interface ScoreBreakdown {
  demand: number;
  headroom: number;
  pipeline: number;
  barrier: number;
  /** Weighted composite, 0..100. */
  opportunity: number;
}

export interface ScoredPlace extends PlaceMetrics {
  scores: ScoreBreakdown;
  /** Ranks (1 = best) within the current peer set. */
  rank: number;
  /** Percentile of `pharmacies_per_100k` within the peer set (0 = least served). */
  saturationPercentile: number;
  /** Target patients-per-pharmacy used for this run (auto or explicit). */
  targetPopPerPharmacy: number;
  /** Pharmacies the place could absorb before hitting the target, can be < 0. */
  capacityGap: number;
  /** max(0, capacityGap) — rounded. */
  absorbablePharmacies: number;
  /** Est. annual prescriptions the marginal entrant pharmacy would capture. */
  estScriptsForEntrant: number;
  /**
   * Everything about this row's data that deserves a second look, in Persian.
   * Empty means clean. Shown as a badge; never a reason to delete the row.
   */
  warnings: string[];
  /**
   * False when the population is unusable, so no meaningful score exists. Such
   * rows are still returned and displayed — sorted last and badged — because
   * hiding a place is how it gets missed.
   */
  scorable: boolean;
}

/* ------------------------------------------------------------------------- */
/* Statistics helpers                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Fractional (average-rank) percentile of every value in `values`, in 0..100.
 * Ties share the mean rank, so a board full of identical values does not
 * produce spurious ordering.
 */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [100];

  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avgRank = (i + j) / 2; // 0-based average rank
    const pct = (avgRank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) ranks[order[k].i] = pct;
    i = j + 1;
  }
  return ranks;
}

export function median(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Placeholder economics for the optional revenue panel. These are STARTING
 * ASSUMPTIONS, not measured values — the dashboard exposes them as inputs so
 * they can be replaced with real figures.
 */
export interface UnitEconomics {
  /** Prescriptions dispensed per person per year (whole population). */
  scriptsPerCapitaPerYear: number;
  /** Net margin kept per prescription, in IRR. */
  netMarginPerScriptIRR: number;
}

export const DEFAULT_ECONOMICS: UnitEconomics = {
  scriptsPerCapitaPerYear: 6,
  netMarginPerScriptIRR: 250_000,
};

/* ------------------------------------------------------------------------- */
/* Data-quality guard                                                         */
/* ------------------------------------------------------------------------- */

/** Places need this many people before a shared population value is notable. */
export const SUSPECT_MIN_SHARED_POPULATION = 100_000;

/**
 * Two kinds of published rows are not usable as a pharmacy market, and both
 * would otherwise sit near the top of the board:
 *
 *  1. **placeholder names** — the source ships a handful of rows whose
 *     شهر/روستا cell is `"**"` or `"-"` while carrying a whole city's
 *     population (e.g. 900,000 with one pharmacy).
 *  2. **metropole population attached to a neighbour** — `شهر تجريش` is
 *     published with Tehran's 8,154,051 population but with its own single
 *     pharmacy, so it reads as an 8-million-person white space.
 *
 * Both are detectable from the loaded snapshot alone: a name with no Persian
 * letter (or a `*`), or a population value ≥ SUSPECT_MIN_SHARED_POPULATION that
 * two or more places share. Affected places are held out of the peer set so
 * they can neither be ranked nor distort the percentile bands that everything
 * else is scored against. `places.length` vs the scored length is the audit.
 */
export function suspectPlaces(
  places: PlaceMetrics[],
): { location_id: number; place: string; reason: string }[] {
  const popCount = new Map<number, number>();
  for (const p of places) {
    const pop = p.population ?? 0;
    if (pop >= SUSPECT_MIN_SHARED_POPULATION) {
      popCount.set(pop, (popCount.get(pop) ?? 0) + 1);
    }
  }

  const out: { location_id: number; place: string; reason: string }[] = [];
  for (const p of places) {
    const name = (p.place ?? "").trim();
    if (!name || name.includes("*") || !/[\u0600-\u06FF]/.test(name)) {
      out.push({
        location_id: p.location_id,
        place: p.place,
        reason: "placeholder name (no Persian letters)",
      });
      continue;
    }
    const pop = p.population ?? 0;
    if (pop >= SUSPECT_MIN_SHARED_POPULATION && (popCount.get(pop) ?? 0) > 1) {
      out.push({
        location_id: p.location_id,
        place: p.place,
        reason: `population ${pop} shared with another place (parent-city value)`,
      });
    }
  }
  return out;
}

/**
 * Percentile ranks computed WITHIN groups (e.g. per province).
 *
 * Groups smaller than `minGroup` fall back to the global ranking: in a province
 * with a single city everyone would otherwise score a perfect 100 on every
 * dimension and land a meaningless top-10 slot.
 */
export function percentileRanksGrouped<T>(
  items: T[],
  value: (t: T) => number,
  group: (t: T) => string,
  minGroup = 3,
): number[] {
  const globalRanks = percentileRanks(items.map(value));

  const buckets = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = group(it);
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  });

  const out = new Array<number>(items.length).fill(0);
  for (const idxs of buckets.values()) {
    if (idxs.length < minGroup) {
      idxs.forEach((gi) => (out[gi] = globalRanks[gi]));
      continue;
    }
    const ranks = percentileRanks(idxs.map((i) => value(items[i])));
    idxs.forEach((gi, k) => (out[gi] = ranks[k]));
  }
  return out;
}

/** Score + rank a peer set. Pure: same input -> same output. */
export function scorePlaces(
  places: PlaceMetrics[],
  tunables: Tunables,
  economics: UnitEconomics = DEFAULT_ECONOMICS,
): ScoredPlace[] {
  /* The selected population drives every derived metric, and manual overrides
     are applied inside. Nothing is filtered out here: every place that comes in
     goes out, badged with whatever is wrong with it. */
  const work = applyPopulationMode(places, tunables.populationMode);
  if (!work.length) return [];

  /* Percentile baselines are computed over rows with a usable population only.
     Two kinds of row sit outside them: one published with 0 people (cannot
     inform a percentile) and one whose population is an unresolved mis-joined
     metro figure (would dominate the demand percentile and rank top-three on a
     number we already know is wrong). Both stay VISIBLE below, unranked and
     badged — excluded from the ranking, never from the list. */
  const base = work.filter(
    (p) =>
      (p.population ?? 0) > 0 &&
      !isUnresolvedOutlier(p, tunables.populationMode),
  );
  if (!base.length) return [];

  /* `suspectPlaces` re-derives anomalies from the rendered payload alone, so the
     board stays honest even if rows arrive from a path that never ran the ETL
     flags. It now only warns — it never removes a row. */
  const runtimeSuspects = new Set(
    suspectPlaces(work).map((s) => s.location_id),
  );

  /* Percentile basis. 'province' compares each place only against its own
     province, which is the decision-relevant frame when you already know where
     you intend to practise; 'national' finds the best slot in the country. */
  const groupOf = (p: PlaceMetrics) =>
    tunables.basis === "province" ? p.province : "__all__";

  const rDemand = percentileRanksGrouped(
    base,
    (p) => Math.log10(Math.max(p.population ?? 1, 1)),
    groupOf,
  );
  // Density used for "headroom". Places with zero pharmacies have no ratio, so
  // they are treated as the least-served possible value (ratio 0) rather than
  // being dropped — those are exactly the white-space targets we care about.
  const rDensity = percentileRanksGrouped(
    base,
    (p) => p.pharmacies_per_100k ?? 0,
    groupOf,
  );
  const rPipeline = percentileRanksGrouped(
    base,
    (p) => p.pipeline_ratio,
    groupOf,
  );
  const rBarrier = percentileRanksGrouped(
    base,
    (p) => p.min_score ?? median(base.map((q) => q.min_score ?? 0)),
    groupOf,
  );

  const pctOf = new Map<
    number,
    { demand: number; density: number; pipeline: number; barrier: number }
  >();
  base.forEach((p, i) =>
    pctOf.set(p.location_id, {
      demand: rDemand[i],
      density: rDensity[i],
      pipeline: rPipeline[i],
      barrier: rBarrier[i],
    }),
  );

  const w = tunables.weights;
  const wSum = w.demand + w.headroom + w.pipeline + w.barrier || 1;

  // --- capacity sizing -----------------------------------------------------
  const observedPopPerPharmacy = base
    .filter((p) => p.n_pharmacy_total > 0)
    .map((p) => (p.population as number) / p.n_pharmacy_total);
  const target =
    tunables.targetPopulationPerPharmacy > 0
      ? tunables.targetPopulationPerPharmacy
      : Math.round(median(observedPopPerPharmacy)) || 5_000;

  const scored: ScoredPlace[] = work.map((p) => {
    const pct = pctOf.get(p.location_id);
    const scorable = pct !== undefined;

    const scores: ScoreBreakdown = scorable
      ? {
          demand: pct.demand,
          headroom: 100 - pct.density, // less dense than peers -> better
          pipeline: 100 - pct.pipeline, // less pipeline than peers -> better
          barrier: 100 - pct.barrier, // lower threshold -> better
          opportunity: 0,
        }
      : { demand: 0, headroom: 0, pipeline: 0, barrier: 0, opportunity: 0 };

    if (scorable) {
      scores.opportunity =
        (scores.demand * w.demand +
          scores.headroom * w.headroom +
          scores.pipeline * w.pipeline +
          scores.barrier * w.barrier) /
        wSum;
    }

    const population = p.population ?? 0;
    const capacityGap = population / target - p.n_pharmacy_total;
    const competitorCount = p.n_pharmacy_total + 1; // you are the +1
    const estScriptsForEntrant =
      (population * economics.scriptsPerCapitaPerYear) / competitorCount;

    const warnings = warningsFor(p, tunables.populationMode);
    if (runtimeSuspects.has(p.location_id) && warnings.length === 0) {
      warnings.push(
        "جمعیت این ردیف با آبادی دیگری مشترک است و غیرقابل‌اعتماد است",
      );
    }

    return {
      ...p,
      scores,
      rank: 0,
      saturationPercentile: pct?.density ?? 0,
      targetPopPerPharmacy: target,
      capacityGap: Math.round(capacityGap * 10) / 10,
      absorbablePharmacies: Math.max(0, Math.round(capacityGap)),
      estScriptsForEntrant: Math.round(estScriptsForEntrant),
      warnings,
      scorable,
    };
  });

  /* Rankable rows first (best opportunity), then the unrankable ones so they are
     visible at the bottom rather than gone. */
  scored.sort((a, b) => {
    if (a.scorable !== b.scorable) return a.scorable ? -1 : 1;
    return b.scores.opportunity - a.scores.opportunity;
  });
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}
