/**
 * What is left for another pharmacy, and how much of the land is already served.
 *
 * `service_metric` (etl/compute_capacity.py) holds the province-wide numbers: how much of the
 * built-up area falls within 1.5 km of a pharmacy, how much population that is, and how many
 * pharmacies are already above capacity. `settlement_service` holds the same per settlement.
 *
 *   GET  ?benchmark=5408        → metrics + the settlements with the most spare capacity
 *   POST { benchmark }          → recompute capacity at a different residents-per-pharmacy
 *
 * The benchmark is a *policy* dial, not a measurement: at 5,408 residents per pharmacy the
 * register says we are at the provincial ratio; at 8,000 the map says where we could stop.
 */
import { NextResponse } from "next/server";
import { all, run } from "@/lib/db";

const DEFAULT_BENCHMARK = 5408;

function metrics(): { key: string; value: number; note: string }[] {
  return all<{ key: string; value: number; note: string }>(
    "SELECT key, value, note FROM service_metric ORDER BY rowid",
  );
}

function top(limit = 12) {
  return all<{
    area_id: number; name: string; kind: string; population: number;
    nearest_km: number | null; pharmacies_1500: number; density: number | null;
    supply: number; capacity: number; remaining: number;
  }>(
    `SELECT area_id, name, kind, population, nearest_km, pharmacies_1500, density,
            supply, capacity, remaining
       FROM v_settlement_capacity
      WHERE population > 0 AND remaining IS NOT NULL
      ORDER BY remaining DESC
      LIMIT ?`,
    [limit],
  );
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return NextResponse.json({
    metrics: metrics(),
    benchmark: Number(q.get("benchmark")) || DEFAULT_BENCHMARK,
    room: top(),
    short: all<{ area_id: number; name: string; population: number; supply: number;
      capacity: number; remaining: number }>(
      `SELECT area_id, name, population, supply, capacity, remaining
         FROM v_settlement_capacity
        WHERE population > 0 AND remaining < 0
        ORDER BY remaining ASC LIMIT 12`,
    ),
    unknown: all<{ area_id: number; name: string; population: number; supply: number }>(
      `SELECT area_id, name, population, supply
         FROM v_settlement_capacity
        WHERE population > 5000 AND supply_known = 0
        ORDER BY population DESC LIMIT 8`,
    ),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { benchmark?: number };
  const benchmark = Math.round(Number(body.benchmark));
  if (!Number.isFinite(benchmark) || benchmark < 500 || benchmark > 50000) {
    return NextResponse.json({ error: "ظرفیت باید بین ۵۰۰ و ۵۰٬۰۰۰ نفر باشد" }, { status: 400 });
  }
  /* capacity per settlement is `benchmark x pharmacies within 3 km`, not one pharmacy */
  run(`UPDATE settlement_service SET
             capacity  = CAST(ROUND(? * supply) AS INTEGER),
             remaining = CASE WHEN supply_known = 0 THEN NULL ELSE
                           (SELECT CAST(ROUND(v.population) AS INTEGER)
                              FROM v_map_settlement v WHERE v.area_id = settlement_service.area_id)
                           - CAST(ROUND(? * supply) AS INTEGER) END`,
      [benchmark, benchmark]);
  run("UPDATE pharmacy_catchment SET capacity = ?, remaining = ? - catchment, saturated = catchment > ?",
      [benchmark, benchmark, benchmark]);
  run("UPDATE service_metric SET value = ? WHERE key = 'benchmark'", [benchmark]);
  run(`UPDATE service_metric SET value = (SELECT COUNT(*) FROM pharmacy_catchment WHERE saturated = 1)
        WHERE key = 'saturated_count'`);
  return NextResponse.json({ ok: true, benchmark, metrics: metrics() });
}
