import pymupdf
import pytest

from app.pdf.geometry import Box, NormalizedBox, normalize_box


def test_box_covering_the_whole_page_is_the_unit_square():
    assert normalize_box((0, 0, 400, 800), (0, 0, 400, 800)) == NormalizedBox(0.0, 0.0, 1.0, 1.0)


def test_box_in_the_top_left_quarter():
    box = normalize_box((0, 0, 200, 400), (0, 0, 400, 800))
    assert box == NormalizedBox(0.0, 0.0, 0.5, 0.5)


def test_page_origin_is_subtracted():
    """A CropBox that does not start at zero must not shift every coordinate.

    Sheets exported from CAD routinely carry a non-zero origin, and ignoring it
    offsets every highlight on the page by the same amount - a defect that looks
    like a systematic drawing error rather than a coordinate bug.
    """
    box = normalize_box((100, 200, 300, 600), (100, 200, 500, 1000))
    assert box == NormalizedBox(0.0, 0.0, 0.5, 0.5)


def test_coordinates_outside_the_page_are_clamped():
    box = normalize_box((-50, -50, 450, 900), (0, 0, 400, 800))
    assert box == NormalizedBox(0.0, 0.0, 1.0, 1.0)


def test_inverted_input_is_returned_in_order():
    box = normalize_box((300, 600, 100, 200), (0, 0, 400, 800))
    assert box.x0 <= box.x1 and box.y0 <= box.y1


def test_degenerate_page_is_refused():
    with pytest.raises(ValueError):
        normalize_box((0, 0, 10, 10), (0, 0, 0, 800))


def _page_with_marker(rotation: int) -> tuple[Box, Box]:
    """Build a one-page PDF with a marker near the unrotated top-left corner.

    Returns the marker's bbox and the page box, both as PyMuPDF reports them
    after the rotation has been applied.

    PyMuPDF 1.28.2's ``get_text("dict")`` reports block boxes in the page's
    unrotated coordinate space, not the space ``page.rect`` describes, so the
    /Rotate entry has to be applied by hand via ``page.rotation_matrix`` to get
    the box a reader actually sees. Skipping this step is exactly the silent
    defect this test exists to catch: the raw bbox is /Rotate-blind, so
    normalizing it straight against ``page.rect`` gives the same position for
    0/180 and for 90/270, and the corner test below fails.
    """
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    page.insert_text((20, 40), "MARKER", fontsize=24)
    page.set_rotation(rotation)

    raw = document.tobytes()
    document.close()

    reopened = pymupdf.open(stream=raw, filetype="pdf")
    page = reopened[0]
    rect = page.rect
    marker = next(
        block for block in page.get_text("dict")["blocks"]
        if block.get("type") == 0
    )
    rotated = pymupdf.Rect(marker["bbox"]) * page.rotation_matrix
    box = (rotated.x0, rotated.y0, rotated.x1, rotated.y1)
    page_box = (rect.x0, rect.y0, rect.x1, rect.y1)
    reopened.close()
    return box, page_box


def test_rotation_moves_the_marker_to_a_different_corner():
    """Four rotations must give four different positions.

    If Rotate is ignored, all four come out identical - the page still renders
    rotated, so the highlight silently lands 90 degrees away from its subject.
    This assertion is the one that fails when that happens.
    """
    positions = {}
    for rotation in (0, 90, 180, 270):
        box, page_box = _page_with_marker(rotation)
        normalized = normalize_box(box, page_box)
        positions[rotation] = (round(normalized.x0, 2), round(normalized.y0, 2))

    assert len(set(positions.values())) == 4, positions


def test_rotation_maps_the_marker_to_the_expected_quadrant():
    """Pins the mapping found empirically, so a later change cannot flip it.

    If this fails while the test above passes, rotation is still honoured but
    the direction changed - check the PyMuPDF version before touching the code.
    """
    expected = {0: "left-top", 90: "right-top", 180: "right-bottom", 270: "left-bottom"}
    for rotation, quadrant in expected.items():
        box, page_box = _page_with_marker(rotation)
        normalized = normalize_box(box, page_box)
        horizontal = "left" if normalized.x0 < 0.5 else "right"
        vertical = "top" if normalized.y0 < 0.5 else "bottom"
        assert f"{horizontal}-{vertical}" == quadrant, (rotation, normalized)
