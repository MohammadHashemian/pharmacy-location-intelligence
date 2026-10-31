"""Dump a chapter's tables in full (all rows/columns) for parser authoring.

Usage: python etl/dump_salname_table.py <chapter> [tableIndex ...]
"""
from __future__ import annotations

import os
import sys

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.join("data", "raw", "salname", "ex")


def chapter_docx(num: str) -> str | None:
    for root, _d, files in os.walk(BASE):
        for f in files:
            if f.lower().endswith(".docx") and os.path.basename(root) == num:
                return os.path.join(root, f)
    return None


def main() -> int:
    num = sys.argv[1]
    want = [int(x) for x in sys.argv[2:]]
    path = chapter_docx(num)
    if not path:
        print("chapter not found")
        return 1
    doc = Document(path)
    last = ""
    ti = 0
    for child in doc.element.body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            t = Paragraph(child, doc).text.strip()
            if t:
                last = t
            continue
        if tag != "tbl":
            continue
        ti += 1
        if want and ti not in want:
            continue
        tb = Table(child, doc)
        print(f"\n{'='*90}\nT{ti}  caption: {last[:150]}\n{'='*90}")
        for r in tb.rows:
            cells = [c.text.strip().replace("\n", " ") for c in r.cells]
            print("  " + " | ".join(cells)[:250])
    return 0


if __name__ == "__main__":
    sys.exit(main())
