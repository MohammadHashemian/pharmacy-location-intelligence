"""Label the places a regex cannot decide, with a model over OpenRouter.

`classify_poi` settles everything the name actually says. What is left is the hard
tail: «Dr. Sadeghi» (a pharmacy or a doctor's office?), «مرکز مشاوره پیوند مهر»
(counselling — a medical service?), «بگا» (nothing at all). Those are semantics, not
tokens.

The key and the model name come from `/settings` (table `app_setting`), so nothing is
stored in this file or in the repo.

    python etl/classify_with_llm.py                  # report what would be judged
    python etl/classify_with_llm.py --run            # call OpenRouter, store verdicts
    python etl/classify_with_llm.py --run --apply    # …and move/delete rows
    python etl/classify_with_llm.py --check          # offline: prompt + parser self-test

Verdicts are cached in `poi_classification` keyed by (table, external id, model), so a
second run costs nothing and a first run is reproducible. Nothing is applied
automatically below the confidence floor — a wrong pin misleads a site decision.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_poi import (  # noqa: E402
    CLINIC, DENTIST, DOCTOR, HOSPITAL, IRRELEVANT, LAB, MEDICAL_ROLES, PHARMACY,
    UNKNOWN, classify,
)

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
API = "https://openrouter.ai/api/v1/chat/completions"
ROLES = [PHARMACY, DOCTOR, CLINIC, DENTIST, HOSPITAL, LAB, IRRELEVANT, UNKNOWN]
FLOOR = 0.85

SYSTEM = """You label places in Iran for a pharmacy site-selection tool.
Given a JSON array of places (id, name, address), return ONLY a JSON array, same order:
[{"i": <id>, "role": "<one of: pharmacy|doctor|clinic|dentist|hospital|lab|irrelevant|unknown>", "confidence": <0..1>}]

Rules:
- pharmacy: sells medicines to the public (داروخانه, pharmacy). Not عطاری (herbalist), not a medical-equipment shop.
- doctor: one practitioner's office (مطب, مطب دکتر, clinic of a single doctor).
- clinic: درمانگاه, کلینیک, مرکز درمانی, physiotherapy, counselling centre that is licensed medical.
- dentist: دندانپزشک/دندانپزشکی.  hospital: بیمارستان.  lab: آزمایشگاه, رادیولوژی, سونوگرافی, تصویربرداری, MRI.
- irrelevant: not a medical business at all — tire shop, supermarket, cosmetics, insurance office, equipment seller, factory, a street or an address with no business name.
- unknown: the name carries no usable signal and the address does not help.
Judge by meaning, not by a keyword: «کلینیک سوم خرداد بیمه تامین اجتماعی» is a clinic, «تجهیزات پزشکی آلا» is irrelevant.
Output JSON only, no prose, no code fences."""


def setting(c: sqlite3.Connection, key: str) -> str | None:
    row = c.execute("SELECT value FROM app_setting WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def ensure_table(c: sqlite3.Connection) -> None:
    c.execute("""CREATE TABLE IF NOT EXISTS poi_classification (
        src         TEXT NOT NULL,
        ref         TEXT NOT NULL,
        name        TEXT NOT NULL,
        role        TEXT NOT NULL,
        confidence  REAL NOT NULL,
        model       TEXT NOT NULL,
        prompt_v    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (src, ref, model)
    )""")


def candidates(c: sqlite3.Connection, model: str) -> list[dict]:
    """Rows the rules cannot settle, minus the ones already judged by this model."""
    done = {(r[0], r[1]) for r in c.execute(
        "SELECT src, ref FROM poi_classification WHERE model = ?", (model,))}
    out: list[dict] = []
    for r in c.execute("SELECT osm_type || '/' || osm_id AS ref, name, street AS addr "
                       "FROM map_pharmacy"):
        if len((r["name"] or "").strip()) < 2:
            continue          # nothing to judge: an unnamed pin cannot be reasoned about
        if classify(r["name"], (), r["addr"] or "")["role"] != PHARMACY:
            if ("map_pharmacy", r["ref"]) not in done:
                out.append({"src": "map_pharmacy", "ref": r["ref"], "name": r["name"] or "",
                            "addr": r["addr"] or ""})
    for r in c.execute("SELECT CAST(id AS TEXT) AS ref, name, address AS addr FROM map_medical"):
        if len((r["name"] or "").strip()) < 2:
            continue
        if classify(r["name"], (), r["addr"] or "")["role"] not in MEDICAL_ROLES:
            if ("map_medical", r["ref"]) not in done:
                out.append({"src": "map_medical", "ref": r["ref"], "name": r["name"] or "",
                            "addr": r["addr"] or ""})
    return out


def parse(raw: str) -> list[dict]:
    """Read the model's answer without trusting its formatting."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < start:
        raise ValueError(f"no JSON array in answer: {text[:160]}")
    rows = json.loads(text[start:end + 1])
    out = []
    for r in rows:
        role = str(r.get("role", "")).strip().lower()
        if role not in ROLES:
            continue
        out.append({"i": int(r["i"]), "role": role,
                    "confidence": max(0.0, min(1.0, float(r.get("confidence", 0.5))))})
    return out


