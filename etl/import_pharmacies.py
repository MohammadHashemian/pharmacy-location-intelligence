"""Import pharmacy points from نشان (Neshan) Search into `map_pharmacy`.

Contract (platform.neshan.org/docs/api/search-category/search): GET
`/v3/search?q=<url-encoded json>` with the `Api-Key` header, where
`q = {"term": ..., "center": {"latitude", "longitude"}}`. Neshan returns **at most
30 results per request**, ordered by distance from `center`, and offers no paging
knob — so coverage is a *grid of centres*, one request each, deduped afterwards.

The key is read from the app's own settings table (entered at /settings), never
copied into a file or a shell history.

    python etl/import_pharmacies.py --dry-run --limit 5     # pilot, writes nothing
    python etl/import_pharmacies.py                         # the 87 cities
    python etl/import_pharmacies.py --min-pop 2000          # + larger villages

Writes `map_pharmacy` rows with `source='neshan'`. `build_map_layer.py` only
replaces `source='osm'`, so an import survives a rebuild, and /map reads the table
on the next request — no rebuild needed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT_GEO = os.path.join(HOME, "web", "public", "geo")
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
SEARCH = "https://api.neshan.org/v3/search"

# A result is kept only when it looks like a pharmacy. «داروخانه» also matches a
# street called Pharmacy Street, a clinic and a hospital, so a name hit is not
# enough on its own: the POI type has to be something other than a road/area.
PHARMACY_HINTS = ("داروخانه", "pharmacy", "drugstore")
NON_PHARMACY_TYPES = {
    "street", "road", "highway", "motorway", "residential", "square", "plaza",
    "neighbourhood", "neighborhood", "locality", "city", "town", "village",
    "hospital", "clinic", "polyclinic", "bus_station", "subway", "park",
    "address", "place_of_worship", "school", "university",
}


def looks_like_pharmacy(title: str, ptype: str, category: str) -> bool:
    hay = f"{title} {ptype} {category}".lower()
    if not any(h in hay for h in PHARMACY_HINTS):
        return False
    return ptype.strip().lower() not in NON_PHARMACY_TYPES


def haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def setting(c: sqlite3.Connection, key: str) -> str | None:
    try:
        row = c.execute("SELECT value FROM app_setting WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    except sqlite3.OperationalError:
        return None


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


def search(key: str, term: str, lat: float, lon: float) -> tuple[int, list[dict], str]:
    q = json.dumps(
        {"term": term, "center": {"latitude": lat, "longitude": lon}},
        ensure_ascii=False,
    )
    url = f"{SEARCH}?q={urllib.parse.quote(q)}"
    req = urllib.request.Request(url, headers={**UA, "Api-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode("utf-8"))
        return 200, body.get("items") or [], ""
    except urllib.error.HTTPError as e:
        return e.code, [], e.read().decode("utf-8", "ignore")[:200]
    except Exception as e:  # noqa: BLE001 — network failure
        return 0, [], str(e)[:200]


def point_id(lat: float, lon: float, poi_hash: str | None) -> int:
    raw = poi_hash or f"{lat:.5f},{lon:.5f}"
    return int(hashlib.sha1(raw.encode()).hexdigest()[:12], 16) % 2_000_000_000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--term", default="داروخانه")
    ap.add_argument("--min-pop", type=int, default=0,
                    help="also query at villages with at least this population")
    ap.add_argument("--cities-only", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="first N centres (pilot)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pause", type=float, default=0.35, help="seconds between requests")
    ap.add_argument("--keep-unmatched", action="store_true",
                    help="keep points >3 km from any settlement (still inside the province)")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    key = setting(c, "neshan_api_key")
    if not key:
        print("no neshan_api_key in app_setting — enter it at /settings first")
        return 2

    cities = c.execute("""
        SELECT a.name, a.county, p.lat, p.lon, COALESCE(a.population, 0)
        FROM v_admin_area_current a
        JOIN map_point p ON p.area_id = a.area_id
        WHERE a.kind = 'city'
        ORDER BY COALESCE(a.population, 0) DESC
    """).fetchall()
    centres = [(n, cty, la, lo, pop) for n, cty, la, lo, pop in cities]

    if not args.cities_only and args.min_pop:
        villages = c.execute("""
            SELECT a.name, a.county, p.lat, p.lon, COALESCE(a.population, 0)
            FROM v_admin_area_current a
            JOIN map_point p ON p.area_id = a.area_id
            WHERE a.kind = 'village' AND COALESCE(a.population, 0) >= ?
            ORDER BY COALESCE(a.population, 0) DESC
        """, (args.min_pop,)).fetchall()
        centres += [(n, cty, la, lo, pop) for n, cty, la, lo, pop in villages]

    if args.limit:
        centres = centres[: args.limit]

    settlements = c.execute("""
        SELECT p.area_id, p.lat, p.lon, a.county FROM map_point p
        JOIN v_admin_area_current a ON a.area_id = p.area_id
    """).fetchall()

    found: dict[str, dict] = {}
    codes: dict[int, int] = {}
    for i, (name, _county, lat, lon, _pop) in enumerate(centres, 1):
        code, items, err = search(key, args.term, lat, lon)
        codes[code] = codes.get(code, 0) + 1
        if code != 200:
            if code in (401, 403, 480, 485):
                print(f"\nstopped at {name}: HTTP {code} {err}")
                if code == 485:
                    print("  485 = this key is not scoped to the Search service.")
                    print("  In the Neshan panel create a key for «جستجو» and ask support to")
                    print("  activate the Search service (their docs require a ticket).")
                return 3
            if i <= 3:
                print(f"  {name}: HTTP {code} {err}")
            time.sleep(1.0)
            continue
        kept = 0
        for it in items:
            loc = it.get("location") or {}
            x, y = loc.get("x"), loc.get("y")
            if x is None or y is None:
                continue
            llat, llon = float(y), float(x)
            if not looks_like_pharmacy(
                str(it.get("title") or ""),
                str(it.get("type") or ""),
                str(it.get("category") or ""),
            ):
                continue
            if not inside_outline(llat, llon):
                continue
            pk = f"{llat:.5f},{llon:.5f}"
            if pk in found:
                continue
            found[pk] = {
                "name": (it.get("title") or "").strip() or "داروخانه",
                "lat": round(llat, 6),
                "lon": round(llon, 6),
                "address": it.get("address"),
                "hash": it.get("poiHash"),
            }
            kept += 1
        if i % 10 == 0:
            print(f"  [{i}/{len(centres)}] {name}: {len(items)} results, "
                  f"{kept} new (total {len(found)})")
        time.sleep(args.pause)

    print(f"\n{len(found)} unique pharmacies from {len(centres)} centres · "
          f"HTTP {dict(sorted(codes.items()))}")
    if not found:
        print("nothing to write")
        return 1
    if args.dry_run:
        for p in list(found.values())[:10]:
            print("  ", p["name"], "|", p["lat"], p["lon"], "|", (p["address"] or "")[:40])
        return 0

    rows, matched, dropped = [], 0, 0
    for p in found.values():
        best_id, best_d, best_county = None, 1e9, None
        for area_id, slat, slon, county in settlements:
            d = haversine_km(p["lat"], p["lon"], slat, slon)
            if d < best_d:
                best_id, best_d, best_county = area_id, d, county
        if best_d > 3.0 and not args.keep_unmatched:
            dropped += 1
            continue
        rows.append((
            "neshan", point_id(p["lat"], p["lon"], p["hash"]), p["name"], None,
            p["lat"], p["lon"], best_id, round(best_d, 2), best_county, p["address"],
        ))
        matched += best_d <= 3.0

    c.executemany("""
        INSERT OR REPLACE INTO map_pharmacy
          (osm_type, osm_id, name, name_en, lat, lon, nearest_area_id, nearest_km,
           county, street, source)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'neshan')
    """, rows)
    c.commit()
    print(f"wrote {len(rows)} rows (source='neshan'): {matched} within 3 km of a "
          f"settlement, {dropped} dropped as too far from any settlement")
    print("/map reads the table on the next request — no rebuild needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
