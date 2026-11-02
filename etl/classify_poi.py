"""Decide what a place is, before it is allowed onto the map.

The old rule was "Google returned a `medical_clinic` type, keep it", and it put a
tire repair shop (`پنچرگیری تیوبلس استاد غلام`) and a bag shop (`فروشگاه کیف محمد`)
into the medical layer. Google's own categories are wrong often enough in Iran that
they cannot be the only signal, and the name carries most of the truth.

Order of evidence, strongest first:

1. a hard **negative type** — `tire_repair`, `car_repair`, `convenience_store`…:
   no name can rescue a tire shop;
2. a hard **negative name** — پنچر, لاستیک, فروشگاه, آرایشگاه, رستوران…
3. a **positive name** — درمانگاه, کلینیک, مطب, پزشک, داروخانه, آزمایشگاه…;
4. **types** — `doctor`, `medical_clinic`, `pharmacy`…, used when the name is
   neutral («دکتر رضایی» vs «رضایی»);
5. the **query role** we searched with, as a weak last resort.

Anything left is `unknown`, and unknown is not mapped: a wrong pin is worse than a
missing one.
"""
from __future__ import annotations

import re

ZWNJ = "\u200c"

PHARMACY = "pharmacy"
DOCTOR = "doctor"
CLINIC = "clinic"
DENTIST = "dentist"
HOSPITAL = "hospital"
LAB = "lab"
IRRELEVANT = "irrelevant"
UNKNOWN = "unknown"

MEDICAL_ROLES = {DOCTOR, CLINIC, DENTIST, HOSPITAL, LAB}

# A place that carries one of these is not a medical business, whatever its name
# says. Kept in Google's vocabulary (`types[]`), not translated.
NEGATIVE_TYPES = {
    "tire_repair", "car_repair", "car_wash", "car_dealer", "auto_parts_store",
    "gas_station", "convenience_store", "supermarket", "grocery_store",
    "restaurant", "cafe", "bakery", "meal_takeaway", "meal_delivery",
    "beauty_salon", "hair_salon", "barber_shop", "spa",
    "clothing_store", "shoe_store", "jewelry_store", "gift_shop",
    "furniture_store", "hardware_store", "electronics_store", "mobile_phone_store",
    "florist", "book_store", "department_store", "shopping_mall",
    "bank", "atm", "insurance_agency", "real_estate_agency", "lawyer",
    "travel_agency", "lodging", "hotel", "bar", "night_club", "gym",
    "school", "university", "primary_school", "secondary_school",
    "laundry", "tailor", "painter", "plumber", "electrician", "moving_company",
    "storage", "parking", "bus_station", "subway_station", "train_station",
    "place_of_worship", "mosque", "cemetery", "police", "city_hall",
    "post_office", "library", "museum", "park", "stadium",
    # a street or a square can be *called* داروخانه without being one
    "street", "route", "road", "highway", "locality", "neighbourhood",
    "neighborhood", "sublocality", "political", "administrative_area_level_1",
    "administrative_area_level_2", "village", "town", "city", "square",
    "plus_code", "postal_code", "intersection", "premise",
}

# Persian/Farsi words that settle the question by themselves.
NEGATIVE_NAME = (
    "پنچر", "لاستیک", "تعمیرگاه", "تعمیرات", "فروشگاه", "سوپرمارکت", "سوپر مارکت",
    "بقالی", "خواروبار", "خواربار", "نانوایی", "قنادی", "رستوران", "کافه",
    "فست فود", "فستفود", "ساندویچ", "پیتزا", "آبمیوه", "بستنی", "قهوه",
    "آرایشگاه", "آرایش", "سالن زیبایی", "پیرایش", "دکوراسیون", "مبلمان", "فرش",
    "پوشاک", "لباس", "کفش", "طلا", "جواهر", "ساعت", "عینک فروشی", "موبایل",
    "لوازم خانگی", "لوازم یدکی", "یدکی", "ابزار", "رنگ ", "کاشی", "سرامیک",
    "میلگرد", "آهن", "چوب", "سنگ", "شن و ماسه", "بتن", "باربری", "مسافربری",
    "پمپ بنزین", "جایگاه", "سوخت", "گاز", "تاکسی", "آژانس", "املاک", "مشاور املاک",
    "بانک", "بیمه", "بورس", "صرافی", "دفتر اسناد", "دفترخانه", "وکیل", "حسابداری",
    "آموزشگاه", "کلاس", "مهد", "کتابفروشی", "لوازم التحریر", "چاپ", "تبلیغات",
    "آهنفروشی", "ضایعات", "بازیافت", "کارواش", "قالیشویی", "خشکشویی",
    "گل فروشی", "گلفروشی", "پرنده", "حیوانات", "دامپزشکی", "کشاورزی", "بذر",
    "پیمانکاری", "مهندسی", "معماری", "ساختمانی", "کارخانه", "انبار", "عمده فروشی",
    "تجهیزات پزشکی", "لوازم پزشکی", "تجهیزات بیمارستانی", "کشاورزی", "دامپزشکی",
    "گلخانه", "نهال", "بذر", "سموم", "کود", "چاپخانه", "کارگزاری",
    "عطاری", "عطاریه", "کالای", "کالا دندان", "لوازم دندانپزشکی",
    # «داروخانه گیاهپزشکی» is a crop-chemicals shop; the LLM audit found them filed as
    # human pharmacies because the name contains داروخانه.
    "گیاهپزشکی", "گیاه پزشکی",
    "لوازم آزمایشگاهی", "کانون زیبایی", "سالن", "باشگاه",
)

