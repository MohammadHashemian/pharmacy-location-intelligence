"""Independent re-implementation of the dashboard scoring model, in Python.

If this agrees with what the web app prints, the TS model is doing what it says.
Deliberately written from the schema docs, not by copying the TS.
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

rows = [r for r in all_places
        if r["place_kind"] == "city" and r["loc_key"] not in _suspect_keys]
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


logpop = [math.log10(max(r["population"] or 1, 1)) for r in rows]
dens = [r["pharmacies_per_100k"] or 0 for r in rows]
pipe = [r["pipeline_ratio"] or 0 for r in rows]
barr = [r["min_score"] if r["min_score"] is not None
        else st.median([q["min_score"] or 0 for q in rows]) for r in rows]

rD, rH, rP, rB = pranks(logpop), pranks(dens), pranks(pipe), pranks(barr)
W = dict(demand=30, headroom=40, pipeline=20, barrier=10)
wsum = sum(W.values())

scored = []
for i, r in enumerate(rows):
    s = dict(demand=rD[i], headroom=100 - rH[i], pipeline=100 - rP[i], barrier=100 - rB[i])
    s["opportunity"] = sum(s[k] * W[k] for k in W) / wsum
    scored.append((s["opportunity"], r, s))
scored.sort(key=lambda x: -x[0])

obs = [r["population"] / r["n_pharmacy_total"] for r in rows
       if (r["population"] or 0) > 0 and r["n_pharmacy_total"] > 0]
target = round(st.median(obs))
print(f"cities={len(rows)}  auto target pop/pharmacy (median)={target}")

print(f"\n{'#':>3} {'city':<24} {'pop':>9} {'ph':>4} {'/100k':>6} "
      f"{'minE':>5} {'pipe':>6} {'dem':>5} {'head':>5} {'pip':>5} {'bar':>5} {'OPP':>6}")
for k, (opp, r, s) in enumerate(scored[:12], 1):
    print(f"{k:>3} {r['place'][4:]:<24} {r['population']:>9,} {r['n_pharmacy_total']:>4} "
          f"{(r['pharmacies_per_100k'] or 0):>6.1f} {int(r['min_score'] or 0):>5} "
          f"{r['pipeline_ratio']:>6.2f} {s['demand']:>5.1f} {s['headroom']:>5.1f} "
          f"{s['pipeline']:>5.1f} {s['barrier']:>5.1f} {opp:>6.1f}")

print("\n--- with minPopulation>=20000 filter applied (what the UI defaults to) ---")
vis = [x for x in scored if (x[1]["population"] or 0) >= 20000]
print(f"visible cities: {len(vis)}")
for k, (opp, r, s) in enumerate(vis[:8], 1):
    print(f"{k:>3} {r['place'][4:]:<20} pop={r['population']:>9,} "
          f"ph={r['n_pharmacy_total']:>3} /100k={(r['pharmacies_per_100k'] or 0):>6.1f} "
          f"pipe={r['n_req_pipeline']:>3} OPP={opp:>5.1f}")

print("\n--- the 3 unambiguously best 'big market, thin supply' cities ---")
big = [x for x in vis if (x[1]["population"] or 0) >= 100_000]
big.sort(key=lambda x: -(x[1]["population_per_pharmacy"] or 0))
for opp, r, s in big[:6]:
    print(f"  {r['place'][4:]:<22} pop={r['population']:>9,} ph={r['n_pharmacy_total']:>3} "
          f"pop/ph={r['population_per_pharmacy']:>6,} /100k={(r['pharmacies_per_100k'] or 0):>5.1f} "
          f"pipe={r['n_req_pipeline']:>3} approved={r['n_req_approved']:>2}")
