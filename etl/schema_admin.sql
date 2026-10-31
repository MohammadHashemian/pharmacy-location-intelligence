-- ============================================================================
--  Pharmacy Location Intelligence — ADMINISTRATIVE layer (additive)
--
--  What the FDA feed lacks: it names a place and a بخش, never a دهستان, and it
--  only lists settlements that already have (or applied for) a pharmacy. The
--  question "how many people live in ام‌الطمیر?" therefore has no answer in
--  `locations`.
--
--  This layer is the full settlement tree of استان خوزستان:
--      استان → شهرستان → بخش → دهستان → شهر / روستا
--  built from fa.wikipedia (county «تقسیمات کشوری» tables, village infoboxes),
--  Wikidata (identity, coordinates, population) and the two layers we already
--  hold (FDA `locations`, OSM `geo_places`) — all four are kept as *sources*,
--  never merged into one unaccountable number.
--
--  Design rules, same as the rest of the project:
--    1. Date-banded. A row is never edited in place: a new
--       `admin_area_version` opens at `valid_from`, the previous one is closed
--       at `valid_to`. "What did the tree look like on 1404-08-09?" is a
--       WHERE clause, not a backup restore.
--    2. Every population carries its own source, census year and URL, and
--       lives in `admin_population` (also date-banded) — never as a single
--       mutable column.
--    3. Nothing existing is touched: no ALTER on `locations`, `geo_places`,
--       `salname_metrics`. This file only creates new tables/views.
--    4. Idempotent: re-running the loader re-emits the same keys, so the
--       second run changes nothing (and is auditable as a no-op).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- A1. One row per ingest run. Same role as `data_sources`, but scoped to the
--     admin layer so a rebuild of one never falsifies the other's history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_import (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,           -- human name of the snapshot
  scope         TEXT    NOT NULL DEFAULT 'استان خوزستان',
  observed_at   TEXT    NOT NULL,           -- when the source was captured
  imported_at   TEXT    NOT NULL,
  sources       TEXT,                       -- JSON: [{layer, ref, sha256}]
  n_province    INTEGER NOT NULL DEFAULT 0,
  n_county      INTEGER NOT NULL DEFAULT 0,
  n_bakhsh      INTEGER NOT NULL DEFAULT 0,
  n_dehestan    INTEGER NOT NULL DEFAULT 0,
  n_city        INTEGER NOT NULL DEFAULT 0,
  n_village     INTEGER NOT NULL DEFAULT 0,
  n_added       INTEGER NOT NULL DEFAULT 0,
  n_changed     INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  UNIQUE (label, observed_at)
);

