"""Comparing room explications between a design (PD) sheet and its working
documentation (RD) counterpart.

Section 9.2 of the specification: the engine only ever answers CANDIDATE or
NEGATIVE_VERIFIED - CONFIRMED_VIOLATION is an inspector's verdict, never
ours. Section 9.2 also fixes the FPR <= 0.10 ceiling that decides every rule
below: an equal room must be reported (it is what a false-positive rate is
measured against), a changed one must be reported with its signed delta, and
a room missing from one sheet is only ever reported when its neighbours on
the *other* sheet prove the gap is real rather than a parsing miss - the
pilot markup's own argument for room 1.109 ("after 1.108 comes 1.110").

A run against the pilot markup's own reference sheets (Полярная 25 school
and DOO, Задание/Комплект_предметной_разметки.pdf) showed a third rule is
needed before an area delta is even a candidate: a systematic recalculation
between PD and RD nudges *every* room's area by about one rounding step
(e.g. +0.10 m² on 38 of the DOO's ~40 rooms), and for a small room that step
alone clears any absolute threshold worth having. Two areas are therefore
"the same", not a candidate, when *either* of two things is true - see
`_within_rounding_tolerance`:
  - the delta is within M-002's own relative ceiling for the building's
    total area (`compare_threshold` in specs/params/M-002.yaml, currently
    1%) - the pilot's own bar for "this delta matters", reused here rather
    than inventing a second one for rooms; or
  - the delta is no more than one unit of the precision the areas were
    themselves recorded to (0.1 m² or 0.01 m², recovered from the numbers
    since parse.py keeps only the float) - a single rounding step is not
    evidence of a real change, however large a fraction of a small room it
    happens to be.
A delta clearing *both* bars is a candidate; one that does not is
NEGATIVE_VERIFIED, with a rationale saying so - it must still be reported,
per the FPR <= 0.10 comment above, just not as a candidate.

Задание/10. Мосстройнадзор.pdf and the pilot's own markup (DOO25-V01,
Задание/Комплект_предметной_разметки.pdf) add a fourth rule: the DOO pair's
kitchen-block change is recorded by the pilot as ONE violation over one box
spanning rows 134-149, not eighteen independent ones - a composite candidate
the inspector must split before deciding on any part of it. `compare_sheets`
therefore groups a maximal run of *two or more* consecutive CANDIDATE room
findings (area change, absent-from-RD or added-in-RD - never a floor total,
which is compared once for the whole sheet and never part of a run) into one
composite RoomFinding carrying its members as `atoms`. "Consecutive" means
adjacent in the table's own printed order - natural sort of the room number,
grouped so two different tables' numbers (Алтуфьевское's ground floor vs.
antresol "1") never merge - not adjacent integers: a NEGATIVE_VERIFIED room,
or one with no finding at all, sits in that same order and breaks the run
exactly where the pilot's own comparison would. A run of one stays atomic,
exactly as before this rule existed.
"""

import re
from dataclasses import dataclass

from app.explication.parse import FloorTotal, Room
from app.pdf.geometry import NormalizedBox

# Two areas within this many square metres of each other are "the same room
# area", not a real change - matches the merge tolerance parse.py uses when
# folding one room's two detections into one, so the same rounding never
# reads as a delta here.
_AREA_TOLERANCE = 0.005

# M-002's own relative ceiling ("Дельта общей площади между ПД и РД (или ИД)
# > 1%") is reused as the relative half of the room/floor-total rounding
# tolerance above (there is no room-specific parameter in the matrix to draw
# it from instead). Only a fallback for when the spec file cannot be loaded
# at all (see app.pipeline) - the real value always comes from
# specs/params/M-002.yaml's compare_threshold at runtime.
DEFAULT_AREA_RELATIVE_THRESHOLD = 0.01

# A room sheet is another sheet's counterpart when they share at least half
# of the smaller sheet's room numbers. Below that, two sheets that happen to
# share a handful of numbers (e.g. two different floors both have a "1")
# would otherwise be paired and produce nonsense findings.
_MIN_SHARE = 0.5

