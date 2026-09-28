"""Measure the OCR pipeline (app.ocr.tiling) against the ТЗ's own acceptance
numbers (Задание/10. Мосстройнадзор.pdf, p.16, п.1):

    "Character Accuracy = 1 - CER должна быть не ниже 0,95; Exact Match для
    ключевых полей ... - не ниже 0,90 ... Для расчёта CER применяется
    Unicode NFC и нормализация повторных пробелов; регистр может
    игнорироваться только для полей, где он не несёт смысла, а знаки в
    шифрах и редакциях не удаляются."

There is no hidden acceptance sample of scanned pages to measure against (the
ТЗ's own "скрытая фиксированная выборка" is the customer's, not ours) - this
tool substitutes the closest honest stand-in: reference PDFs that already
carry a real text layer (Задание/Комплект_предметной_разметки.pdf, the same
file services/worker's own tests and tests/e2e/make_reference_package.py
read real sheets from). Each chosen page is rasterized at OCR_DPI and run
through the exact same app.ocr.tiling.ocr_page a real scanned page would go
through; the OCR answer is then compared back against that page's own text
layer, which stands in for ground truth.

Character Accuracy is computed over the whole page's text (NFC, whitespace
collapsed, case kept, per the ТЗ quote above). Exact Match is scoped to the
one key field a page image can actually produce on its own - room/element
number and area (app.explication.parse.find_rooms) - not document metadata
(шифр, стадия, редакция) that never comes from OCR to begin with: it lives in
the registry, not on the page (app.domain.manifest).

Usage (from services/worker, with OCR_MODEL/OCR_BASE_URL set - a real call to
a real OCR model, not a fake):

    .venv/Scripts/python.exe -m tools.ocr_eval [--pages 19 20 21 22 11 12]
                                                [--strip-height-px 800]
                                                [--dpi 300]
"""

import argparse
import asyncio
import json
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # allow `python tools/ocr_eval.py` too

from app.config import load_config  # noqa: E402
from app.explication.parse import Room, find_rooms, room_key  # noqa: E402
from app.ocr.client import ocr_provider_from_config  # noqa: E402
from app.ocr.tiling import ocr_page  # noqa: E402
from app.pdf.extract import ExtractedBlock, ExtractedLine, ExtractedPage, extract_pages  # noqa: E402
from app.pdf.geometry import NormalizedBox  # noqa: E402

REFERENCE_PDF = Path(__file__).resolve().parents[3] / "Задание" / "Комплект_предметной_разметки.pdf"
REPORT_PATH = Path(__file__).resolve().parents[3] / "docs" / "quality" / "ocr-eval.json"

# 19-22 are the same explication sheets tests/e2e/make_reference_package.py
# cuts into the reference package (22 carries a room explication table, the
# ТЗ's own "не менее 6 страниц, включая страницу с экспликационной
# таблицей"); 11 and 12 add two dense, non-explication sheets for variety.
DEFAULT_PAGES = [11, 12, 19, 20, 21, 22]

_WHITESPACE_RE = re.compile(r"\s+")


def normalize_for_cer(text: str) -> str:
    """Unicode NFC + collapsed repeated whitespace, case kept - exactly the
    ТЗ's own CER normalization (p.16, п.1), no more: characters inside a
    шифр/редакция are never stripped, and case is never folded (this text is
    prose, not one of the case-insensitive fields the ТЗ carves out)."""
    return _WHITESPACE_RE.sub(" ", unicodedata.normalize("NFC", text)).strip()


