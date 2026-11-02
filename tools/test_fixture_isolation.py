"""A test must never delete what it did not create.

`tools/_fixtures.py` exists because two tests cleaned up by enumerating every row the API
returned — that wiped seven surveyed areas and the visit list in production data.

    python tools/test_fixture_isolation.py

It plants a row that looks like the owner's work, runs the shared sweep, and asserts the row
survives; then it removes its own fixture.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _fixtures import PREFIX, is_fixture, sweep  # noqa: E402

BASE = "http://localhost:3737"


def api(path: str, body: dict | None = None, method: str | None = None) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main() -> int:
    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        ok = ok and cond

    poly = [[31.30, 48.66], [31.31, 48.66], [31.31, 48.67]]
    owner = api("/api/surveys", {"name": "محدودهٔ مالکِ حساب", "points": poly}, "POST")
    fixture = api("/api/surveys", {"name": f"{PREFIX} موقت", "points": poly}, "POST")

    check("the guard recognises its own rows", is_fixture(f"{PREFIX} هرچیز") is True)
    check("and nothing else", is_fixture("محدودهٔ مالکِ حساب") is False)

    before = {a["id"]: a["name"] for a in api("/api/surveys")["items"]}
    gone = sweep(api, "/api/surveys")
    after = {a["id"]: a["name"] for a in api("/api/surveys")["items"]}

    check("the sweep removed the fixture", fixture["id"] not in after, f"{gone} row(s)")
    check("the owner's row is untouched", owner["id"] in after, after.get(owner["id"], "MISSING"))
    check("nothing else disappeared", all(i in after for i in before if i != fixture["id"]),
          f"{len(before)} → {len(after)}")

    api(f"/api/surveys?id={owner['id']}", method="DELETE")

    print("\nRESULT:", "cleanup cannot reach the owner's data" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
