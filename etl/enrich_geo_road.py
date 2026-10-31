"""Attach the real driving distance from اهواز to every place (OSRM).

Separate from load_geo.py on purpose: the loader deletes and re-creates
geo_places, so anything it fetched would be thrown away on the next rebuild. This
step only UPDATEs three columns, and can be re-run or skipped independently.

Uses OSRM's *table* service with a single source (اهواز) rather than one `route`
call per place — 90 destinations per request instead of 90 requests, which is both
~90× faster and far politer to the public demo server. Falls back to individual
route calls if the table call fails.

The public router is shared infrastructure: it is rate-limited here, the responses
are cached on disk, and a failure never overwrites a value already stored.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
CACHE = os.path.join(HOME, "data", "reference", "osrm_table_cache.json")
AHVAZ_LAT, AHVAZ_LON = 31.3203, 48.6693
UA = {"User-Agent": "pharmacy-site-selection/1.0 (research)"}
TABLE = "https://router.project-osrm.org/table/v1/driving/"
ROUTE = "https://router.project-osrm.org/route/v1/driving/"
BATCH = 90
PAUSE = 1.2

# Every place a pharmacy decision could plausibly be made about: the urban
# settlements plus anything the map says has 2,000+ people.
MIN_POP = 2000


def fetch_table(coords: list[tuple[float, float]]) -> dict | None:
    pts = ";".join(f"{lon},{lat}" for lon, lat in coords)
    url = f"{TABLE}{pts}?sources=0&annotations=distance,duration"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                    timeout=90) as r:
            d = json.loads(r.read().decode())
        return d if d.get("code") == "Ok" else None
    except Exception:  # noqa: BLE001
        return None


def fetch_route(lon: float, lat: float) -> dict | None:
    url = f"{ROUTE}{AHVAZ_LON},{AHVAZ_LAT};{lon},{lat}?overview=false"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                    timeout=45) as r:
            d = json.loads(r.read().decode())
        if d.get("code") == "Ok" and d.get("routes"):
            return {"km": d["routes"][0]["distance"] / 1000.0,
                    "min": d["routes"][0]["duration"] / 60.0}
    except Exception:  # noqa: BLE001
        return None
    return None


def main() -> int:
    force = "--force" in sys.argv
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    targets = [dict(r) for r in c.execute("""
        SELECT g.id, g.name, g.lat, g.lon, g.place_kind, g.distance_km
        FROM geo_places g
        WHERE g.place_kind IN ('city','town')
           OR COALESCE(g.pop_wikidata, g.pop_wikipedia, g.pop_osm, 0) >= ?
           -- and every candidate location, so the answer to "how far is it from
           -- اهواز?" exists for all of them, not just the ones that resolved a
           -- population
           OR g.id IN (SELECT m.geo_place_id FROM geo_location_match m
                       WHERE m.tier = 'variant'
                       UNION
                       SELECT gp.id FROM geo_places gp
                       WHERE gp.in_fda = 0)
        ORDER BY g.distance_km""", (MIN_POP,))]
    print(f"road-distance targets: {len(targets):,}")

    cache: dict = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE, encoding="utf-8"))
        except Exception:  # noqa: BLE001
            cache = {}

    todo = targets if force else [t for t in targets if str(t["id"]) not in cache]
    print(f"  to fetch: {len(todo):,} ({len(cache):,} cached)")

    done = 0
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        coords = [(AHVAZ_LON, AHVAZ_LAT)] + [(t["lon"], t["lat"]) for t in chunk]
        got = fetch_table(coords)
        if got and got.get("distances"):
            dist = got["distances"][0]
            dur = (got.get("durations") or [[]])[0]
            for n, t in enumerate(chunk, start=1):
                d_km = dist[n] / 1000.0 if dist[n] is not None else None
                d_min = dur[n] / 60.0 if n < len(dur) and dur[n] is not None else None
                cache[str(t["id"])] = {"km": d_km, "min": d_min, "via": "table"}
                done += 1
        else:
            print(f"  table batch {i//BATCH} failed -> per-place route calls")
            for t in chunk:
                rec = fetch_route(t["lon"], t["lat"])
                cache[str(t["id"])] = ({"km": rec["km"], "min": rec["min"],
                                        "via": "route"} if rec
                                       else {"km": None, "min": None,
                                             "via": "unreachable"})
                done += 1
                time.sleep(PAUSE)
        json.dump(cache, open(CACHE, "w", encoding="utf-8"))
        print(f"    {done:,}/{len(todo):,}", flush=True)
        time.sleep(PAUSE)

    wrote = 0
    for t in targets:
        rec = cache.get(str(t["id"]))
        if not rec or rec.get("km") is None:
            continue
        c.execute("""UPDATE geo_places SET road_km = ?, road_minutes = ?
                     WHERE id = ?""", (round(rec["km"], 2),
                                       round(rec["min"], 1) if rec.get("min") else None,
                                       t["id"]))
        wrote += 1
    c.execute("""INSERT OR REPLACE INTO geo_coverage_note
        (scope, metric, value, detail, computed_at) VALUES (?,?,?,?,?)""",
        ("khuzestan", "road_distance_resolved", wrote,
         "OSRM driving distance and time from اهواز", time.strftime(
             "%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
    c.commit()
    ok = sum(1 for v in cache.values() if v.get("km") is not None)
    print(f"road distances stored: {wrote:,} of {len(targets):,} targets "
          f"({ok:,} in cache)")
    for r in c.execute("""SELECT COUNT(*) n,
                                 ROUND(AVG(road_km / distance_km), 2) ratio
                          FROM geo_places
                          WHERE road_km IS NOT NULL AND distance_km > 5"""):
        print(f"  road/great-circle ratio: {r['ratio']} over {r['n']:,} places")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
