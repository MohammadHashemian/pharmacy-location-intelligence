"""Enrich FDA places with a corroborated reference population.

Rules learned the hard way from the probes:

  1. **Never overwrite the FDA population.** It stays on the snapshot; the
     reference value lives in its own table with its own provenance.
  2. **Refuse to guess.** A match is accepted only when the name lines up AND the
     source's admin unit corroborates it. Everything else is left explicitly
     unmatched rather than given a plausible-looking wrong number. (Scraping
     fa.wikipedia by title failed exactly this way: «گرجي سفلي» matched an
     article claiming 50,000 for a village.)
  3. **Prefer Wikidata; fall back to the QID's own article.** Wikidata's P1082
     cites amar.org.ir. Where the item has no P1082 but has a fa.wikipedia
     sitelink, the census sentence is read from THAT article — the QID resolves
     which article is meant, so there is no same-name collision. This is what
     reaches ملاشیه یک (Q3860196), which carries coordinates and an admin unit
     but no population statement.
  4. **Two candidate sources, because one is not enough.**
       (a) a bulk index of Iranian settlement items that DO have a population;
       (b) per-name EntitySearch, which finds items the bulk index misses —
           either because they have no population statement, or because Wikidata
           spells the name differently (مسجدسلیمان, one word).

Writes table `population_reference` (defined in etl/schema.sql).
"""
from __future__ import annotations

import collections
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import norm_key, norm_text  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
REF_DIR = os.path.join(HOME, "data", "reference")
WD = os.path.join(REF_DIR, "wikidata_ir_settlements.json")
IRZIP = os.path.join(REF_DIR, "IR.zip")
ADMIN1 = os.path.join(REF_DIR, "admin1CodesASCII.txt")
SEARCH_CACHE = os.path.join(REF_DIR, "entity_search_cache.json")
UA = {"User-Agent": "pharmacy-site-selection/1.0 (research)"}
WIKI_API = "https://fa.wikipedia.org/w/api.php"
WD_API = "https://www.wikidata.org/w/api.php"
SPARQL = "https://query.wikidata.org/sparql"

MAX_CANDIDATES = 40     # bound per FDA place
BATCH = 120             # QIDs per SPARQL round-trip

# GeoNames admin1 code -> Persian province. Taken from the codes actually present
# in admin1CodesASCII.txt (IR.01-IR.44), NOT hand-guessed: an earlier guessed
# name map matched only 11 of 31 provinces, which would have silently dropped the
# coordinate check for two thirds of the country.
CODE_TO_FA_PROVINCE = {
    "01": "آذربایجان غربی", "03": "چهارمحال و بختیاری", "04": "سیستان و بلوچستان",
    "05": "کهگیلویه و بویراحمد", "07": "فارس", "08": "گیلان", "09": "همدان",
    "10": "ایلام", "11": "هرمزگان", "13": "کرمانشاه", "15": "خوزستان",
    "16": "کردستان", "22": "بوشهر", "23": "لرستان", "25": "سمنان",
    "26": "تهران", "28": "اصفهان", "29": "کرمان", "32": "اردبیل",
    "33": "آذربایجان شرقی", "34": "مرکزی", "35": "مازندران", "36": "زنجان",
    "37": "گلستان", "38": "قزوین", "39": "قم", "40": "یزد", "41": "خراسان جنوبی",
    "42": "خراسان رضوی", "43": "خراسان شمالی", "44": "البرز",
}


def ensure_admin1() -> dict[str, str]:
    """GeoNames alpha-2 admin1 code ('IR.15') -> Persian province name."""
    if not os.path.exists(ADMIN1):
        url = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                    timeout=90) as r:
            open(ADMIN1, "wb").write(r.read())
    out: dict[str, str] = {}
    for ln in open(ADMIN1, encoding="utf-8"):
        f = ln.split("\t")
        if len(f) < 4 or not f[0].startswith("IR."):
            continue
        code = f[0].split(".")[1]
        fa = CODE_TO_FA_PROVINCE.get(code)
        if fa:
            out[code] = fa
    return out


