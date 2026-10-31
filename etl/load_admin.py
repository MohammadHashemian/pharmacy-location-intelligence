"""Load the Khuzestan administrative tree into SQLite, date-banded.

Inputs (all already on disk, so this runs offline):
    data/raw/wiki/counties.json      «تقسیمات کشوری» tables  -> county/bakhsh/dehestan/city + 1395 pop
    data/raw/wiki/cities.json        city articles           -> city identity
    data/raw/wiki/cities_list.json   فهرست شهرها              -> city | county | bakhsh | 1395 pop
    data/raw/wiki/villages.json      village infoboxes       -> village | دهستان | pop
    data/raw/wiki/khz_wikidata_settlements.json  Wikidata   -> coordinates, QID, fallback villages
    db/pharmacy.sqlite               `locations` (FDA) and `geo_places` (OSM) -> names + evidence

Output: the A1..A9 tables from schema_admin.sql. Existing tables are untouched.

Usage:
    python etl/load_admin.py --db db/pharmacy.sqlite --dry-run
    python etl/load_admin.py --db db/pharmacy.sqlite
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from normalize import norm_key, norm_text, to_int  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "data", "raw", "wiki")
PROVINCE = "استان خوزستان"
PROVINCE_KEY = "khuzestan"

# confidence of a population figure, per method -----------------------------
PREF = {
    "fa.wikipedia-county-table": 0.90,
    "fa.wikipedia-census-sentence": 0.88,
    "fa.wikipedia-infobox": 0.75,
    "wikidata": 0.60,
    "fda-feed": 0.45,
    "osm-tag": 0.35,
}
SOURCE_PRIORITY = ["fa.wikipedia-county-table", "fa.wikipedia-census-sentence",
                   "fa.wikipedia-infobox", "wikidata", "fda-feed", "osm-tag"]


# ---------------------------------------------------------------------------
# wikitext helpers
# ---------------------------------------------------------------------------
_REF = re.compile(r"<ref[^>]*>.*?</ref\s*>|<ref[^>]*/>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_LINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
_TPL = re.compile(r"\{\{[^{}]*\}\}")


def plain(text: str) -> str:
    """wikitext cell -> readable text (links unwrapped, refs/templates dropped)."""
    s = _COMMENT.sub("", text or "")
    s = _REF.sub("", s)
    s = re.sub(r"\{\{\s*(?:سخ|-|break)\s*\}\}", "، ", s)
    s = _TPL.sub("", s)
    s = re.sub(r"<br\s*/?>", "، ", s)
    s = _LINK.sub(lambda m: (m.group(2) or m.group(1)).strip(), s)
    s = re.sub(r"'''?|''", "", s)
    s = _TAG.sub("", s)
    s = s.replace("&nbsp;", " ").replace("\n", "، ")
    return norm_text(s)


def pop_int(text: str) -> tuple[int | None, int | None]:
    """'۱۱٬۹۳۸ نفر (۲٬۵۰۰ خانوار)' -> (11938, 2500)."""
    s = plain(text)
    nums = re.findall(r"[0-9][0-9,٬،\u066c]*", s)
    vals = [to_int(n) for n in nums]
    vals = [v for v in vals if v is not None]
    if not vals:
        return (None, None)
    pop = vals[0]
    households = vals[1] if len(vals) > 1 else None
    return (pop, households)


def year_sh(text: str) -> int | None:
    s = plain(text)
    for m in re.finditer(r"(1[34]\d\d)", s):
        return int(m.group(1))
    return None


def template_params(wikitext: str, name: str) -> dict[str, str]:
    """Extract the top-level ``|key=value`` pairs of {{name ...}}."""
    start = wikitext.find("{{" + name)
    if start == -1:
        return {}
    depth, i = 0, start
    while i < len(wikitext):
        if wikitext.startswith("{{", i):
            depth += 1
            i += 2
            continue
        if wikitext.startswith("}}", i):
            depth -= 1
            i += 2
            if depth == 0:
                break
            continue
        i += 1
    body = wikitext[start + 2:i - 2]
    params: dict[str, str] = {}
    for line in body.split("\n"):
        line = line.strip()
        if not line.startswith("|"):
            continue
        k, _, v = line[1:].partition("=")
        params[norm_key(k.strip())] = v.strip()
    return params


_ATTR = re.compile(r'^\s*(rowspan|colspan)\s*=\s*"?(\d+)"?\s*', re.I)


def table_grid(block: str) -> list[list[str]]:
    """Parse a wikitable into a rectangular grid, honouring rowspan/colspan."""
    rows: list[list[tuple[str, int, int]]] = []
    cur: list[tuple[str, int, int]] = []
    open_cell: list | None = None

    def flush_row():
        nonlocal cur
        if cur:
            rows.append(cur)
        cur = []

    for raw in block.splitlines():
        line = raw.rstrip()
        st = line.strip()
        if st.startswith("{|"):
            continue
        if st.startswith("|}"):
            flush_row()
            break
        if st.startswith("|-"):
            flush_row()
            open_cell = None
            continue
        if st.startswith("!") or st.startswith("|"):
            body = st[1:]
            for part in re.split(r"\|\||!!", body):
                part = part.strip()
                rs, cs = 1, 1
                while True:
                    m = _ATTR.match(part)
                    if not m:
                        break
                    n = int(m.group(2))
                    if m.group(1).lower() == "rowspan":
                        rs = n
                    else:
                        cs = n
                    part = part[m.end():].strip()
                    if part.startswith("|"):
                        part = part[1:].strip()
                cur.append((plain(part), rs, cs))
                open_cell = cur[-1]
            continue
        if open_cell is not None and st:
            open_cell = (open_cell[0] + "\n" + plain(st), open_cell[1], open_cell[2])
            cur[-1] = open_cell
    # expand spans
    grid: list[list[str]] = []
    pending: dict[int, tuple[str, int]] = {}
    for row in rows:
        out: list[str] = []
        col = 0
        for text, rs, cs in row:
            while col in pending:
                t, left = pending[col]
                out.append(t.replace("\n", "، "))
                if left <= 1:
                    del pending[col]
                else:
                    pending[col] = (t, left - 1)
                col += 1
            for k in range(cs):
                out.append(text.replace("\n", "، "))
                if rs > 1:
                    pending[col + k] = (text, rs - 1)
                col += 1
        while col in pending:
            t, left = pending[col]
            out.append(t.replace("\n", "، "))
            if left <= 1:
                del pending[col]
            else:
                pending[col] = (t, left - 1)
            col += 1
        grid.append(out)
    return grid


def tables_in(wikitext: str):
    """Yield every ``{| ... |}`` block (nested tables are rare in these pages)."""
    i = 0
    while True:
        s = wikitext.find("{|", i)
        if s == -1:
            return
        e = wikitext.find("|}", s)
        if e == -1:
            return
        yield wikitext[s:e + 2]
        i = e + 2


def county_table(wikitext: str) -> list[list[str]]:
    for block in tables_in(wikitext):
        grid = table_grid(block)
        head = " ".join(" ".join(r) for r in grid[:2])
        if "دهستان" in head and "بخش" in head:
            return grid
    return []


def short_unit(name: str) -> str:
    """'بخش مرکزی شهرستان اهواز' -> 'مرکزی' (the name the county table uses)."""
    s = norm_text(name or "")
    s = re.sub(r"^بخش\s+", "", s)
    s = re.sub(r"\s+شهرستان\s+.*$", "", s)
    return s.strip()


# The same county is spelled several ways by the four sources. Map the spelling
# onto the Wikipedia county article title, never onto a new county.
COUNTY_ALIASES = {
    "هفتگل": "هفتکل", "اغاجاری": "آغاجاری", "بندرماهشهر": "بندر ماهشهر",
    "مسجدسلیمان": "مسجدسلیمان", "دشت ازادگان": "دشت آزادگان",
    "باغ ملک": "باغملک", "باغملک": "باغملک", "ماهشهر": "بندر ماهشهر",
    "بندر ماهشهر": "بندر ماهشهر", "دزپارت": "دزپارت", "ابوالعباس": "ابوالعباس",
}
# Non-settlement places the pharmacy feed and the map both contain; they are
# excluded from the tree but never from their own layers.
JUNK_RE = re.compile(
    r"^(مجتمع|کارخانه|کارگاه|دانشگاه|بیمارستان|درمانگاه|پادگان|پاسگاه|فرودگاه|"
    r"ایستگاه|اداره|سازمان|شرکت|تعاونی|منازل|دبیرستان|مدرسه|مسجد|امامزاده|"
    r"گورستان|قبرستان|پمپ|ایستگاه)\s")

CITY_ALIASES = {"هفتگل": "هفتکل", "بندرماهشهر": "بندر ماهشهر"}

COUNTY_CANON: dict[str, str] = {}      # norm_key(short) -> «شهرستان X»


def canon_county(name: str) -> str | None:
    """Spelling of a county as the tree spells it, or None when it is not ours."""
    s = norm_text(name or "")
    s = re.sub(r"^استان\s+", "", s)
    s = re.sub(r"^شهرستان\s+", "", s)
    key = norm_key(COUNTY_ALIASES.get(norm_key(s), s))
    full = COUNTY_CANON.get(key)
    if full:
        return full
    return None


def canonical_name(kind: str, name: str) -> str:
    s = norm_text(name)
    if kind in ("city", "village"):
        # «ویس (شهر)» / «حمیدیه (خوزستان)» are article titles, not place names
        s = re.sub(r"\s*\([^)]*\)\s*$", "", s)
        # «بستان، خوزستان» — the province qualifier is not part of the name
        s = re.sub(r"\s*[،,]\s*(خوزستان|ایران)\s*$", "", s)
        return s.strip()
    if kind == "bakhsh":
        s = re.sub(r"^بخش\s+", "", s)
        s = re.sub(r"\s+شهرستان\s+.*$", "", s)
    elif kind == "dehestan":
        s = re.sub(r"^دهستان\s+", "", s)
    return s.strip()


def section(wikitext: str, title: str) -> str:
    m = re.search(r"^==\s*" + re.escape(title) + r"\s*==\s*$", wikitext, re.M)
    if not m:
        return ""
    rest = wikitext[m.end():]
    nxt = re.search(r"^==[^=]", rest, re.M)
    return rest[:nxt.start()] if nxt else rest


# ---------------------------------------------------------------------------
# tree building (in memory)
# ---------------------------------------------------------------------------
class Tree:
    def __init__(self):
        self.nodes: dict[str, dict] = {}
        self.order: list[str] = []

    def key(self, kind: str, name: str, parent_key: str) -> str:
        return hashlib.sha1(f"{kind}|{norm_key(name)}|{parent_key}".encode()).hexdigest()[:16]

    def ensure(self, kind: str, name: str, parent_key: str, *,
               source: str, ref: str, key: str | None = None, **extra) -> str:
        name = canonical_name(kind, name)
        if not name:
            return parent_key
        k = key or self.key(kind, name, parent_key)
        if k not in self.nodes:
            self.nodes[k] = {
                "area_key": k, "kind": kind, "name": name,
                "parent_key": parent_key or None,
                "sources": {source}, "refs": {ref} if ref else set(),
                "population": [], "links": [], "aliases": [],
                "lat": None, "lon": None, "wikidata": None, "wikipedia": None,
            }
            self.order.append(k)
        else:
            n = self.nodes[k]
            n["sources"].add(source)
            if ref:
                n["refs"].add(ref)
        node = self.nodes[k]
        for f, v in extra.items():
            if v not in (None, "") and node.get(f) in (None, ""):
                node[f] = v
        return k

    def add_pop(self, key: str, population, source: str, ref: str,
                method: str, year=None, households=None, confidence=None):
        # 0 in the FDA/OSM feeds means "not stated", not "no inhabitants"
        if population is None or population <= 0:
            return
        n = self.nodes[key]
        conf = confidence if confidence is not None else PREF.get(source, 0.5)
        for p in n["population"]:
            if p["source"] == source and p["year_sh"] == year:
                if p["population"] == population:
                    return
        n["population"].append({"population": population, "households": households,
                                "year_sh": year, "source": source, "source_ref": ref,
                                "method": method, "confidence": conf})

    def path(self, key: str) -> tuple[str | None, str | None, str | None]:
        node = self.nodes[key]
        county = bakhsh = dehestan = None
        cur, seen = key, set()
        while cur and cur not in seen:
            seen.add(cur)
            n = self.nodes[cur]
            if n["kind"] == "county":
                county = n["name"]
            elif n["kind"] == "bakhsh":
                bakhsh = n["name"]
            elif n["kind"] == "dehestan":
                dehestan = n["name"]
            cur = n["parent_key"]
        return county, bakhsh, dehestan

    def find_by(self, kind: str, name: str, county_key: str) -> str | None:
        want = norm_key(canonical_name(kind, name) if kind in ("bakhsh", "dehestan") else name)
        cname = norm_key(self.nodes[county_key]["name"])
        for k, n in self.nodes.items():
            if n["kind"] != kind or norm_key(n["name"]) != want:
                continue
            c, _b, _d = self.path(k)
            if c and norm_key(c) == cname:
                return k
        return None

    def merge_loose(self) -> int:
        """Collapse a place attached both to its دهستان and straight to the county.

        Wikidata often knows the village but not its دهستان, so the same place
        arrives twice: once under «دهستان غیزانیه», once under the county. Only
        the flat copy is folded in — a same-named place under *another* دهستان
        stays separate, because that is a real second village.
        """
        merged = 0
        for kind in ("city", "village"):
            groups: dict[tuple, list[str]] = {}
            for k, n in self.nodes.items():
                if n["kind"] != kind:
                    continue
                c = self.path(k)[0]
                groups.setdefault((norm_key(c or ""), norm_key(n["name"])), []).append(k)
            for keys in groups.values():
                if len(keys) < 2:
                    continue

                def depth(k: str) -> int:
                    d, cur = 0, k
                    while cur and self.nodes[cur]["parent_key"]:
                        cur = self.nodes[cur]["parent_key"]
                        d += 1
                    return d

                keys.sort(key=depth)
                keep = keys[0]
                for other in keys[1:]:
                    pk, kp = (self.nodes[other]["parent_key"],
                              self.nodes[keep]["parent_key"])
                    flat = (kind == "city" or pk == kp or
                            (pk and self.nodes[pk]["kind"] in ("county", "province")) or
                            (kp and self.nodes[kp]["kind"] in ("county", "province")))
                    if not flat:
                        continue
                    a, b = self.nodes[keep], self.nodes[other]
                    a["sources"] |= b["sources"]
                    a["refs"] |= b["refs"]
                    a["population"] += b["population"]
                    a["links"] += b["links"]
                    a["aliases"] += b["aliases"]
                    for f in ("lat", "lon", "wikidata", "wikipedia"):
                        if not a.get(f) and b.get(f):
                            a[f] = b[f]
                    del self.nodes[other]
                    merged += 1
        return merged

    def merge_same_population(self) -> int:
        """Two rows, identical population, one name a superset of the other.

        «مغیطیه» / «مغیطیه /فحستان /» and «دریسیه» / «دریسیه سفلی» are the same
        census figure written twice; «صگور» / «سیدعباس» also share a number but
        share no name, so they are left alone.
        """
        merged = 0
        groups: dict[tuple, list[str]] = {}
        for k, n in self.nodes.items():
            if n["kind"] != "village":
                continue
            pop = next((p["population"] for p in n["population"] if p["population"]), None)
            if not pop or pop < 100:
                continue
            groups.setdefault((norm_key(self.path(k)[0] or ""), pop), []).append(k)
        for keys in groups.values():
            if len(keys) < 2:
                continue
            keys.sort(key=lambda k: (len(re.sub(r"[^\w]", "", self.nodes[k]["name"])),
                                     -len(self.nodes[k]["sources"])))
            keep = keys[0]
            keep_name = re.sub(r"[^\w]", "", norm_key(self.nodes[keep]["name"]))
            if len(keep_name) < 5:
                continue
            for other in keys[1:]:
                other_name = re.sub(r"[^\w]", "", norm_key(self.nodes[other]["name"]))
                if other_name == keep_name or keep_name not in other_name:
                    continue
                a, b = self.nodes[keep], self.nodes[other]
                a["sources"] |= b["sources"]
                a["refs"] |= b["refs"]
                for p in b["population"]:
                    a["population"].append(dict(p))
                a["links"] += b["links"]
                a["aliases"] += b["aliases"] + [(b["name"], norm_key(b["name"]), "same-population")]
                for f in ("lat", "lon", "wikidata", "wikipedia"):
                    if not a.get(f) and b.get(f):
                        a[f] = b[f]
                for x in self.nodes.values():
                    if x["parent_key"] == other:
                        x["parent_key"] = keep
                del self.nodes[other]
                merged += 1
        return merged

    def merge_city_village(self) -> int:
        """A village article and a city article for the same place: keep the city."""
        merged = 0
        cities = {k: (norm_key(self.path(k)[0] or ""), norm_key(n["name"]))
                  for k, n in self.nodes.items() if n["kind"] == "city"}
        for k, (county, name) in list(cities.items()):
            for other, n in list(self.nodes.items()):
                if n["kind"] != "village" or norm_key(n["name"]) != name:
                    continue
                if norm_key(self.path(other)[0] or "") != county:
                    continue
                a, b = self.nodes[k], n
                a["sources"] |= b["sources"]
                a["refs"] |= b["refs"]
                a["population"] += b["population"]
                a["links"] += b["links"]
                a["aliases"] += b["aliases"]
                for f in ("lat", "lon", "wikidata", "wikipedia"):
                    if not a.get(f) and b.get(f):
                        a[f] = b[f]
                for x in self.nodes.values():
                    if x["parent_key"] == other:
                        x["parent_key"] = k
                del self.nodes[other]
                merged += 1
        return merged

    def merge_fuzzy(self) -> int:
        """Same place, two spellings («اب بید» / «اببید»): fold the loser in.

        Only exact *despaced* equality counts, and only when the two rows hang
        off the same دهستان or one of them hangs off the county directly — a
        same-named village under two different دهستان‌ها stays separate.
        """
        merged = 0
        groups: dict[tuple, list[str]] = {}
        for k, n in self.nodes.items():
            if n["kind"] not in ("city", "village"):
                continue
            c = self.path(k)[0]
            groups.setdefault((norm_key(c or ""), re.sub(r"[^\w]", "", norm_key(n["name"]))),
                              []).append(k)
        for keys in groups.values():
            if len(keys) < 2:
                continue
            keys.sort(key=lambda k: (-len(self.nodes[k]["population"]),
                                     self.nodes[k]["kind"] != "city"))
            keep = keys[0]
            for other in keys[1:]:
                pk, kp = self.nodes[other]["parent_key"], self.nodes[keep]["parent_key"]
                flat = (pk == kp or
                        (pk and self.nodes[pk]["kind"] in ("county", "province")) or
                        (kp and self.nodes[kp]["kind"] in ("county", "province")))
                if not flat:
                    continue
                a, b = self.nodes[keep], self.nodes[other]
                b["aliases"].append((b["name"], norm_key(b["name"]), "spelling"))
                a["sources"] |= b["sources"]
                a["refs"] |= b["refs"]
                a["population"] += b["population"]
                a["links"] += b["links"]
                a["aliases"] += b["aliases"]
                for f in ("lat", "lon", "wikidata", "wikipedia"):
                    if not a.get(f) and b.get(f):
                        a[f] = b[f]
                for n in self.nodes.values():
                    if n["parent_key"] == other:
                        n["parent_key"] = keep
                del self.nodes[other]
                merged += 1
        return merged

    def merge_duplicates(self) -> int:
        """Same (parent, name, kind) reached by two sources -> one node."""
        groups: dict[tuple, list[str]] = {}
        for k, n in self.nodes.items():
            groups.setdefault((n["parent_key"], norm_key(n["name"]), n["kind"]), []).append(k)
        merged = 0
        for keys in groups.values():
            if len(keys) < 2:
                continue
            keys.sort(key=lambda k: min(
                (SOURCE_PRIORITY.index(s) for s in self.nodes[k]["sources"]
                 if s in SOURCE_PRIORITY), default=99))
            keep = keys[0]
            for other in keys[1:]:
                a, b = self.nodes[keep], self.nodes[other]
                b["parent_key"] = a["area_key"]  # placeholder, remapped below
                a["sources"] |= b["sources"]
                a["refs"] |= b["refs"]
                a["population"] += b["population"]
                a["links"] += b["links"]
                a["aliases"] += b["aliases"]
                for f in ("lat", "lon", "wikidata", "wikipedia"):
                    if not a.get(f) and b.get(f):
                        a[f] = b[f]
                # children of the loser move under the survivor
                for n in self.nodes.values():
                    if n["parent_key"] == other:
                        n["parent_key"] = keep
                del self.nodes[other]
                merged += 1
        return merged


# ---------------------------------------------------------------------------
# source parsers
# ---------------------------------------------------------------------------
COUNTY_TABLE_HEADERS = ["بخش", "مرکز بخش", "جمعیت بخش", "دهستان", "مرکز دهستان",
                        "جمعیت دهستان", "شهر", "جمعیت شهر"]


def parse_counties(tree: Tree, payload: dict) -> dict:
    stats = {"tables": 0, "rows": 0, "cities": 0, "counties": 0}
    for title, wikitext in payload["pages"].items():
        county = norm_text(title)
        if not county.startswith("شهرستان"):
            continue
        stats["counties"] += 1
        county_key = tree.ensure("county", county, "khuzestan",
                                 source="fa.wikipedia", ref=title)
        box = template_params(wikitext, "جعبه شهرستان ایران")
        cpop, _chh = pop_int(box.get("جمعیت", ""))
        if cpop:
            tree.add_pop(county_key, cpop, "fa.wikipedia-infobox", title, "infobox",
                         year_sh(box.get("جمعیت", "")), None, 0.70)
        grid = county_table(wikitext)
        if not grid:
            # no table: still create the county so its villages have a root
            continue
        header_at = next((i for i, r in enumerate(grid)
                          if r and norm_key(r[0]) == norm_key("بخش")), None)
        if header_at is None:
            continue
        stats["tables"] += 1
        bakhsh_key = None
        for row in grid[header_at + 1:]:
            row = (row + [""] * 8)[:8]
            bakhsh, _bcenter, bpop, dehestan, _dcenter, dpop, city, cpop = row
            if bakhsh and "*" not in bakhsh:
                bakhsh_key = tree.ensure("bakhsh", bakhsh, county_key,
                                        source="fa.wikipedia-county-table", ref=title)
                p, _ = pop_int(bpop)
                tree.add_pop(bakhsh_key, p, "fa.wikipedia-county-table", title, "table", 1395)
            if dehestan and "*" not in dehestan and bakhsh_key:
                dkey = tree.ensure("dehestan", dehestan, bakhsh_key,
                                   source="fa.wikipedia-county-table", ref=title)
                p, hh = pop_int(dpop)
                tree.add_pop(dkey, p, "fa.wikipedia-county-table", title, "table", 1395, hh)
            if city and "*" not in city:
                names = [x.strip() for x in re.split(r"[،؛]", city) if x.strip()]
                pops = [pop_int(x)[0] for x in re.split(r"[،؛]", cpop)]
                for i, nm in enumerate(names):
                    if len(nm) > 28 or len(nm.split()) > 3:
                        continue
                    ckey = tree.ensure("city", nm, bakhsh_key or county_key,
                                       source="fa.wikipedia-county-table", ref=title)
                    p = pops[i] if i < len(pops) else None
                    tree.add_pop(ckey, p, "fa.wikipedia-county-table", title, "table", 1395)
                    stats["cities"] += 1
            stats["rows"] += 1
    return stats


def parse_cities_list(tree: Tree, payload: dict) -> dict:
    stats = {"rows": 0, "skipped": 0}
    known = {norm_key(n["name"]) for n in tree.nodes.values() if n["kind"] == "county"}
    for _title, wikitext in payload["pages"].items():
        grid = []
        for block in tables_in(wikitext):
            g = table_grid(block)
            head = " ".join(" ".join(r) for r in g[:2])
            if "شهرستان" in head and "جمعیت" in head and "شهر" in head:
                grid = g
                break
        header_at = next((i for i, r in enumerate(grid)
                          if r and "شهر" in r and "شهرستان" in " ".join(r)), None)
        if header_at is None:
            continue
        for row in grid[header_at + 1:]:
            if len(row) < 5:
                continue
            _rank, city, county, bakhsh, pop = row[:5]
            if (not city or not county or city.startswith("شهرستان")
                    or len(city) > 28 or len(city.split()) > 3):
                stats["skipped"] += 1
                continue
            if norm_key(county) not in known:
                stats["skipped"] += 1   # typo'd county (e.g. «دست آزادگان»)
                continue
            county_key = tree.key("county", "شهرستان " + county, "khuzestan")
            parent = county_key
            if bakhsh and bakhsh not in ("*", "***", "********"):
                parent = tree.ensure("bakhsh", bakhsh, county_key,
                                     source="fa.wikipedia", ref="فهرست شهرهای استان خوزستان")
            ckey = tree.ensure("city", city, parent, source="fa.wikipedia",
                               ref="فهرست شهرهای استان خوزستان")
            p, _ = pop_int(pop)
            tree.add_pop(ckey, p, "fa.wikipedia-county-table",
                         "فهرست شهرهای استان خوزستان", "table", 1395)
            stats["rows"] += 1
    return stats


CITY_TPLS = ("جعبه اطلاعات شهر ایران", "جعبه شهر ایران")


def parse_cities(tree: Tree, payload: dict) -> dict:
    """City articles — the only source of city status for counties whose
    «تقسیمات کشوری» table is missing (آغاجاری, ابوالعباس, ...)."""
    stats = {"pages": 0, "cities": 0}
    for title, wikitext in payload["pages"].items():
        params = {}
        for tpl in CITY_TPLS:
            params = template_params(wikitext, tpl)
            if params:
                break
        if not params:
            continue
        name = plain(params.get("نامرسمی") or params.get("نام") or "")
        county = canon_county(plain(params.get("شهرستان") or ""))
        if not name or not county:
            continue
        stats["pages"] += 1
        ckey = tree.ensure("county", county, "khuzestan", source="fa.wikipedia", ref=title)
        bakhsh = short_unit(plain(params.get("بخش") or ""))
        bkey = (tree.ensure("bakhsh", bakhsh, ckey, source="fa.wikipedia", ref=title)
                if bakhsh else ckey)
        ckey_area = tree.find_by("city", name, ckey)
        if not ckey_area:
            ckey_area = tree.ensure("city", name, bkey, source="fa.wikipedia", ref=title)
            stats["cities"] += 1
        raw = params.get("جمعیت", "")
        p, _ = pop_int(raw)
        if p:
            tree.add_pop(ckey_area, p, "fa.wikipedia-census-sentence", title,
                         "infobox", year_sh(raw), None, 0.80)
    return stats


_VILLAGE_TPL = "جعبه اطلاعات روستای ایران"


def parse_villages(tree: Tree, payload: dict) -> dict:
    stats = {"pages": 0, "with_pop": 0}
    for title, wikitext in payload["pages"].items():
        params = template_params(wikitext, _VILLAGE_TPL)
        if not params:
            stats["pages"] += 1
            continue
        name = plain(params.get("نام رسمی") or params.get("نام") or title)
        county = plain(params.get("شهرستان") or "")
        bakhsh = plain(params.get("بخش") or "")
        dehestan = plain(params.get("دهستان") or "")
        if not name or not county:
            continue
        if bakhsh.startswith("دهستان"):
            # a few articles put the دهستان in the بخش field; swap instead of
            # inventing a بخش with that name.
            dehestan = dehestan or bakhsh[len("دهستان"):].strip()
            bakhsh = ""
        stats["pages"] += 1
        county_full = canon_county(county)
        if not county_full:
            stats.setdefault("unknown_county", 0)
            stats["unknown_county"] += 1
            continue
        ckey = tree.ensure("county", county_full, "khuzestan",
                           source="fa.wikipedia", ref=title)
        bkey = tree.ensure("bakhsh", bakhsh, ckey, source="fa.wikipedia", ref=title) if bakhsh else ckey
        dkey = tree.ensure("dehestan", dehestan, bkey, source="fa.wikipedia", ref=title) if dehestan else bkey
        vkey = tree.ensure("village", name, dkey, source="fa.wikipedia", ref=title)
        tree.add_pop(vkey, None, "fa.wikipedia", title, "infobox")

        # population: prefer the census sentence (it states the year), fall
        # back to the infobox value only when the article has no sentence.
        sec = section(wikitext, "جمعیت")
        body = sec or wikitext
        m = re.search(r"جمعیت[^.]{0,40}?([0-9۰-۹][0-9۰-۹,،٬\u066c]*)\s*نفر", plain(body))
        hh = re.search(r"\(([0-9۰-۹][0-9۰-۹,،٬\u066c]*)\s*خانوار\)", plain(body))
        y = year_sh(body)
        p_sentence = to_int(m.group(1)) if m else None
        hh_sentence = to_int(hh.group(1)) if hh else None
        p_box, hh_box = pop_int(params.get("جمعیت", ""))
        if p_sentence and p_sentence > 60_000:
            p_sentence = None          # a village that size is a parsing accident
        if p_sentence:
            tree.add_pop(vkey, p_sentence, "fa.wikipedia-census-sentence", title,
                        "census-sentence", y, hh_sentence, 0.88)
            stats["with_pop"] += 1
        elif p_box and p_box <= 60_000:
            tree.add_pop(vkey, p_box, "fa.wikipedia-infobox", title,
                         "infobox", y, hh_box, 0.75)
            stats["with_pop"] += 1
        code = plain(params.get("کد آماری") or "")
        if code:
            tree.nodes[vkey].setdefault("aliases", []).append(
                (f"code:{code}", code, "fa.wikipedia"))
    return stats


# Wikidata class labels we accept as settlements, and the kind to use ---------
WIKIDATA_KINDS = {"روستا": "village", "یک شهر ایران": "city",
                  "سکونتگاه انسانی": "village", "شهر": "city"}


def parse_wikidata(tree: Tree, rows: list[dict]) -> dict:
    stats = {"items": 0, "villages": 0, "matched": 0, "county_resolved": 0}
    by = {}
    for r in rows:
        qid = r["x"]["value"].rsplit("/", 1)[-1]
        d = by.setdefault(qid, {"qid": qid, "label": None, "types": set(),
                                "parents": {}, "pop": set(), "coord": None,
                                "article": None})
        d["label"] = r.get("xLabel", {}).get("value") or d["label"]
        if "typeLabel" in r:
            d["types"].add(r["typeLabel"]["value"])
        if "parentLabel" in r:
            d["parents"][r["parent"]["value"].rsplit("/", 1)[-1]] = r["parentLabel"]["value"]
        if "pop" in r:
            d["pop"].add(to_int(r["pop"]["value"]))
        if "coord" in r and not d["coord"]:
            m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", r["coord"]["value"])
            if m:
                d["coord"] = (float(m.group(2)), float(m.group(1)))
        if "article" in r:
            d["article"] = r["article"]["value"]
    stats["items"] = len(by)

    # county name_key -> area_key (the tree is the authority on spelling)
    county_by_name = {norm_key(n["name"]): k for k, n in tree.nodes.items()
                      if n["kind"] == "county"}
    county_name = {k: norm_key(n["name"]) for k, n in tree.nodes.items()
                   if n["kind"] == "county"}

    def resolve_county(qid: str, seen: set[str]) -> str | None:
        if qid in seen:
            return None
        seen.add(qid)
        d = by.get(qid)
        if not d:
            return None
        for plabel in d["parents"].values():
            ck = county_by_name.get(norm_key(plabel))
            if ck:
                return ck
        for pid in d["parents"]:
            ck = resolve_county(pid, seen)
            if ck:
                return ck
        return None

    index = {}
    for k, n in tree.nodes.items():
        if n["kind"] in ("city", "village"):
            c, _b, _d = tree.path(k)
            index.setdefault((norm_key(c or ""), norm_key(n["name"]), n["kind"]), k)

    # ---- pass 1: the administrative nodes Wikidata knows about --------------
    # (the county table is missing on several articles, so بخش/دهستان from
    # Wikidata keeps those villages from being attached straight to the county)
    admin: dict[str, str] = {}
    for qid, d in by.items():
        if "شهرستانهای ایران" in d["types"] and d["label"]:
            ck = county_by_name.get(norm_key(d["label"]))
            if ck:
                admin[qid] = ck
    for qid, d in list(by.items()):
        if "بخش" not in d["types"] or not d["label"]:
            continue
        parent = next((admin[p] for p in d["parents"] if p in admin), None)
        county = resolve_county(qid, set())
        if not parent:
            parent = county
        if parent:
            existing = tree.find_by("bakhsh", d["label"], county) if county else None
            admin[qid] = existing or tree.ensure("bakhsh", d["label"], parent,
                                                 source="wikidata", ref=qid)
    for qid, d in list(by.items()):
        if "دهستان" not in d["types"] or not d["label"]:
            continue
        parent = next((admin[p] for p in d["parents"] if p in admin), None)
        county = resolve_county(qid, set())
        if not parent:
            parent = county
        if parent:
            existing = tree.find_by("dehestan", d["label"], county) if county else None
            admin[qid] = existing or tree.ensure("dehestan", d["label"], parent,
                                                 source="wikidata", ref=qid)

    for qid, d in by.items():
        kind = next((WIKIDATA_KINDS[t] for t in d["types"] if t in WIKIDATA_KINDS), None)
        if not kind or not d["label"]:
            continue
        county_key = resolve_county(qid, set())
        if not county_key:
            continue
        stats["county_resolved"] += 1
        target_kind = "village" if kind == "village" else "city"
        hit = index.get((county_name[county_key], norm_key(d["label"]), target_kind))
        if hit:
            stats["matched"] += 1
            node = tree.nodes[hit]
            node["wikidata"] = node["wikidata"] or d["qid"]
            if d["coord"]:
                node["lat"] = node["lat"] or d["coord"][0]
                node["lon"] = node["lon"] or d["coord"][1]
            if d["article"]:
                node["wikipedia"] = node["wikipedia"] or d["article"]
            for p in d["pop"]:
                tree.add_pop(hit, p, "wikidata", d["qid"], "P1082", None, None, 0.60)
            continue
        parent = next((admin[p] for p in d["parents"] if p in admin), None) or county_key
        # Wikidata's «شهر» class is not evidence enough to call a place a city:
        # the list article and the county tables own that distinction.
        vkey = tree.ensure("village", d["label"], parent, source="wikidata", ref=d["qid"])
        stats["villages"] += 1
        index[(county_name[county_key], norm_key(d["label"]), "village")] = vkey
        n = tree.nodes[vkey]
        n["wikidata"] = d["qid"]
        n["wikipedia"] = d["article"]
        if d["coord"]:
            n["lat"], n["lon"] = d["coord"]
        for p in d["pop"]:
            tree.add_pop(vkey, p, "wikidata", d["qid"], "P1082", None, None, 0.60)
    return stats


def drop_county_copies(tree: Tree) -> int:
    """A city whose population equals its whole county's is a copy error.

    Several county articles repeat the county figure on the city row (دزفول
    638,551 was the county, not the city). The other sources' figures stay, so
    the city keeps a population only when one survived.
    """
    dropped = 0
    county_pops: dict[str, set[int]] = {}
    for k, n in tree.nodes.items():
        if n["kind"] == "county":
            county_pops[k] = {p["population"] for p in n["population"]}
    for k, n in tree.nodes.items():
        if n["kind"] != "city":
            continue
        c = tree.path(k)[0]
        ck = next((x for x in county_pops if norm_key(tree.nodes[x]["name"]) == norm_key(c or "")), None)
        if not ck:
            continue
        keep = [p for p in n["population"] if p["population"] not in county_pops[ck]]
        dropped += len(n["population"]) - len(keep)
        n["population"] = keep
    return dropped


def parse_existing(conn: sqlite3.Connection, tree: Tree, layer: str) -> dict:
    """FDA `locations` and OSM `geo_places`: names + populations, as evidence."""
    stats = {"rows": 0, "matched": 0, "created": 0}
    idx: dict[tuple[str, str], list[str]] = {}
    fidx: dict[tuple[str, str], list[str]] = {}
    glob: dict[str, list[str]] = {}
    for k, n in tree.nodes.items():
        if n["kind"] in ("city", "village"):
            c, _b, _d = tree.path(k)
            idx.setdefault((norm_key(c or ""), norm_key(n["name"])), []).append(k)
            fidx.setdefault((norm_key(c or ""),
                             re.sub(r"[^\w]", "", norm_key(n["name"]))), []).append(k)
            glob.setdefault(re.sub(r"[^\w]", "", norm_key(n["name"])), []).append(k)
    county_nodes = {norm_key(n["name"]): k for k, n in tree.nodes.items()
                    if n["kind"] == "county"}
    bakhsh_nodes = {(norm_key(tree.nodes[n["parent_key"]]["name"]) if n["parent_key"] else "",
                     norm_key(n["name"])): k
                    for k, n in tree.nodes.items() if n["kind"] == "bakhsh"}
    if layer == "fda":
        rows = conn.execute("""
            SELECT l.id, l.county, l.district, l.place, l.place_kind,
                   (SELECT s.population FROM location_snapshots s
                     WHERE s.location_id = l.id
                     ORDER BY s.observed_at DESC LIMIT 1) AS population
            FROM locations l WHERE l.province_key LIKE '%خوزستان%'
        """).fetchall()
        for rid, county, district, place, kind, pop in rows:
            stats["rows"] += 1
            name = norm_text(re.sub(r"^(شهر|شهرک|روستای|روستا|آبادی)\s+", "", place or ""))
            if not name or JUNK_RE.search(name):
                continue
            ck = county_nodes.get(norm_key(canon_county(county) or ""))
            if not ck:
                continue
            ckey_norm = norm_key(tree.nodes[ck]["name"])
            fname = re.sub(r"[^\w]", "", norm_key(CITY_ALIASES.get(name, name)))
            hit = (idx.get((ckey_norm, norm_key(name)))
                   or fidx.get((ckey_norm, fname))
                   or ([glob[fname][0]] if len(glob.get(fname, [])) == 1 else [])
                   or [None])[0]
            if not hit:
                parent = bakhsh_nodes.get((norm_key(county or ""), norm_key(short_unit(district)))) or ck
                hit = tree.ensure("village", name, parent,
                                  source="fda-feed", ref=f"locations#{rid}")
                stats["created"] += 1
            else:
                stats["matched"] += 1
            tree.nodes[hit]["links"].append(("fda", rid, 0.8, "name+county"))
            tree.nodes[hit]["aliases"].append((place, norm_key(place), "fda"))
            if pop:
                tree.add_pop(hit, int(pop), "fda-feed", f"locations#{rid}", "reported", None, None, 0.45)
    else:
        rows = conn.execute("""
            SELECT id, name, place_kind, county, district, pop_osm, pop_wikipedia,
                   pop_ref_year_sh, lat, lon
            FROM geo_places WHERE province LIKE '%خوزستان%'
        """).fetchall()
        for rid, name, kind, county, district, p_osm, p_wiki, yr, lat, lon in rows:
            stats["rows"] += 1
            if kind not in ("city", "town", "village", "hamlet", "isolated_dwelling"):
                continue
            if not name or JUNK_RE.search(name):
                continue
            ck = county_nodes.get(norm_key(canon_county(county) or ""))
            if not ck:
                continue
            ckey_norm = norm_key(tree.nodes[ck]["name"])
            fname = re.sub(r"[^\w]", "", norm_key(CITY_ALIASES.get(name, name)))
            hit = (idx.get((ckey_norm, norm_key(name)))
                   or fidx.get((ckey_norm, fname))
                   or ([glob[fname][0]] if len(glob.get(fname, [])) == 1 else [])
                   or [None])[0]
            if not hit:
                parent = bakhsh_nodes.get((norm_key(county or ""), norm_key(short_unit(district)))) or ck
                hit = tree.ensure("village",
                                  name, parent, source="osm", ref=f"geo_places#{rid}")
                stats["created"] += 1
            else:
                stats["matched"] += 1
            node = tree.nodes[hit]
            node["links"].append(("osm", rid, 0.7, "name+county"))
            node["aliases"].append((name, norm_key(name), "osm"))
            node["lat"] = node["lat"] or lat
            node["lon"] = node["lon"] or lon
            tree.add_pop(hit, p_wiki, "osm-tag", f"geo_places#{rid}", "wikipedia-census", yr, None, 0.5)
            tree.add_pop(hit, p_osm, "osm-tag", f"geo_places#{rid}", "osm-tag", None, None, 0.35)
    return stats


# ---------------------------------------------------------------------------
# persistence (date-banded)
# ---------------------------------------------------------------------------
def head_version(conn, area_id):
    return conn.execute("""
        SELECT id, kind, name, parent_area_id, county, bakhsh, dehestan
        FROM admin_area_version WHERE area_id=? AND valid_to IS NULL
        ORDER BY id DESC LIMIT 1""", (area_id,)).fetchone()


def load(conn: sqlite3.Connection, tree: Tree, now: str,
         label: str, observed: str, sources: list[dict], notes: str = "") -> dict:
    conn.execute("PRAGMA foreign_keys = ON")
    counts = {k: sum(1 for n in tree.nodes.values() if n["kind"] == k)
              for k in ("county", "bakhsh", "dehestan", "city", "village")}
    cur = conn.execute("""
        INSERT INTO admin_import (label, scope, observed_at, imported_at, sources,
              n_province, n_county, n_bakhsh, n_dehestan, n_city, n_village, notes)
        VALUES (?,?,?,?,?,1,?,?,?,?,?,?)""",
        (label, PROVINCE, observed, now, json.dumps(sources, ensure_ascii=False),
         counts["county"], counts["bakhsh"], counts["dehestan"], counts["city"],
         counts["village"], notes))
    import_id = cur.lastrowid

    existing = {r[0]: r[1] for r in conn.execute("SELECT area_key, id FROM admin_area")}
    id_of: dict[str, int] = dict(existing)
    head: dict[str, tuple] = {}
    for key, aid in existing.items():
        hv = head_version(conn, aid)
        if hv:
            head[key] = hv

    added = changed = 0
    # parents first: order was built top-down already
    for key in tree.order:
        if key not in tree.nodes:
            continue
        n = tree.nodes[key]
        parent_id = id_of.get(n["parent_key"]) if n["parent_key"] else None
        county, bakhsh, dehestan = tree.path(key)
        state = (n["kind"], n["name"], parent_id, county, bakhsh, dehestan)
        if key in id_of:
            aid = id_of[key]
            prev = head.get(key)
            if prev and tuple(prev[1:]) == tuple(state):
                conn.execute("UPDATE admin_area SET last_import_id=?, last_seen_at=? WHERE id=?",
                             (import_id, now, aid))
            else:
                if prev:
                    conn.execute("UPDATE admin_area_version SET valid_to=? WHERE id=?",
                                 (now, prev[0]))
                conn.execute("""
                    INSERT INTO admin_area_version (area_id, import_id, valid_from, kind, name,
                        parent_area_id, county, bakhsh, dehestan, source, source_ref)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (aid, import_id, now, *state, ",".join(sorted(n["sources"])),
                     ",".join(sorted(n["refs"]))[:400]))
                conn.execute("""UPDATE admin_area SET parent_area_id=?, county=?, bakhsh=?,
                    dehestan=?, latitude=COALESCE(?,latitude), longitude=COALESCE(?,longitude),
                    wikidata=COALESCE(?,wikidata), wikipedia=COALESCE(?,wikipedia),
                    last_import_id=?, last_seen_at=? WHERE id=?""",
                    (parent_id, county, bakhsh, dehestan, n["lat"], n["lon"],
                     n["wikidata"], n["wikipedia"], import_id, now, aid))
                changed += 1
        else:
            cur2 = conn.execute("""
                INSERT INTO admin_area (area_key, kind, name, name_key, parent_area_id,
                    latitude, longitude, wikidata, wikipedia, county, bakhsh, dehestan,
                    first_import_id, last_import_id, first_seen_at, last_seen_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (key, n["kind"], n["name"], norm_key(n["name"]), parent_id,
                 n["lat"], n["lon"], n["wikidata"], n["wikipedia"],
                 county, bakhsh, dehestan, import_id, import_id, now, now))
            aid = cur2.lastrowid
            id_of[key] = aid
            conn.execute("""
                INSERT INTO admin_area_version (area_id, import_id, valid_from, kind, name,
                    parent_area_id, county, bakhsh, dehestan, source, source_ref)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (aid, import_id, now, *state, ",".join(sorted(n["sources"])),
                 ",".join(sorted(n["refs"]))[:400]))
            added += 1

        for p in n["population"]:
            prev = conn.execute("""
                SELECT id, population FROM admin_population
                WHERE area_id=? AND source=? AND IFNULL(year_sh,-1)=IFNULL(?,-1)
                  AND valid_to IS NULL ORDER BY id DESC LIMIT 1""",
                (aid, p["source"], p["year_sh"])).fetchone()
            if prev and prev[1] == p["population"]:
                conn.execute("UPDATE admin_population SET observed_at=? WHERE id=?",
                             (now, prev[0]))
            else:
                if prev:
                    conn.execute("UPDATE admin_population SET valid_to=? WHERE id=?",
                                 (now, prev[0]))
                conn.execute("""
                    INSERT INTO admin_population (area_id, import_id, population, households,
                        year_sh, source, source_ref, method, confidence, valid_from, observed_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (aid, import_id, p["population"], p["households"], p["year_sh"],
                     p["source"], p["source_ref"], p["method"], p["confidence"], now, now))

        for layer, rid, score, method in n["links"]:
            conn.execute("""INSERT OR IGNORE INTO admin_area_link
                (area_id, layer, ref_id, score, method, decided_at) VALUES (?,?,?,?,?,?)""",
                (aid, layer, rid, score, method, now))
        for alias, akey, src in n["aliases"][:8]:
            conn.execute("""INSERT OR IGNORE INTO admin_area_alias
                (area_id, alias, alias_key, source) VALUES (?,?,?,?)""",
                (aid, alias, akey, src))

    # close areas that disappeared from the snapshot (never delete: history stays)
    open_keys = set(tree.nodes)
    for key, aid in existing.items():
        if key in open_keys or key not in head:
            continue
        conn.execute("UPDATE admin_area_version SET valid_to=? WHERE id=?",
                     (now, head[key][0]))

    conn.execute("""UPDATE admin_import SET n_added=?, n_changed=? WHERE id=?""",
                 (added, changed, import_id))
    return {"import_id": import_id, "added": added, "changed": changed, **counts}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "db", "pharmacy.sqlite"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    missing = [f for f in ("counties.json", "cities.json", "villages.json",
                           "cities_list.json", "khz_wikidata_settlements.json")
               if not os.path.exists(os.path.join(RAW, f))]
    if missing:
        print("missing payloads:", ", ".join(missing), file=sys.stderr)
        print("run: python etl/fetch_admin_khz.py", file=sys.stderr)
        return 2

    payloads = {f[:-5]: json.load(open(os.path.join(RAW, f), encoding="utf-8"))
                for f in ("counties.json", "cities.json", "villages.json",
                          "cities_list.json")}
    wd = json.load(open(os.path.join(RAW, "khz_wikidata_settlements.json"), encoding="utf-8"))

    tree = Tree()
    tree.ensure("province", PROVINCE, None, key="khuzestan",
                source="fa.wikipedia", ref="استان خوزستان")
    stats = {"county": parse_counties(tree, payloads["counties"])}
    COUNTY_CANON.update({norm_key(n["name"]): n["name"]
                         for n in tree.nodes.values() if n["kind"] == "county"})
    stats["citylist"] = parse_cities_list(tree, payloads["cities_list"])
    stats["cities"] = parse_cities(tree, payloads["cities"])
    stats["village"] = parse_villages(tree, payloads["villages"])
    stats["wikidata"] = parse_wikidata(tree, wd)

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")
    with open(os.path.join(HERE, "schema_admin.sql"), encoding="utf-8") as fh:
        conn.executescript(fh.read())
    stats["fda"] = parse_existing(conn, tree, "fda")
    stats["osm"] = parse_existing(conn, tree, "osm")

    dropped = drop_county_copies(tree)
    merged = (tree.merge_duplicates() + tree.merge_loose()
              + tree.merge_same_population() + tree.merge_city_village()
              + tree.merge_fuzzy())
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    print("duplicates merged:", merged, " county-copy populations dropped:", dropped)
    for kind in ("county", "bakhsh", "dehestan", "city", "village"):
        n = [x for x in tree.nodes.values() if x["kind"] == kind]
        print(f"  {kind:9s} {len(n):5d}  with population {sum(1 for x in n if x['population']):5d}")

    if args.dry_run:
        return 0

    sources = []
    for name in ("counties", "cities", "villages", "cities_list"):
        p = payloads[name]
        sources.append({"layer": "fa.wikipedia", "ref": name,
                        "sha256": p.get("sha256"), "observed_at": p.get("observed_at")})
    sources.append({"layer": "wikidata", "ref": "SPARQL P131* Q241119",
                    "sha256": hashlib.sha256(json.dumps(wd, sort_keys=True).encode()).hexdigest()})
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    res = load(conn, tree, now, label="khuzestan-admin-wikipedia+wikidata+fda+osm",
               observed=max(p.get("observed_at") or now for p in
                            [payloads["counties"], payloads["cities"], payloads["villages"]]),
               sources=sources)
    conn.commit()
    print("import", json.dumps(res, ensure_ascii=False))
    for row in conn.execute("SELECT kind, n, n_with_population, population_sum FROM v_admin_coverage"):
        print("  coverage", row)
    return 0


if __name__ == "__main__":
    sys.exit(main())
