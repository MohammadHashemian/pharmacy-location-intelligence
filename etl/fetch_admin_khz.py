"""Fetch the Persian-Wikipedia evidence used to complete the Khuzestan
administrative tree (province -> county -> bakhsh -> dehestan -> city/village).

Three payloads, all free (CC BY-SA) and all cached under data/raw/wiki/ so the
loader can be re-run offline and a re-fetch is a new observation, not an
overwrite:

  * ``counties``  — every «شهرستان X» article. Its «تقسیمات کشوری» table is the
    only public source that states bakhsh/dehestan/city **with their 1395
    census populations** in one place, including for rural districts whose own
    article is a stub.
  * ``cities``    — the «فهرست شهرهای استان خوزستان» table (city|county|bakhsh|pop).
  * ``villages``  — every page in «رده:روستاهای شهرستان ...», whose
    {{جعبه اطلاعات روستای ایران}} infobox carries استان/شهرستان/بخش/دهستان and
    the village population. This is the only per-village hierarchy that exists.

Usage:
    python etl/fetch_admin_khz.py [--refresh]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

API = "https://fa.wikipedia.org/w/api.php"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "data", "raw", "wiki")

UA = "pharmacy-location-intelligence/1.0 (Khuzestan admin ETL; contact: local)"


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Encoding": "gzip"})
    return s


S = session()


def api(**params):
    params.setdefault("format", "json")
    params.setdefault("formatversion", "2")
    params.setdefault("maxlag", "5")
    for attempt in range(10):
        try:
            r = S.get(API, params=params, timeout=60)
            if r.status_code in (429, 503):
                # Wikipedia asks us to slow down; honour Retry-After when given.
                time.sleep(float(r.headers.get("Retry-After") or 5) + attempt)
                continue
            r.raise_for_status()
            time.sleep(0.5)  # stay well under the API rate limit
            return r.json()
        except Exception:
            if attempt == 9:
                raise
            time.sleep(3 * (attempt + 1))


def category_pages(cat: str, types: str = "page") -> list[str]:
    out, cont = [], {}
    while True:
        d = api(action="query", list="categorymembers", cmtitle=cat,
                cmlimit="500", cmtype=types, **cont)
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" in d:
            cont = d["continue"]
        else:
            return out


def wikitext(titles: list[str]) -> dict[str, str]:
    """Fetch raw wikitext for up to 50 titles per call."""
    got: dict[str, str] = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        d = api(action="query", prop="revisions", rvprop="content",
                rvslots="main", titles="|".join(chunk), redirects="1")
        for p in d["query"]["pages"]:
            if "revisions" in p:
                got[p["title"]] = p["revisions"][0]["slots"]["main"]["content"]
        time.sleep(0.15)
    return got


def sha(blob: str) -> str:
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def save(name: str, payload: dict, observed_at: str) -> None:
    os.makedirs(RAW, exist_ok=True)
    payload = dict(payload, observed_at=observed_at,
                   sha256=sha(json.dumps(payload["pages"], ensure_ascii=False,
                                         sort_keys=True)))
    path = os.path.join(RAW, f"{name}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    print(f"  {name}: {len(payload['pages'])} pages -> {path}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true",
                    help="refetch even when a payload already exists")
    args = ap.parse_args()
    observed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    jobs = {
        "counties": category_pages("رده:شهرستان‌های استان خوزستان", "page"),
        "cities": category_pages("رده:شهرهای استان خوزستان", "page"),
    }
    village_subs = category_pages("رده:روستاهای استان خوزستان", "subcat")
    villages = []
    for sub in village_subs:
        villages += category_pages(sub, "page")
    jobs["villages"] = sorted(set(villages))
    jobs["counties"] = [t for t in jobs["counties"] if not t.startswith("فهرست")]

    for name, titles in jobs.items():
        path = os.path.join(RAW, f"{name}.json")
        if os.path.exists(path) and not args.refresh:
            print(f"  {name}: cached, skip", flush=True)
            continue
        print(f"  {name}: {len(titles)} titles", flush=True)
        save(name, {"pages": wikitext(titles)}, observed_at)

    # the hand-maintained city table, kept as wikitext too (it is one page and
    # its columns are richer than the category: county + bakhsh + population)
    list_path = os.path.join(RAW, "cities_list.json")
    if args.refresh or not os.path.exists(list_path):
        page = "فهرست شهرهای استان خوزستان"
        save("cities_list", {"pages": wikitext([page])}, observed_at)

    print("\nvillage subcategories:", len(village_subs), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
