/**
 * Measure a drawn area: how big is it, how much of it is residential, and how many people
 * live inside.
 *
 * The population comes from the same surfaces the map already trusts:
 *   - `urban_pop.json`  0.25 km cells for the 86 cities that were built up cell by cell;
 *   - `pop_province.json` 0.5 km cells for the rest of the province.
 * The finer surface wins wherever it has cells in the polygon, so a neighbourhood in اهواز
 * is not measured with half-kilometre cells.
 *
 *   POST { points, name? }  → metrics, and stores them when `name` is given
 *   GET                     → this user's saved measurements (for comparison)
 *   DELETE ?id=<id>
 *
 * Honest about its method: population is the sum of cell centres inside the polygon, and
 * «residential area» is the area of the cells that carry population — not a cadastral
 * residential boundary.
 */
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { all, one, run } from "@/lib/db";
import { currentUser } from "@/lib/user";

const GEO = path.join(process.cwd(), "public", "geo");
type Cell = { lat: number; lon: number; pop: number; km: number };

let fine: Cell[] | null = null;
let coarse: Cell[] | null = null;

function loadCells(): { fine: Cell[]; coarse: Cell[] } {
  if (!fine) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(GEO, "urban_pop.json"), "utf8")) as {
        cell_km: number; cells: [number, number, number, number][];
      };
      fine = j.cells.map((c) => ({ lat: c[0], lon: c[1], pop: c[2], km: j.cell_km }));
    } catch {
      fine = [];
    }
  }
  if (!coarse) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(GEO, "pop_province.json"), "utf8")) as {
        cell_km: number; cells: [number, number, number][];
      };
      coarse = j.cells.map((c) => ({ lat: c[0], lon: c[1], pop: c[2], km: j.cell_km }));
    } catch {
      coarse = [];
    }
  }
  return { fine, coarse };
}

const R = 6371.0088;              // km

