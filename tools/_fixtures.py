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

import os
import shutil
import time

PREFIX = "آزمون"

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
SNAPS = os.path.join(HOME, "db", "snapshots")


def snapshot(keep: int = 12) -> str | None:
    """Copy the database before a test touches user data.

    The owner's annotations are not fixtures; if a test goes wrong the rows still exist in the
    last snapshot. Cheap (80 MB), and only twelve are kept.
    """
    if not os.path.exists(DB):
        return None
    # fold the write-ahead log into the main file first, otherwise the copy can miss the last
    # few commits and a «snapshot» would silently be older than the damage it is meant to undo
    import sqlite3
    try:
        con = sqlite3.connect(DB)
        con.execute("PRAGMA wal_checkpoint(FULL)")
        con.close()
    except Exception:
        pass
    os.makedirs(SNAPS, exist_ok=True)
    dst = os.path.join(SNAPS, time.strftime("%Y%m%d-%H%M%S.sqlite"))
    shutil.copy2(DB, dst)
    old = sorted(f for f in os.listdir(SNAPS) if f.endswith(".sqlite"))[:-keep]
    for f in old:
        os.remove(os.path.join(SNAPS, f))
    return dst


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
