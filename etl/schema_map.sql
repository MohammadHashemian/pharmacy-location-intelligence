-- ============================================================================
--  Pharmacy Location Intelligence — MAP layer (additive)
--
--  The dashboard ranks places by market potential; it cannot answer "how far is
--  this village from اهواز, and what does the province look like on the way
--  there?" This layer adds exactly that and nothing else:
--
--    map_point     one row per plotted settlement: resolved coordinate, straight
--                  line, road distance where OSRM measured one, network distance
--                  over the settlement proximity graph, the ring it falls in
--    map_edge      the minimum spanning tree over that graph — what the map draws
--    map_density   residential grid cells only: a cell exists iff a settlement is
--                  within MASK_KM, so a density colour can never land in desert
--    map_import    one row per build: parameters, calibration, counts
--
--  Design rules (same as the rest of the project):
--    1. Nothing existing is altered. Coordinates and counts are NOT copied here:
--       `v_map_settlement` joins `v_admin_area_current` and the live FDA snapshot,
--       so an FDA reload is visible without re-running this build.
--    2. Distances are computed, never guessed. Where the road network was not
--       measured, the row says `network` and carries the graph number — it is
--       never relabelled as a road distance.
--    3. Idempotent: a rebuild deletes and re-inserts the same keys.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- M1. One row per build.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS map_import (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  built_at          TEXT NOT NULL,
  reference_name    TEXT NOT NULL,            -- «اهواز»
  reference_lat     REAL NOT NULL,
  reference_lon     REAL NOT NULL,
  k_neighbors       INTEGER NOT NULL,
  connect_km        REAL NOT NULL,            -- radius of the "everything near" edges
  max_edge_km       REAL NOT NULL,            -- longer proximity edges are dropped
  road_calibration  REAL,                     -- median(road / network) over sampled places
  n_road_sample     INTEGER NOT NULL DEFAULT 0,
  n_settlement      INTEGER NOT NULL DEFAULT 0,
  n_plotted         INTEGER NOT NULL DEFAULT 0,
  n_edge            INTEGER NOT NULL DEFAULT 0,
  n_cell            INTEGER NOT NULL DEFAULT 0,
  residents_per_pharmacy REAL,                -- from this dataset, the gap baseline
  grid_step_km      REAL NOT NULL,
  mask_km           REAL NOT NULL,
  window_km         REAL NOT NULL,
  notes             TEXT
);

