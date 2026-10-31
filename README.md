# Pharmacy Location Intelligence

An analytic tool for deciding **where in Iran to open a private pharmacy**, built on
the Iran FDA's published pharmacy-capacity data
(`pharmacy.fda.gov.ir` → «نمایش تعداد داروخانه های کشور»).

Two halves, deliberately decoupled:

| Layer | Stack | Responsibility |
|---|---|---|
| **Data** | Python + SQLite | Ingest every artifact, keep provenance, expose analytic views |
| **Dashboard** | Next.js 16 + Tailwind 4 | Rank, filter, score, drill down |

The dashboard reads the SQLite file directly through Node's built-in `node:sqlite`
(no native modules, no ORM, no build step). Re-running the Python ETL is visible on
the next page load.

---

## Quick start

```bash
# 1. (re)build the database from everything in data/raw
bash etl/rebuild.sh

# 2. fetch the corroborated reference populations (Wikidata + fa.wikipedia census)
python etl/fetch_reference.py          # ~3 min; cached to data/reference/
python etl/enrich_population.py        # ~35 min cold, ~2 min warm (JSON caches)
python etl/verify_reference.py         # proves the FDA numbers were not touched

# 3. parse the provincial yearbook (if data/raw/salname is present)
python etl/convert_salname_doc.py      # .doc -> .docx via Word (see note below)
python etl/load_salname.py             # county-level official figures
python etl/crosscheck_salname.py       # FDA vs the province's own counts

# 4. run the dashboard
cd web && npm install && npm run dev     # http://localhost:3000
```

Manually re-apply the schema and views after adding a table (the loaders do this
for the FDA data, not for the yearbook):

```bash
python -c "import sqlite3;c=sqlite3.connect('db/pharmacy.sqlite');\
c.executescript(open('etl/schema.sql',encoding='utf-8').read());c.commit()"
python -c "import sqlite3;c=sqlite3.connect('db/pharmacy.sqlite');\
c.executescript(open('etl/views.sql',encoding='utf-8').read());c.commit()"
```

`etl/rebuild.sh` ends by running `etl/verify_db.py`, which fails loudly if the
loaded data stops making sense (population outside 70–100 M, pharmacy count
outside 14–26 k, non-UTC timestamps, missing data-quality flags, «تهران بزرگ»
falling out of scope).

`etl/verify_reference.py` is the guard for the population layer: it asserts every
FDA population still equals the stored snapshot value (nothing overwritten), that
every reference row carries source + id + url + confidence, and that the case
which started the work (ملاشیه) actually resolves.

> `etl/fetch_reference.py` and `etl/enrich_population.py` keep their SPARQL result
> sets in `data/reference/*_cache.json`. Delete those to force a full refetch.

---

## What the data actually is

One row per settlement, with the FDA's own capacity metrics:

| Persian column | Field | Meaning |
|---|---|---|
| استان / شهرستان / بخش / شهر-روستا | `province` / `county` / `district` / `place` | administrative hierarchy |
| جمعیت | `population` | population |
| تعداد داروخانه حقیقی | `n_pharmacy_real` | pharmacies owned by natural persons |
| تعداد داروخانه حقوقی | `n_pharmacy_legal` | pharmacies owned by legal entities |
| تعداد درخواست ثبت شده | `n_req_registered` | registered applications |
| تعداد درخواست های درحال جریان | `n_req_inprogress` | applications in progress |
| تعداد موافقت اصولی صادر شده | `n_req_approved` | approvals in principle issued |
| امتیاز شهر / حداقل امتیاز | `city_score` / `min_score` | city score / permit threshold |
| نسبت تعداد داروخانه به جمعیت ×۱۰⁶ | `density_reported` | published density, = (real + legal + approved) / pop × 10⁶ |
| — | `university` | administering university of medical sciences (`OrganOnvan`) |

**Loaded today:** 47,564 settlements, 88.4 M population, 18,701 pharmacies, 31
provinces, 431 counties, 44 university catchments. Two independent captures:

* `data/raw/fda-zarfiat.html` — offline page save, Khuzestan only (3,192 rows)
* `data/raw/zarfiat_pages/*.json` — 13-page API crawl, national (62,524 rows)

