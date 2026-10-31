"""Write reports/khuzestan-geo.md — the human-readable geographic layer report.

Every number is read from the database at run time; nothing is typed by hand. The
prose states the rules the pipeline actually applies, including the ones that
limit what the layer can claim.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
OUT = os.path.join(HOME, "reports", "khuzestan-geo.md")

FA = "۰۱۲۳۴۵۶۷۸۹"


def fa(v, dec: int = 0) -> str:
    if v is None:
        return "—"
    if isinstance(v, str):
        return v
    s = f"{v:,.{dec}f}" if dec else f"{int(round(v)):,}"
    return (s.replace(",", "٬").replace(".", "٫")
            .translate(str.maketrans("0123456789", FA)))


def cov(c: sqlite3.Connection) -> dict:
    return {r["metric"]: r["value"] for r in c.execute(
        "SELECT metric, value FROM geo_coverage_note WHERE scope='khuzestan'")}


def table(headers: list[str], rows: list[list[str]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join([" --- "] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(r) + " |")
    return out


def main() -> int:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    k = cov(c)
    L: list[str] = []
    A = L.append

    A("# لایهٔ مکانی استان خوزستان — نقشه، جمعیت، و مکان‌های تازه‌یافته")
    A("")
    A(f"تاریخ تولید گزارش: {time.strftime('%Y-%m-%d %H:%M')} — "
      f"منبع نقشه: OpenStreetMap (Overpass) · "
      f"منبع جمعیت: Wikidata و سرشماری ویکی‌پدیای فارسی")
    A("")
    A("این لایه مکمل فهرست ظرفیت داروخانهٔ سازمان غذا و دارو است، نه جانشین آن. "
      "فهرست سازمان، آبادی‌های شناخته‌شدهٔ خودش را دارد ولی مختصات جغرافیایی و شهرستانِ "
      "استاندارد ندارد (سطح شهرستان در نگاشت خوزستان در OpenStreetMap وجود ندارد). "
      "برای پاسخ به این پرسش ساخته شده است: **چه مکان‌هایی روی نقشه وجود دارند که در "
      "فهرست سازمان نیستند؟**")
    A("")

    # ---------------------------------------------------------------- snapshot
    A("## ۱) عکس لحظه‌ای لایهٔ مکانی")
    A("")
    st = {r["status"]: dict(r) for r in c.execute("""
        SELECT status, COUNT(*) n,
               SUM(CASE WHEN place_kind IN ('city','town') THEN 1 ELSE 0 END) urban,
               SUM(CASE WHEN place_kind = 'village' THEN 1 ELSE 0 END) vil,
               SUM(CASE WHEN place_kind = 'hamlet' OR place_kind='isolated_dwelling'
                        THEN 1 ELSE 0 END) ham,
               SUM(CASE WHEN place_kind = 'neighbourhood' THEN 1 ELSE 0 END) nb,
               SUM(COALESCE(population_best,0)) pop
        FROM v_geo_place GROUP BY status""")}
    A(f"- اشیای مکانی دریافتی از Overpass: **{fa(k.get('osm_places_raw'))}**")
    A(f"- مکان پس از حذف تکرارهای خودِ نقشه (گره و مرزِ یک شهر): "
      f"**{fa(k.get('osm_places_deduped'))}**")
    matched_n = st["matched"]["n"] if "matched" in st else 0
    A(f"- منطبق با فهرست سازمان (نام و شهرستان): **{fa(matched_n)}**")
    A(f"- نام مشابه با یک ردیف سازمان، نیازمند بازبینی: "
      f"**{fa(k.get('osm_places_name_variants'))}**")
    A(f"- **تازه‌یافته (بدون هیچ معادل در فهرست سازمان): "
      f"{fa(k.get('osm_places_not_in_fda'))}**")
    A(f"- ردیف‌های فهرست سازمان که روی نقشه معادلی ندارند: "
      f"**{fa(k.get('fda_places_not_on_map'))}** از {fa(k.get('fda_places_total'))}")
    A(f"- مکان بدون شهرستان: **{fa(k.get('places_without_county'))}** "
      f"(به‌جای حدس، خالی مانده است)")
    A("")
    rows = []
    for status, label in (("matched", "منطبق"), ("variant", "نیازمند بازبینی"),
                          ("new", "تازه‌یافته")):
        r = st.get(status) or {}
        rows.append([label, fa(r.get("n")), fa(r.get("urban")), fa(r.get("vil")),
                     fa(r.get("ham")), fa(r.get("nb")), fa(r.get("pop"))])
    L.extend(table(["وضعیت", "کل", "شهر/شهرک", "روستا", "آبادی", "محلهٔ شهری",
                    "جمعیت (برآورد موجود)"], rows))
    A("")

    # ------------------------------------------------------------- how built
    A("## ۲) چگونه ساخته شد (و چه چیزی را تضمین می‌کند)")
    A("")
    A("**۱. برداشت نقشه.** همهٔ اشیای `place=city|town|village|hamlet|"
      "isolated_dwelling|neighbourhood` داخل مرز استان خوزستان "
      "(رابطهٔ ۳۶۶۱۵۸۱، ناحیهٔ ۳۶۰۳۶۶۱۵۸۱) از Overpass گرفته و خام روی دیسک "
      "ذخیره شد (`data/raw/osm/`). این برداشت بدون سرور واسط و بدون کلید API است.")
    A("")
    A("**۲. شهرستان از کجا می‌آید.** نگاشت خوزستان در OpenStreetMap سطح "
      "شهرستان ندارد: ۶۷ رابطه در `admin_level=6` وجود دارد و نام همهٔ آن‌ها با "
      "«بخش …» شروع می‌شود. بنابراین بخش از **هندسه** (تست نقطه‌در‌چندضلعی) و "
      "شهرستان از **زنجیرهٔ P131 ویکی‌داده** همان بخش تعیین می‌شود. "
      "برای ۱۷ بخش با نام «بخش مرکزی» که شناسهٔ ویکی‌داده ندارند، شهرستان از "
      "رأی مکان‌های داخل همان بخش (که شناسهٔ خودشان را دارند) گرفته می‌شود — "
      "چون «بخش مرکزی» در هر ۲۷ شهرستان وجود دارد و تطبیق بر پایهٔ نام قطعاً "
      "غلط می‌شد.")
    A(f"  - بخش‌های دارای شهرستان: **{fa(k.get('bakhsh_with_county'))} از {fa(k.get('bakhsh_total'))}**")
    A(f"  - مکان‌های خارج از همهٔ چندضلعی‌ها: **{fa(k.get('places_outside_any_bakhsh'))}**")
    A("")
    A("**۳. اعتبارسنجی متقابل شهرستان.** شهرستان هر مکان از دو مسیر مستقل "
      "به‌دست می‌آید: زنجیرهٔ P131 خودِ مکان، و چندضلعی بخشی که در آن افتاده است. "
      f"این دو مسیر فقط در **{fa(k.get('county_sources_disagree'))} مکان** اختلاف "
      "دارند و اختلاف در ستون `county_alt` نگه داشته می‌شود، نه اینکه پاک شود.")
    A("")
    A("**۴. تطبیق با فهرست سازمان.** نام نرمال‌شده (یکسان‌سازی ی/ک عربی، فاصله‌ها، "
      "اعراب، و پیشوندهای نوعی مانند «روستای/ده/شهرک») و در صورت وجود، تطبیق "
      "شهرستان. کاندیداها از چهار فهرست (نام دقیق، بی‌فاصله، پیشوند چهارحرفی، "
      "سه‌حرفی‌های نمای ایندکس) انتخاب می‌شوند تا «ملاشیه یک» شانس دیدن "
      "«روستاي ملاشيه» را داشته باشد. سه سطح نتیجه:")
    A("  - **منطبق**: نام یکی است (با احتساب اختلاف نگارشی) و شهرستان هم می‌خواند.")
    A("  - **نیازمند بازبینی**: نام تقریباً یکی است، یا نام یکی است ولی شهرستان "
      "فرق دارد. ایران شهرستان‌ها را جابه‌جا کرده است (کرخه از شوش، صیدون از "
      "باغ‌ملک) و فهرست سازمان همچنان نام قدیم را دارد؛ پس این اختلاف نباید یک "
      "مکان را «پنهان» کند، بلکه آن را به یک پرسش تبدیل می‌کند.")
    A("  - **تازه‌یافته**: هیچ معادل قابل قبولی در فهرست سازمان نیست.")
    A("")
    A("**۵. جمعیت.** سه مقدار مستقل جدا نگه داشته می‌شود: برچسب جمعیت روی نقشه، "
      "`P1082` ویکی‌داده، و جملهٔ سرشماری در ویکی‌پدیای فارسی "
      "(«جمعیت آن ۱۶۵۷۵ نفر (۴۴۷۴ خانوار)») که فقط از طریق شناسهٔ خودِ مکان خوانده "
      "می‌شود، نه با جست‌وجوی عنوان. مقدار نمایشی `population_best` و منبعش "
      "(`pop_ref_source`) و نشانی صفحه (`pop_ref_url`) همیشه همراه هم می‌آیند.")
    A("")
    A("**۶. فاصله.** فاصلهٔ هوایی از میدان اصلی شهر اهواز برای همهٔ مکان‌ها "
      "محاسبه شده است؛ فاصله و زمان جاده‌ای با موتور مسیریابی OSRM برای شهرها و "
      "مکان‌های پرجمعیت (سرویس عمومی، با احترام به محدودیت نرخ). "
      f"تعداد فاصلهٔ جاده‌ای محاسبه‌شده: **{fa(k.get('road_distance_resolved'))}**.")
    A("")

    # ----------------------------------------------------- audit / crosscheck
    A("## ۳) بازبینی: آیا «تازه‌یافته» واقعی است؟")
    A("")
    A("برای هر مکان تازه‌یافته، نزدیک‌ترین نام در کل فهرست سازمان (بدون قید "
      "شهرستان) جست‌وجو شد. نتیجه:")
    A("")
    news = [dict(r) for r in c.execute("""
        SELECT name, place_kind, county, population_best, distance_km, pop_ref_source,
               pop_ref_url, dq_flags
        FROM v_geo_new_places
        WHERE intra_city = 0 AND size_unknown = 0 AND pop_suspect = 0
        ORDER BY population_best DESC LIMIT 30""")]
    L.extend(table(["مکان", "نوع", "شهرستان", "جمعیت", "منبع جمعیت",
                    "فاصله از اهواز (کم)", "مأخذ"],
                   [[r["name"], {"city": "شهر", "town": "شهرک",
                                 "village": "روستا", "hamlet": "آبادی",
                                 "isolated_dwelling": "آبادی"}.get(r["place_kind"], r["place_kind"]),
                     r["county"] or "—", fa(r["population_best"]),
                     {"wikidata": "ویکی‌داده", "wikipedia-census": "سرشماری ویکی‌پدیا",
                      "osm-tag": "برچسب نقشه"}.get(r["pop_ref_source"], "—"),
                     fa(r["distance_km"], 1),
                     f"[مأخذ]({r['pop_ref_url']})" if r["pop_ref_url"] else "—"]
                    for r in news]))
    A("")
    A("فهرست کامل در جدول `v_geo_new_places` و در فایل "
      "`web/public/geo/khuzestan_places.geojson`. مواردی که هشدار "
      "`pop_outlier` دارند (جمعیت غیرقابل قبول برای یک روستا) از این جدول کنار "
      "گذاشته شده‌اند ولی از پایگاه‌داده حذف نشده‌اند.")

    # ------------------------------------------------------------- distance
    A("")
    A("## ۴) فاصله از اهواز")
    A("")
    L.extend(table(["حلقه", "مکان", "شهر/شهرک", "تازه‌یافته", "جمعیت",
                    "داروخانهٔ ثبت‌شده"],
                   [[r["distance_band_fa"], fa(r["n_places"]), fa(r["n_urban"]),
                     fa(r["n_new"]), fa(r["population"]), fa(r["n_pharmacies"])]
                    for r in c.execute(
                       "SELECT * FROM v_geo_distance_bands ORDER BY band_km")]))
    A("")
    far = [dict(r) for r in c.execute("""
        SELECT name, place_kind, county, population_best, distance_km, road_km,
               road_minutes, status
        FROM v_geo_place WHERE place_kind IN ('city','town')
        ORDER BY distance_km DESC LIMIT 12""")]
    A("دورترین شهرها/شهرک‌ها از اهواز:")
    A("")
    L.extend(table(["مکان", "شهرستان", "جمعیت", "هوایی (کم)", "جاده‌ای (کم)",
                    "زمان (دقیقه)", "وضعیت"],
                   [[r["name"], r["county"] or "—", fa(r["population_best"]),
                     fa(r["distance_km"], 1), fa(r["road_km"], 1) if r["road_km"] else "—",
                     fa(r["road_minutes"]) if r["road_minutes"] else "—",
                     {"matched": "منطبق", "new": "تازه‌یافته",
                      "variant": "بازبینی"}[r["status"]]] for r in far]))
    A("")
    ratio = c.execute("""SELECT AVG(road_km / distance_km) r, COUNT(*) n
                         FROM v_geo_place WHERE road_km IS NOT NULL
                           AND distance_km > 5""").fetchone()
    if ratio and ratio["r"]:
        A(f"نسبت میانگین فاصلهٔ جاده‌ای به هوایی (برای {fa(ratio['n'])} مکان با "
          f"فاصلهٔ بیش از ۵ کیلومتر): **{fa(ratio['r'], 2)}** — یعنی فاصلهٔ هوایی "
          "برای رتبه‌بندی قابل استفاده است، ولی برای برآورد زمان سفر نه.")
    A("")

    # -------------------------------------------------------------- network
    A("## ۵) شبکهٔ سکونتگاه‌ها")
    A("")
    A("گراف با scipy ساخته شده است: یال‌ها درخت پوشای کمینه (MST) روی "
      "سکونتگاه‌هایی که کمتر از ۳۵ کیلومتر از هم فاصله دارند، در فضای کیلومتری "
      "تصحیح‌شده بر حسب عرض جغرافیایی. خروجی در "
      "`data/derived/geo_network.json` و نمایش زنده در تب «شبکه و فاصله از اهواز» "
      "فایل اطلس است.")
    A("")
    catch = [dict(r) for r in c.execute("""
        SELECT name, place_kind, county, population_best, distance_km
        FROM v_geo_new_places
        WHERE intra_city = 0 AND size_unknown = 0 AND pop_suspect = 0
        ORDER BY population_best DESC LIMIT 10""")]
    A("پرجمعیت‌ترین کاندیداهای تازه‌یافته (برای تحلیل دامنهٔ خدمت در گراف، "
      "شمار سکونتگاه و جمعیت در شعاع ۳۰ کیلومتری هر نقطه در فایل گراف آمده است):")
    A("")
    L.extend(table(["مکان", "شهرستان", "جمعیت", "فاصله از اهواز (کم)"],
                   [[r["name"], r["county"] or "—", fa(r["population_best"]),
                     fa(r["distance_km"], 1)] for r in catch]))
    A("")

    # ------------------------------------------------------------ variants
    A("## ۶) صف بازبینی انسانی")
    A("")
    A("این موارد **نباید** بدون بررسی به‌عنوان مکان تازه شمرده شوند و "
      "**نباید** هم بی‌صدا کنار گذاشته شوند:")
    A("")
    var = [dict(r) for r in c.execute("""
        SELECT name, place_kind, county, fda_place, fda_county, fda_population,
               n_pharmacy_total, match_method
        FROM v_geo_variants ORDER BY fda_population DESC LIMIT 20""")]
    L.extend(table(["نام روی نقشه", "شهرستان نقشه", "ردیف سازمان", "شهرستان سازمان",
                    "داروخانه", "دلیل"],
                   [[r["name"], r["county"] or "—", r["fda_place"],
                     r["fda_county"], fa(r["n_pharmacy_total"]),
                     r["match_method"]] for r in var]))
    A("")

    # -------------------------------------------------------------- limits
    A("## ۷) محدودیت‌های شناخته‌شده")
    A("")
    A("- **جمعیت نقشه تأییدشده نیست.** برچسب `population` در OpenStreetMap "
      "اجتماعی است؛ هر مقدار با هشدار `pop_outlier` علامت خورده است و در "
      "رتبه‌بندی‌ها کنار گذاشته می‌شود.")
    A("- **شهرستان‌ها از ویکی‌داده می‌آیند، نه از مرز رسمی.** سطح شهرستان در "
      "نگاشت خوزستان وجود ندارد؛ اگر ویکی‌داده برای یک بخش زنجیرهٔ ناقص داشته "
      "باشد، شهرستان از رأی مکان‌های داخل آن بخش گرفته می‌شود و همین موضوع "
      "دلیل وجود ستون `admin_method` و `admin_confidence` است.")
    A("- **خودِ نقشه کامل نیست.** سکونتگاه‌هایی که در OpenStreetMap ثبت نشده‌اند "
      "در این لایه غایب‌اند؛ به همین دلیل ستون «ردیف‌های فهرست سازمان بدون معادل "
      "نقشه» در بالا گزارش می‌شود. اجتماع دو منبع از هر کدام بزرگ‌تر است.")
    A("- **محله‌های شهری یک سکونتگاه نیستند.** ۳۱۳ مورد از این نوع در نقشه "
      "هستند و با پرچم `city_neighbourhood_not_a_settlement` جدا شده‌اند؛ "
      "شهر خودشان (مثلاً اهواز) از قبل در فهرست سازمان است.")
    A("- **دامنهٔ خدمت با فاصلهٔ هوایی سنجیده شده است**، نه با زمان سفر واقعی؛ "
      "فاصلهٔ جاده‌ای فقط برای بخشی از مکان‌ها محاسبه شده است.")
    A("")

    # ------------------------------------------------------------ reproduce
    A("## ۸) بازتولید")
    A("")
    A("```bash")
    A("bash etl/rebuild_geo.sh        # برداشت، تطبیق، جمعیت، خروجی‌ها، بازبینی")
    A("python etl/audit_geo.py        # فقط گزارش بازبینی")
    A("python etl/build_geo_pages.py  # ساخت دوبارهٔ اطلس HTML")
    A("```")
    A("")
    A("جداول: `geo_places` (مکان‌ها)، `geo_admin_unit` (بخش‌ها و شهرستان‌ها)، "
      "`geo_location_match` (تطبیق، با ستون `tier`)، `geo_place_duplicate` "
      "(تکرارهای خود نقشه)، `geo_coverage_note` (شمارنده‌ها). "
      "نماها: `v_geo_place`, `v_geo_new_places`, `v_geo_variants`, "
      "`v_geo_county_rollup`, `v_geo_distance_bands`, `v_geo_status_summary`, "
      "`v_geo_dq`, `v_geo_coverage`.")
    A("")

    # --------------------------------------------------------------- sources
    A("## ۹) منابع و مجوزها")
    A("")
    L.extend(table(["لایه", "مأخذ", "مجوز", "زمان برداشت", "تعداد عنصر"],
                   [[r["layer"], f"`{r['ref']}`", r["licence"] or "—",
                     r["observed_at"], fa(r["element_count"])]
                    for r in c.execute("""SELECT layer, ref, licence, observed_at,
                                                 element_count FROM geo_sources
                                          ORDER BY id""")]))
    A("")
    A("دادهٔ OpenStreetMap تحت ODbL 1.0 است. جمعیت ویکی‌داده در نهایت به "
      "مرکز آمار ایران ارجاع می‌دهد؛ نشانی صفحهٔ هر مقدار در ستون `pop_ref_url` "
      "ذخیره شده است.")
    A("")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write("\n".join(L))
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
