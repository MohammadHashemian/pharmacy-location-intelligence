"""Import clinics, doctors, dentists, hospitals and labs into `map_medical`.

The pharmacy map answers "where is the competition". This one answers "where do
the prescriptions get written", which is what makes a corner valuable: a clinic
next door with no pharmacy around is worth more than a street of pharmacies.

    python etl/import_medical_services.py --check
    python etl/import_medical_services.py --dry-run --limit 5
    python etl/import_medical_services.py
    python etl/import_medical_services.py --types doctor,medical_clinic

One Google Text Search per (city, type), cached per pair in
`data/derived/google_medical_cache.json` — 87 cities x 4 types is ~350 calls, all
inside the free tier. Iran is a Prohibited Territory in Google's ToS; see README.
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
CACHE = os.path.join(HOME, "data", "derived", "google_medical_cache.json")
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
SEARCH = "https://places.googleapis.com/v1/places:searchText"
MASK = ("places.id,places.displayName,places.formattedAddress,places.location,"
        "places.types,places.businessStatus,nextPageToken")

# Google type -> the label the map legend uses
TYPES = {
    "doctor": "doctor",
    "medical_clinic": "clinic",
    "dentist": "dentist",
    "hospital": "hospital",
    "medical_lab": "lab",
}
KIND_ORDER = ["hospital", "clinic", "doctor", "dentist", "lab"]


def haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


_OUTLINE: list[list[tuple[float, float]]] | None = None


def inside_outline(lat: float, lon: float) -> bool:
    global _OUTLINE
    if _OUTLINE is None:
        path = os.path.join(OUT_GEO, "khuzestan_outline.geojson")
        if not os.path.exists(path):
            _OUTLINE = []
        else:
            fc = json.load(open(path, encoding="utf-8"))
            _OUTLINE = [ring for poly in fc["features"][0]["geometry"]["coordinates"]
                        for ring in poly]
    hit = False
    for ring in _OUTLINE:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
    return hit


def search(key: str, term: str, gtype: str, lat: float, lon: float, radius_m: int,
           page_token: str | None = None) -> tuple[int, list[dict], str | None, str]:
    body: dict = {
        "textQuery": term,
        "languageCode": "fa",
        "regionCode": "IR",
        "includedType": gtype,
        "maxResultCount": 20,
        "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon},
                                    "radius": radius_m}},
    }
    if page_token:
        body["pageToken"] = page_token
    req = urllib.request.Request(
        SEARCH, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={**UA, "X-Goog-Api-Key": key, "X-Goog-FieldMask": MASK,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            p = json.loads(r.read().decode("utf-8"))
        return 200, p.get("places") or [], p.get("nextPageToken"), ""
    except urllib.error.HTTPError as e:
        return e.code, [], None, e.read().decode("utf-8", "ignore")[:200]
    except Exception as e:  # noqa: BLE001
        return 0, [], None, str(e)[:200]


def to_point(pl: dict, wanted: str) -> dict | None:
    loc = pl.get("location") or {}
    lat, lon = loc.get("latitude"), loc.get("longitude")
    if lat is None or lon is None:
        return None
    if pl.get("businessStatus") == "CLOSED_PERMANENTLY":
        return None
    types = [t.lower() for t in (pl.get("types") or [])]
    if wanted not in types:
        return None
    if "pharmacy" in types:            # a pharmacy with a consultation desk is not a clinic
        return None
    if not inside_outline(float(lat), float(lon)):
        return None
    # Google returns a dentist inside the doctor search and a hospital inside the
    # clinic search, so the kind comes from the place's own types, ordered by how
    # much traffic each brings to a pharmacy next door.
    kind = "doctor"
    for g, label in (("hospital", "hospital"), ("medical_clinic", "clinic"),
                     ("dentist", "dentist"), ("medical_lab", "lab")):
        if g in types:
            kind = label
            break
    return {
        "kind": kind,
        "name": ((pl.get("displayName") or {}).get("text") or "").strip() or kind,
        "lat": round(float(lat), 6),
        "lon": round(float(lon), 6),
        "address": pl.get("formattedAddress"),
        "hash": pl.get("id"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", default="doctor,medical_clinic,dentist,hospital")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--radius-km", type=float, default=18.0)
    ap.add_argument("--pages", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--pause", type=float, default=0.15)
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT value FROM app_setting WHERE key='google_places_key'").fetchone()
    key = row[0] if row else None
    if not key:
        print("no google_places_key in app_setting — enter it at /settings first")
        return 2

    cities = c.execute("""
        SELECT a.name, p.lat, p.lon FROM v_admin_area_current a
        JOIN map_point p ON p.area_id = a.area_id
        WHERE a.kind = 'city' ORDER BY COALESCE(a.population, 0) DESC
    """).fetchall()
    centres = [(r["name"], r["lat"], r["lon"]) for r in cities]
    if args.limit:
        centres = centres[: args.limit]
    wanted = [t.strip() for t in args.types.split(",") if t.strip()]

    if args.check:
        code, places, _, detail = search(key, "کلینیک", "medical_clinic",
                                         centres[0][1], centres[0][2], 15000)
        print(f"google medical search: HTTP {code} · {len(places)} places")
        if code != 200:
            print(detail[:200])
        return 0 if code == 200 else 3

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    cache: dict[str, list] = {}
    if not args.refresh and os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE, encoding="utf-8"))
        except json.JSONDecodeError:
            cache = {}

    def remember(k: str, pts: list) -> None:
        cache[k] = pts
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)

    found: dict[str, dict] = {}
    calls = 0
    for i, (city, la, lo) in enumerate(centres, 1):
        for gtype in wanted:
            ck = f"{city}|{gtype}"
            if ck in cache:
                pts = cache[ck]
            else:
                pts = []
                token, page = None, 0
                while page < args.pages:
                    code, places, token, detail = search(
                        key, "پزشک" if gtype == "doctor" else "درمانگاه", gtype,
                        la, lo, int(args.radius_km * 1000), token)
                    calls += 1
                    if code != 200:
                        if code in (401, 403):
                            print(f"stopped at {city}: HTTP {code} {detail[:120]}")
                            return 3
                        break
                    for pl in places:
                        p = to_point(pl, gtype)
                        if p:
                            pts.append(p)
                    page += 1
                    if not token:
                        break
                    time.sleep(1.2)
                remember(ck, pts)
                time.sleep(args.pause)
            for p in pts:
                found.setdefault(f"{p['lat']:.5f},{p['lon']:.5f}", p)
        if i % 10 == 0:
            print(f"  [{i}/{len(centres)}] {city}: {len(found)} places so far · "
                  f"{calls} calls")

    print(f"{len(found)} medical places from {len(centres)} cities · {calls} calls")
    if not found:
        print("nothing to write")
        return 1

    settlements = c.execute("""
        SELECT p.area_id, p.lat, p.lon, a.county FROM map_point p
        JOIN v_admin_area_current a ON a.area_id = p.area_id
    """).fetchall()
    rows = []
    for p in found.values():
        best_id, best_d, best_county = None, 1e9, None
        for area_id, slat, slon, county in settlements:
            d = haversine_km(p["lat"], p["lon"], slat, slon)
            if d < best_d:
                best_id, best_d, best_county = area_id, d, county
        rows.append((p["kind"], p["name"], p["lat"], p["lon"], best_id,
                     round(best_d, 2), best_county, p["address"], "google",
                     p["hash"] or hashlib.sha1(f"{p['lat']},{p['lon']}".encode()).hexdigest()[:20]))

    if args.dry_run:
        for r in rows[:8]:
            print("  ", r[0], r[1][:38], r[2], r[3])
        print(f"(dry run, {len(rows)} rows not written)")
        return 0

    c.executemany("""
        INSERT OR REPLACE INTO map_medical
          (kind, name, lat, lon, nearest_area_id, nearest_km, county, address, source, external_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    """, rows)
    c.commit()
    by_kind = c.execute("SELECT kind, count(*) FROM map_medical GROUP BY 1 ORDER BY 2 DESC").fetchall()
    print("wrote", len(rows), "rows:", ", ".join(f"{k}={n}" for k, n in by_kind))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
