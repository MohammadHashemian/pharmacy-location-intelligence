"""Give every map place a population, from Wikidata or the fa.wikipedia census.

The map carries a `population` tag on half its objects and, like every
crowd-sourced field, sometimes the wrong one. This step resolves an *independent*
figure per place and keeps both:

  * **Wikidata P1082** where the item has it (Wikidata in turn cites amar.org.ir);
  * **the census sentence** — «جمعیت آن ۱۶۵۷۵ نفر (۴۴۷۴ خانوار)» — read from the
    fa.wikipedia article of the item's own QID, never from a title search.

Nothing is overwritten and nothing is guessed: a place that cannot be matched
keeps NULL and a flag, and the reason is stored in `pop_match_method`.

Reuses etl/enrich_population.py's resolvers (bulk label lookup, fuzzy
EntitySearch, fact resolution, census parser) so the two layers agree on what a
match means — and so the shared on-disk caches do the heavy lifting.

Writes pop_wikidata / pop_wikipedia / pop_wikipedia_hh / pop_ref_* on geo_places.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich_population as ep  # noqa: E402
from load_geo import county_match_key, fold_name, haversine_km  # noqa: E402
from normalize import norm_key  # noqa: E402

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
CACHE = os.path.join(HOME, "data", "reference")
GEO_FACTS = os.path.join(CACHE, "geo_place_facts.json")
GEO_LABELS = os.path.join(CACHE, "geo_place_labels.json")
GEO_NAME_INDEX = os.path.join(CACHE, "geo_name_index.json")
GEO_CENSUS = os.path.join(CACHE, "geo_census_cache.json")

# Matching thresholds. A village name repeats inside a district constantly, so a
# name alone never decides: the coordinate separation and the admin chain must
# back it up.
MAX_SEPARATION_KM = 15.0     # map point vs Wikidata point
ADMIN_CONFIDENCE = 0.85
NAME_ONLY_CONFIDENCE = 0.60  # accepted only when the place carries its own QID


def load_json(path: str) -> dict:
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def save_json(path: str, data: dict) -> None:
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False)


def main() -> int:
    t0 = time.time()
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    places = [dict(r) for r in c.execute("""
        SELECT id, name, name_key, place_kind, lat, lon, county, county_key,
               wikidata, wikipedia, pop_osm, dq_flags
        FROM geo_places""")]
    print(f"map places to enrich: {len(places):,}")

    # ---- 1. which Wikidata items could be this place? -----------------------
    own = {p["id"]: p["wikidata"] for p in places if p.get("wikidata")}
    print(f"  places that carry their own QID: {len(own):,}")

    names = sorted({p["name_key"] for p in places if p["name_key"]})
    # Both resolvers hit Wikidata's rate limit hard (~0.4 s per batch and they are
    # not cached upstream), so the per-name result is kept on disk here. A re-run
    # then costs one pass over the 2,400 local names instead of ~35 batch queries.
    index = load_json(GEO_NAME_INDEX)

    def cached(fn, keys: list[str]) -> dict:
        missing = [k for k in keys if k not in index]
        if missing:
            print(f"  {fn.__name__}: {len(missing):,} new names")
            got = fn(missing)
            for k in missing:
                index[k] = got.get(k, [])
            save_json(GEO_NAME_INDEX, index)
        return {k: index.get(k, []) for k in keys}

    label_map = cached(ep.label_lookup, names)      # rdfs:label + skos:altLabel
    unresolved = sorted(p["name_key"] for p in places
                        if p["name_key"] and not label_map.get(p["name_key"]))
    print(f"  names with no bulk-label hit: {len(unresolved):,} -> EntitySearch")
    search_map = cached(ep.mwapi_search, unresolved) if unresolved else {}

    cands_by_name: dict[str, list[str]] = defaultdict(list)
    for nm in names:
        for q in label_map.get(nm, []) + search_map.get(nm, []):
            if q not in cands_by_name[nm]:
                cands_by_name[nm].append(q)
    pool = {q for v in cands_by_name.values() for q in v} | set(own.values())
    print(f"  candidate items: {len(pool):,}")

    # ---- 2. facts (cached: the FDA layer already fetched ~16k items) --------
    facts, adm_qids = ep.resolve_facts(sorted(pool))
    adm_labels = ep.resolve_adm_labels(adm_qids)
    bulk = {i["qid"]: i for i in json.load(open(ep.WD, encoding="utf-8"))}
    geo_labels = load_json(GEO_LABELS)
    todo_lbl = sorted(q for q in pool if q not in geo_labels)
    print(f"  labels to fetch: {len(todo_lbl):,}")
    for i in range(0, len(todo_lbl), ep.BATCH):
        chunk = todo_lbl[i:i + ep.BATCH]
        try:
            res = ep.sparql(ep.Q_LABELS % " ".join(f"wd:{q}" for q in chunk))
        except Exception:  # noqa: BLE001
            continue
        for b in res["results"]["bindings"]:
            q = b["p"]["value"].rsplit("/", 1)[-1]
            rec = geo_labels.setdefault(q, {"fa": None, "en": None})
            if b.get("faLabel"):
                rec["fa"] = b["faLabel"]["value"]
            if b.get("enLabel"):
                rec["en"] = b["enLabel"]["value"]
        save_json(GEO_LABELS, geo_labels)
        time.sleep(0.3)

    def item_name(q: str) -> list[str]:
        """Every spelling Wikidata offers for this item."""
        out = []
        for nm in (geo_labels.get(q, {}).get("fa"),
                   (bulk.get(q) or {}).get("name_fa"),
                   (bulk.get(q) or {}).get("name_en"),
                   geo_labels.get(q, {}).get("en")):
            if nm and nm not in out:
                out.append(nm)
        return out

    def item_population(q: str, f: dict):
        if f.get("population"):
            return int(f["population"])
        bp = (bulk.get(q) or {}).get("population")
        return int(bp) if bp else None

    # ---- 3. choose the best item per place ---------------------------------
    def accept(p: dict, q: str, item: dict):
        """-> (score, reason, separation_km) or None. A name alone never decides:
        it must be backed by the coordinate separation or the admin chain."""
        best = None
        for nm in item_name(q):
            k = norm_key(nm)
            if not k:
                continue
            fk, cf = fold_name(k), fold_name(p["name_key"])
            if k == p["name_key"]:
                score, why = 0.50, ["نام یکسان"]
            elif fk == cf:
                score, why = 0.45, ["نام یکسان پس از یکسان‌سازی حروف"]
            elif fk.startswith(cf) or cf.startswith(fk):
                score, why = 0.25, ["نام با پیشوند مشترک"]
            else:
                continue
            lat, lon = item.get("lat"), item.get("lon")
            sep_km = None
            if lat is not None and lon is not None:
                sep_km = haversine_km(p["lat"], p["lon"], lat, lon)
                if sep_km <= MAX_SEPARATION_KM:
                    score += 0.35
                    why.append(f"فاصله {sep_km:.1f} کیلومتر")
                elif sep_km <= 40:
                    why.append(f"فاصله {sep_km:.1f} کیلومتر")
                else:
                    continue      # a same-name place 100 km away is a different place
            if p.get("county"):
                ck = county_match_key(p["county"])
                adm_keys = set()
                for a in item.get("adm", []):
                    lbl = (adm_labels.get(a, {}).get("fa")
                           or adm_labels.get(a, {}).get("en") or "")
                    if lbl:
                        adm_keys.add(county_match_key(lbl))
                if ck and any(ck == k2 or ck in k2 or k2 in ck for k2 in adm_keys):
                    score += 0.20
                    why.append("شهرستان مطابق")
            if q == p.get("wikidata"):
                score += 0.30
                why.append("شناسهٔ خود مکان")
            if best is None or score > best[0]:
                # Capped: the bonuses are additive and four of them together
                # reached 1.35, which would have made "confidence" meaningless.
                best = (min(score, 1.0), "، ".join(why), sep_km)
        return best

    decisions = []
    for p in places:
        pool_ids = ([p["wikidata"]] if p.get("wikidata") else []) + \
                   cands_by_name.get(p["name_key"], [])
        best = None
        for q in dict.fromkeys(pool_ids):
            item = facts.get(q)
            if not item:
                continue
            got = accept(p, q, item)
            if not got:
                continue
            score, why, sep = got
            if best is None or score > best["score"]:
                best = {"qid": q, "score": score, "why": why, "sep": sep,
                        "pop": item_population(q, item), "fawiki": item.get("fawiki"),
                        "lat": item.get("lat"), "lon": item.get("lon")}
        decisions.append((p, best))

    accepted = [(p, b) for p, b in decisions if b and b["score"] >= ADMIN_CONFIDENCE]
    # A place carrying its own QID is its own evidence — but only when the item
    # actually has coordinates that agree, which the score already encodes.
    weak = [(p, b) for p, b in decisions
            if b and ADMIN_CONFIDENCE > b["score"] >= NAME_ONLY_CONFIDENCE
            and p.get("wikidata") == b["qid"]]
    none = [(p, b) for p, b in decisions if not b]
    print(f"  accepted: {len(accepted):,} | own-QID fallback: {len(weak):,} | "
          f"no match: {len(none):,}")

    # ---- 4. census sentence for the accepted items without a P1082 ---------
    titles = sorted({b["fawiki"] for _p, b in accepted + weak
                     if not b["pop"] and b.get("fawiki")})
    print(f"  fa.wikipedia articles to read: {len(titles):,}")
    # wiki_census() swallows a failed batch and moves on, so one burst of 429s
    # silently cost a third of the census coverage on the first run. Retry the
    # misses here and keep every parsed sentence, so a re-run is free and the
    # count only ever grows.
    census_cache = load_json(GEO_CENSUS)
    todo = [t for t in titles if t not in census_cache]
    for attempt in range(2):
        if not todo:
            break
        print(f"  census pass {attempt + 1}: {len(todo):,} articles")
        got = ep.wiki_census(todo)
        for k, v in got.items():
            census_cache[k] = list(v)
        save_json(GEO_CENSUS, census_cache)
        todo = [t for t in todo if t not in census_cache]
        if todo:
            time.sleep(2.0)
    # A second pass catches the batch that was rate-limited; the remainder
    # genuinely carry no census sentence, and remembering that stops every future
    # run from asking for them again.
    for t in todo:
        census_cache[t] = []
    save_json(GEO_CENSUS, census_cache)
    census = {t: tuple(census_cache[t]) for t in titles if census_cache.get(t)}
    print(f"  censuses parsed: {len(census):,} of {len(titles):,}")

    # ---- 5. write ----------------------------------------------------------
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    written = {"wikidata": 0, "wikipedia-census": 0, "unmatched": 0}
    for p, b in accepted + weak:
        pop_wd = int(b["pop"]) if b["pop"] else None
        pop_wk, hh, year_sh, url = None, None, None, None
        src = None
        if pop_wd:
            src = "wikidata"
            url = f"https://www.wikidata.org/wiki/{b['qid']}"
        else:
            w = census.get(b.get("fawiki") or "")
            if w and w[0]:
                pop_wk, _gy, year, hh = w[0], w[1], w[2], w[3]
                year_sh = year - 621 if year else None
                src = "wikipedia-census"
                url = ("https://fa.wikipedia.org/wiki/"
                       + (b.get("fawiki") or "").replace(" ", "_"))
        # Always name the source of the number that will be displayed. Without
        # this a place whose only figure is the map's own tag showed a population
        # with an empty "source" cell, which reads as if it had no provenance at
        # all — the tag is weak but it is not nothing, and it is now labelled as
        # exactly that.
        if not src:
            src = "osm-tag" if (p.get("pop_osm") or 0) > 0 else None
        flags = set((p.get("dq_flags") or "").split(", ")) - {""}
        # The outlier rule from the FDA layer, applied to the map's own numbers: a
        # village of 50k+ people in خوزستان does not exist.
        pop_best = pop_wd or pop_wk or p["pop_osm"] or 0
        if pop_best >= 50_000 and p["place_kind"] in ("village", "hamlet",
                                                      "isolated_dwelling",
                                                      "neighbourhood"):
            flags.add("pop_outlier")
        if pop_wd or pop_wk:
            written[src] += 1
        c.execute("""UPDATE geo_places SET
                       pop_wikidata = ?, pop_wikipedia = ?, pop_wikipedia_hh = ?,
                       pop_ref_year_sh = ?, pop_ref_source = COALESCE(?, pop_ref_source),
                       pop_ref_url = ?, pop_match_score = ?, pop_match_method = ?,
                       wd_lat = ?, wd_lon = ?, wd_separation_m = ?,
                       dq_flags = ?
                     WHERE id = ?""",
                  (pop_wd, pop_wk, hh, year_sh, src, url, round(b["score"], 3),
                   b["why"], b["lat"], b["lon"],
                   round(b["sep"] * 1000, 1) if b["sep"] is not None else None,
                   ", ".join(sorted(flags)) or None, p["id"]))
    for p, _b in none:
        written["unmatched"] += 1
    c.commit()

    print("\npopulations written:", written)
    for r in c.execute("""SELECT COALESCE(pop_ref_source,'(map tag only)') src, COUNT(*) n
                          FROM geo_places GROUP BY 1 ORDER BY n DESC"""):
        print(f"   {r['src']:<20} {r['n']:>5}")
    for r in c.execute("""SELECT COUNT(*) n FROM geo_places
                          WHERE pop_wikidata IS NOT NULL
                             OR pop_wikipedia IS NOT NULL"""):
        print(f"   places with a resolved external population: {r['n']:,}")
    for r in c.execute("""SELECT COUNT(*) n FROM geo_places
                          WHERE COALESCE(pop_wikidata, pop_wikipedia, pop_osm) IS NULL"""):
        print(f"   places still without any population: {r['n']:,}")
    for r in c.execute("""SELECT dq_flags, COUNT(*) n FROM geo_places
                          WHERE dq_flags LIKE '%pop_outlier%' GROUP BY 1"""):
        print(f"   outlier flags: {r['n']}")
    c.close()
    print(f"elapsed {time.time()-t0:,.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
