"""
Write a human-readable shortlist report from the database.

    python src/report.py                       # -> reports/top-sites.md
    python src/report.py --target 4000 --top 30
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import analyze  # noqa: E402
from db import DB_PATH, connect  # noqa: E402

FA = "۰۱۲۳۴۵۶۷۸۹"


def fa(n) -> str:
    if n is None:
        return "—"
    if isinstance(n, str):
        return n
    return f"{n:,}".replace(",", "٬").translate(str.maketrans("0123456789", FA))


def cell(v, fmt: str) -> str:
    if v is None or v == "":
        return "—"
    if fmt == "s":
        return str(v)
    try:
        x = float(v)
    except (TypeError, ValueError):
        return str(v)
    if fmt == "int":
        return fa(int(round(x)))
    return fa(round(x, 1))


def table(rows: list[dict], cols: list[tuple[str, str, str]]) -> str:
    head = " | ".join(c[0] for c in cols)
    sep = " | ".join("---" for _ in cols)
    out = [f"| {head} |", f"| {sep} |"]
    for i, r in enumerate(rows, 1):
        out.append(f"| {fa(i)} | " + " | ".join(cell(r.get(k), f) for _, k, f in cols) + " |")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--target", type=float, default=analyze.DEFAULT_TARGET_POP_PER_PHARMACY)
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--out", default=str(ROOT / "reports" / "top-sites.md"))
    args = ap.parse_args()

    con = connect(args.db)
    meta = analyze.meta(con)
    t = meta["totals"]
    L: list[str] = []
    L.append("# کجای کشور داروخانه باز کنیم؟ — فهرست کوتاه ماشینی")
    L.append("")
    L.append(f"تاریخ تولید گزارش: {datetime.now():%Y-%m-%d %H:%M} — "
             f"منبع: گزارش ظرفیت داروخانهٔ سازمان غذا و دارو")
    L.append("")

    L.append("## عکس لحظه‌ای داده")
    L.append("")
    L.append(f"- آبادی‌های موجود در پایگاه‌داده: **{fa(t['cities'])}** "
             f"(شهر {fa(t['shahr'])} · روستا {fa(t['roosta'])})")
    L.append(f"- رکورد خام دریافتی از سرویس: **{fa(t['raw_rows'])}**")
    L.append(f"- جمعیت پوشش‌داده‌شده: **{fa(t['population'])}** نفر")
    L.append(f"- داروخانهٔ ثبت‌شده: **{fa(t['pharmacies'])}**")
    L.append(f"- ستون ظرفیت خالی منتشرشدهٔ سازمان (روزانه): {fa(t['zk_rouzaneh_sum'])}")
    L.append("")

    def block(title: str, note: str, filters: dict, sort: str, cols, n=None):
        res = analyze.query(con, filters, target_pop_per_pharmacy=args.target,
                            sort=sort, limit=n or args.top)
        L.append(f"## {title}")
        L.append("")
        L.append(note)
        L.append(f"\nمجموعهٔ فیلترشده: {fa(res['total'])} آبادی — نمایش "
                 f"{fa(len(res['rows']))} مورد برتر.\n")
        L.append(table(res["rows"], cols))
        L.append("")

    cols_main = [("شهر/روستا", "city", "s"), ("شهرستان", "county", "s"),
                 ("استان", "province", "s"), ("جمعیت", "population", "int"),
                 ("داروخانه", "pharmacies", "int"),
                 ("جمعیت/داروخانه", "pop_per_pharmacy", "int"),
                 ("درخواست درجریان", "applications_pending", "int"),
                 ("حداقل امتیاز", "hadaghale_emtiaz", "int"),
                 ("ظرفیت تخمینی", "spare", "int"), ("امتیاز", "score", "f")]

    block("۱) بهترین گزینه‌ها بر پایهٔ امتیاز فرصت",
          "فیلتر: شهر، جمعیت ۲۰٬۰۰۰ نفر و بیشتر، حداکثر ۴ داروخانه. وزن‌های پیش‌فرض "
          "(تقاضا ۳۰٪، کمبود دسترسی ۳۰٪، ظرفیت ۱۰٪، نبود رقیب ۱۵٪، سهولت ورود ۱۵٪).",
          {"kind": "shahr", "min_pop": 20000, "max_dk": 4}, "score", cols_main)
    analyze.query(con, {"kind": "shahr", "min_pop": 20000, "max_dk": 4},
                  target_pop_per_pharmacy=args.target, sort="score", limit=args.top)

    block("۲) شهرهای بدون هیچ داروخانه",
          "فیلتر: شهر، جمعیت ۱۰٬۰۰۰ نفر و بیشتر، بدون داروخانهٔ فعال. "
          "مرتب‌شده بر پایهٔ جمعیت (بزرگ‌ترین بازار خالی).",
          {"kind": "shahr", "min_pop": 10000, "max_dk": 0}, "population", cols_main, 20)

    block("۳) شهرهای بزرگ کم‌خدمت",
          "فیلتر: شهر، جمعیت ۵۰٬۰۰۰ نفر و بیشتر، حداکثر ۳ داروخانه — بیشترین نسبت "
          "جمعیت به داروخانه در میان شهرهای بزرگ.",
          {"kind": "shahr", "min_pop": 50000, "max_dk": 3}, "pop_per_pharmacy", cols_main, 20)

    L.append("## ۴) جمع‌بندی استانی (کل کشور)")
    L.append("")
    prov = analyze.province_summary(con, {}, args.target)
    L.append("| استان | شهر/روستا | جمعیت | داروخانه | جمعیت/داروخانه | درخواست درجریان | شهر بدون داروخانه |")
    L.append("| --- | --- | --- | --- | --- | --- | --- |")
    for p in prov:
        L.append(f"| {p['province']} | {fa(p['cities'])} | {fa(p['population'])} | {fa(p['pharmacies'])} | "
                 f"{fa(p['pop_per_pharmacy'])} | {fa(p['applications_pending'])} | "
                 f"{fa(p['cities_without_pharmacy'])} |")
    L.append("")

    L.append("## هشدارها و محدودیت‌ها")
    L.append("")
    L.append("- `ظرفیت خالی` و `حداقل امتیاز` را با امتیاز واقعی خودتان و آخرین مصوبهٔ "
             "دانشگاه بسنجید؛ آستانه‌ها سالانه تغییر می‌کنند.")
    L.append("- «ظرفیت تخمینی» = ⌊جمعیت ÷ هدف⌋ − داروخانه‌های موجود، با هدف "
             f"{fa(int(args.target))} نفر برای هر داروخانه؛ این عدد رسمی سازمان نیست.")
    L.append("- ردیف‌هایی که جمعیتشان با آبادی دیگری مشترک است (انتساب جمعیت شهر مادر) "
             "به‌صورت پیش‌فرض کنار گذاشته شده‌اند.")
    L.append("- دادهٔ عمومی هیچ طول/عرض جغرافیایی ندارد؛ نقشه در اپ وجود ندارد.")
    L.append("- تردد، بیمه، اجاره، فاصله تا بیمارستان و رقابت واقعی میدانی در داده نیست.")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L), encoding="utf-8")
    print(f"[report] {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