> The settlement count moved 48,410 → 47,564 when the Arabic→Persian letter
> folding in `etl/normalize.py` was fixed. `_LETTER_MAP` had **string keys**,
> which `str.translate()` silently ignores (it indexes by `ord(char)`), so ي/ك
> never folded onto ی/ک and every place spelled with an Arabic letter got its own
> `loc_key`. **846 phantom duplicate settlements** disappeared once it folded
> correctly — the 50 duplicates visible inside the Khuzestan page alone are the
> same bug.

### Verification performed

* The API's `count` says 62,524 but only **48,423 distinct `ShahrID`s** come back —
  the endpoint fans out duplicate rows (0 of them disagree on values). Distinct
  places is the right denominator, not `count`.
* **Khuzestan cross-check:** the API reproduces 3,181/3,181 places from the
  independent HTML capture — *zero* missing — with matching pharmacy counts, and
  8 extra villages the HTML page didn't carry. Only 4 `ShahrID`s straddle a page
  boundary, so the `ShahrID asc` paging is stable.
* National totals (18,756 pharmacies / 88.7 M people) match Iran's real magnitude,
  which is the strongest available completeness signal.

---

## Analysis scope: why `is_market` exists

The obvious filter — "name starts with شهر" — is **wrong at national scale**. The
single largest market in the country, **«تهران بزرگ»** (3,057 pharmacies, 8.15 M
people), carries no `شهر` prefix and would be silently dropped.

So scope is defined by the market itself, in `etl/views.sql`:

```sql
is_market = 1  WHEN  place_kind = 'city'
                OR   (n_pharmacy_real + n_pharmacy_legal) >= 3
```

That keeps **1,323 of 48,410 settlements covering 96.6% of all 18,756
pharmacies**. The other 47,087 are hamlets averaging ~490 people where a private
pharmacy is not a business.

