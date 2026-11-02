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

### Administrative attribution is geometric, not by name (`etl/fix_admin_attribution.py`)

The map printed «کوی زیباشهر دزفول» at 31.3056, 48.7000 — inside اهواز, 130 km from
دزفول. It was not one bad label: **283 settlements sat more than 40 km from their own
county's centre**, because the admin parents had been attached by *name* across the
census and OSM layers, and village names repeat in every county.

Attribution is now derived from geometry. `khuzestan_bakhsh_areas.geojson` is the only
complete polygon set, so a polygon's county is the **modal county of the settlements
inside it** — 8 % of labels are wrong, so one bad row cannot move the answer. Keyed by
`osm_id`, not by name: 31 counties each have a «بخش مرکزی», and a name-keyed vote
merged four cities into one district and sent اهواز to ایذه.

```bash
python etl/fix_admin_attribution.py --check          # boundary answers, no writes
python etl/fix_admin_attribution.py                  # what would change
python etl/fix_admin_attribution.py --apply --fix-names
python etl/build_map_layer.py                        # rebuild the served layer
```

Result: **2,611 areas re-attributed**, 1 name trimmed. A name is only trimmed when it
starts with a neighbourhood word (کوی/شهرک/محله/…) *and* ends with a county it is not
in — «بیت باوی» and «کشت و صنعت کارون» are real names whose last word happens to be a
county, and trimming them would destroy them.

### Adding a pharmacy by hand (`/api/pharmacies`)

No dataset is complete, and the map is a decision tool — so a place you can see with
your own eyes must be pinnable. «افزودن داروخانه» in the toolbar turns the cursor into
a pin: click the spot, name it, save. The pin appears immediately with `source='manual'`
and counts in density, the ring table and the per-pharmacy ratio like any imported row.

Rows live in their own table, **not** in `map_pharmacy`: every ETL run rewrites that one
from Google/OSM, and a rebuild must never delete something a person verified by hand.
`/api/pharmacies` validates the same way the importer does — inside خوزستان, within
16 km of a known settlement (so `nearest_area_id`/`county` are real), and 90 m away from
any existing pin, imported or manual.

```bash
curl -X POST localhost:3737/api/pharmacies -H 'Content-Type: application/json'   -d '{"name":"داروخانه دکتر سجادی","lat":31.27783,"lon":48.61470}'
curl -X DELETE 'localhost:3737/api/pharmacies?id=3'
```

### Density is area served, not settlements per shop (`service_metric`)

The old number was residents per pharmacy **per settlement** — one shop in a 40 km² آبادی read
as «density 1», as if that one counter occupied the whole district. `etl/compute_capacity.py`
replaces it with measurements that have a denominator:

| metric | value | how |
|---|---|---|
| built-up area | **2,687 km²** | every cell holding a street vertex, from the 87 cached `streets_city-*.json` |
| inside 1.5 km of a pharmacy | **699 km² (26.0 %)** | union of discs, each cell counted once |
| population inside 1.5 km | **74.2 %** | settlement populations whose nearest pharmacy is that close |
| no pharmacy within 8 km | **668,569 people** | the honest «unserved» number |
| residents per mapped pharmacy | **10,967** | 4.78 M people, 436 pins |
| saturated pharmacies | **83** | catchment above the benchmark |

Per settlement (`v_settlement_capacity`): nearest pharmacy, shops within 1.5/3 km, its own
Voronoi footprint, `population / footprint` (real residents per km²), and `remaining` =
`population − supply × benchmark`. Supply is the **FDA register** where it is larger than the
map, because an unmapped pharmacy still exists; a city with no register row is marked
`supply_known = 0` and shows «آمار ناقص» rather than a fake 100k of unmet demand.

The benchmark is a dial, not a measurement — `/api/capacity` POST recomputes every capacity
without touching the grid, and the map recolours:

* **red** — saturated (زیاد از ظرفیت), **green** — room, **amber** — no pharmacy at all,
  **grey** — numbers incomplete.

`tools/test_capacity.py`: coverage between 2 % and 60 %, density equals population ÷ footprint,
Ahvaz (1.2 M) is saturated and absent from the «room» ranking, the benchmark dial moves the
saturated count 83 → 32 and back, and the map draws all four colours.

### «بررسی شد» is a row in the database, per user (`/api/checks`)

Two different things were being conflated, so both are now explicit:

| what you mark | table | shape |
|---|---|---|
| an area you walked (drawn polygon) | `survey_area` | polygon + km² |
| **a place you have already checked** | **`place_check`** | `(user_id, kind, ref)` |
| a place you plan to visit | `prospect` | point + status |

`place_check` takes `kind = settlement | hood` and the id — a tick on a village or a
neighbourhood, not a shape. It is scoped by `user_id` like everything else, so it survives a
refresh, a restart, and will belong to the right account when authentication lands.

