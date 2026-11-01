/**
 * Pure helpers behind the main dashboard. No React here, so the header stats
 * and the data-notes list can be reasoned about (and checked) on their own.
 */
import {
  exclusionReason,
  suspectPlaces,
  type PlaceMetrics,
  type ScoredPlace,
} from "./analytics";

export interface HeldOutRow {
  place: string;
  county: string;
  reason: string;
  /** Worth the user's attention: multi-pharmacy or metro-sized. */
  important: boolean;
}

/**
 * Rows that stay in the list but do not score, each with its reason.
 *
 * One pass: the per-row exclusion check and the cross-row "shared population"
 * check are both computed here, once, instead of being rebuilt by each caller.
 */
export function heldOutRows(places: PlaceMetrics[]): HeldOutRow[] {
  const runtime = new Map(
    suspectPlaces(places).map((s) => [s.location_id, s.reason]),
  );
  const out: HeldOutRow[] = [];
  for (const p of places) {
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
}

export interface VisibleSummary {
  /** Sum of population across the visible rows. */
  population: number;
  /** Sum of active pharmacies across the visible rows. */
  pharmacies: number;
  /** Sum of the market-scope OTC (non-prescription) spend, IRR per year. */
  otcMarket: number;
  /** Mean prosperity index (0–100) across the visible rows. */
  avgProsperity: number;
  /** Pharmacies per 100,000 residents, pooled over the visible rows. */
  densityPer100k: number;
}

/** Aggregates the header stats in one pass over the visible rows. */
export function summarize(rows: ScoredPlace[]): VisibleSummary {
  let population = 0;
  let pharmacies = 0;
  let otcMarket = 0;
  let prosperity = 0;
  for (const p of rows) {
    population += p.population ?? 0;
    pharmacies += p.n_pharmacy_total;
    otcMarket += p.otc.market;
    prosperity += p.prosperity;
  }
  return {
    population,
    pharmacies,
    otcMarket,
    avgProsperity: rows.length ? prosperity / rows.length : 0,
    densityPer100k: population > 0 ? (pharmacies / population) * 100_000 : 0,
  };
}
