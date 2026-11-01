"""Build the interactive map layer for استان خوزستان.

Answers three questions the ranking dashboard cannot:

  1. **Where do people actually live?** Every شهر/روستا of the administrative
     layer that has a coordinate becomes one node — 3.6k+ of them, named with
     شهرستان → بخش → دهستان, carrying population and the live FDA pharmacy
     count. Places without a coordinate are counted and reported, never plotted
     at a guessed position.
  2. **How far is it from اهواز?** A proximity graph over the settlements
     (k nearest + everything within 10 km) is walked with Dijkstra from اهواز;
     where OSRM measured a real driving distance that number wins, and the
     graph number is calibrated against the median road/network ratio otherwise.
     `dist_source` records which one each row carries.
  3. **Where is the pharmacy density, inside inhabited ground only?** A ~3.3 km
     grid is kept only for cells within MASK_KM of a settlement, so desert, salt
     flats and the Zagros ridges stay blank by construction.

Outputs
  db/pharmacy.sqlite ................ map_point, map_edge, map_density, map_import
  web/public/geo/khuzestan_bakhsh_areas.geojson .... 67 بخش polygons (+label anchors)
  web/public/geo/khuzestan_dehestan_areas.geojson .. 188 دهستان polygons (+label anchors)

The polygons are stitched from the raw Overpass relations (`out geom`) — the
existing khuzestan_bakhsh.geojson is a LineString soup because the atlas only
strokes it; a filled map needs closed rings.

Usage: python etl/build_map_layer.py [--check]
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_geo import haversine_km, norm_key  # noqa: E402

# `etl/export_geo_map.py` has this same function, but importing it drags in
# scipy (sparse MST) for a 20-line pure helper — this layer must run on a bare
# numpy install, so the simplifier lives here.
def rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Ramer–Douglas–Peucker on a closed ring, iterative (no recursion limit)."""
    if len(points) < 4:
        return points
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    arr = np.asarray(points, dtype=float)
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        p0, p1 = arr[i], arr[j]
        seg = p1 - p0
        nrm = math.hypot(seg[0], seg[1])
        if nrm == 0:
            d = np.hypot(arr[i + 1:j, 0] - p0[0], arr[i + 1:j, 1] - p0[1])
        else:
            d = np.abs(seg[0] * (p0[1] - arr[i + 1:j, 1]) -
                       (p0[0] - arr[i + 1:j, 0]) * seg[1]) / nrm
        if d.size == 0:
            continue
        k = int(np.argmax(d))
        if d[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return [points[i] for i in range(len(points)) if keep[i]]

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
RAW = os.path.join(HOME, "data", "raw", "osm")
OUT_GEO = os.path.join(HOME, "web", "public", "geo")
SCHEMA = os.path.join(HOME, "etl", "schema_map.sql")

REFERENCE_NAME = "اهواز"
K_NEIGHBORS = 5
CONNECT_KM = 10.0
MAX_EDGE_KM = 45.0            # longer proximity edges bridge deserts, not roads
RING_EDGES = (0, 25, 50, 75, 100, 150, 200, 300)

# density grid — same geometry as build_geo_density.py, computed on the admin
# layer instead of the OSM-only places file, which double-counts names.
GRID_LAT, GRID_LON = 0.030, 0.033
WINDOW_KM, MASK_KM = 10.0, 2.5

RDP_BAKHSH = 0.0018
RDP_DEHESTAN = 0.0030


# --------------------------------------------------------------------------- #
# geometry helpers
# --------------------------------------------------------------------------- #
def km_xy(lat: np.ndarray, lon: np.ndarray, lat0: float = 31.4) -> tuple[np.ndarray, np.ndarray]:
    k = math.cos(math.radians(lat0))
    return (lon - 48.0) * 111.32 * k, (lat - lat0) * 110.57


def stitch_rings(members: list[dict]) -> tuple[list[list[tuple[float, float]]], int]:
    """Join unordered member ways into closed rings.

    Overpass returns the outer ways of a multipolygon in arbitrary order and
    direction. Endpoints are shared node-for-node, so exact tuple matching is
    enough; anything that refuses to close is dropped and counted.
    """
    segs: list[list[tuple[float, float]]] = []
    for m in members:
        if m.get("role") == "subarea":       # nested relations, not geometry
            continue
        g = m.get("geometry")
        if not g or len(g) < 2:
            continue
        way = [(round(p["lon"], 7), round(p["lat"], 7)) for p in g]
        if way[0] == way[-1]:
            segs.append(way)
        else:
            segs.append(way)

    rings, open_ways = [], 0
    while segs:
        cur = segs.pop(0)
        grew = True
        while grew and cur[0] != cur[-1]:
            grew = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(i)
                grew = True
                break
        if len(cur) >= 4 and cur[0] == cur[-1]:
            rings.append(cur)
        else:
            open_ways += 1
    return rings, open_ways


def ring_area_km2(ring: list[tuple[float, float]]) -> float:
    """Spherical-excess-free planar area of a lon/lat ring, in km²."""
    lat0 = np.mean([p[1] for p in ring])
    kx = 111.32 * math.cos(math.radians(lat0))
    ky = 110.57
    x = np.array([p[0] for p in ring]) * kx
    y = np.array([p[1] for p in ring]) * ky
    return abs(float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))) / 2.0