_NEIGHBOUR_NUMBER_RE = re.compile(r"^(.*?)(\d+)$")


@dataclass(frozen=True)
class SheetRooms:
    file_id: str
    page_no: int
    # Keyed by room_key(room, rooms) from parse.py: the bare number when it is
    # unique on the sheet, "scope|number" when two tables reuse it.
    rooms: dict[str, Room]
    totals: list[FloorTotal]


@dataclass(frozen=True)
class RoomFinding:
    subject: str                 # "room 1.109", "floor total", or "rooms 134..149"
    status: str                  # "CANDIDATE" or "NEGATIVE_VERIFIED"
    expected: str | None         # value on the design sheet, None when absent
    actual: str | None           # value on the working sheet, None when absent
    delta: str | None
    rationale: str
    expected_sheet: SheetRooms
    expected_box: NormalizedBox
    actual_sheet: SheetRooms
    actual_box: NormalizedBox
    # The individual room findings a composite candidate was built from
    # (module docstring) - empty for every ordinary, atomic finding, which is
    # every finding this module produced before composites existed.
    atoms: tuple["RoomFinding", ...] = ()


def _fmt(value: float) -> str:
    """Two decimals, the precision the reference sheets are drawn to (m²)."""
    return f"{value:.2f}"


def _fmt_signed(value: float) -> str:
    return f"{value:+.2f}"


def _fmt_ru(value: float) -> str:
    """Russian decimal comma, for the rationale an inspector actually reads."""
    return _fmt(value).replace(".", ",")


def _fmt_signed_ru(value: float) -> str:
    return _fmt_signed(value).replace(".", ",")


def _is_whole_tenth(value: float) -> bool:
    """True when `value` round-trips exactly at one decimal place (8.7, or a
    whole number like 87.0) - i.e. it could have been written to 0.1 m²
    precision. parse.py keeps only the float, never the text a value was
    written as, so the precision has to be recovered from the number itself;
    the *10 round-trip is exact for one-decimal values (float noise aside)
    but fails for a genuine two-decimal one like 8.73.
    """
    scaled = value * 10
    return abs(scaled - round(scaled)) < 1e-6


def _precision_unit(a: float, b: float) -> float:
    """The precision both areas were recorded to: 0.1 m² when both round-trip
    at one decimal place, 0.01 m² (the explications' other common precision)
    otherwise. Either value alone being a "round" 0.1 number proves nothing -
    Наблюдение above found a *pair* like 8.7/8.8 that are both one-decimal,
    while a pair like 8.70/8.73 needs the finer unit even though 8.70 alone
    would pass the whole-tenth test.
    """
    if _is_whole_tenth(a) and _is_whole_tenth(b):
        return 0.1
    return 0.01


def _within_rounding_tolerance(pd_area: float, rd_area: float, relative_threshold: float) -> bool:
    """The module docstring's two-part allowance: not a candidate when the
    delta is small either as a fraction of the PD area, or as a fraction of
    the recording precision (at most one rounding step). Only called once
    the tiny `_AREA_TOLERANCE` case (an exact or near-exact match) has
    already been ruled out by the caller.
    """
    delta = abs(rd_area - pd_area)
    if pd_area and delta <= relative_threshold * abs(pd_area):
        return True
    # `+ 1e-9` absorbs the float noise `_precision_unit`'s own *10 round-trip
    # does not - e.g. 47.9 -> 48.5 subtracts to 0.6000000000000014, not 0.6.
    return delta <= _precision_unit(pd_area, rd_area) + 1e-9


def _natural_key(number: str) -> tuple:
    """Table order for a room number, not a plain string sort: "1.9" must
    sort before "1.10", which `"1.9" < "1.10"` gets wrong. Split on "." into
    ints; a number with any non-numeric part (Алтуфьевское's stair flights
    "А", "Б") sorts after every numeric one, as its own group ordered by the
    raw text - there is no numeric position to place it at instead.
    """
    parts = number.split(".")
    try:
        return (0, tuple(int(part) for part in parts))
    except ValueError:
        return (1, number)


