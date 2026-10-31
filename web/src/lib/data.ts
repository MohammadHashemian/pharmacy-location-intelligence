/** Server-side data assembly: SQLite -> typed payload for the dashboard. */
import { all, one, dbReady } from "./db";
import type { CountyMetrics, PlaceMetrics, SourceInfo } from "./analytics";

export interface ProvinceSummary {
  province: string;
  n_places: number;
  population: number;
  n_pharmacy_total: number;
  n_req_pipeline: number;
  pharmacies_per_100k: number | null;
}

export interface DqFlagSummary {
  dq_flags: string | null;
  n_places: number;
  population: number;
  n_pharmacy_total: number;
}

export interface UniversitySummary {
  university: string | null;
  n_provinces: number;
  n_market_places: number;
  population: number;
  n_pharmacy_total: number;
  n_req_pipeline: number;
  pharmacies_per_100k: number | null;
}

/** How much of the analysis scope carries a corroborated reference population. */
export interface ReferenceCoverage {
  market_places: number;
  with_reference: number;
  coverage_pct: number | null;
  high_confidence: number;
  medium_confidence: number;
  /** Places where the reference figure differs by >= 2x from the FDA figure. */
  materially_different: number;
}

export interface ScopeSummary {
  totalPlaces: number;
  totalPharmacies: number;
  marketPlaces: number;
  marketPharmacies: number;
  nonMarketPlaces: number;
  nonMarketPharmacies: number;
  flaggedInScope: number;
  provinces: number;
  counties: number;
}

export interface DashboardData {
  ready: boolean;
  /** Market-scope places, carrying BOTH the FDA and the reference population. */
  places: PlaceMetrics[];
  counties: CountyMetrics[];
  provinces: ProvinceSummary[];
  universities: UniversitySummary[];
  dq: DqFlagSummary[];
  reference: ReferenceCoverage | null;
  sources: SourceInfo[];
  scope: ScopeSummary;
  observedAt: string | null;
}

/**
 * Reads `v_place_full`, which layers two things on top of the FDA feed:
 *   * the corroborated reference population and its provenance;
 *   * manual overrides (the user's own evidence) and the yearbook's county-level
 *     cross-check.
 *
 * Scope: every place that is a city-market OR already holds at least one
 * pharmacy. The old `is_market = 1` filter alone dropped 548 settlements that
 * hold 629 pharmacies between them — real markets, hidden, which is exactly what
 * the user objected to. They now load and carry a warning badge instead.
 */
const PLACE_SQL = `
  SELECT
    location_id, loc_key, province, county, district, place, place_kind,
    university, observed_at, is_market, dq_flags, city_score, min_score,
    fda_population, ref_population, ref_source, ref_source_id, ref_source_url,
    ref_census_year_sh, ref_households, ref_match_score, ref_match_method,
    effective_population, has_reference, ref_ratio,
    manual_population, manual_pharmacy_real, manual_pharmacy_legal,
    manual_note, manual_updated_at, has_manual,
    n_pharmacy_real AS src_pharmacy_real,
    n_pharmacy_legal AS src_pharmacy_legal,
    salname_pharmacies_1403, salname_county_population_1395,
    fda_county_pharmacies, county_pharmacy_ratio,
    n_pharmacy_real, n_pharmacy_legal, n_pharmacy_total, n_pharmacy_committed,
    n_req_registered, n_req_inprogress, n_req_approved, n_req_pipeline,
    pipeline_ratio, density_reported
  FROM v_place_full
  WHERE is_market = 1
     OR (COALESCE(n_pharmacy_real, 0) + COALESCE(n_pharmacy_legal, 0)) > 0
  ORDER BY COALESCE(ref_population, fda_population, 0) DESC
`;

const EMPTY: DashboardData = {
  ready: false,
  places: [],
  counties: [],
  provinces: [],
  universities: [],
  dq: [],
  reference: null,
  sources: [],
  scope: {
    totalPlaces: 0,
    totalPharmacies: 0,
    marketPlaces: 0,
    marketPharmacies: 0,
    nonMarketPlaces: 0,
    nonMarketPharmacies: 0,
    flaggedInScope: 0,
    provinces: 0,
    counties: 0,
  },
  observedAt: null,
};

