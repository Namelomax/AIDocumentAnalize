from pathlib import Path

import pytest

from app.explication.parse import find_floor_totals, find_rooms
from app.pdf.extract import ExtractedBlock, ExtractedLine, ExtractedPage, extract_pages
from app.pdf.geometry import NormalizedBox

REFERENCE_PDF = Path(__file__).resolve().parents[3] / "Задание" / "Комплект_предметной_разметки.pdf"

pytestmark = pytest.mark.skipif(not REFERENCE_PDF.exists(), reason="reference package is not in the checkout")


@pytest.fixture(scope="module")
def pages():
    return extract_pages(REFERENCE_PDF.read_bytes())


def rooms_of(pages, page_no):
    return {room.number: room for room in find_rooms(pages[page_no - 1])}


@pytest.mark.parametrize("pd_page,rd_page", [(21, 22), (23, 24)])
def test_negative_reference_pair_reads_the_same_rooms_on_both_sheets(pages, pd_page, rd_page):
    """Полярная, 17: the pilot markup's verified negative pair.

    The same floor in design and working documentation, with no substantive
    difference. Any room found on one sheet and not the other here is a parse
    error, and in the protocol it would be a false violation - exactly what
    the FPR <= 0.10 threshold of the specification counts.
    """
    pd_rooms, rd_rooms = rooms_of(pages, pd_page), rooms_of(pages, rd_page)

    assert len(pd_rooms) >= 20
    assert set(pd_rooms) == set(rd_rooms), (
        sorted(set(pd_rooms) ^ set(rd_rooms))
    )
    for number in pd_rooms:
        assert pd_rooms[number].area == pytest.approx(rd_rooms[number].area), number


def test_room_label_on_a_plan_is_read(pages):
    rooms = rooms_of(pages, 22)
    assert rooms["1.0.9"].area == pytest.approx(5.95)


def test_the_added_school_room_is_read_from_the_working_documentation(pages):
    """Полярная, 25: the pilot's candidate. RD adds room 1.109 of 18.2 m²."""
    rd_rooms = rooms_of(pages, 20)
    assert rd_rooms["1.109"].area == pytest.approx(18.2)


def test_the_design_documentation_has_the_neighbours_but_not_the_added_room(pages):
    """The pilot's own argument: after 1.108 comes 1.110 in the design sheet."""
    pd_rooms = rooms_of(pages, 19)
    assert "1.109" not in pd_rooms
    assert "1.108" in pd_rooms and "1.110" in pd_rooms


def test_floor_totals_of_the_school_are_read(pages):
    pd_totals = [t.area for t in find_floor_totals(pages[18])]
    rd_totals = [t.area for t in find_floor_totals(pages[19])]
    assert 6234.1 in pd_totals
    assert 6252.3 in rd_totals


def test_explication_table_with_plain_room_numbers_is_read(pages):
    """Алтуфьевское, 79Б: two tables on one sheet reuse the same plain
    numbers ("1", "2", "А", "Б") for different rooms - the ground floor and
    the antresol. A lookup keyed by number alone cannot tell them apart, so
    this asserts against `find_rooms` directly rather than the number-keyed
    `rooms_of` helper: doing otherwise would silently depend on which of the
    two same-numbered rooms happens to win the dict, which is exactly the
    ambiguity `scope` exists to resolve.
    """
    rooms = find_rooms(pages[1])
    antresol_room_1 = next(r for r in rooms if r.number == "1" and r.scope and "антресол" in r.scope.lower())
    ground_floor_room_1 = next(r for r in rooms if r.number == "1" and r is not antresol_room_1)

    assert antresol_room_1.area == pytest.approx(11.33)
    assert antresol_room_1.name == "Тех.помещение"
    assert ground_floor_room_1.area == pytest.approx(165.05)

    totals = sorted(t.area for t in find_floor_totals(pages[1]))
    assert totals == pytest.approx([71.01, 2797.27])


def test_room_numbers_are_unique_after_merging(pages):
    """Task 4's comparator keys sheets by room number; a page that still
    reports the same number twice after merging would silently corrupt
    that lookup."""
    for page_no in (19, 20, 21, 22):
        rooms = find_rooms(pages[page_no - 1])
        assert len(rooms) == len({r.number for r in rooms}), page_no