def _table_order(keys: list[str], scope_by_key: dict[str, str | None],
                  number_by_key: dict[str, str]) -> list[list[str]]:
    """Every room key in the order its own table prints it, one list per
    scope: two independent tables' numbers (Алтуфьевское's ground floor vs.
    antresol "1") must never be read as adjacent to each other, so grouping
    below must never see a lone candidate at the end of one table's list
    right next to a lone candidate at the start of another's - only a
    per-scope grouping caller can guarantee that, not a flattened one.
    Natural-sorted by number within each scope.
    """
    by_scope: dict[str | None, list[str]] = {}
    for key in keys:
        by_scope.setdefault(scope_by_key[key], []).append(key)

    return [
        sorted(by_scope[scope], key=lambda k: _natural_key(number_by_key[k]))
        for scope in sorted(by_scope, key=lambda s: (s is None, s or ""))
    ]


def _composite_finding(run: list[tuple[str, str, RoomFinding]]) -> RoomFinding:
    """One composite candidate out of a run of >= 2 consecutive CANDIDATE
    room findings (module docstring). `run` is a list of (key, number,
    finding) in table order; only the boundary keys and the room numbers
    they were written under are shown to the inspector, the rest are read
    off the nested atoms.
    """
    keys = [key for key, _number, _finding in run]
    numbers = [number for _key, number, _finding in run]
    atoms = tuple(finding for _key, _number, finding in run)

    # Only atoms that actually carry a value on that side contribute to the
    # sum - an added-in-RD or absent-from-RD atom inside the run has no
    # value on one side at all, same as its own standalone finding would.
    expected_values = [float(a.expected) for a in atoms if a.expected is not None]
    actual_values = [float(a.actual) for a in atoms if a.actual is not None]
    delta_values = [float(a.delta) for a in atoms if a.delta is not None]

    expected_total = sum(expected_values) if expected_values else None
    actual_total = sum(actual_values) if actual_values else None
    delta_total = sum(delta_values) if delta_values else None

    number_range = f"{numbers[0]}–{numbers[-1]}"
    if expected_total is not None and actual_total is not None and delta_total is not None:
        rationale = (
            f"Изменены площади {len(atoms)} помещений подряд ({number_range}): "
            f"в ПД {_fmt_ru(expected_total)} м², в РД {_fmt_ru(actual_total)} м² "
            f"(дельта {_fmt_signed_ru(delta_total)} м²). Разделите кандидат, "
            f"чтобы решить по каждому помещению."
        )
    else:
        # A run mixing area changes with an added or a missing room (both
        # sides not present on every atom) - the same claim, without a total
        # the mixed atoms cannot honestly support.
        rationale = (
            f"Изменения в {len(atoms)} помещениях подряд ({number_range}): "
            f"состав и площади отличаются между ПД и РД. Разделите кандидат, "
            f"чтобы решить по каждому помещению."
        )

    return RoomFinding(
        subject=f"rooms {keys[0]}..{keys[-1]}",
        status="CANDIDATE",
        expected=_fmt(expected_total) if expected_total is not None else None,
        actual=_fmt(actual_total) if actual_total is not None else None,
        delta=_fmt_signed(delta_total) if delta_total is not None else None,
        rationale=rationale,
        expected_sheet=atoms[0].expected_sheet,
        expected_box=_union([a.expected_box for a in atoms]),
        actual_sheet=atoms[0].actual_sheet,
        actual_box=_union([a.actual_box for a in atoms]),
        atoms=atoms,
    )


