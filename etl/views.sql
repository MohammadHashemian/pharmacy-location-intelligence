-- ============================================================================
--  Pharmacy Location Intelligence — analytic VIEWS
--
--  Kept separate from schema.sql so they can be (re)created AFTER the additive
--  column migrations run: a view that references a newly added column would
--  otherwise fail to create against a pre-existing database.
--
--  Every metric the dashboard shows is defined here, once, so an ad-hoc
--  sqlite3 session, the Python tooling and the web app all agree.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 5. Analytics view: latest observation per place, with derived metrics.
--    All formulas are explicit so nobody has to guess where a number came from.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_latest_snapshot;
CREATE VIEW v_latest_snapshot AS
SELECT
    s.id            AS snapshot_id,
    l.id            AS location_id,
    l.loc_key,
    l.province,
    l.county,
    l.district,
    l.place,
    l.place_kind,
    l.university,
    s.observed_at,
    s.population,
    s.city_score,
    s.min_score,
    COALESCE(s.n_pharmacy_real, 0)  AS n_pharmacy_real,
    COALESCE(s.n_pharmacy_legal, 0) AS n_pharmacy_legal,
    COALESCE(s.n_req_registered, 0) AS n_req_registered,
    COALESCE(s.n_req_inprogress, 0) AS n_req_inprogress,
    COALESCE(s.n_req_approved, 0)   AS n_req_approved,
    s.density_reported,
    s.dq_flags
FROM location_snapshots s
JOIN locations l ON l.id = s.location_id
JOIN (
    SELECT location_id, MAX(observed_at) AS mx
    FROM location_snapshots
    GROUP BY location_id
) lat ON lat.location_id = s.location_id AND lat.mx = s.observed_at;

DROP VIEW IF EXISTS v_metrics;
CREATE VIEW v_metrics AS
SELECT
    v.*,
    -- supply ---------------------------------------------------------------
    (v.n_pharmacy_real + v.n_pharmacy_legal)                        AS n_pharmacy_total,
    (v.n_pharmacy_real + v.n_pharmacy_legal + v.n_req_approved)     AS n_pharmacy_committed,
    -- ---------------------------------------------------------------------
    -- ANALYSIS SCOPE.
    -- Name-prefix alone is NOT a safe filter at national scale: the single
    -- largest market in the country, «تهران بزرگ» (3,057 pharmacies), carries
    -- no «شهر» prefix, so a prefix-only rule silently drops it. A place counts
    -- as having an urban pharmacy market when it is city-labelled OR already
    -- sustains at least 3 pharmacies. Nationally this keeps 1,323 places and
    -- 96.6% of all 18,756 pharmacies, and the rest are hamlets where a private
    -- pharmacy is not a viable business.
    CASE WHEN v.place_kind = 'city'
              OR (v.n_pharmacy_real + v.n_pharmacy_legal) >= 3
         THEN 1 ELSE 0 END                                          AS is_market,
    -- ---------------------------------------------------------------------
    -- competition -----------------------------------------------------------
    CASE WHEN v.population > 0
         THEN ROUND((v.n_pharmacy_real + v.n_pharmacy_legal) * 100000.0 / v.population, 2)
    END AS pharmacies_per_100k,
    CASE WHEN (v.n_pharmacy_real + v.n_pharmacy_legal) > 0
         THEN ROUND(v.population * 1.0 / (v.n_pharmacy_real + v.n_pharmacy_legal), 0)
    END AS population_per_pharmacy,
    -- pipeline pressure: how many applicants are already queued ahead of you
    (v.n_req_registered + v.n_req_inprogress + v.n_req_approved)    AS n_req_pipeline,
    CASE WHEN (v.n_pharmacy_real + v.n_pharmacy_legal) > 0
         THEN ROUND((v.n_req_inprogress + v.n_req_approved) * 1.0
                    / (v.n_pharmacy_real + v.n_pharmacy_legal), 3)
         ELSE (v.n_req_inprogress + v.n_req_approved) * 1.0
    END AS pipeline_ratio,
    -- administrative barrier (higher min_score == harder to obtain a permit)
    v.min_score                                                     AS entry_threshold
