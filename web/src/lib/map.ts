/**
 * Server-side loader for the interactive map layer (etl/schema_map.sql).
 *
 * One request reads four things:
 *   v_map_settlement  every شهر/روستا of the administrative layer that has a
 *                     coordinate, with the LIVE pharmacy counts joined in
 *   map_edge          the spanning tree the map draws as the distance network
 *   map_density       the residential-masked density grid
 *   the two GeoJSON   بخش and دهستان polygons, stitched from OSM relations
 *
 * Everything is shipped to the client in one payload: 3.6k points, 3.7k edges,
 * ~2.5k cells and ~250 polygons is a few hundred KB, and it makes the map a
 * single hydration instead of a fetch waterfall. Numbers are pre-rounded here
 * (4 decimals ≈ 11 m) so the payload is not carrying coordinates nobody can
 * use.
 */
import fs from "node:fs";
import path from "node:path";
import { all, one, run } from "./db";
import { currentUser } from "./user";

export type MapSettlement = {
  id: number;
  name: string;
  kind: "city" | "village";
  county: string | null;
  bakhsh: string | null;
  dehestan: string | null;
  pop: number | null;
  popYear: number | null;
  popSource: string | null;
  /** Every source side by side, so a number can be argued with instead of trusted. */
  popAdmin: number | null;
  popWiki: number | null;
  popFda: number | null;
  popOsm: number | null;
  popManual: number | null;
  lat: number;
  lon: number;
  /** Supply we can actually count: the FDA register, or the pharmacies mapped or added by
   *  hand when the register has none for this settlement. Taking the larger is deliberate —
   *  the two count the same shops by different methods, and a hand-added pin exists exactly
   *  because the register missed it. */
  ph: number;
  phReal: number;
  phLegal: number;
  /** Pharmacies mapped in OSM within 3 km of this settlement (a sample, not a total). */
  mapped: number;
  inFda: boolean;
  /** Great-circle km from اهواز. */
  straight: number;
  /** Dijkstra over the settlement graph; null when the node is isolated. */
  net: number | null;
  /** Measured OSRM driving distance, where it exists. */
  road: number | null;
  roadMin: number | null;
  /** The number the UI must quote, and which of the three it is. */
  dist: number;
  distSource: "road" | "network" | "straight" | "reference";
  ring: number;
  deg: number | null;
};

export type MapCell = {
  lat: number;
  lon: number;
  pop: number;
  ph: number;
  /** Pharmacies per 10 000 residents within the 10 km window. */
  dens: number;
  /** population / baseline − pharmacies: positive = undersupplied. */
  gap: number;
  county: string | null;
  dehestan: string | null;
  near: string | null;
  urban: string | null;
};

export type MapShape = {
  /** Stable identity: OSM id, or name+label when the capture has no id. */
  id: string;
  name: string;
  county: string | null;
  bakhsh: string | null;
  area: number;
  /** Label anchor, [lat, lon] as computed in the ETL. */
  label: [number, number];
  /** Rings as [lon, lat] pairs, already simplified. */
  rings: number[][][];
};