def _group_room_findings(keys: list[str], finding_by_key: dict[str, RoomFinding],
                          scope_by_key: dict[str, str | None],
                          number_by_key: dict[str, str]) -> list[RoomFinding]:
    """Replace every maximal run of >= 2 consecutive CANDIDATE room findings
    (module docstring) with one composite; everything else - a lone
    candidate, a NEGATIVE_VERIFIED finding - passes through unchanged.
    """
    result: list[RoomFinding] = []
    run: list[tuple[str, str, RoomFinding]] = []

    def flush() -> None:
        if not run:
            return
        result.append(run[0][2] if len(run) == 1 else _composite_finding(run))
        run.clear()

    for scope_group in _table_order(keys, scope_by_key, number_by_key):
        for key in scope_group:
            finding = finding_by_key.get(key)
            if finding is not None and finding.status == "CANDIDATE":
                run.append((key, number_by_key[key], finding))
                continue
            # A NEGATIVE_VERIFIED finding, or a room with no finding at all
            # (`finding is None`, e.g. an absence `_absent_from_rd` could not
            # confirm), both break a run in progress - the second is skipped
            # here exactly as it always was, only after breaking the run.
            flush()
            if finding is not None:
                result.append(finding)
        # A table boundary always breaks a run in progress, even when every
        # room right up to the last one of this scope was a candidate.
        flush()
    return result


def _union(boxes: list[NormalizedBox]) -> NormalizedBox:
    return NormalizedBox(
        x0=min(b.x0 for b in boxes),
        y0=min(b.y0 for b in boxes),
        x1=max(b.x1 for b in boxes),
        y1=max(b.y1 for b in boxes),
    )


def pair_sheets(pd: list[SheetRooms], rd: list[SheetRooms]) -> list[tuple[SheetRooms, SheetRooms]]:
    """Match every RD sheet to its most likely PD counterpart, if any.

    A sheet whose best match still shares fewer than half its (smaller set
    of) room numbers is not a real pair - it just happens to reuse a few
    common numbers with some unrelated floor, and comparing it would invent
    findings out of two unrelated tables.
    """
    pairs: list[tuple[SheetRooms, SheetRooms]] = []
    for rd_sheet in rd:
        rd_keys = set(rd_sheet.rooms)
        if not rd_keys:
            continue

        best_pd, best_share = None, 0.0
        for pd_sheet in pd:
            pd_keys = set(pd_sheet.rooms)
            smaller = min(len(pd_keys), len(rd_keys))
            if smaller == 0:
                continue
            share = len(pd_keys & rd_keys) / smaller
            if share > best_share:
                best_pd, best_share = pd_sheet, share

        if best_pd is not None and best_share >= _MIN_SHARE:
            pairs.append((best_pd, rd_sheet))

    return pairs


def _neighbour_numbers(number: str) -> tuple[str, str] | None:
    """The two adjacent room numbers, in the same width as the original.

    "1.109" splits into prefix "1." and last part "109": neighbours are
    "1.108" and "1.110". A bare "7" has an empty prefix, giving "6" and "8".
    Letter numbers ("А", "Б" - Алтуфьевское's stair flights) have no digit
    suffix and no neighbours at all; a room numbered "...0" has no lower
    neighbour a real room could occupy, so it is treated the same way rather
    than inventing a negative one.
    """
    match = _NEIGHBOUR_NUMBER_RE.match(number)
    if match is None:
        return None
    prefix, digits = match.groups()
    width = len(digits)
    value = int(digits)
    if value == 0:
        return None
    return (f"{prefix}{str(value - 1).zfill(width)}", f"{prefix}{str(value + 1).zfill(width)}")


def _find_room(sheet: SheetRooms, number: str, scope: str | None) -> Room | None:
    # Neighbours are searched in the same scope as the room whose absence is
    # being checked (Наблюдение of the plan): two independent tables on one
    # sheet can reuse the same plain numbers, and a "neighbour" from the wrong
    # table proves nothing about the room actually missing.
    return next(
        (r for r in sheet.rooms.values() if r.number == number and r.scope == scope),
        None,
    )


