"""Recovering text lines, with approximate boxes, from a page that carries
no text layer (app.pdf.extract's needs_ocr) - "stage C" of customer's ТЗ
p.16, п.1: "Распознавание текста (OCR)".

Probed manually against a real LM Studio server serving glm-ocr (the model
this stand is configured with) with real pages of
`Задание/Комплект_предметной_разметки.pdf` rasterized at 300 dpi: the model
answers with plain text only - one recognized line per line of its answer,
no bounding boxes, no JSON, no markdown table. (Raw example, a crop
containing a numbered explication table row: the model returned
"ОТРИЦАТЕЛЬНЫЙ ПРИМЕР — РД, СЕКЦИЯ 1\\n\\nСоответственный лист
соответствует..." - free text, line breaks only, nothing else structured.)
That rules out design option "the model reports its own boxes" entirely for
this deployment.

To still hand callers a per-line NormalizedBox (the explication parser
reads page.blocks/lines the same way whether they came from the PDF's own
text layer or from here, and the evidence UI draws a highlight from a
box either way), the page is rendered once and cut into horizontal strips
before OCR, sized so a strip is roughly a paragraph's worth of lines
(Config.ocr_strip_height_px). A strip's own box is known exactly - it is
how the image was cut - and each line the model returned for that strip is
given an equal share of the strip's own height, in the order the model
printed them, spanning the full page width (a strip is never split into
columns, so nothing here ever claims to know where a line starts or ends
horizontally - a model that reports no boxes cannot support that, and
inventing one would violate the ТЗ's "координаты... обязательно для
корректного отображения" as much as inventing the text would).

This is an honest approximation, not an exact one:
  - a strip with N returned lines but a different real number of visible
    lines produces boxes that do not line up with the real line pitch;
  - a two-line CAD label (room number on one line, area on the next -
    app.pdf.extract's own module docstring) is only read back as one block
    if both lines land in the same strip; split across a strip boundary,
    app.explication.parse's plan-label detector (which requires both lines
    in one block) will not find it, though its table-row detector (which
    only needs lines to be geometrically close, not in the same block) may
    still recover it as an ordinary row.
No box produced here is ever tighter than the strip it was read from.
"""

import logging
from dataclasses import dataclass

import pymupdf

from app.llm.provider import LlmUnavailable
from app.metrics import ocr_pages_total
from app.ocr.client import OcrProvider
from app.pdf.geometry import NormalizedBox

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OcrLine:
    # tile_no groups lines the way app.pdf.extract's own block_no groups
    # ExtractedLine - see this module's own docstring on why that matters
    # for the plan-label detector.
    tile_no: int
    line_no: int
    text: str
    box: NormalizedBox


@dataclass(frozen=True)
class OcrPageResult:
    lines: list[OcrLine]
    # "LOW_QUALITY" when nothing legible came back (OCR was not configured,
    # the model was unreachable for every strip, or every strip's answer was
    # empty) - never fabricated text and never silence about why there is
    # none (customer's ТЗ p.16 п.1: "система обязана вернуть LOW_QUALITY или
    # ABSTAIN"). None when at least one line was recovered.
    quality_status: str | None


def _strip_ranges_pt(page_height_pt: float, dpi: int, strip_height_px: int) -> list[tuple[float, float]]:
    """Page-point y-ranges (relative to the page's own top) for every strip,
    each strip_height_px tall at the given render dpi except possibly the
    last, which is only as tall as what remains of the page."""
    strip_height_pt = strip_height_px * 72.0 / dpi
    if strip_height_pt <= 0:
        raise ValueError(f"strip_height_px must render to a positive height, got {strip_height_px}px at {dpi}dpi")

    ranges: list[tuple[float, float]] = []
    y0 = 0.0
    while y0 < page_height_pt:
        y1 = min(y0 + strip_height_pt, page_height_pt)
        ranges.append((y0, y1))
        y0 = y1
    return ranges


def _tile_lines(tile_no: int, text: str, y0_frac: float, y1_frac: float) -> list[OcrLine]:
    """Split one strip's raw OCR answer into non-empty lines and give each an
    equal share of the strip's own [y0_frac; y1_frac] band - see this
    module's own docstring for why that is the most this client can say
    about where a line actually sits."""
    raw_lines = [line.strip() for line in text.splitlines()]
    lines = [line for line in raw_lines if line]
    if not lines:
        return []

    band = (y1_frac - y0_frac) / len(lines)
    return [
        OcrLine(
            tile_no=tile_no, line_no=index, text=line,
            box=NormalizedBox(x0=0.0, x1=1.0, y0=y0_frac + index * band, y1=y0_frac + (index + 1) * band),
        )
        for index, line in enumerate(lines)
    ]


async def ocr_page(raw: bytes, page_no: int, provider: OcrProvider | None, *,
                    dpi: int, strip_height_px: int) -> OcrPageResult:
    """OCR one page of a PDF already known to need it (app.pdf.extract's
    needs_ocr). provider=None (OCR_MODEL unset, app.ocr.client's own
    docstring) is reported as LOW_QUALITY without a single request - the same
    degradation the free-search hypotheses apply when no chat model is
    configured (app.pipeline's own module docstring).
    """
    if provider is None:
        ocr_pages_total.labels(result="unavailable").inc()
        return OcrPageResult(lines=[], quality_status="LOW_QUALITY")

    with pymupdf.open(stream=raw, filetype="pdf") as document:
        if page_no < 1 or page_no > document.page_count:
            ocr_pages_total.labels(result="low_quality").inc()
            return OcrPageResult(lines=[], quality_status="LOW_QUALITY")

        page = document[page_no - 1]
        # page.rect already describes the rotated/displayed page (same
        # comment as app.pdf.extract._extract_pages), and get_pixmap(clip=)
        # takes its clip rectangle in that same coordinate system - so a
        # strip cut here lands in exactly the space the inspector's own
        # split view (app.pdf.render.render_page_png) shows, with no
        # separate rotation matrix needed the way raw text-dict boxes do.
        page_height_pt = page.rect.height
        ranges_pt = _strip_ranges_pt(page_height_pt, dpi, strip_height_px)

        lines: list[OcrLine] = []
        for tile_no, (y0_pt, y1_pt) in enumerate(ranges_pt):
            clip = pymupdf.Rect(page.rect.x0, page.rect.y0 + y0_pt, page.rect.x1, page.rect.y0 + y1_pt)
            tile_png = page.get_pixmap(dpi=dpi, clip=clip).tobytes("png")
            try:
                text = await provider.recognize_text(tile_png)
            except LlmUnavailable as exc:
                # One strip's own failure (a transient timeout, most often)
                # must not cost the rest of the page - the strips that did
                # answer are still real text, not a reason to discard them.
                logger.warning("ocr strip failed", extra={
                    "page_no": page_no, "tile_no": tile_no, "error": str(exc),
                })
                continue
            lines.extend(_tile_lines(tile_no, text, y0_pt / page_height_pt, y1_pt / page_height_pt))

    if not lines:
        ocr_pages_total.labels(result="low_quality").inc()
        return OcrPageResult(lines=[], quality_status="LOW_QUALITY")

    ocr_pages_total.labels(result="ok").inc()
    return OcrPageResult(lines=lines, quality_status=None)