def ask(key: str, model: str, items: list[dict], timeout: int = 120) -> str:
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps(
                [{"i": i, "name": it["name"], "address": it["addr"]}
                 for i, it in enumerate(items)], ensure_ascii=False)},
        ],
    }).encode()
    req = urllib.request.Request(API, data=body, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/MohammadHashemian/pharmacy-location-intelligence",
        "X-Title": "pharmacy-location-intelligence",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    return data["choices"][0]["message"]["content"]


def apply_rows(c: sqlite3.Connection, model: str) -> tuple[int, int, int]:
    """Move/delete what the model was sure about. Nothing else is touched."""
    moved = fixed = dropped = 0
    rows = c.execute("""SELECT src, ref, name, role, confidence FROM poi_classification
                        WHERE model = ? AND confidence >= ?""", (model, FLOOR)).fetchall()
    for src, ref, name, role, conf in rows:
        if src == "map_pharmacy":
            if role == PHARMACY:
                continue
            if role in MEDICAL_ROLES:
                r = c.execute("SELECT lat, lon, nearest_area_id, nearest_km, county, street "
                              "FROM map_pharmacy WHERE osm_type || '/' || osm_id = ?",
                              (ref,)).fetchone()
                if r:
                    c.execute("""INSERT OR IGNORE INTO map_medical
                        (kind, name, lat, lon, nearest_area_id, nearest_km, county, address,
                         source, external_id) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                              (role, name, r[0], r[1], r[2], r[3], r[4], r[5], "llm", ref))
                    moved += 1
            c.execute("DELETE FROM map_pharmacy WHERE osm_type || '/' || osm_id = ?", (ref,))
            dropped += 1
        else:
            if role in MEDICAL_ROLES:
                c.execute("UPDATE map_medical SET kind = ? WHERE CAST(id AS TEXT) = ?",
                          (role, ref))
                fixed += 1
            elif role == IRRELEVANT:
                c.execute("DELETE FROM map_medical WHERE CAST(id AS TEXT) = ?", (ref,))
                dropped += 1
    c.commit()
    return moved, fixed, dropped


def check() -> int:
    """Offline self-test: the prompt contract and the parser, no key needed."""
    good = '''```json
[{"i":0,"role":"pharmacy","confidence":0.92},{"i":1,"role":"irrelevant","confidence":0.88},
 {"i":2,"role":"doctor","confidence":0.71},{"i":3,"role":"nonsense","confidence":0.9}]
```'''
    rows = parse(good)
    assert [r["i"] for r in rows] == [0, 1, 2], rows       # the bad role is dropped
    assert rows[0]["role"] == PHARMACY and rows[0]["confidence"] == 0.92
    assert parse('[{"i":7,"role":"clinic","confidence":2}]')[0]["confidence"] == 1.0
    try:
        parse("I think these are pharmacies.")
        raise AssertionError("should have raised")
    except ValueError:
        pass
    assert len(SYSTEM) > 200 and "pharmacy" in SYSTEM
    print("check: parser + prompt OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="call OpenRouter")
    ap.add_argument("--apply", action="store_true", help="move/delete after judging")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=25)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        return check()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    ensure_table(c)
    key = setting(c, "openrouter_api_key")
    model = setting(c, "openrouter_model")

    if not args.run:
        todo = candidates(c, model or "—")
        print(f"{len(todo)} places need a verdict")
        for r in todo[:12]:
            print(f"  [{r['src'][4:]}] {r['name'][:44]:46s} {r['addr'][:40]}")
        print(f"\nkey: {'saved' if key else 'MISSING'} · model: {model or 'MISSING'}")
        print("add both in /settings, then: python etl/classify_with_llm.py --run --apply")
        return 0

    if not key or not model:
        print("missing openrouter_api_key / openrouter_model in app_setting — set them in /settings")
        return 1

    todo = candidates(c, model)
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        print("nothing to judge")
        return 0
    print(f"judging {len(todo)} places with {model} in batches of {args.batch}")

    saved = 0
    for start in range(0, len(todo), args.batch):
        batch = todo[start:start + args.batch]
        try:
            raw = ask(key, model, batch)
            rows = parse(raw)
        except (urllib.error.HTTPError, ValueError, KeyError, TimeoutError) as e:
            print(f"  batch {start//args.batch + 1}: {str(e)[:120]}")
            continue
        for r in rows:
            if r["i"] >= len(batch):
                continue
            it = batch[r["i"]]
            c.execute("""INSERT OR REPLACE INTO poi_classification
                         (src, ref, name, role, confidence, model, prompt_v)
                         VALUES (?,?,?,?,?,?,?)""",
                      (it["src"], it["ref"], it["name"], r["role"], r["confidence"],
                       model, "v1"))
        c.commit()
        saved += len(rows)
        print(f"  batch {start//args.batch + 1}: {len(rows)} verdicts", flush=True)

    print(f"stored {saved} verdicts (floor {FLOOR})")
    if args.apply:
        moved, fixed, dropped = apply_rows(c, model)
        print(f"applied: {moved} moved to medical · {fixed} re-kinded · {dropped} deleted")
    else:
        low = c.execute("SELECT count(*) FROM poi_classification WHERE model = ? AND confidence < ?",
                        (model, FLOOR)).fetchone()[0]
        print(f"{low} verdicts below the confidence floor stay for review")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
