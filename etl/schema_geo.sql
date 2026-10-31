-- ============================================================================
--  Pharmacy Location Intelligence — GEOGRAPHIC layer (additive)
--
--  Purpose: the FDA feed is the *pharmacy authority's* inventory of settlements.
--  It is not a map. It has no coordinates, and it is not guaranteed complete —
--  زرگان (a district of اهواز) is simply absent from it. This layer answers the
--  complementary question: **what places exist on the map, and which of them is
--  the FDA feed missing?**
--
--  Sources, all independent of the FDA feed:
--    * OpenStreetMap / Overpass  — place=city|town|village|hamlet|… inside the
--      استان خوزستان boundary (relation 3661581), with coordinates
--    * Wikidata                 — P1082 population + P625 coordinates + the
--      P131 admin chain (which is what supplies the شهرستان, since OSM's
--      Khuzestan mapping has 6=بخش and 7=دهستان but no city-county polygons)
--    * fa.wikipedia census sentence — «جمعیت آن ۱۶۵۷۵ نفر (۴۴۷۴ خانوار)»,
--      read through the item's own QID so a same-name article cannot hijack it
--
--  Design rules, carried over from the FDA layer:
--    1. Nothing is overwritten. The FDA value stays where it is; a map place is
--       a *separate row* in a *separate table*.
--    2. Nothing is guessed. A place that cannot be resolved keeps NULL and a
--       dq_flag instead of a plausible-looking number.
--    3. Every row is traceable to a captured payload (geo_sources).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- G1. Provenance for every geographic capture.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  layer         TEXT NOT NULL,          -- 'osm' | 'wikidata' | 'wikipedia'
  ref           TEXT NOT NULL,          -- file path or URL
  licence       TEXT,                   -- ODbL / CC0
  sha256        TEXT,
  observed_at   TEXT NOT NULL,
  ingested_at   TEXT NOT NULL,
  element_count INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  UNIQUE (layer, ref, sha256)
);

