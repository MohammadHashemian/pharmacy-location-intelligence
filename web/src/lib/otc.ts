/**
 * Over-the-counter demand model — «فروش بدون نسخه».
 *
 * A pharmacy's insured prescriptions are paid by the insurer at a regulated
 * margin. The part of the business that actually differentiates one pharmacy
 * from another is the out-of-pocket basket: OTC drugs, supplements, cosmetics,
 * hygiene. That basket is NOT proportional to population — a village of 4,000
 * people and a district of 4,000 people in a metropolis buy very different
 * amounts of it. So two places with identical populations can have very
 * different OTC turnover, and that is what this module estimates.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND WHAT IS ASSUMED
 * ---------------------------------------------------------------------------
 * Nothing in the loaded data states a household's income per settlement. What
 * the data DOES support is a relative buying-power index built from observable
 * structure, plus one official anchor for its level:
 *
 *   measured (etl/views.sql: v_place_prosperity, v_otc_anchors)
 *     · rural/urban household spending ratio, سالنامه ۱۴۰۳ خوزستان (≈ 0.6)
 *     · county urbanisation: share of the county's people living in a city, or
 *       in a settlement ≥ 10,000, or one already sustaining 3+ pharmacies
 *     · persons per household, from the corroborated census figure (when the
 *       reference-population layer is loaded; NULL means "unknown", never an
 *       average)
 *
 *   assumed (the user's, exposed as inputs — never silently baked in)
 *     · OTC + cosmetics + supplements as a share of household consumption (2%)
 *     · inflation from 1403 to today, so the default is at today's prices
 *     · how elastic per-capita sales are to buying power (default 1.3: a place
 *       20% richer buys ~26% more per head, which is what the category's
 *       income elasticity looks like)
 *
 * The index is normalised to a POPULATION-WEIGHTED MEAN OF 1.0 over the places
 * being compared, so `buying_power = 1.2` reads "about 20% above the national
 * average", and the per-capita money figure stays consistent with the total.
 *
 * Deliberately NOT modelled, because the data cannot support it without
 * inventing numbers: distance to a metropolis, foot traffic, competitor
 * positioning, insurer mix. They are listed in the UI as known omissions rather
 * than folded in as fake precision.
 */

/** Tunable per-head sales assumptions. Part of `UnitEconomics`. */
export interface OtcAssumptions {
  /**
   * Annual OTC + cosmetics + supplement sales per person, in rial, for a place
   * of AVERAGE buying power. This is the one number that sets the level of
   * every money figure the dashboard prints.
   */
  perCapitaIRR: number;
  /** >1 = richer places spend disproportionately more per head. */
  elasticity: number;
  /**
   * Measured relative spending of a rural household vs an urban one
   * (سالنامه ۱۴۰۳: 1,560,873 / 2,618,460 = 0.596). Taken from the database when
   * the yearbook is loaded, so this is a fallback, not a guess.
   */
  ruralToUrbanRatio: number;
}

export const DEFAULT_OTC: OtcAssumptions = {
  perCapitaIRR: 28_000_000,
  elasticity: 1.3,
  ruralToUrbanRatio: 0.596,
};

/** Assumed OTC+cosmetics share of household consumption, for deriving a default. */
export const OTC_SHARE_OF_CONSUMPTION = 0.02;
/** Cumulative price growth from 1403 (the yearbook's year) to today. */
export const INFLATION_SINCE_1403 = 1.8;
/** Reference household size the household-size factor is measured against. */
export const NATIONAL_HOUSEHOLD_SIZE = 3.5;

/**
 * Suggested per-capita default, derived from the official yearbook anchor when
 * it is loaded: 2% of a Khuzestan urban household's per-person consumption in
 * 1403, carried forward to today's prices. Falls back to `DEFAULT_OTC`.
 */
