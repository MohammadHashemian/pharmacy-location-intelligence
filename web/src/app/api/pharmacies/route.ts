/**
 * Manual pharmacies — the pins a user adds because they stood in front of one.
 *
 * Kept in their own table, not in `map_pharmacy`: every ETL run rewrites that table
 * from Google/OSM, and a rebuild must never delete something a person verified by
 * hand. The map loader unions the two.
 *
 *   POST   { name, lat, lon, address?, phone?, note? }
 *   DELETE ?id=<manual id>
 *
 * The new row gets the same `nearest_area_id` / `nearest_km` / `county` the importer
 * would give it, so it counts towards density, the ring table and the
 * per-pharmacy ratio exactly like an imported point.
 */
import { NextResponse } from "next/server";
import { all, one, run } from "@/lib/db";

const KHZ = { latMin: 29.4, latMax: 33.6, lonMin: 47.3, lonMax: 51.1 };

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS manual_pharmacy (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
}

function hav(alat: number, alon: number, blat: number, blon: number): number {
  const R = 6371.0088;
  const p1 = (alat * Math.PI) / 180;
  const p2 = (blat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((blon - alon) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

type Settlement = { area_id: number; name: string; lat: number; lon: number; county: string | null };

function nearestSettlement(lat: number, lon: number): { s: Settlement; km: number } | null {
  // 0.15° box is ~16 km — enough for the nearest town, cheap without trig in SQL
  const rows = all<Settlement>(
    `SELECT area_id, name, lat, lon, county FROM v_map_settlement
      WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
    [lat - 0.15, lat + 0.15, lon - 0.15, lon + 0.15],
  );
  let best: { s: Settlement; km: number } | null = null;
  for (const s of rows) {
    const km = hav(lat, lon, s.lat, s.lon);
    if (!best || km < best.km) best = { s, km };
  }
  return best;
}

export async function GET() {
  ensureTable();
  const rows = all(
    `SELECT id, name, lat, lon, address, phone, note, created_at AS createdAt
       FROM manual_pharmacy ORDER BY id DESC`,
  );
  return NextResponse.json({ pharmacies: rows });
}

/* Editing a hand-added pin. Only manual rows can arrive here: everything else is rebuilt
   from Google/OSM on the next ETL run, so an edit would vanish without a trace. */
export async function PATCH(req: Request) {
  ensureTable();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  const existing = one<{ id: number }>("SELECT id FROM manual_pharmacy WHERE id = ?", [id]);
  if (!existing) {
    return NextResponse.json({ error: "این داروخانه پیدا نشد" }, { status: 404 });
  }

  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  const address = String(body.address ?? "").trim() || null;
  const phone = String(body.phone ?? "").trim() || null;
  const note = String(body.note ?? "").trim() || null;

  if (name.length < 3 || name.length > 120) {
    return NextResponse.json({ error: "نام باید بین ۳ تا ۱۲۰ نویسه باشد" }, { status: 400 });
  }
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) {
    return NextResponse.json({ error: "شمارهٔ تلفن نامعتبر است" }, { status: 400 });
  }

  run("UPDATE manual_pharmacy SET name = ?, address = ?, phone = ?, note = ? WHERE id = ?",
      [name, address, phone, note, id]);
  const row = one<{ name: string; address: string | null; phone: string | null; note: string | null }>(
    "SELECT name, address, phone, note FROM manual_pharmacy WHERE id = ?", [id]);
  return NextResponse.json({ ok: true, id, pharmacy: row });
}

export async function DELETE(req: Request) {
  ensureTable();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM manual_pharmacy WHERE id = ?", [id]);
  return NextResponse.json({ ok: true, id });
}

export async function POST(req: Request) {
  ensureTable();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const address = String(body.address ?? "").trim() || null;
  const phone = String(body.phone ?? "").trim() || null;
  const note = String(body.note ?? "").trim() || null;

  if (name.length < 3 || name.length > 120) {
    return NextResponse.json({ error: "نام باید بین ۳ تا ۱۲۰ نویسه باشد" }, { status: 400 });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "مختصات نامعتبر است" }, { status: 400 });
  }
  if (lat < KHZ.latMin || lat > KHZ.latMax || lon < KHZ.lonMin || lon > KHZ.lonMax) {
    return NextResponse.json(
      { error: "این نقطه بیرون از خوزستان است — نقشه فقط این استان را پوشش می‌دهد" },
      { status: 400 },
    );
  }
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) {
    return NextResponse.json({ error: "شمارهٔ تلفن نامعتبر است" }, { status: 400 });
  }

  const near = nearestSettlement(lat, lon);
  if (!near) {
    return NextResponse.json(
      { error: "هیچ آبادی‌ای نزدیک این نقطه نیست — مختصات را بررسی کنید" },
      { status: 400 },
    );
  }

  // same 60 m rule the importer uses, so a manual pin cannot duplicate an import
  const dup = all<{ name: string; km: number }>(
    `SELECT p.name, 0 AS km FROM map_pharmacy p
      WHERE ABS(p.lat - ?) < 0.0008 AND ABS(p.lon - ?) < 0.0008
      UNION ALL
     SELECT name, 0 AS km FROM manual_pharmacy
      WHERE ABS(lat - ?) < 0.0008 AND ABS(lon - ?) < 0.0008`,
    [lat, lon, lat, lon],
  );
  if (dup.length) {
    return NextResponse.json(
      { error: "داروخانه‌ای تا ۹۰ متر این نقطه ثبت شده است", existing: dup[0].name },
      { status: 409 },
    );
  }

  run(
    `INSERT INTO manual_pharmacy
       (name, lat, lon, address, phone, note, nearest_area_id, nearest_km, county, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [name, lat, lon, address, phone, note, near.s.area_id,
     Math.round(near.km * 100) / 100, near.s.county,
     new Date().toISOString().replace(/\.\d{3}Z$/, "Z")],
  );
  const row = one<{ id: number }>("SELECT last_insert_rowid() AS id");
  return NextResponse.json({
    ok: true,
    id: row?.id ?? null,
    settlement: near.s.name,
    km: Math.round(near.km * 10) / 10,
  });
}
