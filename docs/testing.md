# Testing

Two suites, deliberately split by what they can prove.

| suite | command | covers | speed |
|---|---|---|---|
| unit | `cd web && npm run test:coverage` | `src/lib/**`, `src/app/api/**` | ~6 s |
| end-to-end | `python tools/test_*.py` | the pages a person actually uses | ~30-90 s each |

## Unit suite (vitest)

```
cd web
npm run test            # 103 tests
npm run test:coverage   # + coverage report, fails under the thresholds
```

Coverage (v8, measured on 2026-11-03):

```
Statements  83.1%   Branches 65.6%   Functions 87.0%   Lines 84.4%
```

Thresholds in `vitest.config.ts`: 70 % lines / statements / functions, 60 % branches.

**What is measured, and what is not.** `src/lib` and `src/app/api` run in Node, so v8 can
measure them honestly. `src/components` are React trees that only exist inside a browser; the
Playwright suite in `tools/` exercises them end to end, and counting them here would report 0 %
for files that already have behavioural tests. `src/lib/db.ts` is excluded for the same reason —
it is three lines around `node:sqlite` and every test goes through it.

**Every test runs against a copy.** `tests/setup.ts` copies `db/pharmacy.sqlite` to
`web/.tmp-tests/pharmacy.<pid>.sqlite` — one per worker, because two workers copying an 80 MB
file at once fails with EBUSY on Windows — and points the app at it via `PHARMACY_DB`. A test
that writes cannot touch the owner's data.

Files:

| file | proves |
|---|---|
| `format.test.ts` | Persian digits, separators, `tick()` never leaves a Latin dot |
| `analysis.test.ts` | OTC buying power, percentiles, held-out rows, header summary |
| `scoring.test.ts` | population modes, outliers, `scorePlaces` determinism and invariants |
| `loaders.test.ts` | the three page loaders against the real schema |
| `api.test.ts` | every route, including the refusal paths (400s) |
| `routes-misc.test.ts` | photo proxy validation, tile zoom bounds, key-check refusals |

## End-to-end suite (Playwright, python)

Each script starts from the running dev server (`npx next dev -p 3737`), drives the real page
and asserts on the DOM. They are the only proof that a feature is actually usable.

```bash
python tools/test_decision_flow.py     # badge → reason → shortlist → share → reopen
python tools/test_density_fine.py      # 200 m cells, no absurd ratios, legend
python tools/test_opportunity.py       # the capital never shows as «opportunity»
python tools/test_capacity.py          # coverage metrics + benchmark dial
python tools/test_font_sizes.py        # type size is container-independent
python tools/test_annotations.py       # visit list + surveyed areas, per user
python tools/test_visit_order.py       # unlimited list, drag to reorder, no priority dropdown
python tools/test_per_user_visits.py   # two users, two lists, one table
python tools/test_fixture_isolation.py # cleanup cannot reach the owner's data
```

### The rule that costs the most to break

**A test deletes only rows it created.** Cleanup goes through `tools/_fixtures.sweep()`, which
takes rows whose name starts with `آزمون` and nothing else; tests that touch user tables call
`snapshot()` first, which copies the database (after a WAL checkpoint) to `db/snapshots/`,
keeping twelve. `test_fixture_isolation.py` exists because this rule was learned the hard way:
two tests used to `DELETE` every row the API returned, which erased seven surveyed areas and a
visit list.

## Adding a feature

1. Write the ETL or API change.
2. Add the unit test that would fail if it regressed (route refusal paths count).
3. Add or extend an end-to-end script if a person sees it.
4. `cd web && npm run test:coverage && npm run typecheck && npm run build`.
5. Run the affected `tools/test_*.py` against a live server.