export function suggestPerCapita(
  anchors: { urban_consumption_per_capita: number | null } | null | undefined,
): number {
  const perPerson = anchors?.urban_consumption_per_capita;
  if (!perPerson || perPerson <= 0) return DEFAULT_OTC.perCapitaIRR;
  const now = perPerson * INFLATION_SINCE_1403;
  const v = Math.round((now * OTC_SHARE_OF_CONSUMPTION) / 100_000) * 100_000;
  // A zero/share-less anchor (a partially loaded yearbook) must not produce a
  // meaningless default, so the fallback wins outside a plausible band.
  return v >= 2_000_000 ? v : DEFAULT_OTC.perCapitaIRR;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface AffluenceFactors {
  /** City vs village, scaled by the measured rural/urban spending ratio. */
  urbanity: number;
  /** How urbanised the whole county is (0.85 … 1.20). */
  countyUrban: number;
  /** Fewer persons per household = better-off (0.85 … 1.15); 1 when unknown. */
  household: number;
  /** Bigger settlement = more local commerce, clinics, banks (0.85 … 1.15). */
  agglomeration: number;
  /** The product of the four. */
  raw: number;
}

/**
 * The four observable factors behind a place's buying power. Every one of them
 * is bounded, so a single freak input cannot invent a rich village; and every
 * one of them is returned so the UI can show its contribution instead of a
 * single opaque score.
 */
export function affluenceFactors(
  place: {
    place_kind: string;
    population: number | null;
    county_urban_share: number | null;
    hh_size: number | null;
  },
  ruralToUrbanRatio: number,
): AffluenceFactors {
  const ratio = clamp(ruralToUrbanRatio || DEFAULT_OTC.ruralToUrbanRatio, 0.3, 1);

  const urbanity =
    place.place_kind === "city"
      ? 1
      : place.place_kind === "village"
        ? ratio
        : (1 + ratio) / 2; // 'other' is the source's catch-all — e.g. تهران بزرگ

  const u = place.county_urban_share;
  const countyUrban = u == null ? 1 : 0.85 + 0.35 * clamp(u, 0, 1);

  const hh = place.hh_size;
  const household =
    hh != null && hh > 0
      ? clamp(NATIONAL_HOUSEHOLD_SIZE / hh, 0.85, 1.15)
      : 1;

  const pop = Math.max(place.population ?? 0, 200);
  const agglomeration = clamp(1 + 0.06 * (Math.log10(pop) - 3), 0.85, 1.15);

  return {
    urbanity,
    countyUrban,
    household,
    agglomeration,
    raw: urbanity * countyUrban * household * agglomeration,
  };
}

/**
 * Population-weighted mean of the raw factors: the divisor that turns them into
 * "1.0 = the national average". Weighting by population is what makes the
 * headline per-capita figure and the place-level figures add up.
 */
export function affluenceScale(
  places: {
    place_kind: string;
    population: number | null;
    county_urban_share: number | null;
    hh_size: number | null;
  }[],
  ruralToUrbanRatio: number,
): number {
  let num = 0;
  let den = 0;
  for (const p of places) {
    const pop = p.population ?? 0;
    if (pop <= 0) continue;
    num += pop * affluenceFactors(p, ruralToUrbanRatio).raw;
    den += pop;
  }
  return den > 0 && num > 0 ? num / den : 1;
}

/** Buying power relative to the national average (1 = average). */
export function buyingPower(place: Parameters<typeof affluenceFactors>[0], scale: number, ruralToUrbanRatio: number): number {
  const raw = affluenceFactors(place, ruralToUrbanRatio).raw;
  return scale > 0 ? raw / scale : raw;
}

/**
 * Rank of `value` inside `sortedValues` (ascending), 0–100, ties sharing the
 * mean position. Used for the display index so "برخورداری" means the same thing
 * everywhere else on the board — a percentile rank — instead of an absolute
 * number nobody can calibrate.
 */
export function percentileOf(value: number, sortedValues: number[]): number {
  const n = sortedValues.length;
  if (n === 0) return 50;
  if (n === 1) return 100;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedValues[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  let last = lo;
  while (last + 1 < n && sortedValues[last + 1] === value) last++;
  return Math.round((((lo + last) / 2 / (n - 1)) * 100) * 10) / 10;
}

export type ProsperityBand = "low" | "below" | "average" | "above" | "high";

export const PROSPERITY_LABELS: Record<ProsperityBand, string> = {
  low: "کم‌برخوردار",
  below: "زیر متوسط",
  average: "متوسط",
  above: "بالاتر از متوسط",
  high: "برخوردار",
};

/** Band cut on the PERCENTILE, so the bottom third of the peer set is "low". */
export function prosperityBand(percentile: number): ProsperityBand {
  if (percentile < 35) return "low";
  if (percentile < 55) return "below";
  if (percentile < 75) return "average";
  if (percentile < 90) return "above";
  return "high";
}

export interface OtcEstimate {
  /** Rial per person per year at this place's buying power. */
  perCapita: number;
  /** Rial per year the whole settlement spends out of pocket in pharmacies. */
  market: number;
  /** Rial per year per CURRENT pharmacy (0 when there is none). */
  perPharmacy: number;
  /** Rial per year for the marginal entrant: market ÷ (committed + 1). */
  forEntrant: number;
}

/**
 * `market = population × perCapita`, `perCapita = base × buyingPower^elasticity`.
 *
 * The entrant's share divides the same market by `committed + 1` rather than by
 * `n + 1`: opening one more pharmacy does not create demand, it splits it — and
 * a pharmacy with an in-principle approval (موافقت‌اصولی) will be open whatever
 * we do, so it is a certain competitor, not a maybe. `nCommitted` defaults to
 * `nPharmacy` when the caller does not know it. That is the honest — and
 * deliberately pessimistic — reading, and it is why a rich village with twelve
 * pharmacies can still lose to a plainer one with two.
 */
export function otcEstimate(
  population: number | null,
  bp: number,
  nPharmacy: number,
  a: OtcAssumptions,
  nCommitted: number = nPharmacy,
): OtcEstimate {
  const pop = Math.max(population ?? 0, 0);
  const elasticity = Number.isFinite(a.elasticity) ? a.elasticity : 1;
  const base = a.perCapitaIRR > 0 ? a.perCapitaIRR : DEFAULT_OTC.perCapitaIRR;
  const perCapita = base * Math.pow(Math.max(bp, 0.05), elasticity);
  const market = pop * perCapita;
  const n = Math.max(nPharmacy, 0);
  return {
    perCapita: Math.round(perCapita),
    market: Math.round(market),
    perPharmacy: n > 0 ? Math.round(market / n) : 0,
    forEntrant: Math.round(market / (Math.max(nCommitted, n) + 1)),
  };
}
