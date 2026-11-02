/**
 * «I have already looked at this place.»
 *
 * A per-user checkmark on any place that is not a drawn polygon: a settlement you have
 * surveyed, a neighbourhood you have walked. Stored in SQLite, scoped by user id, so it
 * survives a refresh, a restart, and — when accounts arrive — belongs to whoever ticked it.
 *
 *   GET                          → { items: [{ kind, ref, checkedAt, note }] }
 *   POST   { kind, ref, checked? , note? }   → tick (default) or untick with checked:false
 *   DELETE ?kind=&ref=           → remove the mark
 *
 * `kind` is `settlement` (area_id) or `hood` (OSM id); `ref` is that id as text.
 */
import { NextResponse } from "next/server";
import { all, run } from "@/lib/db";
import { currentUser } from "@/lib/user";

const KINDS = ["settlement", "hood"] as const;
type Kind = (typeof KINDS)[number];

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS place_check (
    user_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    ref        TEXT NOT NULL,
    note       TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, kind, ref)
  )`);
}

function parse(kind: unknown, ref: unknown): { kind: Kind; ref: string } | null {
  const k = String(kind ?? "").trim().toLowerCase();
  const r = String(ref ?? "").trim();
  if (!(KINDS as readonly string[]).includes(k) || !r) return null;
  return { kind: k as Kind, ref: r };
}

export async function GET() {
  ensureTable();
  const u = currentUser();
  const rows = all(
    `SELECT kind, ref, note, checked_at AS checkedAt FROM place_check
      WHERE user_id = ? ORDER BY checked_at DESC`,
    [u.id],
  );
  return NextResponse.json({ user: u, items: rows });
}

export async function POST(req: Request) {
  ensureTable();
  const u = currentUser();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const target = parse(body.kind, body.ref);
  if (!target) {
    return NextResponse.json({ error: "نوع یا شناسهٔ مکان نامعتبر است" }, { status: 400 });
  }
  const checked = body.checked === undefined ? true : Boolean(body.checked);
  if (!checked) {
    run("DELETE FROM place_check WHERE user_id = ? AND kind = ? AND ref = ?",
        [u.id, target.kind, target.ref]);
    return NextResponse.json({ ok: true, ...target, checked: false });
  }
  const note = String(body.note ?? "").trim() || null;
  run(`INSERT INTO place_check (user_id, kind, ref, note) VALUES (?,?,?,?)
       ON CONFLICT(user_id, kind, ref) DO UPDATE SET
         note = excluded.note, checked_at = datetime('now')`,
      [u.id, target.kind, target.ref, note]);
  return NextResponse.json({ ok: true, ...target, checked: true });
}

export async function DELETE(req: Request) {
  ensureTable();
  const u = currentUser();
  const q = new URL(req.url).searchParams;
  const target = parse(q.get("kind"), q.get("ref"));
  if (!target) {
    return NextResponse.json({ error: "نوع یا شناسهٔ مکان نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM place_check WHERE user_id = ? AND kind = ? AND ref = ?",
      [u.id, target.kind, target.ref]);
  return NextResponse.json({ ok: true, ...target });
}