def _compare_room(key: str, pd: SheetRooms, pd_room: Room, rd: SheetRooms, rd_room: Room,
                   relative_threshold: float) -> RoomFinding:
    # The dict key is room_key(room, rooms) from parse.py, not the bare
    # number: Алтуфьевское's ground floor "1" and antresol "1" are different
    # rooms, and a subject built from the number alone would let their
    # findings collide under one evidence_group_id.
    subject = f"room {key}"
    if abs(pd_room.area - rd_room.area) <= _AREA_TOLERANCE:
        return RoomFinding(
            subject=subject, status="NEGATIVE_VERIFIED",
            expected=_fmt(pd_room.area), actual=_fmt(rd_room.area), delta=None,
            rationale=(
                f"Площадь помещения {pd_room.number} совпадает в ПД и РД: "
                f"{_fmt_ru(pd_room.area)} м²."
            ),
            expected_sheet=pd, expected_box=pd_room.evidence_box,
            actual_sheet=rd, actual_box=rd_room.evidence_box,
        )

    delta = rd_room.area - pd_room.area
    if _within_rounding_tolerance(pd_room.area, rd_room.area, relative_threshold):
        return RoomFinding(
            subject=subject, status="NEGATIVE_VERIFIED",
            expected=_fmt(pd_room.area), actual=_fmt(rd_room.area), delta=None,
            rationale=(
                f"Площадь помещения {pd_room.number}: в ПД {_fmt_ru(pd_room.area)} м², "
                f"в РД {_fmt_ru(rd_room.area)} м² — различие в пределах точности "
                f"записи и допуска {relative_threshold:.0%}."
            ),
            expected_sheet=pd, expected_box=pd_room.evidence_box,
            actual_sheet=rd, actual_box=rd_room.evidence_box,
        )

    return RoomFinding(
        subject=subject, status="CANDIDATE",
        expected=_fmt(pd_room.area), actual=_fmt(rd_room.area), delta=_fmt_signed(delta),
        rationale=(
            f"Площадь помещения {pd_room.number} изменена: в ПД "
            f"{_fmt_ru(pd_room.area)} м², в РД {_fmt_ru(rd_room.area)} м² "
            f"(дельта {_fmt_signed_ru(delta)} м²)."
        ),
        expected_sheet=pd, expected_box=pd_room.evidence_box,
        actual_sheet=rd, actual_box=rd_room.evidence_box,
    )


def _absent_from_rd(key: str, pd: SheetRooms, pd_room: Room, rd: SheetRooms) -> RoomFinding | None:
    """A room the design sheet has but the working sheet does not.

    Only reported when the working sheet shows both its numeric neighbours -
    proof the gap is a real removal, not a parsing miss on that sheet.
    """
    neighbours = _neighbour_numbers(pd_room.number)
    if neighbours is None:
        return None
    lower_number, upper_number = neighbours
    lower = _find_room(rd, lower_number, pd_room.scope)
    upper = _find_room(rd, upper_number, pd_room.scope)
    if lower is None or upper is None:
        return None

    absence_box = _union([lower.evidence_box, upper.evidence_box])
    return RoomFinding(
        subject=f"room {key}", status="CANDIDATE",
        expected=_fmt(pd_room.area), actual=None, delta=None,
        rationale=(
            f"В РД отсутствует помещение {pd_room.number} площадью "
            f"{_fmt_ru(pd_room.area)} м²; в РД между {lower_number} и "
            f"{upper_number} его нет."
        ),
        expected_sheet=pd, expected_box=pd_room.evidence_box,
        actual_sheet=rd, actual_box=absence_box,
    )


def _added_in_rd(key: str, pd: SheetRooms, rd: SheetRooms, rd_room: Room) -> RoomFinding | None:
    """The mirror case: a room the working sheet has that the design does not."""
    neighbours = _neighbour_numbers(rd_room.number)
    if neighbours is None:
        return None
    lower_number, upper_number = neighbours
    lower = _find_room(pd, lower_number, rd_room.scope)
    upper = _find_room(pd, upper_number, rd_room.scope)
    if lower is None or upper is None:
        return None

    absence_box = _union([lower.evidence_box, upper.evidence_box])
    return RoomFinding(
        subject=f"room {key}", status="CANDIDATE",
        expected=None, actual=_fmt(rd_room.area), delta=None,
        rationale=(
            f"В РД добавлено помещение {rd_room.number} площадью "
            f"{_fmt_ru(rd_room.area)} м²; в ПД между {lower_number} и "
            f"{upper_number} его нет."
        ),
        expected_sheet=pd, expected_box=absence_box,
        actual_sheet=rd, actual_box=rd_room.evidence_box,
    )