# Name → role. The most specific pattern wins, so «دندانپزشکی» beats «پزشک».
POSITIVE_NAME: dict[str, tuple[str, ...]] = {
    PHARMACY: ("داروخانه", "دارو خانه", "داورخانه", "pharmacy", "drugstore",
               "صيدلية", "صیدلیه", "صيدليه"),
    HOSPITAL: ("بیمارستان", "hospital"),
    DENTIST: ("دندانپزشک", "دندانپزشکی", "دندان پزشک", "orthodont", "dental"),
    LAB: ("آزمایشگاه", "laboratory", "medical lab", "رادیولوژی", "سونوگرافی",
          "تصویربرداری", "پاتولوژی", "ام آر آی", "ام‌آر‌آی", "mri", "سی تی اسکن",
          "سی‌تی", "ct scan", "imaging", "رادیوگرافی", "اکو", "نوار قلب"),
    CLINIC: ("درمانگاه", "کلینیک", "کلینک", "clinic", "مرکز درمانی", "مرکز پزشکی",
             "بهداشت", "درمان بستری", "فیزیوتراپی", "توانبخشی", "مامایی",
             "تزریقات", "پانسمان", "سلامت", "کاردرمانی", "گفتاردرمانی",
             "لیزر", "اسکالپ", "زیبایی", "پوست و مو", "لیزر مو",
             # healthcare environments that were landing in `unknown`
             "پلی کلینیک", "پلی‌کلینیک", "اورژانس", "مرکز سلامت", "خانه بهداشت",
             "پایگاه سلامت", "مرکز بهداشت", "دیالیز", "زایشگاه", "تالاسمی",
             "هموفیلی", "مرکز مشاوره", "روان شناسی", "روان‌شناسی", "روانشناس",
             "طب کار", "occupational", "توانبخشی", "گفتار درمانی"),
    DOCTOR: ("مطب", "پزشک", "دکتر", "doctor", "متخصص", "فوق تخصص", "جراح",
             "پزشکی", "قلب", "اطفال", "زنان", "داخلی", "مغز و اعصاب", "ارتوپد",
             "پوست", "چشم", "گوش", "حلق", "بینی", "تغذیه", "روانپزشک", "روانشناس",
             "اورولوژی", "کلیه", "گوارش", "ریه", "غدد", "خون", "انکولوژی",
             "بیهوشی", "طب سنتی", "طب کار", "پزشک خانواده"),
}

# Google type → role, when the name says nothing.
TYPE_ROLE: dict[str, str] = {
    "pharmacy": PHARMACY, "drugstore": PHARMACY,
    "hospital": HOSPITAL,
    "dentist": DENTIST,
    "medical_lab": LAB,
    "medical_clinic": CLINIC,
    "doctor": DOCTOR,
    "physiotherapist": CLINIC,
    "chiropractor": CLINIC,
}


_WORD = r"؀-ۿ\w"


def _token_re(word: str) -> re.Pattern:
    """Whole word: a negative must not fire inside a name («مهد» in «مهدی پور»)."""
    w = re.escape(word.strip())
    return re.compile(rf"(?<![{_WORD}]){w}(?![{_WORD}])")


def _prefix_re(word: str) -> re.Pattern:
    """Left boundary only, so «دندانپزشک» still matches «دندانپزشکی»."""
    w = re.escape(word.strip())
    return re.compile(rf"(?<![{_WORD}]){w}")


