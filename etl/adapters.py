"""Ingest adapters: turn whatever the source gives us into a uniform row.

Two adapters ship today:

  * ``read_html``  — parses the saved FDA AngularJS/Kendo grid out of a
    client-rendered HTML page (the only offline artifact we have).
  * ``read_json``  — parses a JSON payload: a bare array, or any of the common
    API envelopes (``{data:[...]}``, ``{Data:[...],Total:n}``, Kendo's
    ``{data:[...],total:n}``).

Field names are resolved through ``FIELD_ALIASES`` so an upstream rename or a
Persian/English variant does not break the loader. **Any key that is not
recognised is preserved verbatim in ``extra``** — nothing is ever dropped, so a
future field upgrade is a re-parse away.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable, Iterator

from normalize import (
    classify_place,
    norm_key,
    norm_text,
    to_float,
    to_int,
)

PARSER_VERSION = "2.0.0"

# ---------------------------------------------------------------------------
# canonical field -> accepted source names (matched after norm_key())
# ---------------------------------------------------------------------------
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "province": ("OstanOnvan", "Ostan", "OstanName", "استان", "province"),
    "county": ("ShahrestanOnvan", "Shahrestan", "ShahrestanName", "شهرستان", "county"),
    "district": ("bakhshOnvan", "Bakhsh", "BakhshOnvan", "بخش", "district"),
    "place": ("shahrRoustaOnvan", "ShahrRousta", "ShahrRoustaOnvan", "شهر روستا",
              "شهر/روستا", "place", "city", "village"),
    "population": ("Jamiat", "JamiatOnvan", "Population", "جمعیت", "population", "pop"),
    "city_score": ("EmtiazShahr", "امتیاز شهر", "city_score"),
    "min_score": ("HadaghaleEmtiaz", "حداقل امتیاز", "min_score"),
    "n_pharmacy_real": ("CountDaroukhaneh", "تعداد داروخانه حقیقی", "n_pharmacy_real"),
    "n_pharmacy_legal": ("CountDaroukhanehHoghoghi", "تعداد داروخانه حقوقی",
                         "n_pharmacy_legal"),
    "n_req_registered": ("CountMoteghazi", "تعداد درخواست ثبت شده", "n_req_registered"),
    "n_req_inprogress": ("CountMoteghaziDarkhastDade",
                         "تعداد درخواست های درحال جریان", "n_req_inprogress"),
    "n_req_approved": ("CountMoteghaziDarkhastTaeedShode",
                       "تعداد موافقت اصولی صادر شده", "n_req_approved"),
    # The medical university that administers the place. Pharmacy permits are
    # granted per university catchment, so this is a first-class filter, not
    # trivia — it was previously only reachable inside the `extra` JSON bag.
    "university": ("OrganOnvan", "دانشگاه", "university", "organization"),
    "density_reported": ("ZaribHaghighi",
                         "نسبت تعداد داروخانه به جمعیت ضربدر یک میلیون",
                         "density_reported"),
}

# norm_key(alias) -> canonical field
_LOOKUP: dict[str, str] = {}
for _canon, _aliases in FIELD_ALIASES.items():
    for _a in _aliases:
        _LOOKUP.setdefault(norm_key(_a), _canon)

REQUIRED = ("province", "county", "place")

_HTML_NUMERIC_HINT = re.compile(r"^-?[\d\u0660-\u0669\u06f0-\u06f9.,]+$")

# any Persian/Arabic-script letter — used to spot names like "**" or "-"
_HAS_LETTER = re.compile(r"[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]")

# A population of this size must come with a real pharmacy market; when it does
# not, the upstream feed has almost certainly joined a metro population onto a
# small place (the «شهر تجريش» case: pop 8,154,051 with a single pharmacy).
POP_OUTLIER_MIN = 500_000
POP_OUTLIER_MIN_PHARMACIES = 20

# A place this large with no pharmacy AND no queued application at all is worth
# a second look before it is believed as a white space.
NO_ACTIVITY_MIN_POP = 20_000


def compute_dq_flags(place: str, population: int | None,
                     n_pharmacies: int, n_requests: int = 0) -> str | None:
    """Comma-separated data-quality warnings, or None when the row looks sane.

    Two tiers:
      * HARD flags (pop_outlier / pop_zero / bad_name) make the row unusable for
        ranking — its density and therefore its whole score would be nonsense.
      * SOFT flags (no_activity) only warn: the row is rankable but the user must
        eyeball it. `exclusionReason()` in the web app keys off the hard ones.
    """
    flags: list[str] = []
    if not _HAS_LETTER.search(place):
        flags.append("bad_name")
    if population is None or population <= 0:
        flags.append("pop_zero")
    elif population >= POP_OUTLIER_MIN and n_pharmacies < POP_OUTLIER_MIN_PHARMACIES:
        flags.append("pop_outlier")
    if (population or 0) >= NO_ACTIVITY_MIN_POP and n_pharmacies == 0 and n_requests == 0:
        # A real white space almost always shows queued applicants. A sizeable
        # place with no pharmacy AND no application AND no approval anywhere in
        # the feed may be an attribution gap rather than an opening — e.g.
        # «شهر مشکین دشت» (pop 53,440, 0/0/0), a satellite of Karaj whose
        # pharmacies are plausibly counted under the neighbouring city.
        flags.append("no_activity")
    return ",".join(flags) if flags else None


def _canon(key: str) -> str | None:
    return _LOOKUP.get(norm_key(key))


def map_record(raw: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Split an upstream record into (canonical fields, leftovers)."""
    fields: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    for k, v in raw.items():
        if k is None or str(k).startswith("_"):
            continue
        c = _canon(str(k))
        if c and c not in fields:
            fields[c] = v
        else:
            extra[str(k)] = v
    return fields, extra


