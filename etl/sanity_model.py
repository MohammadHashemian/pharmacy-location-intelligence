"""Independent re-implementation of the dashboard model, in Python.

If this agrees with what the web app prints, the TS model is doing what it says.
Deliberately written from the schema docs, not by copying the TS.

Covers both halves of the business:
  * opportunity — the five percentile dimensions (population, saturation,
    pipeline, permit barrier, buying power);
  * the out-of-pocket basket (فروش بدون نسخه) — buying power → per-capita sales
    → local market → the marginal entrant's share.
"""
import sqlite3, math, statistics as st

con = sqlite3.connect("db/pharmacy.sqlite")
con.row_factory = sqlite3.Row
# The guard runs over EVERY place (the app's `places` payload is unfiltered),
# because the pair that trips it — 'تهران بزرگ' 8,154,051 / 'شهر تجريش'
# 8,154,051 — is only visible together when both kinds are in the universe.
# 'تهران بزرگ' is classified place_kind='other', so a city-only query would see
# the shared population once and miss the trap entirely.
all_places = [dict(r) for r in con.execute("SELECT * FROM v_metrics")]

# Buying-power inputs, read from the same view the dashboard reads.
_prosp = {
    r["location_id"]: dict(r)
    for r in con.execute(
        "SELECT location_id, county_urban_share, hh_size FROM v_place_prosperity"
    )
}
for _r in all_places:
    _p = _prosp.get(_r["location_id"], {})
    _r["county_urban_share"] = _p.get("county_urban_share")
    _r["hh_size"] = _p.get("hh_size")

# --- mirror of the app's data-quality guard (lib/analytics.ts: suspectPlaces) --
# Placeholder names ("**", "-") and metropole populations shared by two places
# (شهر تجريش carries Tehran's 8,154,051) are held out of the peer set before any
# percentile is computed, otherwise they top the board and skew every band.
_SHARED_MIN = 100_000
from collections import Counter as _Counter
_pops = _Counter(r["population"] or 0 for r in all_places)

_suspect_keys: set[str] = set()
_suspect_list: list[tuple[str, str]] = []
for r in all_places:
    name = (r["place"] or "").strip()
    pop = r["population"] or 0
    if not name or "*" in name or not any("\u0600" <= c <= "\u06FF" for c in name):
        _suspect_keys.add(r["loc_key"])
        _suspect_list.append((r["place"], "placeholder name (no Persian letters)"))
    elif pop >= _SHARED_MIN and _pops[pop] > 1:
        _suspect_keys.add(r["loc_key"])
        _suspect_list.append((r["place"], f"population {pop:,} shared with another place"))

# The app's scope (lib/data.ts): market places AND every place holding at least
# one pharmacy, minus the rows above and the ones with no usable population.
rows = [r for r in all_places
        if (r["is_market"] == 1 or (r["n_pharmacy_real"] + r["n_pharmacy_legal"]) > 0)
        and r["loc_key"] not in _suspect_keys
        and (r["population"] or 0) > 0]
print(f"held out of the peer set: {len(_suspect_list)} place(s)")
for name, why in _suspect_list:
    print(f"   - {name}: {why}")


