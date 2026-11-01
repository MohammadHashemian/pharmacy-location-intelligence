"""Fetch the public Google Places profile of every mapped pharmacy.

A dot answers "where"; a competitor analysis needs "what": rating, review count,
website, phone, opening hours, price level and the photo references. Those live
behind Place Details, one billable event per place, so every answer is cached in
`data/derived/google_details_cache.json` and a re-run costs nothing.

    python etl/enrich_pharmacy_profiles.py            # only places with no profile
    python etl/enrich_pharmacy_profiles.py --refresh  # re-fetch everything
    python etl/enrich_pharmacy_profiles.py --limit 5

SKUs touched: Place Details Pro ($17/1k after 5,000 free) and Place Details Photos
($7/1k after 1,000 free). One Khuzestan pass is ~300 calls → $0 inside the cap.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
CACHE = os.path.join(HOME, "data", "derived", "google_details_cache.json")
UA = {"User-Agent": "pharmacy-location-intelligence/1.0 (research; site selection)"}
DETAILS = "https://places.googleapis.com/v1/places/"
# Pro-tier fields plus photo references; everything the competitor panel shows.
MASK = (
    "id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,rating,"
    "userRatingCount,regularOpeningHours,photos,editorialSummary,googleMapsUri,"
    "businessStatus,priceLevel"
)


def key_for(c: sqlite3.Connection) -> str | None:
    row = c.execute("SELECT value FROM app_setting WHERE key='google_places_key'").fetchone()
    return row[0] if row else None


def fetch(key: str, place_id: str) -> tuple[int, dict | str]:
    url = f"{DETAILS}{urllib.parse.quote(place_id)}?languageCode=fa"
    req = urllib.request.Request(url, headers={**UA, "X-Goog-Api-Key": key,
                                              "X-Goog-FieldMask": MASK})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return 200, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")[:300]
    except Exception as e:  # noqa: BLE001
        return 0, str(e)[:200]


def flatten(p: dict) -> dict:
    """Only what the UI and the DB need — the raw payload is 8 KB of geometry."""
    photos = [
        {"name": ph.get("name"), "w": ph.get("widthPx"), "h": ph.get("heightPx")}
        for ph in (p.get("photos") or [])[:5]
        if ph.get("name")
    ]
    hours = (p.get("regularOpeningHours") or {}).get("weekdayDescriptions") or []
    return {
        "name": (p.get("displayName") or {}).get("text"),
        "address": p.get("formattedAddress"),
        "phone": p.get("nationalPhoneNumber"),
        "website": p.get("websiteUri"),
        "rating": p.get("rating"),
        "reviews": p.get("userRatingCount"),
        "price_level": p.get("priceLevel"),
        "hours": hours,
        "photos": photos,
        "summary": (p.get("editorialSummary") or {}).get("text"),
        "maps_uri": p.get("googleMapsUri"),
        "status": p.get("businessStatus"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--pause", type=float, default=0.12)
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    key = key_for(c)
    if not key:
        print("no google_places_key in app_setting — enter it at /settings first")
        return 2

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    cache: dict[str, dict] = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE, encoding="utf-8"))
        except json.JSONDecodeError:
            cache = {}

    todo = c.execute("""
        SELECT p.external_id, p.name FROM map_pharmacy p
        LEFT JOIN pharmacy_profile f
               ON f.external_id = p.external_id AND f.source = p.source
        WHERE p.source = 'google' AND p.external_id IS NOT NULL
          AND (? OR f.external_id IS NULL)
        ORDER BY p.nearest_km
    """, (1 if args.refresh else 0,)).fetchall()
    if not args.refresh:
        todo = [r for r in todo if r["external_id"] not in cache]
    if args.limit:
        todo = todo[: args.limit]
    print(f"to fetch: {len(todo)} (cache holds {len(cache)})")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    written = 0
    codes: dict[int, int] = {}
    for i, row in enumerate(todo, 1):
        pid = row["external_id"]
        code, payload = fetch(key, pid)
        codes[code] = codes.get(code, 0) + 1
        if code != 200:
            if code in (401, 403):
                print(f"stopped: HTTP {code} {str(payload)[:160]}")
                break
            time.sleep(0.8)
            continue
        cache[pid] = flatten(payload)
        f = cache[pid]
        c.execute("""
            INSERT OR REPLACE INTO pharmacy_profile
              (source, external_id, name, address, phone, website, rating, reviews,
               price_level, hours_json, photos_json, summary, maps_uri, status, fetched_at)
            VALUES ('google',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            pid, f["name"] or row["name"], f["address"], f["phone"], f["website"],
            f["rating"], f["reviews"], f["price_level"],
            json.dumps(f["hours"], ensure_ascii=False),
            json.dumps(f["photos"], ensure_ascii=False),
            f["summary"], f["maps_uri"], f["status"], now,
        ))
        written += 1
        if i % 25 == 0:
            c.commit()
            json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"  [{i}/{len(todo)}] {row['name'][:40]} · rating {f['rating']} · "
                  f"{len(f['photos'])} photos")
        time.sleep(args.pause)

    c.commit()
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"profiles written: {written} · HTTP {dict(sorted(codes.items()))}")
    n, rated, with_site, with_photo = c.execute("""
        SELECT count(*), sum(rating IS NOT NULL), sum(website IS NOT NULL),
               sum(photos_json != '[]')
        FROM pharmacy_profile
    """).fetchone()
    print(f"db: {n} profiles · {rated} rated · {with_site} with a website · "
          f"{with_photo} with photos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
