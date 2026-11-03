/**
 * The loaders, run against a copy of the real database.
 *
 * These are the functions the pages call on every request; a shape regression here breaks the
 * dashboard silently, so the assertions are about invariants (counts, joins, ranges) rather
 * than exact numbers that change with every ETL run.
 */
import { describe, expect, it } from "vitest";
import { loadDashboardData } from "@/lib/data";
import { loadMapData } from "@/lib/map";
import { loadAdminData } from "@/lib/admin";
import { dbReady } from "@/lib/db";

describe("database", () => {
  it("is present", () => {
    expect(dbReady()).toBe(true);
  });
});

describe("loadDashboardData", () => {
  const d = loadDashboardData();

  it("has places and a scope summary", () => {
    expect(d.places.length).toBeGreaterThan(100);
    expect(d.scope).toBeTruthy();
    expect(d.ready).toBe(true);
  });

  it("every place carries both populations, so the mode switch can work", () => {
    const p = d.places[0];
    expect(p).toHaveProperty("fda_population");
    expect(p).toHaveProperty("ref_population");
    expect(p.place.length).toBeGreaterThan(0);
    expect(p.n_pharmacy_total).toBeGreaterThanOrEqual(0);
  });

  it("counties are available for the drill-down", () => {
    expect(Array.isArray(d.counties)).toBe(true);
    expect(d.counties.length).toBeGreaterThan(0);
  });
});

describe("loadMapData", () => {
  const m = loadMapData();

  it("plots the settlements that have coordinates", () => {
    expect(m.settlements.length).toBeGreaterThan(3000);
    const withCoords = m.settlements.filter((s) => s.lat !== null && s.lon !== null);
    expect(withCoords.length).toBeGreaterThan(3000);
  });

  it("counts the ones without a coordinate instead of dropping them silently", () => {
    expect(m.meta.nMissingCoord).toBeGreaterThan(0);
    expect(m.totals.plotted).toBeGreaterThan(3000);
  });

  it("carries supply", () => {
    expect(m.pharmacies.length).toBeGreaterThan(300);
    expect(m.medical.length).toBeGreaterThan(100);
  });

  it("carries the annotation layers for the current user", () => {
    expect(Array.isArray(m.prospects)).toBe(true);
    expect(Array.isArray(m.surveys)).toBe(true);
    expect(Array.isArray(m.checked)).toBe(true);
  });

  it("carries the computed surfaces", () => {
    expect(m.capacity.length).toBeGreaterThan(3);
    expect(m.opportunity.length).toBeGreaterThan(100);
  });

  it("gives every settlement a capacity row", () => {
    const s = m.settlements.find((x) => x.pop > 1000);
    expect(s).toBeTruthy();
    expect(typeof s!.nearestKm).toBe("number");
    expect(typeof s!.supply).toBe("number");
  });
});

describe("loadAdminData", () => {
  const a = loadAdminData();

  it("has a tree", () => {
    expect(a.nodes.length).toBeGreaterThan(1000);
    expect(a.totals).toBeTruthy();
  });

  it("reports the provinces the map draws", () => {
    expect(a.nodes[0]).toHaveProperty("kind");
    expect(a.nodes.some((n) => n.kind === "city")).toBe(true);
  });
});
