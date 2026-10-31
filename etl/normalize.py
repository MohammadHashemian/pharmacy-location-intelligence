"""Text/number normalisation for Iranian (Persian/Arabic-script) FDA data.

The source mixes Persian and Arabic codepoints, uses Arabic-Indic digits, and
pads values with stray whitespace / zero-width joiners. Without normalising,
"داروخانه" from two different captures hashes to two different `loc_key`s and
the master table silently explodes with duplicates.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata

# --------------------------------------------------------------------------
# codepoint cleanup
# --------------------------------------------------------------------------
# Arabic-Indic + Extended Arabic-Indic digits -> ASCII
_DIGIT_MAP = {ord(c): str(i) for i, c in enumerate("٠١٢٣٤٥٦٧٨٩", start=0)}
_DIGIT_MAP.update({ord(c): str(i) for i, c in enumerate("۰۱۲۳۴۵۶۷۸۹", start=0)})

# Arabic letters that must fold onto their Persian counterparts so that
# "شهرستان گتوند" and "شهرستان گتوند" compare equal.
#
# Keys MUST be ordinals: str.translate() indexes the table by ord(char) and
# silently leaves a character alone when the lookup misses, so a str-keyed dict
# here is a no-op that fails invisibly. (This was a real bug: روستاي ملاشيه
# never folded onto ملاشيه, so it matched nothing in the reference layer.)
_LETTER_MAP = {
    ord("\u064a"): "\u06cc",  # ARABIC YEH        -> FARSI YEH
    ord("\u0649"): "\u06cc",  # ALEF MAKSURA      -> FARSI YEH
    ord("\u0643"): "\u06a9",  # ARABIC KAF        -> KEHEH
    ord("\u0629"): "\u0647",  # TEH MARBUTA       -> HEH
    ord("\u06c0"): "\u0647",  # HEH WITH YEH      -> HEH
    ord("\u0623"): "\u0627",  # ALEF WITH HAMZA   -> ALEF
    ord("\u0625"): "\u0627",  # ALEF WITH HAMZA B -> ALEF
    ord("\u0622"): "\u0627",  # ALEF WITH MADDA   -> ALEF
    ord("\u0624"): "\u0648",  # WAW WITH HAMZA    -> WAW
    ord("\u0626"): "\u06cc",  # YEH WITH HAMZA    -> FARSI YEH
    ord("\u0640"): "",        # TATWEEL (kashida) -> drop
}

# Characters we simply delete: ZWJ/ZWNJ/BOM/soft hyphen
_DROP = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u200e\u200f\ufeff\u00ad"), None)

_WS = re.compile(r"\s+", re.UNICODE)

# Persian/Arabic-Indic digits anywhere in a string
_PERSIAN_DIGITS = re.compile(r"[0-9\u0660-\u0669\u06f0-\u06f9\u066b\u066c\u066a]")


def norm_text(value: object) -> str:
    """Canonicalise a Persian text cell. Idempotent."""
    if value is None:
        return ""
    s = str(value)
    s = unicodedata.normalize("NFC", s)
    s = s.translate(_DIGIT_MAP)
    s = s.translate(_LETTER_MAP)
    s = s.translate(_DROP)
    s = _WS.sub(" ", s)
    return s.strip()


def norm_key(value: object) -> str:
    """Aggressive form used only for identity/grouping (spacing + punctuation
    insensitive), so cosmetic re-spacing upstream never forks a place in two."""
    s = norm_text(value)
    s = s.replace("\u200c", " ")
    s = re.sub(r"[.،,؛;:!«»\"'()\[\]{}]", " ", s)
    # drop the purely-descriptive Persian prefixes used as a type marker
    s = re.sub(r"^(شهرستان|بخش|شهر|روستا|روستای|دهستان|ده|آبادی|تيره عشايري|تیره عشایری)\s+",
               "", s)
    s = re.sub(r"\bمرکزی\b|\bمركزي\b", "مرکزی", s)
    s = _WS.sub(" ", s)
    return s.strip().lower()


def to_int(value: object) -> int | None:
    """Parse a possibly Persian-digit, possibly float-formatted integer."""
    if value is None:
        return None
    s = norm_text(value).replace(",", "").replace("\u066c", "").replace("\u060c", "")
    if s in ("", "-", "—", "null", "None", "nan", "NaN"):
        return None
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def to_float(value: object) -> float | None:
    if value is None:
        return None
    s = norm_text(value).replace(",", "")
    if s in ("", "-", "—", "null", "None", "nan", "NaN", "inf", "-inf", "∞"):
        return None
    try:
        f = float(s)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


# --------------------------------------------------------------------------
# place classification
# --------------------------------------------------------------------------
_CITY_RE = re.compile(r"^(شهر|شهرک)\b")
_VILLAGE_RE = re.compile(
    r"^(روستا|روستاي|روستای|ده|دهستان|آبادی|آبادي|مزرعه|كانون|کانون|تیره عشایری|تيره عشايري)\b")


def classify_place(place: str, city_score: float | None = None) -> str:
    """'city' | 'village' | 'other' — based on the source's own name prefix.

    Verified against the Khuzestan snapshot: the ``شهر`` prefix marks the real
    cities (79 rows, avg population 45k, holding 889 of 914 pharmacies), while
    ``روستا`` rows are villages (2,168 rows, avg population 466, 24 pharmacies
    between them). The no-prefix remainder are village clusters / hamlets
    (avg population 96, 1 pharmacy).

    ``city_score`` (امتیاز شهر) is deliberately NOT used: the source populates
    it for 1,462 village rows as well, so it describes a location *tier*, not
    whether a place is a city. It is kept as a numeric field instead.
    """
    p = norm_text(place)
    if _CITY_RE.match(p):
        return "city"
    if _VILLAGE_RE.match(p):
        return "village"
    return "other"


# --------------------------------------------------------------------------
# keys
# --------------------------------------------------------------------------
def make_key(*parts: object) -> str:
    """Deterministic short key from normalised parts."""
    joined = "|".join(norm_key(p) for p in parts if p is not None)
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:16]


def loc_key(province: str, county: str, district: str, place: str) -> str:
    return make_key(province, county, district, place)
