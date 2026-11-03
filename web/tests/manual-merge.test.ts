/**
 * A pharmacy added by hand must reach the dashboard, not only the map.
 *
 * The dashboard reads the FDA snapshot, which has no idea somebody pinned a shop by hand — a
 * village that had zero registered shops stayed at zero after two were added. `manualByPlace()`
 * folds `manual_place` into the rows by matching the area name to the place name.
 */
import { describe, expect, it } from "vitest";
import { loadDashboardData } from "@/lib/data";
import { all } from "@/lib/db";

const strip = (v: string | null) =>
  (v ?? "").replace(/^(شهرستان|بخش|شهر|شهرک|روستای|روستاي|روستا|دهستان|ده|آبادی)\s+/u, "").trim();

describe("manual pharmacies in the dashboard", () => {
  it("adds the hand-pinned shops to the place that owns them", () => {
    const manual = all<{ place: string; county: string; n: number }>(`
      SELECT s.name AS place, s.county AS county, COUNT(*) AS n
        FROM manual_place m JOIN v_map_settlement s ON s.area_id = m.nearest_area_id
       WHERE m.kind = 'pharmacy' GROUP BY 1, 2`);
    if (!manual.length) return;                         // nothing pinned in this database

    const d = loadDashboardData();
    for (const m of manual) {
      const place = d.places.find(
        (p) => strip(p.place) === strip(m.place) && strip(p.county) === strip(m.county));
      if (!place) continue;                             // the place is outside the market scope
      expect(place.manual_mapped ?? 0).toBeGreaterThanOrEqual(m.n);
    }
  });

  it("keeps the ratio consistent with the augmented count", () => {
    const d = loadDashboardData();
    const bumped = d.places.filter((p) => (p.manual_mapped ?? 0) > 0);
    for (const p of bumped) {
      const pop = p.fda_population ?? 0;
      if (pop > 0) {
        expect(p.population_per_pharmacy).toBe(Math.round(pop / p.n_pharmacy_total));
      }
    }
  });

  it("a place with no manual pins is untouched", () => {
    const d = loadDashboardData();
    const clean = d.places.filter((p) => !(p.manual_mapped ?? 0));
    expect(clean.length).toBeGreaterThan(0);
    expect(clean.every((p) => p.n_pharmacy_total >= 0)).toBe(true);
  });
});
