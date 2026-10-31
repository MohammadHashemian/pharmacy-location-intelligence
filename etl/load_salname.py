"""Parse the Khuzestan 1403 yearbook into a queryable table.

The yearbook (سالنامه آماری استان خوزستان ۱۴۰۳) is the province's official
statistical annual. Its strongest contribution to this model is that it is an
INDEPENDENT, official count of pharmacies per county — the FDA feed is a live
operational system, so having the province's own published numbers lets the two
be cross-checked against each other rather than trusted blindly.

It is also county-level, while the FDA feed is settlement-level: the two are
complementary, not substitutes. Nothing here replaces FDA values; it corroborates
or contradicts them, and the dashboard surfaces county-level deltas.

Tables parsed (indices are positional in each chapter's .docx and verified by
caption + shape before any value is read):
  ch3  T16/T17  خانوار و جمعیت شهرستانها  (1395, total/urban/rural/non-resident)
  ch3  T18      جمعیت شهرستانهای استان across censuses 1335..1395
  ch18 T15      تعداد داروخانهها به تفکیک نوع وابستگی  (1385..1403 + county)
  ch21 T1/T2    متوسط هزینه خالص سالانه یک خانوار شهری و روستایی (province)

Writes table `salname_metrics` (defined in etl/schema.sql).
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys
import time

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import norm_key, norm_text  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BASE = os.path.join(HOME, "data", "raw", "salname", "ex")

_FA = "۰۱۲۳۴۵۶۷۸۹"
_AR = "٠١٢٣٤٥٦٧٨٩"


def ascii_digits(s: str) -> str:
    for i, c in enumerate(_FA):
        s = s.replace(c, str(i))
    for i, c in enumerate(_AR):
        s = s.replace(c, str(i))
    return s


def to_num(s: object) -> float | None:
    """Yearbook cells mix Persian and Latin digits, and use «000»/«...» for nil."""
    if s is None:
        return None
    t = ascii_digits(str(s)).strip()
    t = t.replace(",", "").replace("٬", "").replace("٫", ".").replace("/", ".")
    t = t.replace("_", "").strip()
    if t in ("", "-", "—", "...", "000", "00", ".", "000000"):
        return None
    m = re.match(r"^-?\d+(?:\.\d+)?$", t)
    return float(t) if m else None


def chapter_docx(num: str) -> str | None:
    for root, _d, files in os.walk(BASE):
        for f in files:
            if f.lower().endswith(".docx") and os.path.basename(root) == num:
                return os.path.join(root, f)
    return None


def tables(path: str):
    """-> [(index, caption, Table)] in document order."""
    doc = Document(path)
    last, out, ti = "", [], 0
    for child in doc.element.body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            t = Paragraph(child, doc).text.strip()
            if t:
                last = t
            continue
        if tag == "tbl":
            ti += 1
            out.append((ti, last, Table(child, doc)))
    return out


def cells(row) -> list[str]:
    return [c.text.strip().replace("\n", " ") for c in row.cells]


def county_of(raw: str) -> str | None:
    """Normalise a شهرستان cell («آبادان», «اهواز ...») to a county key."""
    t = norm_text(raw)
    t = re.sub(r"\.{2,}", " ", t)
    t = re.sub(r"^شهرستان\s+", "", t).strip()
    t = re.sub(r"\s*\d+$", "", t).strip()
    return t or None


def main() -> int:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    c.execute("DELETE FROM salname_metrics")
    rows: list[tuple] = []

    def add(chapter, tref, caption, scope, county, metric, dimension, year, value, unit):
        rows.append((chapter, tref, caption[:190], scope, county,
                     norm_key(county) if county else None, metric,
                     dimension, year, float(value), unit, now))

    # ---------------------------------------------------------------- ch 3 --
    p3 = chapter_docx("3")
    t3 = tables(p3)
    by_idx = {i: (cap, tb) for i, cap, tb in t3}

    # T16/T17: households + population by county (1395)
    for idx, cont in ((16, None), (17, None)):
        if idx not in by_idx:
            continue
        cap, tb = by_idx[idx]
        for r in tb.rows[2:]:
            cc = cells(r)
            if len(cc) < 5:
                continue
            name = county_of(cc[0])
            if not name or "کل استان" in cc[0]:
                if "کل استان" in cc[0]:
                    for dim, hh, pop in (("total", cc[1], cc[2]),):
                        if (v := to_num(hh)) is not None:
                            add("3", f"3-{idx}", cap, "province", None,
                                "households", dim, 1395, v, "household")
                        if (v := to_num(pop)) is not None:
                            add("3", f"3-{idx}", cap, "province", None,
                                "population", dim, 1395, v, "person")
                continue
            dims = (("total", cc[1], cc[2]),) if idx == 16 else (
                ("rural", cc[1], cc[2]), ("nonresident", cc[3], cc[4]))
            for dim, hh, pop in dims:
                if (v := to_num(hh)) is not None:
                    add("3", f"3-{idx}", cap, "county", name,
                        "households", dim, 1395, v, "household")
                if (v := to_num(pop)) is not None:
                    add("3", f"3-{idx}", cap, "county", name,
                        "population", dim, 1395, v, "person")
        if idx == 16:
            for r in tb.rows[2:]:
                cc = cells(r)
                if len(cc) < 5:
                    continue
                name = county_of(cc[0])
                if not name or "کل استان" in cc[0]:
                    continue
                for dim, hh, pop in (("urban", cc[3], cc[4]),):
                    if (v := to_num(hh)) is not None:
                        add("3", "3-16", cap, "county", name,
                            "households", dim, 1395, v, "household")
                    if (v := to_num(pop)) is not None:
                        add("3", "3-16", cap, "county", name,
                            "population", dim, 1395, v, "person")

    # T18: county population across censuses
    if 18 in by_idx:
        cap, tb = by_idx[18]
        header = cells(tb.rows[0])
        years = [int(ascii_digits(h)) for h in header[1:] if ascii_digits(h).strip().isdigit()]
        for r in tb.rows[1:]:
            cc = cells(r)
            name = county_of(cc[0])
            if not name:
                continue
            for y, cellv in zip(years, cc[1:]):
                if (v := to_num(cellv)) is not None:
                    add("3", "3-18", cap, "county", name,
                        "population", "census", y, v, "person")

    # --------------------------------------------------------------- ch 18 --
    p18 = chapter_docx("18")
    t18 = {i: (cap, tb) for i, cap, tb in tables(p18)}
    if 15 in t18:
        cap, tb = t18[15]
        # columns: total | uni | other-public | social-security | other-public2 | private | charity | other
        dims = ["total", "public_university", "public_other", "social_security",
                "public_other2", "private", "charity", "other"]
        for r in tb.rows[2:]:
            cc = cells(r)
            if len(cc) < 2:
                continue
            label = ascii_digits(cc[0]).strip()
            if re.fullmatch(r"1[34]\d{2}", label):          # a year row
                y = int(label)
                for dim, cellv in zip(dims, cc[1:]):
                    if (v := to_num(cellv)) is not None:
                        add("18", "18-10", cap, "province", None,
                            "pharmacies", dim, y, v, "pharmacy")
            else:
                name = county_of(cc[0])
                if not name:
                    continue
                for dim, cellv in zip(dims, cc[1:]):
                    if (v := to_num(cellv)) is not None:
                        add("18", "18-10", cap, "county", name,
                            "pharmacies", dim, 1403, v, "pharmacy")

    # --------------------------------------------------------------- ch 21 --
    p21 = chapter_docx("21")
    t21 = {i: (cap, tb) for i, cap, tb in tables(p21)}
    for idx, dims_map in (
        (1, {"خانوارشهری": "urban", "خانوار شهری": "urban",
             "هزينه هاي غير خوراكي": "urban_nonfood",
             "هزينه هاي خوراكي و دخاني": "urban_food",
             "خانوار روستایی": "rural", "هزینه های غیر خوراکی": "rural_nonfood",
             "هزینه های خوراکی و دخانی": "rural_food"}),
        (2, {"خانوار شهری": "urban", "هزينه هاي غير خوراكي": "urban_nonfood",
             "هزینه های خوراکی و دخانی": "urban_food", "خانوار روستایی": "rural",
             "هزینه های غیر خوراکی": "rural_nonfood"}),
    ):
        if idx not in t21:
            continue
        cap, tb = t21[idx]
        header = cells(tb.rows[0])
        years = [int(ascii_digits(h)) for h in header[1:] if ascii_digits(h).strip().isdigit()]
        for r in tb.rows[1:]:
            cc = cells(r)
            key = norm_text(cc[0]).replace("ي", "ی")
            dim = None
            for k, v in dims_map.items():
                if norm_text(k).replace("ي", "ی") == key:
                    dim = v
                    break
            if not dim:
                continue
            for y, cellv in zip(years, cc[1:]):
                if (v := to_num(cellv)) is not None:
                    add("21", f"21-{idx}", cap, "province", None,
                        "household_expenditure", dim, y, v, "thousand_rial")

    c.executemany("""INSERT INTO salname_metrics
        (chapter, table_ref, caption, scope, county, county_key, metric, dimension,
         year_sh, value, unit, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
    c.commit()

    print(f"salname_metrics rows: {len(rows):,}")
    for r in c.execute("""SELECT metric, scope, COUNT(*) n, COUNT(DISTINCT county) ncounty
                          FROM salname_metrics GROUP BY 1,2 ORDER BY 1,2"""):
        print(f"   {r['metric']:<24} {r['scope']:<9} rows={r['n']:<5} counties={r['ncounty']}")
    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