def build_row(raw: dict[str, Any], observed_at: str,
              default_province: str | None = None) -> dict[str, Any] | None:
    """Turn one upstream record into the canonical row dict (or None to skip)."""
    f, extra = map_record(raw)

    province = norm_text(f.get("province")) or norm_text(default_province)
    county = norm_text(f.get("county"))
    district = norm_text(f.get("district"))
    place = norm_text(f.get("place"))

    # A handful of rows in the offline page have an empty place cell; fall back
    # to the county name rather than silently discarding a populated row.
    if not place:
        place = county or district
    if not province or not county or not place:
        return None

    city_score = to_float(f.get("city_score"))

    n_real = to_int(f.get("n_pharmacy_real")) or 0
    n_legal = to_int(f.get("n_pharmacy_legal")) or 0
    population = to_int(f.get("population"))

    row = {
        "province": province,
        "county": county,
        "district": district or county,
        "place": place,
        "place_kind": classify_place(place, city_score),
        "university": norm_text(f.get("university")) or None,
        "population": population,
        "city_score": city_score,
        "min_score": to_float(f.get("min_score")),
        "n_pharmacy_real": n_real,
        "n_pharmacy_legal": n_legal,
        "n_req_registered": to_int(f.get("n_req_registered")) or 0,
        "n_req_inprogress": to_int(f.get("n_req_inprogress")) or 0,
        "n_req_approved": to_int(f.get("n_req_approved")) or 0,
        "density_reported": to_float(f.get("density_reported")),
        "observed_at": observed_at,
        "dq_flags": compute_dq_flags(
            place, population, n_real + n_legal,
            (to_int(f.get("n_req_registered")) or 0)
            + (to_int(f.get("n_req_inprogress")) or 0)
            + (to_int(f.get("n_req_approved")) or 0),
        ),
        "extra": json.dumps(extra, ensure_ascii=False) if extra else None,
    }
    return row


# ---------------------------------------------------------------------------
# HTML adapter
# ---------------------------------------------------------------------------
_TR_SPLIT = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S | re.I)
_TD_SPLIT = re.compile(r"<td\b[^>]*>(.*?)</td>", re.S | re.I)
_TH_FIELD = re.compile(r'data-field="([^"]+)"')
_TAG = re.compile(r"<[^>]+>")


def _cell_text(html: str) -> str:
    return norm_text(_TAG.sub(" ", html))


def iter_html_records(html: str) -> Iterator[dict[str, Any]]:
    """Yield one dict per data row of the Kendo grid.

    Column names come from the ``data-field`` attributes on the header cells,
    not from positional guessing, so a column reorder or an added column
    upstream keeps working.
    """
    header_at = html.find("<thead")
    body_at = html.find("<tbody", header_at if header_at != -1 else 0)
    if header_at == -1 or body_at == -1:
        raise ValueError("no Kendo grid <thead>/<tbody> found in HTML")

    fields = _TH_FIELD.findall(html[header_at:body_at])
    if not fields:
        raise ValueError("grid header carried no data-field attributes")

    body = html[body_at:]
    end = body.find("</tbody>")
    if end != -1:
        body = body[:end]

    n = 0
    for inner in _TR_SPLIT.findall(body):
        cells = [_cell_text(c) for c in _TD_SPLIT.findall(inner)]
        if len(cells) < len(fields):
            continue
        n += 1
        yield dict(zip(fields, cells))
    if n == 0:
        raise ValueError("grid <tbody> contained no parsable rows")


def read_html(path: str, observed_at: str,
              default_province: str | None = None) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8", errors="replace") as fh:
        html = fh.read()
    rows = []
    for raw in iter_html_records(html):
        r = build_row(raw, observed_at, default_province)
        if r:
            rows.append(r)
    return rows


# ---------------------------------------------------------------------------
# JSON adapter
# ---------------------------------------------------------------------------
_ENVELOPE_KEYS = ("data", "Data", "result", "Result", "rows", "items",
                  "records", "list", "DataList", "d", "value")


def unwrap_json(payload: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (records, envelope_meta), accepting array or wrapped shapes."""
    meta: dict[str, Any] = {}

    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)], meta

    if isinstance(payload, dict):
        # Kendo / ASP.NET style envelope first
        for key in _ENVELOPE_KEYS:
            node = payload.get(key)
            if isinstance(node, list) and node and isinstance(node[0], dict):
                for mk in ("total", "Total", "count", "Count", "TotalCount"):
                    if mk in payload:
                        meta["total"] = payload[mk]
                return node, meta
            # {"d": {"data": [...]}} — double-wrapped
            if isinstance(node, dict):
                inner, m = unwrap_json(node)
                if inner:
                    meta.update(m)
                    return inner, meta
        # single record?
        if any(_canon(k) for k in payload):
            return [payload], meta

    raise ValueError("JSON payload is not a recognised record collection")


def read_json(path: str, observed_at: str,
              default_province: str | None = None) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8-sig", errors="replace") as fh:
        payload = json.load(fh)
    records, _meta = unwrap_json(payload)
    rows = []
    for raw in records:
        r = build_row(raw, observed_at, default_province)
        if r:
            rows.append(r)
    return rows


def read_any(path: str, observed_at: str, kind: str = "auto",
             default_province: str | None = None) -> list[dict[str, Any]]:
    if kind == "auto":
        kind = "json" if path.lower().endswith((".json", ".jsonl")) else "html"
    if kind == "json":
        return read_json(path, observed_at, default_province)
    if kind == "html":
        return read_html(path, observed_at, default_province)
    raise ValueError(f"unknown source kind: {kind!r}")