FROM v_latest_snapshot v;

-- ---------------------------------------------------------------------------
-- 6. County rollup (the level you actually apply at)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_county_rollup;
CREATE VIEW v_county_rollup AS
SELECT
    province,
    county,
    COUNT(*)                                              AS n_places,
    SUM(CASE WHEN place_kind = 'city'    THEN 1 ELSE 0 END) AS n_cities,
    SUM(CASE WHEN place_kind = 'village' THEN 1 ELSE 0 END) AS n_villages,
    SUM(population)                                       AS population,
    SUM(n_pharmacy_real + n_pharmacy_legal)               AS n_pharmacy_total,
    SUM(n_req_registered)                                 AS n_req_registered,
    SUM(n_req_inprogress)                                 AS n_req_inprogress,
    SUM(n_req_approved)                                   AS n_req_approved,
    ROUND(SUM(n_pharmacy_real + n_pharmacy_legal) * 100000.0
          / NULLIF(SUM(population), 0), 2)                AS pharmacies_per_100k,
    ROUND(SUM(population) * 1.0
          / NULLIF(SUM(n_pharmacy_real + n_pharmacy_legal), 0), 0) AS population_per_pharmacy,
    MAX(min_score)                                        AS max_entry_threshold,
    SUM(is_market)                                        AS n_market_places
FROM v_metrics
GROUP BY province, county;

-- ---------------------------------------------------------------------------
-- 7. Data-quality roll-up.
--
--    The upstream feed is a live operational system, not a curated dataset, and
--    outside Khuzestan it contains rows that would silently corrupt any ranking:
--
--      pop_outlier  population >= 500,000 but fewer than 20 pharmacies. Almost
--                   always a metro population value joined onto a small place
--                   (e.g. «شهر تجريش», pop 8,154,051 with 1 pharmacy — the
--                   population figure actually belongs to Tehran).
--      pop_zero     population missing or reported as 0.
--      bad_name     the place name carries no Persian/Arabic letters at all
--                   (e.g. «**» or «-»): a malformed source record.
--      no_activity  population >= 20,000 with no pharmacy AND no queued
--                   application AND no approval anywhere in the feed. A SOFT
--                   flag only: a genuine white space nearly always shows queued
--                   applicants, so this pattern usually means the pharmacies are
--                   attributed to a neighbouring city (e.g. «شهر مشکین دشت»,
--                   pop 53,440, 0/0/0, a satellite of Karaj). The row stays
--                   rankable but is badged so the user verifies it in the field.
--
--    The first three are HARD: the web app's exclusionReason() holds those rows
--    out of the ranking entirely, because a wrong population makes the density —
--    and therefore the whole score — meaningless.
--
--    Flags are computed at ingest (etl/adapters.py) and stored on the snapshot,
--    so they are queryable and the dashboard can exclude or badge them.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_dq_summary;
CREATE VIEW v_dq_summary AS
SELECT
    dq_flags,
    COUNT(*)                  AS n_places,
    SUM(population)           AS population,
    SUM(n_pharmacy_real + n_pharmacy_legal) AS n_pharmacy_total
FROM v_latest_snapshot
WHERE dq_flags IS NOT NULL
GROUP BY dq_flags
ORDER BY n_places DESC;