def normalize(text: str) -> str:
    t = (text or "").replace(ZWNJ, " ").replace("ي", "ی").replace("ك", "ک")
    t = re.sub(r"[^\w\u0600-\u06FF]+", " ", t).lower()
    return re.sub(r"\s+", " ", t).strip()


# a negative of 4+ letters may carry a suffix («پنچر» → «پنچرگیری»); shorter ones
# are matched whole so «مهد» cannot fire inside «مهدی پور» or «فرش» inside «فرشته»
NEG_RES = []
for _w in NEGATIVE_NAME:
    _n = normalize(_w)
    if not _n:
        continue
    NEG_RES.append(_prefix_re(_n) if len(_n) >= 4 else _token_re(_n))
POS_RES = {
    role: [_prefix_re(normalize(w)) for w in words if normalize(w)]
    for role, words in POSITIVE_NAME.items()
}
# equipment sellers, factories and address-like strings: no medical word rescues them
HARD_NEG = [_prefix_re(normalize(w)) for w in
            ("تجهیزات پزشکی", "لوازم پزشکی", "تجهیزات بیمارستانی", "تجهیزات دندان",
             "کارخانه", "factory", "شرکت تجهیزات")]

# words that outrank a negative hit: «کلینیک سوم خرداد بیمه تامین اجتماعی» is a
# clinic that happens to belong to an insurer
STRONG = [_prefix_re(normalize(w)) for w in
          ("کلینیک", "درمانگاه", "بیمارستان", "داروخانه", "آزمایشگاه", "مطب", "clinic",
           "hospital", "pharmacy", "dental", "medical")]




def classify(name: str, types=(), address: str = "", query_role: str | None = None) -> dict:
    """Return {role, score, why}. Score is 0..1 confidence in `role`."""
    n = normalize(name)
    toks = {str(t).lower().strip() for t in (types or ()) if str(t).strip()}

    hits = sorted(toks & NEGATIVE_TYPES)
    if hits:
        return {"role": IRRELEVANT, "score": 0.97, "why": f"type:{hits[0]}"}
    for rx in HARD_NEG:
        if rx.search(n):
            return {"role": IRRELEVANT, "score": 0.96, "why": f"hard:{rx.pattern}"}
    strong_hit = any(rx.search(n) for rx in STRONG)
    for rx in NEG_RES:
        if rx.search(n):
            if strong_hit:
                break                      # «کلینیک … بیمه …» is still a clinic
            return {"role": IRRELEVANT, "score": 0.95, "why": f"name:{rx.pattern}"}

    # most specific role first: a «دندانپزشکی» is not a generic «پزشکی»
    for role in (PHARMACY, HOSPITAL, DENTIST, LAB, CLINIC, DOCTOR):
        for rx, word in zip(POS_RES[role], POSITIVE_NAME[role]):
            if rx.search(n):
                # a bare «دکتر X» is a doctor's office; «درمانگاه دکتر X» is a clinic
                typed = {TYPE_ROLE[t] for t in toks if t in TYPE_ROLE}
                if role == DOCTOR and CLINIC in typed and "درمانگاه" not in n:
                    return {"role": CLINIC, "score": 0.72, "why": f"type+name:{word}"}
                return {"role": role, "score": 0.88, "why": f"name:{word}"}

    typed = {TYPE_ROLE[t] for t in toks if t in TYPE_ROLE}
    if PHARMACY in typed and len(typed) == 1:
        return {"role": PHARMACY, "score": 0.8, "why": "type:pharmacy"}
    if typed:
        # several medical types: pick the one that brings the most traffic
        for role in (HOSPITAL, CLINIC, DENTIST, LAB, DOCTOR):
            if role in typed:
                return {"role": role, "score": 0.62, "why": f"type:{role}"}

    if query_role and query_role in MEDICAL_ROLES | {PHARMACY}:
        return {"role": query_role, "score": 0.35, "why": f"query:{query_role}"}
    return {"role": UNKNOWN, "score": 0.2, "why": "no-signal"}


def as_pharmacy(name: str, types=(), address: str = "") -> bool:
    """Only an explicit pharmacy, never «probably fine»."""
    r = classify(name, types, address)
    return r["role"] == PHARMACY and r["score"] >= 0.6


def as_medical(name: str, types=(), address: str = "") -> str | None:
    """The medical role, or None when the place is not a medical business."""
    r = classify(name, types, address)
    if r["role"] in MEDICAL_ROLES and r["score"] >= 0.6:
        return r["role"]
    return None