def _compare_totals(pd: SheetRooms, rd: SheetRooms, relative_threshold: float) -> RoomFinding | None:
    # Only compared when each sheet carries exactly one total: with zero,
    # there is nothing to compare, and with more than one, which total on one
    # sheet corresponds to which on the other is not determined by anything
    # this module knows.
    if len(pd.totals) != 1 or len(rd.totals) != 1:
        return None

    pd_total, rd_total = pd.totals[0], rd.totals[0]
    delta = rd_total.area - pd_total.area
    if abs(delta) <= _AREA_TOLERANCE:
        return RoomFinding(
            subject="floor total", status="NEGATIVE_VERIFIED",
            expected=_fmt(pd_total.area), actual=_fmt(rd_total.area), delta=None,
            rationale=f"Итог по этажу совпадает в ПД и РД: {_fmt_ru(pd_total.area)} м².",
            expected_sheet=pd, expected_box=pd_total.evidence_box,
            actual_sheet=rd, actual_box=rd_total.evidence_box,
        )

    # Same rounding allowance as a single room (module docstring): a floor
    # total is itself just a sum of room areas, so the same systematic
    # recalculation that nudges every room by one step nudges the total too -
    # СОШ25's own total (6234.10 -> 6252.30, +0.29%) is exactly this case.
    if _within_rounding_tolerance(pd_total.area, rd_total.area, relative_threshold):
        return RoomFinding(
            subject="floor total", status="NEGATIVE_VERIFIED",
            expected=_fmt(pd_total.area), actual=_fmt(rd_total.area), delta=None,
            rationale=(
                f"Итог по этажу: в ПД {_fmt_ru(pd_total.area)} м², "
                f"в РД {_fmt_ru(rd_total.area)} м² — различие в пределах точности "
                f"записи и допуска {relative_threshold:.0%}."
            ),
            expected_sheet=pd, expected_box=pd_total.evidence_box,
            actual_sheet=rd, actual_box=rd_total.evidence_box,
        )

    return RoomFinding(
        subject="floor total", status="CANDIDATE",
        expected=_fmt(pd_total.area), actual=_fmt(rd_total.area), delta=_fmt_signed(delta),
        rationale=(
            f"Итог по этажу изменён: в ПД {_fmt_ru(pd_total.area)} м², "
            f"в РД {_fmt_ru(rd_total.area)} м² (дельта {_fmt_signed_ru(delta)} м²)."
        ),
        expected_sheet=pd, expected_box=pd_total.evidence_box,
        actual_sheet=rd, actual_box=rd_total.evidence_box,
    )


def compare_sheets(pd: SheetRooms, rd: SheetRooms,
                    relative_threshold: float = DEFAULT_AREA_RELATIVE_THRESHOLD) -> list[RoomFinding]:
    """`relative_threshold` is M-002's own compare_threshold (app.pipeline
    reads it from specs/params/M-002.yaml and passes it through); the default
    here only covers direct callers that do not - tests, and a spec file that
    failed to load at all.
    """
    keys = sorted(set(pd.rooms) | set(rd.rooms))
    finding_by_key: dict[str, RoomFinding] = {}
    scope_by_key: dict[str, str | None] = {}
    number_by_key: dict[str, str] = {}

    for key in keys:
        pd_room = pd.rooms.get(key)
        rd_room = rd.rooms.get(key)
        room = pd_room if pd_room is not None else rd_room
        scope_by_key[key] = room.scope
        number_by_key[key] = room.number

        if pd_room is not None and rd_room is not None:
            finding_by_key[key] = _compare_room(key, pd, pd_room, rd, rd_room, relative_threshold)
            continue

        finding = (
            _absent_from_rd(key, pd, pd_room, rd) if pd_room is not None
            else _added_in_rd(key, pd, rd, rd_room)
        )
        if finding is not None:
            finding_by_key[key] = finding

    findings: list[RoomFinding] = _group_room_findings(keys, finding_by_key, scope_by_key, number_by_key)

    totals_finding = _compare_totals(pd, rd, relative_threshold)
    if totals_finding is not None:
        findings.append(totals_finding)

    return findings
