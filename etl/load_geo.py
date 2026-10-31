"""Build the geographic place layer for استان خوزستان and match it to the FDA feed.

Pipeline (each step is separately inspectable):

  1. **OSM places** (`data/raw/osm/khuzestan_places.json`) — every place=city|town|
     village|hamlet|isolated_dwelling|neighbourhood inside the province boundary.
  2. **Administrative resolution.** OSM's Khuzestan mapping is 4=استان,
     6=بخش, 7=دهستان — there are **no شهرستان polygons in OSM for this province**
     (verified: 67 admin_level=6 relations, all named «بخش …»). So the county
     comes from Wikidata: each بخش polygon carries a `wikidata` tag, and the
     item's P131 chain states the شهرستان it belongs to. Geometry decides the
     بخش; Wikidata decides the شهرستان. Nothing is inferred from Name alone —
     «بخش مرکزی» exists in all 27 counties and a name-only lookup would be wrong
     27 times.
  3. **De-duplication inside OSM.** A city is routinely mapped twice (a
     `place=city` node plus a `boundary=administrative` relation). Clusters are
     keyed on (name, county) *and* proximity, never on name alone.
  4. **Matching to the FDA master list** — name agreement is required, county
     agreement is required when both sides know it, and a same-name place in a
     different county is deliberately NOT matched (that is exactly the error the
     reference-population layer was built to avoid).
  5. **Geometry to the reference city** — great-circle distance/bearing from
     اهواز for every place, plus the real OSRM driving distance for the urban
     places (the demo router has Iran coverage; verified فاصله اهواز→دزفول =
     146.0 km / 117 min).
  6. **Coverage notes** in both directions: map places absent from the FDA feed
     (the business question) and FDA places absent from the map (a data-quality
     signal about OSM).

Writes: geo_sources, geo_places, geo_place_duplicate, geo_admin_unit,
geo_location_match, geo_coverage_note; and fills the reserved `locations.lat/lon`
columns for matched FDA places. The FDA tables themselves are never modified.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import classify_place, norm_key, norm_text  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
RAW = os.path.join(HOME, "data", "raw")
OSM = os.path.join(RAW, "osm")
SCHEMA_GEO = os.path.join(HOME, "etl", "schema_geo.sql")
CACHE = os.path.join(HOME, "data", "reference")

# اهواز, the reference city. Taken from the OSM city node (cross-checked against
# the OSRM waypoint it snaps to: 48.669509, 31.320673).
AHVAZ_LAT, AHVAZ_LON = 31.3203, 48.6693

UA = {"User-Agent": "pharmacy-site-selection/1.0 (research)"}
SPARQL = "https://query.wikidata.org/sparql"
OSRM = "https://router.project-osrm.org/route/v1/driving"
OSRM_CACHE = os.path.join(CACHE, "osrm_cache.json")

# Matching thresholds. Name agreement alone is NOT enough to accept a match in a
# province where «علیا», «ملاشیه» and «چم گلک» each exist more than once.
MATCH_ACCEPT = 0.50

# Administrative resolution confidence by method.
ADMIN_CONF = {
    "wikidata-p131": 0.95,     # بakhsh polygon -> Wikidata P131 -> شهرستان
    "wikidata-qid": 0.90,      # the place itself carries a QID with a P131 chain
    "polygon-ambiguous": 0.60,  # point inside >1 بakhsh polygon, finest taken
    "nearest-bakhsh": 0.35,     # outside every polygon, took the closest one
    "none": 0.0,
}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def now_utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# names
# ---------------------------------------------------------------------------
# The Persian letter pairs that Iranian place names swap between spellings
# (هفتکل/هفتگل, بردیا/بردیاه, صفی/سفی). Folding them is what lets the map and
# the pharmacy authority agree on a name; nothing is decided on the fold alone —
# a folded match still needs the same شهرستان.
_FOLD = str.maketrans({
    "گ": "ک", "پ": "ب", "چ": "ج", "ژ": "ز",
    "ح": "ه", "ص": "س", "ث": "س", "ذ": "ز", "ض": "ز", "ظ": "ز",
    "ط": "ت", "غ": "ق", "ع": "", "أ": "ا", "إ": "ا", "آ": "ا",
})

# Arabic diacritics (harakat). OSM spells «دُب حردان» with a damma while the FDA
# writes «دب حردان»; without stripping them the two forms are 8% apart and the
# pair lands in the wrong bucket.
_DIACRITICS = dict.fromkeys(map(ord, "\u064b\u064c\u064d\u064e\u064f\u0650"
                                     "\u0651\u0652\u0653\u0654\u0655\u0670"), None)


def fold_name(name_key: str) -> str:
    """Fold a normalised name to its comparison form.

    Removes spacing, harakat and the Persian letter pairs that genuinely swap
    between sources. Used for *comparison only* — the display name is never
    folded.
    """
    return (name_key.replace(" ", "").translate(_DIACRITICS).translate(_FOLD))


def county_match_key(county: str | None) -> str:
    """Comparison key for a شهرستان name.

    The two sources spell counties differently: the FDA writes «شهرستان باغ ملک»
    and «شهرستان بندرماهشهر», Wikidata «شهرستان باغملک» and «شهرستان ماهشهر».
    Exact comparison rejected those, which turned real matches into false "new
    locations". The key folds spacing, harakat and letter variants; a substring
    test handles the بقیه cases (ماهشهر ⊂ بندرماهشهر).
    """
    return fold_name(norm_key(county or ""))


def counties_compatible(a: str | None, b: str | None) -> bool:
    ka, kb = county_match_key(a), county_match_key(b)
    if not ka or not kb:
        return False
    return ka == kb or ka in kb or kb in ka


_COUNTY_RE = re.compile(r"شهرستان\s+(\S.*)$")


def county_from_label(label: str) -> str | None:
    """Pull a شهرستان out of an administrative label.

    Necessary because Wikidata's P131 chain for a village runs
    village -> دهستان -> **بخش** -> شهرستان, and the بakhsh labels embed the
    county name: «بخش مرکزی شهرستان هفتگل». Taking "the first label containing
    شهرستان" therefore returns a *بakhsh*, which is what the first run did — it
    silently produced county values like «بخش مرکزی شهرستان هفتگل» that matched
    no FDA county at all, and pushed 68 good matches into the "new" bucket.
    """
    if not label:
        return None
    m = _COUNTY_RE.search(label)
    if m:
        return "شهرستان " + m.group(1).strip()
    return None


def fold_ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


# Leading tokens that mark a *kind* of settlement rather than its name. The two
# sources attach them inconsistently — OSM «ده ملابزرگ» against the FDA's
# «روستای ده ملابزرگ», whose own normalisation has already eaten the «روستای »
# and therefore keeps the «ده» that OSM's has dropped. Comparing after removing a
# single leading token resolves those pairs instead of queueing them by hand.
_LEADING_KIND = ("ده", "شهرک", "مزرعه", "بنوار", "آبادی", "کانون", "تیره",
                 "دهستان", "روستا", "شهر", "بخش", "پاسگاه", "ایستگاه")


def without_leading_kind(compact_name: str) -> str:
    parts = compact_name.split()
    if len(parts) > 1 and parts[0] in _LEADING_KIND:
        return " ".join(parts[1:])
    return compact_name


def trigrams(s: str) -> list[str]:
    """3-grams of the folded comparison form, for the fuzzy candidate index.

    A prefix index cannot join «ملابزرگ» with «دهملابزرگ» — they do not share a
    first character. Trigrams do, and with ~3k rows the whole inverted index is
    a few tens of thousands of entries.
    """
    if len(s) < 3:
        return [s] if s else []
    return [s[i:i + 3] for i in range(len(s) - 2)]


def migrate(con: sqlite3.Connection) -> list[str]:
    """Additive column migrations, in the same style as etl/load.py.

    `CREATE TABLE IF NOT EXISTS` does not touch a table that already exists, so a
    database created by an earlier revision of schema_geo.sql keeps the old shape
    and every INSERT of a new column fails. These catch that up in place.
    """
    applied = []
    for table, column, decl in GEO_MIGRATIONS:
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
            applied.append(f"{table}.{column}")
    if applied:
        con.commit()
    return applied


GEO_MIGRATIONS = (
    ("geo_places", "county_alt", "TEXT"),
    ("geo_places", "admin_source", "TEXT"),
    ("geo_location_match", "tier", "TEXT NOT NULL DEFAULT 'match'"),
    ("geo_places", "pop_ref_url", "TEXT"),
    ("geo_places", "pop_match_score", "REAL"),
    ("geo_places", "pop_match_method", "TEXT"),
    ("geo_places", "wd_lat", "REAL"),
    ("geo_places", "wd_lon", "REAL"),
    ("geo_places", "wd_separation_m", "REAL"),
    # catchment, written by export_geo_map.py (scipy k-d tree), not by this loader
    ("geo_places", "settlements_20km", "INTEGER"),
    ("geo_places", "population_20km", "INTEGER"),
    ("geo_places", "settlements_30km", "INTEGER"),
    ("geo_places", "population_30km", "INTEGER"),
    ("geo_places", "settlements_50km", "INTEGER"),
    ("geo_places", "population_50km", "INTEGER"),
)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


# ---------------------------------------------------------------------------
# Wikidata: بakhsh polygon -> شهرستان
# ---------------------------------------------------------------------------
def sparql(query: str, timeout: int = 240, attempts: int = 5) -> dict:
    data = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    delay, last = 10.0, None
    for _ in range(attempts):
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
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(delay)
        delay = min(delay * 2, 180)
    raise last if last else RuntimeError("sparql failed")


BATCH = 120
ADMIN_CACHE = os.path.join(CACHE, "geo_admin_labels.json")


def resolve_admin_units(qids: list[str]) -> dict[str, dict]:
    """QID -> {fa, en, county_fa, county_en} for the بakhsh polygons."""
    cache = {}
    if os.path.exists(ADMIN_CACHE):
        try:
            cache = json.load(open(ADMIN_CACHE, encoding="utf-8"))
        except Exception:  # noqa: BLE001
            cache = {}
    todo = [q for q in qids if q not in cache]
    print(f"  admin units: {len(qids)} QIDs, {len(todo)} to resolve "
          f"({len(cache):,} cached)", flush=True)
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        vals = " ".join(f"wd:{q}" for q in chunk)
        q = """
