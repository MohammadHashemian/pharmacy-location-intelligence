/**
 * The scoring pipeline: population mode, percentiles, suspects, and the final ranking.
 *
 * `scorePlaces` is the one function that turns rows into the recommendation board, so it is
 * worth testing as a pure function — no database, no React, same extreme cases the data has:
 * a zero-population village, a mis-joined metro figure, and a place with no pharmacy at all.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUNABLES,
  applyPopulationMode,
  effectivePopulation,
  exclusionReason,
  isUnresolvedOutlier,
  median,
  percentileRanks,
  scorePlaces,
  suspectPlaces,
  warningsFor,
  type PlaceMetrics,
} from "@/lib/analytics";

const place = (over: Partial<PlaceMetrics> = {}): PlaceMetrics =>
  ({
    location_id: 1, loc_key: "k", province: "خوزستان", county: "شهرستان اهواز",
    district: "بخش مرکزی", place: "شهر آزمون", place_kind: "city", university: null,
    observed_at: "2026-01-01",
    fda_population: 50_000, ref_population: null, ref_source: null, ref_source_id: null,
    ref_source_url: null, ref_census_year_sh: null, ref_households: null,
    ref_match_score: null, ref_match_method: null, has_reference: 0, ref_ratio: null,
    manual_population: null, manual_pharmacy_real: null, manual_pharmacy_legal: null,
    manual_note: null, manual_updated_at: null, has_manual: 0,
    src_pharmacy_real: 2, src_pharmacy_legal: 1,
    salname_pharmacies_1403: null, salname_county_population_1395: null,
    county_pharmacy_ratio: null, population: 50_000, city_score: null, min_score: null,
    n_pharmacy_real: 2, n_pharmacy_legal: 1, n_pharmacy_total: 3, n_pharmacy_committed: 0,
    n_req_registered: 0, n_req_inprogress: 0, n_req_approved: 0, n_req_pipeline: 0,
    pharmacies_per_100k: 6, population_per_pharmacy: 16_666, pipeline_ratio: 0,
    density_reported: 6, is_market: 1, dq_flags: null,
    county_urban_share: 0.7, hh_size: 3.4,
    ...over,
  }) as unknown as PlaceMetrics;

describe("population mode", () => {
  it("prefers a manual override over everything", () => {
    const p = place({ manual_population: 12_345, has_manual: 1, ref_population: 60_000, has_reference: 1 });
    expect(effectivePopulation(p, "fda")).toBe(12_345);
    expect(effectivePopulation(p, "reference")).toBe(12_345);
  });

  it("uses the corroborated reference only in reference mode", () => {
    const p = place({ ref_population: 60_000, has_reference: 1 });
    expect(effectivePopulation(p, "fda")).toBe(50_000);
    expect(effectivePopulation(p, "reference")).toBe(60_000);
  });

  it("falls back to the feed when the reference is missing", () => {
    expect(effectivePopulation(place({ has_reference: 0 }), "reference")).toBe(50_000);
  });

  it("applyPopulationMode rewrites population, per-capita and density together", () => {
    const [p] = applyPopulationMode([place({ manual_population: 100_000, has_manual: 1 })], "manual");
    expect(p.population).toBe(100_000);
    expect(p.population_per_pharmacy).toBe(Math.round(100_000 / 3));
    expect(p.pharmacies_per_100k).toBeCloseTo((3 / 100_000) * 100_000, 5);
  });

  it("survives a zero population without dividing by it", () => {
    const [p] = applyPopulationMode([place({ fda_population: 0, population: 0 })], "fda");
    expect(p.pharmacies_per_100k === null || Number.isFinite(p.pharmacies_per_100k)).toBe(true);
  });
});

describe("warnings", () => {
  it("explains a zero population", () => {
    const w = warningsFor(place({ population: 0, fda_population: 0 }));
    expect(w.length).toBeGreaterThan(0);
  });

  it("flags a row outside the urban market", () => {
    expect(warningsFor(place({ is_market: 0 })).join(" ")).toContain("بازار شهری");
  });

  it("stops complaining once a manual figure fixes the row", () => {
    const bad = place({ population: 0, fda_population: 0 });
    const fixed = place({ population: 0, fda_population: 0, manual_population: 9_000, has_manual: 1 });
    expect(warningsFor(bad).length).toBeGreaterThan(warningsFor(fixed).length);
  });

  it("exclusionReason is the first warning", () => {
    expect(exclusionReason(place({ is_market: 0 }))).toBe(warningsFor(place({ is_market: 0 }))[0]);
    expect(exclusionReason(place())).toBeNull();
  });
});

describe("outliers", () => {
  it("only flags a pop_outlier row that nothing has fixed", () => {
    const p = place({ dq_flags: "pop_outlier" });
    expect(isUnresolvedOutlier(p)).toBe(true);
    expect(isUnresolvedOutlier(place({ dq_flags: "pop_outlier", manual_population: 5_000, has_manual: 1 }))).toBe(false);
  });

  it("finds a shared metro population across several rows", () => {
    const rows = [
      place({ location_id: 1, place: "تجریش", population: 8_154_000, n_pharmacy_total: 1 }),
      place({ location_id: 2, place: "شمیران", population: 8_154_000, n_pharmacy_total: 2 }),
    ];
    const s = suspectPlaces(rows);
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].reason).toBeTruthy();
  });

  it("says nothing about ordinary rows", () => {
    expect(suspectPlaces([place({ location_id: 1 }), place({ location_id: 2, population: 20_000 })])).toEqual([]);
  });
});

describe("percentiles", () => {
  it("ranks ascending with ties sharing a position", () => {
    // ties share the mean of the positions they occupy
    expect(percentileRanks([10, 20, 20, 40])).toEqual([0, 50, 50, 100]);
  });

  it("handles an empty list and a single value", () => {
    expect(percentileRanks([])).toEqual([]);
    expect(percentileRanks([7])).toEqual([100]);
  });

  it("median of an even and an odd list", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("scorePlaces", () => {
  const rows = [
    place({ location_id: 1, place: "کوچک", population: 20_000, n_pharmacy_total: 1 }),
    place({ location_id: 2, place: "متوسط", population: 60_000, n_pharmacy_total: 12 }),
    place({ location_id: 3, place: "بزرگ", population: 200_000, n_pharmacy_total: 2 }),
  ];

  it("scores every row on a 0-100 band", () => {
    const out = scorePlaces(rows, DEFAULT_TUNABLES);
    expect(out.length).toBe(3);
    for (const p of out) {
      expect(p.scores.opportunity).toBeGreaterThanOrEqual(0);
      expect(p.scores.opportunity).toBeLessThanOrEqual(100);
      expect(Number.isFinite(p.prosperity)).toBe(true);
    }
  });

  it("gives a crowded market less headroom than a thin one", () => {
    // five peers with the same population and a rising pharmacy count: headroom must fall
    const peers = [1, 2, 3, 6, 10].map((n, i) =>
      place({ location_id: 100 + i, place: `p${n}`, population: 50_000, n_pharmacy_total: n }));
    const out = scorePlaces(peers, DEFAULT_TUNABLES).filter((p) => p.scores.headroom >= 0);
    const byPharmacy = [...out].sort((a, b) => a.n_pharmacy_total - b.n_pharmacy_total);
    expect(byPharmacy[0].scores.headroom).toBeGreaterThanOrEqual(
      byPharmacy[byPharmacy.length - 1].scores.headroom);
  });

  it("is deterministic", () => {
    const a = scorePlaces(rows, DEFAULT_TUNABLES).map((p) => p.scores.opportunity);
    const b = scorePlaces(rows, DEFAULT_TUNABLES).map((p) => p.scores.opportunity);
    expect(a).toEqual(b);
  });

  it("returns nothing for an empty peer set", () => {
    expect(scorePlaces([], DEFAULT_TUNABLES)).toEqual([]);
  });

  it("keeps an unscoreable row in the list instead of dropping it", () => {
    const withZero = [...rows, place({ location_id: 9, place: "بدون جمعیت", population: 0, fda_population: 0 })];
    const out = scorePlaces(withZero, DEFAULT_TUNABLES);
    expect(out.some((p) => p.place === "بدون جمعیت")).toBe(true);
  });
});
