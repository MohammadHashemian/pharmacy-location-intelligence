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

if (!existsSync(copy)) {
  copyFileSync(live, copy);
}
process.env.PHARMACY_DB = copy;
