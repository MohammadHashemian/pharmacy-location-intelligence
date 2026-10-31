"""List every table in a chapter with its caption and shape.

Word tables carry no reliable title of their own, so the caption is taken from the
nearest preceding non-empty paragraph — which is how these yearbook chapters label
their tables («جدول ۳-۱: ...»).

Usage: python etl/inspect_salname_tables.py 3 18 21
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


def walk_body(doc: Document):
    """Yield body items in document order (paragraphs and tables interleaved)."""
    body = doc.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            yield Paragraph(child, doc)
        elif tag == "tbl":
            yield Table(child, doc)


def main() -> int:
    nums = sys.argv[1:] or ["3"]
    for num in nums:
        path = chapter_docx(num)
        print(f"\n{'#'*78}\n# chapter {num}: {path}\n{'#'*78}")
        if not path:
            print("  not found")
            continue
        doc = Document(path)
        last_para = ""
        ti = 0
        for item in walk_body(doc):
            if isinstance(item, Paragraph):
                t = item.text.strip()
                if t:
                    last_para = t
                continue
            ti += 1
            t = item
            nrows, ncols = len(t.rows), len(t.columns)
            cap = last_para[:110] if last_para else "(no preceding caption)"
            print(f"\n  T{ti} [{nrows}r x {ncols}c]  caption: {cap}")
            # print up to 3 rows, cells trimmed
            for r in t.rows[:3]:
                cells = [c.text.strip().replace("\n", " ")[:22] for c in r.cells]
                print(f"      {(' | '.join(cells))[:170]}")
            if nrows > 3:
                print(f"      … {nrows-3} more rows")
        print(f"\n  total tables: {ti}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