export function loadDashboardData(): DashboardData {
  if (!dbReady()) return EMPTY;

  const places = all<PlaceMetrics>(PLACE_SQL);

  const counties = all<CountyMetrics>(`
    SELECT province, county, n_places, n_cities, n_villages, population,
           n_pharmacy_total, n_req_registered, n_req_inprogress, n_req_approved,
           pharmacies_per_100k, population_per_pharmacy, max_entry_threshold
    FROM v_county_rollup
    ORDER BY population DESC
  `);

  const provinces = all<ProvinceSummary>(`
    SELECT province,
           COUNT(*)                              AS n_places,
           SUM(population)                       AS population,
           SUM(n_pharmacy_real + n_pharmacy_legal) AS n_pharmacy_total,
           SUM(n_req_registered + n_req_inprogress + n_req_approved) AS n_req_pipeline,
           ROUND(SUM(n_pharmacy_real + n_pharmacy_legal) * 100000.0
                 / NULLIF(SUM(population), 0), 2) AS pharmacies_per_100k
    FROM v_metrics
    WHERE is_market = 1
    GROUP BY province
    ORDER BY population DESC
  `);

  const dq = all<DqFlagSummary>(`
    SELECT dq_flags, n_places, population, n_pharmacy_total
    FROM v_dq_summary
    ORDER BY n_places DESC
  `);

  const universities = all<UniversitySummary>(`
    SELECT university, n_provinces, n_market_places, population,
           n_pharmacy_total, n_req_pipeline, pharmacies_per_100k
    FROM v_university_rollup
  `);

  const reference =
    one<ReferenceCoverage>(`SELECT * FROM v_reference_coverage`) ?? null;

  const s = one<{
    total_places: number;
    total_ph: number;
    market_places: number;
    market_ph: number;
    flagged_in_scope: number;
    provinces: number;
    counties: number;
  }>(`
    SELECT (SELECT COUNT(*) FROM v_latest_snapshot)                       AS total_places,
           (SELECT SUM(n_pharmacy_real + n_pharmacy_legal)
              FROM v_latest_snapshot)                                     AS total_ph,
           (SELECT COUNT(*) FROM v_metrics WHERE is_market = 1)           AS market_places,
           (SELECT SUM(n_pharmacy_real + n_pharmacy_legal)
              FROM v_metrics WHERE is_market = 1)                         AS market_ph,
           (SELECT COUNT(*) FROM v_metrics
              WHERE is_market = 1 AND dq_flags IS NOT NULL)               AS flagged_in_scope,
           (SELECT COUNT(DISTINCT province) FROM v_metrics WHERE is_market = 1) AS provinces,
           (SELECT COUNT(DISTINCT county)   FROM v_metrics WHERE is_market = 1) AS counties
  `);

  const sources = all<SourceInfo>(`
    SELECT id, kind, ref, sha256, observed_at, ingested_at, row_count,
           scope_label, status
    FROM data_sources ORDER BY observed_at DESC, id DESC
  `);

  return {
    ready: true,
    places,
    counties,
    provinces,
    universities,
    dq,
    reference,
    sources,
    scope: {
      totalPlaces: s?.total_places ?? 0,
      totalPharmacies: s?.total_ph ?? 0,
      marketPlaces: s?.market_places ?? 0,
      marketPharmacies: s?.market_ph ?? 0,
      nonMarketPlaces: (s?.total_places ?? 0) - (s?.market_places ?? 0),
      nonMarketPharmacies: (s?.total_ph ?? 0) - (s?.market_ph ?? 0),
      flaggedInScope: s?.flagged_in_scope ?? 0,
      provinces: s?.provinces ?? 0,
      counties: s?.counties ?? 0,
    },
    observedAt: places.length ? places[0].observed_at : null,
  };
}
