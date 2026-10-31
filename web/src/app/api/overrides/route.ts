/**
 * Manual override API — the only writable endpoint in the app.
 *
 * The user is the authority here: they may hold a census page, a yearbook table
 * or field knowledge the feed lacks. An override is therefore stored alongside
 * the source data rather than on top of it, and every change is journalled, so
 * "where did this number come from?" always has an answer.
 *
 *   POST   { location_id, field, value, note?, author? }   upsert + journal
 *   DELETE { location_id, field }                          remove + journal
 */
import { NextResponse } from "next/server";
import { one, run } from "@/lib/db";

/** Only fields the model actually consumes may be overridden. */
const FIELDS = new Set(["population", "n_pharmacy_real", "n_pharmacy_legal"]);

interface Body {
  location_id?: unknown;
  field?: unknown;
  value?: unknown;
  note?: unknown;
  author?: unknown;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function currentValue(locationId: number, field: string): number | null {
  if (field === "population") {
    const r = one<{ v: number | null }>(
      `SELECT population AS v FROM v_latest_snapshot WHERE location_id = ?`,
      [locationId],
    );
    return r?.v ?? null;
  }
  const r = one<{ v: number | null }>(
    `SELECT ${field} AS v FROM v_latest_snapshot WHERE location_id = ?`,
    [locationId],
  );
  return r?.v ?? null;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const locationId = Number(body.location_id);
  const field = String(body.field ?? "");
  const value =
    body.value === null || body.value === "" ? null : Number(body.value);
  const note = body.note == null ? null : String(body.note).slice(0, 500);
  const author = body.author == null ? null : String(body.author).slice(0, 120);

  if (!Number.isInteger(locationId) || locationId <= 0) {
    return NextResponse.json(
      { error: "location_id must be a positive integer" },
      { status: 400 },
    );
  }
  if (!FIELDS.has(field)) {
    return NextResponse.json(
      { error: `field must be one of ${[...FIELDS].join(", ")}` },
      { status: 400 },
    );
  }
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    return NextResponse.json(
      { error: "value must be a finite number >= 0, or null to clear" },
      { status: 400 },
    );
  }

  // A place must exist before anything can be attached to it; this also stops a
  // typo'd id from silently creating a dangling override.
  const loc = one<{ loc_key: string }>(
    "SELECT loc_key FROM locations WHERE id = ?",
    [locationId],
  );
  if (!loc) {
    return NextResponse.json({ error: "unknown location_id" }, { status: 404 });
  }
  // Overrides are keyed on loc_key so a rebuild (which re-creates locations with
  // fresh autoincrement ids) cannot orphan the user's evidence.
  const locKey = loc.loc_key;

  const old = currentValue(locationId, field);
  const ts = nowIso();

  if (value === null) {
    run("DELETE FROM manual_override WHERE loc_key = ? AND field = ?", [
      locKey,
      field,
    ]);
  } else {
    run(
      `INSERT INTO manual_override (loc_key, location_id, field, value, note, author, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(loc_key, field) DO UPDATE SET
         location_id = excluded.location_id,
         value = excluded.value,
         note = excluded.note,
         author = excluded.author,
         updated_at = excluded.updated_at`,
      [locKey, locationId, field, value, note, author, ts],
    );
  }

  run(
    `INSERT INTO manual_override_log
       (loc_key, location_id, field, old_value, new_value, note, author, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [locKey, locationId, field, old, value, note, author, ts],
  );

  return NextResponse.json({
    ok: true,
    location_id: locationId,
    field,
    value,
    note,
  });
}

export async function DELETE(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const locationId = Number(body.location_id);
  const field = String(body.field ?? "");
  if (!Number.isInteger(locationId) || !FIELDS.has(field)) {
    return NextResponse.json(
      { error: "location_id and a valid field are required" },
      { status: 400 },
    );
  }
  const loc = one<{ loc_key: string }>(
    "SELECT loc_key FROM locations WHERE id = ?",
    [locationId],
  );
  if (!loc) {
    return NextResponse.json({ error: "unknown location_id" }, { status: 404 });
  }
  const old = currentValue(locationId, field);
  run("DELETE FROM manual_override WHERE loc_key = ? AND field = ?", [
    loc.loc_key,
    field,
  ]);
  run(
    `INSERT INTO manual_override_log
       (loc_key, location_id, field, old_value, new_value, note, author, changed_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    [loc.loc_key, locationId, field, old, nowIso()],
  );
  return NextResponse.json({ ok: true, cleared: true });
}