-- ---------------------------------------------------------------------------
-- M2. Per-settlement geometry + distances.
--     straight_km / net_km / est_km are all measured FROM the reference city.
--       road_km  : OSRM driving distance (measured, when available)
--       net_km   : Dijkstra over the proximity graph (a lower bound of road)
--       est_km   : net_km * road_calibration, the best estimate when no road
--     `dist_source` says which one the UI must quote.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS map_point (
  area_id       INTEGER PRIMARY KEY REFERENCES admin_area (id) ON DELETE CASCADE,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  coord_source  TEXT NOT NULL,                -- admin | osm
  straight_km   REAL NOT NULL,
  road_km       REAL,
  road_minutes  REAL,
  net_km        REAL,
  est_km        REAL NOT NULL,
  dist_source   TEXT NOT NULL,                -- road | network | straight
  ring_km       INTEGER NOT NULL,             -- lower edge of the distance band
  deg           INTEGER,                      -- graph hops from the reference
  built_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_map_point_ring ON map_point (ring_km, est_km);
CREATE INDEX IF NOT EXISTS ix_map_point_est  ON map_point (est_km);

-- ---------------------------------------------------------------------------
-- M3. Edges of the spanning tree the map draws. Undirected, a < b.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS map_edge (
  a  INTEGER NOT NULL REFERENCES admin_area (id) ON DELETE CASCADE,
  b  INTEGER NOT NULL REFERENCES admin_area (id) ON DELETE CASCADE,
  km REAL NOT NULL,
  PRIMARY KEY (a, b)
);

-- ---------------------------------------------------------------------------
-- M4. Residential density grid. A cell is stored only when a settlement with a
--     population is within `mask_km`, which is what keeps the overlay inside
--     inhabited ground.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS map_density (
  cell_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  population   INTEGER NOT NULL,              -- within window_km
  pharmacies   INTEGER NOT NULL,
  dens         REAL NOT NULL,                 -- pharmacies per 10 000 residents
  gap          REAL NOT NULL,                 -- population / baseline - pharmacies
  nearest_name TEXT,
  county       TEXT,
  dehestan     TEXT,
  nearest_urban TEXT
);
CREATE INDEX IF NOT EXISTS ix_map_density_xy ON map_density (lat, lon);

-- ---------------------------------------------------------------------------
-- M4b. Mapped pharmacies: OSM publishes the POINT of a pharmacy, the FDA feed
--      publishes the COUNT per settlement. Both are kept, never merged: a row
--      here is a pharmacy somebody surveyed on the ground, `nearest_km` says how
--      far it is from the settlement it was matched to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS map_pharmacy (
  osm_type        TEXT NOT NULL,             -- node | way
  osm_id          INTEGER NOT NULL,
  name            TEXT,
  name_en         TEXT,
  lat             REAL NOT NULL,
  lon             REAL NOT NULL,
  nearest_area_id INTEGER REFERENCES admin_area (id) ON DELETE SET NULL,
  nearest_km      REAL,
  county          TEXT,
  street          TEXT,
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX IF NOT EXISTS ix_map_pharmacy_area ON map_pharmacy (nearest_area_id);

-- one row per settlement: how many mapped pharmacies sit within 2 km of it
DROP VIEW IF EXISTS v_map_pharmacy_mapped;
CREATE VIEW v_map_pharmacy_mapped AS
SELECT nearest_area_id AS area_id,
       COUNT(*)       AS n_mapped,
       MIN(nearest_km) AS nearest_km
FROM map_pharmacy
WHERE nearest_area_id IS NOT NULL AND nearest_km <= 3.0
GROUP BY nearest_area_id;

-- ---------------------------------------------------------------------------
-- M5. Live pharmacy aggregate per admin area (FDA layer only).
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_map_pharmacy AS
SELECT l.area_id,
       COALESCE(SUM(s.n_pharmacy_real), 0)  AS pharmacy_real,
       COALESCE(SUM(s.n_pharmacy_legal), 0) AS pharmacy_legal,
       COUNT(*)                             AS n_fda_rows
FROM admin_area_link l
JOIN v_latest_snapshot s ON s.location_id = l.ref_id
WHERE l.layer = 'fda'
GROUP BY l.area_id;

-- ---------------------------------------------------------------------------
-- M6. The map's one read path: geography + live counts + computed distances.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_map_settlement;
CREATE VIEW v_map_settlement AS
SELECT a.area_id,
       a.kind,
       a.name,
       a.county,
       a.bakhsh,
       a.dehestan,
       a.population,
       a.population_year_sh,
       a.population_source,
       a.population_confidence,
       p.lat,
       p.lon,
       p.coord_source,
       COALESCE(ph.pharmacy_real, 0)  AS pharmacy_real,
       COALESCE(ph.pharmacy_legal, 0) AS pharmacy_legal,
       COALESCE(ph.pharmacy_real, 0) + COALESCE(ph.pharmacy_legal, 0) AS pharmacy_total,
       COALESCE(ph.n_fda_rows, 0)     AS n_fda_rows,
       COALESCE(mp.n_mapped, 0)       AS pharmacy_mapped,
       p.straight_km,
       p.road_km,
       p.road_minutes,
       p.net_km,
       p.est_km,
       p.dist_source,
       p.ring_km,
       p.deg
FROM v_admin_area_current a
LEFT JOIN map_point p            ON p.area_id = a.area_id
LEFT JOIN v_map_pharmacy ph      ON ph.area_id = a.area_id
LEFT JOIN v_map_pharmacy_mapped mp ON mp.area_id = a.area_id
WHERE a.kind IN ('city', 'village');