def load_geofence() -> dict:
    """Persian province -> (lat_min, lat_max, lon_min, lon_max), from GeoNames
    populated places grouped by the *authoritative* admin1 code."""
    if not os.path.exists(IRZIP):
        print("  (no IR.zip - skipping province geofence)")
        return {}
    code2prov = ensure_admin1()
    print(f"  admin1 codes mapped: {len(code2prov)}")
    with zipfile.ZipFile(IRZIP) as z:
        raw = z.read("IR.txt").decode("utf-8", "replace")
    bbox = collections.defaultdict(lambda: [90.0, -90.0, 180.0, -180.0])
    for ln in raw.splitlines():
        f = ln.split("\t")
        if len(f) < 11 or f[6] != "P":
            continue
        prov = code2prov.get(f[10])
        if not prov:
            continue
        try:
            lat, lon = float(f[4]), float(f[5])
        except ValueError:
            continue
        b = bbox[prov]
        b[0], b[1] = min(b[0], lat), max(b[1], lat)
        b[2], b[3] = min(b[2], lon), max(b[3], lon)
    return {k: v for k, v in bbox.items() if v[0] <= v[1]}


# ---------------------------------------------------------------------------
# fa.wikipedia census sentence
# ---------------------------------------------------------------------------
FA_D = "۰۱۲۳۴۵۶۷۸۹"
AR_D = "٠١٢٣٤٥٦٧٨٩"


def fa2en(s: str) -> str:
    for i, ch in enumerate(FA_D):
        s = s.replace(ch, str(i))
    for i, ch in enumerate(AR_D):
        s = s.replace(ch, str(i))
    return s


POP_RE = re.compile(
    r"([\d\u06F0-\u06F9\u0660-\u0669][\d\u06F0-\u06F9\u0660-\u0669,٬\s]{0,14}?)\s*نفر")
SHAMSI_RE = re.compile(r"(1[23][0-9]{2}|14[0-9]{2})")


def parse_census(text: str):
    """-> (population, shamsi_year, gregorian_year, households)"""
    t = re.sub(r"<ref[^>]*>.*?</ref>", " ", text, flags=re.S)
    t = re.sub(r"\{\{[^{}]*\}\}", " ", t)
    t = re.sub(r"\[\[([^\]|]*\|)?([^\]]*)\]\]", r"\2", t)
    for s in re.split(r"[.\n]", t):
        if "نفر" not in s:
            continue
        for m in POP_RE.finditer(s):
            raw = fa2en(m.group(1)).replace(",", "").replace("٬", "").replace(" ", "")
            if not raw.isdigit():
                continue
            val = int(raw)
            if 1 <= val <= 20_000_000:
                ym = SHAMSI_RE.search(fa2en(s))
                sy = int(ym.group(1)) if ym else None
                hh = re.search(r"\(\s*([\d,٬\s]+)\s*خانوار", fa2en(s))
                households = None
                if hh:
                    v = hh.group(1).replace(",", "").replace("٬", "").replace(" ", "")
                    households = int(v) if v.isdigit() else None
                return val, sy, (sy + 621 if sy else None), households
    return None, None, None, None


def wiki_census(titles: list[str]) -> dict[str, tuple]:
    out: dict[str, tuple] = {}
    for i in range(0, len(titles), 25):
        chunk = titles[i:i + 25]
        u = (f"{WIKI_API}?action=query&format=json&prop=revisions&rvprop=content"
             f"&rvslots=main&redirects=1&titles="
             + urllib.parse.quote("|".join(chunk)))
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA),
                                        timeout=90) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
        except Exception:
            time.sleep(0.5)
            continue
        norm = {n["to"]: n["from"] for n in d.get("query", {}).get("normalized", [])}
        redir = {n["to"]: n["from"] for n in d.get("query", {}).get("redirects", [])}
        for _pid, p in d.get("query", {}).get("pages", {}).items():
            title = p.get("title")
            if "revisions" not in p:
                continue
            res = parse_census(p["revisions"][0]["slots"]["main"]["*"])
            if not res[0]:
                continue
            out[title] = res
            for m in (norm, redir):
                if title in m:
                    out[m[title]] = res
        time.sleep(0.35)
    return out