/** Public Google Places profile of a mapped pharmacy (competitor analysis). */
function safeJson<T>(v: string | null): T | null {
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export type MapPharmacyProfile = {
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviews: number | null;
  priceLevel: string | null;
  hours: string[];
  /** Photo resource names — the browser asks /api/place-photo for the bytes. */
  photos: string[];
  summary: string | null;
  mapsUri: string | null;
  status: string | null;
};

/** One pharmacy somebody mapped on the ground (OSM `amenity=pharmacy`). */
export type MapPharmacy = {
  id: string;
  /** osm | neshan | google — which provider the point came from. */
  source: string;
  name: string;
  nameEn: string | null;
  /** OSM nodes tagged `amenity=pharmacy` with no name: probably real, certainly unverified. */
  unnamed?: boolean;
  lat: number;
  lon: number;
  /** Distance to the nearest administrative settlement, km. */
  km: number;
  settlement: string | null;
  county: string | null;
  /** id of the settlement it was matched to — the density weighting needs it. */
  areaId: number | null;
  /** null until `etl/enrich_pharmacy_profiles.py` has run for this place. */
  profile: MapPharmacyProfile | null;
};

/** A place prescriptions are written: doctor, clinic, dentist, hospital, lab. */
export type MapMedical = {
  id: number;
  /** `manual` when a person pinned it; the id is then negative. */
  source?: "manual";
  kind: "doctor" | "clinic" | "dentist" | "hospital" | "lab";
  name: string;
  lat: number;
  lon: number;
  km: number;
  address: string | null;
  settlement: string | null;
  county: string | null;
};

export type MapMeta = {
  builtAt: string;
  referenceName: string;
  referenceLat: number;
  referenceLon: number;
  roadCalibration: number | null;
  nRoadSample: number;
  nSettlement: number;
  nPlotted: number;
  nMissingCoord: number;
  nEdge: number;
  residentsPerPharmacy: number;
  gridStepKm: number;
  maskKm: number;
  windowKm: number;
  kNeighbors: number;
  connectKm: number;
  adminImportedAt: string | null;
  /** True when the admin layer was rebuilt after this map layer: rebuild it. */
  stale: boolean;
};

export type MapTotals = {
  provinces: 1;
  counties: number;
  /** Every شهر of the administrative layer, plotted or not. */
  cities: number;
  villages: number;
  plotted: number;
  population: number;
  pharmacies: number;
  withPharmacy: number;
  noPharmacy: number;
  /** Clinics, doctors, dentists, hospitals, labs — the demand side. */
  medical: number;
  /** Pharmacies with a coordinate (the rest of the FDA count has none). */
  mappedPharm: number;
};

export type SiteCandidate = {
  rank: number;
  score: number;
  lat: number;
  lon: number;
  settlement: string | null;
  /** Distance from this point to the settlement it is named after, km. The
      recommendation is a demand cell, not a town centre — saying so avoids
      «the marker is not where the name is». */
  settleKm: number;
  county: string | null;
  demand: number;
  demandKm2: number;
  supplyMapped: number;
  supplyExpected: number;
  anchors: number;
  roadKm: number;
  gap: number;
  reason: string;
  /** Score if a competitor opens next door and the population estimate is off by a fifth. */
  scoreLow: number;
  scoreHigh: number;
};

/** A shortlisted candidate, with the score it had when it was saved. */
export type ShortlistItem = {
  id: number;
  rank: number;
  lat: number;
  lon: number;
  settlement: string | null;
  county: string | null;
  score: number;
  demand: number;
  supplyMapped: number;
  anchors: number;
  roadKm: number;
  gap: number;
  note: string | null;
  snapshotAt: string;
};

/** A place the user wants to stand in front of before signing a lease. */
export type Prospect = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  note: string | null;
  status: "todo" | "visited" | "rejected";
  priority: number;
  visitedAt: string | null;
};

/** A محله: not an administrative unit, so it lives outside `v_map_settlement`. */
export type MapNeighbourhood = {
  osmId: number;
  name: string;
  /** The name people actually use, when it differs from the OSM label. */
  alias: string | null;
  lat: number;
  lon: number;
  city: string | null;
  county: string | null;
  cityKm: number | null;
};

/** A measured polygon: area, how much of it is inhabited, and the people inside. */
export type Measurement = {
  id: number;
  name: string;
  points: [number, number][];
  areaKm2: number;
  residentialKm2: number;
  population: number;
  density: number;
  pharmacies: number;
  cellKm: number;
};

/** A polygon the user has already walked — so the same streets are not surveyed twice. */
export type SurveyArea = {
  id: number;
  name: string;
  note: string | null;
  points: [number, number][];
  areaKm2: number | null;
};

export type MapData = {
  settlements: MapSettlement[];
  /** Ranked places to open a pharmacy (`etl/rank_sites.py`). Empty until it has run. */
  sites: SiteCandidate[];
  /** Places the user is actually comparing; metrics are the ones saved with the row. */
  shortlist: ShortlistItem[];
  /** This user's visit list and the areas they have already surveyed. */
  prospects: Prospect[];
  surveys: SurveyArea[];
  measurements: Measurement[];
  /** Named neighbourhoods (محله) — 312 of them, invisible before this table existed. */
  neighbourhoods: MapNeighbourhood[];
  user: { id: number; displayName: string; role: string };
  /** [index a, index b] into `settlements`. */
  edges: [number, number][];
  cells: MapCell[];
  pharmacies: MapPharmacy[];
  medical: MapMedical[];
  bakhsh: MapShape[];
  dehestan: MapShape[];
  /** Province outline as rings of [lon, lat] — the silhouette stroke. */
  outline: number[][][];
  meta: MapMeta;
  totals: MapTotals;
};

