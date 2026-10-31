"""Completeness audit, v2 — fixed key handling.

Question: the API's `count` says 62,524 but only ~48,423 distinct ShahrIDs came
back. Is the feed complete, or did OFFSET paging drop records?

Cross-validation: the offline HTML snapshot is an INDEPENDENT capture of
Khuzestan province. If the API's Khuzestan rows reproduce the HTML's pharmacy
counts and populations, the paging can be trusted.
"""
import json, glob, collections, sys, os, sqlite3

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from normalize import norm_text, norm_key  # noqa: E402


def records(payload):
    d = payload["data"]
    return d["records"] if isinstance(d, dict) else d


files = sorted(glob.glob("data/raw/zarfiat_pages/*.json"))
all_rows = []
for f in files:
    all_rows.extend(records(json.load(open(f, encoding="utf-8-sig"))))

print(f"rows across {len(files)} pages : {len(all_rows):,}")

ids = [r["ShahrID"] for r in all_rows]
uniq_ids = set(ids)
print(f"distinct ShahrID               : {len(uniq_ids):,}")
print(f"duplicate rows served          : {len(ids)-len(uniq_ids):,} "
      f"({100*(len(ids)-len(uniq_ids))/len(ids):.1f}%)")
print(f"ShahrID range                  : {min(ids)} .. {max(ids)}")

# pagination stability: a stable sort means a ShahrID is confined to ONE page
page_of = {}
straddle = 0
for i, r in enumerate(all_rows):
    p, sid = i // 5000, r["ShahrID"]
    if sid in page_of and page_of[sid] != p:
        straddle += 1
    page_of.setdefault(sid, p)
print(f"ShahrIDs appearing on >1 page  : {straddle:,}")

# do duplicate ShahrIDs agree on their payload?
seen = {}
conflict = 0
for r in all_rows:
    sid = r["ShahrID"]
    sig = (r.get("Jamiat"), r.get("CountDaroukhaneh"), r.get("shahrRoustaOnvan"))
    if sid in seen and seen[sid] != sig:
        conflict += 1
    seen.setdefault(sid, sig)
print(f"duplicate ShahrIDs with DIFFERENT values: {conflict:,}")

# --- structural check: do the same natural place repeat under 1 ShahrID? ----
nat = collections.Counter(
    (norm_text(r["OstanOnvan"]), norm_text(r["ShahrestanOnvan"]),
     norm_text(r["bakhshOnvan"]), norm_text(r["shahrRoustaOnvan"]))
    for r in all_rows
)
print(f"distinct natural (ostan|shahrestan|bakhsh|place): {len(nat):,}")
print("most repeated natural keys:")
for k, n in nat.most_common(6):
    print(f"   x{n:<3} {' | '.join(x[:30] for x in k)}")

# --- DECISIVE: cross-validate Khuzestan against the independent HTML capture --
c = sqlite3.connect("db/pharmacy.sqlite")
c.row_factory = sqlite3.Row

api_kh = {}
for r in all_rows:
    if "خوزستان" in norm_text(r["OstanOnvan"]):
        k = (norm_text(r["ShahrestanOnvan"]), norm_text(r["shahrRoustaOnvan"]))
        api_kh.setdefault(k, (r.get("Jamiat"), r.get("CountDaroukhaneh"),
                              r.get("CountDaroukhanehHoghoghi")))
html_kh = {}
for r in c.execute("""select l.county, l.place, s.population, s.n_pharmacy_real,
                             s.n_pharmacy_legal
                      from locations l join location_snapshots s on s.location_id = l.id
                      where l.province like '%خوزستان%' and l.id in (
                        select location_id from location_snapshots k
                        join data_sources d on d.id = k.source_id
                        where d.kind='html')"""):
    html_kh[(r["county"], r["place"])] = (r["population"], r["n_pharmacy_real"],
                                          r["n_pharmacy_legal"])

print(f"\nKhuzestan places — offline HTML capture : {len(html_kh):,}")
print(f"Khuzestan places — API pages            : {len(api_kh):,}")

common = set(api_kh) & set(html_kh)
only_html = set(html_kh) - set(api_kh)
only_api = set(api_kh) - set(html_kh)
mismatch = [k for k in common if api_kh[k] != html_kh[k]]
print(f"present in both                         : {len(common):,}")
print(f"present only in HTML (missed by API)    : {len(only_html):,}")
print(f"present only in API                     : {len(only_api):,}")
print(f"common keys WITH DISAGREEING values     : {len(mismatch):,}")
for k in mismatch[:8]:
    print(f"   {k[1][:30]:<30} html={html_kh[k]} api={api_kh[k]}")
for k in list(only_html)[:8]:
    print(f"   HTML-only: {k[1][:34]:<34} {html_kh[k]}")

# --- national plausibility -------------------------------------------------
ph = sum((r.get("CountDaroukhaneh") or 0) + (r.get("CountDaroukhanehHoghoghi") or 0)
         for r in all_rows)
pop = sum((r.get("Jamiat") or 0) for r in all_rows)
print(f"\nAPI national pharmacies : {ph:,}")
print(f"API national population : {pop:,}")
print(f"runtime DB pharmacies   : "
      f"{c.execute('select sum(n_pharmacy_real+n_pharmacy_legal) from v_latest_snapshot').fetchone()[0]:,}")
print(f"runtime DB places       : {c.execute('select count(*) from v_latest_snapshot').fetchone()[0]:,}")
