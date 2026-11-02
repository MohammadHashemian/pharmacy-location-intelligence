/**
 * Areas already surveyed — the answer to «did I check this neighbourhood or not?».
 *
 * A polygon drawn on the map, stored per user, rendered as a translucent wash with its name.
 * The point is not cartography: it is to stop re-walking the same streets and to show at a
 * glance which parts of a city are still unexamined.
 *
 *   GET                    → this user's areas
 *   POST   { name, points: [[lat, lon], …], note? }   (3+ points)
 *   PATCH  { id, name?, note? }
 *   DELETE ?id=<id>
 */
import { NextResponse } from "next/server";
import { all, one, run } from "@/lib/db";
import { currentUser } from "@/lib/user";

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS survey_area (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    note       TEXT,
    points     TEXT NOT NULL,          -- JSON [[lat, lon], …]
    area_km2   REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  run("CREATE INDEX IF NOT EXISTS idx_survey_user ON survey_area(user_id)");
}

/** Shoelace in local km (111.32 km per degree) — good enough for an area wash. */
function areaKm2(points: [number, number][]): number {
  if (points.length < 3) return 0;
  const lat0 = points.reduce((a, p) => a + p[0], 0) / points.length;
  const mPerDegLat = 111.32;
  const mPerDegLon = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[(i + 1) % points.length];
    const x1 = lon1 * mPerDegLon;
    const y1 = lat1 * mPerDegLat;
    const x2 = lon2 * mPerDegLon;
    const y2 = lat2 * mPerDegLat;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;      // x/y are already km: 111.32 km per degree, not metres
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
  const rows = all<{ id: number; name: string; note: string | null; points: string;
    area_km2: number | null; created_at: string }>(
    `SELECT id, name, note, points, area_km2, created_at FROM survey_area
      WHERE user_id = ? ORDER BY id DESC`, [u.id]);
  return NextResponse.json({
    user: u,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      note: r.note,
      points: JSON.parse(r.points) as [number, number][],
      areaKm2: r.area_km2,
      createdAt: r.created_at,
    })),
  });
}

export async function POST(req: Request) {
  ensureTable();
  const u = currentUser();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  const points = parsePoints(body.points);
  if (name.length < 2 || name.length > 120) {
    return NextResponse.json({ error: "نام باید بین ۲ تا ۱۲۰ نویسه باشد" }, { status: 400 });
  }
  if (!points) {
    return NextResponse.json({ error: "محدوده باید دست‌کم سه نقطه داشته باشد" }, { status: 400 });
  }
  const note = String(body.note ?? "").trim() || null;
  run(`INSERT INTO survey_area (user_id, name, note, points, area_km2)
       VALUES (?,?,?,?,?)`,
      [u.id, name, note, JSON.stringify(points), Math.round(areaKm2(points) * 100) / 100]);
  const row = one<{ id: number }>("SELECT last_insert_rowid() AS id");
  return NextResponse.json({ ok: true, id: row?.id ?? null, areaKm2: areaKm2(points) });
}

export async function PATCH(req: Request) {
  ensureTable();
  const u = currentUser();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  const row = one<{ id: number }>("SELECT id FROM survey_area WHERE id = ? AND user_id = ?",
                                 [id, u.id]);
  if (!row) return NextResponse.json({ error: "این محدوده پیدا نشد" }, { status: 404 });

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (body.name !== undefined) {
    const name = String(body.name).replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 120) {
      return NextResponse.json({ error: "نام باید بین ۲ تا ۱۲۰ نویسه باشد" }, { status: 400 });
    }
    sets.push("name = ?");
    args.push(name);
  }
  if (body.note !== undefined) {
    sets.push("note = ?");
    args.push(String(body.note).trim() || null);
  }
  if (!sets.length) return NextResponse.json({ ok: true, id, unchanged: true });
  run(`UPDATE survey_area SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [...args, id, u.id]);
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: Request) {
  ensureTable();
  const u = currentUser();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM survey_area WHERE id = ? AND user_id = ?", [id, u.id]);
  return NextResponse.json({ ok: true, id });
}
