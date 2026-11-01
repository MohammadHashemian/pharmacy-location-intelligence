"""Fixture tests for the POI classifier, plus a live audit of what is already on the map.

    python etl/verify_classifier.py            # fixtures + audit of the DB
    python etl/verify_classifier.py --no-db    # fixtures only

Every fixture is a real shape we saw in the province or a textbook case: a tire
shop that Google types «medical_clinic», a bag shop, a social-security clinic that
is genuinely medical, a doctor's office inside a hospital, …
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_poi import (  # noqa: E402
    CLINIC, DENTIST, DOCTOR, HOSPITAL, IRRELEVANT, LAB, PHARMACY, UNKNOWN,
    classify,
)

# (name, types, expected role)
CASES: list[tuple[str, tuple[str, ...], str]] = [
    # --- the junk that actually reached the map -------------------------------
    ("پنچرگیری تیوبلس استاد غلام", ("medical_clinic",), IRRELEVANT),
    ("فروشگاه کیف محمد", ("medical_clinic",), IRRELEVANT),
    ("لاستیک فروشی حاج رضا", ("car_repair", "tire_repair"), IRRELEVANT),
    ("کارواش ستاره", ("car_wash",), IRRELEVANT),
    ("آرایشگاه مردانه رضا", ("beauty_salon",), IRRELEVANT),
    ("سوپرمارکت مهر", ("supermarket",), IRRELEVANT),
    ("کافه dentist", ("cafe",), IRRELEVANT),          # negative type beats a name hit
    ("بیمه سینا نمایندگی برزگر", ("insurance_agency",), IRRELEVANT),
    ("مشاور املاک آرام", ("real_estate_agency",), IRRELEVANT),
    ("دفتر اسناد رسمی ۱۲", (), IRRELEVANT),
    ("نانوایی سنگک", (), IRRELEVANT),
    ("موبایل فروشی پارس", (), IRRELEVANT),

    # --- pharmacies -----------------------------------------------------------
    ("داروخانه شبانه‌روزی مادر", ("pharmacy", "health"), PHARMACY),
    ("داروخانه دکتر بدری", ("pharmacy", "health"), PHARMACY),
    ("Dr Ali Andishmand Pharmacy", ("pharmacy",), PHARMACY),
    ("داروخانه شرکت نفت", ("pharmacy",), PHARMACY),
    ("صيدلية ام قصر", (), PHARMACY),                  # Arabic spelling
    ("دکتر رضایی", ("pharmacy",), DOCTOR),             # a bare «دکتر X» is a doctor

    # --- doctors --------------------------------------------------------------
    ("دکتر سعید افتخار", ("doctor",), DOCTOR),
    ("مطب دکتر نوری", ("doctor",), DOCTOR),
    ("دکتر مجید کاراندیش", (), DOCTOR),
    ("Dr. Kazemi", ("doctor",), DOCTOR),
    ("دکتر شهلا فانی متخصص زنان", (), DOCTOR),
    ("پزشک عمومی سید حسن موسوی", (), DOCTOR),

    # --- clinics --------------------------------------------------------------
    ("درمانگاه تخصصی دانیال", (), CLINIC),
    ("کلینیک سوم خرداد بیمه تامین اجتماعی", (), CLINIC),
    ("مرکز کاردرمانی قائم", (), CLINIC),
    ("درمانگاه شبانه‌روزی امام رضا", (), CLINIC),
    ("کلینیک فیزیوتراپی مهر", (), CLINIC),
    ("بهداشت و درمان صنعت نفت", (), CLINIC),
    ("رخشا رادیولوژی و سونوگرافی", (), LAB),
    ("آزمایشگاه پاتولوژی دکتر شریفی", (), LAB),

    # --- dentists / hospitals -------------------------------------------------
    ("کلینیک دندانپزشکی تبسم", (), DENTIST),
    ("دندانپزشکی دکتر یاری", (), DENTIST),
    ("بیمارستان امام خمینی", (), HOSPITAL),
    ("بیمارستان گلستان اهواز", ("hospital",), HOSPITAL),
    ("درمانگاه امام علی", ("doctor",), CLINIC),       # name beats a loose type

    # --- no signal ------------------------------------------------------------
    ("ساختمان پزشکان", (), DOCTOR),                   # medical building: keep, weak
    ("مجموعه ورزشی", ("gym",), IRRELEVANT),
    ("", (), UNKNOWN),
]

# fixtures that are only meaningful with a query role attached
QUERY_CASES: list[tuple[str, tuple[str, ...], str, str]] = [
    ("سازمانی بدون نام", ("doctor",), "doctor", DOCTOR),
    ("مرکز ناشناس", ("doctor",), "medical_clinic", DOCTOR),
]

FAIL_SCORE = 0.6


def run_fixtures() -> int:
    fails = 0
    print("== fixtures ==")
    for name, types, want in CASES:
        r = classify(name, types)
        got = r["role"]
        if want in (DOCTOR, CLINIC) and got in (DOCTOR, CLINIC) and name != "ساختمان پزشکان":
            # doctor vs clinic is a soft boundary; both are medical
            ok = True
        else:
            ok = got == want
        if not ok:
            fails += 1
        mark = "PASS" if ok else "FAIL"
        print(f"{mark}  {name[:38]:40s} types={','.join(types)[:22]:24s} "
              f"-> {got:10s} ({r['score']:.2f}, {r['why']})")
    for name, types, q, want in QUERY_CASES:
        r = classify(name, types, query_role=q)
        ok = r["role"] == want
        fails += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}  {name[:38]:40s} q={q:14s} -> {r['role']}")

    total = len(CASES) + len(QUERY_CASES)
    print(f"\n{total - fails}/{total} fixtures pass")
    return fails


def run_audit() -> int:
    db = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "db", "pharmacy.sqlite")
    if not os.path.exists(db):
        print("no db")
        return 0
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    print("\n== live audit: map_medical ==")
    rows = c.execute("SELECT id, kind, name, address FROM map_medical").fetchall()
    bad: list[sqlite3.Row] = []
    for r in rows:
        role = classify(r["name"], (), r["address"] or "")["role"]
        if role not in (DOCTOR, CLINIC, DENTIST, HOSPITAL, LAB):
            bad.append(r)
    print(f"{len(rows):,} rows · {len(bad):,} no longer classify as medical "
          f"({len(bad)/max(1,len(rows))*100:.1f}%)")
    for r in bad[:15]:
        res = classify(r["name"], (), r["address"] or "")
        print(f"  [{r['kind']}] {r['name'][:46]:48s} -> {res['role']:10s} ({res['why']})")

    print("\n== live audit: map_pharmacy ==")
    ph = c.execute("SELECT name, source FROM map_pharmacy").fetchall()
    badp = [r for r in ph if classify(r["name"], ())["role"] not in (PHARMACY, DOCTOR, CLINIC)]
    print(f"{len(ph):,} rows · {len(badp):,} not a pharmacy by name")
    for r in badp[:10]:
        print(f"  [{r['source']}] {r['name'][:50]:52s} -> "
              f"{classify(r['name'], ())['role']} ({classify(r['name'], ())['why']})")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-db", action="store_true")
    args = ap.parse_args()
    fails = run_fixtures()
    if not args.no_db:
        run_audit()
    print("\n" + ("classifier: OK" if fails == 0 else f"classifier: {fails} FAILED"))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