On screen: a green ✓ beside the settlement dot, `✓ کوت نواصر` in the neighbourhood label, a
`✓ N بررسیشده` chip in the header, and a toggle button in the settlement card
(«علامتگذاری بهعنوان بررسیشده» ⇄ «بررسیشده — برداشتن علامت»).

`tools/test_checks.py`: the toggle writes a row with the user id, the tick survives a full
reload, a neighbourhood marked through the API shows its ✓, a second user's marks are
invisible, unticking deletes the row.

### The watch list has no cap (`/api/prospects`)

Reported as «I can only add 3 places». There was never a row limit — **priority was clamped
to 1..3**, which read as «three places allowed». Priority now runs **1-9**, the list holds any
number, and the panel stays usable as it grows:

* status filters — همه / در انتظار / بازدید‌شده / رد‌شده — with counts;
* a search box that appears once the list passes six entries;
* the priority badge is a button: click it to move a place up or down the trip;
* the list scrolls (max-h-72) instead of pushing the rest of the sidebar off screen.

`tools/test_visitlist.py` creates 14 places (priorities up to 9), checks all 14 render, filters
to the 3 visited ones, clicks a priority badge and verifies the database follows, then adds a
15th while the page is open.

### Population: every source, and a manual override that wins (`/api/population`)

The settlement card lists the four imported sources side by side — تقسیمات کشوری، ویکی‌پدیا،
فید سازمان، OpenStreetMap — marks the one currently in use, and takes a manual number when
somebody knows the place better than the feeds.

`v_map_settlement` now resolves `COALESCE(manual, admin)` and exposes `population_admin`,
`population_wiki`, `population_fda`, `population_osm`, `population_manual`. Because the gap
table, the density wash, the per-capita ratio and `rank_sites.py` all read that view, a manual
value lands in the analysis on the next request; the API also re-runs the ranking in the
background (30 s debounce) so the numbered candidates move.

Sources on file: `fda-feed` 2,898 areas · `fa.wikipedia-*` 3,202 · `osm-tag` 1,980 ·
`wikidata` 1,461. Where they disagree the card shows the disagreement instead of hiding it —
«چمران»: three sources say 33,505, OSM says 13,913.

`tools/test_population.py`: card lists the sources, the manual value wins in the view
(source becomes «manual»), the gap moves by exactly `Δpopulation ÷ target`, a re-rank fires,
and deleting restores the imported number.

### Neighbourhoods are a layer now, not an exception list (`etl/import_neighbourhoods.py`)

Reported: «کوت نواصر و کوی هادی در نقشه اسم‌گذاری نشدند». The cause was structural, not two
missing rows: the label layer read `v_map_settlement`, the **administrative** layer (شهر /
روستا). A محله is not an administrative unit, so every named neighbourhood was invisible —
`geo_places` had been holding **312 of them** all along.

```
etl/import_neighbourhoods.py            →  map_neighbourhood (312 rows, city + distance)
etl/neighbourhood_aliases.json          →  the name people use, where OSM differs
```

* labels draw from 5× as small purple names with a dot, decluttered in screen space
  (26 px) so the city core does not become a word cloud;
* `alias` wins the label slot, so «کوی هادی» is shown rather than the OSM string;
* the search box searches them too and shows a «محله:» row of chips that fly to the point;
* the map header counts them («۳۱۲ محله»).

**The two reported places**

| name | source | coordinates |
|---|---|---|
| کوت نواصر | `geo_places` (OSM neighbourhood); Google Places agrees within ~450 m | 31.2227, 48.6609 |
| کوی هادی | alias of the OSM label «هادی آباد - کوت عبداله»; Google has «هادی آباد» at the same point | 31.2249, 48.6532 |

The second is an **inferred alias**, not an independently surveyed point: no source we can
reach names a separate «کوی هادی» node. It is recorded as an alias so it is findable and
correctable — if the real extent differs, add a row to the aliases file rather than editing
code.

`tools/test_neighbourhoods.py` asserts the diagnosis (0 rows in `v_map_settlement`), the class
fix (≥300 imported), both names present, both drawn at 17×, and searchable.

### Measuring an area, and what lives inside it (`/api/measure`)

Draw a polygon → area, inhabited footprint, estimated population, density and the pharmacies
inside it. Two of them side by side answer «کوی منتظری or کوت نواصر?» with numbers instead of
impressions.

**Where the population comes from** — the surfaces the map already trusts, finest first:

| surface | cell | when |
|---|---|---|
| `urban_pop.json` | 0.25 km | inside the 86 cities that were built cell by cell |
| `pop_province.json` | 0.5 km | the rest of the province |

**Two mistakes worth recording**, both caught by testing rather than by looking:

