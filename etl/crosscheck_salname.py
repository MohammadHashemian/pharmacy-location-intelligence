"""Cross-check the FDA feed's pharmacy counts against the province's own numbers.

The FDA feed is a live operational system; the yearbook is the province's official
published annual. Where they agree, both can be trusted. Where they disagree, the
dashboard must say so instead of silently preferring one — that is the whole point
of loading the yearbook at all.

Also compares county population (1395 census in the yearbook vs the FDA's own
جمعیت summed over the county).
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import norm_key  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
c = sqlite3.connect("db/pharmacy.sqlite")
c.row_factory = sqlite3.Row


def ck(s: str | None) -> str:
    return norm_key(re.sub(r"^شهرستان\s+", "", (s or "")).strip())


# ---- FDA side: pharmacies and population per Khuzestan county ----------------
fda = {}
for r in c.execute("""
    SELECT county,
           SUM(n_pharmacy_real + n_pharmacy_legal) AS ph,
           SUM(population)                          AS pop,
           SUM(n_req_registered + n_req_inprogress + n_req_approved) AS pipe
    FROM v_metrics
    WHERE province LIKE '%خوزستان%'
    GROUP BY county
"""):
    fda[ck(r["county"])] = {"ph": r["ph"] or 0, "pop": r["pop"] or 0,
                            "pipe": r["pipe"] or 0, "raw": r["county"]}

# ---- yearbook side -----------------------------------------------------------
sal_ph = {}
for r in c.execute("""SELECT county, value FROM salname_metrics
                      WHERE metric='pharmacies' AND scope='county'
                        AND dimension='total' AND year_sh=1403"""):
    sal_ph[ck(r["county"])] = r["value"]

sal_pop = {}
for r in c.execute("""SELECT county, value FROM salname_metrics
                      WHERE metric='population' AND scope='county'
                        AND dimension='total'"""):
    sal_pop[ck(r["county"])] = r["value"]

print(f"FDA Khuzestan counties: {len(fda)}   yearbook counties: {len(sal_ph)}")
print()
print("=== PHARMACIES per county: FDA (live) vs yearbook (1403) ===")
print(f"  {'county':<18} {'FDA':>6} {'سالنامه 1403':>13} {'diff':>7} {'ratio':>7}")
tot_f = tot_s = 0
pairs = []
for k in sorted(set(fda) | set(sal_ph)):
    f = fda.get(k, {}).get("ph")
    s = sal_ph.get(k)
    if f is None or s is None:
        continue
    tot_f += f
    tot_s += s
    d = f - s
    ratio = (f / s) if s else None
    pairs.append((k, f, s, d, ratio))
for k, f, s, d, ratio in sorted(pairs, key=lambda t: -(t[1] or 0)):
    flag = "" if abs(d) <= max(2, 0.15 * s) else "   <-- CHECK"
    print(f"  {k:<18} {f:>6} {s:>13.0f} {d:>+7} "
          f"{(f'{ratio:.2f}' if ratio else '-'):>7}{flag}")
print(f"  {'TOTAL (matched)':<18} {tot_f:>6} {tot_s:>13.0f} {tot_f-tot_s:>+7}")
print(f"\n  yearbook province total 1403 : {c.execute(chr(39)+'x'+chr(39)).fetchone() if False else ''}")
for r in c.execute("""SELECT year_sh, value FROM salname_metrics
                      WHERE metric='pharmacies' AND scope='province'
                        AND dimension='total' ORDER BY year_sh"""):
    print(f"     {r['year_sh']}: {r['value']:.0f}")

print("\n=== FDA province total (all Khuzestan rows, any scope) ===")
r = c.execute("""SELECT SUM(n_pharmacy_real+n_pharmacy_legal) ph, COUNT(*) n
                 FROM v_metrics WHERE province LIKE '%خوزستان%'""").fetchone()
print(f"     {r['ph']:.0f} pharmacies over {r['n']} settlements")

print("\n=== POPULATION per county: FDA sum vs yearbook (1395 census) ===")
print(f"  {'county':<18} {'FDA pop':>10} {'سرشماری 1395':>13} {'ratio':>7}")
for k in sorted(set(fda) | set(sal_pop), key=lambda k: -(fda.get(k, {}).get("pop") or 0)):
    f = fda.get(k, {}).get("pop")
    s = sal_pop.get(k)
    if f is None or s is None:
        continue
    ratio = (f / s) if s else None
    flag = "" if ratio and 0.9 <= ratio <= 1.1 else "   <-- CHECK"
    print(f"  {k:<18} {f:>10.0f} {s:>13.0f} "
          f"{(f'{ratio:.2f}' if ratio else '-'):>7}{flag}")
c.close()
