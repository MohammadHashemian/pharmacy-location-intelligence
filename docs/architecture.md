# Architecture

A single SQLite file is the contract between three layers. Nothing else is shared.

```
   OSM / Google / FDA feed / street tiles
                 │
                 ▼
   etl/*.py  ── writes ──►  db/pharmacy.sqlite  ── reads ──►  web/ (Next.js)
   (offline, python)        tables + views                    (server loaders → RSC → client)
                 │                                                │
                 └──────────── data/tiles/sat (satellite) ◄───────┘  /api/tile
```

## 1. ETL — `etl/` (Python, offline)

The ETL owns every derived table. It is safe to re-run: each script drops and recreates what it
writes, and nothing the user typed lives in those tables.

| script | writes | why it exists |
|---|---|---|
| `import_*.py` | `map_pharmacy`, `map_medical`, `admin_area`, … | ingest OSM / Google places / the FDA register |
| `classify_poi.py` | `poi_classification` | rules first: is this POI a pharmacy at all? |
| `classify_with_llm.py` | `poi_classification` | the LLM audit for the rows the rules are unsure about |
| `rank_sites.py` | `site_candidate` | gap / anchors / access score per cell |
| `compute_capacity.py` | `service_metric`, `settlement_service`, `pharmacy_catchment` | coverage of the built-up area, capacity per settlement |
| `density_grid.py` | `density_cell` | 200 m cells: residents per pharmacy within an 800 m walk |
| `opportunity_grid.py` | `opportunity_cell` | unmet demand per cell — «کجا جا هست» |
| `prefetch_sat.py` | `data/tiles/sat/**` | satellite tiles on disk, one network call per tile ever |
| `area_report.py` | `area_report` | one town: supply, medical, streets, unmet demand, scored corners, written analysis |
| `fetch_area_osm.py` | `web/public/geo/streets_area-*.json`, `area_poi` | the road network and health POIs for a single bbox |

Convention: **a wrong number is worse than a missing one.** A settlement without a coordinate is
counted, never guessed (`nMissingCoord`); a pharmacy without a name is shown but excluded from
classification; a city with no register row is marked `supply_known = 0` instead of «zero
pharmacies».

## 2. Database — `db/pharmacy.sqlite`

Two kinds of table, and the difference matters when rebuilding:

* **Derived** — everything the ETL writes. Dropping and recreating is normal.
* **User-owned** — `prospect` (visit list), `survey_area` (drawn areas), `measurement`,
  `shortlist`, `manual_place`, `manual_override`, `place_check`, `population_manual`,
  `app_setting`, `app_user`. The ETL must never delete these, and a test must never sweep them.

Views resolve what the UI reads: `v_map_settlement` (COALESCE manual → admin population),
`v_map_pharmacy_mapped` (register + hand-added pins), `v_settlement_capacity`,
`v_latest_snapshot`, `v_place_full`.

## 3. Web — `web/` (Next.js 16, App Router)

```
src/app/**/page.tsx        server components; each calls one loader
src/lib/*.ts               loaders + analysis, no React
src/app/api/**/route.ts    the write paths and the viewport endpoints
src/components/*.tsx       client components; receive plain JSON only
```

* **Settings** — `lib/settings.ts` (map keys) and `lib/llm.ts` (provider → base URL → model →
  key) are the only readers of `app_setting`. Both return a masked status to the browser, and
  `classify_with_llm.py` resolves the same `llm_*` rows, with the legacy `openrouter_*` pair as
  a fallback. Chat bodies always set `stream: false` (9Router streams otherwise) and every
  reader parses tolerantly — plain JSON, a JSON body with `data: [DONE]`, or real SSE chunks.
* **Loaders** (`loadDashboardData`, `loadMapData`, `loadAdminData`) run SQL and return plain
  objects. `node:sqlite` returns null-prototype rows, so `lib/db.ts` re-homes every row onto
  `Object.prototype` before it crosses the server → client boundary.
* **Read vs write**: pages read through loaders; anything the user changes goes through an API
  route, then `router.refresh()`. There is no client-side store and no localStorage — a reload
  re-reads the database.
* **Per user**: `lib/user.ts#currentUser()` is the only place identity is decided. Every
  annotation table carries `user_id` and every query filters on it, so authentication only has
  to replace that function.
* **Regional report**: `/report/<area_id>` renders `area_report.payload`, built by
  `etl/area_report.py`. The numbers are computed (SQL + street geometry); the model only writes
  the prose, and its text is post-processed so no `key=value` leaks into a Persian page.
* **Big computed surfaces are fetched per viewport** (`/api/density?bbox=…`) rather than shipped
  with the page: 80,000 cells would triple the payload to draw a corner of it.
* **Analytic assistant (experimental)**: `POST /api/chat` runs a bounded tool loop
  (`lib/agent.ts`) over four read-only tools (`lib/agentTools.ts`) — overview, the
  dashboard's own `scorePlaces()` ranking, schema, and one capped `SELECT`. The model
  writes prose only; every number comes from the database, and `query_sql` opens a
  separate `readOnly` connection, so a bad instruction cannot write. Replies carry the
  tool trace, and `web/tests/agent.test.ts` proves the fence and the loop.
* **Table filters are client state over the rows already shipped** (`lib/tableFilter.ts` +
  `PlacesTable`). Clicking a header opens a panel with an `از/تا` range (numeric columns) or a
  substring + value pick list (text columns); it narrows the visible list only, so the score and
  the «رتبه» column still describe the whole compared set. There is no round trip and no SQL —
  the filter predicate is unit-tested, the panel is proved in `web/scripts/proof-table-filter.mjs`.

## Numbers that must stay true

| invariant | where |
|---|---|
| 5,505 settlements · 3,677 plotted · 1,828 without a coordinate | `map_meta`, header chips |
| supply = `max(FDA register, mapped pins)` | `v_map_pharmacy_mapped`, `settlement_service.supply` |
| a column filter narrows the rows, never the score | `lib/tableFilter.ts`, `web/scripts/proof-table-filter.mjs` |
| the saturated core of اهواز is never an «opportunity» | `tools/test_opportunity.py` |
| full screen does not change type size | `unitsPerPx` in `KhuzestanMap`, `tools/test_font_sizes.py` |
| a test never deletes a row it did not create | `tools/_fixtures.py` |
