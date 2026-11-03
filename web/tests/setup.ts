/**
 * Tests never touch the live database.
 *
 * The app keeps one SQLite file with the owner's annotations, the imported register and the
 * computed surfaces. A unit test that called `run()` against it would repeat the accident that
 * already cost a visit list, so every worker gets its OWN copy and the app is pointed at it
 * through `PHARMACY_DB`.
 *
 * One copy per process, not one shared file: vitest runs test files in parallel workers, and
 * two workers copying the same 80 MB file at once fails with EBUSY on Windows.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const live = path.resolve(__dirname, "..", "..", "db", "pharmacy.sqlite");
const dir = path.resolve(__dirname, "..", ".tmp-tests");
const copy = path.join(dir, `pharmacy.${process.pid}.sqlite`);

if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

// drop copies older than an hour — a crashed run should not fill the disk
for (const f of readdirSync(dir)) {
  const p = path.join(dir, f);
  try {
    if (Date.now() - statSync(p).mtimeMs > 3_600_000) rmSync(p, { force: true });
  } catch {
    /* another worker may be removing it */
  }
}

/* Fold the WAL into the main file first. Without this the copy can miss the newest tables
   and rows — the report table is created by an ETL run and lives in the log for a while. */
try {
  const db = new DatabaseSync(live);
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.close();
} catch {
  /* a reader holding the file is not fatal: the copy below still carries every committed page */
}

/* Several workers copy at once; on Windows an EBUSY here is a timing problem, not a failure. */
for (let attempt = 0; attempt < 8; attempt++) {
  try {
    copyFileSync(live, copy);
    break;
  } catch (e) {
    if (attempt === 7) throw e;
    const until = Date.now() + 300;
    while (Date.now() < until) { /* short, synchronous backoff: setup runs before the tests */ }
  }
}
process.env.PHARMACY_DB = copy;
