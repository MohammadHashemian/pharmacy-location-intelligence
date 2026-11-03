"""Label the places a regex cannot decide, with a model over OpenRouter.

`classify_poi` settles everything the name actually says. What is left is the hard
tail: «Dr. Sadeghi» (a pharmacy or a doctor's office?), «مرکز مشاوره پیوند مهر»
(counselling — a medical service?), «بگا» (nothing at all). Those are semantics, not
tokens.

Provider, base URL, model and key come from `/settings` (table `app_setting`, keys
`llm_provider` / `llm_base_url` / `llm_model` / `llm_api_key`), so nothing is stored in
this file or in the repo. An install that still has only the old `openrouter_api_key` /
`openrouter_model` rows keeps working.

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
# Defaults for the presets the settings page offers; `llm_base_url` always wins.
BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "9router": "https://9router.com/v1",
}
ROLES = [PHARMACY, DOCTOR, CLINIC, DENTIST, HOSPITAL, LAB, IRRELEVANT, UNKNOWN]
FLOOR = 0.85
# A row already sitting in the pharmacy table is weak evidence for «pharmacy»; a row in the
# medical table is weak evidence against it. Neither is proof, so both still need the model
# to be sure — the prior only decides what the model is shown, never what is applied.

SYSTEM = """You label places in Iran for a pharmacy site-selection tool.
Given a JSON array of places (i, name, address, table), return ONLY a JSON array, same order:
[{"i": <id>, "role": "<one of: pharmacy|doctor|clinic|dentist|hospital|lab|irrelevant|unknown>", "confidence": <0..1>}]

Rules:
- pharmacy: sells medicines to the public (داروخانه, pharmacy). Not عطاری (herbalist), not a medical-equipment shop.
- doctor: one practitioner's office (مطب, مطب دکتر, clinic of a single doctor).
- clinic: درمانگاه, کلینیک, مرکز درمانی, physiotherapy, counselling centre that is licensed medical.
- dentist: دندانپزشک/دندانپزشکی.  hospital: بیمارستان.  lab: آزمایشگاه, رادیولوژی, سونوگرافی, تصویربرداری, MRI.
- irrelevant: not a medical business at all — tire shop, supermarket, cosmetics, insurance office, equipment seller, factory, a street or an address with no business name.
- unknown: the name carries no usable signal and the address does not help.
Judge by meaning, not by a keyword: «کلینیک سوم خرداد بیمه تامین اجتماعی» is a clinic, «تجهیزات پزشکی آلا» is irrelevant.

Names are Persian, English, or transliterations. «Eczanesi»/«Eczane» is Turkish for pharmacy.
«Dr. X» with no other word is a person: a pharmacy only if the table is pharmacy and the town
has no better reading — otherwise doctor.