-- ---------------------------------------------------------------------------
-- 8. University-of-medical-sciences rollup.
--
--    Pharmacy establishment permits are granted within a university catchment
--    (دانشگاه علوم پزشکی), not purely geographically, so two cities in the same
--    province can face different queues. `university` is lifted out of the raw
--    feed's OrganOnvan field at ingest.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- 9. Population choice + adjusted metrics.
--
--    The FDA's own جمعیت is used by default. When a corroborated reference value
--    exists (population_reference), the adjusted view recomputes every
--    population-derived metric from it instead. Nothing is overwritten — both
--    values are exposed side by side so the dashboard can switch, and so any
--    reviewer can see exactly which number produced which ranking.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_population_choice;
CREATE VIEW v_population_choice AS
SELECT
    m.location_id,
    m.loc_key,
    m.province,
    m.county,
    m.district,
    m.place,
    m.place_kind,
    m.university,
    m.observed_at,
    m.is_market,
    m.dq_flags,
    m.city_score,
    m.min_score,
    -- the raw FDA figure, untouched
    m.population                              AS fda_population,
    -- the corroborated external figure, if any
    pr.population                             AS ref_population,
    pr.source                                 AS ref_source,
    pr.source_id                              AS ref_source_id,
    pr.source_url                             AS ref_source_url,
    pr.census_year_sh                         AS ref_census_year_sh,
    pr.households                             AS ref_households,
    pr.match_score                            AS ref_match_score,
    pr.match_method                           AS ref_match_method,
    -- what the adjusted view uses
    COALESCE(pr.population, m.population)     AS effective_population,
    CASE WHEN pr.population IS NOT NULL THEN 1 ELSE 0 END AS has_reference,
    CASE WHEN pr.population IS NULL THEN NULL
         WHEN m.population IS NULL OR m.population = 0 THEN NULL
         ELSE ROUND(pr.population * 1.0 / m.population, 3) END AS ref_ratio,
    -- pharmacy supply is never adjusted: it is FDA operational data
    m.n_pharmacy_real, m.n_pharmacy_legal, m.n_pharmacy_total, m.n_pharmacy_committed,
    m.n_req_registered, m.n_req_inprogress, m.n_req_approved, m.n_req_pipeline,
    m.pipeline_ratio,
    m.density_reported
FROM v_metrics m
LEFT JOIN population_reference pr ON pr.location_id = m.location_id;

DROP VIEW IF EXISTS v_metrics_adjusted;
CREATE VIEW v_metrics_adjusted AS
SELECT
    c.*,
    c.effective_population                                   AS population,
    CASE WHEN c.effective_population > 0
         THEN ROUND((c.n_pharmacy_real + c.n_pharmacy_legal) * 100000.0
                    / c.effective_population, 2) END         AS pharmacies_per_100k,
    CASE WHEN (c.n_pharmacy_real + c.n_pharmacy_legal) > 0
         THEN ROUND(c.effective_population * 1.0
                    / (c.n_pharmacy_real + c.n_pharmacy_legal), 0) END
                                                             AS population_per_pharmacy
FROM v_population_choice c;

-- ---------------------------------------------------------------------------
-- 10. How much of the analysis scope has a corroborated reference population?
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_reference_coverage;
CREATE VIEW v_reference_coverage AS
SELECT
    COUNT(*)                                                        AS market_places,
    SUM(has_reference)                                              AS with_reference,
    ROUND(100.0 * SUM(has_reference) / NULLIF(COUNT(*), 0), 1)      AS coverage_pct,
    SUM(CASE WHEN has_reference = 1 AND ref_match_score >= 0.75
             THEN 1 ELSE 0 END)                                     AS high_confidence,
    SUM(CASE WHEN has_reference = 1 AND ref_match_score < 0.75
             THEN 1 ELSE 0 END)                                     AS medium_confidence,
    SUM(CASE WHEN has_reference = 1 AND ref_ratio IS NOT NULL
                  AND (ref_ratio >= 2 OR ref_ratio <= 0.5)
             THEN 1 ELSE 0 END)                                     AS materially_different
FROM v_population_choice
WHERE is_market = 1;