/** Spherical polygon area (km²) — exact enough for a neighbourhood, no projection needed. */
function polygonKm2(pts: [number, number][]): number {
  if (pts.length < 3) return 0;
  const rad = Math.PI / 180;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [lat1, lon1] = pts[i];
    const [lat2, lon2] = pts[(i + 1) % pts.length];
    sum += (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return Math.abs((sum * R * R) / 2);
}

function inside(lat: number, lon: number, pts: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i];
    const [yj, xj] = pts[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

type Metrics = {
  areaKm2: number;
  residentialKm2: number;
  population: number;
  density: number;
  pharmacies: number;
  cells: number;
  cellKm: number;
  method: string;
};

function measure(points: [number, number][]): Metrics {
  const areaKm2 = polygonKm2(points);
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const box = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];

  const { fine: fineCells, coarse: coarseCells } = loadCells();
  const inBox = (c: Cell) =>
    c.lat >= box[0] - 0.01 && c.lat <= box[2] + 0.01 &&
    c.lon >= box[1] - 0.01 && c.lon <= box[3] + 0.01;

  const fineHere = fineCells.filter(inBox).filter((c) => inside(c.lat, c.lon, points));
  const useFine = fineHere.length >= 2;
  const cells = useFine
    ? fineHere
    : coarseCells.filter(inBox).filter((c) => inside(c.lat, c.lon, points));

  const cellKm = useFine ? 0.25 : 0.5;
  const population = cells.reduce((s, c) => s + (c.pop || 0), 0);

  /* The population cells are not a regular lattice (they follow built-up discs), so
     «cells × cell area» overstated the residential footprint — a 1 km² box came out as
     3.75 km². Instead sample a 100 m lattice and ask whether the nearest cell carries
     population: that is a footprint, not a count. */
  const STEP = 0.0009;                        // ≈100 m
  const grid = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${Math.floor(c.lat / 0.01)}:${Math.floor(c.lon / 0.01)}`;
    const list = grid.get(k);
    if (list) list.push(c);
    else grid.set(k, [c]);
  }
  const nearest = (la: number, lo: number): { cell: Cell | null; km: number } => {
    let best: Cell | null = null;
    let bestD = Infinity;
    const ki = Math.floor(la / 0.01);
    const kj = Math.floor(lo / 0.01);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const c of grid.get(`${ki + a}:${kj + b}`) ?? []) {
          const d = (c.lat - la) ** 2 + ((c.lon - lo) * 0.85) ** 2;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    /* km between the sample and the cell centre: 1° lat ≈ 111 km, lon shrunk by cos */
    return { cell: best, km: best ? Math.sqrt(bestD) * 111.32 : Infinity };
  };

  let residentialSamples = 0;
  let samples = 0;
  for (let la = box[0]; la <= box[2]; la += STEP) {
    for (let lo = box[1]; lo <= box[3]; lo += STEP) {
      if (!inside(la, lo, points)) continue;
      samples += 1;
      const hit = nearest(la, lo);
      /* a sample counts as inhabited only if its nearest cell is *close* and populated:
         without the distance test every sample found some cell somewhere and the whole
         polygon came back «100 % residential» */
      const reach = cellKm * 0.75;
      if (hit.cell && hit.km <= reach && (hit.cell.pop || 0) > 0) residentialSamples += 1;
    }
  }
  /* the share of samples that sit on inhabited ground, applied to the measured area —
     sampling area directly double-counted the boundary row and could exceed the polygon */
  const residentialKm2 = samples > 0 ? (residentialSamples / samples) * areaKm2 : 0;

  const pharmacies = all<{ lat: number; lon: number }>(
    `SELECT lat, lon FROM map_pharmacy
      WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
    [box[0], box[2], box[1], box[3]],
  ).filter((p) => inside(p.lat, p.lon, points)).length;

  return {
    areaKm2: Math.round(areaKm2 * 1000) / 1000,
    residentialKm2: Math.round(residentialKm2 * 1000) / 1000,
    population: Math.round(population),
    density: residentialKm2 > 0
      ? Math.round(population / residentialKm2)
      : Math.round(population / Math.max(0.001, areaKm2)),
    pharmacies,
    cells: cells.length,
    cellKm,
    method: useFine
      ? `شبکهٔ ۲۵۰ متری شهر · ${cells.length} سلول · پوشش مسکونی از نمونه‌برداری ۱۰۰ متری`
      : `شبکهٔ ۵۰۰ متری استان · ${cells.length} سلول · پوشش مسکونی از نمونه‌برداری ۱۰۰ متری`,
  };
}

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS measurement (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    name           TEXT NOT NULL,
    points         TEXT NOT NULL,
    area_km2       REAL NOT NULL,
    residential_km2 REAL NOT NULL,
    population     INTEGER NOT NULL,
    density        INTEGER NOT NULL,
    pharmacies     INTEGER NOT NULL,
    cell_km        REAL NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function parsePoints(raw: unknown): [number, number][] | null {
  if (!Array.isArray(raw)) return null;
  const out: [number, number][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lat = Number(p[0]);
    const lon = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    out.push([lat, lon]);
  }
  return out.length >= 3 ? out : null;
}

export async function GET() {
  ensureTable();
  const u = currentUser();
  const rows = all<{
    id: number; name: string; points: string; areaKm2: number; residentialKm2: number;
    population: number; density: number; pharmacies: number; cellKm: number;
  }>(`SELECT id, name, points, area_km2 AS areaKm2, residential_km2 AS residentialKm2,
             population, density, pharmacies, cell_km AS cellKm
        FROM measurement WHERE user_id = ? ORDER BY id DESC`, [u.id]);
  return NextResponse.json({
    user: u,
    items: rows.map((r) => ({ ...r, points: JSON.parse(r.points) as [number, number][] })),
  });
}

export async function POST(req: Request) {
  ensureTable();
  const u = currentUser();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const points = parsePoints(body.points);
  if (!points) {
    return NextResponse.json({ error: "محدوده باید دست‌کم سه نقطه داشته باشد" }, { status: 400 });
  }
  const m = measure(points);

  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) {
    return NextResponse.json({ ok: true, metrics: m, saved: false });
  }
  if (name.length > 120) {
    return NextResponse.json({ error: "نام بیش از حد بلند است" }, { status: 400 });
  }
  run(`INSERT INTO measurement
        (user_id, name, points, area_km2, residential_km2, population, density, pharmacies, cell_km)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [u.id, name, JSON.stringify(points), m.areaKm2, m.residentialKm2, m.population,
       m.density, m.pharmacies, m.cellKm]);
  const row = one<{ id: number }>("SELECT last_insert_rowid() AS id");
  return NextResponse.json({ ok: true, id: row?.id ?? null, metrics: m, saved: true });
}

export async function DELETE(req: Request) {
  ensureTable();
  const u = currentUser();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM measurement WHERE id = ? AND user_id = ?", [id, u.id]);
  return NextResponse.json({ ok: true, id });
}