Calibration — do not return 0.8 for everything:
- 0.95: the name states the category (داروخانه …, درمانگاه …, بیمارستان …, آز …).
- 0.90: a strong, unambiguous form («دکتر X» in the pharmacy table, «مطب دکتر X»).
- 0.75-0.85: the name is a plausible business but the category is inferred.
- <=0.5: genuinely undecidable; say «unknown» rather than guess.
Output JSON only, no prose, no code fences."""


def setting(c: sqlite3.Connection, key: str) -> str | None:
    row = c.execute("SELECT value FROM app_setting WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def llm_conf(c: sqlite3.Connection) -> tuple[str, str | None, str | None]:
    """(base_url, key, model) from the settings panel, legacy OpenRouter rows last."""
    provider = setting(c, "llm_provider")
    if provider:
        base = setting(c, "llm_base_url") or BASE_URLS.get(provider, "")
        return base.rstrip("/"), setting(c, "llm_api_key"), setting(c, "llm_model")
    return (BASE_URLS["openrouter"], setting(c, "openrouter_api_key"),
            setting(c, "openrouter_model"))


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


def candidates(c: sqlite3.Connection, model: str, audit: bool = False) -> list[dict]:
    """Rows the rules cannot settle — or, with `audit`, every row: the rules were
    confidently wrong before («پنچر گیری» filed as a medical service), so their positive
    verdicts need checking too."""
    done = {(r[0], r[1]) for r in c.execute(
        "SELECT src, ref FROM poi_classification WHERE model = ?", (model,))}
    out: list[dict] = []
    for r in c.execute("SELECT osm_type || '/' || osm_id AS ref, name, street AS addr "
                       "FROM map_pharmacy"):
        if len((r["name"] or "").strip()) < 2:
            continue          # nothing to judge: an unnamed pin cannot be reasoned about
        if audit or classify(r["name"], (), r["addr"] or "")["role"] != PHARMACY:
            if ("map_pharmacy", r["ref"]) not in done:
                out.append({"src": "map_pharmacy", "ref": r["ref"], "name": r["name"] or "",
                            "addr": r["addr"] or ""})
    for r in c.execute("SELECT CAST(id AS TEXT) AS ref, name, address AS addr FROM map_medical"):
        if len((r["name"] or "").strip()) < 2:
            continue
        if audit or classify(r["name"], (), r["addr"] or "")["role"] not in MEDICAL_ROLES:
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


def payload(raw: str) -> dict:
    """One chat answer, whatever envelope the gateway sent.

    `stream: false` is sent below, but 9Router (and routers built on a streaming
    core) answer `text/event-stream` anyway: the body becomes `{…json…}\r\ndata:
    [DONE]`, or real SSE chunks. A bare `json.loads` fails on the trailer, which
    surfaced as «پاسخ دروازه JSON معتبر نبود» with a valid answer inside.
    """
    text = raw.strip()
    try:
        obj, _ = json.JSONDecoder().raw_decode(text)   # ignores a `data: [DONE]` trailer
        return obj
    except json.JSONDecodeError:
        pass
    full: dict | None = None
    content = ""
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            o = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        ch = (o.get("choices") or [{}])[0]
        if ch.get("message"):
            full = ch["message"]
        d = ch.get("delta") or {}
        if d.get("content"):
            content += d["content"]
    if full:
        return {"choices": [{"message": full}]}
    if content:
        return {"choices": [{"message": {"role": "assistant", "content": content}}]}
    raise ValueError("gateway answer was not a chat completion")


def ask(base: str, key: str, model: str, items: list[dict], timeout: int = 120) -> str:
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "stream": False,        # 9Router streams by default; an SSE body is not JSON
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps(
                [{"i": i, "name": it["name"], "address": it["addr"],
                  "table": "pharmacy" if it["src"] == "map_pharmacy" else "medical"}
                 for i, it in enumerate(items)], ensure_ascii=False)},
        ],
    }).encode()
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if "openrouter.ai" in base:      # OpenRouter attributes spend by these; other gateways reject them
        headers["HTTP-Referer"] = "https://github.com/MohammadHashemian/pharmacy-location-intelligence"
        headers["X-Title"] = "pharmacy-location-intelligence"
    req = urllib.request.Request(f"{base}/chat/completions", data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = payload(r.read().decode("utf-8", "replace"))
    return data["choices"][0]["message"]["content"]


def apply_rows(c: sqlite3.Connection, model: str) -> tuple[int, int, int]:
    """Move/delete what the model was sure about. Nothing else is touched.

    Counters are what the database actually changed — `cursor.rowcount`, not how many
    verdicts were considered. The first version reported «756 re-kinded» on every run
    because it incremented once per matching verdict, which made a no-op run look busy.
    """
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
                    cur = c.execute("""INSERT OR IGNORE INTO map_medical
                        (kind, name, lat, lon, nearest_area_id, nearest_km, county, address,
                         source, external_id) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                              (role, name, r[0], r[1], r[2], r[3], r[4], r[5], "llm", ref))
                    moved += max(0, cur.rowcount)
            cur = c.execute("DELETE FROM map_pharmacy WHERE osm_type || '/' || osm_id = ?", (ref,))
            dropped += max(0, cur.rowcount)
        else:
            if role in MEDICAL_ROLES:
                cur = c.execute("UPDATE map_medical SET kind = ? "
                                "WHERE CAST(id AS TEXT) = ? AND kind <> ?", (role, ref, role))
                fixed += max(0, cur.rowcount)
            elif role == PHARMACY:
                r = c.execute("SELECT name, lat, lon, nearest_area_id, nearest_km, county, address "
                              "FROM map_medical WHERE CAST(id AS TEXT) = ?", (ref,)).fetchone()
                if r:
                    cur = c.execute("""INSERT OR IGNORE INTO map_pharmacy
                        (osm_type, osm_id, name, lat, lon, nearest_area_id, nearest_km,
                         county, street, source, external_id)
                        VALUES ('poi', ?, ?, ?, ?, ?, ?, ?, ?, 'llm', ?)""",
                              (ref, r[0], r[1], r[2], r[3], r[4], r[5], r[6], ref))
                    moved += max(0, cur.rowcount)
                c.execute("DELETE FROM map_medical WHERE CAST(id AS TEXT) = ?", (ref,))
            elif role == IRRELEVANT:
                cur = c.execute("DELETE FROM map_medical WHERE CAST(id AS TEXT) = ?", (ref,))
                dropped += max(0, cur.rowcount)
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

    # gateway envelopes: plain JSON, a JSON body with an SSE trailer, real chunks
    plain = '{"choices":[{"message":{"role":"assistant","content":"سلام"}}]}'
    assert payload(plain)["choices"][0]["message"]["content"] == "سلام"
    hybrid = plain + "\r\ndata: [DONE]\r\n\r\n"
    assert payload(hybrid)["choices"][0]["message"]["content"] == "سلام"
    chunks = ('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
              'data: {"choices":[{"delta":{"content":"سلا"}}]}\n\n'
              'data: {"choices":[{"delta":{"content":"م"}}]}\n\n'
              'data: [DONE]\n')
    assert payload(chunks)["choices"][0]["message"]["content"] == "سلام"
    try:
        payload("I think this is a pharmacy.")
        raise AssertionError("should have raised")
    except ValueError:
        pass
    print("check: parser + prompt + gateway envelopes OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="call the configured gateway")
    ap.add_argument("--apply", action="store_true", help="move/delete after judging")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=25)
    ap.add_argument("--audit", action="store_true",
                    help="re-judge rows the rules already accepted, not just the residue")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        return check()

    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    ensure_table(c)
    base, key, model = llm_conf(c)

    if not args.run:
        todo = candidates(c, model or "—")
        print(f"{len(todo)} places need a verdict")
        for r in todo[:12]:
            print(f"  [{r['src'][4:]}] {r['name'][:44]:46s} {r['addr'][:40]}")
        print(f"\nprovider: {base or 'MISSING'} · key: {'saved' if key else 'MISSING'}"
              f" · model: {model or 'MISSING'}")
        print("set them in /settings, then: python etl/classify_with_llm.py --run --apply")
        return 0

    if not key or not model:
        print("missing provider/key/model in app_setting — set them in /settings")
        return 1

    todo = candidates(c, model, audit=args.audit)
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
            raw = ask(base, key, model, batch)
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
                       model, "v2"))   # v2: source table + calibration; purge v1 before a run
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
