/**
 * Fine density cells for the current viewport — 200 m squares, residents per pharmacy within
 * an 800 m walk.
 *
 * The map asks for a box, not for the province: 80,000 cells in one payload would double the
 * page weight to draw a corner of it, and every pan would re-download the same rows.
 *
 *   GET ?bbox=lat0,lon0,lat1,lon1[&limit=12000]
 *     → { cells: [[lat, lon, ratio, ph800, unserved], …], step: 0.002, benchmark }
 */
import { NextResponse } from "next/server";
import { all, one } from "@/lib/db";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const box = (q.get("bbox") ?? "").split(",").map(Number);
  const limit = Math.min(20000, Number(q.get("limit")) || 12000);
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) {
    return NextResponse.json({ error: "bbox لازم است: lat0,lon0,lat1,lon1" }, { status: 400 });
  }
  const [lat0, lon0, lat1, lon1] = box;
  const rows = all<{ lat: number; lon: number; ratio: number; ph_800: number; unserved: number }>(
    `SELECT lat, lon, ratio, ph_800, unserved FROM density_cell
      WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
      ORDER BY ratio DESC LIMIT ?`,
    [Math.min(lat0, lat1), Math.max(lat0, lat1),
     Math.min(lon0, lon1), Math.max(lon0, lon1), limit],
  );
  const bench = one<{ value: number }>(
    "SELECT value FROM service_metric WHERE key = 'benchmark'",
  );
  return NextResponse.json({
    step: 0.002,
    benchmark: bench?.value ?? 5408,
    total: rows.length,
    cells: rows.map((r) => [r.lat, r.lon, r.ratio, r.ph_800, r.unserved]),
  });
}