-- ---------------------------------------------------------------------------
-- A2. Stable identity of one administrative/settlement unit.
--     area_key = sha1(kind|name_key|parent_area_key): an area that is moved to
--     another parent gets a NEW key and its old row is closed, so history shows
--     the move instead of pretending nothing happened.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_area (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  area_key       TEXT    NOT NULL UNIQUE,
  kind           TEXT    NOT NULL,   -- province|county|bakhsh|dehestan|city|village
  name           TEXT    NOT NULL,   -- as the source spells it, e.g. «غیزانیه»
  name_key       TEXT    NOT NULL,   -- norm_key(name), the join key
  parent_area_id INTEGER REFERENCES admin_area (id),
  latitude       REAL,
  longitude      REAL,
  wikidata       TEXT,
  wikipedia      TEXT,
  -- denormalised current path, so a report needs no recursive CTE
  county         TEXT,
  bakhsh         TEXT,
  dehestan       TEXT,
  first_import_id INTEGER,
  last_import_id  INTEGER,
  first_seen_at  TEXT,
  last_seen_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_admin_area_kind  ON admin_area (kind);
CREATE INDEX IF NOT EXISTS ix_admin_area_name  ON admin_area (name_key);
CREATE INDEX IF NOT EXISTS ix_admin_area_par   ON admin_area (parent_area_id);
CREATE INDEX IF NOT EXISTS ix_admin_area_path  ON admin_area (county, bakhsh, dehestan);

-- ---------------------------------------------------------------------------
-- A3. Date-banded state. Exactly one open row per area (valid_to IS NULL).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_area_version (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id        INTEGER NOT NULL REFERENCES admin_area (id) ON DELETE CASCADE,
  import_id      INTEGER NOT NULL REFERENCES admin_import (id),
  valid_from     TEXT    NOT NULL,
  valid_to       TEXT,                          -- NULL = still current
  kind           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  parent_area_id INTEGER,
  county         TEXT,
  bakhsh         TEXT,
  dehestan       TEXT,
  source         TEXT,                          -- 'fa.wikipedia' | 'wikidata' | ...
  source_ref     TEXT,                          -- article title / QID
  note           TEXT
);
CREATE INDEX IF NOT EXISTS ix_admin_ver_area  ON admin_area_version (area_id, valid_from);
CREATE INDEX IF NOT EXISTS ix_admin_ver_open  ON admin_area_version (valid_to);

-- ---------------------------------------------------------------------------
-- A4. Population observations. Date-banded per (area, source, census year), so
--     a 1385 figure and a 1395 figure coexist instead of overwriting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_population (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id      INTEGER NOT NULL REFERENCES admin_area (id) ON DELETE CASCADE,
  import_id    INTEGER REFERENCES admin_import (id),
  population   INTEGER,
  households   INTEGER,
  year_sh      INTEGER,                      -- 1385, 1395, ...
  source       TEXT    NOT NULL,             -- fa.wikipedia | wikidata | fda-feed | osm-tag
  source_ref   TEXT,
  method       TEXT,                         -- 'infobox' | 'census-sentence' | 'p1082'
  confidence   REAL,
  valid_from   TEXT    NOT NULL,
  valid_to     TEXT,
  observed_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_admin_pop_area ON admin_population (area_id, source, year_sh);
CREATE INDEX IF NOT EXISTS ix_admin_pop_open ON admin_population (valid_to);

-- ---------------------------------------------------------------------------
-- A5. Alternative spellings (Arabic yeh/kaf, «روستای» prefix, OSM's transliteration).
--     Kept so a later match never has to guess.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_area_alias (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id   INTEGER NOT NULL REFERENCES admin_area (id) ON DELETE CASCADE,
  alias     TEXT    NOT NULL,
  alias_key TEXT    NOT NULL,
  source    TEXT,
  UNIQUE (area_id, alias_key, source)
);
CREATE INDEX IF NOT EXISTS ix_admin_alias_key ON admin_area_alias (alias_key);

-- ---------------------------------------------------------------------------
-- A6. Cross-layer links: which FDA location / OSM place is this area?
--     MANY-to-one on purpose (the FDA feed duplicates spellings); a link is
--     evidence, never a merge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_area_link (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id     INTEGER NOT NULL REFERENCES admin_area (id) ON DELETE CASCADE,
  layer       TEXT    NOT NULL,          -- 'fda' | 'osm'
  ref_id      INTEGER NOT NULL,          -- locations.id | geo_places.id
  score       REAL,
  method      TEXT,
  decided_at  TEXT    NOT NULL,
  UNIQUE (area_id, layer, ref_id)
);
CREATE INDEX IF NOT EXISTS ix_admin_link_ref ON admin_area_link (layer, ref_id);

-- ---------------------------------------------------------------------------
-- A7. Current state, one row per open area. This is what the app reads.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_admin_area_current;
CREATE VIEW v_admin_area_current AS
SELECT a.id            AS area_id,
       a.area_key,
       a.kind,
       a.name,
       a.name_key,
       a.county, a.bakhsh, a.dehestan,
       a.latitude, a.longitude,
       a.wikidata, a.wikipedia,
       a.parent_area_id,
       v.valid_from,
       p.population,
       p.households,
       p.year_sh       AS population_year_sh,
       p.source        AS population_source,
       p.confidence    AS population_confidence
FROM admin_area a
JOIN admin_area_version v ON v.area_id = a.id AND v.valid_to IS NULL
LEFT JOIN admin_population p ON p.id = (
    SELECT p2.id FROM admin_population p2
    WHERE p2.area_id = a.id AND p2.valid_to IS NULL AND p2.population IS NOT NULL
    ORDER BY COALESCE(p2.confidence, 0) DESC, p2.year_sh DESC, p2.id DESC
    LIMIT 1
);

-- ---------------------------------------------------------------------------
-- A8. The settlement tree flattened, with a readable breadcrumb.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_admin_settlement;
CREATE VIEW v_admin_settlement AS
SELECT c.area_id, c.kind, c.name, c.county, c.bakhsh, c.dehestan,
       c.population, c.population_year_sh, c.population_source,
       c.latitude, c.longitude, c.wikidata, c.wikipedia,
       COALESCE(c.county, '') ||
         CASE WHEN c.bakhsh   IS NOT NULL THEN ' › بخش '   || c.bakhsh   ELSE '' END ||
         CASE WHEN c.dehestan IS NOT NULL THEN ' › دهستان ' || c.dehestan ELSE '' END
         AS breadcrumb
FROM v_admin_area_current c
WHERE c.kind IN ('city', 'village');

-- ---------------------------------------------------------------------------
-- A9. Counts per level, for the completeness report.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_admin_coverage;
CREATE VIEW v_admin_coverage AS
SELECT kind,
       COUNT(*)                                   AS n,
       SUM(population IS NOT NULL)                AS n_with_population,
       SUM(population IS NULL)                    AS n_without_population,
       SUM(population)                            AS population_sum
FROM v_admin_area_current
GROUP BY kind;
