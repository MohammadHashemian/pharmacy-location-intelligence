-- ============================================================================
--  Pharmacy Location Intelligence — SQLite schema
--  Source: Iran FDA  "نمایش تعداد داروخانه های کشور"  (pharmacy.fda.gov.ir)
--  Design goal: idempotent, agent-updatable. Every ingest is an immutable
--  "observation" appended to a time series; the master list of places is
--  stable and keyed by a natural key so re-running the loader never
--  duplicates or destroys history.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Provenance: one row per ingest run.
--    The other agent registers each fetch here, so every number in the
--    dashboard can be traced back to a file/URL + hash + timestamp.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_sources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,              -- 'html' | 'json' | 'api_json'
  ref            TEXT NOT NULL,              -- absolute file path or URL
  sha256         TEXT,                       -- hash of the payload
  parser_version TEXT,
  observed_at    TEXT NOT NULL,              -- when the snapshot was captured
  ingested_at    TEXT NOT NULL,              -- when we loaded it
  row_count      INTEGER NOT NULL DEFAULT 0,
  rows_inserted  INTEGER NOT NULL DEFAULT 0,
  rows_updated   INTEGER NOT NULL DEFAULT 0,
  scope_label    TEXT,                       -- e.g. 'استان خوزستان'
  status         TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'partial' | 'error'
  notes          TEXT,
  UNIQUE (kind, ref, sha256, observed_at)
);

-- ---------------------------------------------------------------------------
-- 2. Master registry of places (stable identity across snapshots).
--    loc_key = sha1 normalised "province|county|district|place"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  loc_key       TEXT NOT NULL UNIQUE,
  province      TEXT NOT NULL,
  county        TEXT NOT NULL,
  district      TEXT NOT NULL,
  place         TEXT NOT NULL,
  place_kind    TEXT NOT NULL,               -- 'city' | 'village' | 'other'
  university    TEXT,                        -- دانشگاه علوم پزشکی متولی (OrganOnvan)
  province_key  TEXT NOT NULL,
  county_key    TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  -- reserved for future enrichment (geo coords, drive-time, etc.)
  lat           REAL,
  lon           REAL,
  external_ids  TEXT                         -- JSON bag for extra identifiers
);
CREATE INDEX IF NOT EXISTS idx_loc_province ON locations (province_key);
CREATE INDEX IF NOT EXISTS idx_loc_county   ON locations (county_key);
CREATE INDEX IF NOT EXISTS idx_loc_kind     ON locations (place_kind);