* «residential area» was cells × cell area, which gave **3.75 km² inside a 1 km² box** — the
  population cells are not a regular lattice (they follow built-up discs). It is now the share
  of a 100 m sample grid whose nearest cell is both populated **and close**: without the
  distance test every sample found some cell somewhere and every polygon came back
  «100 % residential». کوی منتظری: 0.94 of 1.52 km² built-up.
* sampling area directly double-counted the boundary row and exceeded the polygon; the
  footprint is now a **ratio of the measured area**, so it cannot.

Arithmetic the test asserts: `density = population ÷ residential`, `residential ≤ area`,
and a larger polygon contains more people. `tools/test_measure.py` draws both neighbourhoods
through the browser, saves them, checks the comparison table and deletes one.

### Two things that belong to a person: places to visit, and ground already walked

**Visit list** — `prospect` table, `POST/PATCH/DELETE /api/prospects`. Mark a spot on the map,
name it, add a note (rent, size, phone) and a travel priority. The list is ordered by
priority; clicking the status chip walks it `برای بازدید → بازدید شد → رد شد`, which stamps
`visited_at`. Flags are drawn on the map in a shape nothing else uses.

**Surveyed areas** — `survey_area` table, `POST/DELETE /api/surveys`. Click corners to draw a
polygon; it is stored with its size in km² and drawn as a hatched blue wash with its name, so
the next trip shows at a glance which streets are already done. A wash alone reads as map
shading — the diagonal hatch is what says «a person marked this».

**Per user, without authentication yet.** Both tables carry `user_id`, every query filters by
it, and `web/src/lib/user.ts` resolves the current user — today one seeded owner
(«محمد هاشمیان»، role `owner`), shown as a chip in the header. Real accounts are a matter of
replacing that one function: the schema, the API and the UI already scope by id. The test
proves the scoping by inserting a second user's rows and asserting the owner cannot see them.

Verified in `tools/test_annotations.py` (12 checks): mark → stored with `user_id` → flag drawn
→ listed; status cycle → `visited_at` written; draw → 3 points, 6.58 km², polygon drawn;
second user invisible; delete → gone.

### A manual pharmacy moves the analysis (`tools/test_live_analytics.py`)

Reported: two pharmacies added in عین دو, and the «بیشترین شکاف» table did not move. Two
separate reasons, both found by reading the SQL rather than the screen:

1. **The views never saw manual pins.** `v_map_pharmacy_mapped` counted `map_pharmacy` only,
   so the gap, the density wash and the per-capita ratio were blind to everything a person
   added. It now unions `manual_place`, and a new `v_map_pharmacy_assigned` counts by
   `nearest_area_id` (no 3 km spill — a pin in the next village must not pay for this one).
2. **The gap used the FDA register alone.** `ph` was `pharmacy_total`, so a settlement with
   no FDA row had a gap no matter how many pharmacies stood in it. Supply is now
   `max(FDA total, assigned)` — the two count the same shops by different methods, and a
   hand-added pin exists precisely because the register missed it.

`etl/rank_sites.py` had the same blind spot for the numbered badges; it now unions
`manual_place` too. Since it is an 8 s Python build, `POST/PATCH/DELETE /api/pharmacies`
re-runs it in the background (30 s debounce) and the page polls `rankAt` until the new build
lands, then refreshes — the gap table updates immediately, the badges a few seconds later.

The test asserts the whole loop against the real database and the real page:

```
before ....... mapped 3 · gap 0.33
add pin ...... mapped 4 · gap -0.67   PASS  live view counts the new pin
              re-rank 07:14:32 → 07:14:52   PASS
page row ..... «عین دو | … | ۱۸٬۰۰۰ | ۴ | ۴٬۵۰۰ | −۰٫۷»   PASS
delete ....... mapped 3 · gap 0.33   PASS  deleting restores the gap
```

`python tools/test_live_analytics.py` — exit 0 only when every assertion holds; it removes
its own leftovers first, so interrupted runs cannot poison the baseline.

### A hand-added pharmacy is a pin, not a diamond

Every fetched pharmacy is an orange diamond. A pharmacy **you** placed is an **indigo
teardrop pin** with a white core — three independent cues at once (hue, silhouette, inner
dot), so it reads in a cluster of 400 orange markers instead of depending on foveal
inspection. Over imagery the pin takes a white rim, the same rule the street casing follows.

Legend: «داروخانهٔ دست‌افزوده (سنجاق)» next to the fetched-pharmacy entry.

Measured: 436 pharmacy markers at 16x — 433 diamonds, 3 pins, each tagged
`data-shape="fetched" | "manual"` so a test can assert the split without reading pixels.

### Unnamed pharmacies: kept, marked, and reviewable

Twelve OSM nodes carry `amenity=pharmacy` and no name. Dropping them would quietly
under-count supply in the towns they sit in; treating them like verified pins would let an
unchecked guess drive the ranking. They stay, labelled «داروخانه بدون نام», and are marked
so nobody mistakes them for confirmed:

