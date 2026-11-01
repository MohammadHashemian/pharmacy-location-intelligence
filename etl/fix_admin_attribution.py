"""Put every settlement in the county it is actually standing in.

The map printed «کوی زیباشهر دزفول» at 31.3056, 48.7000 — inside اهواز, 130 km from
دزفول. It is not one bad label: **283 settlements sit more than 40 km from their own
county's centre**, because the admin parents were attached by *name* across the census
and OSM layers, and village names repeat in every county (`خشاب` exists more than
once; the join picked the wrong one).

The geometry is authoritative, and we already ship it: `khuzestan_bakhsh.geojson`
carries the county with each bakhsh polygon, and the dehestan file carries the
دهستان. So attribution is re-derived by point-in-polygon, not by name.

    python etl/fix_admin_attribution.py            # report what would change
    python etl/fix_admin_attribution.py --apply    # write county/bakhsh/dehestan
    python etl/fix_admin_attribution.py --apply --fix-names
                                                   # and strip a foreign county
                                                   # suffix from the name
    python etl/fix_admin_attribution.py --check    # self-test, no database writes
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
GEO = os.path.join(HOME, "web", "public", "geo")
BAKHSH = os.path.join(GEO, "khuzestan_bakhsh_areas.geojson")
DEHESTAN = os.path.join(GEO, "khuzestan_dehestan_areas.geojson")


def rings_of(geom: dict) -> list[list[list[float]]]:
    """Polygon or MultiPolygon → list of [outer, hole, hole…] rings."""
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return list(geom["coordinates"])
    return []


def bbox(ring: list[list[float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x:
                inside = not inside
        j = i
    return inside


class Layer:
    """A polygon layer indexed by bounding box, so 3.7k points are cheap."""

    def __init__(self, path: str, label: str):
        data = json.load(open(path, encoding="utf-8"))
        self.items: list[dict] = []
        for f in data["features"]:
            props = f.get("properties") or {}
            polys = [r for r in rings_of(f["geometry"]) if r]
            if not polys:
                continue
            outer = polys[0][0]
            self.items.append({
                "osm_id": props.get("osm_id") or "",
                "name": props.get("name") or "",
                "county": props.get("county") or "",
                "label": label,
                "polys": polys,
                "box": bbox(outer),
            })
        self.items.sort(key=lambda it: (it["box"][2] - it["box"][0]) * (it["box"][3] - it["box"][1]))

    def find(self, lon: float, lat: float) -> dict | None:
        for it in self.items:
            x0, y0, x1, y1 = it["box"]
            if not (x0 <= lon <= x1 and y0 <= lat <= y1):
                continue
            for poly in it["polys"]:
                if in_ring(lon, lat, poly[0]) and not any(in_ring(lon, lat, h) for h in poly[1:]):
                    return it
        return None


def norm_county(name: str) -> str:
    return (name or "").replace("شهرستان ", "").strip()


def check() -> int:
    """Boundary answers we can verify by hand."""
    b = Layer(BAKHSH, "bakhsh")
    d = Layer(DEHESTAN, "dehestan")
    for label, lon, lat in (("اهواز", 48.6693, 31.3189), ("دزفول", 48.4050, 32.3810),
                            ("زیباشهر", 48.69999, 31.305648), ("رامهرمز", 49.604, 31.279)):
        hit = b.find(lon, lat)
        print(f"  {label:10s} → {hit['name'] if hit else 'outside'}")
        assert hit, (label, lon, lat)
    assert b.find(47.78, 30.51) is None, "بصره must be outside"
    assert d.find(48.6693, 31.3189) is not None
    print("check: point-in-polygon OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--fix-names", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--limit", type=int, default=12, help="examples to print")
    args = ap.parse_args()
    if args.check:
        return check()

    b = Layer(BAKHSH, "bakhsh")
    d = Layer(DEHESTAN, "dehestan")
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    rows = [dict(r) for r in c.execute("""
        SELECT a.id, a.kind, a.name, a.county, a.bakhsh, a.dehestan,
               p.lat, p.lon
        FROM admin_area a JOIN map_point p ON p.area_id = a.id
        WHERE p.lat IS NOT NULL AND a.kind IN ('city','village')
    """)]
    print(f"settlements with coordinates: {len(rows):,}")

    # which polygon holds each settlement
    home: dict[int, dict] = {}
    outside = 0
    for r in rows:
        poly = b.find(r["lon"], r["lat"])
        if poly:
            home[r["id"]] = poly
        else:
            outside += 1
    print(f"inside a bakhsh polygon: {len(home):,} · outside: {outside}")

    # county of a polygon = modal county of the settlements inside it. 8 % of the
    # labels are wrong, so one bad row cannot move the answer.
    votes: dict[str, dict[str, int]] = {}
    for r in rows:
        poly = home.get(r["id"])
        if not poly:
            continue
        key = str(poly["osm_id"])      # 31 counties each have a «بخش مرکزی»
        v = votes.setdefault(key, {})
        cnt = norm_county(r["county"] or "")
        if cnt:
            v[cnt] = v.get(cnt, 0) + 1
    county_of = {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in votes.items() if v}
    print(f"polygons with a county consensus: {len(county_of)}/{len(votes)}")

    changes = []
    for r in rows:
        poly = home.get(r["id"])
        if not poly:
            continue
        county = county_of.get(str(poly["osm_id"])) or norm_county(r["county"] or "")
        county = f"شهرستان {county}" if county and not county.startswith("شهرستان") else county
        bakhsh_name = poly["name"].replace("بخش ", "").strip()
        deh = d.find(r["lon"], r["lat"])
        dehestan = (deh["name"].replace("دهستان ", "").strip() if deh else (r["dehestan"] or ""))
        if (county != (r["county"] or "")) or (bakhsh_name != (r["bakhsh"] or "")) or (dehestan != (r["dehestan"] or "")):
            changes.append((r, county, bakhsh_name, dehestan))

    print(f"rows to re-attribute: {len(changes):,}")
    for r, county, bakhsh, dehestan in changes[: args.limit]:
        print(f"  {r['name'][:28]:30s} {norm_county(r['county']) or '—':14s} → "
              f"{norm_county(county):14s} · {bakhsh}")

    # A name that ends with a county it does not stand in travelled here by mistake —
    # but only a *neighbourhood* prefix is evidence of that. «بیت باوی» and «کشت و
    # صنعت کارون» are real names whose last word happens to be a county; trimming
    # them destroys the name.
    strip_prefixes = ("کوی ", "شهرک ", "محله ", "بلوار ", "خیابان ", "مجتمع ", "شهر ")
    county_names = sorted({norm_county(v) for v in county_of.values() if v})
    fix = []
    for r in rows:
        poly = home.get(r["id"])
        if not poly:
            continue
        own = norm_county(county_of.get(str(poly["osm_id"]), ""))
        if not r["name"].strip().startswith(strip_prefixes):
            continue
        for name in county_names:
            if name and name != own and r["name"].strip().endswith(" " + name):
                trimmed = r["name"][: -len(name) - 1].strip()
                if len(trimmed) >= 6:
                    fix.append((r, r["name"], trimmed, own))
                break
    print(f"names carrying a county they are not in: {len(fix)}")
    for r, old, new, own in fix[: args.limit]:
        print(f"  «{old}» → «{new}»  (in {own})")

    if not args.apply:
        print("(report only — pass --apply)")
        return 0

    for r, county, bakhsh, dehestan in changes:
        c.execute("UPDATE admin_area SET county = ?, bakhsh = ?, dehestan = ? WHERE id = ?",
                  (county, bakhsh, dehestan, r["id"]))
    if args.fix_names:
        for r, old, new, _own in fix:
            if new:
                c.execute("UPDATE admin_area SET name = ? WHERE id = ?", (new, r["id"]))
    c.commit()
    print(f"applied: {len(changes):,} areas re-attributed"
          f"{', ' + str(len(fix)) + ' names trimmed' if args.fix_names else ''}")
    print("now rebuild the layer: python etl/build_map_layer.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
