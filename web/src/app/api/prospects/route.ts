/**
 * The visit list: places worth standing in front of before signing a lease.
 *
 * Scoped by `user_id` from `currentUser()` — the tables and API are already multi-user, only
 * the identity is hard-coded until real authentication arrives.
 *
 *   GET                      → this user's marks, newest first
 *   POST   { name, lat, lon, note?, status?, priority? }
 *   PATCH  { id, name?, note?, status?, priority? }
 *   DELETE ?id=<id>
 *
 * Status is deliberately small: `todo` (go look), `visited` (been there), `rejected`
 * (checked, not viable). Priority is a trip ORDER, not a category: a new place is appended at
 * the end (max + 1) and `PUT` rewrites the whole order when the list is dragged into shape.
 * There is no cap on how many places the list holds and none on the number's range.
 */
import { NextResponse } from "next/server";
import { all, one, run } from "@/lib/db";
import { currentUser } from "@/lib/user";

const STATUS = ["todo", "visited", "rejected"] as const;

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS prospect (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    note       TEXT,
    status     TEXT NOT NULL DEFAULT 'todo',
    priority   INTEGER NOT NULL DEFAULT 2,
    visited_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  run("CREATE INDEX IF NOT EXISTS idx_prospect_user ON prospect(user_id)");
}

export async function GET() {
  ensureTable();
  const u = currentUser();
  const rows = all(
    `SELECT id, name, lat, lon, note, status, priority, visited_at AS visitedAt,
            created_at AS createdAt
       FROM prospect WHERE user_id = ? ORDER BY priority, id DESC`,
    [u.id],
  );
  return NextResponse.json({ user: u, items: rows });
}

export async function POST(req: Request) {
  ensureTable();
  const u = currentUser();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const note = String(body.note ?? "").trim() || null;
  const status = STATUS.includes(body.status as (typeof STATUS)[number])
    ? (body.status as string) : "todo";
  const given = Number(body.priority);
  const priority = Number.isFinite(given) && given > 0
    ? Math.round(given)
    : (one<{ p: number }>(
        "SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM prospect WHERE user_id = ?",
        [u.id])?.p ?? 1);

  if (name.length < 2 || name.length > 120) {
    return NextResponse.json({ error: "نام باید بین ۲ تا ۱۲۰ نویسه باشد" }, { status: 400 });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "مختصات نامعتبر است" }, { status: 400 });
  }

  run(`INSERT INTO prospect (user_id, name, lat, lon, note, status, priority)
       VALUES (?,?,?,?,?,?,?)`, [u.id, name, lat, lon, note, status, priority]);
  const row = one<{ id: number }>("SELECT last_insert_rowid() AS id");
  return NextResponse.json({ ok: true, id: row?.id ?? null, userId: u.id });
}

export async function PATCH(req: Request) {
  ensureTable();
  const u = currentUser();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  const row = one<{ id: number }>("SELECT id FROM prospect WHERE id = ? AND user_id = ?",
                                 [id, u.id]);
  if (!row) {
    return NextResponse.json({ error: "این نشان پیدا نشد" }, { status: 404 });
  }

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
  if (body.status !== undefined) {
    if (!STATUS.includes(body.status as (typeof STATUS)[number])) {
      return NextResponse.json({ error: "وضعیت نامعتبر است" }, { status: 400 });
    }
    sets.push("status = ?", "visited_at = ?");
    args.push(body.status as string,
              body.status === "visited" ? new Date().toISOString().slice(0, 19) : null);
  }
  if (body.priority !== undefined) {
    sets.push("priority = ?");
    args.push(Math.max(1, Math.round(Number(body.priority) || 1)));
  }
  if (!sets.length) {
    return NextResponse.json({ ok: true, id, unchanged: true });
  }
  run(`UPDATE prospect SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
      [...args, id, u.id]);
  const updated = one("SELECT id, name, lat, lon, note, status, priority, visited_at AS visitedAt"
                      + " FROM prospect WHERE id = ?", [id]);
  return NextResponse.json({ ok: true, item: updated });
}

/**
 * Reorder the whole trip at once — `{ ids: [12, 7, 31, …] }`.
 *
 * Drag and drop produces a new sequence, not a series of pairwise swaps; sending the sequence
 * means the database can never be left half-ordered if one request in a chain fails.
 */
export async function PUT(req: Request) {
  ensureTable();
  const u = currentUser();
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
  if (!ids || !ids.length || ids.some((n) => !Number.isInteger(n))) {
    return NextResponse.json({ error: "فهرست شناسه‌ها نامعتبر است" }, { status: 400 });
  }
  const owned = new Set(
    all<{ id: number }>("SELECT id FROM prospect WHERE user_id = ?", [u.id]).map((r) => r.id),
  );
  const clean = ids.filter((id) => owned.has(id));
  run("BEGIN");
  try {
    clean.forEach((id, i) => {
      run("UPDATE prospect SET priority = ? WHERE id = ? AND user_id = ?", [i + 1, id, u.id]);
    });
    run("COMMIT");
  } catch (e) {
    run("ROLLBACK");
    return NextResponse.json({ error: `ثبت ترتیب ناموفق بود: ${String(e)}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ordered: clean.length });
}

export async function DELETE(req: Request) {
  ensureTable();
  const u = currentUser();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "شناسه نامعتبر است" }, { status: 400 });
  }
  run("DELETE FROM prospect WHERE id = ? AND user_id = ?", [id, u.id]);
  return NextResponse.json({ ok: true, id });
}
