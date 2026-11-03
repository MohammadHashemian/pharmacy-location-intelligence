import { describe, expect, it } from "vitest";
import {
  DEFAULT_OTC,
  affluenceFactors,
  affluenceScale,
  buyingPower,
  percentileOf,
  suggestPerCapita,
} from "@/lib/otc";
import { heldOutRows, summarize } from "@/lib/dashboardStats";
import type { PlaceMetrics, ScoredPlace } from "@/lib/analytics";

const RATIO = 0.596;

const place = (over: Partial<PlaceMetrics> = {}): PlaceMetrics =>
  ({
    location_id: 1,
    loc_key: "k1",
    province: "خوزستان",
    county: "شهرستان اهواز",
    district: "بخش مرکزی",
    place: "شهر آزمون",
    place_kind: "city",
    university: null,
    observed_at: "2026-01-01",
    fda_population: 50_000,
    ref_population: null,
    ref_source: null,
    ref_source_id: null,
    ref_source_url: null,
    ref_census_year_sh: null,
    ref_households: null,
    ref_match_score: null,
    ref_match_method: null,
    has_reference: 0,
    ref_ratio: null,
    manual_population: null,
    manual_pharmacy_real: null,
    manual_pharmacy_legal: null,
    manual_note: null,
    manual_updated_at: null,
    has_manual: 0,
    src_pharmacy_real: 2,
    src_pharmacy_legal: 1,
    salname_pharmacies_1403: null,
    salname_county_population_1395: null,
    county_pharmacy_ratio: null,
    population: 50_000,
    city_score: null,
    min_score: null,
    n_pharmacy_real: 2,
    n_pharmacy_legal: 1,
    n_pharmacy_total: 3,
    n_pharmacy_committed: 0,
    n_req_registered: 0,
    n_req_inprogress: 0,
    n_req_approved: 0,
    n_req_pipeline: 0,
    pharmacies_per_100k: 6,
    population_per_pharmacy: 16_666,
    pipeline_ratio: 0,
    density_reported: 6,
    is_market: 1,
    dq_flags: null,
    county_urban_share: 0.7,
    hh_size: 3.4,
    ...over,
  }) as unknown as PlaceMetrics;

const scored = (over: Partial<ScoredPlace> = {}): ScoredPlace =>
  ({
    ...place(),
    prosperity: 55,
    otc: { market: 1_000_000_000, perCapita: 28_000_000, buyingPower: 1 },
    scores: {
      demand: 60, headroom: 50, pipeline: 40, barrier: 30, affluence: 55,
      tolerance: 45, opportunity: 50,
    },
    ...over,
  }) as unknown as ScoredPlace;

describe("suggestPerCapita", () => {
  it("falls back when the anchor is missing", () => {
    expect(suggestPerCapita(null)).toBe(DEFAULT_OTC.perCapitaIRR);
    expect(suggestPerCapita({ urban_consumption_per_capita: 0 })).toBe(DEFAULT_OTC.perCapitaIRR);
  });

  it("scales the anchor by inflation and the OTC share", () => {
    expect(suggestPerCapita({ urban_consumption_per_capita: 100_000_000 })).toBe(3_600_000);
  });

  it("refuses an implausibly small result", () => {
    expect(suggestPerCapita({ urban_consumption_per_capita: 1_000 })).toBe(DEFAULT_OTC.perCapitaIRR);
  });
});

describe("affluenceFactors", () => {
  it("returns four bounded factors and their product", () => {
    const f = affluenceFactors(place(), RATIO);
    for (const k of ["urbanity", "countyUrban", "household", "agglomeration"] as const) {
      expect(f[k]).toBeGreaterThan(0.5);
      expect(f[k]).toBeLessThan(1.5);
    }
    expect(f.raw).toBeCloseTo(f.urbanity * f.countyUrban * f.household * f.agglomeration, 6);
  });

  it("a village is poorer than a city with the same inputs", () => {
    expect(affluenceFactors(place({ place_kind: "village" }), RATIO).raw)
      .toBeLessThan(affluenceFactors(place(), RATIO).raw);
  });

  it("a smaller household is better-off", () => {
    expect(affluenceFactors(place({ hh_size: 2.5 }), RATIO).raw)
      .toBeGreaterThan(affluenceFactors(place({ hh_size: 5 }), RATIO).raw);
  });

  it("survives missing inputs", () => {
    const f = affluenceFactors(
      place({ population: null, county_urban_share: null, hh_size: null }), RATIO);
    expect(Number.isFinite(f.raw)).toBe(true);
  });
});

describe("affluenceScale", () => {
  it("is 1 when there is nothing to weigh", () => {
    expect(affluenceScale([], RATIO)).toBe(1);
  });

  it("weights by population, so the biggest city dominates", () => {
    const scale = affluenceScale([
      place({ population: 900_000 }),
      place({ population: 10_000, place_kind: "village" }),
    ], RATIO);
    expect(scale).toBeGreaterThan(1);
  });

  it("buying power is the factor over the scale", () => {
    const scale = affluenceScale([place()], RATIO);
    expect(buyingPower(place(), scale, RATIO)).toBeGreaterThan(0.5);
    expect(buyingPower(place(), 0, RATIO)).toBeGreaterThan(0);
  });
});

describe("percentileOf", () => {
  it("finds the share below a value", () => {
    // index 4 of 10 → 4/9 = 44.4 on the 0-100 scale
    expect(percentileOf(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(44.4, 1);
  });

  it("is neutral on an empty list and top on a single value", () => {
    expect(percentileOf(5, [])).toBe(50);
    expect(percentileOf(5, [5])).toBe(100);
  });

  it("is 0 for the smallest and 100 for the largest", () => {
    expect(percentileOf(1, [1, 2, 3])).toBe(0);
    expect(percentileOf(3, [1, 2, 3])).toBe(100);
  });
});

describe("heldOutRows", () => {
  it("finds the rows that carry a warning", () => {
    const rows = [place({ location_id: 1 }), place({ location_id: 2, is_market: 0 })];
    const held = heldOutRows(rows);
    expect(held.length).toBe(1);
    expect(held[0].county).toBe("شهرستان اهواز");
  });

  it("marks a large or multi-pharmacy exclusion as important", () => {
    const held = heldOutRows([place({ is_market: 0, population: 200_000, n_pharmacy_total: 4 })]);
    expect(held[0].important).toBe(true);
  });

  it("is empty when nothing is wrong", () => {
    expect(heldOutRows([place()])).toEqual([]);
  });
});

describe("summarize", () => {
  it("adds up the visible rows", () => {
    const s = summarize([scored(), scored({ population: 20_000, n_pharmacy_total: 4 })]);
    expect(s.population).toBe(70_000);
    expect(s.pharmacies).toBe(7);
    expect(s.otcMarket).toBe(2_000_000_000);
    expect(s.densityPer100k).toBeCloseTo(10, 5);
  });

  it("averages prosperity", () => {
    const s = summarize([scored({ prosperity: 40 }), scored({ prosperity: 60 })]);
    expect(s.avgProsperity).toBe(50);
  });

  it("does not divide by zero on an empty list", () => {
    const s = summarize([]);
    expect(s.population).toBe(0);
    expect(s.densityPer100k).toBe(0);
    expect(s.avgProsperity).toBe(0);
  });
});