SELECT ?p ?faLabel ?enLabel ?countyFa ?countyEn WHERE {
  VALUES ?p { %s }
  OPTIONAL { ?p rdfs:label ?faLabel FILTER(lang(?faLabel)="fa") }
  OPTIONAL { ?p rdfs:label ?enLabel FILTER(lang(?enLabel)="en") }
  OPTIONAL { ?p wdt:P131 ?c .
             OPTIONAL { ?c rdfs:label ?countyFa FILTER(lang(?countyFa)="fa") }
             OPTIONAL { ?c rdfs:label ?countyEn FILTER(lang(?countyEn)="en") } }
}
""" % vals
        fresh: dict[str, dict] = {x: {"fa": None, "en": None,
                                      "county_fa": None, "county_en": None}
                                  for x in chunk}
        try:
            res = sparql(q)
        except Exception as e:  # noqa: BLE001
            print(f"    batch {i//BATCH}: FAILED {type(e).__name__}", flush=True)
            continue
        for b in res["results"]["bindings"]:
            rec = fresh.setdefault(b["p"]["value"].rsplit("/", 1)[-1], {})
            rec.setdefault("fa", None); rec.setdefault("en", None)
            rec.setdefault("county_fa", None); rec.setdefault("county_en", None)
            if b.get("faLabel"):
                rec["fa"] = b["faLabel"]["value"]
            if b.get("enLabel"):
                rec["en"] = b["enLabel"]["value"]
            if b.get("countyFa"):
                rec["county_fa"] = b["countyFa"]["value"]
            if b.get("countyEn"):
                rec["county_en"] = b["countyEn"]["value"]
        cache.update(fresh)
        json.dump(cache, open(ADMIN_CACHE, "w", encoding="utf-8"), ensure_ascii=False)
        time.sleep(0.3)
    return {q: cache[q] for q in qids if q in cache}


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------
def relation_segments(rel: dict) -> np.ndarray | None:
    """Every member-way segment of a relation as (n,4) [x1,y1,x2,y2] in lon/lat.

    Ring assembly is deliberately skipped: an even-odd ray cast over *all*
    segments of a multipolygon gives the correct in/out answer for outer rings
    and for holes without having to stitch ends, which matters because Overpass
    `out geom;` returns the member ways unordered and broken.
    """
    segs = []
    for m in rel.get("members", []):
        g = m.get("geometry")
        if not g or len(g) < 2:
            continue
        for a, b in zip(g, g[1:]):
            segs.append((a["lon"], a["lat"], b["lon"], b["lat"]))
    return np.asarray(segs, dtype=float) if segs else None


def points_inside(segs: np.ndarray, lonlat: np.ndarray) -> np.ndarray:
    x1, y1, x2, y2 = segs[:, 0], segs[:, 1], segs[:, 2], segs[:, 3]
    px, py = lonlat[:, 0][:, None], lonlat[:, 1][:, None]
    straddles = ((y1 <= py) & (y2 > py)) | ((y1 > py) & (y2 <= py))
    with np.errstate(divide="ignore", invalid="ignore"):
        x_cross = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
    crossings = straddles & (px < x_cross)
    return (crossings.sum(axis=1) % 2) == 1


# ---------------------------------------------------------------------------
# 1. load + normalise the OSM capture
# ---------------------------------------------------------------------------
def read_osm_places(path: str) -> list[dict]:
    payload = json.load(open(path, encoding="utf-8"))
    out = []
    for el in payload["elements"]:
        t = el.get("tags") or {}
        place = t.get("place")
        if not place:
            continue
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        raw_name = (t.get("name") or t.get("name:fa") or t.get("name:en") or "").strip()
        if not raw_name:
            continue
        pop = None
        try:
            pop = int(float(str(t.get("population", "")).replace(",", "")))
        except (TypeError, ValueError):
            pop = None
        out.append({
            "source_id": f"{el['type']}/{el['id']}",
            "osm_type": el["type"],
            "osm_id": el["id"],
            "name": raw_name,
            "name_clean": norm_text(raw_name),
            "name_key": norm_key(raw_name),
            "name_en": t.get("name:en"),
            "place_kind": place,
            "lat": float(lat),
            "lon": float(lon),
            "pop_osm": pop,
            "pop_osm_date": t.get("population:date"),
            "wikidata": t.get("wikidata"),
            "wikipedia": t.get("wikipedia"),
            "alt_names": sorted({v for k, v in t.items()
                                 if k.startswith(("alt_name", "name:"))
                                 and k not in ("name:en",) and v}),
            "tags": t,
        })
    return out


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    t0 = time.time()
    place_path = os.path.join(OSM, "khuzestan_places.json")
    admin_path = os.path.join(OSM, "khuzestan_admin6.json")
    places = read_osm_places(place_path)
    print(f"OSM places with a name and coordinates: {len(places):,}")
    print("  by kind:", dict(Counter(p["place_kind"] for p in places)))

    admins = json.load(open(admin_path, encoding="utf-8"))["elements"]
    print(f"OSM admin_level=6 (بخش) relations: {len(admins)}")

    # ---- the FDA master list, needed early (it supplies the 27 county names
    #      and the city -> county map used to break «بخش مرکزی» ties) ----------
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.executescript(open(SCHEMA_GEO, encoding="utf-8").read())
    applied = migrate(c)
    if applied:
        print(f"  additive migrations applied: {applied}")
    c.commit()
    fda = [dict(r) for r in c.execute("""
        SELECT m.location_id, m.place, m.place_kind, m.county, m.district,
               m.population, m.n_pharmacy_total, m.is_market,
               -- the *reference layer's* own coordinate (Wikidata/census QID
               -- resolution), never `locations.lat/lon`: those are filled BY this
               -- script, so reading them back would make the separation check
               -- compare a point with itself and always report 0 m.
               pr.lat AS ref_lat, pr.lon AS ref_lon
        FROM v_metrics m
        JOIN locations l ON l.id = m.location_id
        LEFT JOIN population_reference pr ON pr.location_id = m.location_id
        WHERE l.province_key LIKE '%خوزستان%'""")]
    print(f"FDA Khuzestan rows to match against: {len(fda):,}")
    county_names = {norm_key(r["county"]) for r in fda if r["county"]}
    # city/شهر spelling -> the county the pharmacy authority files it under.
    city_to_county: dict[str, str] = {}
    for r in fda:
        if r["place_kind"] in ("city", "other"):
            city_to_county.setdefault(norm_key(r["place"]), r["county"])

    # ---- 2a. Wikidata gives each بakhsh its شهرستان -------------------------
    qids = sorted({(a["tags"] or {}).get("wikidata") for a in admins
                   if (a["tags"] or {}).get("wikidata")})
    labels = resolve_admin_units(qids) if qids else {}

    admin_rows = []
    for a in admins:
        t = a["tags"] or {}
        qid = t.get("wikidata")
        lab = labels.get(qid or "", {})
        # The P131 target's label is usually «شهرستان X», but for a few بakhsh
        # items the chain stops one level short and the label is itself a بakhsh
        # string («بخش مرکزی شهرستان اهواز»). county_from_label extracts the
        # county from either shape — without it, every place in that polygon
        # carries a county that matches no FDA row.
        county_fa = county_from_label(lab.get("county_fa") or "") or lab.get("county_fa")
        admin_rows.append({
            "osm_type": a["type"], "osm_id": a["id"],
            "admin_level": t.get("admin_level"),
            "name": t.get("name") or "",
            "name_key": norm_key(t.get("name") or ""),
            "unit_kind": "bakhsh",
            "county": county_fa,
            "county_key": norm_key(county_fa) if county_fa else None,
            "wikidata": qid,
            "wikipedia": t.get("wikipedia"),
            "n_members": len(a.get("members") or []),
        })
    known = sum(1 for r in admin_rows if r["county"])
    print(f"  بakhsh units with a Wikidata-derived شهرستان: {known}/{len(admin_rows)}")
    miss = [r["name"] for r in admin_rows if not r["county"]]
    if miss:
        print(f"  unresolved: {miss[:12]}")

    polys = []
    for a in admins:
        segs = relation_segments(a)
        if segs is None:
            continue
        polys.append({
            "segments": segs,
            "bbox": (segs[:, 0].min(), segs[:, 1].min(),
                     segs[:, 0].max(), segs[:, 1].max()),
            "name": (a["tags"] or {}).get("name") or "",
            "name_key": norm_key((a["tags"] or {}).get("name") or ""),
            "qid": (a["tags"] or {}).get("wikidata"),
            "osm_id": a["id"],
        })
    print(f"  polygons built: {len(polys)}  "
          f"(segments: {sum(len(p['segments']) for p in polys):,})")

    # ---- 2b. place -> بakhsh by even-odd ray cast ---------------------------
    lonlat = np.array([[p["lon"], p["lat"]] for p in places], dtype=float)
    hits: list[list[int]] = [[] for _ in places]
    for pi, poly in enumerate(polys):
        x0, y0, x1, y1 = poly["bbox"]
        pre = np.where((lonlat[:, 0] >= x0) & (lonlat[:, 0] <= x1) &
                       (lonlat[:, 1] >= y0) & (lonlat[:, 1] <= y1))[0]
        if pre.size == 0:
            continue
        inside = points_inside(poly["segments"], lonlat[pre])
        for idx in pre[inside]:
            hits[idx].append(pi)

    n_none = sum(1 for h in hits if not h)
    n_multi = sum(1 for h in hits if len(h) > 1)
    print(f"  inside one بakhsh: {len(places)-n_none-n_multi:,} | "
          f"inside >1: {n_multi} | inside none: {n_none}")

    by_key = {r["name_key"]: r for r in admin_rows}
    by_qid = {r["wikidata"]: r for r in admin_rows if r["wikidata"]}
    centroids = [(p["segments"][:, 0].mean(), p["segments"][:, 1].mean())
                 for p in polys]

    for i, p in enumerate(places):
        h = hits[i]
        method, conf = "none", ADMIN_CONF["none"]
        if len(h) == 1:
            chosen = h[0]
            method, conf = "wikidata-p131", ADMIN_CONF["wikidata-p131"]
        elif len(h) > 1:
            # Overlapping polygons: prefer the finest (fewest segments == most
            # specific) rather than the first one, and mark the row resolved-but-
            # ambiguous so it is never presented as certain.
            chosen = min(h, key=lambda k: len(polys[k]["segments"]))
            method, conf = "polygon-ambiguous", ADMIN_CONF["polygon-ambiguous"]
        else:
            d = [haversine_km(p["lat"], p["lon"], c[1], c[0]) for c in centroids]
            k = int(np.argmin(d))
            if d[k] <= 25.0:
                chosen = k
                method, conf = "nearest-bakhsh", ADMIN_CONF["nearest-bakhsh"]
            else:
                chosen = None
        if chosen is None:
            p.update(district=None, district_key=None,
                     admin_method="none", admin_confidence=ADMIN_CONF["none"])
            p["_poly"] = None
            continue
        poly = polys[chosen]
        p["_poly"] = chosen
        p.update(
            district=poly["name"],
            district_key=poly["name_key"],
            admin_method=method,
            admin_confidence=conf,
            _own_county=None,
            _own_adm_keys=set(),
        )

    # ---- 2c. own-QID county (independent of the polygon) --------------------
    # A village's P131 chain runs village -> دهستان -> بخش -> شهرستان, so three
    # hops reach the county. Where this answer exists it is preferred over the
    # polygon's, because it is a statement about *this* place rather than about
    # the area it happens to sit in — and where the two disagree the disagreement
    # is kept in county_alt rather than resolved silently.
    own_qids = sorted({p["wikidata"] for p in places if p.get("wikidata")})
    own: dict[str, list[str]] = {}
    if own_qids:
        print(f"  places carrying their own QID: {len(own_qids)}")
        own_cache = os.path.join(CACHE, "geo_place_admin.json")
        if os.path.exists(own_cache):
            try:
                own = json.load(open(own_cache, encoding="utf-8"))
            except Exception:  # noqa: BLE001
                own = {}
        todo = [q for q in own_qids if q not in own]
        print(f"    admin chains to resolve: {len(todo)} ({len(own)} cached)")
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            q = """
SELECT ?p ?lbl WHERE {
  VALUES ?p { %s }
  { ?p wdt:P131 ?a } UNION { ?p wdt:P131/wdt:P131 ?a }
  UNION { ?p wdt:P131/wdt:P131/wdt:P131 ?a }
  ?a rdfs:label ?lbl FILTER(lang(?lbl) = "fa")
}
""" % " ".join(f"wd:{x}" for x in chunk)
            try:
                res = sparql(q)
            except Exception as e:  # noqa: BLE001
                print(f"    admin chain batch {i//BATCH}: FAILED {type(e).__name__}")
                continue
            for b in res["results"]["bindings"]:
                qid = b["p"]["value"].rsplit("/", 1)[-1]
                chain = own.setdefault(qid, [])
                v = b["lbl"]["value"]
                if v not in chain:
                    chain.append(v)
            json.dump(own, open(own_cache, "w", encoding="utf-8"), ensure_ascii=False)
            time.sleep(0.3)
    for p in places:
        chain = own.get(p.get("wikidata") or "", [])
        p["_own_adm_keys"] = {norm_key(x) for x in chain}
        p["_own_county"] = None
        for x in chain:
            cc = county_from_label(x)
            if cc:
                p["_own_county"] = cc
                break

    # ---- 2d. resolve the بakhsh polygons Wikidata could not ------------------
    # 17 of the 67 are named «بخش مرکزی» with no QID — the single most ambiguous
    # name in the whole hierarchy, since **every** county has one. Three
    # independent routes, tried in order, and the route used is recorded:
    #
    #   votes         the county that the places *inside* this polygon state in
    #                 their own Wikidata P131 chain (independent of the polygon)
    #   seat          the polygon's own name after «مرکزی» («بخش مرکزی لالی»,
    #                 «بخش مرکزی شهرستان کوت عبد الله») resolved through the FDA
    #                 list, which knows which county each city belongs to
    #   seat-city     the largest city/town inside the polygon whose name is a
    #                 county name — the county seat always sits in بخش مرکزی
    poly_county: dict[int, str] = {}
    for i, poly in enumerate(polys):
        adm = by_qid.get(poly["qid"]) or by_key.get(poly["name_key"]) or {}
        if adm.get("county"):
            poly_county[i] = adm["county"]

    unresolved = [i for i in range(len(polys)) if i not in poly_county]
    print(f"  polygons needing a non-Wikidata route: {len(unresolved)}")
    for i in unresolved:
        members = [p for p in places if p.get("_poly") == i]
        votes = Counter(p["_own_county"] for p in members if p.get("_own_county"))
        if votes:
            poly_county[i] = votes.most_common(1)[0][0]
            polys[i]["county_method"] = "votes"
            continue
        tail = polys[i]["name"]
        tail = tail.split("مرکزی", 1)[1].strip() if "مرکزی" in tail else tail
        tail = tail.replace("شهرستان", " ").strip()
        if tail and norm_key(tail) in county_names:
            poly_county[i] = tail
            polys[i]["county_method"] = "seat"
            continue
        if tail and norm_key(tail) in city_to_county:
            poly_county[i] = city_to_county[norm_key(tail)]
            polys[i]["county_method"] = "seat"
            continue
        seats = [p for p in members
                 if p["place_kind"] in ("city", "town", "village")
                 and (norm_key(p["name"]) in county_names
                      or norm_key(p["name"]) in city_to_county)]
        if seats:
            best = max(seats, key=lambda p: (p.get("pop_osm") or 0,
                                             1 if p["place_kind"] == "city" else 0))
            key = norm_key(best["name"])
            poly_county[i] = best["name"] if key in county_names else city_to_county[key]
            polys[i]["county_method"] = "seat-city"
            continue
        polys[i]["county_method"] = "unresolved"
    by_method = Counter(polys[i].get("county_method", "wikidata")
                        for i in range(len(polys)))
    print(f"  بakhsh county routes: {dict(by_method)}")
    for i, poly in enumerate(polys):
        for r in admin_rows:
            if r["osm_id"] == poly["osm_id"]:
                r["county"] = poly_county.get(i)
                r["county_key"] = norm_key(r["county"]) if r["county"] else None
                break

    # ---- 2e. assign the county to every place -------------------------------
    # A place's own Wikidata statement wins over the area it sits in; where the
    # two disagree the polygon's answer is kept in county_alt, so the
    # disagreement is visible instead of averaged away.
    n_own = n_poly = n_none = n_conflict = 0
    for p in places:
        poly_c = poly_county.get(p["_poly"]) if p.get("_poly") is not None else None
        own_c = p.get("_own_county")
        if own_c:
            n_own += 1
            if poly_c and norm_key(poly_c) != norm_key(own_c):
                p["county_alt"] = poly_c
                p["_county_conflict"] = True
                n_conflict += 1
            else:
                p["county_alt"] = None
            p["county"] = own_c
            p["admin_method"] = "wikidata-qid"
            p["admin_confidence"] = ADMIN_CONF["wikidata-qid"]
        elif poly_c:
            n_poly += 1
            p["county"] = poly_c
            p["county_alt"] = None
        else:
            n_none += 1
            p["county"] = None
            p["county_alt"] = None
            p["admin_method"] = "none"
            p["admin_confidence"] = ADMIN_CONF["none"]
        p["county_key"] = norm_key(p["county"]) if p["county"] else None
    print(f"  county by the place's own QID: {n_own:,} | from its polygon: "
          f"{n_poly:,} | unknown: {n_none:,}")
    print(f"  the two independent routes disagree on {n_conflict} place(s)")

    # ---- 3. de-duplicate inside OSM ----------------------------------------
    now = now_utc()
    match_rows: list[tuple] = []
    # Grouped by name, then clustered by proximity — but two records only merge
    # when their شهرستان also agrees (or one is unknown). Grouping on an exact
    # county key was too strict: OSM itself calls the same county both
    # «شهرستان ماهشهر» and «شهرستان بندرماهشهر», so «بندر ماهشهر» and
    # «شهر بندر ماهشهر» survived as two points on the map.
    groups: dict[str, list[int]] = defaultdict(list)
    for i, p in enumerate(places):
        groups[p["name_key"]].append(i)

    survivor_of: dict[int, int] = {}
    dup_rows: list[dict] = []
    for _key, idxs in groups.items():
        if len(idxs) == 1:
            survivor_of[idxs[0]] = idxs[0]
            continue
        # greedy cluster: within 20 km of the cluster's first member
        used = set()
        for a in idxs:
            if a in used:
                continue
            cluster = [a]
            used.add(a)
            for b in idxs:
                if b in used:
                    continue
                ca, cb = places[a].get("county"), places[b].get("county")
                if ca and cb and not counties_compatible(ca, cb):
                    continue          # same name, genuinely different county
                if haversine_km(places[a]["lat"], places[a]["lon"],
                                places[b]["lat"], places[b]["lon"]) <= 20.0:
                    cluster.append(b)
                    used.add(b)

            def rank(k: int):
                p = places[k]
                return (1 if p["pop_osm"] else 0,           # a population beats none
                        1 if p["wikidata"] else 0,          # an identity link
                        1 if p["osm_type"] == "node" else 0,  # a point beats a boundary
                        len(p["alt_names"]))

            # Prefer the node carrying data; a boundary relation's `center` is the
            # same coordinates, so nothing is lost by dropping it.
            win = max(cluster, key=rank)
            for k in cluster:
                survivor_of[k] = win
                if k != win:
                    dup_rows.append({
                        "survivor": win, "duplicate": k,
                        "duplicate_source_id": places[k]["source_id"],
                        "duplicate_kind": places[k]["place_kind"],
                        "separation_m": haversine_km(
                            places[win]["lat"], places[win]["lon"],
                            places[k]["lat"], places[k]["lon"]) * 1000,
                        "reason": ("city mapped twice (node + boundary relation)"
                                   if {places[win]["osm_type"], places[k]["osm_type"]}
                                   & {"way", "relation"} else "same name, same county, "
                                   f"within 20 km ({places[k]['source_id']})"),
                    })
    kept = sorted({v for v in survivor_of.values()})
    print(f"  after de-duplication: {len(kept):,} places "
          f"({len(dup_rows)} duplicates recorded)")

    # ---- 4. match to the FDA master list -----------------------------------
    # Candidates are looked up through FOUR indexes, not just the exact name key.
    # Exact-only lookup was the second real bug: «ملاشیه یک» never saw the FDA's
    # «روستاي ملاشيه» because the prefix rule can only fire on a row that is
    # already in the candidate list. The indexes are:
    #   by exact name key · by name with spaces removed · by the first 4
    #   characters of the name · by the first 4 characters of the *folded* name
    # The last one is what puts «هفتکل» next to the FDA's «هفتگل».
    fda_by_key: dict[str, list[dict]] = defaultdict(list)
    fda_compact: dict[str, list[dict]] = defaultdict(list)
    fda_prefix: dict[str, list[dict]] = defaultdict(list)
    fda_fold: dict[str, list[dict]] = defaultdict(list)
    fda_tri: dict[str, list[dict]] = defaultdict(list)
    for row in fda:
        row["name_key"] = norm_key(row["place"])
        row["compact"] = row["name_key"].replace(" ", "")
        row["folded"] = fold_name(row["name_key"])
        row["county_key"] = norm_key(row["county"])
        fda_by_key[row["name_key"]].append(row)
        fda_compact[row["compact"]].append(row)
        fda_prefix[row["compact"][:4]].append(row)
        fda_fold[row["folded"][:4]].append(row)
        for tri in set(trigrams(row["folded"])):
            fda_tri[tri].append(row)

    def score(p: dict, row: dict) -> tuple[float, str, str]:
        """-> (score, reason, tier).

        The tier decides what the *result* means, and the distinction is the whole
        point of this function:

          'name'    an accepted match — a name that is the same name, in the same
                    city-county, possibly written differently.
          'fuzzy'   a probable variant — a near-identical name, or an identical
                    name whose شهرستان differs. Iran re-draws county boundaries
                    (کرخه out of شوش, with the pharmacy feed still filing those
                    villages under شوش), so a county mismatch cannot be allowed to
                    *hide* a place; it downgrades it to a question.
          'none'    no plausible counterpart on the FDA side.
        """
        nk, cp = p["name_key"], p["name_key"].replace(" ", "")
        fc = fold_name(nk)
        r_nk, r_cp, r_fc = row["name_key"], row["compact"], row["folded"]
        tier = "name"
        if nk == r_nk:
            score, why = 0.55, "نام یکسان"
        elif cp == r_cp:
            score, why = 0.50, "نام یکسان (فاصله‌ها نادیده)"
        elif fc == r_fc:
            score, why = 0.48, "نام یکسان پس از یکسان‌سازی حروف"
        elif without_leading_kind(nk) == without_leading_kind(r_nk):
            score, why = 0.46, "نام یکسان پس از حذف پیشوند نوعی"
        elif (nk.startswith(r_nk) or r_nk.startswith(nk) or
              cp.startswith(r_cp) or r_cp.startswith(cp)) and \
                min(len(cp), len(r_cp)) >= 4:
            score, why = 0.28, "نام با پیشوند مشترک"
        else:
            ratio = fold_ratio(cp, r_cp)
            if ratio >= 0.86:
                tier = "fuzzy"
                score, why = 0.20 + 0.25 * (ratio - 0.86) / 0.14, \
                    f"نام مشابه ({ratio:.2f})"
            else:
                return 0.0, "نام نامرتبط", "none"
        if p.get("county_key") and row["county_key"]:
            if counties_compatible(p["county"], row["county"]):
                score += 0.30
                why += "، شهرستان مطابق"
            elif tier == "name":
                # Same name, different شهرستان. Kept as a question, and the score
                # is left without the county bonus so an exactly-equal name (0.55)
                # still clears the bar while a loose prefix match does not.
                tier = "fuzzy"
                why += f"، شهرستان متفاوت ({p['county']} ↔ {row['county']})"
        elif p.get("county_key") or row["county_key"]:
            score += 0.05
            why += "، شهرستان فقط یک طرف"
        return min(score, 1.0), why, tier

    geo_rows: list[dict] = []
    unmatched_fda = {r["location_id"] for r in fda}
    for i in kept:
        p = places[i]
        cp = p["name_key"].replace(" ", "")
        seen_ids = set()
        cands = []
        buckets = [fda_by_key.get(p["name_key"], []),
                   fda_compact.get(cp, []),
                   fda_prefix.get(cp[:4], []),
                   fda_fold.get(fold_name(p["name_key"])[:4], [])]
        # Trigram bucket: only worth the extra candidates when nothing exact was
        # found — otherwise it would drag hundreds of loose names into every call.
        if not buckets[0] and not buckets[1]:
            tri_hits: dict[int, int] = {}
            for tri in set(trigrams(fold_name(p["name_key"]))):
                for row in fda_tri.get(tri, []):
                    tri_hits[id(row)] = tri_hits.get(id(row), 0) + 1
            by_id = {id(r): r for r in fda}
            # Two shared trigrams is the floor: one is noise. The earlier version
            # took the top 40 by count regardless, which dropped genuine pairs
            # whose only common ground is the tail of the name — «فرع زایر» vs the
            # FDA's «فرغ زایر» share just «زای» and «ایر», and a village of 657
            # people was reported as a new location because of it.
            ranked = sorted(tri_hits.items(), key=lambda kv: -kv[1])
            buckets.append([by_id[i] for i, n in ranked[:150]
                            if n >= 2 and i in by_id])
        for bucket in buckets:
            for row in bucket:
                if row["location_id"] not in seen_ids:
                    seen_ids.add(row["location_id"])
                    cands.append(row)
        scored = []
        for row in cands:
            s, why, tier = score(p, row)
            if s >= MATCH_ACCEPT:
                scored.append((s, why, tier, row))
        scored.sort(key=lambda t: (-t[0], t[2] != "name"))
        geo_rows.append({**p, "_scored": scored})

    # ---- 5. geometry to اهواز ----------------------------------------------
    # Great-circle distance and bearing for every place. The *driving* distance is
    # a separate enrichment step (etl/enrich_geo_road.py) precisely because this
    # function deletes and re-creates its own output: fetching a 90-request OSRM
    # matrix here would throw it away on the next rebuild.
    for g in geo_rows:
        g["distance_km"] = haversine_km(AHVAZ_LAT, AHVAZ_LON, g["lat"], g["lon"])
        g["bearing_deg"] = bearing_deg(AHVAZ_LAT, AHVAZ_LON, g["lat"], g["lon"])

    # ---- 6. write ----------------------------------------------------------
    obs = now
    c.execute("DELETE FROM geo_location_match")
    c.execute("DELETE FROM geo_place_duplicate")
    src_registry = [
        ("osm", place_path, "ODbL 1.0 (OpenStreetMap contributors)",
         len(places), "place=city|town|village|hamlet|isolated_dwelling|neighbourhood, "
                      "inside استان خوزستان (rel 3661581)"),
        ("osm", admin_path, "ODbL 1.0 (OpenStreetMap contributors)",
         len(admins), "admin_level=6 (بخش) boundaries with geometry, used for the "
                      "point-in-polygon district assignment"),
    ]
    for layer, ref, lic, cnt, note in src_registry:
        c.execute("""INSERT OR REPLACE INTO geo_sources
            (layer, ref, licence, sha256, observed_at, ingested_at, element_count, notes)
            VALUES (?,?,?,?,?,?,?,?)""",
            (layer, ref, lic, sha256_file(ref), obs, now, cnt, note))

    c.execute("DELETE FROM geo_admin_unit")
    for r in admin_rows:
        c.execute("""INSERT INTO geo_admin_unit
            (osm_type, osm_id, admin_level, name, name_key, unit_kind, county,
             county_key, wikidata, wikipedia, n_members, observed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r["osm_type"], r["osm_id"], r["admin_level"], r["name"], r["name_key"],
             r["unit_kind"], r["county"], r["county_key"], r["wikidata"],
             r["wikipedia"], r["n_members"], obs))

    c.execute("DELETE FROM geo_places")
    for g in geo_rows:
        scored = g.pop("_scored")
        best = scored[0] if scored else None
        tier = best[2] if best else None
        row = best[3] if best else None
        sep = None
        if row and row.get("ref_lat"):
            sep = haversine_km(g["lat"], g["lon"],
                               row["ref_lat"], row["ref_lon"]) * 1000
        flags = []
        if not g.get("county"):
            flags.append("no_county")
        if g.get("admin_method") == "polygon-ambiguous":
            flags.append("admin_ambiguous")
        if g.get("admin_method") == "nearest-bakhsh":
            flags.append("outside_bakhsh_polygons")
        if g.get("_county_conflict"):
            flags.append("county_sources_disagree")
        if not g["pop_osm"]:
            flags.append("no_population_on_map")
        if g["place_kind"] == "neighbourhood":
            flags.append("city_neighbourhood_not_a_settlement")
        if "name" not in g["tags"]:
            flags.append("name_from_a_name_key_only")
        # A village of 100k people in خوزستان does not exist. The map's population
        # tag — and occasionally Wikidata — carries the *city* total for a nearby
        # village; the first run produced «دُب حردان» (a village 15 km from اهواز)
        # with 1,000,000. Flagged, not silently averaged into the ranking.
        pop_seen = g["pop_osm"] or 0
        if pop_seen >= 50_000 and g["place_kind"] in ("village", "hamlet",
                                                      "isolated_dwelling",
                                                      "neighbourhood"):
            flags.append("pop_outlier")
        if tier == "fuzzy":
            flags.append("name_variant_of_fda_row")
        in_fda = 1 if (row and tier == "name") else 0
        db_tier = ("match" if tier == "name"
                   else "variant" if tier == "fuzzy" else None)
        c.execute("""INSERT INTO geo_places
            (source, source_id, osm_type, osm_id, name, name_clean, name_key,
             name_en, alt_names, place_kind, lat, lon, province, county, county_alt,
             district, county_key, district_key, admin_method, admin_source,
             admin_confidence, pop_osm, pop_osm_date, wikidata, wikipedia,
             distance_km, road_km, road_minutes, bearing_deg,
             in_fda, is_in_fda_scope, dq_flags, tags, observed_at)
            VALUES ('osm',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (g["source_id"], g["osm_type"], g["osm_id"], g["name"], g["name_clean"],
             g["name_key"], g["name_en"],
             json.dumps(g["alt_names"], ensure_ascii=False) if g["alt_names"] else None,
             g["place_kind"], g["lat"], g["lon"], "استان خوزستان",
             g.get("county"), g.get("county_alt"), g.get("district"),
             g.get("county_key"), g.get("district_key"), g.get("admin_method"),
             "wikidata" if str(g.get("admin_method", "")).startswith("wikidata")
             else "geometric",
             g.get("admin_confidence"),
             g["pop_osm"], g["pop_osm_date"], g.get("wikidata"), g.get("wikipedia"),
             g["distance_km"], None, None,
             g["bearing_deg"], in_fda,
             1 if (in_fda and row["is_market"]) else 0,
             ", ".join(flags) or None,
             json.dumps(g["tags"], ensure_ascii=False), obs))
        geo_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]
        g["_matched"] = in_fda
        g["_tier"] = tier
        if row:
            match_rows.append((geo_id, row["location_id"], db_tier, best[0], best[1],
                               sep, now))
            if in_fda:
                unmatched_fda.discard(row["location_id"])
                # Fill the reserved coordinate columns on the FDA master row.
                # Additive: only lat/lon, and only when empty.
                c.execute("""UPDATE locations SET lat = COALESCE(lat, ?),
                                                    lon = COALESCE(lon, ?)
                              WHERE id = ?""",
                          (g["lat"], g["lon"], row["location_id"]))
        g["_geo_id"] = geo_id

    by_sid = {g["source_id"]: g["_geo_id"] for g in geo_rows}
    c.executemany("""INSERT OR REPLACE INTO geo_location_match
        (geo_place_id, location_id, tier, match_score, match_method,
         separation_m, decided_at)
        VALUES (?,?,?,?,?,?,?)""", match_rows)
    for d in dup_rows:
        c.execute("""INSERT INTO geo_place_duplicate
            (survivor_id, duplicate_id, duplicate_source_id, duplicate_kind,
             separation_m, reason) VALUES (?,?,?,?,?,?)""",
            (by_sid[places[d["survivor"]]["source_id"]], None,
             d["duplicate_source_id"], d["duplicate_kind"], d["separation_m"],
             d["reason"]))

    # ---- coverage notes ----------------------------------------------------
    n_geo = len(geo_rows)
    n_matched = sum(1 for g in geo_rows if g["_matched"])
    n_variant = sum(1 for g in geo_rows if g["_tier"] == "fuzzy")
    n_new = n_geo - n_matched - n_variant
    notes = [
        ("khuzestan", "osm_places_raw", len(places),
         "elements returned by Overpass that carry a name and coordinates"),
        ("khuzestan", "osm_places_deduped", n_geo,
         "after collapsing node/boundary twins"),
        ("khuzestan", "osm_places_matched_to_fda", n_matched,
         "name agreement + شهرستان agreement"),
        ("khuzestan", "osm_places_name_variants", n_variant,
         "similar name, same county — probably the same place, not confirmed"),
        ("khuzestan", "osm_places_not_in_fda", n_new,
         "candidate new locations"),
        ("khuzestan", "fda_places_not_on_map", len(unmatched_fda),
         "FDA rows with no OSM twin"),
        ("khuzestan", "fda_places_total", len(fda), "FDA places in خوزستان"),
        ("khuzestan", "bakhsh_with_county", sum(1 for r in admin_rows if r["county"]),
         "بakhsh polygons with a resolved شهرستان"),
        ("khuzestan", "bakhsh_total", len(admin_rows), "admin_level=6 relations"),
        ("khuzestan", "places_without_county",
         sum(1 for g in geo_rows if not g.get("county")),
         "left NULL rather than guessed"),
        ("khuzestan", "county_sources_disagree",
         sum(1 for g in geo_rows if g.get("_county_conflict")),
         "place's own Wikidata P131 vs its بakhsh polygon"),
        ("khuzestan", "places_outside_any_bakhsh",
         sum(1 for g in geo_rows if g.get("admin_method") == "nearest-bakhsh"),
         "assigned from the nearest polygon instead"),
    ]
    for scope, metric, value, detail in notes:
        c.execute("""INSERT OR REPLACE INTO geo_coverage_note
            (scope, metric, value, detail, computed_at) VALUES (?,?,?,?,?)""",
            (scope, metric, value, detail, now))
    c.commit()

    views_geo = os.path.join(HOME, "etl", "views_geo.sql")
    if os.path.exists(views_geo):
        c.executescript(open(views_geo, encoding="utf-8").read())
        c.commit()

    print(f"\ngeo_places: {n_geo:,} | matched to FDA: {n_matched:,} | "
          f"new candidates: {n_new:,}")
    print(f"FDA rows with no map twin: {len(unmatched_fda):,} of {len(fda):,}")
    print("by kind (matched / new):")
    for kind in ("city", "town", "village", "hamlet", "isolated_dwelling",
                 "neighbourhood"):
        m = sum(1 for g in geo_rows if g["place_kind"] == kind and g["_matched"])
        t = sum(1 for g in geo_rows if g["place_kind"] == kind)
        print(f"   {kind:18s} matched {m:5d} / total {t:5d}")
    conf = sum(1 for g in geo_rows if g.get("_county_conflict"))
    print(f"county: two independent methods disagree on {conf} place(s)")
    print(f"elapsed {time.time()-t0:,.0f}s")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