-- ---------------------------------------------------------------------------
-- 11. University-of-medical-sciences rollup (moved below the population views
--     so this file stays readable top-down: raw -> metrics -> adjustment).
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_university_rollup;
CREATE VIEW v_university_rollup AS
SELECT
    university,
    COUNT(DISTINCT province)                AS n_provinces,
    SUM(is_market)                          AS n_market_places,
    SUM(population)                         AS population,
    SUM(n_pharmacy_real + n_pharmacy_legal) AS n_pharmacy_total,
    SUM(n_req_inprogress + n_req_approved)  AS n_req_pipeline,
    ROUND(SUM(n_pharmacy_real + n_pharmacy_legal) * 100000.0
          / NULLIF(SUM(population), 0), 2)  AS pharmacies_per_100k
FROM v_metrics
WHERE university IS NOT NULL AND is_market = 1
GROUP BY university
ORDER BY n_pharmacy_total DESC;

-- ---------------------------------------------------------------------------
-- 12. The view the dashboard actually reads.
--
--     v_population_choice plus the two things added on top of it:
--       * manual overrides, pivoted from the field/value rows in
--         manual_override so they arrive as columns;
--       * county-level corroboration from the provincial yearbook, which is the
--         only way to tell that the FDA's pharmacy count for a county disagrees
--         with the province's own published figure.
--
--     county_pharmacy_ratio ~= 1 means the two independent sources agree.
--     Deliberately computed over ALL places (not just market scope), so the
--     comparison is apples-to-apples with the yearbook's whole-county totals.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_place_full;
CREATE VIEW v_place_full AS
SELECT
    m.*,
    ov.manual_population,
    ov.manual_pharmacy_real,
    ov.manual_pharmacy_legal,
    ov.manual_note,
    ov.manual_updated_at,
    CASE WHEN ov.n_overrides > 0 THEN 1 ELSE 0 END AS has_manual,
    sal_ph.value  AS salname_pharmacies_1403,
    sal_pop.value AS salname_county_population_1395,
    cty.fda_ph    AS fda_county_pharmacies,
    CASE WHEN sal_ph.value > 0
         THEN ROUND(cty.fda_ph * 1.0 / sal_ph.value, 3) END AS county_pharmacy_ratio
FROM v_population_choice m
LEFT JOIN (
    SELECT loc_key,
           MAX(CASE WHEN field = 'population'       THEN value END) AS manual_population,
           MAX(CASE WHEN field = 'n_pharmacy_real'  THEN value END) AS manual_pharmacy_real,
           MAX(CASE WHEN field = 'n_pharmacy_legal' THEN value END) AS manual_pharmacy_legal,
           GROUP_CONCAT(CASE WHEN note IS NOT NULL AND note <> ''
                             THEN note END, ' • ')                   AS manual_note,
           MAX(updated_at)                                           AS manual_updated_at,
           COUNT(*)                                                  AS n_overrides
    FROM manual_override
    GROUP BY loc_key
) ov ON ov.loc_key = m.loc_key
LEFT JOIN (
    SELECT county_key, value FROM salname_metrics
    WHERE scope = 'county' AND metric = 'pharmacies'
      AND dimension = 'total' AND year_sh = 1403
) sal_ph ON REPLACE(sal_ph.county_key, ' ', '') = REPLACE(TRIM(REPLACE(m.county, 'شهرستان', '')), ' ', '')
LEFT JOIN (
    SELECT county_key, value FROM salname_metrics
    WHERE scope = 'county' AND metric = 'population' AND dimension = 'total'
) sal_pop ON REPLACE(sal_pop.county_key, ' ', '') = REPLACE(TRIM(REPLACE(m.county, 'شهرستان', '')), ' ', '')
LEFT JOIN (
    SELECT province, county,
           SUM(COALESCE(n_pharmacy_real, 0) + COALESCE(n_pharmacy_legal, 0)) AS fda_ph
    FROM v_metrics GROUP BY province, county
) cty ON cty.province = m.province
     AND TRIM(REPLACE(cty.county, 'شهرستان', '')) = TRIM(REPLACE(m.county, 'شهرستان', ''));

