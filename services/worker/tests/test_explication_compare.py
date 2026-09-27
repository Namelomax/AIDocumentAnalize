from pathlib import Path

import pytest

from app.explication.compare import SheetRooms, compare_sheets, pair_sheets
from app.explication.parse import Room, find_floor_totals, find_rooms
from app.pdf.extract import extract_pages
from app.pdf.geometry import NormalizedBox

REFERENCE_PDF = Path(__file__).resolve().parents[3] / "Задание" / "Комплект_предметной_разметки.pdf"
BOX = NormalizedBox(0.1, 0.1, 0.2, 0.2)


def sheet(file_id, rooms, totals=()):
    return SheetRooms(file_id, 1, {r.number: r for r in rooms}, list(totals))


def room(number, area):
    return Room(number, area, None, BOX)


def test_equal_rooms_are_verified_negatives():
    findings = compare_sheets(sheet("pd", [room("1.1", 10.0)]), sheet("rd", [room("1.1", 10.0)]))
    assert [(f.subject, f.status) for f in findings] == [("room 1.1", "NEGATIVE_VERIFIED")]


def test_a_changed_area_is_a_candidate_with_a_signed_delta():
    findings = compare_sheets(sheet("pd", [room("1.1", 10.0)]), sheet("rd", [room("1.1", 12.5)]))
    finding = findings[0]
    assert finding.status == "CANDIDATE"
    assert (finding.expected, finding.actual, finding.delta) == ("10.00", "12.50", "+2.50")


def test_an_added_room_between_present_neighbours_is_a_candidate():
    pd = sheet("pd", [room("1.108", 5.0), room("1.110", 6.0)])
    rd = sheet("rd", [room("1.108", 5.0), room("1.109", 18.2), room("1.110", 6.0)])

    added = [f for f in compare_sheets(pd, rd) if f.subject == "room 1.109"]
    assert len(added) == 1
    assert added[0].status == "CANDIDATE"
    assert (added[0].expected, added[0].actual) == (None, "18.20")


def test_an_absence_without_neighbours_proves_nothing():
    """A room missing from a sheet whose neighbours are missing too is a gap in
    parsing or in the sheet, not evidence that the room was added."""
    pd = sheet("pd", [room("1.100", 5.0)])
    rd = sheet("rd", [room("1.100", 5.0), room("1.109", 18.2)])

    assert not [f for f in compare_sheets(pd, rd) if f.subject == "room 1.109"]


def test_sheets_are_paired_by_shared_room_numbers():
    first = sheet("pd-1", [room(f"1.{i}", 1.0) for i in range(1, 11)])
    second = sheet("pd-2", [room(f"2.{i}", 1.0) for i in range(1, 11)])
    rd = sheet("rd-2", [room(f"2.{i}", 1.0) for i in range(1, 10)])

    assert [(p.file_id, r.file_id) for p, r in pair_sheets([first, second], [rd])] == [("pd-2", "rd-2")]


def test_a_sheet_without_a_counterpart_is_not_compared():
    pd = sheet("pd", [room(f"1.{i}", 1.0) for i in range(1, 11)])
    rd = sheet("rd", [room(f"9.{i}", 1.0) for i in range(1, 11)])
    assert pair_sheets([pd], [rd]) == []


@pytest.mark.skipif(not REFERENCE_PDF.exists(), reason="reference package is not in the checkout")
class TestReferencePairs:
    @pytest.fixture(scope="class")
    def pages(self):
        return extract_pages(REFERENCE_PDF.read_bytes())

    def sheet_of(self, pages, page_no, file_id):
        page = pages[page_no - 1]
        return SheetRooms(file_id, page_no, {r.number: r for r in find_rooms(page)},
                          find_floor_totals(page))

    @pytest.mark.parametrize("pd_page,rd_page", [(21, 22), (23, 24)])
    def test_negative_pair_yields_no_candidates(self, pages, pd_page, rd_page):
        """The pilot's verified negative pair must come out clean."""
        findings = compare_sheets(self.sheet_of(pages, pd_page, "pd"), self.sheet_of(pages, rd_page, "rd"))

        assert [f.subject for f in findings if f.status == "CANDIDATE"] == []
        assert sum(f.status == "NEGATIVE_VERIFIED" for f in findings) >= 20

    def test_school_pair_yields_the_added_room_and_the_changed_total(self, pages):
        findings = compare_sheets(self.sheet_of(pages, 19, "pd"), self.sheet_of(pages, 20, "rd"))

        candidates = {f.subject: f for f in findings if f.status == "CANDIDATE"}
        assert candidates["room 1.109"].actual == "18.20"
        assert candidates["floor total"].expected == "6234.10"
        assert candidates["floor total"].actual == "6252.30"
        assert candidates["floor total"].delta == "+18.20"
