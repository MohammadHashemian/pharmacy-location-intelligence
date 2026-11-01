"""Import pharmacy points from نشان (Neshan) into `map_pharmacy`.

Two Neshan services can answer "what is near this point", and a key is bound to
whichever one it was created for, so this script probes both and uses the first
that the key can call:

  /v1/nearby   ?location=lat,lng&radius=<m>[&layer=...]   (مکان‌های نزدیک)
  /v3/search   ?q=<json {term, center:{latitude,longitude}}> (جستجو, ≤30 results)

Both return `items[]` with `title/address/category/type/location{x,y}/poiHash`.
The key is read from the app's own settings table (entered at /settings).

    python etl/import_pharmacies.py --check            # which service does the key have?
    python etl/import_pharmacies.py --dry-run --limit 5
    python etl/import_pharmacies.py                    # 87 cities
    python etl/import_pharmacies.py --min-pop 2000     # + larger villages
    python etl/import_pharmacies.py --fixture data/sample/neshan_nearby.json  # offline

Deduping (the reason this is not a 20-line loop):
  1. exact point      two results within 30 m are the same POI
  2. same name        «داروخانه دکتر بدری» and «دکتر بدری» within 150 m are one
  3. cross-source     a Neshan point within 60 m of an existing OSM pharmacy is
                      already on the map — it is counted, not duplicated
  4. irrelevant       a street/square/village called «داروخانه» is not a pharmacy

Rows land in `map_pharmacy` with `source='neshan'`; `build_map_layer.py` only
replaces `source='osm'`, so an import survives a rebuild and /map picks it up.
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

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT_GEO = os.path.join(HOME, "web", "public", "geo")
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}

NEARBY = "https://api.neshan.org/v1/nearby"
SEARCH = "https://api.neshan.org/v3/search"

# «داروخانه» also names streets, squares and clinics. A name hit alone is not
# enough: the POI type must not be a place/road class.
PHARMACY_HINTS = ("داروخانه", "pharmacy", "drugstore")
NON_PHARMACY_TYPES = {
    "street", "road", "highway", "motorway", "residential", "square", "plaza",
    "neighbourhood", "neighborhood", "locality", "city", "town", "village",
    "hospital", "clinic", "polyclinic", "bus_station", "subway", "park",
    "address", "place_of_worship", "school", "university",
}

# fallback coordinates if the provider ever returns a bare item without a city
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
    hay = f"{title} {ptype} {category}".lower()
    if not any(h in hay for h in PHARMACY_HINTS):
        return False
    return ptype.strip().lower() not in NON_PHARMACY_TYPES


def normalize_name(name: str) -> str:
    n = name.replace(ZWNJ, " ").replace("ي", "ی").replace("ك", "ک").lower()
    n = re.sub(r"[^\w\u0600-\u06FF]+", " ", n)
    n = re.sub(r"^(داروخانه|درمانگاه)\s+", "", n.strip())
    n = re.sub(r"^(دکتر|dr\.?|pharmacy)\s+", "", n)
    return re.sub(r"\s+", " ", n).strip()


def dedupe_points(points: list[dict], same_px_km: float = 0.03,
                  same_name_km: float = 0.15) -> tuple[list[dict], dict[str, int]]:
    """Collapse duplicates: identical points, and the same pharmacy named twice.

    Neshan returns one POI per branch, but the same branch can come back from two
    neighbouring search centres with a slightly different title; without this the
    map gets two diamonds on one shop.
    """
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
# provider calls
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
    if not looks_like_pharmacy(str(it.get("title") or ""), str(it.get("type") or ""),
                               str(it.get("category") or "")):
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


# --------------------------------------------------------------------------- #
def detect_service(key: str, lat: float, lon: float) -> str | None:
    code, items = call_nearby(key, lat, lon, 800)
    if code == 200:
        return "nearby"
    code2, items2 = call_search(key, "داروخانه", lat, lon)
    if code2 == 200:
        return "search"
    last = code2 if code2 != 200 else code
    if last == 485:
        print("HTTP 485 = this key is not scoped to a search service.")
        print("  In the Neshan panel (platform.neshan.org) create a key for")
        print("  «مکان‌های نزدیک / Nearby» or «جستجو / Search» — activating them needs a")
        print("  support ticket. The reverse-geocoding service alone cannot list POIs.")
    else:
        print(f"no usable Neshan search service (nearby={code}, search={code2})")
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--term", default="داروخانه")
    ap.add_argument("--radius", type=int, default=1500, help="nearby radius, metres")
    ap.add_argument("--service", choices=["nearby", "search"], default=None)
    ap.add_argument("--min-pop", type=int, default=0,
                    help="also query at villages with at least this population")
    ap.add_argument("--cities-only", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="first N centres (pilot)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true", help="only report which service the key has")
    ap.add_argument("--fixture", default=None,
                    help="offline: a saved Neshan response (or list of items) instead of the API")
    ap.add_argument("--pause", type=float, default=0.35)
    ap.add_argument("--keep-unmatched", action="store_true")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    key = None if args.fixture else (c.execute(
        "SELECT value FROM app_setting WHERE key='neshan_api_key'").fetchone() or [None])[0]
    if not args.fixture and not key:
        print("no neshan_api_key in app_setting — enter it at /settings first")
        return 2

    cities = c.execute("""
        SELECT a.name, p.lat, p.lon, COALESCE(a.population, 0)
        FROM v_admin_area_current a
        JOIN map_point p ON p.area_id = a.area_id
        WHERE a.kind = 'city'
        ORDER BY COALESCE(a.population, 0) DESC
    """).fetchall()
    centres = [(n, la, lo) for n, la, lo, _pop in cities]

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

    if args.check:
        if not centres:
            print("no centres")
            return 1
        name, la, lo = centres[0]
        service = detect_service(key, la, lo)
        print(f"service: {service or 'none'}")
        return 0 if service else 3

    raw_points: list[dict] = []
    if args.fixture:
        payload = json.load(open(args.fixture, encoding="utf-8"))
        items = payload.get("items") if isinstance(payload, dict) else payload
        for it in items or []:
            p = item_to_point(it)
            if p:
                raw_points.append(p)
        print(f"fixture: {len(items or [])} items -> {len(raw_points)} pharmacy points")
    else:
        service = args.service or detect_service(key, centres[0][1], centres[0][2])
        if not service:
            return 3
        print(f"service: {service} · {len(centres)} centres")
        codes: dict[int, int] = {}
        for i, (name, la, lo) in enumerate(centres, 1):
            if service == "nearby":
                code, items = call_nearby(key, la, lo, args.radius)
            else:
                code, items = call_search(key, args.term, la, lo)
            codes[code] = codes.get(code, 0) + 1
            if code != 200:
                if code in (401, 403, 480, 485):
                    print(f"stopped at {name}: HTTP {code}")
                    return 3
                time.sleep(1.0)
                continue
            for it in items:
                p = item_to_point(it)
                if p:
                    raw_points.append(p)
            if i % 10 == 0:
                print(f"  [{i}/{len(centres)}] {name}: {len(items)} results "
                      f"(points so far {len(raw_points)})")
            time.sleep(args.pause)
        print(f"HTTP {dict(sorted(codes.items()))}")

    points, dup_stats = dedupe_points(raw_points)
    print(f"{len(points)} unique pharmacies from {len(raw_points)} results "
          f"(dropped {dup_stats['exact']} same-point, {dup_stats['same_name']} same-name)")

    settlements = c.execute("""
        SELECT p.area_id, p.lat, p.lon, a.county FROM map_point p
        JOIN v_admin_area_current a ON a.area_id = p.area_id
    """).fetchall()
    osm = c.execute("SELECT lat, lon FROM map_pharmacy WHERE source='osm'").fetchall()

    rows, matched, dropped, dupes = [], 0, 0, 0
    for p in points:
        best_id, best_d, best_county = None, 1e9, None
        for area_id, slat, slon, county in settlements:
            d = haversine_km(p["lat"], p["lon"], slat, slon)
            if d < best_d:
                best_id, best_d, best_county = area_id, d, county
        near_osm = any(haversine_km(p["lat"], p["lon"], la, lo) <= 0.06 for la, lo in osm)
        if near_osm:
            dupes += 1
            continue
        if best_d > 3.0 and not args.keep_unmatched:
            dropped += 1
            continue
        rows.append((
            "neshan", point_id(p["lat"], p["lon"], p["hash"]), p["name"], None,
            p["lat"], p["lon"], best_id, round(best_d, 2), best_county,
            p.get("address"),
        ))
        matched += best_d <= 3.0

    print(f"to write: {len(rows)} · already in OSM within 60 m: {dupes} · "
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
           county, street, source)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'neshan')
    """, rows)
    c.commit()
    print(f"wrote {len(rows)} rows (source='neshan') — /map reads them on the next request")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