| | |
|---|---|
| on the map | amber diamond, dashed rim, «؟» glyph above 10× |
| chip | «۱۲ بدون نام» — toggling it enters review mode |
| review mode | only those 12 pins, density wash off, settlement dots off, no merging; view frames them all |
| review list | 12 rows with settlement + distance; click flies to that pin at 16× |
| panel | warning banner: comes from OSM, nobody named it, check the satellite view |

Measured: default view 434 markers of which 12 dashed; review mode 12 markers, 0 medical
pins, 0 settlement dots, 0 density cells; clicking a row centres its pin.

They are deliberately **not** editable — an OSM row is rewritten by the next import. If one
is confirmed on the ground, add it through «افزودن داروخانه» with its real name.

### Hand-added places of any kind (`manual_place`)

A pin a person adds is not always a pharmacy: it can be a درمانگاه, a مطب, a dentist, a
hospital, a lab. `manual_place` carries a `kind`, and the map puts the row in the layer that
kind belongs to — pharmacies as orange diamonds, the rest beside the 867 imported medical
places.

```
POST  { kind, name, lat, lon, address?, phone?, note? }
PATCH { id, kind?, name?, address?, phone?, note? }   ← changing kind moves the pin's layer
```

Six kinds: `pharmacy · clinic · doctor · dentist · hospital · lab`.

Decisions worth keeping:

* the 60 m duplicate rule is **per kind** — a clinic next door to a pharmacy is normal, a
  second pharmacy on the same 60 m is a double entry;
* manual medical rows are unioned into the medical layer with **negative ids**, so they can
  never collide with an imported `map_medical` row, and the panel can still tell they are
  hand-added (`source: "manual"`);
* the old `manual_pharmacy` table is migrated in place, every existing row becoming
  `kind = 'pharmacy'` — nobody has to re-pin their own work;
* the success message after adding used to vanish in the same tick that cleared the form.
  The pin and the form now stay; `لغو` closes them.

Verified in a browser: adding a lab through the UI wrote `kind='lab'`; switching that row to
`pharmacy` moved it into the pharmacy layer (+1 diamond, 434 → 435) and back out; the panel
select reads `clinic` for a clinic and saves a change to `dentist` into the database.

### Hand-added pins: edit and delete (`PATCH /api/pharmacies`)

A pin somebody added by standing in front of a shop can be wrong — a typo in the name, the
pharmacy next door, the one that closed. Clicking it now opens the panel with **ویرایش** and
**حذف**, and only for `source = 'manual'` rows:

```
PATCH /api/pharmacies  { id, name, address, phone, note }   → updates that row
DELETE /api/pharmacies?id=<id>                              → removes it
```

Imported rows get no buttons on purpose: `map_pharmacy` is rebuilt from Google/OSM on every
ETL run, so an edit to one of those would disappear without saying so. Coordinates are not
editable from the panel either — a pin at the wrong place should be deleted and re-added,
which keeps `nearest_area_id`, `county` and the density ring honest instead of silently
skewing them.

Verified in a browser: draft prefilled from the row, save persists (`داروخانه آزمون ویرایش`
→ `داروخانه آزمون — نام اصلاحشده`, phone `0611111111` → `0612222222`), reload shows the new
name, delete removes the row and closes the panel, and a Google row (`poi/1910340621`)
offers neither button.

### Satellite tiles are local (`/api/tile/[z]/[x]/[y]` + `etl/prefetch_sat.py`)

The imagery used to be fetched straight from ArcGIS by the browser, so every pan and every
reload paid a round trip to the internet. It now goes through our own route, which stores the
tile on disk the first time and serves it from there forever:

```
web/src/app/api/tile/[z]/[x]/[y]/route.ts   →  data/tiles/sat/<z>/<x>/<y>.jpg
etl/prefetch_sat.py --zooms 8-13            →  warm the province before you look
```

Measured: `x-tile-cache: miss-stored` on first view, `disk` afterwards, and **0 requests to
`server.arcgisonline.com` from the browser**. The route refuses to cache a placeholder
(z19 over خوزستان answers 200 with a ~2 KB stub), so a blank tile cannot freeze onto the map.

Prefetched province, z8–13: **2,355 tiles / 38 MB (z8–12), z13 in progress** — the store is
gitignored because it is derivable, and it lives outside `web/public` because files written
under public are copied at build time and would 404 in production.

Deep zoom past z13 caches itself the first time you look; a whole-province z14 would be
~570 MB, which is not a download anyone asked for.

### The LLM audit: what the rules were confidently wrong about

The rules are the first pass, not the last word. `python etl/classify_with_llm.py --run --audit`
sends **every** row to the model — including the ones the rules accepted — because a
keyword rule that says «داروخانه» cannot know that «داروخانه دامپزشکی» is a veterinary
chemist and «داروخانه گیاهپزشکی» sells crop spray.