type GeoFeature = {
  properties: {
    osm_id?: number | string;
    name: string;
    county?: string | null;
    bakhsh?: string | null;
    area_km2?: number;
    label_lat: number;
    label_lon: number;
  };
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
};

function readOutline(file: string): number[][][] {
  const full = path.join(process.cwd(), "public", "geo", file);
  const fc = JSON.parse(fs.readFileSync(full, "utf-8")) as {
    features: { geometry: { coordinates: number[][][][] } }[];
  };
  return fc.features.flatMap((f) =>
    f.geometry.coordinates.flatMap((poly) =>
      poly.map((ring) =>
        ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]),
      ),
    ),
  );
}

function readShapes(file: string): MapShape[] {
  const full = path.join(process.cwd(), "public", "geo", file);
  const fc = JSON.parse(fs.readFileSync(full, "utf-8")) as { features: GeoFeature[] };
  return fc.features.map((f) => ({
    // Names repeat («بخش مرکزی» exists once per شهرستان), so the OSM id is the
    // identity; the coordinate fallback keeps a shape addressable even in a
    // capture that predates the id column.
    id: String(
      f.properties.osm_id ??
        `${f.properties.name}@${f.properties.label_lat},${f.properties.label_lon}`,
    ),
    name: f.properties.name,
    county: f.properties.county ?? null,
    bakhsh: f.properties.bakhsh ?? null,
    area: f.properties.area_km2 ?? 0,
    label: [f.properties.label_lat, f.properties.label_lon] as [number, number],
    // polygons are flattened to one ring list: the map fills each ring, and a
    // hole just draws as a ring of its own
    rings: f.geometry.coordinates.flatMap((poly) =>
      poly.map((ring) =>
        ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]),
      ),
    ),
  }));
}

/** The table exists from the first hand-added pin; the loader may run before the
    API ever does, so it creates it here too rather than failing the whole page. */
function ensureManualTable(): void {
  run(`CREATE TABLE IF NOT EXISTS manual_place (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL DEFAULT 'pharmacy',
    name            TEXT NOT NULL,
    lat             REAL NOT NULL,
    lon             REAL NOT NULL,
    address         TEXT,
    phone           TEXT,
    note            TEXT,
    nearest_area_id INTEGER,
    nearest_km      REAL,
    county          TEXT,
    created_at      TEXT NOT NULL
  )`);
  /* rows written before `kind` existed were all pharmacies */
  const legacy = one<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manual_pharmacy'",
  );
  if (legacy) {
    run(`INSERT INTO manual_place
           (id, kind, name, lat, lon, address, phone, note,
            nearest_area_id, nearest_km, county, created_at)
         SELECT id, 'pharmacy', name, lat, lon, address, phone, note,
                nearest_area_id, nearest_km, county, created_at
           FROM manual_pharmacy`);
    run("DROP TABLE manual_pharmacy");
  }
}

