"""Import pharmacy points into `map_pharmacy` from a POI provider.

Two providers, one pipeline (filter → clip → dedupe → match → write):

  --provider neshan   /v1/nearby or /v3/search, service key (`service.…`), Iran-legal.
                      Returns ≤30 per request, no paging.
  --provider google   Places API (New) places:searchText, key from Google Cloud.
                      Max 20 per page, up to 3 pages (60) per centre.
                      NOTE: Iran is a *Prohibited Territory* in Google's ToS
                      (cloud.google.com/maps-platform/terms/maps-prohibited-territories),
                      and billing needs a card Google will accept — see README before
                      spending money on it.

Keys are read from the app's own settings table (entered at /settings), so they are
never copied into a file or a shell history.

    python etl/import_pharmacies.py --provider google --check
    python etl/import_pharmacies.py --provider google --dry-run --limit 5
    python etl/import_pharmacies.py --provider google              # 87 cities
    python etl/import_pharmacies.py --provider google --min-pop 2000
    python etl/import_pharmacies.py --provider google --fixture data/sample/google.json

Deduping (why this is longer than a loop over the API):
  1. exact point      two results within 30 m are the same POI
  2. same name        «داروخانه دکتر بدری» and «دکتر بدری» within 150 m are one
  3. cross-source     a point within 60 m of a pharmacy already on the map (OSM, or a
                      previous provider) is counted, not duplicated
  4. irrelevant       a street/square/village called «داروخانه» is not a pharmacy;
                      Google's CLOSED_PERMANENTLY is skipped too
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

from classify_poi import as_pharmacy

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT_GEO = os.path.join(HOME, "web", "public", "geo")
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}

NEARBY = "https://api.neshan.org/v1/nearby"
SEARCH = "https://api.neshan.org/v3/search"
GOOGLE_TEXT = "https://places.googleapis.com/v1/places:searchText"
GOOGLE_MASK = (
    "places.id,places.displayName,places.formattedAddress,places.location,"
    "places.types,places.businessStatus,nextPageToken"
)

# Google's Pro SKU: 5,000 free events a month, then $32 per 1,000 (2026 list price).
GOOGLE_FREE_MONTH = 5_000
GOOGLE_USD_PER_CALL = 0.032

# «داروخانه» also names streets, squares and clinics. A name hit alone is not
# enough: the POI type must not be a place/road class.
PHARMACY_HINTS = ("داروخانه", "pharmacy", "drugstore")
NON_PHARMACY_TYPES = {
    "street", "road", "highway", "motorway", "residential", "square", "plaza",
    "neighbourhood", "neighborhood", "locality", "city", "town", "village",
    "hospital", "clinic", "polyclinic", "bus_station", "subway", "park",
    "address", "place_of_worship", "school", "university", "route", "street_address",
    # Google tags a few of these «pharmacy» too; none of them dispenses to patients
    "veterinary_care", "insurance_agency", "doctor", "dentist", "bank", "finance",
}
# Businesses sitting next to a pharmacy and mistyped as one (seen in Abadan:
# «بیمه سینا نمایندگی برزگر», «عمده فروشی»). The name, not the type, gives them away.
NAME_BLOCK = ("بیمه", "نمایندگی", "عمده", "پخش", "انبار", "توزیع", "wholesale")

ZWNJ = "\u200c"


# --------------------------------------------------------------------------- #
# pure helpers (verified by etl/verify_import.py)
# --------------------------------------------------------------------------- #
def haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def looks_like_pharmacy(title: str, ptype: str, category: str) -> bool:
    """True only for something that dispenses medicine to patients.

    ptype may be one word (Neshan) or a comma-joined list (Google), so the type
    check is on tokens, not on the whole string.
    """
    tokens = {t for t in re.split(r"[\s,]+", f"{ptype} {category}".lower()) if t}
    if tokens & NON_PHARMACY_TYPES:
        return False
    if any(m in title for m in NAME_BLOCK):
        return False
    hay = f"{title} {ptype} {category}".lower()
    return any(h in hay for h in PHARMACY_HINTS)


def normalize_name(name: str) -> str:
    n = name.replace(ZWNJ, " ").replace("ي", "ی").replace("ك", "ک").lower()
    n = re.sub(r"[^\w\u0600-\u06FF]+", " ", n)
    n = re.sub(r"^(داروخانه|درمانگاه)\s+", "", n.strip())
    n = re.sub(r"^(دکتر|dr\.?|pharmacy)\s+", "", n)
    return re.sub(r"\s+", " ", n).strip()


def dedupe_points(points: list[dict], same_px_km: float = 0.03,
                  same_name_km: float = 0.15) -> tuple[list[dict], dict[str, int]]:
    """Collapse duplicates: identical points, and the same pharmacy named twice."""
    kept: list[dict] = []
    stats = {"exact": 0, "same_name": 0}
    for p in sorted(points, key=lambda x: (x["name"], x["lat"], x["lon"])):
        dup = False
        for q in kept:
            d = haversine_km(p["lat"], p["lon"], q["lat"], q["lon"])
            if d <= same_px_km:
                stats["exact"] += 1
                dup = True
                break
            if d <= same_name_km and normalize_name(p["name"]) == normalize_name(q["name"]):
                stats["same_name"] += 1
                dup = True
                break
        if not dup:
            kept.append(p)
    return kept, stats


def point_id(lat: float, lon: float, poi_hash: str | None) -> int:
    raw = poi_hash or f"{lat:.5f},{lon:.5f}"
    return int(hashlib.sha1(raw.encode()).hexdigest()[:12], 16) % 2_000_000_000


_OUTLINE: list[list[tuple[float, float]]] | None = None


def inside_outline(lat: float, lon: float) -> bool:
    global _OUTLINE
    if _OUTLINE is None:
        path = os.path.join(OUT_GEO, "khuzestan_outline.geojson")
        if not os.path.exists(path):
            _OUTLINE = []
        else:
            fc = json.load(open(path, encoding="utf-8"))
            _OUTLINE = [
                ring
                for poly in fc["features"][0]["geometry"]["coordinates"]
                for ring in poly
            ]
    hit = False
    for ring in _OUTLINE:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
    return hit


# --------------------------------------------------------------------------- #
# نشان (Neshan)
# --------------------------------------------------------------------------- #
def _get(url: str, key: str) -> tuple[int, dict | str]:
    req = urllib.request.Request(url, headers={**UA, "Api-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")[:300]
    except Exception as e:  # noqa: BLE001
        return 0, str(e)[:200]


def call_nearby(key: str, lat: float, lon: float, radius: int) -> tuple[int, list[dict]]:
    q = urllib.parse.urlencode({"location": f"{lat},{lon}", "radius": radius})
    code, body = _get(f"{NEARBY}?{q}", key)
    return code, (body.get("items") or []) if isinstance(body, dict) else []


def call_search(key: str, term: str, lat: float, lon: float) -> tuple[int, list[dict]]:
    q = urllib.parse.quote(json.dumps(
        {"term": term, "center": {"latitude": lat, "longitude": lon}}, ensure_ascii=False))
    code, body = _get(f"{SEARCH}?q={q}", key)
    return code, (body.get("items") or []) if isinstance(body, dict) else []


def item_to_point(it: dict) -> dict | None:
    loc = it.get("location") or {}
    x, y = loc.get("x"), loc.get("y")
    if x is None or y is None:
        return None
    lat, lon = float(y), float(x)
    if not as_pharmacy(str(it.get("title") or ""),
                       [str(it.get("type") or ""), str(it.get("category") or "")]):
        return None
    if not inside_outline(lat, lon):
        return None
    return {
        "name": (it.get("title") or "").strip() or "داروخانه",
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "address": it.get("address"),
        "hash": it.get("poiHash"),
        "type": it.get("type"),
    }


def detect_neshan(key: str, lat: float, lon: float) -> str | None:
    code, _ = call_nearby(key, lat, lon, 800)
    if code == 200:
        return "nearby"
    code2, _ = call_search(key, "داروخانه", lat, lon)
    if code2 == 200:
        return "search"
    last = code2 if code2 != 200 else code
    if key.startswith("web.") or last == 483:
        print("This is a WEB (map SDK) key — prefix «web.». REST APIs answer 483")
        print("  «API Key type not suitable for this service» to it.")
        print("  Create a key of type «سرویس» (service.…) with the service")
        print("  «مکان‌های نزدیک / Nearby» or «جستجو / Search».")
    elif last == 485:
        print("HTTP 485 = this key is a service key, but not for a search service.")
        print("  Create the key with «مکان‌های نزدیک» or «جستجو» selected — Neshan")
        print("  activates those through a support ticket.")
    else:
        print(f"no usable Neshan search service (nearby={code}, search={code2})")
    return None


# --------------------------------------------------------------------------- #
# Google Places (New)
# --------------------------------------------------------------------------- #
def call_google(key: str, term: str, lat: float, lon: float, radius_m: int,
                page_token: str | None = None) -> tuple[int, list[dict], str | None, str]:
    body: dict = {
        "textQuery": term,
        "languageCode": "fa",
        "regionCode": "IR",
        "includedType": "pharmacy",
        "maxResultCount": 20,
        "locationBias": {
            "circle": {"center": {"latitude": lat, "longitude": lon}, "radius": radius_m}
        },
    }
    if page_token:
        body["pageToken"] = page_token
    req = urllib.request.Request(
        GOOGLE_TEXT,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            **UA,
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": GOOGLE_MASK,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read().decode("utf-8"))
        return 200, payload.get("places") or [], payload.get("nextPageToken"), ""
    except urllib.error.HTTPError as e:
        return e.code, [], None, e.read().decode("utf-8", "ignore")[:300]
    except Exception as e:  # noqa: BLE001
        return 0, [], None, str(e)[:200]


def google_item_to_point(pl: dict) -> dict | None:
    loc = pl.get("location") or {}
    lat, lon = loc.get("latitude"), loc.get("longitude")
    if lat is None or lon is None:
        return None
    if pl.get("businessStatus") == "CLOSED_PERMANENTLY":
        return None
    name = ((pl.get("displayName") or {}).get("text") or "").strip()
    # The shared classifier: negatives first (a cosmetics shop named «آرایشی» must
    # not pass on a pharmacy type), then the name, then the types.
    if not as_pharmacy(name, [str(t) for t in (pl.get("types") or [])]):
        return None
    if not inside_outline(float(lat), float(lon)):
        return None
    return {
        "name": name or "داروخانه",
        "lat": round(float(lat), 6),
        "lon": round(float(lon), 6),
        "address": pl.get("formattedAddress"),
        "hash": pl.get("id"),
        "type": "pharmacy",
    }


def detect_google(key: str, lat: float, lon: float) -> bool:
    code, places, _, detail = call_google(key, "داروخانه", lat, lon, 15000)
    if code == 200:
        print(f"google: OK · {len(places)} places in the first page")
        return True
    if code == 403:
        low = detail.lower()
        if "billing" in low or "not enabled" in low or "service_disabled" in low:
            print("google: HTTP 403 — Places API (New) is not enabled for this project,")
            print("  or the project has no billing account. Google requires a card even")
            print("  for the free 5,000 calls a month.")
        elif "referer" in low or "api_key" in low or "invalid" in low:
            print("google: HTTP 403 — key rejected. Restrict it to «Places API (New)»")
            print("  and allow server requests (no HTTP-referer restriction).")
        else:
            print(f"google: HTTP 403 — {detail[:200]}")
    else:
        print(f"google: HTTP {code} — {detail[:200]}")
    return False


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=["neshan", "google"], default="neshan")
    ap.add_argument("--term", default="داروخانه")
    ap.add_argument("--radius", type=int, default=1500, help="neshan nearby radius, m")
    ap.add_argument("--radius-km", type=float, default=20.0, help="google text-search bias")
    ap.add_argument("--pages", type=int, default=3, help="google: pages of 20 per centre")
    ap.add_argument("--service", choices=["nearby", "search"], default=None)
    ap.add_argument("--min-pop", type=int, default=0,
                    help="also query at villages with at least this population")
    ap.add_argument("--cities-only", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="first N centres (pilot)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true", help="only test the key")
    ap.add_argument("--fixture", default=None,
                    help="offline: a saved provider response instead of the API")
    ap.add_argument("--pause", type=float, default=0.35)
    ap.add_argument("--page-pause", type=float, default=2.0, help="google pageToken wait")
    ap.add_argument("--keep-unmatched", action="store_true")
    ap.add_argument("--refresh", action="store_true",
                    help="ignore the per-centre cache and call the provider again")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    setting_key = "google_places_key" if args.provider == "google" else "neshan_api_key"
    key = None if args.fixture else (
        c.execute("SELECT value FROM app_setting WHERE key=?", (setting_key,)).fetchone()
        or [None])[0]
    if not args.fixture and not key:
        print(f"no {setting_key} in app_setting — enter it at /settings first")
        return 2

    cities = c.execute("""
        SELECT a.name, p.lat, p.lon
        FROM v_admin_area_current a
        JOIN map_point p ON p.area_id = a.area_id
        WHERE a.kind = 'city'
        ORDER BY COALESCE(a.population, 0) DESC
    """).fetchall()
    centres = [(n, la, lo) for n, la, lo in cities]

    if not args.cities_only and args.min_pop:
        villages = c.execute("""
            SELECT a.name, p.lat, p.lon
            FROM v_admin_area_current a
            JOIN map_point p ON p.area_id = a.area_id
            WHERE a.kind = 'village' AND COALESCE(a.population, 0) >= ?
            ORDER BY COALESCE(a.population, 0) DESC
        """, (args.min_pop,)).fetchall()
        centres += [(n, la, lo) for n, la, lo in villages]

    if args.limit:
        centres = centres[: args.limit]
    if not centres:
        print("no centres")
        return 1

    if args.check:
        if args.provider == "google":
            return 0 if detect_google(key, centres[0][1], centres[0][2]) else 3
        print(f"service: {detect_neshan(key, centres[0][1], centres[0][2]) or 'none'}")
        return 0

    raw_points: list[dict] = []
    calls = 0
    # Every answered centre is cached, so a run that dies at city 60 resumes at 60
    # instead of paying for 1…59 again (Google bills per event).
    cache_path = os.path.join(HOME, "data", "derived", f"{args.provider}_poi_cache.json")
    cache: dict[str, list[dict]] = {}
    if not args.refresh and os.path.exists(cache_path):
        try:
            cache = json.load(open(cache_path, encoding="utf-8"))
        except json.JSONDecodeError:
            cache = {}
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    def remember(name: str, pts: list[dict]) -> None:
        cache[name] = pts
        json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)

    if args.fixture:
        payload = json.load(open(args.fixture, encoding="utf-8"))
        if args.provider == "google":
            items = payload.get("places") if isinstance(payload, dict) else payload
            for pl in items or []:
                p = google_item_to_point(pl)
                if p:
                    raw_points.append(p)
        else:
            items = payload.get("items") if isinstance(payload, dict) else payload
            for it in items or []:
                p = item_to_point(it)
                if p:
                    raw_points.append(p)
        print(f"fixture: {len(items or [])} items -> {len(raw_points)} pharmacy points")

    elif args.provider == "google":
        print(f"google: {len(centres)} centres · up to {args.pages} pages of 20 each")
        codes: dict[int, int] = {}
        for i, (name, la, lo) in enumerate(centres, 1):
            if name in cache:
                raw_points.extend(cache[name])
                continue
            token, page = None, 0
            here: list[dict] = []
            while page < args.pages:
                code, places, token, detail = call_google(
                    key, args.term, la, lo, int(args.radius_km * 1000), token)
                codes[code] = codes.get(code, 0) + 1
                calls += 1
                if code != 200:
                    if code in (401, 403):
                        print(f"stopped at {name}: HTTP {code} {detail[:160]}")
                        detect_google(key, la, lo)
                        return 3
                    time.sleep(1.0)
                    break
                for pl in places:
                    p = google_item_to_point(pl)
                    if p:
                        here.append(p)
                page += 1
                if not token:
                    break
                time.sleep(args.page_pause)
            raw_points.extend(here)
            remember(name, here)
            if i % 10 == 0:
                print(f"  [{i}/{len(centres)}] {name}: points so far {len(raw_points)}")
            time.sleep(args.pause)
        print(f"HTTP {dict(sorted(codes.items()))}")

    else:
        service = args.service or detect_neshan(key, centres[0][1], centres[0][2])
        if not service:
            return 3
        print(f"service: {service} · {len(centres)} centres")
        codes = {}
        for i, (name, la, lo) in enumerate(centres, 1):
            if name in cache:
                raw_points.extend(cache[name])
                continue
            if service == "nearby":
                code, items = call_nearby(key, la, lo, args.radius)
            else:
                code, items = call_search(key, args.term, la, lo)
            codes[code] = codes.get(code, 0) + 1
            calls += 1
            if code != 200:
                if code in (401, 403, 480, 483, 485):
                    print(f"stopped at {name}: HTTP {code}")
                    return 3
                time.sleep(1.0)
                continue
            here = []
            for it in items:
                p = item_to_point(it)
                if p:
                    here.append(p)
            raw_points.extend(here)
            remember(name, here)
            if i % 10 == 0:
                print(f"  [{i}/{len(centres)}] {name}: {len(items)} results "
                      f"(points so far {len(raw_points)})")
            time.sleep(args.pause)
        print(f"HTTP {dict(sorted(codes.items()))}")

    reused = sum(1 for n, _la, _lo in centres if n in cache)
    if reused:
        print(f"cache: {reused}/{len(centres)} centres reused from {os.path.basename(cache_path)}")

    points, dup_stats = dedupe_points(raw_points)
    print(f"{len(points)} unique pharmacies from {len(raw_points)} results "
          f"(dropped {dup_stats['exact']} same-point, {dup_stats['same_name']} same-name)")

    if args.provider == "google" and calls:
        free_left = max(0, GOOGLE_FREE_MONTH - calls)
        print(f"calls: {calls} · free tier {GOOGLE_FREE_MONTH}/month → "
              f"${max(0, calls - GOOGLE_FREE_MONTH) * GOOGLE_USD_PER_CALL:.2f} "
              f"({free_left} free calls left this month)")

    settlements = c.execute("""
        SELECT p.area_id, p.lat, p.lon, a.county FROM map_point p
        JOIN v_admin_area_current a ON a.area_id = p.area_id
    """).fetchall()
    existing = c.execute(
        "SELECT lat, lon FROM map_pharmacy WHERE source != ?", (args.provider,)).fetchall()

    rows, matched, dropped, dupes = [], 0, 0, 0
    for p in points:
        best_id, best_d, best_county = None, 1e9, None
        for area_id, slat, slon, county in settlements:
            d = haversine_km(p["lat"], p["lon"], slat, slon)
            if d < best_d:
                best_id, best_d, best_county = area_id, d, county
        if any(haversine_km(p["lat"], p["lon"], la, lo) <= 0.06 for la, lo in existing):
            dupes += 1
            continue
        if best_d > 3.0 and not args.keep_unmatched:
            dropped += 1
            continue
        rows.append((
            "poi", point_id(p["lat"], p["lon"], p["hash"]), p["name"], None,
            p["lat"], p["lon"], best_id, round(best_d, 2), best_county,
            p.get("address"), args.provider, p.get("hash"),
        ))
        matched += best_d <= 3.0

    print(f"to write: {len(rows)} · already on the map within 60 m: {dupes} · "
          f"too far from any settlement: {dropped} · within 3 km: {matched}")
    if args.dry_run or args.fixture:
        for r in rows[:10]:
            print("  ", r[2], "|", r[4], r[5], "|", (r[9] or "")[:40])
        return 0
    if not rows:
        print("nothing to write")
        return 1

    c.executemany("""
        INSERT OR REPLACE INTO map_pharmacy
          (osm_type, osm_id, name, name_en, lat, lon, nearest_area_id, nearest_km,
           county, street, source, external_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    """, rows)
    c.commit()
    print(f"wrote {len(rows)} rows (source='{args.provider}') — /map reads them on the "
          f"next request")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
