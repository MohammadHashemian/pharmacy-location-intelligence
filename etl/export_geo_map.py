"""Export the geographic layer for display: map files + a network graph.

Three artefacts, all derived from the database (never hand-written):

  web/public/geo/khuzestan_places.geojson   every map place with its attributes
                                            (status, population, distance from
                                            اهواز, the FDA row it matches)
  web/public/geo/khuzestan_bakhsh.geojson   the 67 بخش polygons, simplified, each
                                            labelled with its شهرستان — OSM's
                                            Khuzestan mapping has no county
                                            polygons, so the بakhsh layer *is* the
                                            administrative layer on this map
  data/derived/geo_network.json             the distance network: an MST over the
                                            settlements (scipy, no extra deps),
                                            degree + catchment per place, and the
                                            distance ladder from اهواز

Polygon simplification is Ramer–Douglas–Peucker at ~150 m. At this scale that is
invisible on screen and cuts the payload roughly tenfold; the simplification
tolerance is recorded in the output so the map is never mistaken for the raw data.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import sys

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import minimum_spanning_tree
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_geo import migrate  # noqa: E402
from normalize import norm_key  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT_GEO = os.path.join(HOME, "web", "public", "geo")
OUT_DERIVED = os.path.join(HOME, "data", "derived")
RDP_TOLERANCE = 0.0015          # ~150 m at Khuzestan's latitude
CATCHMENT_KM = (20.0, 30.0, 50.0)


# ---------------------------------------------------------------------------
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


def ring(points: list[tuple[float, float]]) -> list[list[float]]:
    out = [[round(x, 5), round(y, 5)] for x, y in points]
    if out and out[0] != out[-1]:
        out.append(out[0])
    return out


# ---------------------------------------------------------------------------
def export_places(c: sqlite3.Connection) -> dict:
    rows = [dict(r) for r in c.execute("""
        SELECT geo_place_id, name, name_en, place_kind, lat, lon,
               COALESCE(county, 'نامشخص') AS county, district, status,
               population_best, pop_osm, pop_wikidata, pop_wikipedia,
               pop_ref_source, pop_ref_url, pop_match_score,
               fda_place, fda_population, n_pharmacy_total,
               distance_km, road_km, road_minutes, distance_band_fa,
               direction_from_ahvaz, dq_flags, match_method, match_score,
               admin_method, admin_confidence, wikidata
        FROM v_geo_place ORDER BY status, distance_km""")]
    feats = []
    for r in rows:
        props = {k: v for k, v in r.items() if k not in ("lat", "lon")}
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point",
                         "coordinates": [round(r["lon"], 5), round(r["lat"], 5)]},
            "properties": props,
        })
    (c.execute("SELECT COUNT(*) FROM v_geo_place").fetchone())[0]
    return {"type": "FeatureCollection", "features": feats}


def export_bakhsh(c: sqlite3.Connection) -> tuple[dict, dict]:
    raw = json.load(open(os.path.join(HOME, "data", "raw", "osm",
                                      "khuzestan_admin6.json"), encoding="utf-8"))
    county_of = {r["osm_id"]: r["county"]
                 for r in c.execute("SELECT osm_id, county FROM geo_admin_unit")}
    feats = []
    stats = {"relations": 0, "segments_in": 0, "segments_out": 0}
    for el in raw["elements"]:
        pts: list[tuple[float, float]] = []
        for m in el.get("members", []):
            g = m.get("geometry")
            if not g:
                continue
            pts.extend((p["lon"], p["lat"]) for p in g)
        if len(pts) < 4:
            continue
        stats["relations"] += 1
        stats["segments_in"] += len(pts)
        # The members arrive as unordered ways, so there is no single ring to
        # simplify; RDP is applied per member way instead, which is exactly where
        # the redundant vertices are anyway.
        simplified: list[tuple[float, float]] = []
        for m in el.get("members", []):
            g = m.get("geometry")
            if not g:
                continue
            simplified.extend(rdp([(p["lon"], p["lat"]) for p in g], RDP_TOLERANCE)[:-1])
        stats["segments_out"] += len(simplified)
        tags = el.get("tags") or {}
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": ring(simplified)},
            "properties": {
                "osm_id": el["id"],
                "name": tags.get("name"),
                "county": county_of.get(el["id"]),
                "wikidata": tags.get("wikidata"),
            },
        })
    fc = {"type": "FeatureCollection", "features": feats,
          "_simplified": {"method": "rdp-per-member-way", "tolerance_deg": RDP_TOLERANCE}}
    stats["county_coverage"] = sum(1 for f in feats if f["properties"]["county"])
    return fc, stats


def export_network(c: sqlite3.Connection) -> dict:
    rows = [dict(r) for r in c.execute("""
        SELECT geo_place_id, name, place_kind, lat, lon, county, status,
               COALESCE(population_best, 0) AS pop, distance_km, road_km,
               fda_place, n_pharmacy_total, dq_flags
        FROM v_geo_place
        WHERE place_kind IN ('city','town','village')
          -- COALESCE is load-bearing: `dq_flags NOT LIKE '%pop_outlier%'` is NULL
          -- for every row with no flags at all, and a NULL predicate drops the
          -- row — which silently removed every clean, well-populated city from
          -- the graph (572 nodes instead of 1,858, اهواز and دزفول among the
          -- missing).
          AND COALESCE(dq_flags, '') NOT LIKE '%pop_outlier%'""")]
    pts = np.array([[r["lon"], r["lat"]] for r in rows], dtype=float)
    # Work in approximate kilometres so radii and edge weights mean what they say;
    # in raw degrees a circle is an ellipse (1° lon ≈ 95 km here, 1° lat ≈ 110 km).
    scale = np.array([np.cos(np.radians(31.5)) * 111.32, 110.57])
    km = pts * scale
    tree = cKDTree(km)

    print(f"  network nodes (city/town/village): {len(rows):,}")
    pairs = tree.query_pairs(r=35.0, output_type="ndarray")
    print(f"  candidate edges within 35 km: {len(pairs):,}")
    edges: list[dict] = []
    n_comp = 0
    if len(pairs):
        d = np.linalg.norm(km[pairs[:, 0]] - km[pairs[:, 1]], axis=1)
        keep = d <= 35.0
        pairs, d = pairs[keep], d[keep]
        # Symmetrise: csgraph would otherwise see one direction only.
        ri = np.concatenate([pairs[:, 0], pairs[:, 1]])
        ci = np.concatenate([pairs[:, 1], pairs[:, 0]])
        vv = np.concatenate([d, d])
        mst = minimum_spanning_tree(coo_matrix((vv, (ri, ci)), shape=(len(rows), len(rows))))
        mst = mst.tocoo()
        seen = set()
        for i, j, v in zip(mst.row, mst.col, mst.data):
            key = (min(i, j), max(i, j))
            if key in seen:
                continue
            seen.add(key)
            edges.append({"a": int(key[0]), "b": int(key[1]), "km": round(float(v), 1)})
        from scipy.sparse.csgraph import connected_components
        n_comp, _labels = connected_components(
            coo_matrix((np.ones(len(ri)), (ri, ci)), shape=(len(rows), len(rows))),
            directed=False)
    print(f"  MST edges: {len(edges):,} | components: {n_comp:,}")

    # catchment: how many settlements and how much population within 20/30/50 km
    catch = {radius: tree.query_ball_point(km, r=radius) for radius in CATCHMENT_KM}
    pop = np.array([r["pop"] or 0 for r in rows], dtype=float)
    out_nodes = []
    for i, r in enumerate(rows):
        node = {k: r[k] for k in ("geo_place_id", "name", "place_kind", "county",
                                  "status", "pop", "distance_km", "road_km",
                                  "fda_place", "n_pharmacy_total", "dq_flags")}
        node["lat"] = round(r["lat"], 5)
        node["lon"] = round(r["lon"], 5)
        for radius in CATCHMENT_KM:
            near = catch[radius][i]
            node[f"settlements_{int(radius)}km"] = len(near)
            node[f"population_{int(radius)}km"] = int(pop[near].sum())
        out_nodes.append(node)

    ladder = [dict(r) for r in c.execute("""
        SELECT distance_band_fa AS band, band_km,
               n_places, n_urban, n_new, population, n_pharmacies
        FROM v_geo_distance_bands ORDER BY band_km""")]

    # Catchment is the answer to a problem the map layer cannot solve on its own:
    # 480 of the candidate places have no population statement anywhere. Ranking
    # them by how much population sits within 20/30/50 km gives a size proxy that
    # does not invent a number for the place itself. Stored back onto geo_places
    # so SQL, the report and the page all read the same value.
    migrate(c)
    for i, r in enumerate(rows):
        sets = {int(km): v[i] for km, v in catch.items()}
        c.execute("""UPDATE geo_places SET
                       settlements_20km = ?, population_20km = ?,
                       settlements_30km = ?, population_30km = ?,
                       settlements_50km = ?, population_50km = ?
                     WHERE id = ?""",
                  (len(sets[20]), int(pop[sets[20]].sum()),
                   len(sets[30]), int(pop[sets[30]].sum()),
                   len(sets[50]), int(pop[sets[50]].sum()),
                   r["geo_place_id"]))
    c.commit()
    print(f"  catchment stored on {len(rows):,} places")

    return {
        "nodes": out_nodes,
        "edges": edges,
        "distance_ladder": ladder,
        "meta": {
            "reference_city": "اهواز",
            "reference_lat": 31.3203, "reference_lon": 48.6693,
            "catchment_radii_km": list(CATCHMENT_KM),
            "edge_rule": "minimum spanning tree over settlements within ~35 km",
            "node_count": len(out_nodes),
            "edge_count": len(edges),
        },
    }


def main() -> int:
    os.makedirs(OUT_GEO, exist_ok=True)
    os.makedirs(OUT_DERIVED, exist_ok=True)
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    places = export_places(c)
    p = os.path.join(OUT_GEO, "khuzestan_places.geojson")
    json.dump(places, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"places  -> {p}  ({len(places['features']):,} features, "
          f"{os.path.getsize(p)/1024:.0f} KB)")

    bakhsh, stats = export_bakhsh(c)
    p = os.path.join(OUT_GEO, "khuzestan_bakhsh.geojson")
    json.dump(bakhsh, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"bakhsh  -> {p}  ({stats['relations']} relations, "
          f"{stats['segments_in']:,} -> {stats['segments_out']:,} vertices, "
          f"{os.path.getsize(p)/1024:.0f} KB)")

    net = export_network(c)
    p = os.path.join(OUT_DERIVED, "geo_network.json")
    json.dump(net, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"network -> {p}  ({net['meta']['node_count']:,} nodes, "
          f"{net['meta']['edge_count']:,} edges, {os.path.getsize(p)/1024:.0f} KB)")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
