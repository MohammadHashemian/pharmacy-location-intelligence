"""Fetch the reference population layer for Iranian settlements (Wikidata).

Source: **Wikidata** `wdt:P1082`. For Iranian settlements this is overwhelmingly
the Statistical Center of Iran census — the Ahvaz item cites
https://www.amar.org.ir/english and carries exactly the census figure.

Why not the obvious alternatives:

  * **GeoNames** `IR.zip` — Latin-only names, admin2 (county) present for 250 of
    81,837 populated places, and 95% of those carry population 0. Good enough to
    build a province geofence, useless as a population authority.
  * **Scraping fa.wikipedia by title** — collides catastrophically: «گرجي سفلي»
    matched an article claiming 50,000 people for a village. Only safe when a
    QID has already resolved which article is meant.
  * Wikidata gives a **stable QID** plus coordinates, which is what makes a name
    match verifiable — and the QID (not a title search) then resolves the correct
    fa.wikipedia page for the census fallback.

Querying notes: WDQS answers 500 for a query that does the join fan-out, the
coordinate extraction and labelling together, and truncates (IncompleteRead) once
a result grows much past ~50k rows. So this makes ONE deliberately minimal bulk
pass — item, population and coordinate only, one row per item — and everything
heavier (labels, admin unit, sitelink) is fetched in bounded batches afterwards
or on demand by etl/enrich_population.py.

Output: data/reference/wikidata_ir_settlements.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = {"User-Agent": "pharmacy-site-selection/1.0 (research)"}
HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(HOME, "data", "reference")
OUT = os.path.join(OUT_DIR, "wikidata_ir_settlements.json")
ENDPOINT = "https://query.wikidata.org/sparql"

# Classes accepted as a settlement. An explicit VALUES list is far cheaper than a
# wdt:P31/wdt:P279* path, which times WDQS out.
TYPES = [
    "wd:Q486972",   # human settlement
    "wd:Q515",      # city
    "wd:Q3957",     # town
    "wd:Q532",      # village
    "wd:Q149621",   # district
    "wd:Q15284",    # municipality
    "wd:Q1637706",  # city with millions of inhabitants
    "wd:Q1241352",  # ?
    "wd:Q15078955", # ?
]

# Minimal bulk: one row per item.
Q_BULK = """
SELECT ?p ?pop ?coord WHERE {
  VALUES ?type { %s }
  ?p wdt:P31 ?type ;
     wdt:P17 wd:Q794 ;
     wdt:P1082 ?pop .
  OPTIONAL { ?p wdt:P625 ?coord . }
}
""" % " ".join(TYPES)

Q_LABELS = """
SELECT ?p ?faLabel ?enLabel WHERE {
  VALUES ?p { %s }
  OPTIONAL { ?p rdfs:label ?faLabel FILTER(lang(?faLabel) = "fa") }
  OPTIONAL { ?p rdfs:label ?enLabel FILTER(lang(?enLabel) = "en") }
}
"""


def sparql(query: str, timeout: int = 300, attempts: int = 6) -> dict:
    """POST a SPARQL query, honouring WDQS limits with backoff.

    429 = rate limited (retryable). 500 = query too heavy (rewrite, not retry).
    IncompleteRead = truncated response (retryable, but a signal to shrink).
    """
    data = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    delay, last = 15.0, None
    for n in range(attempts):
        req = urllib.request.Request(
            ENDPOINT, data=data,
            headers={**UA, "Accept": "application/sparql-results+json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code != 429:
                raise
            print(f"    429 rate-limited; sleeping {delay:.0f}s "
                  f"({n+1}/{attempts})", flush=True)
        except Exception as e:
            last = e
            print(f"    {type(e).__name__}; retrying in {delay:.0f}s "
                  f"({n+1}/{attempts})", flush=True)
        time.sleep(delay)
        delay = min(delay * 2, 240)
    raise last if last else RuntimeError("sparql failed")


def parse_point(wkt):
    m = re.match(r"^Point\(([-\d.]+) ([-\d.]+)\)$", wkt or "")
    return (float(m.group(2)), float(m.group(1))) if m else (None, None)


def bulk() -> dict[str, dict]:
    print("bulk pass: item + population + coordinate (one row per item) ...",
          flush=True)
    t0 = time.time()
    res = sparql(Q_BULK)
    rows = res["results"]["bindings"]
    print(f"  {len(rows):,} rows in {time.time()-t0:.0f}s", flush=True)

    by: dict[str, dict] = {}
    for b in rows:
        qid = b["p"]["value"].rsplit("/", 1)[-1]
        try:
            pop = float(b["pop"]["value"])
        except (KeyError, TypeError, ValueError):
            continue
        lat, lon = parse_point(b.get("coord", {}).get("value"))
        rec = by.get(qid)
        if rec is None:
            by[qid] = {
                "qid": qid, "population": pop, "lat": lat, "lon": lon,
                "name_fa": None, "name_en": None,
            }
        elif pop > rec["population"]:
            rec["population"] = pop
    print(f"  unique items: {len(by):,}", flush=True)
    return by


def attach_labels(by: dict[str, dict]) -> None:
    """Persian + English labels, in bounded batches."""
    ids = sorted(by)
    batch = 300
    print(f"  labels for {len(ids):,} items ({-(-len(ids)//batch)} batches) ...",
          flush=True)
    for i in range(0, len(ids), batch):
        chunk = ids[i:i + batch]
        vals = " ".join(f"wd:{q}" for q in chunk)
        try:
            res = sparql(Q_LABELS % vals, timeout=180)
        except Exception as e:
            print(f"    batch {i//batch}: FAILED {type(e).__name__}", flush=True)
            continue
        for b in res["results"]["bindings"]:
            q = b["p"]["value"].rsplit("/", 1)[-1]
            rec = by.get(q)
            if not rec:
                continue
            if b.get("faLabel"):
                rec["name_fa"] = b["faLabel"]["value"]
            if b.get("enLabel"):
                rec["name_en"] = b["enLabel"]["value"]
        if (i // batch) % 10 == 0:
            print(f"    ... {min(i+batch, len(ids)):,}/{len(ids):,}", flush=True)
        time.sleep(0.4)


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    if os.path.exists(OUT) and "--refresh" not in sys.argv:
        cached = json.load(open(OUT, encoding="utf-8"))
        print(f"cache hit: {OUT} ({len(cached):,} items) — --refresh to refetch")
        return 0

    by = bulk()
    attach_labels(by)
    items = list(by.values())
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1e6:.1f} MB)")

    named = [i for i in items if i["name_fa"] or i["name_en"]]
    geo = [i for i in items if i["lat"] is not None]
    print(f"  with a label     : {len(named):,}")
    print(f"  with coordinates : {len(geo):,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