-- ---------------------------------------------------------------------------
-- 3. Observations: the actual measurements, one row per place per capture.
--    Never mutated — a re-capture adds a new observed_at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS location_snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id        INTEGER NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  source_id          INTEGER NOT NULL REFERENCES data_sources (id) ON DELETE CASCADE,
  observed_at        TEXT    NOT NULL,
  -- raw fields, exactly as reported by the source ------------------------
  population         INTEGER,
  city_score         REAL,      -- امتیاز شهر
  min_score          REAL,      -- حداقل امتیاز
  n_pharmacy_real    INTEGER,   -- تعداد داروخانه حقیقی
  n_pharmacy_legal   INTEGER,   -- تعداد داروخانه حقوقی
  n_req_registered   INTEGER,   -- تعداد درخواست ثبت شده
  n_req_inprogress   INTEGER,   -- تعداد درخواست های درحال جریان
  n_req_approved     INTEGER,   -- تعداد موافقت اصولی صادر شده
  density_reported   REAL,      -- نسبت تعداد داروخانه به جمعیت * 1e6
  extra              TEXT,      -- JSON: any field the parser didn't recognise
  dq_flags           TEXT,      -- comma list of data-quality warnings (see below)
  UNIQUE (location_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_snap_loc  ON location_snapshots (location_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_snap_time ON location_snapshots (observed_at);

-- ---------------------------------------------------------------------------
-- 5c. Manual overrides — the dataset is editable.
--
--     The user finds new evidence (a census page, a field visit, a new yearbook)
--     and needs to correct a value without re-running the ETL or losing the
--     original. An override therefore never overwrites the source: it is stored
--     beside it, carries a note and an author, wins over every automated source
--     when present, and every change is journalled in manual_override_log so the
--     provenance of a number is always answerable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_override (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Keyed on loc_key, NOT location_id: a rebuild re-creates locations with new
    -- autoincrement ids, which would silently orphan every override — i.e. lose
    -- the user's evidence. loc_key is derived from province|county|district|place
    -- and survives a rebuild. location_id is kept only as a convenience pointer.
    loc_key     TEXT    NOT NULL,
    location_id INTEGER,
    field       TEXT    NOT NULL,      -- population | n_pharmacy_real | n_pharmacy_legal
    value       REAL,
    note        TEXT,
    author      TEXT,
    updated_at  TEXT    NOT NULL,
    UNIQUE(loc_key, field)
);

CREATE TABLE IF NOT EXISTS manual_override_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    loc_key     TEXT    NOT NULL,
    location_id INTEGER,
    field       TEXT    NOT NULL,
    old_value   REAL,
    new_value   REAL,
    note        TEXT,
    author      TEXT,
    changed_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_override_loc ON manual_override(loc_key);

-- ---------------------------------------------------------------------------
-- 5b. Provincial yearbook (سالنامه آماری استان خوزستان ۱۴۰۳).
--
--     The province's official annual, parsed from its Word chapters. Its value
--     here is independence: it publishes the province's OWN pharmacy count per
--     county (chapter 18, table 10), so the FDA feed can be cross-checked
--     against an authority instead of being trusted on its own. It also carries
--     county population/households (1395 census) and provincial household
--     expenditure including a بهداشت و درمان line.
--
--     Scope is county, whereas the FDA feed is settlement — complementary, not
--     a replacement. Nothing here overwrites FDA values.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS salname_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter     TEXT    NOT NULL,          -- '3' population, '18' health, '21' income
    table_ref   TEXT    NOT NULL,          -- e.g. '18-10'
    caption     TEXT,
    scope       TEXT    NOT NULL,          -- 'province' | 'county'
    county      TEXT,                      -- normalised شهرستان, NULL for province rows
    county_key  TEXT,                      -- norm_key(county), for joining to locations
    metric      TEXT    NOT NULL,          -- population | households | pharmacies | household_expenditure
    dimension   TEXT,                      -- total | urban | rural | private | ...
    year_sh     INTEGER,                   -- 1395, 1403, ...
    value       REAL    NOT NULL,
    unit        TEXT,                      -- person | household | pharmacy | thousand_rial
    fetched_at  TEXT    NOT NULL,
    UNIQUE(chapter, table_ref, scope, county, metric, dimension, year_sh)
);
CREATE INDEX IF NOT EXISTS ix_salname_county ON salname_metrics(county, metric, year_sh);

-- ---------------------------------------------------------------------------
-- 5. Reference population layer (external, corroborated).
--
--    The FDA feed's جمعیت is wrong for a meaningful minority of places — e.g.
--    «روستاي ملاشيه» (خوزستان) is published with 169 people while the official
--    Statistical Center 1395 census gives 16,575 for ملاشیه یک, and several real
--    cities (قرچک, ری, پردیس) are published with population 0 alongside dozens
--    of pharmacies.
--
--    The FDA value is NEVER overwritten: this table holds a parallel, cited value
--    with its own provenance and a match-confidence score. Views downstream pick
--    between them, and the dashboard exposes the choice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS population_reference (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id    INTEGER NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  source         TEXT NOT NULL,          -- 'wikidata' | 'wikipedia-census'
  source_id      TEXT,                   -- QID, or the article title
  source_url     TEXT,
  population     INTEGER NOT NULL,
  households     INTEGER,                -- خانوار, when the census states it
  census_year    INTEGER,                -- Gregorian
  census_year_sh INTEGER,                -- Shamsi (e.g. 1395)
  lat            REAL,
  lon            REAL,
  match_score    REAL NOT NULL,          -- 0..1 confidence
  match_method   TEXT,                   -- why it was accepted
  fetched_at     TEXT NOT NULL,
  UNIQUE (location_id, source)
);
CREATE INDEX IF NOT EXISTS idx_popref_loc ON population_reference (location_id);

-- ---------------------------------------------------------------------------
-- 6. Tunable scoring model. Weights live in the DB (not hard-coded) so the
--    dashboard can re-rank on the fly and the other agent can version a model.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scoring_models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  is_default  INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  weights     TEXT NOT NULL,     -- JSON {metric: weight}
  created_at  TEXT NOT NULL
);