def _inside(ring: list[tuple[float, float]], x: float, y: float) -> bool:
    """Even-odd ray cast for one point against one closed ring."""
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y):
            if x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
    return hit


def label_anchor(ring: list[tuple[float, float]]) -> tuple[float, float]:
    """A point that is actually INSIDE the shape.

    The vertex mean of a crescent-shaped district (دزپارت, اندیکا) lands in the
    next district, and a label floating outside its own polygon reads as a bug.
    So: shoelace centroid, then bbox centre, then a 15×15 grid search that keeps
    the inside point farthest from the ring's vertices.
    """
    n = len(ring)
    if n < 3:
        return round(ring[0][1], 4), round(ring[0][0], 4)
    area = 0.0
    cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        cr = x1 * y2 - x2 * y1
        area += cr
        cx += (x1 + x2) * cr
        cy += (y1 + y2) * cr
    if abs(area) > 1e-12:
        cx /= 3 * area
        cy /= 3 * area
        if _inside(ring, cx, cy):
            return round(cy, 4), round(cx, 4)

    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    bx, by = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    if _inside(ring, bx, by):
        return round(by, 4), round(bx, 4)

    best, best_d = (bx, by), -1.0
    for i in range(15):
        for j in range(15):
            px = min(xs) + (max(xs) - min(xs)) * (i + 0.5) / 15
            py = min(ys) + (max(ys) - min(ys)) * (j + 0.5) / 15
            if not _inside(ring, px, py):
                continue
            d = min((px - vx) ** 2 + (py - vy) ** 2 for vx, vy in ring[::4])
            if d > best_d:
                best, best_d = (px, py), d
    return round(best[1], 4), round(best[0], 4)