# ---------------------------------------------------------------------------
# Wikidata: candidate discovery + facts
# ---------------------------------------------------------------------------
def label_lookup(names: list[str]) -> dict[str, list[str]]:
    """Resolve Persian place names -> Wikidata items in bulk.

    Per-name EntitySearch was the obvious approach and it was far too slow
    (~3.6 s/name throttled, over an hour for 1,281 names). A VALUES list of
    labels does the whole set in a handful of SPARQL round-trips, and matches
    both the label and any altLabel — which is what reaches an item Wikidata
    spells differently from the FDA (مسجدسلیمان vs مسجد سلیمان).

    Imported from fa.wikipedia/other countries are filtered out by requiring
    the item to be located in Iran (wdt:P17).
    """
    out: dict[str, list[str]] = {}
    chunk = 250
    print(f"  label lookup: {len(names):,} names "
          f"({-(-len(names)//chunk)} batches)", flush=True)
    for i in range(0, len(names), chunk):
        part = [n for n in names[i:i + chunk] if n]
        if not part:
            continue
        vals = " ".join(json.dumps(n, ensure_ascii=False) + "@fa" for n in part)
        q = """
SELECT ?p ?nm ?pop ?coord WHERE {
  VALUES ?nm { %s }
  { ?p rdfs:label ?nm . } UNION { ?p skos:altLabel ?nm . }
  ?p wdt:P17 wd:Q794 .
  OPTIONAL { ?p wdt:P1082 ?pop . }
  OPTIONAL { ?p wdt:P625 ?coord . }
}
""" % vals
        try:
            res = sparql(q, timeout=240)
        except Exception as e:
            print(f"    label batch {i//chunk}: FAILED {type(e).__name__}",
                  flush=True)
            continue
        for b in res["results"]["bindings"]:
            nm = b["nm"]["value"]
            qid = b["p"]["value"].rsplit("/", 1)[-1]
            out.setdefault(nm, [])
            if qid not in out[nm]:
                out[nm].append(qid)
        print(f"    label {min(i+chunk, len(names)):,}/{len(names):,}"
              f"  ({sum(len(v) for v in out.values()):,} hits)", flush=True)
        time.sleep(0.4)
    return out


Q_MWAPI = """
SELECT ?p ?st WHERE {
  VALUES ?st { %s }
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch" ;
                    wikibase:endpoint "www.wikidata.org" ;
                    mwapi:search ?st ;
                    mwapi:language "fa" .
    ?p wikibase:apiOutputItem mwapi:item .
  }
}
"""


def mwapi_search(names: list[str]) -> dict[str, list[str]]:
    """Fuzzy per-name entity search, server-side, batched by VALUES.

    This is what reaches the item the FDA spells differently from Wikidata:

      * an extra token — FDA «روستاي ملاشيه» vs Wikidata «ملاشیه یک» (Q3860196);
      * a spacing difference — FDA «خرم اباد» vs Wikidata «خرمآباد»;
      * a one-word form — FDA «مسجد سليمان» vs Wikidata «مسجدسلیمان».

    An exact rdfs:label lookup cannot do any of those, and a FILTER(STRSTARTS())
    sweep times the endpoint out (504). EntitySearch with a VALUES-bound term
    works and costs one round-trip per few hundred names.

    NOTE: do NOT pass `wikibase:limit` here. With a VALUES-bound search term it
    behaves as a GLOBAL result cap — one batch of 200 names returned 4 rows
    total, i.e. only the first term was ever searched. Without it, every term is
    evaluated and returns ~15 candidates.
    """
    out: dict[str, list[str]] = {}
    chunk = 100
    print(f"  entity search: {len(names):,} names "
          f"({-(-len(names)//chunk)} batches)", flush=True)
    for i in range(0, len(names), chunk):
        part = [n for n in names[i:i + chunk] if n]
        if not part:
            continue
        vals = " ".join(json.dumps(n, ensure_ascii=False) for n in part)
        try:
            res = sparql(Q_MWAPI % vals, timeout=240)
        except Exception as e:
            print(f"    search batch {i//chunk}: FAILED {type(e).__name__}",
                  flush=True)
            continue
        for b in res["results"]["bindings"]:
            st = b["st"]["value"]
            qid = b["p"]["value"].rsplit("/", 1)[-1]
            out.setdefault(st, [])
            if qid not in out[st]:
                out[st].append(qid)
        print(f"    search {min(i+chunk, len(names)):,}/{len(names):,}"
              f"  ({sum(len(v) for v in out.values()):,} hits)", flush=True)
        time.sleep(0.4)
    return out