def test_room_scope_and_number_pairs_are_unique_on_the_sheet_with_two_tables(pages):
    """Алтуфьевское, 79Б: numbers alone repeat across its two tables, but
    (scope, number) must still be a unique identity for every room."""
    rooms = find_rooms(pages[1])
    pairs = [(r.scope, r.number) for r in rooms]
    assert len(pairs) == len(set(pairs))


def _line(line_no, text, x0, y0, x1, y1):
    return ExtractedLine(line_no=line_no, text=text, box=NormalizedBox(x0, y0, x1, y1))


def _block(block_no, lines):
    box = NormalizedBox(
        min(l.box.x0 for l in lines), min(l.box.y0 for l in lines),
        max(l.box.x1 for l in lines), max(l.box.y1 for l in lines),
    )
    return ExtractedBlock(block_no=block_no, text="\n".join(l.text for l in lines), box=box, lines=lines)


def test_a_number_with_two_areas_in_the_same_table_is_not_reported():
    """Built directly from `ExtractedPage` rather than a real sheet: the same
    table row number ("1") with two conflicting areas and nothing to tell
    them apart (same table, same scope) is not a case any real sheet in the
    reference package produces, but the comparator must never see it either
    way - so it is exercised as pure synthetic input.
    """
    caption = _block(0, [_line(0, "Спецификация помещений", 0.10, 0.05, 0.30, 0.065)])
    header = _block(1, [
        _line(0, "Номер", 0.10, 0.08, 0.13, 0.09),
        _line(1, "Имя", 0.15, 0.08, 0.18, 0.09),
        _line(2, "Площадь", 0.25, 0.08, 0.30, 0.09),
    ])
    row1 = _block(2, [
        _line(0, "1", 0.10, 0.10, 0.12, 0.11),
        _line(1, "Комната", 0.15, 0.10, 0.20, 0.11),
        _line(2, "5,0", 0.25, 0.10, 0.28, 0.11),
    ])
    row2 = _block(3, [
        _line(0, "1", 0.10, 0.12, 0.12, 0.13),
        _line(1, "Комната", 0.15, 0.12, 0.20, 0.13),
        _line(2, "7,0", 0.25, 0.12, 0.28, 0.13),
    ])
    page = ExtractedPage(page_no=1, width_pt=100.0, height_pt=100.0, rotation=0,
                          char_count=100, needs_ocr=False, blocks=[caption, header, row1, row2])

    rooms = find_rooms(page)
    assert not [r for r in rooms if r.number == "1"]


def test_dimension_numbers_on_a_plan_are_not_rooms(pages):
    """Plain integers on a plan are dimensions in millimetres, not rooms."""
    for page_no in (21, 22, 23, 24):
        numbers = set(rooms_of(pages, page_no))
        assert not any(n.isdigit() for n in numbers), (page_no, sorted(n for n in numbers if n.isdigit()))


def test_every_room_box_lies_inside_the_page(pages):
    for page_no in (2, 19, 20, 21, 22):
        for room in find_rooms(pages[page_no - 1]):
            box = room.box
            assert 0.0 <= box.x0 <= box.x1 <= 1.0
            assert 0.0 <= box.y0 <= box.y1 <= 1.0


def test_merged_room_box_is_a_single_detection_not_a_span_across_the_sheet(pages):
    """Полярная, 21/22: the same room is tagged twice on the sheet - once by
    its plan label, once by its table row - often far apart on the page.
    Merging their boxes into a union used to stretch the evidence rectangle
    across a third of the sheet, which fails the specification's IoU >= 0.50
    localisation check against a small reference bbox and would highlight
    half the drawing in the inspector's card instead of the room.
    """
    for page_no in (19, 20, 21, 22):
        for room in find_rooms(pages[page_no - 1]):
            box = room.box
            assert box.x1 - box.x0 <= 0.1, (page_no, room.number, box)
            assert box.y1 - box.y0 <= 0.1, (page_no, room.number, box)
