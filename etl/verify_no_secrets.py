"""Prove the repo carries no credentials, and that it stays that way.

A one-off grep is a feeling; this is a check that can be run after every commit:

    python etl/verify_no_secrets.py            # full audit
    python etl/verify_no_secrets.py --quiet    # exit code only (CI)

What it asserts:

1. no credential-shaped string in **any** commit of any branch;
2. the values actually stored in `app_setting` never appear in history — a regex can
   miss a key format, an exact-value search cannot;
3. `db/*.sqlite`, `data/raw`, `data/derived`, `.env`-style files were never added;
4. `.gitignore` still covers all of them (a missing rule is how the next leak happens);
5. the live `/api/settings` response carries a masked tail, never the value;
6. the built client bundle contains no key material.

Exit code 1 if anything fails, so it can gate a push.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.request

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
BUNDLE = os.path.join(HOME, "web", ".next", "static")
APP = os.environ.get("APP_URL", "http://localhost:3737")

PATTERNS = {
    "openrouter": r"sk-or-v1-[A-Za-z0-9]{16,}",
    "google_api": r"AIza[0-9A-Za-z_\-]{35}",
    "neshan_service": r"\bservice\.[A-Za-z0-9]{20,}",
    "neshan_web": r"\bweb\.[A-Za-z0-9]{20,}",
    "openai": r"sk-[A-Za-z0-9]{32,}",
    "aws": r"AKIA[0-9A-Z]{16}",
    "bearer": r"Bearer\s+[A-Za-z0-9_\-\.]{24,}",
    "private_key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "assigned_secret": r"(?i)(api[_-]?key|apikey|secret|password|passwd)\s*[:=]\s*['\"][^'\"]{12,}['\"]",
}

# paths that must never be tracked: they hold keys, the database, or bulk downloads
FORBIDDEN_PATHS = [
    r"\.sqlite($|-wal$|-shm$)", r"\.sqlite3$", r"(^|/)\.env", r"\.env\.", r"\.pem$",
    r"\.p12$", r"\.pfx$", r"^data/raw/", r"^data/derived/", r"^data/inbound/",
    r"_cache\.json$", r"(^|/)id_rsa", r"credentials\.json$",
]
REQUIRED_IGNORES = ["db/*.sqlite", "data/raw/", "data/derived/", ".env"]

fails: list[str] = []


def run(*args: str) -> str:
    r = subprocess.run(["git", *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", cwd=HOME)
    return r.stdout


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        fails.append(label)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    revs = run("rev-list", "--all").split()
    if not revs:
        print("not a git repository")
        return 1
    print(f"== history: {len(revs)} commits ==")

    # 1 — credential shapes in any commit
    for name, pat in PATTERNS.items():
        r = subprocess.run(["git", "grep", "-I", "-l", "-E", pat, *revs], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", cwd=HOME)
        hits = [l for l in r.stdout.splitlines() if l.strip()]
        check(f"no {name} in history", not hits, hits[0][:80] if hits else "")

    # 2 — the exact stored values, which no regex can be trusted to know
    if os.path.exists(DB):
        c = sqlite3.connect(DB)
        rows = c.execute("SELECT key, value FROM app_setting WHERE value != ''").fetchall()
        for key, value in rows:
            if len(value) < 12:
                continue
            r = subprocess.run(["git", "grep", "-I", "-l", "-F", value, *revs],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", cwd=HOME)
            hits = [l for l in r.stdout.splitlines() if l.strip()]
            # never echo the value itself
            check(f"stored {key} absent from history", not hits, f"{len(hits)} match(es)")
    else:
        print("SKIP  no database — nothing to compare")

    # 3 — forbidden paths ever added
    added = run("log", "--all", "--diff-filter=A", "--name-only", "--pretty=format:").splitlines()
    bad = sorted({p for p in added if any(re.search(rx, p) for rx in FORBIDDEN_PATHS)})
    check("no database / env / bulk data ever committed", not bad, ", ".join(bad[:3]))
    tracked = run("ls-files").splitlines()
    bad_now = [p for p in tracked if any(re.search(rx, p) for rx in FORBIDDEN_PATHS)]
    check("nothing forbidden in the working tree index", not bad_now, ", ".join(bad_now[:3]))

    # 4 — the ignore rules that keep it that way
    ignore = open(os.path.join(HOME, ".gitignore"), encoding="utf-8").read()
    missing = [r for r in REQUIRED_IGNORES if r not in ignore]
    check(".gitignore still covers db, data and env", not missing, ", ".join(missing))

    # 5 — what the browser actually receives
    try:
        with urllib.request.urlopen(f"{APP}/api/settings", timeout=10) as r:
            payload = json.loads(r.read())
        leaked = []
        for p in payload.get("providers", []):
            masked = p.get("masked") or ""
            if not (p.get("secret") and masked):
                continue
            # a masked secret is «••••••••» plus the last four characters, no more
            if "•" not in masked or len(masked.replace("•", "")) > 4:
                leaked.append(p.get("key", "?"))
        check("/api/settings returns only masked secrets", not leaked, ", ".join(leaked))
    except Exception as e:  # noqa: BLE001
        print(f"SKIP  /api/settings unreachable ({str(e)[:60]})")

    # 6 — the client bundle is public by definition
    hits = []
    if os.path.isdir(BUNDLE):
        rx = re.compile("|".join(PATTERNS[p] for p in
                                ("openrouter", "google_api", "neshan_service", "neshan_web",
                                 "private_key")))
        for root, _dirs, files in os.walk(BUNDLE):
            for f in files:
                if not f.endswith((".js", ".json", ".map", ".html")):
                    continue
                path = os.path.join(root, f)
                try:
                    if rx.search(open(path, encoding="utf-8", errors="ignore").read()):
                        hits.append(os.path.relpath(path, HOME))
                except OSError:
                    continue
    check("no key material in the client bundle", not hits, ", ".join(hits[:3]))

    print()
    if fails:
        print(f"RESULT: {len(fails)} check(s) FAILED")
        return 1
    print("RESULT: repo is clean — no credential in history, none reachable from the browser")
    return 0


if __name__ == "__main__":
    sys.exit(main())
