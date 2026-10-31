"""Survey the Khuzestan 1403 yearbook: what tables does each chapter actually hold?

The archive is 24 chapters x (.doc + .pdf). The .doc carries real table structure
(Word COM -> .docx -> python-docx), which beats scraping the PDF text layer, but
24 chapters is a lot to convert blind. This reads only the PDF text to map every
chapter's table captions («جدول ...»), then we convert just the chapters that
carry what the pharmacy model needs.

Writes the full map to data/raw/salname/survey.txt so it survives truncation.
"""
from __future__ import annotations

import os
import re
import sys

import fitz  # PyMuPDF

BASE = os.path.join("data", "raw", "salname", "ex")
OUT = os.path.join("data", "raw", "salname", "survey.txt")

CAPTION = re.compile(r"^\s*(جدول|نمودار|شكل|شکل)\s*[۰-۹0-9\-–]*")


def chapters() -> list[tuple[str, str, str]]:
    """-> [(chapter_no, chapter_title, pdf_path)] sorted numerically."""
    found: list[tuple[str, str, str]] = []
    for root, dirs, files in os.walk(BASE):
        for f in files:
            if not f.lower().endswith(".pdf"):
                continue
            parts = root.split(os.sep)
            # .../سالنامه 1403/<n>/<title>.pdf
            num = next((p for p in reversed(parts) if p.isdigit()), None)
            title = os.path.splitext(f)[0].strip()
            if num:
                found.append((num, title, os.path.join(root, f)))
    return sorted(found, key=lambda t: int(t[0]))


def main() -> int:
    lines: list[str] = []
    rows: list[tuple[int, str, int, int]] = []

    for num, title, path in chapters():
        doc = fitz.open(path)
        npages = doc.page_count
        caps: list[str] = []
        for page in doc:
            text = page.get_text("text")
            for ln in text.splitlines():
                ln = ln.strip()
                if CAPTION.match(ln) and 3 < len(ln) < 160:
                    caps.append(ln)
        doc.close()
        # de-duplicate while keeping order
        seen: set[str] = set()
        uniq = [c for c in caps if not (c in seen or seen.add(c))]
        rows.append((int(num), title, npages, len(uniq)))
        lines.append(f"\n{'='*78}\nفصل {num} — {title}   ({npages} pages, {len(uniq)} captions)\n{'='*78}")
        for c in uniq[:40]:
            lines.append(f"   {c}")
        if len(uniq) > 40:
            lines.append(f"   … +{len(uniq)-40} more")

    lines.append(f"\n\n{'='*78}\nSUMMARY\n{'='*78}")
    for num, title, npages, ncaps in rows:
        lines.append(f"  {num:>2}. {title:<34} {npages:>3}p  {ncaps:>3} captions")

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print("\n".join(lines[-30:]))
    print(f"\nfull map -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