def levenshtein(a: str, b: str) -> int:
    """Character-level edit distance, O(len(a)*len(b)) time / O(len(b)) space
    - reference pages here run a few hundred to a couple thousand characters,
    small enough that the classic DP table is plenty fast."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            current[j] = min(
                previous[j] + 1,       # deletion
                current[j - 1] + 1,    # insertion
                previous[j - 1] + cost,  # substitution
            )
        previous = current
    return previous[-1]


def character_accuracy(reference: str, hypothesis: str) -> tuple[float, int, int]:
    """1 - CER, plus (edit_distance, reference_length) so a caller can pool
    several pages' own numbers into one honest total instead of averaging
    already-averaged ratios."""
    ref = normalize_for_cer(reference)
    hyp = normalize_for_cer(hypothesis)
    if not ref:
        # Nothing to measure CER against - happens only for a page this
        # tool was pointed at that turns out to carry no real text layer,
        # never for any of DEFAULT_PAGES.
        return (1.0 if not hyp else 0.0), 0, 0
    distance = levenshtein(ref, hyp)
    accuracy = max(0.0, 1 - distance / len(ref))
    return accuracy, distance, len(ref)


def _text_layer_string(page: ExtractedPage) -> str:
    """The page's own text, in the same top-to-bottom reading order
    app.pdf.extract already produced it in (PyMuPDF's own block order)."""
    return "\n".join(line.text for block in page.blocks for line in block.lines)


def _synthetic_page_from_ocr(lines) -> ExtractedPage:
    """Rebuild the block/line shape app.explication.parse.find_rooms expects
    out of app.ocr.tiling's own OcrLine list - one block per strip
    (tile_no), exactly how app.pipeline._ocr_stored_pages stores them, so
    this tool's find_rooms comparison sees precisely what a real run would
    hand the parser, approximate boxes included."""
    by_tile: dict[int, list] = {}
    for line in lines:
        by_tile.setdefault(line.tile_no, []).append(line)

    blocks: list[ExtractedBlock] = []
    for tile_no in sorted(by_tile):
        tile_lines = sorted(by_tile[tile_no], key=lambda l: l.line_no)
        extracted_lines = [
            ExtractedLine(line_no=line.line_no, text=line.text, box=line.box)
            for line in tile_lines
        ]
        blocks.append(ExtractedBlock(
            block_no=tile_no,
            text="\n".join(l.text for l in extracted_lines),
            box=NormalizedBox(
                x0=min(l.box.x0 for l in extracted_lines), y0=min(l.box.y0 for l in extracted_lines),
                x1=max(l.box.x1 for l in extracted_lines), y1=max(l.box.y1 for l in extracted_lines),
            ),
            lines=extracted_lines,
        ))
    return ExtractedPage(
        page_no=0, width_pt=0.0, height_pt=0.0, rotation=0, char_count=0,
        needs_ocr=False, blocks=blocks,
    )


def _room_exact_match(reference_rooms: list[Room], ocr_rooms: list[Room]) -> tuple[int, int]:
    """(matched, total) - a reference room counts as matched only when the
    OCR-derived parse found a room with the exact same key (number, or
    scope+number when the number alone repeats - room_key) AND the exact
    same area, both post NFC/whitespace normalization for the number.
    Neither field is case-folded or otherwise relaxed - room numbers and
    areas are exactly the "номер помещения" / numeric field the ТЗ's own
    Exact Match targets, not a case-insensitive one.
    """
    if not reference_rooms:
        return 0, 0
    by_key = {room_key(room, ocr_rooms): room for room in ocr_rooms}
    matched = 0
    for room in reference_rooms:
        key = room_key(room, reference_rooms)
        candidate = by_key.get(key)
        if candidate is None:
            continue
        if normalize_for_cer(candidate.number) != normalize_for_cer(room.number):
            continue
        if candidate.area != room.area:
            continue
        matched += 1
    return matched, len(reference_rooms)


@dataclass
class PageResult:
    page_no: int
    quality_status: str | None
    elapsed_s: float
    ref_chars: int
    edit_distance: int
    char_accuracy: float
    ref_rooms: int
    matched_rooms: int
    exact_match: float | None


async def _evaluate_page(raw: bytes, page_no: int, provider, *, dpi: int, strip_height_px: int) -> PageResult:
    text_pages = extract_pages(raw)
    text_page = next(p for p in text_pages if p.page_no == page_no)
    reference_text = _text_layer_string(text_page)
    reference_rooms = find_rooms(text_page)

    started = time.monotonic()
    result = await ocr_page(raw, page_no, provider, dpi=dpi, strip_height_px=strip_height_px)
    elapsed_s = time.monotonic() - started

    ocr_text = "\n".join(
        line.text for line in sorted(result.lines, key=lambda l: (l.tile_no, l.line_no))
    )
    accuracy, distance, ref_len = character_accuracy(reference_text, ocr_text)

    ocr_page_obj = _synthetic_page_from_ocr(result.lines)
    ocr_rooms = find_rooms(ocr_page_obj)
    matched, total = _room_exact_match(reference_rooms, ocr_rooms)

    return PageResult(
        page_no=page_no, quality_status=result.quality_status, elapsed_s=elapsed_s,
        ref_chars=ref_len, edit_distance=distance, char_accuracy=accuracy,
        ref_rooms=total, matched_rooms=matched,
        exact_match=(matched / total) if total else None,
    )


def _print_table(results: list[PageResult]) -> None:
    header = f"{'page':>4} {'chars':>6} {'CER-acc':>8} {'rooms':>6} {'exact':>7} {'quality':>12} {'time_s':>8}"
    print(header)
    print("-" * len(header))
    for r in results:
        exact = f"{r.exact_match:.2f}" if r.exact_match is not None else "n/a"
        print(
            f"{r.page_no:>4} {r.ref_chars:>6} {r.char_accuracy:>8.4f} "
            f"{r.ref_rooms:>6} {exact:>7} {str(r.quality_status):>12} {r.elapsed_s:>8.1f}"
        )


def _totals(results: list[PageResult]) -> dict:
    total_ref_chars = sum(r.ref_chars for r in results)
    total_distance = sum(r.edit_distance for r in results)
    pooled_accuracy = (1 - total_distance / total_ref_chars) if total_ref_chars else None
    total_ref_rooms = sum(r.ref_rooms for r in results)
    total_matched_rooms = sum(r.matched_rooms for r in results)
    pooled_exact_match = (total_matched_rooms / total_ref_rooms) if total_ref_rooms else None
    mean_time_s = sum(r.elapsed_s for r in results) / len(results) if results else None
    return {
        "pages": len(results),
        "total_reference_chars": total_ref_chars,
        "pooled_character_accuracy": pooled_accuracy,
        "total_reference_rooms": total_ref_rooms,
        "total_matched_rooms": total_matched_rooms,
        "pooled_exact_match": pooled_exact_match,
        "mean_time_s": mean_time_s,
        "meets_character_accuracy_threshold": (pooled_accuracy or 0) >= 0.95,
        "meets_exact_match_threshold": (pooled_exact_match or 0) >= 0.90,
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=int, nargs="+", default=DEFAULT_PAGES)
    parser.add_argument("--dpi", type=int, default=None, help="defaults to OCR_DPI / Config.ocr_dpi")
    parser.add_argument("--strip-height-px", type=int, default=None,
                         help="defaults to OCR_STRIP_HEIGHT_PX / Config.ocr_strip_height_px")
    args = parser.parse_args()

    if not REFERENCE_PDF.exists():
        print(f"reference package not found: {REFERENCE_PDF}", file=sys.stderr)
        raise SystemExit(1)

    config = load_config()
    provider = ocr_provider_from_config(config)
    if provider is None:
        print("OCR_MODEL/OCR_BASE_URL are not configured - nothing to evaluate.", file=sys.stderr)
        raise SystemExit(1)

    dpi = args.dpi or config.ocr_dpi
    strip_height_px = args.strip_height_px or config.ocr_strip_height_px
    raw = REFERENCE_PDF.read_bytes()

    results = []
    for page_no in args.pages:
        result = await _evaluate_page(raw, page_no, provider, dpi=dpi, strip_height_px=strip_height_px)
        results.append(result)
        print(f"page {page_no}: char_accuracy={result.char_accuracy:.4f} "
              f"exact_match={result.exact_match} quality={result.quality_status} "
              f"time={result.elapsed_s:.1f}s", flush=True)

    print()
    _print_table(results)
    totals = _totals(results)
    print()
    print(f"pooled character accuracy: {totals['pooled_character_accuracy']:.4f} "
          f"(ТЗ >= 0.95: {'OK' if totals['meets_character_accuracy_threshold'] else 'NOT MET'})")
    if totals["pooled_exact_match"] is not None:
        print(f"pooled exact match (room number+area): {totals['pooled_exact_match']:.4f} "
              f"(ТЗ >= 0.90: {'OK' if totals['meets_exact_match_threshold'] else 'NOT MET'})")
    else:
        print("pooled exact match: n/a (no rooms found on any reference page)")
    print(f"mean time per page: {totals['mean_time_s']:.1f}s")

    report = {
        "reference_pdf": str(REFERENCE_PDF),
        "dpi": dpi,
        "strip_height_px": strip_height_px,
        "ocr_model": config.ocr_model,
        "pages": [
            {
                "page_no": r.page_no, "quality_status": r.quality_status, "elapsed_s": r.elapsed_s,
                "reference_chars": r.ref_chars, "edit_distance": r.edit_distance,
                "character_accuracy": r.char_accuracy, "reference_rooms": r.ref_rooms,
                "matched_rooms": r.matched_rooms, "exact_match": r.exact_match,
            }
            for r in results
        ],
        "totals": totals,
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nwrote {REPORT_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
