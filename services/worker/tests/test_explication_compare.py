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


def test_a_small_relative_change_is_not_a_candidate():
    """51.50 -> 51.60 is +0.19%, well inside the 1% ceiling: systematic
    recalculation noise on a room too large for one rounding step to matter,
    not evidence of a real change."""
    findings = compare_sheets(sheet("pd", [room("1.1", 51.50)]), sheet("rd", [room("1.1", 51.60)]))
    finding = findings[0]
    assert finding.status == "NEGATIVE_VERIFIED"
    assert "допуска" in finding.rationale


def test_one_rounding_step_is_not_a_candidate_even_past_the_relative_ceiling():
    """8.7 -> 8.8 is +1.1%, past the 1% ceiling on its own, but the delta is
    exactly one step of the precision (0.1 m²) both values are recorded to -
    a single rounding step on a small room, not a real change."""
    findings = compare_sheets(sheet("pd", [room("1.1", 8.7)]), sheet("rd", [room("1.1", 8.8)]))
    finding = findings[0]
    assert finding.status == "NEGATIVE_VERIFIED"


def test_two_rounding_steps_past_the_relative_ceiling_is_a_candidate():
    """1.8 -> 1.6 is -11%, and the delta (0.2) is two steps of the 0.1 m²
    precision, not one: clears both bars, so it must still be reported."""
    findings = compare_sheets(sheet("pd", [room("1.1", 1.8)]), sheet("rd", [room("1.1", 1.6)]))
    finding = findings[0]
    assert finding.status == "CANDIDATE"


def test_a_large_change_at_tenth_precision_is_a_candidate():
    """13.70 -> 11.80 (room 145 of the pilot's DOO pair): far past both the
    1% ceiling and one rounding step."""
    findings = compare_sheets(sheet("pd", [room("1.1", 13.70)]), sheet("rd", [room("1.1", 11.80)]))
    finding = findings[0]
    assert finding.status == "CANDIDATE"
    assert finding.delta == "-1.90"


def test_the_relative_threshold_is_a_parameter_not_a_constant():
    """M-002's own compare_threshold drives this rule (app.pipeline reads it
    from specs/params/M-002.yaml); swapping it here must change the verdict,
    proving the value is actually read, not hard-coded. Areas are recorded
    to 0.01 m² here (51.23, not a whole tenth like 51.20), so the precision
    half of the tolerance never masks the relative half being tightened.
    """
    pd, rd = sheet("pd", [room("1.1", 51.23)]), sheet("rd", [room("1.1", 51.33)])

    default = compare_sheets(pd, rd)[0]
    assert default.status == "NEGATIVE_VERIFIED"  # +0.20% is under the default 1%

    strict = compare_sheets(pd, rd, relative_threshold=0.001)[0]
    assert strict.status == "CANDIDATE"  # +0.20% clears a 0.1% ceiling


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

    def test_school_pair_yields_exactly_the_added_room_as_a_candidate(self, pages):
        """The pilot's own markup for this pair names one violation: room
        1.109 was added. The floor total also moved (6234.10 -> 6252.30),
        but by only +0.29% - well inside M-002's own 1% ceiling - so it must
        come back NEGATIVE_VERIFIED, not join room 1.109 as a second
        candidate (the school sheet's own systematic-rounding case, not a
        real change)."""
        findings = compare_sheets(self.sheet_of(pages, 19, "pd"), self.sheet_of(pages, 20, "rd"))

        candidates = {f.subject: f for f in findings if f.status == "CANDIDATE"}
        assert list(candidates) == ["room 1.109"]
        assert candidates["room 1.109"].actual == "18.20"

        totals = {f.subject: f for f in findings if f.subject == "floor total"}
        floor_total = totals["floor total"]
        assert floor_total.status == "NEGATIVE_VERIFIED"
        assert floor_total.expected == "6234.10"
        assert floor_total.actual == "6252.30"
        assert "допуска" in floor_total.rationale

    def test_doo_pair_keeps_candidates_bounded_and_covers_the_pilot_rooms(self, pages):
        """DOO, лист 17/18 (Полярная 25): a systematic recalculation nudges
        almost every one of ~40 rooms by about one rounding step - unfiltered,
        that was 38 candidates on a pilot markup naming one violation
        (kitchen block, rooms 135-150). The two-part tolerance must cut that
        down (ceiling: 20) while still keeping every room in the pilot's own
        135-145 range whose change is unambiguous - more than one rounding
        step *and* more than 1% - among the candidates, room 145
        (13.7 -> 11.8) included.
        """
        findings = compare_sheets(self.sheet_of(pages, 17, "pd"), self.sheet_of(pages, 18, "rd"))
        candidates = {f.subject: f for f in findings if f.status == "CANDIDATE"}

        assert len(candidates) <= 20

        expected_in_pilot_range = {
            "135", "136", "137", "138", "139", "140", "141", "142", "143", "144", "145",
        }
        assert expected_in_pilot_range <= {
            subject.removeprefix("room ") for subject in candidates
        }
        assert candidates["room 145"].expected == "13.70"
        assert candidates["room 145"].actual == "11.80"
