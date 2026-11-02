/**
 * Manual places — the pins a user adds because they stood in front of one.
 *
 * Kept in their own table, not in `map_pharmacy` / `map_medical`: every ETL run rewrites those
 * from Google/OSM, and a rebuild must never delete something a person verified by hand.
 *
 * A manual place can be any health service, not only a pharmacy — a درمانگاه, a مطب, a
 * dentist, a lab. `kind` decides which layer the map puts it in.
 *
 *   POST   { kind, name, lat, lon, address?, phone?, note? }
 *   PATCH  { id, kind?, name?, address?, phone?, note? }
 *   DELETE ?id=<id>
 *
 * The new row gets the same `nearest_area_id` / `nearest_km` / `county` the importer
 * would give it, so it counts towards density, the ring table and the
 * per-pharmacy ratio exactly like an imported point.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { all, one, run } from "@/lib/db";

/* Hand-added supply is part of the ranking. The gap table, the density wash and the ratio
   read live views and move on reload; the numbered site badges are a Python build
   (`etl/rank_sites.py`, ~8 s), so a manual change re-runs it in the background and the page
   polls until `generated_at` moves. */
let lastRank = 0;
function rerank(): void {
  if (Date.now() - lastRank < 30_000) return;      // a burst of edits is one rebuild
  lastRank = Date.now();
  const root = path.join(process.cwd(), "..");
  try {
    const child = spawn("python", ["etl/rank_sites.py", "--min-pop", "4000"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    lastRank = 0;                                   // python missing: try again next save
  }
}

const KHZ = { latMin: 29.4, latMax: 33.6, lonMin: 47.3, lonMax: 51.1 };
const KINDS = ["pharmacy", "clinic", "doctor", "dentist", "hospital", "lab"] as const;
type Kind = (typeof KINDS)[number];

const KIND_FA: Record<Kind, string> = {
  pharmacy: "داروخانه",
  clinic: "درمانگاه / کلینیک",
  doctor: "مطب پزشک",
  dentist: "دندانپزشکی",
  hospital: "بیمارستان",
  lab: "آزمایشگاه",
};

function ensureTable(): void {
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
  /* Everything added before this table existed was a pharmacy, by definition — carry it
     over rather than asking anyone to re-pin their own work. */
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

function kindOf(v: unknown): Kind | null {
  const k = String(v ?? "pharmacy").trim().toLowerCase();
  return (KINDS as readonly string[]).includes(k) ? (k as Kind) : null;
}

export async function GET() {
  ensureTable();
  const rows = all(
    `SELECT id, kind, name, lat, lon, address, phone, note, created_at AS createdAt
       FROM manual_place ORDER BY id DESC`,
  );
  const rank = one<{ at: string | null }>("SELECT MAX(generated_at) AS at FROM site_candidate");
  return NextResponse.json({ places: rows, rankAt: rank?.at ?? null });
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
  const existing = one<{ id: number; kind: Kind }>(
    "SELECT id, kind FROM manual_place WHERE id = ?", [id]);
  if (!existing) {
    return NextResponse.json({ error: "این مکان پیدا نشد" }, { status: 404 });
  }

  const kind = body.kind === undefined ? existing.kind : kindOf(body.kind);
  if (!kind) {
    return NextResponse.json({ error: "نوع خدمت نامعتبر است" }, { status: 400 });
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

  run("UPDATE manual_place SET kind = ?, name = ?, address = ?, phone = ?, note = ? WHERE id = ?",
      [kind, name, address, phone, note, id]);
  if (kind !== existing.kind) rerank();
  const row = one("SELECT id, kind, name, address, phone, note FROM manual_place WHERE id = ?", [id]);
  return NextResponse.json({ ok: true, id, kindFa: KIND_FA[kind], place: row });
}

export async function DELETE(req: Request) {
  ensureTable();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM manual_place WHERE id = ?", [id]);
  rerank();
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

  const kind = kindOf(body.kind);
  if (!kind) {
    return NextResponse.json({ error: "نوع خدمت نامعتبر است" }, { status: 400 });
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

  /* the 60 m duplicate rule, per kind: a clinic next door to a pharmacy is normal, a second
     pharmacy on the same 60 m is a double entry. */
  const dup = all<{ name: string }>(
    `SELECT name FROM map_pharmacy
      WHERE ? = 'pharmacy' AND ABS(lat - ?) < 0.0008 AND ABS(lon - ?) < 0.0008
      UNION ALL
     SELECT name FROM map_medical
      WHERE ? <> 'pharmacy' AND ABS(lat - ?) < 0.0008 AND ABS(lon - ?) < 0.0008
      UNION ALL
     SELECT name FROM manual_place
      WHERE kind = ? AND ABS(lat - ?) < 0.0008 AND ABS(lon - ?) < 0.0008`,
    [kind, lat, lon, kind, lat, lon, kind, lat, lon],
  );
  if (dup.length) {
    return NextResponse.json(
      { error: "مکانی از همین نوع تا ۹۰ متر این نقطه ثبت شده است", existing: dup[0].name },
      { status: 409 },
    );
  }

  run(
    `INSERT INTO manual_place
       (kind, name, lat, lon, address, phone, note, nearest_area_id, nearest_km, county, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [kind, name, lat, lon, address, phone, note, near.s.area_id,
     Math.round(near.km * 100) / 100, near.s.county,
     new Date().toISOString().replace(/\.\d{3}Z$/, "Z")],
  );
  rerank();
  const row = one<{ id: number }>("SELECT last_insert_rowid() AS id");
  return NextResponse.json({
    ok: true,
    id: row?.id ?? null,
    kind,
    kindFa: KIND_FA[kind],
    settlement: near.s.name,
    km: Math.round(near.km * 10) / 10,
  });
}
