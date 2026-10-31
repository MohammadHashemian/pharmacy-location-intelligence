"""Convert the yearbook's legacy .doc chapters to .docx via Word COM.

Why not the PDFs: their text layer is bad OCR from old typewriter-era census
tables — جمعيت.pdf yields strings like «ععومی فوس مسکن ربا ما ون» where the
source says «عمومی نفوس و مسکن». Parsing that would bake garbage into the
database. The .doc chapters carry real Unicode text and real Word tables.

Why Word COM rather than antiword: antiword loses table structure, and these
chapters ARE tables. Table structure is the whole point — a population table read
as a flat text stream cannot be attributed to a city.

Idempotent: skips a chapter whose .docx already exists and is newer.
"""
from __future__ import annotations

import os
import sys
import time

import win32com.client as win32
from win32com.client import gencache

BASE = os.path.join("data", "raw", "salname", "ex")
WD_FORMAT_XML_DOCUMENT = 16  # wdFormatXMLDocument -> .docx


def doc_chapters() -> list[str]:
    """Paths of .doc (not .docx) chapter files."""
    out: list[str] = []
    for root, _dirs, files in os.walk(BASE):
        for f in files:
            if f.lower().endswith(".doc"):  # excludes .docx
                out.append(os.path.join(root, f))
    return sorted(out)


def main() -> int:
    todo = []
    for src in doc_chapters():
        dst = os.path.splitext(src)[0] + ".docx"
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            continue
        todo.append((src, dst))
    print(f"{len(doc_chapters())} legacy .doc chapters, {len(todo)} to convert")
    if not todo:
        return 0

    gencache.EnsureModule("{00020905-0000-0000-C000-000000000046}", 0, 8, 7)
    word = win32.gencache.EnsureDispatch("Word.Application")
    word.Visible = False
    try:
        word.DisplayAlerts = 0
    except Exception:
        pass
    # Two chapters (جمعيت, محیط زیست) are nFib=193 (Word 97) yet still refused with
    # "Office has detected a problem with this file" — that is Office FILE
    # VALIDATION, not File Block (there is no MOTW on them). msoFileValidationSkip
    # (1) is the documented switch and opens them. Without it those two chapters
    # — including the population one — are silently skipped.
    try:
        word.FileValidation = 1
    except Exception as e:
        print(f"  warning: could not skip file validation: {e}")
    try:
        for i, (src, dst) in enumerate(todo, 1):
            src_abs = os.path.abspath(src)
            dst_abs = os.path.abspath(dst)
            t0 = time.time()
            doc = None
            try:
                doc = word.Documents.Open(src_abs, ReadOnly=True,
                                          AddToRecentFiles=False,
                                          ConfirmConversions=False)
                doc.SaveAs2(dst_abs, FileFormat=WD_FORMAT_XML_DOCUMENT)
                n_tables = doc.Tables.Count
                n_paras = doc.Paragraphs.Count
                print(f"  [{i}/{len(todo)}] {os.path.basename(src)[:38]:<38} "
                      f"tables={n_tables:<4} paras={n_paras:<6} "
                      f"{time.time()-t0:.1f}s", flush=True)
            except Exception as e:
                print(f"  [{i}/{len(todo)}] {os.path.basename(src)[:38]:<38} "
                      f"FAILED {type(e).__name__}: {e}", flush=True)
            finally:
                if doc is not None:
                    try:
                        doc.Close(False)
                    except Exception:
                        pass
    finally:
        word.Quit()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
