/**
 * The short list — the three to five places you are actually choosing between.
 *
 * Not a favourite: a snapshot. Each row stores the score and its components **as they were
 * when you shortlisted it**, because the ranking is rebuilt whenever supply changes. A
 * shortlist that silently re-scores itself is worse than no shortlist — you would compare
 * numbers from two different models without knowing.
 *
 *   GET                     → rows, newest first
 *   POST   { rank }         → copy that candidate (and its metrics) into the list
 *   DELETE ?id=<id>         → remove
 */
import { NextResponse } from "next/server";
import { all, one, run } from "@/lib/db";

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS shortlist (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    rank          INTEGER NOT NULL,
    lat           REAL NOT NULL,
    lon           REAL NOT NULL,
    settlement    TEXT,
    county        TEXT,
    score         REAL NOT NULL,
    demand        REAL NOT NULL,
    supply_mapped REAL NOT NULL,
    anchors       REAL NOT NULL,
    road_km       REAL NOT NULL,
    gap           REAL NOT NULL,
    note          TEXT,
    snapshot_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export async function GET() {
  ensureTable();
  const rows = all(
    `SELECT id, rank, lat, lon, settlement, county, score, demand, supply_mapped AS supplyMapped,
            anchors, road_km AS roadKm, gap, note, snapshot_at AS snapshotAt, created_at AS createdAt
       FROM shortlist ORDER BY id DESC`,
  );
  return NextResponse.json({ items: rows });
}

export async function POST(req: Request) {
  ensureTable();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const rank = Number(body.rank);
  if (!Number.isInteger(rank)) {
    return NextResponse.json({ error: "شناسهٔ پیشنهاد نامعتبر است" }, { status: 400 });
  }
  const s = one<{
    rank: number; lat: number; lon: number; settlement: string | null; county: string | null;
    score: number; demand: number; supply_mapped: number; anchors: number; road_km: number;
    gap: number;
  }>(
    `SELECT rank, lat, lon, settlement, county, score, demand, supply_mapped, anchors, road_km, gap
       FROM site_candidate WHERE rank = ?`,
    [rank],
  );
  if (!s) {
    return NextResponse.json({ error: "این پیشنهاد پیدا نشد — رتبه‌بندی را دوباره اجرا کنید" },
      { status: 404 });
  }
  const dup = one<{ id: number }>(
    "SELECT id FROM shortlist WHERE ABS(lat - ?) < 0.001 AND ABS(lon - ?) < 0.001",
    [s.lat, s.lon],
  );
  if (dup) {
    return NextResponse.json({ ok: true, id: dup.id, already: true });
  }
  run(
    `INSERT INTO shortlist
       (rank, lat, lon, settlement, county, score, demand, supply_mapped, anchors, road_km, gap,
        note, snapshot_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.rank, s.lat, s.lon, s.settlement, s.county, s.score, s.demand, s.supply_mapped,
     s.anchors, s.road_km, s.gap, String(body.note ?? "").trim() || null,
     new Date().toISOString().replace(/\.\d{3}Z$/, "Z")],
  );
  const row = one<{ id: number }>("SELECT last_insert_rowid() AS id");
  return NextResponse.json({ ok: true, id: row?.id ?? null });
}

export async function DELETE(req: Request) {
  ensureTable();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM shortlist WHERE id = ?", [id]);
  return NextResponse.json({ ok: true, id });
}