-- ---------------------------------------------------------------------------
-- 13. County-level agreement between the two independent pharmacy sources.
--
--     fda_pharmacies is the live feed summed over the whole county;
--     salname_pharmacies_1403 is the province's own published count. A ratio far
--     from 1 means one of the two deserves a look — and the yearbook's own growth
--     series (828 -> 849 across 1402 -> 1403) is what makes the expected gap
--     between a 1403 figure and a 1405-era feed known rather than assumed.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_county_crosscheck;
CREATE VIEW v_county_crosscheck AS
SELECT
    l.province,
    l.county,
    l.fda_pharmacies,
    s.value AS salname_pharmacies_1403,
    ROUND(l.fda_pharmacies * 1.0 / NULLIF(s.value, 0), 3) AS ratio,
    l.fda_population,
    sp.value AS salname_population_1395,
    ROUND(l.fda_population * 1.0 / NULLIF(sp.value, 0), 3) AS population_ratio
FROM (
    SELECT province, county,
           SUM(n_pharmacy_real + n_pharmacy_legal) AS fda_pharmacies,
           SUM(population)                         AS fda_population
    FROM v_metrics
    GROUP BY province, county
) l
LEFT JOIN salname_metrics s
       ON s.scope = 'county' AND s.metric = 'pharmacies'
      AND s.dimension = 'total' AND s.year_sh = 1403
      AND REPLACE(s.county_key, ' ', '') = REPLACE(TRIM(REPLACE(l.county, 'شهرستان', '')), ' ', '')
LEFT JOIN salname_metrics sp
       ON sp.scope = 'county' AND sp.metric = 'population'
      AND sp.dimension = 'total'
      AND REPLACE(sp.county_key, ' ', '') = REPLACE(TRIM(REPLACE(l.county, 'شهرستان', '')), ' ', '')
ORDER BY l.fda_pharmacies DESC;

