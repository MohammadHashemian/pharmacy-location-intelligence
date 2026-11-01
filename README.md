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

Six dimensions, each reduced to a **percentile rank inside the peer set** (0–100),
then combined with user-tunable weights. Percentile ranking is robust to the heavy
skew in this data and needs no distributional assumptions.

| Dimension | Better when | Driven by |
|---|---|---|
| اندازه بازار — market size | larger | log₁₀(population) |
| ظرفیت خالی — head-room | less saturated | `pharmacies_per_100k` (lower is better) |
| تحمل داروخانهٔ جدید — tolerance for one more | more patients per pharmacy *after* we open | `population / (committed + 1)` (higher is better) |
| کم‌بودن صف متقاضی — pipeline | fewer rivals queued | `pipeline_ratio` (lower is better) |
| سهولت ورود — entry barrier | lower permit threshold | `min_score` (lower is better) |
| قدرت خرید محل — buying power | richer catchment | the OTC index below |

Head-room asks how crowded the place is *today*; tolerance asks what it looks like
*the day after we open* — the only state we would actually trade in. Its denominator
counts **committed** pharmacies, not open ones: a permit that already holds
موافقت‌اصولی opens whatever we do, so it splits the market exactly like an open
pharmacy (`n_pharmacy_committed = real + legal + approved`). The same `committed + 1`
denominator drives the entrant script and OTC estimates. A 5,000-person town with one
pharmacy scores 5,000 patients per pharmacy today, but 2,500 once we are the second
pharmacy; a 20,000-person town with four pharmacies gives up far less
(5,000 → 4,000). Head-room and tolerance are therefore weighted 10/20 each by
default: they measure nearly the same thing, and the post-entry one is the decision
being made.

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

## The out-of-pocket basket — «فروش بدون نسخه»

Half of a pharmacy's business is not in the FDA feed at all. Insured prescriptions
are paid by an insurer at a regulated margin; the part that actually decides
whether a pharmacy thrives is the **out-of-pocket basket** — cosmetics, hygiene,
supplements, OTC drugs — and its size depends on how well-off the catchment is,
not on how many people live in it.

Which breaks the population-only ranking. In this run:

| place | kind | population | buying power | OTC per head | local market |
|---|---|---|---|---|---|
| جنت مکان | شهر | ۵٬۳۶۰ | ۰٫۹۲ | ۲۵٫۱ M ریال | ۱۳۴٫۶ bn ریال |
| ای جنگیه | روستا | ۴٬۶۴۴ | ۰٫۵۴ | ۱۲٫۵ M ریال | ۵۷٫۹ bn ریال |

