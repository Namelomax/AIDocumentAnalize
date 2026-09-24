from pathlib import Path

import pymupdf
import pytest

from app.pdf.extract import extract_pages

REFERENCE_PDF = Path(__file__).resolve().parents[3] / "Задание" / "Комплект_предметной_разметки.pdf"


def _one_page_pdf(text: str, rotation: int = 0) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    if text:
        # insert_text's base-14 "helv" has no Cyrillic glyphs on this platform
        # and silently draws tofu instead, which get_text then reads back as
        # placeholder dots. insert_htmlbox picks a Unicode-covering font, so
        # the fixture text actually round-trips through extraction.
        page.insert_htmlbox(pymupdf.Rect(20, 20, 380, 100), text, css="* {font-size:24px;}")
    page.set_rotation(rotation)
    raw = document.tobytes()
    document.close()
    return raw


def test_reads_text_and_page_geometry():
    # Long enough to clear the default scan_char_threshold: a title-page
    # fragment this short would otherwise be indistinguishable from a scan
    # with no text layer at all, which is not what this test is checking.
    text = (
        "Площадь застройки объекта капитального строительства составляет "
        "пятьсот квадратных метров согласно проектной документации."
    )
    pages = extract_pages(_one_page_pdf(text))

    assert len(pages) == 1
    page = pages[0]
    assert page.page_no == 1
    assert page.rotation == 0
    assert "Площадь застройки" in "".join(b.text for b in page.blocks)
    assert page.char_count > 0
    assert page.needs_ocr is False


def test_every_box_lies_inside_the_unit_square():
    pages = extract_pages(_one_page_pdf("Экспликация помещений", rotation=90))

    boxes = [b.box for p in pages for b in p.blocks]
    assert boxes
    for box in boxes:
        assert 0.0 <= box.x0 <= box.x1 <= 1.0
        assert 0.0 <= box.y0 <= box.y1 <= 1.0


def test_a_page_without_a_text_layer_is_marked_for_ocr():
    """A scan is a statement about the input, not a failure.

    The page is still recorded, with its geometry, so stage C can come back to
    it later instead of the document silently losing a page.
    """
    pages = extract_pages(_one_page_pdf(""))

    assert len(pages) == 1
    assert pages[0].needs_ocr is True
    assert pages[0].blocks == []


def test_threshold_decides_what_counts_as_a_scan():
    pages = extract_pages(_one_page_pdf("короткая подпись"), scan_char_threshold=1000)
    assert pages[0].needs_ocr is True


def test_rotation_is_honoured_on_the_real_extraction_path():
    """The gate that matters, applied where production code actually runs.

    The same check exists in test_geometry.py, but there it proves the test
    fixture applies the rotation. Only this one proves extract_pages does, and
    extract_pages is what fills the database the inspector's highlights are
    drawn from.
    """
    positions = {}
    for rotation in (0, 90, 180, 270):
        pages = extract_pages(_one_page_pdf("MARKER", rotation=rotation))
        box = pages[0].blocks[0].box
        positions[rotation] = (round(box.x0, 2), round(box.y0, 2))

    assert len(set(positions.values())) == 4, positions


@pytest.mark.skipif(not REFERENCE_PDF.exists(), reason="reference package is not in the checkout")
def test_reads_the_reference_package_without_ocr():
    """The architecture's central assumption, checked against the real file.

    Design documentation is exported from CAD and carries a text layer, so
    level 1 alone covers it. If this ever fails, the cost model of the whole
    pipeline changes and the OCR stage stops being optional.
    """
    pages = extract_pages(REFERENCE_PDF.read_bytes())

    assert len(pages) == 24
    assert all(p.needs_ocr is False for p in pages)
    assert all(p.blocks for p in pages)