def union_rings(rings: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Outer boundary of a set of adjacent polygons, by edge parity.

    Every internal border is shared by exactly two بخش polygons, so it appears
    twice and cancels; the province outline is what is left. This needs the RAW
    stitched rings (shared vertices identical), not the simplified export.
    """
    edges: dict[tuple[tuple[float, float], tuple[float, float]], int] = {}
    for ring in rings:
        for a, b in zip(ring, ring[1:]):
            key = (a, b) if a <= b else (b, a)
            edges[key] = edges.get(key, 0) ^ 1
    remaining = [list(k) for k, n in edges.items() if n]

    # stitch the surviving edges into closed rings
    rings_out: list[list[tuple[float, float]]] = []
    while remaining:
        start, nxt = remaining.pop()
        ring = [start, nxt]
        while ring[-1] != ring[0]:
            last = ring[-1]
            for i, (a, b) in enumerate(remaining):
                if a == last:
                    ring.append(b)
                elif b == last:
                    ring.append(a)
                else:
                    continue
                remaining.pop(i)
                break
            else:
                break
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings_out.append(ring)
    return rings_out


def export_pharmacies(pts: list[dict]) -> list[tuple]:
    """Mapped pharmacy points (OSM `amenity=pharmacy`) + their nearest settlement.

    The FDA feed counts pharmacies per settlement, the OSM layer locates the ones
    somebody surveyed. Matching each point to the closest settlement within 3 km
    is enough to say "this village has a mapped pharmacy 400 m away" without
    pretending the two datasets are the same thing.
    """
    path = os.path.join(RAW, "khuzestan_pharmacies.json")
    if not os.path.exists(path):
        print("  pharmacies: data/raw/osm/khuzestan_pharmacies.json missing — run "
              "etl/fetch_osm_pharmacies.py")
        return []
    payload = json.load(open(path, encoding="utf-8"))
    outline_path = os.path.join(OUT_GEO, "khuzestan_outline.geojson")
    outline = []
    if os.path.exists(outline_path):
        fc = json.load(open(outline_path, encoding="utf-8"))
        for poly in fc["features"][0]["geometry"]["coordinates"]:
            for ring in poly:
                outline.append([(p[0], p[1]) for p in ring])
    rows, feats, outside = [], [], 0
    for el in payload["elements"]:
        t = el.get("tags") or {}
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        # The Overpass bbox includes a slice of Iraq and Kuwait; a pharmacy
        # across the border would land in خرمشهر county and inflate its count
        # (113 of 223 points were exactly that).
        if outline and not any(_inside(r, lon, lat) for r in outline):
            outside += 1
            continue
        best_i, best_d = None, 1e9
        for p in pts:
            d = haversine_km(lat, lon, p["lat"], p["lon"])
            if d < best_d:
                best_i, best_d = p, d
        name = (t.get("name") or t.get("name:fa") or t.get("name:en") or "").strip() or None
        rows.append((
            el["type"], el["id"], name, t.get("name:en"),
            round(lat, 6), round(lon, 6),
            best_i["area_id"],
            round(best_d, 2),
            best_i["county"],
            t.get("addr:street"),
        ))
        feats.append({
            "type": "Feature",
            "properties": {
                "osm": f"{el['type']}/{el['id']}",
                "name": name,
                "name_en": t.get("name:en"),
                "settlement": best_i["name"] if best_d <= 3.0 else None,
                "nearest_km": round(best_d, 2),
                "county": best_i["county"] if best_d <= 3.0 else None,
            },
            "geometry": {"type": "Point",
                          "coordinates": [round(lon, 6), round(lat, 6)]},
        })
    fc = {"type": "FeatureCollection", "features": feats,
          "_method": {"source": "Overpass node/way amenity=pharmacy",
                      "matched": "nearest administrative settlement within 3 km"}}
    out = os.path.join(OUT_GEO, "khuzestan_pharmacies.geojson")
    json.dump(fc, open(out, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    matched = sum(1 for r in rows if r[7] is not None and r[7] <= 3.0)
    if outside:
        print(f"  pharmacies: {outside} points outside the province outline dropped")
    print(f"  khuzestan_pharmacies.geojson: {len(feats):,} points · "
          f"{matched:,} within 3 km of a settlement · "
          f"{os.path.getsize(out)/1024:.0f} KB")
    return rows


def export_polygons(filename: str, raw_name: str, tolerance: float,
                    extra: dict[str, dict]) -> dict:
    payload = json.load(open(os.path.join(RAW, raw_name), encoding="utf-8"))
    feats, dropped, total_area = [], 0, 0.0
    all_rings: list[list[tuple[float, float]]] = []
    for el in payload["elements"]:
        tags = el.get("tags") or {}
        name = (tags.get("name") or "").strip()
        if not name:
            continue
        rings, open_ways = stitch_rings(el.get("members", []))
        dropped += open_ways
        rings = [r for r in rings if ring_area_km2(r) > 0.5]      # < 0.5 km² = sliver
        if not rings:
            continue
        rings.sort(key=ring_area_km2, reverse=True)
        all_rings.extend(rings)
        area = sum(ring_area_km2(r) for r in rings)
        total_area += area
        simplified = [
            [[round(x, 5), round(y, 5)] for x, y in rdp(r, tolerance)]
            for r in rings
        ]
        lat, lon = label_anchor(rings[0])
        props = {
            "osm_id": el["id"],
            "name": name,
            "name_key": norm_key(name),
            "area_km2": round(area, 1),
            "label_lat": lat,
            "label_lon": lon,
        }
        props.update(extra.get(name, {}))
        feats.append({
            "type": "Feature",
            "geometry": {"type": "MultiPolygon",
                         "coordinates": [[r] for r in simplified]},
            "properties": props,
        })
    fc = {"type": "FeatureCollection", "features": feats,
          "_method": {"stitched": "unordered member ways joined on shared nodes",
                      "simplified": f"rdp {tolerance} deg", "unclosed_ways_dropped": dropped}}

    path = os.path.join(OUT_GEO, filename)
    json.dump(fc, open(path, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    print(f"  {filename}: {len(feats)} polygons · {total_area:,.0f} km² · "
          f"{os.path.getsize(path)/1024:.0f} KB · {dropped} unclosed ways dropped")
    return fc, all_rings


ROAD_CLASSES = {"motorway": 0.0006, "trunk": 0.0008, "primary": 0.0010,
                "secondary": 0.0018}


def export_roads() -> None:
    """Major roads as thin context lines (OSM, `out geom`).

    The map has no basemap: at city scale a settlement dot alone cannot answer
    "is this on the Ahvaz–Shushtar road or behind the salt marsh". Secondary
    roads are kept because that is what a rural site actually sits on, and each
    way carries its class + bbox so the client can draw only what is visible and
    only the classes its zoom level needs.
    """
    path = os.path.join(RAW, "khuzestan_roads.json")
    if not os.path.exists(path):
        print("  roads: data/raw/osm/khuzestan_roads.json missing — run "
              "etl/fetch_osm_roads.py to add road context")
        return
    payload = json.load(open(path, encoding="utf-8"))
    feats, pts_in, pts_out = [], 0, 0
    for el in payload["elements"]:
        cls = (el.get("tags") or {}).get("highway")
        if cls not in ROAD_CLASSES:
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        pts = [(p["lon"], p["lat"]) for p in geom]
        pts_in += len(pts)
        simp = rdp(pts, ROAD_CLASSES[cls])
        pts_out += len(simp)
        xs = [p[0] for p in simp]
        ys = [p[1] for p in simp]
        feats.append({
            "type": "Feature",
            "properties": {
                "cls": cls,
                "bbox": [round(min(xs), 4), round(min(ys), 4),
                         round(max(xs), 4), round(max(ys), 4)],
            },
            "geometry": {"type": "LineString",
                          "coordinates": [[round(x, 5), round(y, 5)] for x, y in simp]},
        })
    out = {"type": "FeatureCollection", "features": feats,
           "_method": {"source": "Overpass highway=motorway|trunk|primary|secondary",
                       "simplified": "rdp per class, 0.0006-0.0018 deg"}}
    path = os.path.join(OUT_GEO, "khuzestan_roads.geojson")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    print(f"  khuzestan_roads.geojson: {len(feats):,} ways · {pts_in:,} -> "
          f"{pts_out:,} pts · {os.path.getsize(path)/1024:.0f} KB")


# --------------------------------------------------------------------------- #
# data
# --------------------------------------------------------------------------- #
def load_settlements(c: sqlite3.Connection) -> tuple[list[dict], dict]:
    rows = [dict(r) for r in c.execute("""
        SELECT a.area_id, a.kind, a.name, a.county, a.bakhsh, a.dehestan,
               a.population, a.latitude, a.longitude
        FROM v_admin_area_current a
        WHERE a.kind IN ('city', 'village')
    """)]
    # An area with no coordinate of its own but a matched OSM twin inherits the
    # twin's point — the twin IS the same settlement, so this is not a guess.
    osm = {r["area_id"]: (r["lat"], r["lon"], r["road_km"], r["road_minutes"])
           for r in c.execute("""
        SELECT l.area_id, g.lat, g.lon, g.road_km, g.road_minutes
        FROM admin_area_link l
        JOIN geo_places g ON g.id = l.ref_id
        WHERE l.layer = 'osm' AND g.lat IS NOT NULL
    """)}
    ref = next((r for r in rows
                if r["kind"] == "city" and norm_key(r["name"]) == norm_key(REFERENCE_NAME)),
               None)
    if ref is None:
        raise SystemExit("reference city اهواز not found in the administrative layer")

    plotted = 0
    for r in rows:
        lat, lon, src = r["latitude"], r["longitude"], "admin"
        road_km = road_min = None
        if lat is None or lon is None:
            twin = osm.get(r["area_id"])
            if twin:
                lat, lon, src = twin[0], twin[1], "osm"
        else:
            twin = osm.get(r["area_id"])
            if twin:
                road_km, road_min = twin[2], twin[3]
        r.update(lat=lat, lon=lon, coord_source=src,
                 road_km=road_km, road_minutes=road_min)
        plotted += lat is not None
    print(f"settlements: {len(rows):,} · plotted {plotted:,} · "
          f"no coordinate {len(rows) - plotted:,}")
    return rows, ref


def _near_pairs(lat: np.ndarray, lon: np.ndarray, k: int,
                radius_km: float) -> set[tuple[int, int]]:
    """Every pair within `radius_km`, plus the k nearest neighbours of each node.

    A bucket index over `radius_km` cells answers both questions without scipy:
    anything within `radius_km` sits in the 3×3 block of cells, and the k nearest
    are found by widening that block one shell at a time until k candidates are
    in hand (a wider shell can then only add farther points, which the k-th cap
    drops anyway).
    """
    x, y = km_xy(lat, lon)
    cell = radius_km
    buckets: dict[tuple[int, int], list[int]] = {}
    for i, (cx, cy) in enumerate(zip(x, y)):
        buckets.setdefault((int(cx // cell), int(cy // cell)), []).append(i)

    pairs: set[tuple[int, int]] = set()
    for i in range(len(lat)):
        bx, by = int(x[i] // cell), int(y[i] // cell)
        cand: list[tuple[float, int]] = []
        ring = 1
        while True:
            for ox in range(-ring, ring + 1):
                for oy in range(-ring, ring + 1):
                    if max(abs(ox), abs(oy)) != ring:
                        continue                      # only the new shell
                    for j in buckets.get((bx + ox, by + oy), ()):
                        if j != i:
                            cand.append((haversine_km(lat[i], lon[i], lat[j], lon[j]), j))
            if len(cand) >= k or ring >= 40:
                break
            ring += 1
        cand.sort()
        for d, j in cand:
            if d > radius_km:
                break
            pairs.add((i, j) if i < j else (j, i))
        for _, j in cand[:k]:
            pairs.add((i, j) if i < j else (j, i))
    return pairs


def distance_graph(pts: list[dict], ref_idx: int) -> dict:
    """Proximity graph + Dijkstra + MST, all in great-circle km, stdlib only."""
    lat = np.array([p["lat"] for p in pts], dtype=float)
    lon = np.array([p["lon"] for p in pts], dtype=float)
    x, y = km_xy(lat, lon)
    n = len(pts)

    pairs = _near_pairs(lat, lon, K_NEIGHBORS, CONNECT_KM)
    adj: list[list[tuple[int, float]]] = [[] for _ in range(n)]
    weights: dict[tuple[int, int], float] = {}
    for i, j in pairs:
        d = haversine_km(lat[i], lon[i], lat[j], lon[j])
        if d > MAX_EDGE_KM:
            continue
        key = (i, j) if i < j else (j, i)
        if key in weights and weights[key] <= d:
            continue
        weights[key] = d
        adj[i].append((j, d))
        adj[j].append((i, d))

    # Dijkstra — binary heap, 3.6k nodes: milliseconds.
    import heapq
    dist = [math.inf] * n
    dist[ref_idx] = 0.0
    heap = [(0.0, ref_idx)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                heapq.heappush(heap, (nd, v))

    # BFS hop count
    hops = [-1] * n
    hops[ref_idx] = 0
    frontier = [ref_idx]
    while frontier:
        nxt = []
        for u in frontier:
            for v, _ in adj[u]:
                if hops[v] < 0:
                    hops[v] = hops[u] + 1
                    nxt.append(v)
        frontier = nxt

    # Kruskal MST over the same edges — this is what the map draws.
    parent = list(range(n))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    mst = []
    for (i, j), w in sorted(weights.items(), key=lambda kv: kv[1]):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
            mst.append((i, j, w))
            if len(mst) == n - 1:
                break

    reachable = sum(1 for d in dist if math.isfinite(d))
    print(f"graph: {n:,} nodes · {len(weights):,} edges ≤ {MAX_EDGE_KM:.0f} km · "
          f"{reachable:,} reachable · {len(mst):,} MST edges drawn")
    return {"dist": dist, "hops": hops,
            "edges": [(i, j, round(w, 3)) for i, j, w in mst],
            "reachable": reachable, "n_edges": len(weights)}


def ring_of(km: float) -> int:
    lo = RING_EDGES[0]
    for e in RING_EDGES:
        if km >= e:
            lo = e
    return lo


# --------------------------------------------------------------------------- #
# density
# --------------------------------------------------------------------------- #
def pharmacy_weights(pts: list[dict],
                     mapped: list[tuple[int, float, float]]) -> list[tuple[float, float, float]]:
    """Spread each settlement's FDA count over the pharmacies actually mapped in it.

    The FDA feed gives a count per settlement and nothing else, so one city dot
    carried 341 pharmacies and every cell in a 3 km window inherited that number —
    inside اهواز a district with 20 pharmacies and an empty one looked identical.
    Each mapped pharmacy now carries `total / n_mapped`, which keeps the province
    total exactly and puts the weight where the stores are; a settlement with no
    mapped pharmacy keeps its whole count on the centroid.
    """
    by_area: dict[int, list[tuple[float, float]]] = {}
    for area_id, lat, lon in mapped:
        if area_id is None:
            continue
        by_area.setdefault(int(area_id), []).append((float(lat), float(lon)))
    out: list[tuple[float, float, float]] = []
    moved = 0
    for p in pts:
        total = float(p["pharmacy_total"] or 0)
        if total <= 0:
            continue
        here = by_area.get(int(p["area_id"])) or []
        if here:
            w = total / len(here)
            for lat, lon in here:
                out.append((lat, lon, w))
            moved += 1
        else:
            out.append((float(p["lat"]), float(p["lon"]), total))
    print(f"  pharmacy weights: {moved:,} settlements redistributed over "
          f"{sum(1 for _ in out):,} weighted points")
    return out


def build_density(pts: list[dict], baseline: float,
                  weights: list[tuple[float, float, float]] | None = None) -> list[dict]:
    lat = np.array([p["lat"] for p in pts], dtype=float)
    lon = np.array([p["lon"] for p in pts], dtype=float)
    pop = np.array([float(p["population"] or 0) for p in pts])
    ph = np.array([float(p["pharmacy_total"] or 0) for p in pts])
    kind = np.array([p["kind"] for p in pts])

    x, y = km_xy(lat, lon)
    # bucket the settlements on the same 10 km cell the window uses, so "who is
    # within 10 km" is a 3×3 lookup instead of a scan over 3.6k nodes
    buckets: dict[tuple[int, int], list[int]] = {}
    for j, (cx, cy) in enumerate(zip(x, y)):
        buckets.setdefault((int(cx // WINDOW_KM), int(cy // WINDOW_KM)), []).append(j)
    # weighted pharmacy supply: one entry per mapped store (or per settlement
    # centroid when nothing is mapped there)
    if weights:
        wlat = np.array([w[0] for w in weights], dtype=float)
        wlon = np.array([w[1] for w in weights], dtype=float)
        wval = np.array([w[2] for w in weights], dtype=float)
        wx, wy = km_xy(wlat, wlon)
        wbuckets: dict[tuple[int, int], list[int]] = {}
        for j, (cx, cy) in enumerate(zip(wx, wy)):
            wbuckets.setdefault((int(cx // WINDOW_KM), int(cy // WINDOW_KM)), []).append(j)
    else:
        wx = wy = wval = None
        wbuckets = {}

    # The residential mask follows the population: a 1.2 M city covers ~12 km of
    # ground, and a flat 2.5 km mask around its single centroid erased every
    # district of اهواز from the grid.
    mask_km = np.clip(0.9 * np.sqrt(np.maximum(pop, 0) / 1000), MASK_KM, 12.0)

    cities = [(x[j], y[j]) for j in range(len(pts)) if kind[j] == "city"]
    city_idx = [j for j in range(len(pts)) if kind[j] == "city"]

    lats = np.arange(lat.min() - 0.03, lat.max() + 0.03, GRID_LAT)
    lons = np.arange(lon.min() - 0.03, lon.max() + 0.03, GRID_LON)
    glat, glon = np.meshgrid(lats, lons, indexing="ij")
    gx, gy = km_xy(glat.ravel(), glon.ravel())

    cells, kept = [], 0
    for i, (cx, cy) in enumerate(zip(gx, gy)):
        bx, by = int(cx // WINDOW_KM), int(cy // WINDOW_KM)
        near, nearest_d, nearest_j = [], math.inf, None
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                for j in buckets.get((bx + ox, by + oy), ()):
                    d = math.hypot(x[j] - cx, y[j] - cy)
                    if d <= WINDOW_KM:
                        near.append(j)
                    if d < nearest_d:
                        nearest_d, nearest_j = d, j
        if nearest_j is None or nearest_d > float(mask_km[nearest_j]):
            continue                     # desert / ridge / marsh: not a residential cell
        kept += 1
        w_pop = float(pop[near].sum())
        if w_pop <= 0:
            continue                     # somebody lives here, but no count: no cell
        if wx is not None:
            w_ph = 0.0
            for ox in (-1, 0, 1):
                for oy in (-1, 0, 1):
                    for j in wbuckets.get((bx + ox, by + oy), ()):
                        if math.hypot(wx[j] - cx, wy[j] - cy) <= WINDOW_KM:
                            w_ph += float(wval[j])
        else:
            w_ph = float(ph[near].sum())
        urban_name = None
        if city_idx:
            k = min(range(len(city_idx)),
                    key=lambda q: (x[city_idx[q]] - cx) ** 2 + (y[city_idx[q]] - cy) ** 2)
            urban_name = pts[city_idx[k]]["name"]
        cells.append({
            "lat": round(float(glat.ravel()[i]), 4),
            "lon": round(float(glon.ravel()[i]), 4),
            "population": int(round(w_pop)),
            "pharmacies": int(round(w_ph)),
            "dens": round(w_ph / w_pop * 1e4, 3),
            "gap": round(w_pop / baseline - w_ph, 1) if baseline else 0.0,
            "nearest_name": pts[nearest_j]["name"],
            "county": pts[nearest_j]["county"],
            "dehestan": pts[nearest_j]["dehestan"],
            "nearest_urban": urban_name,
        })
    print(f"density: {len(gx):,} grid cells → {kept:,} residential "
          f"(≤{MASK_KM:.1f} km from a settlement) → {len(cells):,} with population")
    return cells


# --------------------------------------------------------------------------- #
def write_db(c: sqlite3.Connection, pts: list[dict], graph: dict,
             cells: list[dict], meta: dict, pharmacies: list[tuple]) -> None:
    now = meta["built_at"]
    c.execute("DELETE FROM map_point")
    c.execute("DELETE FROM map_edge")
    c.execute("DELETE FROM map_density")
    c.execute("DELETE FROM map_pharmacy WHERE source = 'osm'")
    c.execute("DELETE FROM map_import")
    c.executemany("""
        INSERT OR REPLACE INTO map_pharmacy (osm_type, osm_id, name, name_en, lat,
              lon, nearest_area_id, nearest_km, county, street, source)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'osm')
    """, pharmacies)
    c.executemany("""
        INSERT INTO map_point (area_id, lat, lon, coord_source, straight_km,
              road_km, road_minutes, net_km, est_km, dist_source, ring_km, deg, built_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, [(p["area_id"], p["lat"], p["lon"], p["coord_source"], p["straight_km"],
           p["road_km"], p["road_minutes"], p["net_km"], p["est_km"],
           p["dist_source"], p["ring_km"], p["deg"], now) for p in pts])
    ids = [p["area_id"] for p in pts]
    c.executemany("INSERT OR IGNORE INTO map_edge (a, b, km) VALUES (?,?,?)",
                  [(ids[i], ids[j], km) for i, j, km in graph["edges"]])
    c.executemany("""
        INSERT INTO map_density (lat, lon, population, pharmacies, dens, gap,
              nearest_name, county, dehestan, nearest_urban)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    """, [(d["lat"], d["lon"], d["population"], d["pharmacies"], d["dens"],
           d["gap"], d["nearest_name"], d["county"], d["dehestan"],
           d["nearest_urban"]) for d in cells])
    c.execute("""
        INSERT INTO map_import (id, built_at, reference_name, reference_lat,
              reference_lon, k_neighbors, connect_km, max_edge_km,
              road_calibration, n_road_sample, n_settlement, n_plotted, n_edge,
              n_cell, residents_per_pharmacy, grid_step_km, mask_km, window_km, notes)
        VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (now, meta["reference_name"], meta["reference_lat"], meta["reference_lon"],
          K_NEIGHBORS, CONNECT_KM, MAX_EDGE_KM, meta["road_calibration"],
          meta["n_road_sample"], meta["n_settlement"], len(pts), len(graph["edges"]),
          len(cells), meta["residents_per_pharmacy"], GRID_LAT * 110.57,
          MASK_KM, WINDOW_KM, meta["notes"]))
    c.commit()


def main() -> int:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    c.executescript(open(SCHEMA, encoding="utf-8").read())
    # additive migration: an older map_pharmacy predates the provider column
    cols = {r[1] for r in c.execute("PRAGMA table_info(map_pharmacy)")}
    if "source" not in cols:
        c.execute("ALTER TABLE map_pharmacy ADD COLUMN source TEXT NOT NULL DEFAULT 'osm'")
        c.commit()

    rows, ref = load_settlements(c)
    ref_lat, ref_lon = ref["latitude"], ref["longitude"]

    # live pharmacy counts, so the density/gap numbers come from the same join
    # the web page will read
    pharm = {r["area_id"]: r for r in c.execute(
        "SELECT area_id, pharmacy_real, pharmacy_legal, n_fda_rows FROM v_map_pharmacy")}

    pts = [r for r in rows if r["lat"] is not None]
    for r in pts:
        p = pharm.get(r["area_id"])
        r["pharmacy_real"] = p["pharmacy_real"] if p else 0
        r["pharmacy_legal"] = p["pharmacy_legal"] if p else 0
        r["pharmacy_total"] = r["pharmacy_real"] + r["pharmacy_legal"]
        r["n_fda_rows"] = p["n_fda_rows"] if p else 0
        r["straight_km"] = haversine_km(ref_lat, ref_lon, r["lat"], r["lon"])

    ref_idx = next(i for i, r in enumerate(pts) if r["area_id"] == ref["area_id"])
    graph = distance_graph(pts, ref_idx)

    # Calibrate the graph against the measured OSRM distances. A network path is
    # a lower bound of the road distance (it cuts corners), so the median ratio
    # over places beyond 5 km turns it into an estimate instead of a guess.
    ratios: list[float] = []
    rejected_road = 0
    for p, d in zip(pts, graph["dist"]):
        p["net_km"] = round(float(d), 2) if np.isfinite(d) else None
        # A driving distance shorter than the great circle means the twin this
        # row borrowed its road number from is NOT the same settlement (name
        # collision across counties). Drop the number instead of plotting a
        # village 36 km closer to اهواز than it is.
        if p["road_km"] is not None and p["road_km"] < p["straight_km"] * 0.98:
            rejected_road += 1
            p["road_km"] = p["road_minutes"] = None
        if p["road_km"] and p["net_km"] and p["net_km"] >= 5.0:
            ratios.append(float(p["road_km"]) / p["net_km"])
    calibration = round(float(np.median(ratios)), 3) if ratios else None
    print(f"road calibration: median(road/network) = {calibration} over "
          f"{len(ratios)} measured places · {rejected_road} road distances rejected "
          f"(shorter than the straight line)")

    for p, h in zip(pts, graph["hops"]):
        if p["area_id"] == ref["area_id"]:
            # the reference city is zero km from itself; OSRM would return a
            # 1.4 km detour because its pin sits a little off the town centre
            p["est_km"], p["dist_source"] = 0.0, "reference"
        elif p["road_km"]:
            p["est_km"] = round(float(p["road_km"]), 2)
            p["dist_source"] = "road"
        elif p["net_km"] is not None and calibration:
            p["est_km"] = round(p["net_km"] * calibration, 2)
            p["dist_source"] = "network"
        elif p["net_km"] is not None:
            p["est_km"] = p["net_km"]
            p["dist_source"] = "network"
        else:
            # disconnected island in the graph: the straight line is the only
            # honest number left, and the row says so.
            p["est_km"] = round(p["straight_km"] * 1.3, 2)
            p["dist_source"] = "straight"
        p["est_km"] = max(p["est_km"], 0.0)
        p["ring_km"] = ring_of(p["est_km"])
        p["deg"] = int(h) if h < np.iinfo(np.int32).max else None

    prov_pop = sum(float(p["population"] or 0) for p in pts)
    prov_ph = sum(p["pharmacy_total"] for p in pts)
    baseline = prov_pop / prov_ph if prov_ph else 0.0
    print(f"province basis: {prov_pop:,.0f} population · {prov_ph:,.0f} pharmacies "
          f"· {baseline:,.0f} residents per pharmacy")

    pharmacies = export_pharmacies(pts)
    # pharmacies exported above are OSM (they are re-inserted after this), so the
    # rest of the map — Google/Neshan imports — is read from the table as it
    # stands; both feed the same weighting
    mapped = [(r[6], r[4], r[5]) for r in pharmacies]
    mapped += [(r[0], r[1], r[2]) for r in c.execute("""
        SELECT nearest_area_id, lat, lon FROM map_pharmacy
        WHERE source <> 'osm' AND nearest_area_id IS NOT NULL
    """)]
    print(f"  mapped pharmacies for density: {len(mapped):,}")
    cells = build_density(pts, baseline, pharmacy_weights(pts, mapped))

    # --- admin polygons for the map background -----------------------------
    county_of = {}
    for r in rows:
        if r["county"]:
            county_of.setdefault(norm_key(r["name"]), r["county"])
    # bakhsh → its شهرستان, straight from the admin tree (name-keyed, same as
    # the rest of the project) — OSM has no county polygons for خوزستان.
    bakhsh_county = {r["name_key"]: r["county"] for r in c.execute("""
        SELECT name_key, county FROM admin_area WHERE kind = 'bakhsh'
    """) if r["county"]}
    bakhsh_fc, bakhsh_rings = export_polygons("khuzestan_bakhsh_areas.geojson",
                                "khuzestan_admin6.json", RDP_BAKHSH,
                                {k: {"county": v} for k, v in bakhsh_county.items()})
    # province outline = edge-parity union of the بخش polygons the map already
    # draws; one stroke on top of the fills is what makes the silhouette read
    outline_rings = union_rings(bakhsh_rings)
    outline_rings.sort(key=ring_area_km2, reverse=True)
    outline_rings = [r for r in outline_rings if ring_area_km2(r) > 50]
    outline = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "MultiPolygon",
                         "coordinates": [[[[round(x, 5), round(y, 5)] for x, y in
                                          rdp(r, RDP_BAKHSH)]] for r in outline_rings]},
            "properties": {"name": "خوزستان",
                           "area_km2": round(sum(ring_area_km2(r) for r in outline_rings), 1)},
        }],
    }
    path = os.path.join(OUT_GEO, "khuzestan_outline.geojson")
    json.dump(outline, open(path, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    print(f"  khuzestan_outline.geojson: {len(outline_rings)} ring(s) · "
          f"{sum(ring_area_km2(r) for r in outline_rings):,.0f} km² · "
          f"{os.path.getsize(path)/1024:.0f} KB")

    dehestan_props: dict[str, dict] = {}
    for el in json.load(open(os.path.join(RAW, "khuzestan_admin7.json"),
                             encoding="utf-8"))["elements"]:
        tags = el.get("tags") or {}
        if tags.get("name"):
            dehestan_props[norm_key(tags["name"])] = {"bakhsh": tags.get("bakhsh")}
    dehestan_county = {r["name_key"]: r["county"] for r in c.execute("""
        SELECT name_key, county FROM v_admin_area_current WHERE kind = 'dehestan'
    """) if r["county"]}
    for k, v in dehestan_county.items():
        dehestan_props.setdefault(k, {})["county"] = v
    dehestan_fc, _ = export_polygons("khuzestan_dehestan_areas.geojson",
                                  "khuzestan_admin7.json", RDP_DEHESTAN,
                                  dehestan_props)

    export_roads()

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reference_name": ref["name"],
        "reference_lat": ref_lat,
        "reference_lon": ref_lon,
        "road_calibration": calibration,
        "n_road_sample": len(ratios),
        "n_settlement": len(rows),
        "residents_per_pharmacy": round(baseline),
        "notes": (f"{len(rows) - len(pts):,} settlements have no coordinate and are "
                  f"not plotted; {graph['reachable']:,}/{len(pts):,} joined the "
                  f"network graph; {rejected_road} road distances rejected as "
                  f"shorter than the straight line (name collisions in the FDA/OSM "
                  f"link); pharmacy counts are the live FDA snapshot, admin-layer "
                  f"population as published"),
    }
    write_db(c, pts, graph, cells, meta, pharmacies)

    # --- one runnable check ------------------------------------------------
    if "--check" in sys.argv:
        n_pt = c.execute("SELECT COUNT(*) FROM map_point").fetchone()[0]
        assert n_pt == len(pts), "map_point row count drifted"
        assert len(cells) > 200, "density surface looks empty"
        assert all(d["population"] > 0 for d in cells), "a cell without people slipped in"
        assert max(d["dens"] for d in cells) < 200, "density looks like a units bug"
        assert all(29.0 <= d["lat"] <= 33.5 for d in cells), "a cell fell outside خوزستان"
        assert all(46.5 <= d["lon"] <= 51.5 for d in cells), "a cell fell outside خوزستان"
        assert all(p["est_km"] >= p["straight_km"] * 0.98 for p in pts), \
            "a distance is shorter than the straight line — graph bug"
        assert c.execute("SELECT ring_km FROM map_point WHERE area_id = ?",
                         (ref["area_id"],)).fetchone()[0] == 0, "اهواز is not in ring 0"
        assert sum(p["est_km"] == 0 for p in pts) == 1, "exactly one zero distance (اهواز)"
        total_ph = c.execute("SELECT SUM(pharmacy_total) FROM v_map_settlement "
                             "WHERE lat IS NOT NULL").fetchone()[0]
        assert total_ph == prov_ph, "pharmacy sum disagrees with v_map_pharmacy"
        n_ph = c.execute("SELECT COUNT(*) FROM map_pharmacy").fetchone()[0]
        assert n_ph > 100, f"only {n_ph} mapped pharmacies — the OSM fetch is missing"
        n_matched = c.execute("SELECT COUNT(*) FROM v_map_pharmacy_mapped").fetchone()[0]
        assert n_matched > 20, "mapped pharmacies are not matched to settlements"
        assert len(bakhsh_fc["features"]) == 67, "not every بخش produced a polygon"
        assert len(dehestan_fc["features"]) > 170, "دهستان polygons missing"
        area = sum(f["properties"]["area_km2"] for f in bakhsh_fc["features"])
        assert 55_000 < area < 75_000, f"بخش polygons cover {area:,.0f} km² — wrong"
        print("check: OK")

    row = c.execute("SELECT * FROM map_import").fetchone()
    print(f"\nmap_import: {row['built_at']} · {row['n_plotted']:,} plotted · "
          f"{row['n_edge']:,} map edges · {row['n_cell']:,} density cells · "
          f"{row['residents_per_pharmacy']:,} residents/pharmacy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
