"""Level 1 of the extraction pipeline: the PDF's own text layer.

Design documentation is exported from CAD, so the text and its coordinates are
already in the file and cost milliseconds to read. Only pages that carry no
text layer are handed on to OCR, which is what keeps 500 pages inside the ten
minute budget.
"""

from dataclasses import dataclass

import pymupdf

from app.pdf.geometry import NormalizedBox, normalize_box


@dataclass(frozen=True)
class ExtractedBlock:
    block_no: int
    text: str
    box: NormalizedBox


@dataclass(frozen=True)
class ExtractedPage:
    page_no: int
    width_pt: float
    height_pt: float
    rotation: int
    char_count: int
    needs_ocr: bool
    blocks: list[ExtractedBlock]


def _block_text(block: dict) -> str:
    return "".join(
        span.get("text", "")
        for line in block.get("lines", [])
        for span in line.get("spans", [])
    )


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
                text = _block_text(block)
                if not text.strip():
                    continue
                char_count += len(text.strip())
                displayed = pymupdf.Rect(block["bbox"]) * rotation_matrix
                blocks.append(ExtractedBlock(
                    block_no=len(blocks),
                    text=text,
                    box=normalize_box(
                        (displayed.x0, displayed.y0, displayed.x1, displayed.y1), page_box
                    ),
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