export function loadMapData(): MapData {
  const rows = all<{
    area_id: number;
    kind: "city" | "village";
    name: string;
    county: string | null;
    bakhsh: string | null;
    dehestan: string | null;
    population: number | null;
    population_year_sh: number | null;
    population_source: string | null;
    population_admin: number | null;
    population_wiki: number | null;
    population_fda: number | null;
    population_osm: number | null;
    population_manual: number | null;
    lat: number;
    lon: number;
    pharmacy_real: number;
    pharmacy_legal: number;
    pharmacy_total: number;
    n_fda_rows: number;
    pharmacy_mapped: number;
    pharmacy_assigned: number;
    straight_km: number;
    net_km: number | null;
    road_km: number | null;
    road_minutes: number | null;
    est_km: number;
    dist_source: "road" | "network" | "straight" | "reference";
    ring_km: number;
    deg: number | null;
  }>(`
    SELECT area_id, kind, name, county, bakhsh, dehestan, population,
           population_year_sh, population_source, lat, lon,
           population_admin, population_wiki, population_fda, population_osm, population_manual,
           pharmacy_real, pharmacy_legal, pharmacy_total, n_fda_rows, pharmacy_mapped,
           pharmacy_assigned,
           straight_km, net_km, road_km, road_minutes, est_km, dist_source,
           ring_km, deg
    FROM v_map_settlement
    WHERE lat IS NOT NULL
    ORDER BY (population IS NULL), population DESC, name
  `);

  // 4 decimals ≈ 11 m and 1 decimal km are all the map can resolve; carrying
  // full float precision for 3.6k rows is ~400 KB of noise in the payload.
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const r1 = (v: number) => Math.round(v * 10) / 10;

  const settlements: MapSettlement[] = rows.map((r) => ({
    id: r.area_id,
    name: r.name,
    kind: r.kind,
    county: r.county,
    bakhsh: r.bakhsh,
    dehestan: r.dehestan,
    pop: r.population,
    popYear: r.population_year_sh,
    popSource: r.population_source,
    popAdmin: r.population_admin,
    popWiki: r.population_wiki,
    popFda: r.population_fda,
    popOsm: r.population_osm,
    popManual: r.population_manual,
    lat: r4(r.lat),
    lon: r4(r.lon),
    ph: Math.max(r.pharmacy_total, r.pharmacy_assigned),
    phReal: r.pharmacy_real,
    phLegal: r.pharmacy_legal,
    mapped: r.pharmacy_mapped,
    inFda: r.n_fda_rows > 0,
    straight: r1(r.straight_km),
    net: r.net_km === null ? null : r1(r.net_km),
    road: r.road_km === null ? null : r1(r.road_km),
    roadMin: r.road_minutes === null ? null : r1(r.road_minutes),
    dist: r1(r.est_km),
    distSource: r.dist_source,
    ring: r.ring_km,
    deg: r.deg,
  }));

  const index = new Map<number, number>();
  settlements.forEach((s, i) => index.set(s.id, i));
  const edges: [number, number][] = [];
  for (const e of all<{ a: number; b: number }>("SELECT a, b FROM map_edge")) {
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i !== undefined && j !== undefined) edges.push([i, j]);
  }

  const cells: MapCell[] = all<{
    lat: number;
    lon: number;
    population: number;
    pharmacies: number;
    dens: number;
    gap: number;
    county: string | null;
    dehestan: string | null;
    nearest_name: string | null;
    nearest_urban: string | null;
  }>(`
    SELECT lat, lon, population, pharmacies, dens, gap, county, dehestan,
           nearest_name, nearest_urban
    FROM map_density
    ORDER BY lat, lon
  `).map((c) => ({
    lat: c.lat,
    lon: c.lon,
    pop: c.population,
    ph: c.pharmacies,
    dens: c.dens,
    gap: c.gap,
    county: c.county,
    dehestan: c.dehestan,
    near: c.nearest_name,
    urban: c.nearest_urban,
  }));

  ensureManualTable();
  /* Ranked candidates. The table is written by the ETL, so a fresh clone without it
     still renders: an empty list means «no recommendation», not a broken map. */
  let sites: SiteCandidate[] = [];
  try {
    sites = all<{
      rank: number; score: number; lat: number; lon: number; settlement: string | null;
      settle_km: number; county: string | null; demand: number; demand_km2: number; supply_mapped: number;
      supply_expected: number; anchors: number; road_km: number; gap: number; reason: string;
      score_low: number | null; score_high: number | null;
    }>(
      `SELECT rank, score, lat, lon, settlement, settle_km, county, demand, demand_km2,
              supply_mapped, supply_expected, anchors, road_km, gap, reason,
              score_low, score_high
         FROM site_candidate ORDER BY rank`,
    ).map((r) => ({
      rank: r.rank, score: r.score, lat: r.lat, lon: r.lon,
      settlement: r.settlement, settleKm: r.settle_km ?? 0, county: r.county, demand: r.demand,
      demandKm2: r.demand_km2, supplyMapped: r.supply_mapped,
      supplyExpected: r.supply_expected, anchors: r.anchors, roadKm: r.road_km,
      gap: r.gap, reason: r.reason,
    scoreLow: r.score_low ?? r.score, scoreHigh: r.score_high ?? r.score,
    }));
  } catch {
    sites = [];
  }

  const pharmacies: MapPharmacy[] = all<{
    osm_type: string;
    osm_id: number;
    source: string;
    name: string | null;
    name_en: string | null;
    lat: number;
    lon: number;
    nearest_km: number | null;
    settlement: string | null;
    county: string | null;
    area_id: number | null;
    address: string | null;
    phone: string | null;
    website: string | null;
    rating: number | null;
    reviews: number | null;
    price_level: string | null;
    hours_json: string | null;
    photos_json: string | null;
    summary: string | null;
    maps_uri: string | null;
    status: string | null;
  }>(`
    SELECT p.osm_type, p.osm_id, p.source, p.name, p.name_en, p.lat, p.lon,
           p.nearest_km, a.name AS settlement, p.county, p.nearest_area_id AS area_id,
           f.address, f.phone, f.website, f.rating, f.reviews, f.price_level,
           f.hours_json, f.photos_json, f.summary, f.maps_uri, f.status
    FROM map_pharmacy p
    LEFT JOIN admin_area a ON a.id = p.nearest_area_id
    LEFT JOIN pharmacy_profile f
           ON f.external_id = p.external_id AND f.source = p.source
    /* Hand-added pins live in their own table so a rebuild cannot delete them; the
       map treats them like any other pharmacy, with source='manual'. */
    UNION ALL
    SELECT 'manual' AS osm_type, m.id AS osm_id, 'manual' AS source, m.name,
           NULL AS name_en, m.lat, m.lon, COALESCE(m.nearest_km, 0) AS nearest_km,
           a2.name AS settlement, m.county, m.nearest_area_id AS area_id,
           m.address, m.phone, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM manual_place m
    LEFT JOIN admin_area a2 ON a2.id = m.nearest_area_id
    WHERE m.kind = 'pharmacy' 
    ORDER BY 1, 2
  `).map((p) => ({
    id: `${p.osm_type}/${p.osm_id}`,
    source: p.source ?? p.osm_type,
    name: p.name ?? "داروخانه بدون نام",
    unnamed: !p.name,
    nameEn: p.name_en,
    lat: Math.round(p.lat * 1e4) / 1e4,
    lon: Math.round(p.lon * 1e4) / 1e4,
    km: p.nearest_km ?? 0,
    settlement: p.settlement,
    county: p.county,
    areaId: p.area_id,
    profile: p.rating === null && p.website === null && p.phone === null
      ? null
      : {
          address: p.address,
          phone: p.phone,
          website: p.website,
          rating: p.rating,
          reviews: p.reviews,
          priceLevel: p.price_level,
          hours: safeJson<string[]>(p.hours_json) ?? [],
          photos: safeJson<{ name: string }[]>(p.photos_json)?.map((x) => x.name) ?? [],
          summary: p.summary,
          mapsUri: p.maps_uri,
          status: p.status,
        },
  }));

  const medical: MapMedical[] = all<{
    id: number;
    kind: MapMedical["kind"];
    name: string;
    lat: number;
    lon: number;
    nearest_km: number | null;
    settlement: string | null;
    county: string | null;
    address: string | null;
  }>(`
    SELECT m.id, m.kind, m.name, m.lat, m.lon, m.nearest_km, m.address, m.county,
           a.name AS settlement
    FROM map_medical m
    LEFT JOIN admin_area a ON a.id = m.nearest_area_id
    UNION ALL
    /* Hand-added clinics, labs, dentists… Negative ids: map_medical owns the positive ones,
       and the panel needs a stable key that cannot collide with an imported row. */
    SELECT -m.id AS id, m.kind, m.name, m.lat, m.lon,
           COALESCE(m.nearest_km, 0) AS nearest_km, m.address, m.county, a3.name AS settlement
      FROM manual_place m
      LEFT JOIN admin_area a3 ON a3.id = m.nearest_area_id
     WHERE m.kind <> 'pharmacy'
    ORDER BY 2, 3
  `).map((m) => ({
    id: m.id,
    source: m.id < 0 ? ("manual" as const) : undefined,
    kind: m.kind,
    name: m.name,
    lat: Math.round(m.lat * 1e4) / 1e4,
    lon: Math.round(m.lon * 1e4) / 1e4,
    km: m.nearest_km ?? 0,
    address: m.address,
    settlement: m.settlement,
    county: m.county,
  }));

  run(`CREATE TABLE IF NOT EXISTS shortlist (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    rank          INTEGER NOT NULL,
    lat           REAL NOT NULL,
    lon           REAL NOT NULL,
    settlement    TEXT,
    county        TEXT,
    score         REAL NOT NULL,
    demand        REAL NOT NULL,
    supply_mapped REAL NOT NULL,
    anchors       REAL NOT NULL,
    road_km       REAL NOT NULL,
    gap           REAL NOT NULL,
    note          TEXT,
    snapshot_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const shortlist: ShortlistItem[] = all<{
    id: number; rank: number; lat: number; lon: number; settlement: string | null;
    county: string | null; score: number; demand: number; supplyMapped: number; anchors: number;
    roadKm: number; gap: number; note: string | null; snapshotAt: string;
  }>(`SELECT id, rank, lat, lon, settlement, county, score, demand,
             supply_mapped AS supplyMapped, anchors, road_km AS roadKm, gap,
             note, snapshot_at AS snapshotAt
        FROM shortlist ORDER BY id DESC`).map((r) => ({
    ...r,
    lat: Math.round(r.lat * 1e4) / 1e4,
    lon: Math.round(r.lon * 1e4) / 1e4,
  }));

  const user = currentUser();
  run(`CREATE TABLE IF NOT EXISTS prospect (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    lat REAL NOT NULL, lon REAL NOT NULL, note TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    visited_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  run(`CREATE TABLE IF NOT EXISTS survey_area (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    note TEXT, points TEXT NOT NULL, area_km2 REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  const prospects: Prospect[] = all<{
    id: number; name: string; lat: number; lon: number; note: string | null;
    status: Prospect["status"]; priority: number; visitedAt: string | null;
  }>(`SELECT id, name, lat, lon, note, status, priority, visited_at AS visitedAt
        FROM prospect WHERE user_id = ? ORDER BY priority, id DESC`, [user.id])
    .map((r) => ({ ...r, lat: Math.round(r.lat * 1e4) / 1e4, lon: Math.round(r.lon * 1e4) / 1e4 }));

  const surveys: SurveyArea[] = all<{
    id: number; name: string; note: string | null; points: string; areaKm2: number | null;
  }>(`SELECT id, name, note, points, area_km2 AS areaKm2 FROM survey_area
        WHERE user_id = ? ORDER BY id DESC`, [user.id])
    .map((r) => ({ ...r, points: JSON.parse(r.points) as [number, number][] }));

  run(`CREATE TABLE IF NOT EXISTS measurement (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    points TEXT NOT NULL, area_km2 REAL NOT NULL, residential_km2 REAL NOT NULL,
    population INTEGER NOT NULL, density INTEGER NOT NULL, pharmacies INTEGER NOT NULL,
    cell_km REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  const measurements: Measurement[] = all<{
    id: number; name: string; points: string; areaKm2: number; residentialKm2: number;
    population: number; density: number; pharmacies: number; cellKm: number;
  }>(`SELECT id, name, points, area_km2 AS areaKm2, residential_km2 AS residentialKm2,
             population, density, pharmacies, cell_km AS cellKm
        FROM measurement WHERE user_id = ? ORDER BY id DESC`, [user.id])
    .map((r) => ({ ...r, points: JSON.parse(r.points) as [number, number][] }));

  run(`CREATE TABLE IF NOT EXISTS map_neighbourhood (
    osm_id INTEGER PRIMARY KEY, name TEXT NOT NULL, alias TEXT, lat REAL NOT NULL,
    lon REAL NOT NULL, city TEXT, county TEXT, city_km REAL, place TEXT)`);
  const neighbourhoods: MapNeighbourhood[] = all<{
    osmId: number; name: string; alias: string | null; lat: number; lon: number;
    city: string | null; county: string | null; cityKm: number | null;
  }>(`SELECT osm_id AS osmId, name, alias, lat, lon, city, county, city_km AS cityKm
        FROM map_neighbourhood ORDER BY name`).map((r) => ({
    ...r,
    lat: Math.round(r.lat * 1e4) / 1e4,
    lon: Math.round(r.lon * 1e4) / 1e4,
  }));

  const imp = one<{
    built_at: string;
    reference_name: string;
    reference_lat: number;
    reference_lon: number;
    road_calibration: number | null;
    n_road_sample: number;
    n_settlement: number;
    n_plotted: number;
    n_edge: number;
    residents_per_pharmacy: number;
    grid_step_km: number;
    mask_km: number;
    window_km: number;
    k_neighbors: number;
    connect_km: number;
  }>("SELECT * FROM map_import");

  const missing = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM v_map_settlement WHERE lat IS NULL",
  );
  const adminAt = one<{ imported_at: string }>(
    "SELECT imported_at FROM admin_import ORDER BY id DESC LIMIT 1",
  );

  const meta: MapMeta = {
    builtAt: imp?.built_at ?? "",
    referenceName: imp?.reference_name ?? "اهواز",
    referenceLat: imp?.reference_lat ?? 31.32,
    referenceLon: imp?.reference_lon ?? 48.67,
    roadCalibration: imp?.road_calibration ?? null,
    nRoadSample: imp?.n_road_sample ?? 0,
    nSettlement: imp?.n_settlement ?? settlements.length,
    nPlotted: imp?.n_plotted ?? settlements.length,
    nMissingCoord: missing?.n ?? 0,
    nEdge: imp?.n_edge ?? edges.length,
    residentsPerPharmacy: imp?.residents_per_pharmacy ?? 5000,
    gridStepKm: imp?.grid_step_km ?? 3.3,
    maskKm: imp?.mask_km ?? 2.5,
    windowKm: imp?.window_km ?? 10,
    kNeighbors: imp?.k_neighbors ?? 5,
    connectKm: imp?.connect_km ?? 10,
    adminImportedAt: adminAt?.imported_at ?? null,
    stale: !!(adminAt && imp && adminAt.imported_at > imp.built_at),
  };

  // headline counts cover the WHOLE administrative layer, not just the plotted
  // subset — the page must not claim 87 cities when the tree has 100.
  const agg = one<{
    n: number;
    plotted: number;
    cities: number;
    villages: number;
    counties: number;
    population: number;
    pharmacies: number;
    with_ph: number;
  }>(`
    SELECT COUNT(*) AS n,
           SUM(lat IS NOT NULL) AS plotted,
           SUM(kind = 'city') AS cities,
           SUM(kind = 'village') AS villages,
           COUNT(DISTINCT county) AS counties,
           SUM(COALESCE(population, 0)) AS population,
           SUM(pharmacy_total) AS pharmacies,
           SUM(pharmacy_total > 0) AS with_ph
    FROM v_map_settlement
  `);
  // the county count comes from the administrative tree, not from the plotted
  // settlements: a county whose rows carry no coordinate still exists
  const nCounties = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM admin_area WHERE kind = 'county'",
  );
  const totals: MapTotals = {
    provinces: 1,
    counties: nCounties?.n ?? agg?.counties ?? 0,
    cities: agg?.cities ?? 0,
    villages: agg?.villages ?? 0,
    plotted: agg?.plotted ?? settlements.length,
    population: agg?.population ?? 0,
    pharmacies: agg?.pharmacies ?? 0,
    withPharmacy: agg?.with_ph ?? 0,
    noPharmacy: (agg?.n ?? 0) - (agg?.with_ph ?? 0),
    medical: medical.length,
    mappedPharm: pharmacies.length,
  };

  return {
    settlements,
    sites,
    shortlist,
    prospects,
    surveys,
    measurements,
    neighbourhoods,
    user: { id: user.id, displayName: user.displayName, role: user.role },
    edges,
    cells,
    pharmacies,
    medical,
    bakhsh: readShapes("khuzestan_bakhsh_areas.geojson"),
    dehestan: readShapes("khuzestan_dehestan_areas.geojson"),
    outline: readOutline("khuzestan_outline.geojson"),
    meta,
    totals,
  };
}
