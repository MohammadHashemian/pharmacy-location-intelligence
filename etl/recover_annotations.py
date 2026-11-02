"""Put back the areas my own tests deleted, from the SQLite WAL.

Two tests cleaned up by enumerating the user's rows and deleting them:

    for it in api("/api/surveys")["items"]:
        api(f"/api/surveys?id={it['id']}", method="DELETE")

That is the bug these rows are recovering from. The polygons were still in the write-ahead
log, so the recovery scans `pharmacy.sqlite-wal` for JSON point arrays, pairs each with the
Persian label stored just before it, and only inserts what is missing.

    python etl/recover_annotations.py            # report
    python etl/recover_annotations.py --apply
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
WAL = DB + "-wal"

PAT = re.compile(r"\[\[3[01]\.[^\[\]]*(?:\]?,?\[3[01]\.[^\[\]]*){2,}\]\]")

# labels that this session wrote while testing — never restored
FIXTURES = ("آزمون", "شمال خیابان", "مکان بازدید", "پروب", "probe")


def area_km2(points: list[list[float]]) -> float:
    lat0 = sum(p[0] for p in points) / len(points)
    kx = 111.32 * math.cos(math.radians(lat0))
    s = 0.0
    for i in range(len(points)):
        lat1, lon1 = points[i]
        lat2, lon2 = points[(i + 1) % len(points)]
        s += lon1 * kx * (lat2 * 111.32) - lon2 * kx * (lat1 * 111.32)
    return abs(s) / 2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(WAL):
        print("no WAL — nothing to scan")
        return 1

    text = open(WAL, "rb").read().decode("utf-8", "ignore")
    found: dict[str, list[list[float]]] = {}
    for m in PAT.finditer(text):
        try:
            pts = json.loads(m.group(0))
        except Exception:
            continue
        if len(pts) < 3 or not all(isinstance(p, list) and len(p) == 2 for p in pts):
            continue
        if not all(29 < p[0] < 34 and 47 < p[1] < 51 for p in pts):
            continue
        before = text[max(0, m.start() - 300):m.start()]
        labels = re.findall(r"[\u0600-\u06FF][\u0600-\u06FF\s\u200c]{2,40}", before)
        name = labels[-1].strip() if labels else ""
        if not name or any(f in name for f in FIXTURES):
            continue
        found.setdefault(name, pts)

    c = sqlite3.connect(DB)
    have = {r[0] for r in c.execute("SELECT name FROM survey_area")}
    print(f"{len(found)} labelled polygons in the WAL, {len(have)} already in the table")
    for name, pts in found.items():
        flag = "have" if name in have else "MISSING"
        print(f"  {flag:8} {name[:40]:42} {len(pts)} pts · {area_km2(pts):.2f} km²")

    if not args.apply:
        print("\nreport only — pass --apply to insert the missing ones")
        return 0

    inserted = 0
    for name, pts in found.items():
        if name in have:
            continue
        # all seven were drawn with the survey tool; the point count differs because a
        # neighbourhood is not the same shape twice
        if True:
            c.execute("INSERT INTO survey_area (user_id, name, note, points, area_km2)"
                      " VALUES (1,?,?,?,?)",
                      (name, None, json.dumps(pts), round(area_km2(pts), 2)))
            table = "survey_area"

        inserted += 1
        print(f"  inserted {table}: {name}")
    c.commit()
    print(f"\n{inserted} rows restored")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
