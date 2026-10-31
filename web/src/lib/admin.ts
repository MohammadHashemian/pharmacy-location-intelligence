/**
 * Read-only access to the administrative layer (etl/schema_admin.sql).
 *
 * The whole tree is ~5,900 rows, so it is loaded once per request and shipped to
 * the client as a flat array; the explorer rebuilds the hierarchy in the browser.
 * That keeps expansion instant (no round-trip per click) and still reflects a
 * fresh `python etl/load_admin.py` on the next request.
 */
import { all, one } from "./db";

export type AdminKind = "county" | "bakhsh" | "dehestan" | "city" | "village";

export type AdminNode = {
  id: number;
  parent: number | null;
  kind: AdminKind;
  name: string;
  county: string | null;
  bakhsh: string | null;
  dehestan: string | null;
  population: number | null;
  year: number | null;
  source: string | null;
  /** Real + legal pharmacies of the FDA row this place is linked to, if any. */
  pharmacyReal: number;
  pharmacyLegal: number;
  /** True when the FDA feed (or OSM) knows this place at all. */
  inFda: boolean;
  /** Every population figure we hold, with its source and census year. */
  populations: { source: string; population: number; year: number | null }[];
};

export type AdminTotals = {
  county: number;
  bakhsh: number;
  dehestan: number;
  city: number;
  village: number;
  withPopulation: number;
  withPharmacy: number;
};

export type AdminData = {
  nodes: AdminNode[];
  totals: AdminTotals;
  importedAt: string | null;
  builtAt: string;
};

export const SOURCE_LABEL: Record<string, string> = {
  "fa.wikipedia-county-table": "ویکی‌پدیا › جدول شهرستان",
  "fa.wikipedia-census-sentence": "ویکی‌پدیا › متن سرشماری",
  "fa.wikipedia-infobox": "ویکی‌پدیا › جعبه اطلاعات",
  wikidata: "ویکی‌داده (P1082)",
  "fda-feed": "فید سازمان غذا و دارو",
  "osm-tag": "OpenStreetMap",
};

export function loadAdminData(): AdminData {
  const rows = all<{
    area_id: number;
    parent_area_id: number | null;
    kind: AdminKind;
    name: string;
    county: string | null;
    bakhsh: string | null;
    dehestan: string | null;
    population: number | null;
    population_year_sh: number | null;
    population_source: string | null;
  }>(`
    SELECT area_id, parent_area_id, kind, name, county, bakhsh, dehestan,
           population, population_year_sh, population_source
    FROM v_admin_area_current
    WHERE kind <> 'province'
    ORDER BY county, bakhsh, dehestan, kind DESC, population DESC, name
  `);

  const pharmacy = new Map<number, { real: number; legal: number }>();
  for (const r of all<{ area_id: number; real: number; legal: number }>(`
    SELECT l.area_id,
           COALESCE(SUM(s.n_pharmacy_real), 0)  AS real,
           COALESCE(SUM(s.n_pharmacy_legal), 0) AS legal
    FROM admin_area_link l
    JOIN v_latest_snapshot s ON s.location_id = l.ref_id
    WHERE l.layer = 'fda'
    GROUP BY l.area_id
  `)) {
    pharmacy.set(r.area_id, { real: r.real, legal: r.legal });
  }

  const inFda = new Set(
    all<{ area_id: number }>(
      `SELECT DISTINCT area_id FROM admin_area_link WHERE layer = 'fda'`,
    ).map((r) => r.area_id),
  );

  const pops = new Map<
    number,
    { source: string; population: number; year: number | null }[]
  >();
  for (const p of all<{
    area_id: number;
    source: string;
    population: number;
    year_sh: number | null;
  }>(`
    SELECT area_id, source, population, year_sh
    FROM admin_population
    WHERE valid_to IS NULL AND population IS NOT NULL
    ORDER BY area_id, population DESC
  `)) {
    const list = pops.get(p.area_id) ?? [];
    list.push({ source: p.source, population: p.population, year: p.year_sh });
    pops.set(p.area_id, list);
  }

  const nodes: AdminNode[] = rows.map((r) => {
    const ph = pharmacy.get(r.area_id);
    return {
      id: r.area_id,
      parent: r.parent_area_id,
      kind: r.kind,
      name: r.name,
      county: r.county,
      bakhsh: r.bakhsh,
      dehestan: r.dehestan,
      population: r.population,
      year: r.population_year_sh,
      source: r.population_source,
      pharmacyReal: ph?.real ?? 0,
      pharmacyLegal: ph?.legal ?? 0,
      inFda: inFda.has(r.area_id),
      populations: pops.get(r.area_id) ?? [],
    };
  });

  const count = (k: AdminKind) => nodes.filter((n) => n.kind === k).length;
  const totals: AdminTotals = {
    county: count("county"),
    bakhsh: count("bakhsh"),
    dehestan: count("dehestan"),
    city: count("city"),
    village: count("village"),
    withPopulation: nodes.filter(
      (n) => (n.kind === "city" || n.kind === "village") && n.population,
    ).length,
    withPharmacy: nodes.filter(
      (n) => n.pharmacyReal + n.pharmacyLegal > 0,
    ).length,
  };

  const last = one<{ imported_at: string }>(
    `SELECT imported_at FROM admin_import ORDER BY id DESC LIMIT 1`,
  );

  return {
    nodes,
    totals,
    importedAt: last?.imported_at ?? null,
    builtAt: new Date().toISOString(),
  };
}
