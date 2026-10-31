-- ============================================================================
--  Pharmacy Location Intelligence — geographic VIEWS
--
--  Kept separate from schema_geo.sql for the same reason views.sql is separate
--  from schema.sql: a view that references a newly added column must be created
--  AFTER the additive migration, otherwise it fails against an older database.
--
--  These views are READ-ONLY over the FDA tables. They never redefine an FDA
--  number; they add a map, a distance and a match status beside it.
-- ============================================================================

PRAGMA foreign_keys = ON;

DROP VIEW IF EXISTS v_geo_place;
CREATE VIEW v_geo_place AS
SELECT
    g.id                     AS geo_place_id,
    g.name, g.name_clean, g.name_en, g.place_kind,
    g.lat, g.lon,
    g.province, g.county, g.county_alt, g.district,
    g.admin_method, g.admin_source, g.admin_confidence,
    -- population: three independent sources, never silently merged -----------
    g.pop_osm, g.pop_osm_date, g.pop_wikidata, g.pop_wikipedia, g.pop_wikipedia_hh,
    g.pop_ref_source, g.pop_ref_year_sh, g.pop_ref_url,
    g.pop_match_score, g.pop_match_method, g.wd_separation_m,
    COALESCE(g.pop_wikidata, g.pop_wikipedia, g.pop_osm) AS population_best,
    g.wikidata, g.wikipedia,
    -- where it sits relative to اهواز ---------------------------------------
    g.distance_km, g.road_km, g.road_minutes, g.bearing_deg,
    -- size of the surrounding settlement cluster: the honest proxy for a place
    -- that has no population statement of its own
    g.settlements_20km, g.population_20km,
    g.settlements_30km, g.population_30km,
    g.settlements_50km, g.population_50km,
    ROUND(g.distance_km / 25.0) * 25                 AS distance_band_km,
    CASE
        WHEN g.distance_km <  25 THEN '۰–۲۵'
        WHEN g.distance_km <  50 THEN '۲۵–۵۰'
        WHEN g.distance_km <  75 THEN '۵۰–۷۵'
        WHEN g.distance_km < 100 THEN '۷۵–۱۰۰'
        WHEN g.distance_km < 150 THEN '۱۰۰–۱۵۰'
        ELSE '۱۵۰+'
    END                                              AS distance_band_fa,
    CASE
        WHEN g.bearing_deg <  45 OR g.bearing_deg >= 315 THEN 'شمال'
        WHEN g.bearing_deg < 135 THEN 'شرق'
        WHEN g.bearing_deg < 225 THEN 'جنوب'
        ELSE 'غرب'
    END                                              AS direction_from_ahvaz,
    -- match status ----------------------------------------------------------
    g.in_fda, g.is_in_fda_scope,
    CASE WHEN g.in_fda = 1 THEN 'matched'
         WHEN m.tier = 'variant' THEN 'variant'
         ELSE 'new' END                                  AS status,
    m.tier, m.location_id, m.match_score, m.match_method, m.separation_m,
    v.place                  AS fda_place,
    v.county                 AS fda_county,
    v.population             AS fda_population,
    v.n_pharmacy_total,
    v.is_market,
    g.dq_flags, g.observed_at
FROM geo_places g
LEFT JOIN geo_location_match m ON m.geo_place_id = g.id
LEFT JOIN v_metrics v          ON v.location_id  = m.location_id;

-- ---------------------------------------------------------------------------
-- The business question: which places exist on the map and NOT in the pharmacy
-- authority's list? These are the φ-potential new sites. They are *candidates*,
-- not conclusions: the map's own population tag is unverified, and a hamlet of
-- 30 people is not a pharmacy market. Both facts are shown, not hidden.
--
-- A place whose name merely *resembles* an FDA row (same county, one letter
-- apart) is NOT here — it sits in v_geo_variants, because calling «هفتکل» a new
-- location when the FDA already lists «هفتگل» would be a false positive.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_geo_new_places;
CREATE VIEW v_geo_new_places AS
SELECT
    geo_place_id, name, name_clean, name_en, place_kind,
    lat, lon, county, county_alt, district, admin_method, admin_confidence,
    population_best, pop_osm, pop_wikidata, pop_wikipedia, pop_ref_source,
    pop_ref_year_sh, pop_ref_url, pop_match_score, pop_match_method,
    settlements_20km, population_20km, settlements_30km, population_30km,
    settlements_50km, population_50km,
    wikidata, distance_km, road_km, road_minutes, distance_band_fa,
    direction_from_ahvaz, dq_flags,
    -- A settlement with no population statement is not rankable, so it is
    -- flagged rather than given a fabricated size.
    CASE WHEN COALESCE(pop_wikidata, pop_wikipedia, pop_osm) IS NULL
         THEN 1 ELSE 0 END                            AS size_unknown,
    CASE WHEN place_kind = 'neighbourhood' THEN 1 ELSE 0 END AS intra_city,
    CASE WHEN dq_flags LIKE '%pop_outlier%' THEN 1 ELSE 0 END AS pop_suspect,
    CASE WHEN name LIKE 'شهرک%' OR name LIKE '%صنعتی%' THEN 1 ELSE 0 END AS industrial
