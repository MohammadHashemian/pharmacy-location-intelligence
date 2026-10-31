/**
 * One runnable check for the post-entry «tolerance» metric.
 *
 *   node scripts/check-tolerance.mjs
 *
 * Compiles lib/{analytics,otc}.ts to CommonJS in .check/ (gitignored) and
 * asserts the three things the ranking now depends on:
 *
 *   1. postEntryPopPerPharmacy is population / (committed + 1), where committed
 *      = open pharmacies + موافقت‌اصولی already granted — not / open pharmacies
 *      and not / open + 1.
 *   2. The script and OTC entrant estimates divide by that same committed + 1.
 *   3. With tolerance as the only weighted dimension, the 20,000-person town
 *      with 4 pharmacies beats the 5,000-person town with 1 — even though both
 *      read as exactly 5,000 people per pharmacy today.
 *
 * Why spawn with `inherit`: the sandbox cannot open the named pipes that
 * piped stdio needs, and this is a local sanity check, not a build step.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");

const tsc = spawnSync(
  process.execPath,
  [
    join(web, "node_modules", "typescript", "bin", "tsc"),
    "--outDir", ".check",
    "--module", "commonjs",
    "--target", "es2022",
    "--skipLibCheck",
    "--moduleResolution", "node",
    "src/lib/analytics.ts",
  ],
  { cwd: web, stdio: "inherit" },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const { scorePlaces } = await import(
  new URL("../.check/analytics.js", import.meta.url).href
);

/** A clean, scorable place; override only the fields the check is about. */
const place = (o) => ({
  location_id: 0,
  loc_key: "k",
  province: "خوزستان",
  county: "شهرستان",
  district: "بخش",
  place: "آبادی",
  place_kind: "city",
  university: null,
  observed_at: "2026-10-10T12:47:00+03:30",
  fda_population: null,
  ref_population: null,
  ref_source: null,
  ref_source_id: null,
  ref_source_url: null,
  ref_census_year_sh: null,
  ref_households: null,
  ref_match_score: null,
  ref_match_method: null,
  has_reference: 0,
  ref_ratio: null,
  manual_population: null,
  manual_pharmacy_real: null,
  manual_pharmacy_legal: null,
  manual_note: null,
  manual_updated_at: null,
  has_manual: 0,
  src_pharmacy_real: 0,
  src_pharmacy_legal: 0,
  salname_pharmacies_1403: null,
  salname_county_population_1395: null,
  county_pharmacy_ratio: null,
  population: null,
  city_score: null,
  min_score: 50,
  n_pharmacy_real: 0,
  n_pharmacy_legal: 0,
  n_pharmacy_total: 0,
  n_pharmacy_committed: 0,
  n_req_registered: 0,
  n_req_inprogress: 0,
  n_req_approved: 0,
  n_req_pipeline: 0,
  pharmacies_per_100k: null,
  population_per_pharmacy: null,
  pipeline_ratio: 0,
  density_reported: null,
  is_market: 1,
  dq_flags: null,
  county_urban_share: null,
  hh_size: null,
  ...o,
});

const town1 = place({
  location_id: 1,
  place: "شهر یک‌داروخانه‌ای",
  population: 5_000,
  fda_population: 5_000,
  n_pharmacy_real: 1,
  n_pharmacy_total: 1,
});
const town4 = place({
  location_id: 2,
  place: "شهر چهارداروخانه‌ای",
  population: 20_000,
  fda_population: 20_000,
  n_pharmacy_real: 4,
  n_pharmacy_total: 4,
});
/* Two open pharmacies and two more already through موافقت‌اصولی: the field we
   would join has five pharmacies in it, not three. */
const townApproved = place({
  location_id: 3,
  place: "شهر دو‌داروخانه‌ای با دو موافقت‌اصولی",
  population: 15_000,
  fda_population: 15_000,
  n_pharmacy_real: 2,
  n_pharmacy_total: 2,
  n_req_approved: 2,
  n_pharmacy_committed: 4,
});

const toleranceOnly = {
  demand: 0,
  headroom: 0,
  pipeline: 0,
  barrier: 0,
  affluence: 0,
  tolerance: 100,
};

const scored = scorePlaces([town1, town4, townApproved], {
  minPopulation: 0,
  populationMode: "fda",
  targetPopulationPerPharmacy: 0,
  basis: "national",
  showFlagged: true,
  unwrapSiblings: false,
  weights: toleranceOnly,
});
// The board comes back ranked, so pick rows by id rather than by input order.
const a = scored.find((s) => s.location_id === 1);
const b = scored.find((s) => s.location_id === 2);
const c = scored.find((s) => s.location_id === 3);

// 1. after entry: 5,000 / (1 + 1), 20,000 / (4 + 1), 15,000 / (4 + 1)
assert.equal(a.postEntryPopPerPharmacy, 2_500);
assert.equal(b.postEntryPopPerPharmacy, 4_000);
assert.equal(c.postEntryPopPerPharmacy, 3_000);
assert.equal(a.entryDilutionPct, 50);
assert.equal(b.entryDilutionPct, 20);
// counting only the two OPEN pharmacies would have said 15,000 / 3 = 5,000
assert.notEqual(
  c.postEntryPopPerPharmacy,
  5_000,
  "approved permits were ignored — the denominator is still open pharmacies only",
);
assert.equal(
  c.estScriptsForEntrant,
  Math.round((15_000 * 6) / 5),
  "script estimate still divides by open pharmacies only",
);
assert.ok(
  Math.abs(c.otc.forEntrant - c.otc.market / 5) <= 1,
  "OTC entrant share still divides by open pharmacies only",
);
assert.ok(
  Math.abs(c.otc.forEntrant - c.otc.market / 3) > 1,
  "OTC entrant share equals the pre-change market / (open + 1)",
);

// 2. the fragile market must not outrank the tolerant one
assert.ok(
  b.scores.tolerance > c.scores.tolerance &&
    c.scores.tolerance > a.scores.tolerance,
  `tolerance rank wrong: ${a.scores.tolerance} / ${c.scores.tolerance} / ${b.scores.tolerance}`,
);
assert.equal(b.rank, 1);

console.log(
  "ok — after entry: 2,500 / 3,000 (2 open + 2 approved) / 4,000; tolerant town ranks first",
);
