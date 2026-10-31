"""Report + CSV export of the Khuzestan administrative tree.

Reads only the views created by schema_admin.sql, so it can run while the loader
is still filling the tables (it always reflects the last committed import).

    python etl/report_admin.py --db db/pharmacy.sqlite
"""
from __future__ import annotations

import argparse
import csv
import os
import sqlite3
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPORTS = os.path.join(ROOT, "reports")

KIND_FA = {"province": "استان", "county": "شهرستان", "bakhsh": "بخش",
           "dehestan": "دهستان", "city": "شهر", "village": "روستا"}


def fmt(n) -> str:
    if n is None:
        return "—"
    return f"{int(n):,}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "db", "pharmacy.sqlite"))
    ap.add_argument("--out-dir", default=REPORTS)
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    cov = list(conn.execute("SELECT * FROM v_admin_coverage"))
    total = sum(r["n"] for r in cov)
    settlements = sum(r["n"] for r in cov if r["kind"] in ("city", "village"))
    with_pop = sum(r["n_with_population"] for r in cov if r["kind"] in ("city", "village"))

    # ---- per county --------------------------------------------------------
    per_county = list(conn.execute("""
        SELECT county,
               SUM(kind='bakhsh')            AS bakhsh,
               SUM(kind='dehestan')          AS dehestan,
               SUM(kind='city')              AS city,
               SUM(kind='village')           AS village,
               SUM(CASE WHEN kind IN ('city','village') THEN population END) AS pop,
               SUM(kind IN ('city','village') AND population IS NULL) AS no_pop
        FROM v_admin_area_current
        WHERE county IS NOT NULL
        GROUP BY county ORDER BY village DESC"""))

    # ---- explicit gaps -----------------------------------------------------
    fda_unmatched = list(conn.execute("""
        SELECT COUNT(*) n FROM locations l
        WHERE l.province_key LIKE '%خوزستان%'
          AND NOT EXISTS (SELECT 1 FROM admin_area_link k
                          WHERE k.layer='fda' AND k.ref_id=l.id)"""))[0]["n"]
    osm_unmatched = list(conn.execute("""
        SELECT COUNT(*) n FROM geo_places g
        WHERE g.province LIKE '%خوزستان%'
          AND g.place_kind IN ('city','town','village','hamlet','isolated_dwelling')
          AND NOT EXISTS (SELECT 1 FROM admin_area_link k
                          WHERE k.layer='osm' AND k.ref_id=g.id)"""))[0]["n"]

    imports = list(conn.execute("""
        SELECT id, label, observed_at, imported_at, n_added, n_changed
        FROM admin_import ORDER BY id DESC LIMIT 5"""))

    # ---- CSV ---------------------------------------------------------------
    rows = conn.execute("""
        SELECT kind, name, county, bakhsh, dehestan, population,
               population_year_sh, population_source, latitude, longitude,
               wikidata, breadcrumb, area_id
        FROM v_admin_settlement
        ORDER BY county, bakhsh, dehestan, kind DESC, population DESC""").fetchall()
    csv_path = os.path.join(args.out_dir, "admin_khuzestan.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["نوع", "نام", "شهرستان", "بخش", "دهستان", "جمعیت", "سال سرشماری",
                    "منبع جمعیت", "عرض", "طول", "ویکیداده", "مسیر", "شناسه"])
        for r in rows:
            w.writerow([KIND_FA.get(r["kind"], r["kind"]), r["name"], r["county"],
                        r["bakhsh"], r["dehestan"], r["population"],
                        r["population_year_sh"], r["population_source"],
                        r["latitude"], r["longitude"], r["wikidata"],
                        r["breadcrumb"], r["area_id"]])

    # ---- markdown ----------------------------------------------------------
    md = [f"# درخت تقسیمات کشوری استان خوزستان",
          "",
          f"تولید: {datetime.now(timezone.utc).astimezone():%Y-%m-%d %H:%M} — "
          f"{fmt(total)} واحد، {fmt(settlements)} محل سکونت "
          f"({fmt(with_pop)} با جمعیت).",
          "",
          "| سطح | تعداد | با جمعیت | بدون جمعیت | جمع جمعیت |",
          "|---|---:|---:|---:|---:|"]
    for r in cov:
        md.append(f"| {KIND_FA.get(r['kind'], r['kind'])} | {fmt(r['n'])} | "
                  f"{fmt(r['n_with_population'])} | {fmt(r['n_without_population'])} | "
                  f"{fmt(r['population_sum'])} |")
    md += ["", "## به تفکیک شهرستان", "",
           "| شهرستان | بخش | دهستان | شهر | روستا | جمعیت | بدون جمعیت |",
           "|---|---:|---:|---:|---:|---:|---:|"]
    for r in per_county:
        md.append(f"| {r['county']} | {fmt(r['bakhsh'])} | {fmt(r['dehestan'])} | "
                  f"{fmt(r['city'])} | {fmt(r['village'])} | {fmt(r['pop'])} | {fmt(r['no_pop'])} |")
    md += ["", "## پوشش منابع", "",
           f"- مکان‌های FDA بدون اتصال به درخت: **{fmt(fda_unmatched)}**",
           f"- مکان‌های OSM بدون اتصال به درخت: **{fmt(osm_unmatched)}**",
           "", "## آخرین بارگذاری‌ها", "",
           "| # | برچسب | مشاهده | بارگذاری | جدید | تغییر |", "|---|---|---|---|---:|---:|"]
    for r in imports:
        md.append(f"| {r['id']} | {r['label']} | {r['observed_at'][:19]} | "
                  f"{r['imported_at'][:19]} | {r['n_added']} | {r['n_changed']} |")

    # ---- xlsx (one workbook the user can filter without SQL) ---------------
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font

        wb = Workbook()
        ws = wb.active
        ws.title = "خلاصه"
        ws.append(["سطح", "تعداد", "با جمعیت", "بدون جمعیت", "جمع جمعیت"])
        for r in cov:
            ws.append([KIND_FA.get(r["kind"], r["kind"]), r["n"], r["n_with_population"],
                       r["n_without_population"], r["population_sum"]])
        ws2 = wb.create_sheet("شهرستان‌ها")
        ws2.append(["شهرستان", "بخش", "دهستان", "شهر", "روستا", "جمعیت", "بدون جمعیت"])
        for r in per_county:
            ws2.append([r["county"], r["bakhsh"], r["dehestan"], r["city"],
                        r["village"], r["pop"], r["no_pop"]])
        ws3 = wb.create_sheet("همه مکان‌ها")
        ws3.append(["نوع", "نام", "شهرستان", "بخش", "دهستان", "جمعیت",
                    "سال سرشماری", "منبع جمعیت", "مسیر"])
        for r in rows:
            ws3.append([KIND_FA.get(r["kind"], r["kind"]), r["name"], r["county"],
                        r["bakhsh"], r["dehestan"], r["population"],
                        r["population_year_sh"], r["population_source"],
                        r["breadcrumb"]])
        for sheet, widths in ((ws, (14, 10, 10, 12, 14)),
                              (ws2, (26, 8, 8, 7, 8, 14, 10)),
                              (ws3, (8, 30, 24, 14, 20, 12, 10, 22, 60))):
            for col, w in zip("ABCDEFGHI", widths):
                sheet.column_dimensions[col].width = w
            sheet.freeze_panes = "A2"
            for cell in sheet[1]:
                cell.font = Font(bold=True)
        xlsx_path = os.path.join(args.out_dir, "admin_khuzestan.xlsx")
        wb.save(xlsx_path)
        print(f"xlsx: {xlsx_path}")
    except ImportError:
        pass

    md_path = os.path.join(args.out_dir, "admin_khuzestan.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")

    print(f"rows: {len(rows)}  csv: {csv_path}")
    print(f"markdown: {md_path}")
    for r in cov:
        print(f"  {r['kind']:9s} {r['n']:6d}  with_pop {r['n_with_population']:6d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
