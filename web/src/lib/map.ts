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
import { all, one } from "./db";

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
  lat: number;
  lon: number;
  /** Real + legal pharmacies of the linked FDA row(s): 0 means "not in the feed". */
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
};

export type MapData = {
  settlements: MapSettlement[];
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
    lat: number;
    lon: number;
    pharmacy_real: number;
    pharmacy_legal: number;
    pharmacy_total: number;
    n_fda_rows: number;
    pharmacy_mapped: number;
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
           pharmacy_real, pharmacy_legal, pharmacy_total, n_fda_rows, pharmacy_mapped,
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
    lat: r4(r.lat),
    lon: r4(r.lon),
    ph: r.pharmacy_total,
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
    ORDER BY p.osm_type, p.osm_id
  `).map((p) => ({
    id: `${p.osm_type}/${p.osm_id}`,
    source: p.source ?? p.osm_type,
    name: p.name ?? "داروخانه (بینام)",
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
    ORDER BY m.kind, m.name
  `).map((m) => ({
    id: m.id,
    kind: m.kind,
    name: m.name,
    lat: Math.round(m.lat * 1e4) / 1e4,
    lon: Math.round(m.lon * 1e4) / 1e4,
    km: m.nearest_km ?? 0,
    address: m.address,
    settlement: m.settlement,
    county: m.county,
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
  };

  return {
    settlements,
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