-- ---------------------------------------------------------------------------
-- 14. Buying-power INPUTS for the over-the-counter (بدون نسخه) model.
--
--     The FDA feed answers "how many prescriptions". It says nothing about the
--     half of a pharmacy's business that is paid out of pocket: cosmetics,
--     supplements, OTC drugs — the part whose size depends on how well-off the
--     catchment is, not on how many people live there. This view supplies the
--     INPUTS only; the model itself is pure and lives in web/src/lib/otc.ts so
--     the user can re-tune it live.
--
--     Two signals, both from data already in the database:
--
--     1. county_urban_share — what fraction of the county's population lives in
--        a settlement that is a city, or large (>= 10,000), or already sustains
--        3+ pharmacies. That is the "urbanisation" of the neighbourhood, which
--        is the single strongest observable driver of household spending.
--        Computed from population counts, NOT from the «شهر» name prefix: the
--        prefix is unreliable at the top end (تهران بزرگ is labelled 'other'),
--        and a name-based urbanisation measure reports 0% urban for تهران.
--        Rows already flagged pop_outlier are excluded from the aggregate
--        because a mis-joined metro population (تجریش carrying Tehran's 8.15 M)
--        would otherwise make شمیرانات look like a metropolis of 8.2 M people.
--
--     2. hh_size — persons per household, from the corroborated census figure
--        (population_reference.households). Smaller households correlate with
--        urban, higher-income living; NULL when no reference value resolved,
--        and NULL is treated as "no information", never as an average.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_place_prosperity;
CREATE VIEW v_place_prosperity AS
WITH county_pop AS (
    SELECT province, county,
           SUM(population) AS county_population,
           SUM(CASE WHEN place_kind = 'city'
                          OR population >= 10000
                          OR (COALESCE(n_pharmacy_real, 0)
                              + COALESCE(n_pharmacy_legal, 0)) >= 3
                    THEN population ELSE 0 END) AS county_urban_population
    FROM v_metrics
    WHERE population > 0
      AND (dq_flags IS NULL OR dq_flags NOT LIKE '%pop_outlier%')
    GROUP BY province, county
)
SELECT
    m.location_id,
    m.province,
    m.county,
    m.place,
    m.place_kind,
    cp.county_population,
    CASE WHEN cp.county_population > 0
         THEN ROUND(cp.county_urban_population * 1.0 / cp.county_population, 4)
    END                                                       AS county_urban_share,
    -- persons per household, only where the census reference actually resolved
    CASE WHEN m.ref_population > 0 AND m.ref_households > 0
         THEN ROUND(m.ref_population * 1.0 / m.ref_households, 2)
    END                                                       AS hh_size,
    m.has_reference
FROM v_population_choice m
LEFT JOIN county_pop cp
       ON cp.province = m.province AND cp.county = m.county;

-- ---------------------------------------------------------------------------
-- 15. The official anchor for the OTC model.
--
--     The model needs one external number it cannot invent: how much a household
--     in this part of the country spends per year. The provincial yearbook
--     (سالنامه ۱۴۰۳ خوزستان, chapter 21) publishes exactly that, for urban and
--     rural households, plus the 1395 census population/household counts that
--     turn it into a PER-PERSON figure.
--
--     What the dashboard does with it:
--       * rural_to_urban_ratio          — the measured relative spending power of
--         a village vs a city, used instead of a guessed 0.6;
--       * consumption_per_capita_1403   — the level the default OTC-per-capita
--         assumption is derived from (see DEFAULT OTC in lib/otc.ts).
--
--     Scope caveat, stated plainly: the yearbook is Khuzestan's. Outside the
--     province no equivalent figure is loaded, so the model treats the ratio as
--     national and says so in the UI. Nothing here is extrapolated per county —
--     the numbers are provincial aggregates and are labelled as such.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_otc_anchors;
CREATE VIEW v_otc_anchors AS
WITH exp AS (
    SELECT MAX(CASE WHEN dimension = 'urban' THEN value END) AS urban_hh_exp,
           MAX(CASE WHEN dimension = 'rural' THEN value END) AS rural_hh_exp
    FROM salname_metrics
    WHERE metric = 'household_expenditure' AND year_sh = 1403
),
hh AS (
    SELECT SUM(CASE WHEN metric = 'population' AND dimension = 'urban' THEN value ELSE 0 END) AS urban_pop,
           SUM(CASE WHEN metric = 'population' AND dimension = 'rural' THEN value ELSE 0 END) AS rural_pop,
           SUM(CASE WHEN metric = 'households' AND dimension = 'urban' THEN value ELSE 0 END) AS urban_hh,
           SUM(CASE WHEN metric = 'households' AND dimension = 'rural' THEN value ELSE 0 END) AS rural_hh
    FROM salname_metrics
    WHERE scope = 'county' AND year_sh = 1395
),
sizes AS (
    SELECT ROUND(urban_pop * 1.0 / NULLIF(urban_hh, 0), 2) AS urban_hh_size,
           ROUND(rural_pop * 1.0 / NULLIF(rural_hh, 0), 2) AS rural_hh_size
    FROM hh
)
SELECT
    1403                                                      AS year_sh,
    'سالنامه آماری خوزستان'                                   AS source,
    e.urban_hh_exp                                            AS urban_hh_expenditure,
    e.rural_hh_exp                                            AS rural_hh_expenditure,
    ROUND(e.rural_hh_exp * 1.0 / NULLIF(e.urban_hh_exp, 0), 3) AS rural_to_urban_ratio,
    s.urban_hh_size,
    s.rural_hh_size,
    ROUND(e.urban_hh_exp / NULLIF(s.urban_hh_size, 0), 0)     AS urban_consumption_per_capita,
    ROUND(e.rural_hh_exp / NULLIF(s.rural_hh_size, 0), 0)     AS rural_consumption_per_capita
FROM exp e, sizes s;