`place_kind` is still recorded (from the source's own name prefix) but is **not**
used as a filter.

---

## Data quality — what is held out, and why

The source is a live operational system, not a curated dataset. Flags are computed
at ingest (`etl/adapters.py`), stored on every snapshot, and queryable via
`v_dq_summary`. The dashboard shows all of them and **never drops a row silently**.

**Hard flags — excluded from ranking** (a bad population makes density, and
therefore the whole score, meaningless):

| Flag | Rule | Found |
|---|---|---|
| `pop_outlier` | pop ≥ 500,000 but < 20 pharmacies | 1 — «شهر تجريش», pop 8,154,051 with 1 pharmacy: the population actually belongs to Tehran |
| `pop_zero` | population missing or 0 | 1,451 |
| `bad_name` | name has no Persian letters (`**`, `-`) | 3 |

**Soft flags — badged, still rankable** (the row may be a real opportunity, but you
must verify it in the field):

| Flag | Rule | Found |
|---|---|---|
| `no_activity` | pop ≥ 20,000 with 0 pharmacies **and** 0 applications **and** 0 approvals | 1 — «شهر مشکین دشت», pop 53,440, 0/0/0. A genuine white space nearly always shows queued applicants, so this most likely means the pharmacies are attributed to the neighbouring city (Karaj). Ranked #1 *and* badged ⚠ — deliberately, so it is investigated rather than hidden. |

A second, independent guard (`suspectPlaces()` in `web/src/lib/analytics.ts`)
re-derives anomalies from the rendered payload alone, so the board stays safe even
if rows arrive by a path that never ran the ETL flags.

---

## How the ranking works

Four dimensions, each reduced to a **percentile rank inside the peer set** (0–100),
then combined with user-tunable weights. Percentile ranking is robust to the heavy
skew in this data and needs no distributional assumptions.

| Dimension | Better when | Driven by |
|---|---|---|
| اندازه بازار — market size | larger | log₁₀(population) |
| ظرفیت خالی — head-room | less saturated | `pharmacies_per_100k` (lower is better) |
| کم‌بودن صف متقاضی — pipeline | fewer rivals queued | `pipeline_ratio` (lower is better) |
| سهولت ورود — entry barrier | lower permit threshold | `min_score` (lower is better) |

`opportunity = Σ(weightᵢ × scoreᵢ) / Σweightᵢ`, computed live in the browser.

Two scope controls:

* **مبنای مقایسه** — `national` (best slot in the country) or `province`
  (best inside your own province). Under `province`, groups smaller than 3 fall
  back to the national ranking, otherwise a one-city province would score a
  perfect 100 on every dimension.
* **حداقل جمعیت** — narrows the visible list only; component scores stay stable
  while you drag it.

Derived sizing, all documented in the UI:

* `capacityGap = population / targetPopPerPharmacy − n_pharmacy_total`
* `absorbablePharmacies = max(0, round(capacityGap))`
* `estScriptsForEntrant = population × scriptsPerCapita ÷ (n_pharmacy_total + 1)`

`targetPopPerPharmacy` auto-defaults to the **median** observed population per
pharmacy in the peer set. The economics panel's scripts-per-capita and
margin-per-prescription are **placeholders you should replace** — they are exposed
as inputs precisely so the “درآمد برآوردی” column is your assumption, not mine.

Every formula lives in `etl/views.sql` (SQL) and `web/src/lib/analytics.ts` (TS),
with the Python re-implementation in `etl/sanity_model.py` used to cross-check the
browser's numbers.

---

## Updating the data (the contract for another agent)

Everything is idempotent. Snapshots are keyed by `(location_id, observed_at)`, so a
re-run **updates in place**; a new capture time appends a new observation and
history accumulates.

```bash
# Full rebuild from every artifact in data/raw (uses the fetch manifest)
bash etl/rebuild.sh

# Drop new files into data/inbound/ and load them
python etl/load.py --scan-inbound

# Load a whole paginated crawl as ONE logical snapshot
python etl/load.py --manifest data/raw/zarfiat_manifest.json

# Fetch + load a URL directly
python etl/load.py --source "https://pharmacy.fda.gov.ir/..." --kind json --url-fetch

# Wipe and reload
python etl/load.py --reset --manifest data/raw/zarfiat_manifest.json
```

### Two pitfalls the loader now guards against

1. **Never derive `observed_at` per page from file mtimes.** A paginated crawl is
   *one* snapshot, so all pages must share the manifest's `updated_at`. Per-file
   timestamps register each page as a separate capture and build a **parallel**
   snapshot set instead of updating in place. `--manifest` does this correctly, and
   `warn_on_stale_reingest()` prints a loud warning if the same file arrives with a
   different `observed_at`.
2. **All timestamps are normalised to UTC (`...Z`).** Snapshots are ordered by a
   lexicographic `MAX(observed_at)`, so mixing `+03:30` and `+00:00` strings makes
   MAX() compare text rather than time — `12:09+03:30` sorts *after* `09:16Z`
   although it happened 38 minutes earlier.

### JSON shape accepted

Any of `[...]`, `{data:[...]}`, `{data:{records:[...]}}`, `{Data:[...],Total:n}`,
Kendo's `{data:[...],total:n}`. Field names are resolved through
`FIELD_ALIASES` in `etl/adapters.py`, so both the API's `OstanOnvan` style and the
Persian header labels work. **Any unrecognised key is preserved verbatim in the
`extra` JSON column** — nothing is ever dropped, so a new upstream field is a
re-parse away.

---

## Layout

```
etl/
  schema.sql          tables + indexes (idempotent, additive migrations)
  views.sql           every analytic definition, in one place
  adapters.py         HTML + JSON readers, field aliases, dq flags
  normalize.py        Persian digit/letter folding, place classification, keys
  load.py             CLI: the only writer
  verify_db.py        post-load assertions (fails loudly)
  rebuild.sh          full rebuild
  sanity_model.py     independent Python re-implementation of the scoring model
  audit_completeness.py  API vs offline-HTML cross-validation
web/
  src/lib/db.ts       node:sqlite access
  src/lib/data.ts     server-side payload assembly (is_market scope)
  src/lib/analytics.ts scoring model, percentile ranking, exclusion rules
  src/lib/format.ts   Persian digits/separators — the single place that decides them
  src/lib/jalali.ts   Gregorian → Shamsi date
  src/components/     Dashboard, Controls, PlacesTable, Charts, DetailPanel, …
  scripts/proof.mjs   headless Chrome proof harness (screenshots + DOM measurements)
  scripts/dom-audit.mjs  exact rendered strings + overflow/clipping audit
db/pharmacy.sqlite    the database
data/raw/             source artifacts + fetch manifest
  fda-zarfiat.html    offline save of the FDA capacity dashboard (Ahvaz view)
  نمایش تعداد داروخانه های کشور_files/   its asset folder (page needs it; keep names)
  dashboard/          the other two offline saves: country-wide + Abadan
  salname/            Khuzestan yearbook, 24 chapters (.doc + .pdf)
  zarfiat_pages/      the 13-page national API crawl (62,524 rows)
  osm/                OSM admin boundaries + places for Khuzestan
data/inbound/         drop-box for new captures
```

**Provenance.** Everything above came from one loose folder
(`Desktop/Pharmacies`, now deleted) that held three yearbook chapters and three
offline dashboard saves. The chapters were byte-identical to `salname/` 3, 18 and
21, and the Ahvaz save was byte-identical to `fda-zarfiat.html`; only the
country-wide and Abadan saves were new, and they live in `dashboard/`. Every
`*.html` loads its `*_files/` folder by hardcoded relative path — keep each pair
together and never rename them, or the page loads blank.

## The provincial yearbook (سالنامه آماری استان خوزستان ۱۴۰۳)

`data/raw/salname/` holds the province's official statistical annual: 24 chapters,
each as a `.doc` plus a `.pdf`. It matters because it is **independent of the FDA
feed** — the province publishes its own pharmacy count per county, so the feed can
be checked against an authority rather than trusted on its own.

**Getting the data out took three fixes worth knowing:**

1. **The PDFs are useless.** Their text layer is bad OCR from old typewriter-era
   census tables — «عمومی نفوس و مسکن» comes out as «ععومی فوس مسکن ربا ما ون».
   Parsing it would bake garbage into the database. Use the `.doc` chapters.
2. **Word refuses two chapters** (جمعيت, محیط زیست) with «Office has detected a
   problem with this file». That is **Office File Validation**, not File Block —
   there is no Zone.Identifier on them, and the FIB says `nFib=193` (Word 97, not
   a blocked legacy format). `word.FileValidation = 1` (msoFileValidationSkip) is
   the documented switch that opens them. Without it the *population* chapter is
   silently skipped.
3. **RAR5 names.** `bsdtar`/libarchive reads the entries but cannot decode the
   Persian filenames, so it extracts nothing. A real extractor is required;
   `tools/7z/7z.exe` is vendored for exactly this (7-Zip Extra has no RAR codec —
   the full 7-Zip `7z.exe` + `7z.dll` pair is what works).

**What it is used for.** `salname_metrics` holds 616 parsed figures: county
population and households (1395 census), pharmacies by county (1403, plus the
series back to 1385) and provincial household expenditure including a
بهداشت و درمان line. `v_county_crosscheck` puts the two sources side by side.

The result is a real cross-check. For Khuzestan's 24 matched counties the FDA's
population sums sit within **±6% of the official 1395 census** (most within ±3%),
and the FDA's 875 pharmacies against the yearbook's 803 for 1403 is right on the
yearbook's own growth trend (828 → 849 across 1402 → 1403). It also isolates the
outliers: **شوش ۱.۶۲×**, شوشتر ۱.۲۶×, ایذه ۱.۲۵×, هویزه ۰.۵× — those rows now
carry a county-disagreement warning.

Scope caveat, stated plainly: the yearbook is **county-level**, the FDA feed is
settlement-level. It corroborates, it cannot replace.

---

## Nothing is hidden (and the dataset is yours to correct)

Two behaviours were removed on request:

* **Rows are never dropped for suspect data.** `exclusionReason()` used to delete
  a row from the ranking; it is now `warningsFor()`, which returns a list of
  reasons. Every suspect row is listed, badged, and explained — and the only thing
  that hides one is the user's **«نمایش موارد مشکوک»** switch.
* **A row with an unusable population is still listed.** It cannot be scored, so
  it sorts last and carries a ⚠ badge rather than disappearing. `scorePlaces()`
  returns every place it is given.

The analysis scope also widened: any settlement holding **at least one pharmacy**
is now included, not only the `is_market` city markets. That recovered **548
settlements holding 629 pharmacies** that were previously invisible — the class
the user was pointing at. (`روستای زرگان البصره` aside, note that زرگان itself — a
district of Ahvaz — is *absent from the FDA feed entirely*; verified against the
raw JSON, not an ETL bug. Nothing can back-populate a place the source never had.)

**Manual overrides** make the dataset editable:

* `manual_override` stores your value beside the source value. Nothing is
  overwritten; clearing an override provably restores exactly what the source
  said (verified: clearing ملاشیه's override returns `fda=169, ref=16575` intact).
* Overrides **always win**, in every population mode. They are corrections, not a
  source preference — an edit that silently stopped applying depending on a toggle
  would be a trap.
* Overrides are keyed on **`loc_key`**, not `location_id`. A rebuild re-creates
  locations with fresh autoincrement ids; keying on the id would orphan (i.e.
  silently lose) every override. Verified: after a full rebuild ملاشیه's id moved
  **396745 → 462461** and the override still applied.
* Every change is journalled to `manual_override_log` with old value, new value,
  note and author, so "where did this number come from?" is always answerable.
* Write path: `POST`/`DELETE /api/overrides` (`web/src/app/api/overrides/route.ts`)
  — the only writable endpoint in the app. Field names are whitelisted, values must
  be finite and non-negative, and unknown `location_id`s are rejected with 404.

> A rebuild **does** clear `population_reference` (those rows are derived and key
> on `location_id`), so re-run `etl/enrich_population.py` afterwards. Your
> overrides are unaffected — that asymmetry is deliberate.

---

## Reference population layer (why some populations are corrected)

The FDA feed's جمعیت is wrong for a meaningful minority of settlements, sometimes
by two orders of magnitude. **`روستاي ملاشيه` in شهرستان اهواز is published with
169 people while sustaining 3 pharmacies**; the Statistical Center's 1395 (2016)
census counts **16,575** for ملاشیه یک. The feed also publishes real cities with
population 0 next to dozens of pharmacies (قرچک 0 / 43 pharmacies, ری 0 / 31).

The layer is additive and refuses to guess:

* **FDA values are never modified.** They stay on `location_snapshots` and are
  exposed as `v_population_choice.fda_population`. Both numbers ship to the
  dashboard side by side.
* **`population_reference`** holds one corroborated value per place with full
  provenance: `source`, `source_id`, `source_url`, `census_year_sh`,
  `households`, `match_score`, `match_method`, `fetched_at`.
* **Sources, in order:** Wikidata `wdt:P1082` (which for Iranian settlements cites
  `amar.org.ir`), then the census sentence — «جمعیت آن ۱۶۵۷۵ نفر (۴۴۷۴ خانوار)»
  — read from the fa.wikipedia article **resolved through the item's QID**. The
  QID is what makes the article lookup safe; a title search alone matched
  «گرجي سفلي» to an article claiming 50,000 for a village, and that is exactly
  the failure mode this design avoids.
* **A match requires name agreement AND admin corroboration** (county, else
  province, plus a province bounding box built from GeoNames). Anything less is
  left explicitly unmatched rather than given a plausible-looking wrong number.
* **Ties are broken by the newest census, then the largest population.** One FDA
  row often maps to several Wikidata items (`روستاي ملاشيه` → ملاشیه یک / دو / سه).
  Picking by iteration order silently selected ملاشیه سه's **1385** figure (265)
  over ملاشیه یک's **1395** figure (16,575); the rule is now explicit and the
  runner-ups are recorded in `match_method`.

In the dashboard, the **«جمعیت مبنای محاسبه»** switch flips every population-derived
metric — density, patients-per-pharmacy, capacity headroom, pipeline pressure and
the final score — between the two bases, live in the browser. Each row that uses a
reference value carries a «مرجع» badge, and the detail panel shows the source, its
id, the census year, the household count and the match confidence.

Two consequences worth knowing:

* Several `pop_zero` places become rankable in corrected mode, because a
  reference value resolves the defect rather than merely flagging it.
* County rollups (`v_county_rollup`) stay on FDA figures — they aggregate villages
  that have no reference value, so they cannot be fully corrected.

---

## Geographic layer (خوزستان) — what the FDA feed is missing

The FDA feed answers "how many pharmacies does this settlement have". It cannot
answer **"which places exist that the feed never lists?"** — it has no coordinates,
no standard county names, and by construction only knows what it knows.

The geographic layer answers that question for one province, from three
independent sources:

| Step | Source | What it contributes |
|---|---|---|
| Places | OpenStreetMap / Overpass | every `place=city\|town\|village\|hamlet\|isolated_dwelling\|neighbourhood` inside the province boundary, with coordinates |
| County | Wikidata (`P131`) | OSM's Khuzestan mapping has **no شهرستان polygons** — only `admin_level=6` بخش and `admin_level=7` دهستان — so the county comes from the P131 chain of each بakhsh polygon |
| Population | Wikidata `P1082` + the fa.wikipedia census sentence | read through the item's own QID, never by title search |

**Loaded today:** 2,724 named places on the map → **2,478 after de-duplication**
(OSM maps a city twice, as a node *and* as a boundary relation) → **1,647 matched**
to the FDA feed, **158 in a human-review queue**, **673 with no counterpart at all**
— the candidate new locations. 1,545 of the province's 3,150 FDA rows have no
map twin, so the two lists are complements, not duplicates.

Address resolution is cross-checked rather than assumed: every place's county is
derived twice, once from its own Wikidata P131 chain and once from the بakhsh
polygon it falls in. The two routes disagree on **9** places (0.4%) and the
disagreement is kept in `county_alt` instead of being resolved silently. All 2,478
places land inside exactly one بakhsh polygon, and none is left without a county.

### Matching rule, and why it has three outcomes

Name agreement (after folding Persian/Arabic letter variants, spacing and
harakat) **plus** county agreement. Three outcomes, because two of them are
genuinely undecidable by machine:

* **matched** — the same name in the same county, possibly spelled differently
  (`هفتکل` → the FDA's `هفتگل`; `ملاشیه یک` → the FDA's `روستای ملاشیه`).
* **variant** — a near-identical name, or an identical name under a different
  شهرستان. Iran re-draws counties (کرخه out of شوش, صیدون out of باغملک) while the
  pharmacy feed keeps the old attribution, so a county mismatch must not be
  allowed to *hide* a place; it becomes a question instead. Calling those "new"
  would overstate the discovery; calling them "matched" would invent a match.
* **new** — no plausible counterpart. Of the 25 largest such places, exactly
  **one** has a ≥0.86-similar name anywhere in the FDA feed, and it sits in a
  different county 88 km away.

### Distances and the network

Great-circle distance from اهواز for every place, plus the real OSRM driving
distance for 950 of them — fetched through OSRM's `table` service with a single
source (90 destinations per request, not 90 requests). Measured
road/great-circle ratio: **1.32**, so great-circle ranks correctly but must never
be used for travel time.

`data/derived/geo_network.json` holds the settlement network: a **minimum
spanning tree** over the 1,855 city/town/village nodes within 35 km of each other
(`scipy.spatial.cKDTree` + `scipy.sparse.csgraph`, no new dependency) — 1,854
edges forming **one single connected component** for the whole province — plus,
per place, the number of settlements and total population within 20/30/50 km.
That catchment figure is the honest size proxy for the 764 places that have no
population statement anywhere: it is a property of the surroundings, not a
fabricated number for the place itself.

### Deliverables

```bash
bash etl/rebuild_geo.sh          # fetch → admin → match → population → road → export → pages → report → audit
python etl/verify_geo_page.py    # drives the atlas in headless Chromium and measures it
```

* `reports/khuzestan-geo.md` — the layer's report: snapshot, method, audit, the
  candidate shortlist with citation links, the review queue, and the known limits.
* `reports/khuzestan-atlas.html` — self-contained page (live Leaflet map with
  filters and distance rings, the network graph, the distance ladder and the
  tables). `reports/khuzestan-atlas-widget.html` is its compact twin.
* `web/public/geo/khuzestan_places.geojson` — 2,478 points with every attribute
  (status, population + source URL, county, distance, the FDA row it matches).
* `web/public/geo/khuzestan_bakhsh.geojson` — the 67 بخش outlines, simplified to
  5,437 vertices (from 43,282) at ~150 m tolerance; the tolerance is recorded in
  the file so the map is never mistaken for the raw capture.

### Verification performed

* `etl/audit_geo.py` searches the **whole** FDA list for a name close to every
  place the loader called new — the check that decides whether "new" means new.
* `etl/verify_geo_page.py` drives the atlas in headless Chromium: it asserts the
  filtered counts on screen equal the counts in the database, that the network SVG
  actually draws its nodes and edges, that no label leaves the drawing box, that
  nothing overflows horizontally at 1440 px or 430 px, and that the console is
  clean — then writes eight screenshots to `reports/screenshots/`.
* `etl/build_geo_pages.py` parses its own generated JavaScript with `node --check`
  before writing the file (a single misplaced quote produced a page that loaded
  Leaflet and then did nothing, visible only in the console).

### Known limits

* The map's own `population` tag carries a village at **1,000,000** people
  (`دُب حردان`, 15 km from اهواز). Flagged `pop_outlier`, excluded from the
  rankings, never deleted.
* **764 places still have no population at all** — Wikidata's coverage of small
  villages is the binding constraint, not the pipeline. They are ranked by
  catchment instead, and flagged `size_unknown`.
* OSM's completeness for small settlements is unknown, which is exactly why the
  reverse count (1,543 FDA rows with no map twin) is reported next to the forward
  one. The union of the two lists is the honest inventory.
* The 312 `place=neighbourhood` objects are intra-city districts, not
  settlements; they are flagged `city_neighbourhood_not_a_settlement` and never
  counted as new locations.
* County names differ between the two sources (`باغ ملک`/`باغملک`,
  `هفتکل`/`هفتگل`, `ماهشهر`/`بندرماهشهر`); comparison folds spacing, letter
  variants and a substring test, and the raw values are always kept.
* Distances are measured from a single point (31.3203, 48.6693) — the centre of
  اهواز — not from the user's actual plot.

---

## UI conventions

Persian (RTL) throughout. **Persian digits with the Arabic thousands separator `٬`
(U+066C) and decimal separator `٫` (U+066B)** for everything you read; Latin digits
are reserved for machine-readable identifiers (file paths, hashes) and are never
used in a data cell. `format.ts` owns that decision so it cannot drift.

---

## Known limits

* **`شهر تجريش` / `شهر مشکین دشت` style anomalies are real source defects**, not
  parser bugs — verified against the raw JSON. They are flagged, not "corrected".
* **502 (province, county, place) groups appear under two different districts.**
  The source lists the same settlement name twice (e.g. «شهر گلستان» in بهارستان,
  under `بخش مرکزی` and `بخش گلستان`, with the same population 252,730 but
  different pharmacy counts). Total over-count exposure is **25 pharmacies —
  0.13%** of the national total, so it does not move any conclusion. Verified that
  **0 ShahrIDs** appear under more than one district and **0** duplicate rows
  disagree on (population, real, legal), i.e. the API's fan-out duplicates are
  exact and de-duplication on the natural key is safe.
* **Sub-district pharmacy attribution** may be incomplete around large cities:
  «شهر مشکین دشت» reports 0 pharmacies for 53,440 people, which is implausible and
  is exactly why it carries a soft warning rather than a straight #1 badge.
* The dataset is a **point-in-time snapshot**; the dashboard shows the capture date
  in Shamsi. Re-run the ETL before acting on it.
* **Reference-population coverage is partial by design.** In the current run 1,151
  of 1,322 market places (87%) resolve to a corroborated figure; the rest are left
  unmatched rather than guessed. Wikidata's coverage of small villages is the
  binding constraint, and a handful of large settlements (تهران بزرگ, شهر کرد,
  شهر جدید سهند) still fail to resolve because the source's own name matches
  nothing — those keep the FDA figure and are visible as such.
* **The reference match is only as good as the name.** Villages whose FDA spelling
  diverges from both the Wikidata label and every altLabel cannot be matched, and
  near-name matches (matched on the settlement stem plus county, confidence ≈ 0.57)
  warrant a manual glance before you commit money to one.
* `min_score` / `city_score` semantics (exact permit-scoring rule) are asserted from
  the source's column names, not from the regulation text — confirm with the FDA
  guideline before relying on the "سد اداری" dimension.
