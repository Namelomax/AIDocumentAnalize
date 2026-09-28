"""Level 1 of the extraction pipeline: the PDF's own text layer.

Design documentation is exported from CAD, so the text and its coordinates are
already in the file and cost milliseconds to read. Only pages that carry no
text layer are handed on to OCR, which is what keeps 500 pages inside the ten
minute budget.
"""

from dataclasses import dataclass

import pymupdf

from app.pdf.geometry import NormalizedBox, normalize_box

# Bumped whenever the *shape* extract_pages hands back changes in a way that
# would make an old Redis cache entry (app.pdf.cache, customer's ТЗ p.16, п.5
# "Кеширование") unsafe to hand to a newer parser - a new field callers now
# rely on, a changed box convention, or a fix that changes char_count/
# needs_ocr for inputs already cached under the old version. The cache key
# embeds this number so such a change can never serve a stale shape to code
# that no longer expects it; the entry is just treated as a miss instead.
#
# 2: app.pipeline now stores each block's line with a "source" ("text" vs
# "ocr") and adds OCR-recovered lines/quality_status to a page's own cache
# entry (app.ocr.tiling) - an entry cached under version 1 predates both and
# must be treated as a miss, not silently read back as if it had them.
PARSER_VERSION = 2


@dataclass(frozen=True)
class ExtractedLine:
    line_no: int
    text: str
    box: NormalizedBox


@dataclass(frozen=True)
class ExtractedBlock:
    block_no: int
    text: str
    box: NormalizedBox
    lines: list[ExtractedLine]


@dataclass(frozen=True)
class ExtractedPage:
    page_no: int
    width_pt: float
    height_pt: float
    rotation: int
    char_count: int
    needs_ocr: bool
    blocks: list[ExtractedBlock]


def _line_text(line: dict) -> str:
    # Spans are style runs within one line and may split a word, so they are
    # joined without a separator. Lines are distinct text objects and are not:
    # a CAD room label is one block with the room number on one line and the
    # area on the next, and gluing those together read "1.0.95,95".
    return "".join(span.get("text", "") for span in line.get("spans", []))


def extract_pages(raw: bytes, scan_char_threshold: int = 100) -> list[ExtractedPage]:
    pages: list[ExtractedPage] = []

    with pymupdf.open(stream=raw, filetype="pdf") as document:
        for index, page in enumerate(document, start=1):
            rect = page.rect
            page_box = (rect.x0, rect.y0, rect.x1, rect.y1)
            # get_text reports block boxes in the page's UNROTATED space while
            # page.rect already describes the rotated one. Normalizing the raw
            # box against that rect is the silent defect this whole stage is
            # built to avoid: measured on PyMuPDF 1.28.2 the raw box is byte
            # for byte identical across all four /Rotate values, so 0 and 180
            # come out in the same place, and so do 90 and 270.
            rotation_matrix = page.rotation_matrix

            blocks: list[ExtractedBlock] = []
            char_count = 0
            for block in page.get_text("dict").get("blocks", []):
                # Type 0 is text; images and drawings carry no readable value
                # at this level and are left to the VLM stage.
                if block.get("type") != 0:
                    continue
                lines: list[ExtractedLine] = []
                for line in block.get("lines", []):
                    text = _line_text(line).strip()
                    if not text:
                        continue
                    shown = pymupdf.Rect(line["bbox"]) * rotation_matrix
                    lines.append(ExtractedLine(
                        line_no=len(lines),
                        text=text,
                        box=normalize_box((shown.x0, shown.y0, shown.x1, shown.y1), page_box),
                    ))
                if not lines:
                    continue
                block_text = "\n".join(line.text for line in lines)
                char_count += sum(len(line.text) for line in lines)
                displayed = pymupdf.Rect(block["bbox"]) * rotation_matrix
                blocks.append(ExtractedBlock(
                    block_no=len(blocks),
                    text=block_text,
                    box=normalize_box(
                        (displayed.x0, displayed.y0, displayed.x1, displayed.y1), page_box
                    ),
                    lines=lines,
                ))

            pages.append(ExtractedPage(
                page_no=index,
                width_pt=rect.width,
                height_pt=rect.height,
                rotation=page.rotation,
                char_count=char_count,
                needs_ocr=char_count < scan_char_threshold,
                blocks=blocks,
            ))

    return pages
