import pymupdf
import pytest

from app.pdf.render import render_page_png


def _pdf(width: float, height: float) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=width, height=height)
    page.insert_text((20, 40), "MARKER", fontsize=24)
    raw = document.tobytes()
    document.close()
    return raw


def test_renders_a_png():
    data = render_page_png(_pdf(400, 800), page_no=1)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"


def test_large_sheet_is_capped_instead_of_rendered_at_full_dpi():
    """CAD sheets are metres wide on paper.

    A 3370 pt sheet at 200 dpi is over nine thousand pixels across, and a
    package of them exhausts memory and disk long before it is useful. The cap
    trades resolution for a render that actually completes.
    """
    data = render_page_png(_pdf(3370, 2384), page_no=1, max_long_side_px=4000)

    pixmap = pymupdf.Pixmap(data)
    assert max(pixmap.width, pixmap.height) <= 4000


def test_small_sheet_keeps_the_requested_dpi():
    data = render_page_png(_pdf(400, 800), page_no=1, dpi=200, max_long_side_px=4000)

    pixmap = pymupdf.Pixmap(data)
    # 800 pt at 200 dpi is 800 / 72 * 200 pixels, within rounding.
    assert abs(pixmap.height - round(800 / 72 * 200)) <= 2


def test_unknown_page_is_refused():
    with pytest.raises(ValueError):
        render_page_png(_pdf(400, 800), page_no=7)
