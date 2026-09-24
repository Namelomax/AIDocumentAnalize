"""Page images for the inspector's split view.

Rendering is capped by pixel count rather than run at a fixed dpi: construction
sheets are printed at A0 and larger, and a fixed 200 dpi on those produces
images too big to store or open.
"""

import pymupdf

POINTS_PER_INCH = 72.0


def render_page_png(
    raw: bytes,
    page_no: int,
    dpi: int = 200,
    max_long_side_px: int = 4000,
) -> bytes:
    with pymupdf.open(stream=raw, filetype="pdf") as document:
        if page_no < 1 or page_no > document.page_count:
            raise ValueError(
                f"page {page_no} is outside the document's {document.page_count} pages"
            )

        page = document[page_no - 1]
        long_side_pt = max(page.rect.width, page.rect.height)
        effective_dpi = min(dpi, max_long_side_px * POINTS_PER_INCH / long_side_pt)

        return page.get_pixmap(dpi=round(effective_dpi)).tobytes("png")