Same size, **half** the out-of-pocket basket. That is the whole reason for the
layer, and it is now a fifth scoring dimension (default weight 20%) and a money
column (فروش بدون نسخه = the marginal entrant's share).

### What is measured, what is assumed

| Input | Value | Where it comes from |
|---|---|---|
| rural vs urban household spending | ۰٫۵۹۶ | **measured**: سالنامه ۱۴۰۳ خوزستان، ۱٬۵۶۰٬۸۷۳ ÷ ۲٬۶۱۸٬۴۶۰ |
| county urbanisation | ۰٫۰۸ … ۰٫۹۹ | share of the county's people in a city / a place ≥ ۱۰٬۰۰۰ / a place with ≥ ۳ pharmacies (`v_place_prosperity`) |
| persons per household | ۳٫۶ (شهری) / ۳٫۹ (روستایی) | census 1395, at province level; per-settlement when `population_reference` is loaded |
| OTC+cosmetics share of consumption | ۲٪ | **assumption**, exposed as an input |
| price growth since 1403 | ۱٫۸× | **assumption**, exposed as an input |
| income elasticity | ۱٫۳ | **assumption**, exposed as an input |

So the *shape* of the index is measured and the *level* of the money is the
user's. That asymmetry is deliberate: the dashboard ranks places on measured
structure, and prints money only from a number the user can replace.

### The model

`lib/otc.ts`, pure functions, cross-checked by `etl/sanity_model.py`:

```
power  = urbanity × county_urban × household × agglomeration
         normalised so the population-weighted mean is exactly 1.0
         (1.3 = "about 30% richer than the national average")

perCapita = base × power^elasticity
market    = population × perCapita
yourShare = market ÷ (n_pharmacies + 1)      ← entry splits demand, it never creates it
```

Each factor is bounded (0.85–1.20, 0.85–1.15, 0.85–1.15) so no single freak
input can invent a rich village, and all four are printed in the detail panel —
the number is auditable, not opaque.

**This run:** buying power spans ۰٫۴۲ … ۱٫۱۱, model market ۱٬۴۶۶ هزار میلیارد
ریال/yr (≈ ۹۴٫۵ میلیارد ریال per existing pharmacy), «برخورداری» displayed as a
percentile so it sits next to the other four dimensions without pretending to be
an income measurement.

### In the main dashboard list

The dashboard reads `v_place_full`, i.e. the FDA feed. The administrative layer
feeds it in two controlled ways, and neither invents a pharmacy number:

* `etl/link_admin_places.py` copies every Khuzestan city and every village of
  3,000+ people that the feed never listed into `locations` (+ one snapshot with
  `population` only). They carry `dq_flags = no_fda_data`, are shown with `—`
  instead of a pharmacy count, are badged «دادهٔ FDA ندارد», and are **never
  ranked** (`analytics.ts` keeps them out of the percentile baseline). The row
  stays because a place you can name must not be invisible.
* The list itself now keeps **every city** regardless of the population floor,
  and Khuzestan villages of 3,000+ people even when the feed reports no pharmacy
  for them. A settlement with no pharmacy *and* no applicant is listed but not
  scored — that pattern is as often an attribution gap as a real white space.

```bash
python etl/link_admin_places.py --min-village 3000   # idempotent
```

### Density: where the count actually goes

The FDA feed counts pharmacies per *settlement*, not per address, so the raw
overlay painted one city's 341 pharmacies onto a single centroid and every cell in
the window inherited the same number — inside اهواز, کیانپارس and an empty
outskirt looked identical.

The count is therefore **redistributed over the pharmacies that are actually
mapped**: each mapped point carries `settlement_total / n_mapped`, which keeps the
provincial total exactly (884) and puts the weight where the stores are; a
settlement with nothing mapped keeps its whole count on the centroid. Same rule on
both sides: `etl/build_map_layer.py` for the region grid, `KhuzestanMap` for the
zoom-dependent grid.

Two consequences worth knowing:

* the fine grid measures **pharmacies per km²** (a spatial question), not
  residents per pharmacy — population is known per settlement only, so a per-capita
  ratio is flat across a city by construction;
* the residential mask grows with population (`0.9·√(pop/1000)` km, 2.5–12 km),
  because a 1.2 M city is an area, not a 1.5 km dot;
* colour is capped at the 95th percentile, otherwise one dense block washes every
  other district to the palest step.

### Expected vs located pharmacies

The FDA count is *expected* supply; the map has *located* supply. Both are now used,
and never double-counted:

* `located` — a pharmacy with a coordinate (OSM/Neshan/Google), weight 1 at its point;
* `residual` — `FDA count − located in that settlement`: they exist, we do not know
  where, so they enter the fine grid as a **density per km² spread over the town's
  built-up disc** (`0.9·√(pop/1000)` km, 2.5–12 km) instead of stacking on a centroid;
* `located + residual = FDA count`, so the provincial total (894) is preserved and a
  district with no survey still shows the background its town implies.

Every settlement tooltip/card shows the split — جمعیت, داروخانه (FDA), نقشهشده,
بدون موقعیت — and the header chip reads «۸۹۴ داروخانه در فید سازمان · ۴۱۹ روی نقشه».

### What counts as a pharmacy or a clinic (`etl/classify_poi.py`)

Google's `types` are not trustworthy in Iran: a tire shop came back as
`medical_clinic` and a bag shop as `pharmacy`. Every importer now asks one
classifier, which weighs evidence in this order:

1. hard negative **type** — `tire_repair`, `car_repair`, `supermarket`, `bank`,
   `street`, `locality` … nothing rescues those;
2. hard negative **name** — پنچر, لاستیک, آرایشگاه, عطاری, تجهیزات پزشکی,
   کالای دندانپزشکی … (whole-word for short tokens, so «مهد» does not fire inside
   «مهدی پور» and «فرش» not inside «فرشته»);
3. positive **name** — بیمارستان › دندانپزشک › آزمایشگاه › درمانگاه/کلینیک ›
   پزشک/مطب › داروخانه, most specific first;
4. **types** when the name is neutral («دکتر رضایی» vs «رضایی»);
5. the query role, as a weak last resort. Everything else stays `unknown` and is
   not mapped.

Strong medical words beat a weak negative (`کلینیک … بیمه تامین اجتماعی` is a clinic
that belongs to an insurer), but never a hard one (`تجهیزات پزشکی` stays out).

```bash
python etl/verify_classifier.py            # 42 fixtures + a live audit
python etl/reclassify_places.py            # report what the stored rows really are
python etl/reclassify_places.py --apply    # delete the wrong, re-kind, move doctors out of the pharmacy layer
```

### Urban detail: streets and a population surface

The province layer knows where people live to the settlement, which is too coarse
inside a city. Two urban layers close that gap, both fetched per city and cached in
`data/derived/urban/<slug>.json`:

```bash
python etl/fetch_urban_detail.py --cities 6      # streets + building centres
python etl/fetch_urban_detail.py --rebuild-cells  # recompute cells from the cache
python etl/build_pop_surface.py                   # census population → cells
```

* **streets** — `highway=tertiary|residential|unclassified|living_street` inside
  6 km of each city centre, simplified to ~9 m and written to
  `web/public/geo/streets_<slug>.json`. The client fetches the one city the view is
  centred on, only above 4.5×, and draws it under the arterial network.
* **population surface** — each city's census population is spread over a 250 m grid
  in proportion to **street metres** per cell (the built-up proxy with real
  coverage here), with a floor of 20 % of the mean so an unmapped block is not a
  desert. Building footprints are fetched too and used as the fallback basis;
  OSM has 3.8 k of them for a 1.2 M city, i.e. 308 people per building, which is why
  streets — not buildings — carry the weight. Output: `web/public/geo/urban_pop.json`.

The analytical mode «نفر به ازای داروخانه» divides that population surface by the
pharmacy supply (located + the FDA residual surface) on the same 1.5 km kernel:
**blue = well covered, red = many residents per pharmacy**, i.e. where the gap is.

### Pharmacy profiles and the demand side

Two more tables sit beside the map layer:

| table | what | filled by |
|---|---|---|
| `pharmacy_profile` | Google's public record per pharmacy: rating, review count, phone, website, hours, up to 5 photo references, editorial summary | `python etl/enrich_pharmacy_profiles.py` |
| `map_medical` | clinics, doctors, dentists, hospitals, labs (875 places) | `python etl/import_medical_services.py` |

```bash
python etl/enrich_pharmacy_profiles.py            # only places without a profile
python etl/import_medical_services.py --check
python etl/import_medical_services.py --pages 1   # 87 cities x 4 types, cached
```

* **Click a pharmacy** on `/map` → profile card: photo, ★ rating and review count,
  phone, website, hours, «باز کردن در گوگلمپ», and the competition block — how many
  pharmacies and how many medical places sit within 1 km, with a blunt verdict
  (`اشباع` at 5+ pharmacies, `فرصت` when care is dense and pharmacies are not).
* **Deep links** make a card shareable: `/map?pharm=<osm_type>/<osm_id>` and
  `/map?med=<map_medical.id>`.
* Photos go through `/api/place-photo?name=places/…/photos/…` — the key never
  reaches the browser, and only photo resource names are accepted.
* One pass costs ~600 Google events: free-tier for both SKUs, but Iran is still a
  **Prohibited Territory** (see above) — Neshan/OSM remains the compliant source.

### Known limits of the layer

* **No income per settlement exists in any loaded source.** The index is
  structure — urbanisation, household size, agglomeration — not money. A rich
  village next to a poor one with the same shape will rank alike.
* `hh_size` is `NULL` for every row until `etl/enrich_population.py` has been
  run (the reference layer is derived and a rebuild clears it). `NULL` is treated
  as *no information* (factor 1), never as an average.
* **Not modelled, on purpose:** distance to a metropolis, foot traffic,
  competitor positioning, insurer mix, the cosmetics market's brand structure.
  They are listed in the panel as omissions rather than folded in as fake
  precision.
* The yearbook anchor is **Khuzestan's**. Outside the province the ratio is still
  applied, and the UI says so; the level applies nationally because the model is
  relative.

Two guards keep it honest:

```bash
python etl/verify_otc.py     # the inputs: one row per place, bounded shares, sane anchor
python etl/sanity_model.py   # the model: normalised mean, bounded range, entrant ≤ market
```

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
  src/lib/otc.ts      buying-power index + the out-of-pocket (بدون نسخه) model
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

### The atlas's three added layers

The app at `/map` is the interactive product; the atlas is the single file you can
open from disk with no server. Both answer the same question, and the atlas gained
the three pieces the app gets from its own layer:

* **دهستان on every place** — `etl/enrich_place_dehestan.py` casts the same
  even-odd ray over the 188 `admin_level=7` relations of the raw Overpass capture
  and writes `dehestan` + `dehestan_method` into `khuzestan_places.geojson`:
  **2,478 of 2,478 places** assigned, 2,362 inside exactly one polygon, 115 inside
  two (resolved to the smallest area, never silently picked), 1 outside all. Every
  popup now prints استان › شهرستان › بخش › دهستان › روستا.
* **density where people live** — `etl/build_geo_density.py`: a 3.3 km grid kept
  only where a settlement is within 2.5 km, each kept cell carrying population and
  pharmacies within 10 km, density per 10,000 and the gap against the provincial
  basis (**4,768 residents per pharmacy**). 2,083 cells; desert, marsh and ridge
  have none, so the overlay cannot colour empty ground. The two `pop_outlier`
  places (دُب حردان 1M, کوله جاز 450k) are zeroed first — left in, they swallowed
  the whole province inside one 10 km window and faked a "159-pharmacy gap" beside
  اهواز.
* **expansion search from اهواز** — the «گسترش از اهواز» tab: a network-distance
  radius dial, a population floor, and a table sorted by network distance (or by
  gap) with a «نقشه» button that jumps to the place. Network distance is Dijkstra
  from اهواز over a proximity graph (5 nearest neighbours + everything within
  10 km), **0.85× the real OSRM road distance** on the 510 places that carry both —
  so it understates the drive, and the tab says so. 1,835 of 1,855 nodes are
  reachable; the rest print «—» rather than a guess.

Both new steps sit in `etl/rebuild_geo.sh` after `export_geo_map.py`, because the
export rewrites the GeoJSON and the دهستان assignment must be re-applied to it.

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

## Administrative layer (خوزستان) — every settlement, not just the ones with a pharmacy

The FDA feed lists a settlement only once a pharmacy (or an application) exists
there, and it names a بخش but never a دهستان. So «how many people live in
ام‌الطمیر?» had no answer anywhere in `locations`. The administrative layer
answers it for the whole province and is the **inventory of places**, independent
of the pharmacy feed:

| Level | Rows | With population |
|---|---:|---:|
| شهرستان | 31 | 22 |
| بخش | 94 | 54 |
| دهستان | 258 | 112 |
| شهر | 100 | 99 |
| روستا / آبادی | 5,405 | 4,240 |

`ام‌الطمیر` (5,004) is in the tree, as are the smaller villages around it.

### Where each level comes from

* **شهرستان / بخش / دهستان / شهر + their 1395 populations** — the
  «تقسیمات کشوری» table on each fa.wikipedia county article. That table is the
  only public source that states a دهستان together with its population, and it
  exists even for counties whose own article is a stub (24 of 31 counties have
  it; the rest fall back to Wikidata).
* **روستا** — the {{جعبه اطلاعات روستای ایران}} infobox on 3,363 village
  articles (استان/شهرستان/بخش/دهستان/جمعیت/کد آماری), then Wikidata for the
  villages Wikipedia has no article for, then the FDA feed and OSM for the rest.
  A village that only one source knows still gets a row — that is the point.
* **Coordinates, QID, article** — Wikidata (`P131*` from Q241119, `P1082`,
  `P625`). Wikidata's «شهر» class is *not* trusted to promote a place to city:
  شهر status comes from the list article and the county tables only.

### Nothing is overwritten, and everything is dated

```
admin_import        one row per ingest (label, observed_at, sha256s, counts)
admin_area          stable identity: kind, name, parent, current denormalised path
admin_area_version  the state of that area during [valid_from, valid_to)
admin_population    one row per (area, source, census year) during [valid_from, valid_to)
admin_area_alias    every spelling seen, with the source that used it
admin_area_link     which FDA location / OSM place this area is (many-to-one)
```

A re-ingest never edits a row: it closes the open version at `valid_to` and
opens a new one. Asking *«what did the tree look like yesterday?»* is a
`WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`, not a restore.
Areas that vanish from a snapshot are closed, never deleted.

### Four sources, four numbers

Each source's population is stored separately, and the view picks the value most
sources agree on (`v_admin_area_current`), so one article's typo — دزفول's county
figure printed on the city row — cannot outvote the other three. All four values
remain queryable, with census year and confidence.

### Mapped pharmacies — where an existing pharmacy actually is

The FDA dashboard gives a **count per settlement** and no coordinates; it cannot
put a pharmacy on a map. OSM does: `amenity=pharmacy` is a surveyed point. Both
layers are kept, never merged:

| | |
|---|---|
| `map_pharmacy` | one row per mapped pharmacy: osm id, name, lat/lon, nearest settlement, distance |
| `v_map_pharmacy_mapped` | pharmacies within 3 km per settlement |
| `khuzestan_pharmacies.geojson` | the same points as GeoJSON (54 KB) |

```bash
python etl/fetch_osm_pharmacies.py   # Overpass, cached in data/raw/osm/
```

**Coverage is the honest part:** OSM has **108** pharmacies in خوزستان against the
**884** the FDA counts — 12%, concentrated in the well-mapped cities (اهواز 20,
دزفول 17, ماهشهر 15, باغملک 10 …). The layer is therefore labelled
«داروخانههای نقشه» and never presented as the complete set. A few OSM entries are
mislabelled institutions («شبکه بهداشت شیبان» tagged as a pharmacy), which is why
the popup shows the raw OSM name.

The Overpass bbox reaches into Iraq and Kuwait: **115 of the 223** points returned
sat across the border (Umm Qasr, Basra) and would have made خرمشهر the densest
pharmacy county in the province. Points are filtered by the province outline
before they reach the database.

To complete it, the same pipeline accepts any point-of-interest source — Google
Places (`places:searchNearby`, needs a billing key, ~$10 for the province), Neshan
or Map.ir (Iranian POI data, free tier with a key). Each returns name + point;
`build_map_layer.py` then matches them to settlements and the map draws them the
same way. Nothing else has to change: `map_pharmacy` is the contract.

### Commands

```bash
python etl/fetch_admin_khz.py     # fa.wikipedia payloads -> data/raw/wiki/*.json (cached, --refresh to refetch)
python etl/load_admin.py          # parse + load, date-banded; idempotent (2nd run: added 0, changed 0)
python etl/report_admin.py        # reports/admin_khuzestan.{md,csv,xlsx}
python etl/verify_admin.py        # invariants: one open version per area, parents, positive population, links
```

### Known limits

* 1,165 villages still have no population: no village article and no `P1082`.
  They are listed with `population NULL`, never guessed.
* Populations mix census years (1385/1390/1395) because that is what each
  article states; `population_year_sh` carries the year, and the 1395 figure is
  preferred when both exist.
* A handful of names arrive concatenated by the source tables («اهواز الهایی»);
  the loader splits them, but the underlying article is still wrong.
* New counties (کرخه، صیدون، دزپارت، ابوالعباس) exist in the tree, but villages
  in them are thinner than in the older counties — Wikipedia's coverage, not the
  loader's.
* The app renders it at **`/places`** (linked from the dashboard header): the
  whole tree, expand-all, search that folds ZWNJ/spacing («ام الطمیر» =
  «امالطمیر»), and per-place population by source plus the pharmacy count rolled
  up from the linked FDA rows. `tools/verify_places.py` drives it in a browser
  and asserts the rendered row count equals the database.

---

## Map layer (خوزستان) — settlements, population, pharmacy density and distance from اهواز

`/places` proves the tree exists; it cannot answer *«how far is this village from
اهواز, and where do I have to go before a site makes sense?»*. The map layer
answers that and nothing else, from data already in the database:

| Table / view | Grain | Contents |
|---|---|---|
| `map_point` | settlement | resolved coordinate, straight line, OSRM road distance when measured, graph distance, ring, graph hops |
| `map_edge` | undirected pair | the spanning tree the map draws (n−1 edges) |
| `map_density` | residential grid cell | population + pharmacies within 10 km, density per 10k, gap |
| `map_import` | one row | parameters, calibration, counts, build time |
| `v_map_settlement` | settlement | the administrative row + the **live** FDA pharmacy counts + the distances |

Counts and populations are **not copied** into the map layer: `v_map_settlement`
joins `v_admin_area_current` and the live FDA snapshot, so a new `load.py` or
`load_admin.py` shows up on the next page load. Only the computed distances and
the density grid are materialised (a Dijkstra is not a `WHERE` clause).

### Distance from اهواز — three numbers, each labelled

1. **road** — 635 places carry a real OSRM driving distance from the OSM layer.
2. **network** — Dijkstra from اهواز over a proximity graph of the settlements
   (5 nearest neighbours each + everything within 10 km, edges capped at 45 km
   so a straight line across the desert cannot become a "road"), then multiplied
   by the measured median `road/network` ratio (**1.174** over 635 places).
3. **straight** — the great-circle fallback, used only for a settlement outside
   the graph.

`map_point.dist_source` records which one each row is, the UI prints it next to
the number, and a driving distance *shorter* than the straight line is rejected
as a name collision in the OSM link (4 cases) instead of being plotted.

### Density only where people live

A ~3.3 km grid is built over the settlement extent and a cell is kept **only if a
settlement is within 2.5 km**; cells with no population inside the 10 km window
are dropped as well. Desert, salt flats, the marshes and the Zagros ridges
therefore have no cell at all — the overlay physically cannot colour empty
ground. Each kept cell carries population and pharmacies in the window, the
density (`pharmacies / population × 10 000`) and the gap against the provincial
baseline (5,408 residents per pharmacy in this dataset).

### Commands

```bash
python etl/fetch_osm_roads.py                   # once: Overpass roads -> data/raw/osm (cached)
python etl/build_map_layer.py --check           # ~5 s: graph, density, polygons, roads, asserts
node web/scripts/proof-map.mjs                  # headless Chrome: screenshots + interaction assertions
node web/scripts/proof-zoom.mjs                 # zoom ladder: symbol size, labels, grids, probe
node web/scripts/probe-map-layout.mjs URL W H   # layout/overflow/label-size audit at any viewport
```

It writes `web/public/geo/khuzestan_bakhsh_areas.geojson` (67 filled بخش
polygons with label anchors), `khuzestan_dehestan_areas.geojson` (188 دهستان
outlines) and `khuzestan_outline.geojson` (the province silhouette, computed as
the edge-parity union of the بخش polygons — internal borders appear twice and
cancel). The polygons are stitched from the raw Overpass relations, which arrive
as unordered member ways: `etl/khuzestan_bakhsh.geojson` is a LineString soup
because the atlas only strokes it, and a filled map needs closed rings.

### App

**`/map`** (linked from the dashboard header). SVG only — no tile server, no map
library, so it works offline and every pixel is accounted for:

* **zoom to 40×** on a 660×820 frame (~25 km across the screen at the deepest
  level). Every symbol is drawn at a **constant screen size** (dot radius ÷ zoom,
  `vector-effect: non-scaling-stroke`), so a city is a 6 px marker at every zoom
  instead of a 300 px blob;
* **two density grids**: the 3.3 km province grid below 3.4×, and above it a
  **1 km grid recomputed from the settlement list over the visible box only**
  (population and pharmacies within 3 km, cells kept where a settlement is within
  1.5 km). The coarse grid is not merely faded — it is removed;
* **roads as context** (`khuzestan_roads.geojson`, motorway/trunk/primary/secondary
  from Overpass), culled to the viewport and to the class the zoom needs, drawn
  under the points so a site can be judged against the road it sits on;
* **labels that survive zooming**: sized in CSS pixels, counter-scaled by zoom,
  chosen from what is *in view* — counties → بخش → دهستان → every settlement,
  with the pharmacy count once the label has room, and the شهرستان added when a
  village name repeats (30 places are called «مرکزی»);
* **«تحلیل یک نقطه»** — click anywhere and the map answers the actual question:
  population, pharmacies, persons-per-pharmacy and gap inside 1 / 2 / 5 / 10 km,
  rings drawn on the map, plus the nearest settlements as clickable chips;
* the spanning tree can be drawn, so the network distance is traceable;
* a radius dial from 10 to 300 km, ring ladder (0–25 … 300+), search over
  name/شهرستان/بخش/دهستان, and a candidate table sorted by distance or by gap;
* the detail panel prints the full path (استان › شهرستان › بخش › دهستان), the
  population with year and source, pharmacy counts, persons-per-pharmacy, the gap
  against an adjustable target, and all three distances with their provenance;
* a kilometre scale bar that follows the zoom, and a card sized so it fits the
  viewport (`calc((100vh - 360px) * 0.805)`).

### Verification performed

`python etl/build_map_layer.py --check` asserts, in one run: 3,677 plotted rows,
>200 density cells, no cell without population, no cell outside 29–33.5°N /
46.5–51.5°E, every distance ≥ its straight line, exactly one zero distance
(اهواز), the pharmacy sum equals `v_map_pharmacy`, 67 بخش polygons, >170 دهستان
polygons and a province area between 55,000 and 75,000 km².

`node web/scripts/proof-map.mjs` drives real Chrome and reports the DOM back:
3,685 circles, 2,742 density cells, 68 filled paths, 30 labels with **0
overlapping bounding boxes**, 408 table rows, no horizontal overflow; then it
hovers a dot (tooltip shows اهواز · ۳۴۱ داروخانه · ۰ کیلومتر), clicks it (detail
panel opens with the same figures), clicks a ring row (radius 300 km, table
re-scoped), toggles the layers (3,676 network lines appear, 0 admin paths when
off), zooms (transform `scale(1)` → `scale(2.25)`, labels 30 → 79) and searches
(rows 408 → 226). `next build` compiles the route as a partial prerender.

`node web/scripts/proof-zoom.mjs` drives the + button through 1× → 25× and
prints, per level: settlement markers **17 px at every zoom**, labels 26 → 73 →
96 → 116, the coarse grid disappearing above 3.4× (2,742 → 226 → 72 rects as the
fine grid takes over), and the point probe returning
`۱ کم ۰ آبادی · ۲ کم ۳ · ۵ کم ۹ · ۱۰ کم ۱۹`. Screenshots land in `web/shots/`.

`probe-map-layout.mjs` sweeps the breakpoints and prints the numbers the layout
must satisfy: **no horizontal overflow at 390 / 768 / 1024 / 1280 / 1568 / 1920**
(`scrollWidth == clientWidth`), the four cards inside their grid, and labels that
render at a constant **18 px line box** at every width. Two defects it found and
this fixed: the portrait SVG's intrinsic width widened a 390 px viewport to
510 px, and the 720 px candidate table did the same at 768 px — both were missing
`min-w-0` on the grid children. Labels are sized in CSS pixels (measured from a
`ResizeObserver`) rather than viewBox units, so they stay legible on a phone, and
their collision boxes follow the text baseline instead of the anchor point.

### API keys — `/settings`

The optional POI providers need a key, and a key is a secret: it is entered in the
app at **`/settings`**, stored in `db/pharmacy.sqlite` (`app_setting`), read only
by the server, and **never sent to the browser** — the page receives a masked tail
(«••••••••7890») and nothing else. `تست کلید` calls the provider from the server
(«داروخانه» within 5 km of اهواز) so a wrong key fails there, with the provider's
own message, instead of silently at import time.

| | |
|---|---|
| `app_setting` | `key`, `value`, `updated_at` — the only table the app writes besides `manual_override` |
| `/api/settings` | GET status (masked) · POST save/clear |
| `/api/settings/test` | live check against نشان `/v1/search` or Google `places:searchNearby` |
| `etl/import_pharmacies.py` | reads the stored نشان key, searches «داروخانه» per city, writes `map_pharmacy` with `source='neshan'` |

An import survives `build_map_layer.py`, which only replaces `source='osm'` rows.
Two things to know: the key lives in the database, so deleting/rebuilding
`db/pharmacy.sqlite` deletes it (re-enter it at `/settings`), and it is stored in
plain text — the file is gitignored, but it is not encrypted at rest.

نشان's Search API is **`/v3/search?q=<url-encoded JSON>`** (docs, 1404):
`q = {"term", "center": {"latitude", "longitude"}}`, `Api-Key` header, **max 30
results per request**, ordered by distance from the centre and with no paging — so
a province-wide import is a grid of search centres, deduped afterwards.
`/v1/search` and `/v4/search` are retired (485 / 404).

Two point services exist and a key is bound to the one chosen at creation, so the
importer probes **both** and uses whichever answers:

```bash
python etl/import_pharmacies.py --check     # prints "nearby" or "search", or the 485 fix
python etl/import_pharmacies.py --fixture data/sample/neshan.json   # offline pipeline
python etl/verify_import.py                 # 30 assertions, no network
```

Errors seen in practice and what they mean:

| code | meaning | fix |
|---|---|---|
| 480 | `API Key not found or is not valid` | wrong/rotated key |
| **483** | `API Key type not suitable for this service` — a **web**/SDK key (`web.…`) was stored; SDK keys are bound to a browser domain and refuse every server call | create a key of type **سرویس** (`service.…`) |
| **485** | `Api Key services not match` — the key is scoped to another service (e.g. reverse geocoding works, search does not) | create a key for **جستجو / Search** in the Neshan panel; their docs say activation needs a **support ticket** |
| 481/482 | quota / rate limit | wait or upgrade the plan |

### Google Places (New) — implemented, but read the legal line first

The importer speaks Google too (`--provider google`), because the pipeline is the
same once a provider returns `lat/lng/name`:

```bash
python etl/import_pharmacies.py --provider google --check
python etl/import_pharmacies.py --provider google --dry-run --limit 5
python etl/import_pharmacies.py --provider google            # 87 cities, ≤3 pages each
python etl/import_pharmacies.py --provider google --refresh  # ignore the centre cache
```

Every answered centre is cached in `data/derived/<provider>_poi_cache.json`, so a
run that dies at city 60 resumes at 60 instead of paying for 1…59 again.

* **Key**: `/settings` → the **Google Places** row. Create it in Google Cloud:
  enable **Places API (New)**, attach a **billing account**, then restrict the key
  to Places API (New) with **no HTTP-referer restriction** (this is a server call).
* **Cost** (list price, per 1,000 events): Nearby Search **Pro** and Text Search
  **Pro** both carry **5,000 free events a month**, then **$32**. A full Khuzestan
  run is ~90–260 calls → **$0** inside the free cap; `--min-pop 2000` roughly
  triples the calls and still fits.
* **Legal**: Iran is a **Prohibited Territory** in Google's own terms
  ([`maps-prohibited-territories`](https://cloud.google.com/maps-platform/terms/maps-prohibited-territories):
  China, Crimea, Cuba, Donetsk, **Iran**, Luhansk, North Korea, Syria, Vietnam).
  Google Maps Core Services may not be used to build or distribute an application
  for that territory, and a billing account cannot be opened from Iran. Use this
  provider only if the deployment is genuinely outside those terms — otherwise
  Neshan (Iranian) or OSM is the correct source.

### Known limits

* **1,828 of 5,505 settlements have no coordinate** and are not plotted — they are
  counted and reported, never placed at a guessed position. Most are villages
  whose Wikipedia article carries no `P625`.
* The graph distance is a **lower bound of the road**; the calibration makes it an
  estimate, not a measurement. Where accuracy matters, use the 635 measured rows.
* Pharmacy counts are the live FDA snapshot: `0` means *not in the feed*, which is
  not the same as *no pharmacy there* (the yearbook counts a few more per county).
* The مساحت figures in the polygon files are planar approximations at Khuzestan's
  latitude, used only to drop slivers and to sanity-check the outline.
* 31 شهرستان exist in the administrative tree; one of them (ابوالعباس) has no
  settlement row with a coordinate yet, so its ground shows no dots.

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
