// Verify the dashboard's payload query against the new views, without the
// Next build (which the sandbox blocks: next build spawns a piped worker and
// Windows confinement refuses that with spawn EPERM).
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("../db/pharmacy.sqlite");

const rows = db
  .prepare(
    `SELECT location_id, place, place_kind, fda_population, county_urban_share, hh_size,
            n_pharmacy_real + n_pharmacy_legal AS n_ph
     FROM v_place_full
     LEFT JOIN (SELECT location_id AS lid, county_urban_share, hh_size
                  FROM v_place_prosperity) pp
            ON pp.lid = v_place_full.location_id
     WHERE is_market = 1
        OR (COALESCE(n_pharmacy_real, 0) + COALESCE(n_pharmacy_legal, 0)) > 0
     ORDER BY COALESCE(fda_population, 0) DESC
     LIMIT 5`,
  )
  .all();

console.log("payload query OK, first rows:");
for (const r of rows) console.log(JSON.stringify(r));

const n = db
  .prepare(
    `SELECT COUNT(*) AS n,
            SUM(county_urban_share IS NULL) AS null_urban,
            SUM(hh_size IS NULL) AS null_hh
     FROM v_place_prosperity`,
  )
  .get();
console.log("prosperity coverage:", JSON.stringify(n));

const anchors = db.prepare("SELECT * FROM v_otc_anchors").get();
console.log("anchors:", JSON.stringify(anchors));
