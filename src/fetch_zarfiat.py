"""
FDA Iran pharmacy-capacity ("ظرفیت") extractor.

Pulls every row of the public report behind
    https://pharmacy.fda.gov.ir/nemayeshZarfiatShahrSearch
by calling the same JSON endpoint the Angular/Kendo page calls:

    GET /app/api/TaghsimatKeshvari/GetVaziatShowShahrestanAndOStanQueryAsync
        ?take=<n>&skip=<n>&page=1&pageSize=<n>
        &sort[0][field]=ShahrID&sort[0][dir]=asc

Two transports:
  * playwright (default) - drives a real Chromium page on the site and issues the
    request *from inside the page context* (same origin, same cookies, same TLS/JA3
    fingerprint as a human browsing the report). Best camouflage / least likely to
    be blocked.
  * http - plain requests session, used as a fallback or for quick re-pulls.

The endpoint's natural (unsorted) ordering is NON-deterministic between calls, so
paging with skip only works when an explicit sort is supplied. We always sort by
ShahrID ascending, which is verified deterministic.

Output: one JSON file per page under data/raw/zarfiat_pages/, plus a manifest.
Re-running resumes: pages already on disk are skipped unless --force.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://pharmacy.fda.gov.ir"
PAGE_URL = f"{BASE}/nemayeshZarfiatShahrSearch"
API_PATH = "/app/api/TaghsimatKeshvari/GetVaziatShowShahrestanAndOStanQueryAsync"

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "zarfiat_pages"
MANIFEST = ROOT / "data" / "raw" / "zarfiat_manifest.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")


def page_url(take: int, skip: int) -> str:
    return (f"{BASE}{API_PATH}?take={take}&skip={skip}&page=1&pageSize={take}"
            f"&sort%5B0%5D%5Bfield%5D=ShahrID&sort%5B0%5D%5Bdir%5D=asc")


# --------------------------------------------------------------------------- #
# transports
# --------------------------------------------------------------------------- #
def find_local_chromium() -> str | None:
    """Locate an already-downloaded Chromium build under %LOCALAPPDATA%\\ms-playwright."""
    roots = []
    la = os.environ.get("LOCALAPPDATA")
    if la:
        roots.append(Path(la) / "ms-playwright")
    roots.append(Path.home() / "AppData" / "Local" / "ms-playwright")

    pats = [
        ("chromium-*", "chrome-win*/chrome.exe"),
        ("chromium_headless_shell-*", "chrome-headless-shell-win64/chrome-headless-shell.exe"),
        ("chromium-*", "chrome-win*/headless_shell.exe"),
    ]
    for root in roots:
        if not root.exists():
            continue
        for dir_pat, exe_pat in pats:
            for d in sorted(root.glob(dir_pat), reverse=True):
                for hit in d.glob(exe_pat):
                    return str(hit)
    return None


class PlaywrightTransport:
    """Issues the API call from inside a real page on the target origin."""

    def __init__(self, headless: bool = True, slow_mo: int = 0):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        args = ["--disable-blink-features=AutomationControlled"]

        # The bundled browser build may not match the installed python package.
        # Reuse whatever Chromium is already on this machine before downloading.
        exe = find_local_chromium()
        if exe:
            self.browser = self._pw.chromium.launch(
                headless=headless, slow_mo=slow_mo, executable_path=exe, args=args)
        else:
            self.browser = self._pw.chromium.launch(
                headless=headless, slow_mo=slow_mo, args=args)
        self.ctx = self.browser.new_context(
            user_agent=UA, locale="fa-IR",
            viewport={"width": 1440, "height": 900},
            extra_http_headers={
                "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
                "Referer": PAGE_URL,
            },
        )
        self.page = self.ctx.new_page()
        self.page.goto(PAGE_URL, wait_until="domcontentloaded", timeout=90_000)

    def get(self, url: str, timeout_ms: int = 900_000) -> dict:
        expr = """
        async (u) => {
          const r = await fetch(u, {
            method: 'GET',
            credentials: 'include',
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'X-Requested-With': 'XMLHttpRequest'
            }
          });
          const t = await r.text();
          return {status: r.status, body: t};
        }
        """
        res = self.page.evaluate(expr, url)
        if res["status"] != 200:
            raise RuntimeError(f"HTTP {res['status']} for {url}")
        return json.loads(res["body"])

    def close(self):
        try:
            self.browser.close()
        finally:
            self._pw.stop()


class HttpTransport:
    def __init__(self):
        import requests

        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
            "Referer": PAGE_URL,
            "X-Requested-With": "XMLHttpRequest",
        })

    def get(self, url: str, timeout_ms: int = 900_000) -> dict:
        r = self.s.get(url, timeout=timeout_ms / 1000)
        r.raise_for_status()
        return r.json()

    def close(self):
        self.s.close()


# --------------------------------------------------------------------------- #
# driver
# --------------------------------------------------------------------------- #
def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {}


def save_manifest(m: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_all(take: int = 5000, transport: str = "playwright",
              max_pages: int | None = None, force: bool = False,
              headless: bool = True, retries: int = 4) -> dict:
    RAW.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest()
    manifest.setdefault("endpoint", API_PATH)
    manifest.setdefault("sort", "ShahrID asc")
    manifest.setdefault("pages", {})

    tp = PlaywrightTransport(headless=headless) if transport == "playwright" else HttpTransport()
    print(f"[fetch] transport={transport} take={take} -> {RAW}", flush=True)

    fetched = 0
    skip = 0
    total = None
    try:
        while True:
            if max_pages is not None and fetched >= max_pages:
                print(f"[fetch] reached --max-pages={max_pages}, stopping", flush=True)
                break

            out = RAW / f"page_{skip:07d}.json"
            if out.exists() and not force:
                rec = json.loads(out.read_text(encoding="utf-8"))
                if total is None:
                    total = rec["data"]["count"]
                n = len(rec["data"]["records"])
                print(f"[fetch] skip={skip:>7} cached ({n} rows)", flush=True)
                fetched += 1
                skip += take
                continue

            url = page_url(take, skip)
            last_err = None
            for attempt in range(1, retries + 1):
                t0 = time.time()
                try:
                    payload = tp.get(url)
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    wait = min(60, 5 * attempt)
                    print(f"[fetch] skip={skip} attempt {attempt}/{retries} failed: {e}"
                          f" -> retry in {wait}s", flush=True)
                    time.sleep(wait)
                    if transport == "playwright" and attempt == 2:
                        try:
                            tp.page.goto(PAGE_URL, wait_until="domcontentloaded",
                                         timeout=90_000)
                        except Exception:
                            pass
            else:
                raise RuntimeError(f"giving up on skip={skip}: {last_err}")

            records = payload.get("data", {}).get("records", [])
            total = payload.get("data", {}).get("count", total)
            out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            manifest["pages"][str(skip)] = {
                "file": out.name, "rows": len(records),
                "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "seconds": round(time.time() - t0, 1),
            }
            manifest["total_count"] = total
            manifest["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            save_manifest(manifest)

            print(f"[fetch] skip={skip:>7} rows={len(records):>5} "
                  f"total={total} ({time.time() - t0:.0f}s)", flush=True)
            fetched += 1
            if not records:
                break
            skip += take
            if total is not None and skip >= total:
                break
    finally:
        tp.close()

    manifest["pages_fetched"] = fetched
    save_manifest(manifest)
    print(f"[fetch] done. pages={fetched} total={total}", flush=True)
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--take", type=int, default=5000)
    ap.add_argument("--transport", choices=["playwright", "http"], default="playwright")
    ap.add_argument("--max-pages", type=int, default=None)
    ap.add_argument("--force", action="store_true", help="re-download cached pages")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    args = ap.parse_args()

    fetch_all(take=args.take, transport=args.transport, max_pages=args.max_pages,
              force=args.force, headless=not args.headed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
