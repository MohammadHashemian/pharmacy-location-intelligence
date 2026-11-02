# /map reviewed against the goal: pick a pharmacy location with confidence

Honest assessment, written after measuring the page rather than remembering it. Numbers are
from the running app and the database, not estimates.

## What the page is today

| | |
|---|---|
| component size | `KhuzestanMap.tsx` 3,579 lines · 18 `useState` · 27 `useMemo` · 20 buttons |
| controls on one screen | **47** (buttons, selects, inputs) |
| text on the page | 27.5 KB (no sections — one `<h1>`, no headings below it) |
| data shown | 3,677 settlements · 434 pharmacies · 865 medical · 111 ranked cells |
| first paint (dev, unminified) | ~10 s to `data-ready` |

## What is genuinely good

1. **Honesty is built in.** 1,828 settlements without coordinates are counted and never
   guessed; the page says so. Supply figures name their source. A wrong pin is treated as
   worse than a missing one.
2. **The numbers are live.** Gap, density and ratio read views, not snapshots: a hand-added
   pharmacy moves them on reload, and the ranking re-runs behind the scenes.
3. **The map does not lie about resolution.** Streets from 3.2×, satellites to z18, density
   fading where a cell would cover a street — each layer says what it is.
4. **Offline-ish.** Tiles cached locally, 147 MB, so panning is not a network bet.
5. **Deep links + CSV.** `/map?lat=…&lon=…&k=…&pharm=…` works, and the candidate table
   exports.

## The one structural flaw

**There are two recommendation systems with different logic and no bridge between them.**

- the sidebar table ranks **settlements** by «gap = population ÷ target − supply»;
- the numbered badges rank **population cells** by a weighted score (demand, supply, anchors,
  access, density).

They disagree by construction, and the page never says so. The «کوت سید صالح» incident —
a badge sitting 4.4 km from the town its label named — was this flaw surfacing. A user who
cannot reconcile two recommendation lists stops trusting both.

Worse: **the badges cannot be inspected.** `site_candidate.reason` already holds a readable
sentence for every candidate:

> «34,329 نفر در ۱٫۲ کم · 0 داروخانه · 1.4 امتیاز درمانی · 13 کم از اهواز»

…and nothing in the UI renders it. The site layer is `pointerEvents="none"`, so the ranked
recommendations are 111 unclickable dots.

## Prioritised fixes

### P0 — make a recommendation inspectable (smallest change, largest trust gain)

1. **Click a badge → detail card**: rank, score, the stored `reason`, the four score
   components (demand, supply mapped/expected, anchors, access), the nearest three
   competitors with names and distances, and the settlement it belongs to with the offset.
   Everything needed is already in `MapData`; this is UI work, not modelling.
2. **Say which number is which.** Per settlement row, tag supply as «فید سازمان»,
   «نقشهشده» or «دستافزوده», and population with its year and source. `ph` is now
   `max(FDA, assigned)` — that is defensible, but the reader must be able to see which side
   won.
3. **One vocabulary.** Either label the two lists explicitly («گزینه در سطح آبادی» vs
   «گزینه در سطح بلوک جمعیتی») or drop the settlement ranking and derive everything from
   cells. Silence is the current, and worst, option.

### P1 — turn a candidate into a decision

4. **Shortlist + compare.** Star a candidate, keep 3–5, compare side by side on demand,
   supply, anchors, access, score. Persist in `manual_shortlist` (SQLite) so it survives a
   reload and can be printed.
5. **Shareable state.** The URL carries lat/lon/zoom and a selected pharmacy, but not mode,
   radius, target or the selected candidate. A decision that cannot be sent to a partner is
   half a decision.
6. **Uncertainty, at least a range.** Score is a point estimate built on an estimated
   population and an incomplete pharmacy register. Show «±» from the population confidence
   and the count of FDA-only rows with no coordinates — the two biggest error sources.

### P2 — quality of the signal itself

7. **Access is still a radius.** `road_km` comes from a settlement graph; a 15-minute walk
   isochrone would match how a customer actually chooses. OSRM is free and local.
8. **Anchor quality, not count.** A 20-bed clinic and a 400-bed teaching hospital both add
   «1». Weight by beds/specialty where the data allows, otherwise say it is a count.
9. **Competitor quality.** Five small pharmacies ≠ five busy ones. Ratings and review counts
   are already imported — show them next to the count.
10. **Performance at province zoom.** 30k street polylines + 2.4k density rects in one SVG.
    Canvas for the wash and quantised polylines would cut the first paint measurably.

### P3 — the honest limits to state in the UI

11. Demand is residential population, not prescriptions. Traffic, rent, frontage, competitor
    loyalty and the FDA's own licensing density are not in the model. A one-line «what this
    model does not know» under the ranking would do more for trust than another feature.

## What I would do first

Items 1 and 2, in one small PR: clickable badges with the reason sentence and a
source-tagged supply figure. That converts 111 anonymous dots into inspectable
recommendations using data already on the page — the cheapest possible improvement to the
question «should I open a pharmacy here?».


---

## What shipped (P0 + P1)

| item | what a user can now do | test |
|---|---|---|
| P0.1 | click any numbered badge → popup with score, **the stored reason sentence**, the four components, and the pharmacies you would compete with | `tools/test_site_panel.py` |
| P0.2 | see where each count came from: «فید» (FDA) or «نقشه» (mapped/hand-added), population year and source | `tools/test_labels_and_sources.py` |
| P0.3 | two lists named by their unit — «کمبود داروخانه» (per settlement) vs «پیشنهاد در سطح بلوک جمعیتی» (0–1 score) | `tools/test_labels_and_sources.py` |
| P1.4 | shortlist 2–5 candidates and compare them side by side; the numbers are a snapshot, dated | `tools/test_shortlist.py` |
| P1.5 | the URL carries mode, radius, target and the open candidate — a decision can be sent to a partner | `tools/test_url_state.py` |
| P1.6 | every score shows its span «0.52 (0.32–0.63)»: one competitor opens, population off by a fifth | `tools/test_score_range.py` |
| — | the whole journey in one run: badge → reason → shortlist → compare → share → reopen | `tools/test_decision_flow.py` |

Still open, deliberately: P2 (walk isochrone instead of a 3 km circle, anchor quality, competitor
quality, canvas rendering at province zoom) and P3 (state the model's blind spots in the UI).
