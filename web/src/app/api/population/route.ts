/**
 * «I know this village — it has 4,200 people, not 900.»
 *
 * A manual population wins over every imported source, and because `v_map_settlement`
 * resolves `COALESCE(manual, admin)` the gap table, the density wash, the per-capita ratio
 * and `rank_sites.py` all pick it up on the next request. A ranking re-run is kicked off in
 * the background so the numbered candidates move too.
 *
 *   GET                  → this user's overrides
 *   POST   { areaId, value, note? }   → set (value must be a positive integer)
 *   DELETE ?areaId=<id>               → back to the imported sources
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { all, one, run } from "@/lib/db";
import { currentUser } from "@/lib/user";

let lastRank = 0;
function rerank(): void {
  if (Date.now() - lastRank < 30_000) return;
  lastRank = Date.now();
  try {
    const child = spawn("python", ["etl/rank_sites.py", "--min-pop", "4000"], {
      cwd: path.join(process.cwd(), ".."),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    lastRank = 0;
  }
}

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS population_manual (
    area_id    INTEGER PRIMARY KEY,
    value      INTEGER NOT NULL,
    note       TEXT,
    user_id    INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export async function GET() {
  ensureTable();
  const u = currentUser();
  const rows = all(
    `SELECT pm.area_id AS areaId, pm.value, pm.note, pm.updated_at AS updatedAt,
            a.name, a.county
       FROM population_manual pm
       LEFT JOIN v_admin_area_current a ON a.area_id = pm.area_id
      WHERE pm.user_id IS NULL OR pm.user_id = ?
      ORDER BY pm.updated_at DESC`,
    [u.id],
  );
  return NextResponse.json({ items: rows });
}

export async function POST(req: Request) {
  ensureTable();
  const u = currentUser();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const areaId = Number(body.areaId);
  const value = Math.round(Number(body.value));
  const note = String(body.note ?? "").trim() || null;

  if (!Number.isInteger(areaId) || areaId <= 0) {
    return NextResponse.json({ error: "آبادی نامعتبر است" }, { status: 400 });
  }
  if (!Number.isFinite(value) || value <= 0 || value > 20_000_000) {
    return NextResponse.json({ error: "جمعیت باید عددی مثبت باشد" }, { status: 400 });
  }
  const exists = one<{ area_id: number }>(
    "SELECT area_id FROM v_admin_area_current WHERE area_id = ?", [areaId]);
  if (!exists) {
    return NextResponse.json({ error: "این آبادی در لایهٔ تقسیمات کشوری نیست" }, { status: 404 });
  }

  run(`INSERT INTO population_manual (area_id, value, note, user_id, updated_at)
       VALUES (?,?,?,?, datetime('now'))
       ON CONFLICT(area_id) DO UPDATE SET
         value = excluded.value, note = excluded.note,
         user_id = excluded.user_id, updated_at = datetime('now')`,
      [areaId, value, note, u.id]);
  rerank();

  const before = one<{ population_admin: number | null }>(
    "SELECT population_admin FROM v_map_settlement WHERE area_id = ?", [areaId]);
  return NextResponse.json({
    ok: true,
    areaId,
    value,
    replaced: before?.population_admin ?? null,
  });
}

export async function DELETE(req: Request) {
  ensureTable();
  const areaId = Number(new URL(req.url).searchParams.get("areaId"));
  if (!Number.isInteger(areaId)) {
    return NextResponse.json({ error: "آبادی نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM population_manual WHERE area_id = ?", [areaId]);
  rerank();
  return NextResponse.json({ ok: true, areaId });
}