Result over 1,223 rows: **1,207 verdicts above the 0.85 floor (93 %**, against 1 in 10
before the prompt carried the source table and a calibration scale).

```
applied: 5 moved to medical · 756 re-affirmed · 47 deleted
map_pharmacy 460 → 428 · map_medical 880 → 865
```

What it removed: 12 veterinary/herbal «pharmacies» (دامپزشکی، گیاهپزشکی), herbalists, and
shops named after a customer rather than a business. What it rescued: real pharmacies that
had been filed as medical — `Dr.Zerafatfard Pharmcy`, `داروخانه دکتر راسخ`,
`داروخانه دکتر سردارزاده` — i.e. supply we were not counting when ranking sites.

Two durable consequences, so the model is not needed twice for the same mistake:

* `دامپزشکی` was already a hard negative; `گیاهپزشکی` was added, and `reclassify_places.py`
  now agrees with the model (**0 further deletions**) — rules and LLM are in sync.
* the prompt carries the source table as prior and a calibration scale, so «Dr. Kazemi»
  scores 0.90 instead of 0.80. A model that answers 0.8 for everything is a model you
  cannot threshold.

### Village lanes: the other half of the street network (`etl/build_rural_streets.py`)

Half of OSM's residential ways in خوزستان lie outside every city disc, so no file contained
them and whole districts rendered as bare imagery. They are now shipped **per county** (and
per 0.25° tile inside the big ones), loaded only when the view needs them:

```bash
python etl/build_rural_streets.py          # → web/public/geo/rural_<slug>.json + index
```

**68,470 ways · 9.4 MB total · largest single file 2.6 MB · 78 index entries**, built from
the tiles we already had, simplified to ~50 m. Assignment is by the **nearest settlement's
county**, not point-in-polygon over 31 shapes: cheaper, and a lane between two counties
belongs to the one whose village it serves.

Two mistakes worth recording, both caught by counting:

* a 3-cell county lookup dropped **38,952 ways (37 % of the province)** — the plains have
  stretches more than 27 km from any settlement. The search now widens to 1.2°.
* ways already in a city file are skipped by their endpoint signature, so the county layer
  and the city layer never paint the same line twice.

Measured in the rural corridor between ملاثانی and اهواز: village lanes and connecting
tracks now link nearly every settlement (previously only the main roads). Still patchy —
OSM is thin there, and single connector lines are not street grids.

### Why a town showed no streets (three different answers)

«ملاثانی has streets, the district next to it has none» — measured, and it was three
separate things:

1. **One street file at a time.** The loader fetched the file nearest the *view centre*
   only, so every neighbour within the same screen rendered as bare imagery. It now takes
   every city whose disc intersects the viewport (max 6, cached), merged into one layer:
   ملاثانی at 13× went **540 → 2,366** polylines, a between-towns view **25,382**, south
   اهواز **30,240**.
2. **Contrast, not data.** ملاثانی's file really holds **175 of its 270 ways within 1 km**
   of the centre, but they were drawn 1 px in `#8a9bad` with a white casing — invisible over
   imagery and under the density wash. Over satellite the body is now `#f8fafc` on a dark
   casing, 0.6 px wider, and the density opacity steps back to 0.45 above 6×.
3. **A real data gap, and the big one:** **52,773 of OSM's 104,986 residential ways (50 %)**
   lie outside every city disc and are in no file at all — village lanes and town outskirts.
   The connector layer covers tertiary/unclassified only, so those lanes exist in OSM, cost
   us nothing to fetch, and are simply not shipped. Building them is the next real gain
   (~8-10 MB, or one file per county loaded on demand).

### Deep zoom on satellite imagery (`tools/test_satellite_zoom.py`)

`MAX_ZOOM` was 40, which put the map at ~12 m/px — Esri zoom 14, «an aerial photo», not «I
can see the roof». Detail is a function of the scene scale (194 units per degree), so the
ceiling is now **600×** (~0.84 m/px) and the tile loader follows:

* zoom requested up to **18**, with `devicePixelRatio` in the formula (a 2× screen needs one
  more step to look sharp);
* **19 is excluded** — measured: over خوزستان it answers `200` with a **2 KB placeholder**,
  not imagery. z18 is real (17–24 KB);
* forced to 18 from 300× — rounding the formula down there is what made deep zoom look
  upscaled;
* tile cap 64 → **200**: at z18 the screen needs ~99 tiles, so the old cap left 27 % of the
  frame blank at 300× (100 % coverage now);
* a missing tile falls back to its **parent** instead of showing a hole;
* the density wash **fades out above 80×** (0.45 at 80–200, 0 past 200). At building scale one
  500 m cell covers the whole screen and its teal fill was acting as a colour filter over the
  photo.

```bash
python tools/test_satellite_zoom.py --shots
```