-- ---------------------------------------------------------------------------
-- G2. The place inventory found on the map.
--
--     Grain: one row per (source, source_id). OSM's own duplication (a city is
--     tagged both as a node and as a boundary relation) is collapsed in the
--     loader and the losers are recorded in geo_place_duplicate, so the merge is
--     auditable rather than invisible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_places (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT    NOT NULL,       -- 'osm'
  source_id         TEXT    NOT NULL,       -- 'node/123', 'way/456', 'relation/789'
  osm_type          TEXT,
  osm_id            INTEGER,
  name              TEXT    NOT NULL,       -- exactly as the map spells it
  name_clean        TEXT,                   -- type prefix + Arabic letters folded
  name_key          TEXT    NOT NULL,       -- norm_key(), the join key
  name_en           TEXT,
  alt_names         TEXT,                   -- JSON list of every spelling seen
  place_kind        TEXT,                   -- city|town|village|hamlet|isolated_dwelling|neighbourhood
  lat               REAL,
  lon               REAL,
  -- administrative resolution (see views_geo.sql for the confidence rules) ----
  province          TEXT,
  county        TEXT,                   -- شهرستان (from the place's own QID when it
                                        -- has one, else from its بakhsh polygon)
  county_alt    TEXT,                   -- the other method's answer, kept when the
                                        -- two disagree instead of silently picking
  district      TEXT,                   -- بخش
  county_key    TEXT,
  district_key  TEXT,
  admin_method  TEXT,                   -- how county/district were decided
  admin_source  TEXT,                   -- 'wikidata-p131' | 'wikidata-qid' | 'geometric'
  admin_confidence  REAL,
  -- population, from three independent places: the map's own tag, Wikidata,
  -- and the fa.wikipedia census sentence. Never merged into one number.
  pop_osm           INTEGER,
  pop_osm_date      TEXT,
  pop_wikidata      INTEGER,
  pop_wikipedia     INTEGER,
  pop_wikipedia_hh  INTEGER,                -- خانوار
  pop_ref_year_sh   INTEGER,
  pop_ref_source    TEXT,                   -- 'osm-tag' | 'wikidata' | 'wikipedia-census'
  pop_ref_url       TEXT,                   -- the exact page the number came from
  pop_match_score   REAL,                   -- 0..1, how sure the place is the same one
  pop_match_method  TEXT,                   -- why it was accepted
  wd_lat            REAL,                   -- Wikidata's own point, for the separation check
  wd_lon            REAL,
  wd_separation_m   REAL,
  wikidata          TEXT,                   -- QID, when the map carries one
  wikipedia         TEXT,
  -- position relative to the reference city (اهواز) --------------------------
  distance_km       REAL,                   -- great-circle
  road_km           REAL,                   -- OSRM driving, urban places only
  road_minutes      REAL,
  bearing_deg       REAL,
  -- matches against the FDA master list -------------------------------------
  in_fda            INTEGER NOT NULL DEFAULT 0,   -- 1 when matched to `locations`
  is_in_fda_scope   INTEGER NOT NULL DEFAULT 0,   -- matched AND that row is a market
  dq_flags          TEXT,
  tags              TEXT,                   -- raw OSM tags, verbatim
  observed_at       TEXT    NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS ix_geoplace_name    ON geo_places (name_key);
CREATE INDEX IF NOT EXISTS ix_geoplace_county  ON geo_places (county_key);
CREATE INDEX IF NOT EXISTS ix_geoplace_infda   ON geo_places (in_fda);
CREATE INDEX IF NOT EXISTS ix_geoplace_dist    ON geo_places (distance_km);
CREATE INDEX IF NOT EXISTS ix_geoplace_kind    ON geo_places (place_kind);

-- ---------------------------------------------------------------------------
-- G3. Duplicates inside the map layer itself.
--     OSM maps a city twice (a `place=city` node AND a `boundary=administrative`
--     relation). The loader keeps one and records the rest here with the reason,
--     so "why does اندیمشک appear once instead of three times?" is answerable.
--     duplicate_id is NULL on purpose: the loser never becomes a geo_places row,
--     and inventing an id for it would imply a row that does not exist.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_place_duplicate (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  survivor_id     INTEGER NOT NULL REFERENCES geo_places (id) ON DELETE CASCADE,
  duplicate_id    INTEGER,
  duplicate_source_id TEXT NOT NULL,
  duplicate_kind  TEXT,
  separation_m    REAL,
  reason          TEXT
);
CREATE INDEX IF NOT EXISTS ix_geodup_survivor ON geo_place_duplicate (survivor_id);

-- ---------------------------------------------------------------------------
-- G4. Map place -> FDA place. Many-to-one on purpose: OSM may map a settlement
--     twice under different spellings, and both should point at the same FDA row
--     rather than one of them being declared "new".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_location_match (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  geo_place_id  INTEGER NOT NULL REFERENCES geo_places (id) ON DELETE CASCADE,
  location_id   INTEGER NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  tier          TEXT    NOT NULL DEFAULT 'match',   -- 'match' | 'variant'
  match_score   REAL    NOT NULL,
  match_method  TEXT,
  separation_m  REAL,                      -- map point vs the reference layer's own point
  decided_at    TEXT    NOT NULL,
  UNIQUE (geo_place_id, location_id)
);
CREATE INDEX IF NOT EXISTS ix_geomatch_geo ON geo_location_match (geo_place_id);
CREATE INDEX IF NOT EXISTS ix_geomatch_loc ON geo_location_match (location_id);

-- ---------------------------------------------------------------------------
-- G5. Administrative unit resolution: the map's own boundary polygons, each
--     identified in OSM by a Wikidata QID, which in turn states the شهرستان it
--     belongs to (P131). That chain is what makes the county assignment
--     independent of my own geometry rather than a circle drawn by hand.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_admin_unit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_type      TEXT,
  osm_id        INTEGER,
  admin_level   TEXT,                      -- '6' = بخش, '7' = دهستان (OSM Iran)
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  unit_kind     TEXT,                      -- 'bakhsh' | 'dehestan'
  county        TEXT,                      -- from Wikidata P131, when resolvable
  county_key    TEXT,
  wikidata      TEXT,
  wikipedia     TEXT,
  n_members     INTEGER,
  observed_at   TEXT NOT NULL,
  UNIQUE (osm_type, osm_id)
);
CREATE INDEX IF NOT EXISTS ix_geoadmin_key ON geo_admin_unit (name_key);

-- ---------------------------------------------------------------------------
-- G6. Which FDA place is missing from the map, and which map place is missing
--     from the FDA feed? Both directions matter — the first is a data-quality
--     signal about the map, the second is the business question.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_coverage_note (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,               -- 'khuzestan'
  metric      TEXT NOT NULL,
  value       REAL,
  detail      TEXT,
  computed_at TEXT NOT NULL,
  UNIQUE (scope, metric)
);
