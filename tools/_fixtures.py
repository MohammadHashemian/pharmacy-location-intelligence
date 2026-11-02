"""Test fixtures must be findable, and nothing else may be deleted.

A test that cleans up with

    for it in api("/api/surveys")["items"]:
        api(f"/api/surveys?id={it['id']}", method="DELETE")

deletes the user's work as well as its own. That is exactly what happened: seven surveyed
areas and the visit list were wiped by `test_survey_rename.py` and `test_visitlist.py`.

Every fixture this repository creates now starts with `PREFIX`, and cleanup goes through
`sweep()`, which refuses to touch a row it did not name.
"""
from __future__ import annotations

PREFIX = "آزمون"


def is_fixture(name: str | None) -> bool:
    return bool(name) and str(name).startswith(PREFIX)


def sweep(api, path: str, key: str = "items") -> int:
    """Delete only rows whose name starts with PREFIX. Returns how many went."""
    gone = 0
    for it in api(path).get(key, []):
        if not is_fixture(it.get("name")):
            continue
        api(f"{path}?id={it['id']}", method="DELETE")
        gone += 1
    return gone


def assert_untouched(before: dict[int, str], after: dict[int, str]) -> list[str]:
    """Rows that existed before a test and are gone after it."""
    return [n for i, n in before.items() if i not in after]