Eight zooms from 8× to 600×, asserting: tiles present, the zoom actually requested, ≥95 %
coverage, and that density cells, streets, markers and labels all still render — because
zooming deeper must not cost a decision layer. All pass; screenshots in
`tools/shots/satzoom/`.

Honest limit: Esri's z18 over اهواز is roughly 0.6–1 m/px and partly older capture, so
individual buildings and courtyards read, cars and sharp shadows do not. Google's imagery is
denser but Iran is in Google's Prohibited Territory for Maps Platform, so it is not an option
for a real deployment — Neshan is the compliant path once its tile service is enabled.

### Markers must sit on their own coordinate (`tools/test_marker_accuracy.py`)

«The marker does not match the address» has two very different causes and they need
different fixes:

1. **geometry** — the marker is drawn somewhere other than its lat/lon. Every pharmacy and
   every recommendation now carries `data-lat`/`data-lon`, and the map exposes
   `__khz.screenOf(lat, lon)`; the test compares each drawn marker's centre against that
   projection. Worst offset across three views: **0 px**.
2. **labelling** — the recommendation is a *demand cell*, not a town centre, so a badge 4 km
   from اهواز was captioned «اهواز». Candidates are now snapped to the **population peak of
   their own catchment** (زرگان کرانه 0.02 km, کوی زیباشهر 1.16 km), and every label prints
   the distance: «اهواز (۴٫۵ کم از مرکز)».

```bash
python tools/test_marker_accuracy.py --shots
```

The first version of this test reported offsets of 230–4,600 px and was wrong: it applied the
SVG's screen matrix without the scene group's own `translate/scale`. Fixing the test is what
turned «the map is broken» into «the map is correct» — worth writing down, because the next
person will make the same mistake.

### Roads must exist at every zoom (`tools/test_roads_zoom.py`)

