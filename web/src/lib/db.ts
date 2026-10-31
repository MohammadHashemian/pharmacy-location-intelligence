/**
 * Read-only access to the shared ETL SQLite database.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5, stable in 24) so the app has
 * ZERO native dependencies — no better-sqlite3 rebuild step on Windows.
 *
 * The connection is cached per server process; because SQLite readers see
 * committed writes from other processes immediately, re-running the Python ETL
 * is reflected on the very next request without restarting `next dev`. The pages
 * that consume this are marked `force-dynamic`, so nothing is baked into a
 * build-time cache.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const DB_PATH =
  process.env.PHARMACY_DB ??
  path.resolve(process.cwd(), "..", "db", "pharmacy.sqlite");

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) _db = new DatabaseSync(DB_PATH);
  return _db;
}

export function all<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T[] {
  const rows = getDb()
    .prepare(sql)
    .all(...(params as never[])) as T[];
  // node:sqlite yields NULL-PROTOTYPE objects. React 19 refuses to serialise
  // those across the Server -> Client boundary ("Only plain objects ... can be
  // passed"), so re-home every row onto Object.prototype before handing it on.
  return rows.map((r) => ({ ...(r as object) })) as T[];
}

export function one<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T | undefined {
  const r = getDb()
    .prepare(sql)
    .get(...(params as never[])) as T | undefined;
  return r === undefined ? undefined : ({ ...(r as object) } as T);
}

/** True when the schema has been created and at least one snapshot exists. */
export function dbReady(): boolean {
  try {
    const r = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM location_snapshots",
    );
    return !!r && r.n > 0;
  } catch {
    return false;
  }
}

/**
 * Writable statement, for the one thing this app writes back: manual overrides.
 *
 * Everything else in the database is owned by the Python ETL. Overrides live in
 * their own tables precisely so a rebuild can drop the FDA data without touching
 * the user's evidence, and so no source value is ever overwritten in place.
 */
export function run(sql: string, params: unknown[] = []): void {
  getDb()
    .prepare(sql)
    .run(...(params as never[]));
}