def pranks(vals):
    n = len(vals)
    order = sorted(range(n), key=lambda i: vals[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        pct = ((i + j) / 2) / (n - 1) * 100 if n > 1 else 100.0
        for k in range(i, j + 1):
            out[order[k]] = pct
        i = j + 1
    return out


# --- buying power (lib/otc.ts) ------------------------------------------------
# The level and the elasticity are ASSUMPTIONS; the rural/urban ratio is the one
# measured number, from the yearbook anchor in v_otc_anchors.
anchors = dict(con.execute("SELECT * FROM v_otc_anchors").fetchone())
RURAL_RATIO = anchors["rural_to_urban_ratio"]
BASE_OTC = 28_000_000
ELASTICITY = 1.3
NAT_HH = 3.5


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def factors(r):
    urbanity = (1.0 if r["place_kind"] == "city"
                else RURAL_RATIO if r["place_kind"] == "village"
                else (1 + RURAL_RATIO) / 2)
    u = r["county_urban_share"]
    county_urban = 1.0 if u is None else 0.85 + 0.35 * clamp(u, 0, 1)
    hh = r["hh_size"]
    household = clamp(NAT_HH / hh, 0.85, 1.15) if hh and hh > 0 else 1.0
    pop = max(r["population"] or 0, 200)
    agglomeration = clamp(1 + 0.06 * (math.log10(pop) - 3), 0.85, 1.15)
    return dict(urbanity=urbanity, countyUrban=county_urban,
                household=household, agglomeration=agglomeration,
                raw=urbanity * county_urban * household * agglomeration)


_raw = [factors(r)["raw"] for r in rows]
_scale = sum((r["population"] or 0) * raw for r, raw in zip(rows, _raw)) / \
         sum((r["population"] or 0) for r in rows)
bp = [raw / _scale for raw in _raw]

logpop = [math.log10(max(r["population"] or 1, 1)) for r in rows]
dens = [r["pharmacies_per_100k"] or 0 for r in rows]
pipe = [r["pipeline_ratio"] or 0 for r in rows]
barr = [r["min_score"] if r["min_score"] is not None
        else st.median([q["min_score"] or 0 for q in rows]) for r in rows]

rD, rH, rP, rB, rA = pranks(logpop), pranks(dens), pranks(pipe), pranks(barr), pranks(bp)
W = dict(demand=25, headroom=30, pipeline=15, barrier=10, affluence=20)
wsum = sum(W.values())

scored = []
for i, r in enumerate(rows):
    s = dict(demand=rD[i], headroom=100 - rH[i], pipeline=100 - rP[i],
             barrier=100 - rB[i], affluence=rA[i])
    s["opportunity"] = sum(s[k] * W[k] for k in W) / wsum
    scored.append((s["opportunity"], r, s, bp[i]))
scored.sort(key=lambda x: -x[0])

obs = [r["population"] / (r["n_pharmacy_real"] + r["n_pharmacy_legal"]) for r in rows
       if (r["population"] or 0) > 0 and (r["n_pharmacy_real"] + r["n_pharmacy_legal"]) > 0]
target = round(st.median(obs))
print(f"places={len(rows)}  auto target pop/pharmacy (median)={target}")
print(f"affluence scale: population-weighted mean buying power = "
      f"{sum((r['population'] or 0) * b for r, b in zip(rows, bp)) / sum((r['population'] or 0) for r in rows):.6f}"
      f"   range {min(bp):.2f} … {max(bp):.2f}")

print(f"\n{'#':>3} {'place':<24} {'pop':>9} {'ph':>4} {'/100k':>6} "
      f"{'dem':>5} {'head':>5} {'pip':>5} {'bar':>5} {'aff':>5} {'OPP':>6}")
for k, (opp, r, s, _b) in enumerate(scored[:12], 1):
    print(f"{k:>3} {r['place'][4:]:<24} {r['population']:>9,} "
          f"{r['n_pharmacy_real'] + r['n_pharmacy_legal']:>4} "
          f"{(r['pharmacies_per_100k'] or 0):>6.1f} {s['demand']:>5.1f} "
          f"{s['headroom']:>5.1f} {s['pipeline']:>5.1f} {s['barrier']:>5.1f} "
          f"{s['affluence']:>5.1f} {opp:>6.1f}")

# --- the out-of-pocket basket ------------------------------------------------
def otc(r, b):
    n = r["n_pharmacy_real"] + r["n_pharmacy_legal"]
    per_capita = BASE_OTC * max(b, 0.05) ** ELASTICITY
    market = (r["population"] or 0) * per_capita
    return per_capita, market, (market / n if n else 0.0), market / (n + 1)


otc_rows = [(otc(r, b), r, b) for r, b in zip(rows, bp)]
national = sum(m for (_pc, m, _pp, _en), _r, _b in otc_rows)
print(f"\nnational OTC market (model): {national / 1e12:,.0f} هزار میلیارد ریال"
      f"   per existing pharmacy: {national / max(sum(r['n_pharmacy_real'] + r['n_pharmacy_legal'] for r in rows), 1) / 1e9:,.1f}"
      f" میلیارد ریال/yr")

print("\n--- highest «سهم شما» (market ÷ (pharmacies + 1)) ---")
for (_pc, m, _pp, en), r, b in sorted(otc_rows, key=lambda x: -x[0][3])[:10]:
    print(f"  {r['place'][4:]:<26} {r['place_kind']:<7} pop={r['population']:>9,} "
          f"ph={r['n_pharmacy_real'] + r['n_pharmacy_legal']:>3} bp={b:>4.2f} "
          f"market={m / 1e9:>9,.1f} bn  you={en / 1e9:>8,.1f} bn")

# The question the layer exists for is about ABADIS, not capitals, so the village
# shortlist is reported separately: a large city always wins on absolute money.
_villages = sorted((x for x in otc_rows if x[1]["place_kind"] == "village"),
                   key=lambda x: -x[0][3])[:12]
print("\n--- villages: highest «سهم شما» ---")
for (_pc, m, _pp, en), r, b in _villages:
    print(f"  {r['place'][4:]:<26} {r['county'][:14]:<14} pop={r['population']:>7,} "
          f"ph={r['n_pharmacy_real'] + r['n_pharmacy_legal']:>2} bp={b:>4.2f} "
          f"market={m / 1e9:>7,.1f} bn  you={en / 1e9:>6,.1f} bn")

print("\n--- the same population, city vs village (why population alone is wrong) ---")
for kind in ("city", "village"):
    cand = [x for x in otc_rows if x[1]["place_kind"] == kind
            and 4_000 <= (x[1]["population"] or 0) <= 8_000]
    if cand:
        (pc, m, pp, en), r, b = cand[0]
        print(f"  {kind:<8} {r['place'][4:]:<22} pop={r['population']:>6,} "
              f"ph={r['n_pharmacy_real'] + r['n_pharmacy_legal']:>2} "
              f"bp={b:>4.2f} percap={pc / 1e6:>6.1f}M market={m / 1e9:>8,.1f}bn "
              f"you={en / 1e9:>7,.1f}bn")

# --- structural invariants ---------------------------------------------------
_mean = sum((r["population"] or 0) * b for r, b in zip(rows, bp)) / \
        sum((r["population"] or 0) for r in rows)
assert abs(_mean - 1.0) < 1e-6, f"buying power is not normalised (mean={_mean})"
assert 0.25 <= min(bp) and max(bp) <= 2.5, f"buying power out of range: {min(bp)} … {max(bp)}"
for (pc, m, pp, en), r, b in otc_rows:
    assert pc > 0 and m >= 0 and en >= 0
    assert en <= m, "the entrant cannot capture more than the whole market"
    n = r["n_pharmacy_real"] + r["n_pharmacy_legal"]
    if n:
        assert abs(pp - m / n) < 1e-6
assert all(x[0][0] >= 0 for x in otc_rows)
print("\ninvariants OK: normalised mean, bounded range, entrant ≤ market.")