Three layers can carry a road: `roads` (motorway…secondary, province-wide), `connectors`
(tertiary/unclassified) and `streets` (one city's network). «The roads jump when I zoom»
was three separate things, all measured with a zoom ladder at four places:

1. **A gate at 1.25×** dropped the entire road network when zooming back out to the
   province view. Roads now draw from **1.0×**, connectors from **1.0×** as well.
2. **The 3.9 MB connector file was fetched only once the view passed 1.4×**, so the roads
   popped in mid-zoom. It loads at mount now.
3. **The city street file started at 2.5×** and drew at 3.2×; it now loads from 1.6×.

The first version of this test reported 56 «missing» levels that were not missing — it was
measuring a half-loaded map (1.5 MB of roads, 3.6 MB of connectors, 1 MB of streets). The
map now exposes `data-ready="1"` on `g#scene` when its data has landed, and the test waits
for the layer it is about to assert on.

```bash
python tools/test_roads_zoom.py              # 15 zooms × 4 places, reload each time
python tools/test_roads_zoom.py --transition # wheel-zoom, no reload, the reported case
python tools/test_roads_zoom.py --shots
```

Result: a road is painted at **every** zoom from 1.0× to 28×, at اهواز, ویس, دزفول and an
open highway point — and stays painted through a wheel transition from 1.6× to 40× and back.

### Where to open (`etl/rank_sites.py`)

The map is descriptive until this runs. It scores every candidate over a 1.2 km catchment
and writes `site_candidate`, which the map draws as numbered badges (layer «پیشنهادهای
مکانی») with the components on click.

    gap       residents per *accounted* pharmacy  (mapped + FDA residual × 0.85)
    anchors   doctors + 1.4·clinics + 2·hospitals + 0.5·labs within 1.2 km
    density   demand per km²
    access    1 / (1 + road_km to اهواز / 60)
    score     0.45·gap + 0.25·anchors + 0.15·density + 0.15·access

Three rules keep the list honest:

* **FDA residual** — 372 licences the feed has but nobody geocoded are placed around their
  settlement and counted at 0.85, because a town with 9 licensed and 2 mapped pharmacies is
  a *mapping* gap, not an opportunity;
* **no duplicates** — kept candidates are ≥ 3 km apart; the first run listed three points
  800 m apart and called it a top three;
* **county cap** — six per county, or the answer is «wherever the people already are».

Two data bugs this exposed and fixed: `pop_province.json` held one 0.5 km cell with
**343,270 people** (a city whose disc was mostly owned by the finer surface dumped its whole
census into the few cells left; a 5.5 km bucket rounding did the same to villages), and
veterinary pharmacies were counted as competition.

### Roads between towns (`etl/build_connectors.py`)

`fetch_province_streets.py` keeps only what lies inside each city's disc, so a town's own
lanes were there but the tertiary road leaving it was not — ویس had 287 ways inside 6 km
and read as stranded. The province roads file carries motorway…secondary only.

`build_connectors.py` writes every tertiary / unclassified / living_street way in the
province into one 3.9 MB file (19,693 ways, simplified to ~20 m) and the map draws it from
**1.4×**, under the city streets. Measured in ویس at 12×: 287 town streets + **310
connector ways**, i.e. the roads to شجیرات and the کوت سیدسلطان corridor are back.

The per-city radius now has a floor of **6 km** (was `0.9·√(pop/1000)`, so ویس got 3.5),
because the roads that connect a town leave it well inside its built-up radius.

### Full screen is a different layout, and it was half-empty

`preserveAspectRatio="xMidYMid slice"` crops, so in full screen the visible scene box is
**wider than the 660×820 viewBox**. The density grid and the satellite tiles were both
built from `W`/`H`, which meant they covered only the central band of a landscape window
and the edges looked unloaded — the map «didn't load completely».

Both now take their bounds from `visibleBox()` (screen matrix → scene coordinates), and
`isFull` is in their dependency lists so a resize recomputes instead of keeping the old
geometry.

```bash
python tools/test_map_layers.py --fullscreen
```

Four full-screen cases, each also re-run after the viewport is resized to 1740×1180
(full screen on a different monitor is a resize, and that is where stale pixel geometry
shows up): entered full screen · map fills its container · `slice` cropping · density
cells render and **span ≥ 90 % of the map width** · streets · markers · labels ·
imagery covers 100 % with no gaps · layers in order · no page errors.

Measured after the fix at 9× in full screen: grid spans **1,438 of 1,466 px (98 %)**;
before, the same window would have put it in a ~660 px band (45 %).

The first version of this test proved nothing: it pressed Escape to close the layer
popover, and the component listens for Escape to *leave* full screen — so every
assertion ran against the normal layout. The popover is toggled before entering now.

### Layer test (`tools/test_map_layers.py`)

The map is hand-drawn SVG, so «the streets disappeared» can be four different bugs: the
layer is off, the component returned null at this zoom, the city's street file never
loaded, or something opaque is painted on top. Every layer group now carries a
`data-layer` attribute and the test reads the paint order straight from the DOM.

```bash
python tools/test_map_layers.py                 # 10 cases, screenshots → tools/shots/layers/
python tools/test_map_layers.py --only ahvaz-12x
```

For each case it asserts: the zoom the deep link asked for was applied; labels,
pharmacy markers and density cells render; street polylines exist where a city has a
street file (11,299 in اهواز, 4,994 دزفول, 1,256 رامهرمز) and are absent where none
exists; satellite tiles load and the streets survive on top of them; imagery paints
first and labels last; no page errors. Exit 1 on any failure.

It found the real gap immediately: streets were **fetched from 5× and drawn from 4.5×**,
so the 3–4.5× band — the first zoom after the province view — showed density cells over
imagery with no streets at all. Fetching now starts at 2.5×, drawing at 3.2×, and
panning past a city's disc no longer blanks the streets that are still on screen.

### Satellite base (`layers.sat`)

The map is hand-rolled SVG, so the imagery is too: the visible scene box is inverted
to lat/lon, the Esri World Imagery zoom whose native resolution matches the screen is
picked (`z = log2(pxPerDeg · 360 / 256)`), and each tile is projected to the rectangle
its corners fall on. 64 tiles maximum, clipped to the province outline.

* attribution «تصویر: Esri · Maxar · Earthstar Geographics» stays on screen — the
  provider's terms require it and a hidden credit is no credit;
* with imagery on, the vector land fill, the grey «no supply» density wash and the
  boundary strokes step back so the photo is readable — they were covering exactly the
  built-up blocks the layer was switched on to show.

### Why pharmacies were missing from the map

`--provider google` searched **one 20 km bias circle per city and stopped at 3 pages
(60 results)**. اهواز has ~340 pharmacies in the FDA feed and 90 on the map: the cap,
not the city, decided what was found. `داروخانه سجادی` (31.27783, 48.61470) is in
Google, is typed `pharmacy`, and was simply past result 60.

```bash
python etl/import_pharmacies.py --provider google --grid-km 2 --pages 2   # every city
python etl/import_pharmacies.py --provider google --city اهواز --grid-km 2 --pages 2
```

`--grid-km` replaces the circle with a grid of centres inside each city's built-up
radius, `--pages 2` per centre, and the cache key becomes the **centre**, not the city
— without that, the first cell's answer was reused for the whole city.

### Secrets: what is in the repo, and the check that keeps it that way

Keys live **only** in `db/pharmacy.sqlite` (`app_setting`), which is git-ignored, and the
database is never read by the browser — `/api/settings` returns a masked tail.

```bash
python etl/verify_no_secrets.py            # full audit, exit 1 on any finding
python etl/verify_no_secrets.py --quiet    # gate a push
```

Six assertions, each one a mistake somebody has actually made: credential shapes in
**every** commit; the exact stored values (a regex can miss a key format, an exact
search cannot); `db/*.sqlite`, `data/raw`, `data/derived`, `.env` never added; the
ignore rules still present; `/api/settings` returning only «••••••••last4»; and no key
material in `web/.next/static`, which is public by definition.

Audited at 34 commits: no key in history, none in the bundle, 0 vulnerabilities in the
production dependency tree. Two things worth knowing rather than fixing: the commit
author email is public (`mohammadhashemian@…`), and no API route authenticates — fine
for a local tool, not fine if this is ever deployed publicly.

### Judging the hard tail with a model (`etl/classify_with_llm.py`)

The rules settle what the name says. They cannot settle `Dr. Sadeghi`, `بگا`,
`مرکز مشاوره پیوند مهر` or `خوزستان دزفول صفی آباد` — 114 rows today. Those go to a
model over **OpenRouter**, with the key and the model name stored in `app_setting`
from `/settings` (key masked to its last four characters, model shown as typed).

```bash
python etl/classify_with_llm.py                 # count + sample, no key needed
python etl/classify_with_llm.py --run           # call the model, cache verdicts
python etl/classify_with_llm.py --run --apply   # move/delete after judging
python etl/classify_with_llm.py --check         # offline: prompt + parser self-test
```

The prompt asks for one JSON array — role plus confidence — and names the traps
(عطاری is not a pharmacy, تجهیزات پزشکی is not a hospital, a street called داروخانه is
a street). Verdicts land in `poi_classification(src, ref, name, role, confidence,
model, prompt_v)`, keyed by model, so a re-run costs nothing. `--apply` touches only
`confidence >= 0.85`: a pharmacy judged to be a doctor's office moves to the medical
layer, `irrelevant` is deleted, everything else waits.

`/api/settings/test` verifies both halves without a key: the model id is checked
against the live OpenRouter catalogue, and the key is checked with `GET /api/v1/key`
(a wrong key comes back 401 with OpenRouter's own reason).

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

### Streets for all 86 cities (`etl/fetch_province_streets.py`)

`fetch_urban_detail.py` asks Overpass once per city, which is fine for one city and
hopeless for a hundred: the public mirrors rate-limit within seconds (`osm.ch` is a
Swiss extract and answers every Iranian bbox with an empty 200; `kumi` and
`private.coffee` time out; `overpass-api.de` is the only reliable one, at ~45 s a
query). A hundred sequential queries is six hours for data that is one query away.

```bash
python etl/fetch_province_streets.py --fetch   # 16 tiles, ~15 min, resumable
python etl/fetch_province_streets.py --split   # tiles → per-city files + cells
```

Sixteen boxes cover خوزستان; each way is simplified (~9 m) and handed to **every**
city whose radius contains it (nearest-only starved small towns). Output:

* `web/public/geo/streets_<slug>.json` for **86 cities** — 49,565 segments, 8.9 MB,
  drawn above 4.5×;
* `urban_cell(lat, lon, street_m)` per city — the weight for the 250 m surface;
* `data/derived/street_raster.json` — 500 m street metres for the **whole province**,
  206 k cells, which is what gives villages a real footprint instead of a kernel guess.

Cities with no OSM residential coverage stay out of the index; the map falls back to
the 1 km surface there, so nothing renders as empty.

### Population surface for the whole province (`etl/build_pop_province.py`)

The 250 m `urban_pop.json` needs a city's street network, so it only exists for the
cities fetched so far (اهواز). Everything else knew «settlement X holds N people at
this one point», which is what the per-pharmacy ratio looked like it ignored outside
اهواز.

`build_pop_province.py` spreads every settlement's census population over a 0.5 km
grid, weighting each cell by

* **OSM street metres on the cell** (from `street_raster.json`), which is what
  actually follows a village's shape,
* `40 m × (1 - d/r)^2` as the floor inside the settlement's built-up radius `r`
  (2.5–12 km, the same rule as the residential mask) and +1.5 per mapped POI,
* and never on a cell the finer 250 m surface already owns.

```bash
python etl/build_pop_province.py          # → web/public/geo/pop_province.json
python etl/build_pop_province.py --cell-km 0.5
```

Result: **31,725 cells at 0.5 km, 3.72 M of 4.78 M people placed**; the other 1.06 M
lives on cells the 250 m file owns (all 86 surveyed cities). The map loads both and sums whichever
covers a cell, so «نفر به ازای داروخانه» now paints from the province view down to a
village's outskirts.

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
  src/lib/dashboardStats.ts  held-out rows + header aggregates (one pass each)
  src/lib/otc.ts      buying-power index + the out-of-pocket (بدون نسخه) model
  src/lib/format.ts   Persian digits/separators — the single place that decides them
  src/lib/jalali.ts   Gregorian → Shamsi date
  src/components/     Dashboard, Controls, PlacesTable, Charts, DetailPanel, …
  src/components/dashboard/  Header, ScopeBar, DataNotes (parts of Dashboard)
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
