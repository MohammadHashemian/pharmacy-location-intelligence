"""A full report for one settlement — data first, prose last.

Everything here comes from the database or from the street geometry already cached under
`web/public/geo`: population, registered supply, the mapped pharmacies and medical centres,
which roads are arteries and which are side streets, the unmet-demand cells inside the town,
and a scored list of corners worth standing on. The language model only *writes up* those
numbers — it is never asked to invent one.

    python etl/area_report.py --area-id 212            # data only
    python etl/area_report.py --area-id 212 --llm      # + the Persian narrative

The result is stored as JSON in `area_report`, which `/report/<area_id>` renders and
`/api/report` regenerates on demand.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sqlite3

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
GEO = os.path.join(HOME, "web", "public", "geo")

KM_LAT = 110.574
KM_LON = 111.320 * math.cos(math.radians(31.3))

ARTERIAL = {"primary", "primary_link", "secondary", "secondary_link", "trunk"}
COLLECTOR = {"tertiary", "tertiary_link"}
LOCAL = {"residential", "living_street", "service", "unclassified"}

KIND_FA = {
    "pharmacy": "داروخانه", "clinic": "درمانگاه", "doctor": "مطب پزشک",
    "dentist": "دندان‌پزشکی", "hospital": "بیمارستان", "lab": "آزمایشگاه",
}


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((a[0] - b[0]) * KM_LAT, (a[1] - b[1]) * KM_LON)


def load_streets(centre: tuple[float, float]) -> dict | None:
    """The cached street file nearest the town centre (they are per city)."""
    best, best_d = None, 9e9
    for fp in glob.glob(os.path.join(GEO, "streets_city-*.json")):
        try:
            fc = json.load(open(fp, encoding="utf-8"))
        except Exception:
            continue
        lat, lon = fc.get("lat"), fc.get("lon")
        if not lat or not lon:
            continue
        d = km((lat, lon), centre)
        if d < best_d:
            best, best_d = (fc, fp), d
    return best[0] if best and best_d < 15 else None


def street_profile(fc: dict, centre: tuple[float, float], radius_km: float = 3.0) -> dict:
    """Roads inside the town by class, plus the long corridors that act as its main streets.

    The cached extract for کوت عبدالله carries no `primary`/`secondary` class at all, so the
    hierarchy has to be measured rather than read: a segment longer than ~400 m is a corridor
    people drive down, and a vertex shared by three or more ways is a junction where the shops
    are. Both are computed here instead of being guessed from a tag that is not present.
    """
    by_class: dict[str, float] = {}
    segments: list[dict] = []
    seen_vertices: dict[tuple[int, int], set[int]] = {}
    for idx, feat in enumerate(fc.get("features", [])):
        geom = feat.get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        cls = (feat.get("properties") or {}).get("c", "unclassified")
        coords = geom.get("coordinates") or []
        keep: list[list[float]] = []
        length = 0.0
        for i in range(len(coords) - 1):
            a = (coords[i][1], coords[i][0])
            b = (coords[i + 1][1], coords[i + 1][0])
            if km(a, centre) > radius_km and km(b, centre) > radius_km:
                continue
            length += km(a, b)
            keep.append(coords[i])
            key = (round(a[0] * 2000), round(a[1] * 2000))
            seen_vertices.setdefault(key, set()).add(idx)
        if length <= 0:
            continue
        by_class[cls] = by_class.get(cls, 0.0) + length
        if len(keep) >= 2:
            segments.append({"cls": cls, "km": round(length, 3), "coords": keep})

    total = sum(by_class.values()) or 1
    junctions = sum(1 for v in seen_vertices.values() if len(v) >= 3)

    # a corridor is a segment at least 400 m long; the ten longest carry the traffic
    corridors = sorted((s for s in segments if s["km"] >= 0.4), key=lambda s: -s["km"])
    corridor_km = sum(s["km"] for s in corridors)
    corridors = corridors[:12]

    return {
        "km_by_class": {k: round(v, 2) for k, v in sorted(by_class.items(), key=lambda t: -t[1])},
        "arterial_km": round(sum(v for k, v in by_class.items() if k in ARTERIAL), 2),
        "collector_km": round(sum(v for k, v in by_class.items() if k in COLLECTOR), 2),
        "local_km": round(sum(v for k, v in by_class.items() if k in LOCAL), 2),
        "arterial_share": round(
            sum(v for k, v in by_class.items() if k in ARTERIAL) / total * 100, 1),
        "corridor_km": round(corridor_km, 2),
        "corridor_count": len(corridors),
        "junctions": junctions,
        "classified_arterial": any(k in ARTERIAL for k in by_class),
        "corridors": [{"km": c["km"], "cls": c["cls"], "coords": c["coords"]} for c in corridors],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--area-id", type=int, required=True)
    ap.add_argument("--radius", type=float, default=3.0)
    ap.add_argument("--llm", action="store_true", help="also write the Persian narrative")
    args = ap.parse_args()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    cap = c.execute("SELECT * FROM v_settlement_capacity WHERE area_id = ?", [args.area_id]).fetchone()
    if not cap:
        print(f"no settlement with area_id {args.area_id}")
        return 1
    centre = (cap["lat"], cap["lon"])

    # ---- supply: mapped pins first, register second, and say which is which
    pharm = [dict(r) for r in c.execute("""
        SELECT ref, name, lat, lon, source FROM (
          SELECT 'poi/' || osm_id AS ref, name, lat, lon, source FROM map_pharmacy WHERE lat IS NOT NULL
          UNION ALL
          SELECT 'manual/' || id, name, lat, lon, 'manual' FROM manual_place
           WHERE kind = 'pharmacy' AND lat IS NOT NULL)""")]
    near_ph = []
    for p in pharm:
        d = km((p["lat"], p["lon"]), centre)
        if d <= args.radius:
            near_ph.append({**p, "km": round(d, 2)})
    near_ph.sort(key=lambda p: p["km"])

    med = [dict(r) for r in c.execute("SELECT kind, name, lat, lon FROM map_medical WHERE lat IS NOT NULL")]
    near_med = []
    for m in med:
        d = km((m["lat"], m["lon"]), centre)
        if d <= args.radius:
            near_med.append({**m, "km": round(d, 2)})
    near_med.sort(key=lambda m: (m["kind"], m["km"]))
    med_mix: dict[str, int] = {}
    for m in near_med:
        med_mix[m["kind"]] = med_mix.get(m["kind"], 0) + 1

    # ---- the surface: where people live without a pharmacy nearby
    cells = [dict(r) for r in c.execute("""
        SELECT lat, lon, demand, supply, gap FROM opportunity_cell
         WHERE ABS(lat - ?) < ? AND ABS(lon - ?) < ?
         ORDER BY gap DESC LIMIT 40""",
        [centre[0], args.radius / KM_LAT, centre[1], args.radius / KM_LON])]
    hot = [x for x in cells if x["gap"] > 0]

    # ---- streets
    fc = load_streets(centre)
    streets = street_profile(fc, centre, args.radius) if fc else None

    # ---- candidate corners: on an artery, near demand, away from the nearest pharmacy
    spots: list[dict] = []
    if fc:
        for feat in fc.get("features", []):
            geom = feat.get("geometry") or {}
            if geom.get("type") != "LineString":
                continue
            cls = (feat.get("properties") or {}).get("c", "")
            if cls not in ARTERIAL and cls not in COLLECTOR:
                # no classified arteries in this extract: a long residential segment is the
                # local version of one, and that is exactly where a shop window belongs
                coords = geom.get("coordinates") or []
                span = sum(km((coords[i][1], coords[i][0]), (coords[i + 1][1], coords[i + 1][0]))
                           for i in range(len(coords) - 1)) if len(coords) > 1 else 0
                if span < 0.4:
                    continue
                cls = "corridor"
            for lon, lat in geom.get("coordinates") or []:
                p = (lat, lon)
                d_centre = km(p, centre)
                if d_centre > args.radius:
                    continue
                nearest_cell = min(
                    (x for x in cells), key=lambda x: km(p, (x["lat"], x["lon"])), default=None)
                gap = 0
                demand_here = 0
                if nearest_cell and km(p, (nearest_cell["lat"], nearest_cell["lon"])) <= 0.35:
                    gap = max(0, nearest_cell["gap"])
                    demand_here = int(nearest_cell.get("demand") or 0)
                nearest_ph = min((km(p, (q["lat"], q["lon"])) for q in near_ph), default=9.0)
                if nearest_ph < 0.45:
                    continue                      # a pharmacy already stands here
                # Two reasons a corner is interesting: the register says the town is short of
                # shops, or the *mapped* network leaves a hole. The second is weaker evidence
                # (only 6 of 22 shops are pinned here) and is labelled as such downstream.
                if gap < 150 and nearest_ph < 0.9:
                    continue
                med500 = sum(1 for m in near_med if km(p, (m["lat"], m["lon"])) <= 0.6)
                score = (min(gap, 3000) / 3000) * 0.30 \
                    + (min(demand_here, 2500) / 2500) * 0.30 \
                    + (min(nearest_ph, 2.0) / 2.0) * 0.20 \
                    + (min(med500, 3) / 3) * 0.15 \
                    + (0.05 if cls == "corridor" else 0.0)
                spots.append({
                    "lat": round(lat, 5), "lon": round(lon, 5), "road": cls,
                    "gap": int(gap), "demand": demand_here, "med_600m": med500,
                    "nearest_pharmacy_m": int(round(nearest_ph * 1000)),
                    "km_from_centre": round(d_centre, 2),
                    "score": round(score * 100, 1),
                })
    spots.sort(key=lambda s: -s["score"])
    picked: list[dict] = []
    for s in spots:
        if all(km((s["lat"], s["lon"]), (p["lat"], p["lon"])) > 0.25 for p in picked):
            picked.append(s)
        if len(picked) >= 8:
            break

    payload = {
        "area": {
            "area_id": cap["area_id"], "name": cap["name"], "kind": cap["kind"],
            "county": cap["county"], "population": cap["population"],
            "lat": round(centre[0], 5), "lon": round(centre[1], 5),
            "footprint_km2": cap["footprint_km2"], "density": cap["density"],
        },
        "supply": {
            "register": cap["supply"],                  # FDA count for this town
            "mapped": len(near_ph),
            "pharmacies_per_100k": round(100_000 * cap["supply"] / cap["population"], 1)
            if cap["population"] else None,
            "residents_per_pharmacy": round(cap["population"] / cap["supply"])
            if cap["supply"] else None,
            "nearest_km": cap["nearest_km"],
            "within_1500m": cap["pharmacies_1500"],
            "within_3000m": cap["pharmacies_3000"],
            "capacity": cap["capacity"], "remaining": cap["remaining"],
            "coverage_note": f"{len(near_ph)} پین برای {cap['supply']} داروخانهٔ ثبتی — "
                             "نقشه در این محدوده کامل نیست",
        },
        "pharmacies": near_ph[:30],
        "medical": {"mix": med_mix, "items": near_med[:40], "total": len(near_med)},
        "streets": streets,
        "opportunity": {
            "register_gap": int(sum(x["gap"] for x in cells)),
            "hot_cells": len(hot),
            "unmet_residents": int(sum(x["gap"] for x in hot)),
            "cells": [{"lat": x["lat"], "lon": x["lon"], "gap": int(x["gap"]),
                       "demand": int(x["demand"])} for x in hot[:12]],
        },
        "spots": picked,
    }

    c.execute("""CREATE TABLE IF NOT EXISTS area_report (
        area_id INTEGER PRIMARY KEY, payload TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')))""")

    if args.llm:
        payload["narrative"] = write_narrative(c, payload)
    else:
        prev = c.execute("SELECT payload FROM area_report WHERE area_id = ?", [args.area_id]).fetchone()
        if prev and json.loads(prev["payload"]).get("narrative"):
            payload["narrative"] = json.loads(prev["payload"])["narrative"]

    c.execute("""INSERT INTO area_report (area_id, payload, generated_at) VALUES (?,?, datetime('now'))
                 ON CONFLICT(area_id) DO UPDATE SET
                   payload = excluded.payload, generated_at = datetime('now')""",
              [args.area_id, json.dumps(payload, ensure_ascii=False)])
    c.commit()

    print(f"{cap['name']} · pop {cap['population']:,} · register {cap['supply']} · "
          f"mapped {len(near_ph)} · medical {len(near_med)} · hot cells {len(hot)}")
    if streets:
        print(f"  streets: arterial {streets['arterial_km']} km "
              f"({streets['arterial_share']}%) · collector {streets['collector_km']} · "
              f"local {streets['local_km']}")
    print(f"  spots picked: {len(picked)}" + (f" · top {picked[0]['score']}" if picked else ""))
    if payload.get("narrative"):
        print("  narrative: generated")
    c.close()
    return 0


ROAD_FA = {
    "residential": "محلی", "local": "محلی", "tertiary": "جمع‌کننده",
    "secondary": "شریان درجهٔ دو", "primary": "شریان درجهٔ یک",
    "unclassified": "طبقه‌بندی‌نشده", "service": "دسترسی", "corridor": "کریدور",
}


def clean_narrative(text: str) -> str:
    """Strip the machine's habits: `key=` dumps and bare English road classes.

    The model is given a Persian facts block, but a weak model still slips back into
    `nearest_km=۰٫۶۵` or `residential ۱۸۴`. Neither belongs in a report a person reads, so they
    are rewritten here rather than left as a tell.
    """
    import re

    text = re.sub(r"\b[a-z][a-z0-9_]{2,}\s*=\s*", "", text)
    for en, fa in ROAD_FA.items():
        text = re.sub(rf"\b{en}\b", fa, text)
    text = re.sub(r"[ 	]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def write_narrative(c: sqlite3.Connection, p: dict) -> str:
    """Ask the configured model to write the analysis of numbers we computed ourselves."""
    import urllib.request

    key = c.execute("SELECT value FROM app_setting WHERE key = 'openrouter_api_key'").fetchone()
    model = c.execute("SELECT value FROM app_setting WHERE key = 'openrouter_model'").fetchone()
    if not key or not key[0]:
        return ""
    a, sup, med = p["area"], p["supply"], p["medical"]
    st, op = p["streets"] or {}, p["opportunity"]
    mix = "، ".join(f"{KIND_FA.get(k, k)} {v}" for k, v in med["mix"].items()) or "هیچ"
    spots = " / ".join(
        f"{i + 1}) {sp['km_from_centre']} کیلومتر از مرکز، {sp['nearest_pharmacy_m']} متر تا نزدیک‌ترین داروخانه، "
        f"{sp['med_600m']} مرکز درمانی در ۶۰۰ متر، امتیاز {sp['score']}"
        for i, sp in enumerate(p["spots"][:3]))
    facts = " ;; ".join([
        f"نام منطقه: {a['name']} — {a['county']}",
        f"جمعیت: {a['population']}",
        f"مساحت بافت: {a['footprint_km2']} کیلومتر مربع",
        f"تراکم: {a['density']} نفر بر کیلومتر مربع",
        f"داروخانهٔ ثبتی سازمان: {sup['register']}",
        f"داروخانهٔ پین‌شده روی نقشه: {sup['mapped']}",
        f"نفر به ازای هر داروخانه: {sup['residents_per_pharmacy']}",
        f"نزدیک‌ترین داروخانه: {sup['nearest_km']} کیلومتر",
        f"داروخانه در شعاع ۱۵۰۰ متر: {sup['within_1500m']}",
        f"ظرفیت باقی‌مانده بر مبنای ۵۴۰۸ نفر: {sup['remaining']}",
        f"مراکز درمانی نقشه‌ای در ۳ کیلومتری: {med['total']} ({mix})",
        f"خیابان: شریان درجه‌یک {st.get('arterial_km')} کیلومتر، جمع‌کننده {st.get('collector_km')} کیلومتر، محلی {st.get('local_km')} کیلومتر",
        f"کریدورهای بلندتر از ۴۰۰ متر: {st.get('corridor_count')} قطعه به طول {st.get('corridor_km')} کیلومتر",
        f"تقاطع‌ها: {st.get('junctions')}",
        f"شکاف ثبتی در سلول‌های تقاضا: {op['register_gap']} نفر",
        f"نقاط پیشنهادی: {spots}",
    ])
    prompt = " || ".join([
        "تو تحلیل‌گر مکان‌یابی داروخانه در خوزستان هستی. فقط از اعداد زیر استفاده کن و هیچ عدد تازه‌ای نساز.",
        "اگر داده‌ای نیست، صریح بگو.",
        facts,
        "تحلیل را در ۲۵۰ تا ۳۵۰ کلمهٔ فارسی بنویس، شش پاراگراف شماره‌دار، بدون مقدمه:",
        "۱) تصویر کلی منطقه",
        "۲) عرضه: تفاوت شمار ثبتی با پین‌های نقشه و معنایش",
        "۳) مراکز درمانی و اثرشان بر تقاضا",
        "۴) خیابان‌ها و کریدورها",
        "۵) سه نقطهٔ پیشنهادی با دلیل و ریسک",
        "۶) دو هشدار کیفیت داده",
        "قواعد: نام هیچ فیلد یا کلید انگلیسی ننویس؛ ارقام فارسی؛ هیچ مختصاتی در متن نگذار؛ عدد تازه نساز.",
    ])
    body = json.dumps({
        "model": (model[0] if model else "openai/gpt-4o-mini"),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key[0]}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.loads(r.read())
        out = (d.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        return clean_narrative(out)
    except Exception as e:                                  # noqa: BLE001
        print(f"  llm failed: {e}")
        return ""


if __name__ == "__main__":
    raise SystemExit(main())