Q_FACTS = """
SELECT ?p ?pop ?coord ?adm ?fawiki WHERE {
  VALUES ?p { %s }
  OPTIONAL { ?p wdt:P1082 ?pop . }
  OPTIONAL { ?p wdt:P625 ?coord . }
  OPTIONAL {
    { ?p wdt:P131 ?adm }
    UNION { ?p wdt:P131/wdt:P131 ?adm }
    UNION { ?p wdt:P131/wdt:P131/wdt:P131 ?adm }
  }
  OPTIONAL { ?fawiki schema:about ?p ; schema:isPartOf <https://fa.wikipedia.org/> . }
}
"""
Q_LABELS = """
SELECT ?p ?faLabel ?enLabel WHERE {
  VALUES ?p { %s }
  OPTIONAL { ?p rdfs:label ?faLabel FILTER(lang(?faLabel) = "fa") }
  OPTIONAL { ?p rdfs:label ?enLabel FILTER(lang(?enLabel) = "en") }
}
"""


def sparql(query: str, timeout: int = 240, attempts: int = 5) -> dict:
    data = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    delay, last = 12.0, None
    for n in range(attempts):
        req = urllib.request.Request(
            SPARQL, data=data,
            headers={**UA, "Accept": "application/sparql-results+json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code != 429:
                raise
        except Exception as e:
            last = e
        time.sleep(delay)
        delay = min(delay * 2, 180)
    raise last if last else RuntimeError("sparql failed")


def parse_point(wkt):
    m = re.match(r"^Point\(([-\d.]+) ([-\d.]+)\)$", wkt or "")
    return (float(m.group(2)), float(m.group(1))) if m else (None, None)


FACTS_CACHE = os.path.join(REF_DIR, "facts_cache.json")
LABEL_CACHE = os.path.join(REF_DIR, "label_cache.json")
ADM_CACHE = os.path.join(REF_DIR, "adm_label_cache.json")


def _load_cache(path: str) -> dict:
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(path: str, data: dict) -> None:
    try:
        json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:
        pass


def resolve_facts(qids: list[str]) -> tuple[dict, set[str]]:
    """-> ({qid: {pop, lat, lon, adm[], fawiki}}, {adm_qids})

    Cached: the fuzzy search widens the candidate pool to ~16k QIDs, so an
    uncached re-run costs a full pass over Wikidata (~35 min). With the cache a
    re-run only fetches genuinely new items.
    """
    cache = _load_cache(FACTS_CACHE)
    todo = [q for q in qids if q not in cache]
    print(f"  facts: {len(qids):,} candidates, {len(todo):,} to fetch "
          f"({len(cache):,} cached)", flush=True)
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        vals = " ".join(f"wd:{q}" for q in chunk)
        fresh: dict[str, dict] = {q: {"population": None, "lat": None, "lon": None,
                                     "adm": [], "fawiki": None} for q in chunk}
        try:
            res = sparql(Q_FACTS % vals)
        except Exception as e:
            print(f"    facts batch {i//BATCH}: FAILED {type(e).__name__}",
                  flush=True)
            continue
        for b in res["results"]["bindings"]:
            q = b["p"]["value"].rsplit("/", 1)[-1]
            rec = fresh.setdefault(q, {"population": None, "lat": None, "lon": None,
                                       "adm": [], "fawiki": None})
            if b.get("pop"):
                try:
                    v = float(b["pop"]["value"])
                    if rec["population"] is None or v > rec["population"]:
                        rec["population"] = v
                except (TypeError, ValueError):
                    pass
            if b.get("coord") and rec["lat"] is None:
                rec["lat"], rec["lon"] = parse_point(b["coord"]["value"])
            if b.get("adm"):
                a = b["adm"]["value"].rsplit("/", 1)[-1]
                if a not in rec["adm"]:
                    rec["adm"].append(a)
            if b.get("fawiki"):
                rec["fawiki"] = urllib.parse.unquote(
                    b["fawiki"]["value"].rsplit("/", 1)[-1]).replace("_", " ")
        cache.update(fresh)
        if i % (BATCH * 10) == 0:
            _save_cache(FACTS_CACHE, cache)
        print(f"    facts {min(i+BATCH, len(todo)):,}/{len(todo):,}", flush=True)
        time.sleep(0.35)
    _save_cache(FACTS_CACHE, cache)

    info = {q: cache[q] for q in qids if q in cache}
    adm_qids = {a for r in info.values() for a in r["adm"]}
    return info, adm_qids


def resolve_adm_labels(adm_qids: set[str]) -> dict[str, dict]:
    cache = _load_cache(ADM_CACHE)
    ids = sorted(q for q in adm_qids if q not in cache)
    print(f"  admin labels: {len(adm_qids):,} units, {len(ids):,} to fetch "
          f"({len(cache):,} cached)", flush=True)
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        vals = " ".join(f"wd:{q}" for q in chunk)
        fresh: dict[str, dict] = {q: {"fa": None, "en": None} for q in chunk}
        try:
            res = sparql(Q_LABELS % vals)
        except Exception as e:
            print(f"    adm label batch {i//BATCH}: FAILED {type(e).__name__}",
                  flush=True)
            continue
        for b in res["results"]["bindings"]:
            q = b["p"]["value"].rsplit("/", 1)[-1]
            rec = fresh.setdefault(q, {"fa": None, "en": None})
            if b.get("faLabel"):
                rec["fa"] = b["faLabel"]["value"]
            if b.get("enLabel"):
                rec["en"] = b["enLabel"]["value"]
        cache.update(fresh)
        if i % (BATCH * 10) == 0:
            _save_cache(ADM_CACHE, cache)
        time.sleep(0.28)
    _save_cache(ADM_CACHE, cache)
    return {q: cache[q] for q in adm_qids if q in cache}


# ---------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------
def compact(s: str) -> str:
    """Space-insensitive form, for names the two sources break up differently
    («خرم اباد» vs «خرمآباد», «مسجد سليمان» vs «مسجدسليمان»)."""
    return (s or "").replace(" ", "")


# Trailing qualifiers the FDA appends to a city name that Wikidata does not carry
# («تهران بزرگ» -> «تهران»). Deliberately short: عليا/سفلي DO distinguish real
# villages, so they are not included.
_QUALIFIERS = {"بزرگ", "جدید", "صنعتی"}


def strip_qualifiers(k: str) -> str:
    parts = (k or "").split()
    while parts and parts[-1] in _QUALIFIERS:
        parts.pop()
    return " ".join(parts)


# A reference population is only believable if the population it implies is
# consistent with the pharmacy footprint the FDA reports for that place. Across
# market places with at least one pharmacy, the FDA's own ratio sits at 1,358
# (p05) / 3,527 (p50) / 8,602 (p95) / 15,750 (p99) people per pharmacy.
#
# The band keeps every correction verified correct (ملاشیه 5,525; ری 8,065;
# مشکین دشت 4,769; کردکوی 4,985) and rejects the same-name and county-total
# mismatches found (سراب 27; فردیس 60; نورآباد 57; ارکواز 1; میامی 110,560;
# فیروزآباد 41,176; ایوان 50,962; بمپور 30,279).
#
# It cannot separate "the FDA dropped a digit" from "the article quoted the
# county total" in the middle of the range, so corrections beyond 5x are also
# marked for review in the dashboard rather than presented as settled.
PPP_MIN, PPP_MAX = 100, 20_000


def plausible_population(p: dict, pop: float) -> bool:
    """Is this population credible given the place's pharmacies?"""
    ph = (p.get("n_pharmacy_real") or 0) + (p.get("n_pharmacy_legal") or 0)
    if ph <= 0:
        # No pharmacy footprint to contradict it — only reject the absurd.
        return 50 <= pop <= 20_000_000
    return PPP_MIN <= (pop / ph) <= PPP_MAX


def score_match(fda: dict, name: str, item: dict, adm_label: str, geo: dict):
    county = norm_key(fda["county"])
    province = norm_key(fda["province"])
    adm = norm_key(adm_label)
    name_fda = norm_key(fda["place"])
    nf = norm_key(name)
    if not name_fda or not nf:
        return 0.0, "نام نامرتبط"

    score, why = 0.0, []
    exact = name_fda == nf or compact(name_fda) == compact(nf)
    near = (
        nf.startswith(name_fda)
        or name_fda.startswith(nf)
        or compact(nf).startswith(compact(name_fda))
        or compact(strip_qualifiers(name_fda)) == compact(nf)
    )
    if exact:
        score += 0.40
        why.append("نام دقیق")
    elif near:
        score += 0.22
        why.append("نام نزدیک")
    else:
        return 0.0, "نام نامرتبط"

    if county and county in adm:
        score += 0.35
        why.append("شهرستان مطابق")
    elif province and province in adm:
        score += 0.18
        why.append("استان مطابق")

    lat, lon = item.get("lat"), item.get("lon")
    if lat is not None and province in geo:
        a, b, c, d = geo[province]
        if a <= lat <= b and c <= lon <= d:
            score += 0.20
            why.append("داخل محدودهٔ استان")
        else:
            score -= 0.35
            why.append("خارج از محدودهٔ استان")

    fpop, rpop = fda.get("population") or 0, item.get("population") or 0
    if fpop and rpop and (rpop < fpop / 100 or rpop > fpop * 100):
        score -= 0.15
        why.append("اختلاف جمعیت بسیار بزرگ")
    return max(score, 0.0), "، ".join(why)


def main() -> int:
    min_score = 0.55
    for a in sys.argv:
        if a.startswith("--min-score="):
            min_score = float(a.split("=", 1)[1])

    if not os.path.exists(WD):
        print(f"missing {WD} - run etl/fetch_reference.py first")
        return 1
    items = json.load(open(WD, encoding="utf-8"))
    print(f"wikidata bulk items: {len(items):,}")

    geo = load_geofence()
    print(f"province geofences: {len(geo)}")

    # ---- name index over the bulk set (fast path) ----
    by_name: dict[str, list[str]] = collections.defaultdict(list)
    by_qid = {i["qid"]: i for i in items}
    for it in items:
        for nm in (it.get("name_fa"), it.get("name_en")):
            k = norm_key(nm)
            if not k:
                continue
            if it["qid"] not in by_name[k]:
                by_name[k].append(it["qid"])
            parts = k.split()
            if len(parts) > 1:
                short = " ".join(parts[:-1])
                if it["qid"] not in by_name[short]:
                    by_name[short].append(it["qid"])
    print(f"name index keys: {len(by_name):,}")

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    places = [dict(r) for r in c.execute(
        "select location_id, place, county, province, population, "
        "n_pharmacy_real, n_pharmacy_legal "
        "from v_metrics where is_market = 1")]
    print(f"FDA market places: {len(places):,}")

    # ---- candidates: bulk index + bulk label lookup ----
    # The label lookup must try BOTH forms: the FDA spells places with a type
    # prefix («شهر گتوند», «روستاي ملاشيه») while Wikidata uses the bare name
    # («گتوند», «ملاشیه یک»). Looking up only the prefixed form found 80 of
    # 1,281 names; the stripped form is the one that actually matches.
    variants: dict[str, set[str]] = {}
    for p in places:
        raw, stripped = norm_text(p["place"]), norm_key(p["place"])
        s = variants.setdefault(raw, set())
        if stripped:
            s.add(stripped)
            variants.setdefault(stripped, set()).add(raw)
    all_labels = sorted(variants)
    lookup = label_lookup(all_labels)
    search = mwapi_search(all_labels)
    for k, alts in variants.items():
        merged: list[str] = []
        for nm in [k, *alts]:
            for q in lookup.get(nm, []) + search.get(nm, []):
                if q not in merged:
                    merged.append(q)
        lookup[k] = merged
    print(f"  names resolving to >=1 item: "
          f"{sum(1 for k, v in variants.items() if lookup.get(k)):,}")

    cands_by_place: dict[int, list[tuple[str, str]]] = {}
    pool: set[str] = set()
    for p in places:
        raw, stripped = norm_text(p["place"]), norm_key(p["place"])
        cands: list[tuple[str, str]] = [
            (q, "bulk") for q in by_name.get(stripped, [])]
        seen = {q for q, _s in cands}
        for q in lookup.get(raw, []):
            if q not in seen:
                cands.append((q, "label"))
                seen.add(q)
        cands = cands[:MAX_CANDIDATES]
        cands_by_place[p["location_id"]] = cands
        pool.update(q for q, _s in cands)
    print(f"candidate QIDs: {len(pool):,}")
    names_with_cands = sum(1 for v in cands_by_place.values() if v)
    print(f"places with >=1 candidate: {names_with_cands:,} of {len(places):,}")

    facts, adm_qids = resolve_facts(sorted(pool))
    # labels for QIDs that the bulk set does not already know
    need_lbl = sorted(q for q in pool if q not in by_qid)
    print(f"labels needed for {len(need_lbl):,} new QIDs")
    labels: dict[str, dict] = _load_cache(LABEL_CACHE)
    todo_lbl = [q for q in need_lbl if q not in labels]
    for i in range(0, len(todo_lbl), BATCH):
        chunk = todo_lbl[i:i + BATCH]
        vals = " ".join(f"wd:{q}" for q in chunk)
        fresh: dict[str, dict] = {q: {"fa": None, "en": None} for q in chunk}
        try:
            res = sparql(Q_LABELS % vals)
        except Exception:
            continue
        for b in res["results"]["bindings"]:
            q = b["p"]["value"].rsplit("/", 1)[-1]
            rec = fresh.setdefault(q, {"fa": None, "en": None})
            if b.get("faLabel"):
                rec["fa"] = b["faLabel"]["value"]
            if b.get("enLabel"):
                rec["en"] = b["enLabel"]["value"]
        labels.update(fresh)
        if i % (BATCH * 10) == 0:
            _save_cache(LABEL_CACHE, labels)
        time.sleep(0.28)
    _save_cache(LABEL_CACHE, labels)

    print(f"admin units to label: {len(adm_qids):,}")
    adm_labels = resolve_adm_labels(adm_qids)
    print(f"admin labels resolved: {len(adm_labels):,}")

    # ---- pass 1: score every candidate, keep the FINALISTS (best score) ----
    # A single FDA row often corresponds to several Wikidata items: the feed
    # publishes «روستاي ملاشيه» where the census publishes ملاشیه یک / دو / سه.
    # Those siblings score identically (same name stem, same county), so the
    # winner cannot be "whichever came first" — it has to be an explicit rule.
    per_place: dict[int, dict] = {}
    for p in places:
        scored = []
        for q, _src in cands_by_place.get(p["location_id"], []):
            f = facts.get(q)
            if not f:
                continue
            bulk = by_qid.get(q) or {}
            lbl = labels.get(q) or {}
            nm = lbl.get("fa") or bulk.get("name_fa") or lbl.get("en") \
                or bulk.get("name_en") or ""
            if not nm:
                continue
            adm = " ".join(
                (adm_labels.get(a, {}).get("fa") or adm_labels.get(a, {}).get("en") or "")
                for a in f["adm"])
            it = {"population": f["population"] if f["population"] is not None
                  else bulk.get("population"),
                  "lat": f["lat"], "lon": f["lon"], "fawiki": f["fawiki"],
                  "qid": q, "name": nm}
            s, why = score_match(p, nm, it, adm, geo)
            if s > 0:
                scored.append((s, why, it))
        if not scored:
            per_place[p["location_id"]] = {"top": 0.0, "why": "", "finalists": []}
            continue
        top = max(s for s, _w, _i in scored)
        per_place[p["location_id"]] = {
            "top": top,
            "why": next(w for s, w, _i in scored if abs(s - top) < 1e-9),
            "finalists": [(it, w) for s, w, it in scored if abs(s - top) < 1e-9],
        }

    # ---- fetch census articles for every finalist, not just one ----
    titles = sorted({
        it["fawiki"]
        for pp in per_place.values() if pp["top"] >= min_score
        for it, _w in pp["finalists"]
        if not it.get("population") and it.get("fawiki")
    })
    print(f"\nfinalist articles to read: {len(titles):,}")
    wiki_map = wiki_census(titles)
    print(f"census parsed from {len(wiki_map):,} articles")

    # ---- pass 2: pick among finalists: newest census first, then largest ----
    accepted, unmatched = [], []
    implausible_rejected = 0
    for p in places:
        pp = per_place[p["location_id"]]
        if pp["top"] < min_score or not pp["finalists"]:
            unmatched.append((p, pp["top"], pp["why"]))
            continue
        resolved, rejected = [], 0
        for it, why in pp["finalists"]:
            pop, year, hh = it.get("population"), None, None
            if not pop:
                w = wiki_map.get(it.get("fawiki") or "")
                if w and w[0]:
                    pop, _ys, year, hh = w
            if not pop or pop <= 0:
                continue
            if not plausible_population(p, pop):
                rejected += 1
                continue
            resolved.append((it, why, int(pop), year or 0, hh))
        implausible_rejected += rejected
        if not resolved:
            note = pp["why"]
            if rejected:
                note += f"؛ {rejected} مقدار مرجع با ردپای داروخانه ناسازگار بود و رد شد"
            unmatched.append((p, pp["top"], note))
            continue
        # Newest census wins (the user's explicit requirement is current figures);
        # population breaks a same-year tie (the dominant settlement).
        resolved.sort(key=lambda t: (t[3], t[2]), reverse=True)
        it, why, pop, year, hh = resolved[0]
        note = why
        if len(resolved) > 1:
            others = ", ".join(f"{i['name']}={q:,}" for i, _w, q, _y, _h in resolved[1:4])
            note += f"، از میان {len(resolved)} همنام (جدیدترین سرشماری؛ سایر: {others})"
        accepted.append((p, it, pop, year, hh, pp["top"], note))

    print(f"\naccepted : {len(accepted):,} "
          f"({100*len(accepted)/max(len(places),1):.1f}%)")
    print(f"unmatched: {len(unmatched):,}")
    print(f"rejected as inconsistent with the pharmacy footprint: "
          f"{implausible_rejected:,}")
    if unmatched:
        print("  sample unmatched (top by FDA population):")
        top = sorted(unmatched, key=lambda t: -(t[0].get("population") or 0))[:12]
        for p, s, why in top:
            print(f"    {p['place'][:30]:<30} pop={p['population'] or 0:>9,.0f}"
                  f"  best={s:.2f} {why}")

    c.execute("DELETE FROM population_reference")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rows = 0
    for p, it, pop, year, hh, score, why in accepted:
        src, sid = "wikidata", it["qid"]
        url = f"https://www.wikidata.org/wiki/{it['qid']}"
        year_sh = year - 621 if year else None
        if not it.get("population"):
            w = wiki_map.get(it.get("fawiki") or "")
            if not w or not w[0]:
                continue
            src = "wikipedia-census"
            sid = it.get("fawiki")
            url = ("https://fa.wikipedia.org/wiki/"
                   + urllib.parse.quote((it.get("fawiki") or "").replace(" ", "_")))
        if not pop or pop <= 0:
            continue
        c.execute("""INSERT OR REPLACE INTO population_reference
            (location_id, source, source_id, source_url, population, households,
             census_year, census_year_sh, lat, lon, match_score, match_method, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (p["location_id"], src, sid, url, int(pop), hh, year, year_sh,
             it.get("lat"), it.get("lon"), round(score, 3), why, now))
        rows += 1
    c.commit()

    # The population views are defined over population_reference, so re-apply
    # views.sql now that the table has been rewritten — otherwise the dashboard
    # keeps reading the previous run's coverage numbers.
    views = os.path.join(os.path.dirname(os.path.abspath(__file__)), "views.sql")
    if os.path.exists(views):
        c.executescript(open(views, encoding="utf-8").read())
        c.commit()
        print("re-applied etl/views.sql")

    print(f"\npopulation_reference rows: {rows:,}")
    for r in c.execute("select source, count(*) n from population_reference group by 1"):
        print(f"   {r['source']:<18} {r['n']:>5}")
    for r in c.execute("""select sum(match_score>=0.90) a,
                                 sum(match_score>=0.70 and match_score<0.90) b,
                                 sum(match_score<0.70) d from population_reference"""):
        print(f"   confidence: >=0.90 {r['a']} | 0.70-0.90 {r['b']} | <0.70 {r['d']}")
    print("\nthe user's case:")
    for r in c.execute("""select l.place, l.county, s.population fda, pr.population ref,
                                 pr.source, pr.census_year_sh, pr.match_score, pr.match_method
                          from population_reference pr
                          join locations l on l.id = pr.location_id
                          join location_snapshots s on s.location_id = l.id
                          where l.place like '%ملاش%'"""):
        print("   ", dict(r))
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
