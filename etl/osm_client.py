"""Shared Overpass client for the geographic layers.

Why this exists instead of plain `curl`: the mirrors disagree. Measured on the
Khuzestan place inventory (2026-10):

  * `overpass-api.de`            — returns 406/500 on some long queries, but
                                   serves the big `out center tags;` payload fine
  * `overpass.kumi.systems`      — 500 on the same big payload
  * `overpass.private.coffee`    — slow but answers

So the client tries every mirror, accepts only a JSON body that actually has
`elements`, and records which mirror answered (provenance).

Gotcha that cost the first attempt: the **area id is 3600000000 + relation id**.
Khuzestan is OSM relation 3661581, so the area is `3603661581` — writing
`36003661581` (one digit too many) does not error, it silently returns **zero
elements**, which is far more dangerous than a failure.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "pharmacy-locintel/1.0 (local research; OSM data (c) OpenStreetMap contributors, ODbL)"

# OSM relation for استان خوزستان (ISO 3166-2 IR-06); the Overpass *area* id is
# 3600000000 + this id.
KHUZESTAN_REL = 3661581
KHUZESTAN_AREA = 3_600_000_000 + KHUZESTAN_REL


def fetch_query(query: str, timeout: int = 600, verbose: bool = True) -> dict:
    """POST a query to every mirror until one returns parseable elements."""
    last = None
    for url in MIRRORS:
        for pause in (0, 15, 45):
            if pause:
                time.sleep(pause)
            try:
                req = urllib.request.Request(
                    url,
                    data=urllib.parse.urlencode({"data": query}).encode(),
                    headers={"User-Agent": UA},
                )
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    body = r.read().decode("utf-8", "replace")
                if body.lstrip().startswith("{"):
                    payload = json.loads(body)
                    if payload.get("elements") is not None:
                        payload["_fetch"] = {"mirror": url, "fetched_at": _now()}
                        if verbose:
                            print(f"    {url.split('/')[2]} -> "
                                  f"{len(payload['elements']):,} elements")
                        return payload
                last = f"{url} -> non-JSON body ({len(body)} bytes)"
            except Exception as exc:  # noqa: BLE001
                last = f"{url} -> {type(exc).__name__}: {exc}"
            if verbose:
                print(f"    retry: {last}", file=sys.stderr)
    raise RuntimeError(f"all Overpass mirrors failed; last: {last}")


def cached_fetch(query: str, out_path, force: bool = False, verbose: bool = True) -> dict:
    """Fetch once, keep the raw payload on disk, reuse it afterwards."""
    from pathlib import Path

    out = Path(out_path)
    if out.exists() and not force:
        payload = json.loads(out.read_text(encoding="utf-8"))
        if verbose:
            print(f"    cached: {out.name} "
                  f"({len(payload.get('elements', [])):,} elements)")
        return payload
    payload = fetch_query(query, verbose=verbose)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    if verbose:
        print(f"    wrote {out}")
    return payload


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