FROM v_geo_place
WHERE status = 'new';

-- ---------------------------------------------------------------------------
-- The verification queue: a map place and an FDA row that are one letter apart
-- in the same county. Either the FDA misspells it, or they are two different
-- villages. A human decides; the query is ready to answer in one look.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_geo_variants;
CREATE VIEW v_geo_variants AS
SELECT
    geo_place_id, name, place_kind, county,
    lat, lon, distance_km, distance_band_fa,
    fda_place, fda_county, fda_population, n_pharmacy_total,
    match_score, match_method, separation_m, dq_flags
FROM v_geo_place
WHERE status = 'variant';

-- ---------------------------------------------------------------------------
-- County view: the FDA inventory against the map inventory, side by side.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_geo_county_rollup;
CREATE VIEW v_geo_county_rollup AS
SELECT
    county,
    SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END)  AS n_map_matched,
    SUM(CASE WHEN status = 'variant' THEN 1 ELSE 0 END)  AS n_map_variant,
    SUM(CASE WHEN status = 'new'     THEN 1 ELSE 0 END)  AS n_map_new,
    SUM(CASE WHEN status = 'new' AND place_kind IN ('city','town') THEN 1 ELSE 0 END)
                                                          AS n_map_new_urban,
    MAX(CASE WHEN status = 'new' THEN population_best END) AS max_new_population,
    ROUND(MIN(distance_km), 1)                            AS nearest_km_to_ahvaz
FROM v_geo_place
WHERE county IS NOT NULL
GROUP BY county;

-- ---------------------------------------------------------------------------
-- One-glance status summary, in the same shape for the map, the report and the
-- dashboard footer.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_geo_status_summary;
CREATE VIEW v_geo_status_summary AS
SELECT
    status,
    place_kind,
    COUNT(*)                                              AS n_places,
    ROUND(AVG(distance_km), 1)                            AS avg_km_to_ahvaz,
    SUM(COALESCE(population_best, 0))                      AS population
FROM v_geo_place
GROUP BY status, place_kind
ORDER BY status, n_places DESC;

-- ---------------------------------------------------------------------------
-- Distance ladder from اهواز: how many places, how much population and how many
-- pharmacies sit in each 25 km ring. This is the table the map's rings encode.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_geo_distance_bands;
CREATE VIEW v_geo_distance_bands AS
SELECT
    distance_band_fa,
    MIN(distance_band_km)                                 AS band_km,
    COUNT(*)                                              AS n_places,
    SUM(CASE WHEN place_kind IN ('city','town') THEN 1 ELSE 0 END) AS n_urban,
    SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END)        AS n_new,
    SUM(COALESCE(population_best, 0))                      AS population,
    SUM(COALESCE(n_pharmacy_total, 0))                     AS n_pharmacies
FROM v_geo_place
GROUP BY distance_band_fa
ORDER BY band_km;

-- ---------------------------------------------------------------------------
-- Data quality, in one row per flag.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_geo_dq;
CREATE VIEW v_geo_dq AS
SELECT 'place_kind'                         AS dimension,
       place_kind                           AS value,
       COUNT(*)                             AS n,
       SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS n_new
FROM v_geo_place GROUP BY place_kind
UNION ALL
SELECT 'admin_method', admin_method, COUNT(*),
       SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END)
FROM v_geo_place GROUP BY admin_method
UNION ALL
SELECT 'admin_source', admin_source, COUNT(*),
       SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END)
FROM v_geo_place GROUP BY admin_source
UNION ALL
SELECT 'match_method', COALESCE(match_method, '(unmatched)'), COUNT(*), 0
FROM v_geo_place GROUP BY match_method
UNION ALL
SELECT 'population_source',
       COALESCE(pop_ref_source, '(none on the map)'), COUNT(*),
       SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END)
FROM v_geo_place GROUP BY COALESCE(pop_ref_source, '(none on the map)')
UNION ALL
SELECT 'county_known', CASE WHEN county IS NULL THEN 'no' ELSE 'yes' END, COUNT(*),
       SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END)
FROM v_geo_place GROUP BY CASE WHEN county IS NULL THEN 'no' ELSE 'yes' END;

-- ---------------------------------------------------------------------------
-- Coverage counters captured by the loader, for the app's source panel.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_geo_coverage;
CREATE VIEW v_geo_coverage AS
SELECT metric, value, detail, computed_at
FROM geo_coverage_note
WHERE scope = 'khuzestan'
ORDER BY id;
