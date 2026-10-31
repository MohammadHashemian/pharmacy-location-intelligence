"""Extract the two chapters Word refuses to open.

Word's File Block rejects جمعيت.doc and محیط زیست.doc ("Office has detected a
problem with this file") — no MOTW is present, so this is legacy-format
validation, not a security prompt. antiword reads those old formats. The earlier
antiword attempt failed only because the Persian path was mangled by the shell;
here every path is passed as a real argument, never through a shell string.

Also retries Word on an ASCII copy of the file, in case the Persian path is
implicated.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.path.join("data", "raw", "salname", "ex")
TMP = os.path.join("data", "raw", "salname", "tmp")
TARGETS = ["جمعيت.doc", "محیط زیست.doc"]


def find(name: str) -> str | None:
    for root, _d, files in os.walk(BASE):
        for f in files:
            if f == name:
                return os.path.join(root, f)
    return None


def run(argv: list[str], timeout: int = 240) -> tuple[int, bytes, bytes]:
    p = subprocess.run(argv, capture_output=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def main() -> int:
    os.makedirs(TMP, exist_ok=True)
    for name in TARGETS:
        src = find(name)
        if not src:
            print(f"!! not found: {name}")
            continue
        print(f"\n{'='*70}\n{name}\n{'='*70}")
        print(f"  path: {src}")
        print(f"  size: {os.path.getsize(src):,}")

        # ---- 1. ASCII copy, then Word again -----------------------------
        ascii_path = os.path.join(TMP, os.path.splitext(name)[0].encode(
            "ascii", "ignore").decode() or "doc", )
        stem = "ch" + str(abs(hash(name)) % 1000)
        ascii_path = os.path.join(TMP, stem + ".doc")
        shutil.copy2(src, ascii_path)
        print(f"  ascii copy: {ascii_path} ({os.path.getsize(ascii_path):,} bytes)")

        rc, out, err = run(["antiword", "-m", "UTF-8.txt", src])
        txt = out.decode("utf-8", "replace")
        print(f"  antiword: exit={rc} chars={len(txt)} "
              f"err={err.decode('utf-8','replace').strip()[:120]}")
        if len(txt) > 500:
            with open(os.path.join(TMP, stem + ".antiword.txt"), "w",
                      encoding="utf-8") as fh:
                fh.write(txt)
            head = [ln for ln in txt.splitlines() if ln.strip()][:12]
            print("  --- first non-empty lines ---")
            for ln in head:
                print("   |", ln[:150])

        rc2, out2, err2 = run(["antiword", "-t", "-m", "UTF-8.txt", src])
        txt2 = out2.decode("utf-8", "replace")
        print(f"  antiword -t: exit={rc2} chars={len(txt2)}")
        if len(txt2) > 500:
            with open(os.path.join(TMP, stem + ".antiword.tab.txt"), "w",
                      encoding="utf-8") as fh:
                fh.write(txt2)

    print(f"\nartifacts in {TMP}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
