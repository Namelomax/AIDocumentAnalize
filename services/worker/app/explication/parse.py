"""Rooms and floor totals out of a page's own text lines.

There is no layout metadata to lean on here: CAD exports a plan label as a
free-floating block near the room outline, and a specification table as a
grid of lines that PDF's own text extractor does not always keep together as
one block per row. Every rule below was shaped against real sheets of
`Задание/Комплект_предметной_разметки.pdf`, because a rule that looks
reasonable in the abstract kept catching a real decoy: a room's own number,
a plan dimension, or an axis label.

The overriding rule (ТЗ FPR <= 0.10): when a line's role is ambiguous, it is
left out of the result. A missed room costs recall; an invented one costs
precision and, doubled across a design/working pair, a false violation.
"""

import re
from dataclasses import dataclass

from app.pdf.extract import ExtractedBlock, ExtractedLine, ExtractedPage
from app.pdf.geometry import NormalizedBox

# Two lines whose vertical gap is smaller than this are considered to sit in
# the same table row. Measured against the school sheet (pages 19-20 of the
# reference package): a row's own cells (number, area, category) share the
# same y-box to within rounding, while consecutive rows are ~0.013 apart, so
# anything under half that spacing is safely "this row" and not the next one.
_ROW_TOLERANCE = 0.008

# A name candidate further than this from the nearest row's number is not
# that row's name - it is unrelated page furniture inside the same column
# band (Алтуфьевское, лист 2: "План антресольного этажа" sits right above
# the antresol table, in the same x-range, and being closest to no other
# row does not make it that row's name).
_NAME_MAX_DISTANCE = 0.012

# A table's column band is derived from its header cells, not from content:
# Алтуфьевское's "Имя" header sits to the right of where the name text it
# labels actually starts (header 0.9005 vs content 0.8794), so the header
# only bounds the table, it does not mark where each column begins.
_BAND_LEFT_MARGIN = 0.006
_BAND_RIGHT_MARGIN = 0.012

# Two tables are only treated as x-neighbours worth clipping a margin
# against when their headers sit at roughly the same height - i.e. they are
# actually side by side. Школа's seven tables share one header row; Полярная,
# лист 21/22 stacks two explication tables ~0.27 of the page apart, and no
# clipping should ever happen between those.
_SAME_ROW_Y_TOLERANCE = 0.05

# Room numbers are written with dots ("1.0.9", "1.109"); areas with commas
# ("5,95", "18,2"). A dotted number is only mistaken for an area when it
# carries the m² unit, which the tables spell out explicitly ("11.33 м²",
# Алтуфьевское, лист 2) - Наблюдение 3 of the plan.
_AREA_COMMA_RE = re.compile(r"^\d+,\d+$")
_AREA_DOT_UNIT_RE = re.compile(r"^\d+(?:\.\d+)?\s*м²$")

# A composite room number as it is written on a CAD plan label: at least one
# dot, so a bare "2390" (a dimension in millimetres, Алтуфьевское лист 2)
# never qualifies without the table context of Detector 2 below.
_COMPOSITE_NUMBER_RE = re.compile(r"^\d+(?:\.\d+)+$")

# A table cell's number, optionally glued to the name on the same physical
# text line ("1.107 Санузел для посетителей", школа лист 19): plain digits,
# dotted composites, or a bare single letter ("А", "Б" - Алтуфьевское's
# stair flights on лист 2 antresol table).
_TABLE_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)*|[A-ZА-Я])(?:\s+(.+))?$")

_NAME_HEADER_TEXTS = {"наименование", "имя"}
_NUMBER_HEADER_TEXTS = {"№", "номер"}

# Every floor-total label variant actually seen on the reference sheets.
_TOTAL_LABEL_TEXTS = {"общий итог по этажу", "итоговая площадь", "итог по этажу", "итого"}


@dataclass(frozen=True)
class Room:
    number: str             # as written on the sheet: "1.0.9", "1.109", "7"
    area: float              # m²
    name: str | None         # "Тамбур", "Зона ожидания" or None when not found
    box: NormalizedBox       # union of the lines that make up the room
    # The table this row belongs to (its caption, or a stable fallback id
    # when there is none), or None for a plan label. Plain numbers repeat
    # across independent tables (Алтуфьевское, лист 2: "1" is both the
    # ground floor's "Зона мойки" and the antresol's "Тех.помещение"), and
    # the scope is what lets a caller tell those two rooms apart.
    scope: str | None = None
    # The rectangle actually drawn as evidence - wider than `box` for a table
    # row. СОШ25's reference markup (Задание/Матрица_параметров) frames a
    # table finding with the row above and the row below it, not the row
    # alone: a missing room's two table neighbours are boxed together with
    # one further row on each side, and an added room's own row keeps its
    # immediate neighbours too (see `_row_neighbourhood`). A plan label
    # (Detector 1) has no neighbouring rows to speak of - it is already the
    # room's own CAD tag - so it carries no padding of its own. Defaults to
    # `box` so a caller built before this field existed (a plan label, a
    # merge, a test's own `Room(...)`) still gets a usable evidence box.
    evidence_box: NormalizedBox | None = None

    def __post_init__(self) -> None:
        if self.evidence_box is None:
            object.__setattr__(self, "evidence_box", self.box)


@dataclass(frozen=True)
class FloorTotal:
    label: str               # "Общий итог по этажу", "итоговая площадь"...
    area: float
    box: NormalizedBox
    # Same widening as `Room.evidence_box`, padded with the table's own last
    # room row (a total is always the table's last line, so there is never
    # a row below it to pad with) - see `_total_evidence_box`.
    evidence_box: NormalizedBox | None = None

    def __post_init__(self) -> None:
        if self.evidence_box is None:
            object.__setattr__(self, "evidence_box", self.box)


def _area_value(text: str) -> float | None:
    if _AREA_COMMA_RE.match(text):
        return float(text.replace(",", "."))
    if _AREA_DOT_UNIT_RE.match(text):
        return float(text.split()[0])
    return None


def _union(boxes: list[NormalizedBox]) -> NormalizedBox:
    return NormalizedBox(
        x0=min(b.x0 for b in boxes),
        y0=min(b.y0 for b in boxes),
        x1=max(b.x1 for b in boxes),
        y1=max(b.y1 for b in boxes),
    )


def _overlaps(a0: float, a1: float, b0: float, b1: float, tolerance: float) -> bool:
    return a0 - tolerance <= b1 and b0 - tolerance <= a1


# --- Detector 1: a label drawn directly on the plan --------------------------
#
# Полярная, лист 21/22: block ["1.0.9", "5,95"], occasionally a third line
# with the name ("1.0.11", "7,92", "Тамбур"). The block is not part of any
# table - it is the CAD room tag sitting on the drawing next to the outline -
# so there is no header to confirm the number is a room and not something
# else. The dot in the number is what stands in for that confirmation: a
# plain "2" or "7" on a plan is a grid/dimension number (Алтуфьевское, лист
# 2, blocks of axis and dimension labels), never a room, so Detector 1 only
# accepts composite numbers.
def _rooms_from_plan_labels(page: ExtractedPage, table_anchors: list["_TableAnchor"]) -> list[Room]:
    candidates: list[tuple[ExtractedBlock, str, float, str | None]] = []

    for block in page.blocks:
        if len(block.lines) < 2:
            continue

        # Полярная's own explication tables are laid out as one small
        # number+name+area block per row (лист 21/22, e.g. block
        # ["1.0.4", "Вестибюль", "36,46"]) - the same shape Detector 1 looks
        # for on the drawing. Left unfiltered, a room whose true plan tag
        # was disqualified for some other reason would fall back to this
        # table row as its "plan label", and the row spans number to area
        # across the table's name column - far wider than any real tag. A
        # block already claimed by a table is never this detector's to
        # report; Detector 2 owns it.
        if any(anchor.x_left <= block.box.x0 <= anchor.x_right
               and anchor.y_top <= block.box.y0 <= anchor.y_bottom
               for anchor in table_anchors):
            continue

        number_lines = [l for l in block.lines if _COMPOSITE_NUMBER_RE.match(l.text)]
        area_lines = [l for l in block.lines if _area_value(l.text) is not None]
        if len(number_lines) != 1 or len(area_lines) != 1:
            continue

        # Most plan tags are two or three lines (number, area, optionally
        # one name line), but лист 22's "1.0.4" shows a real tag can carry a
        # red organizer's annotation glued on as two more lines ("Места
        # расположения почтовых ящиков см. раздел АИ2"). Requiring exactly
        # one number and one area already does the disambiguating work, so
        # any number of leftover lines are joined as the name rather than
        # rejecting the block outright - the alternative is losing the one
        # tight box this room has on the whole sheet.
        remaining = sorted(
            (l for l in block.lines if l is not number_lines[0] and l is not area_lines[0]),
            key=lambda l: l.box.y0,
        )
        name = " ".join(l.text for l in remaining) if remaining else None
        candidates.append((block, number_lines[0].text, _area_value(area_lines[0].text), name))

    # Полярная's room numbers are all three-level ("1.0.9"); a two-level
    # dotted number there is an axis mark, not a room (Наблюдение 5 of the
    # plan, from the full sheet the reference excerpt was cut from - this
    # excerpt alone never produces a minority form, so the filter is a no-op
    # here, but it is cheap insurance against exactly that decoy elsewhere).
    if candidates:
        dot_counts = [number.count(".") for _, number, _, _ in candidates]
        dominant = max(set(dot_counts), key=dot_counts.count)
        candidates = [c for c in candidates if c[1].count(".") == dominant]

    rooms = []
    for block, number, area, name in candidates:
        rooms.append(Room(number=number, area=area, name=name, box=block.box, scope=None))
    return rooms


# --- Detector 2: a specification table ---------------------------------------
#
# Наблюдение 2 of the plan: a table row is cells lying on one horizontal, not
# necessarily one block. Школа, лист 19/20: a room's number, its (possibly
# two-line) name and its area routinely land in three separate blocks that
# only share a y-position - PyMuPDF's own line grouping never reassembles
# them. So rows are found by scanning every line on the page inside the
# table's column band and grouping by vertical position, not by block.
@dataclass(frozen=True)
class _TableAnchor:
    x_left: float
    x_right: float
    y_top: float
    y_bottom: float
    name_right: float  # right edge of the name column, used to keep a
    # category cell ("В4", "-") out of the name text.
    scope: str | None = None


# A caption sits directly above its table's header, never inside or below
# it: Алтуфьевское, лист 2's "Спецификация помещений антресольного этажа"
# ends ~0.005-0.008 above its header row, and Полярная's "Экспликация
# помещений..." captions the same. The gap is generous insurance, not a
# measured bound - it only has to stay short of the previous table's own
# rows on a crowded sheet.
_CAPTION_MAX_GAP = 0.03
_CAPTION_MARGIN = 0.05
_CAPTION_WORDS = ("спецификация", "экспликация")


def _find_caption(page: ExtractedPage, core_left: float, core_right: float, header_top: float) -> str | None:
    best_block, best_gap = None, None
    for block in page.blocks:
        if not any(word in line.text.lower() for line in block.lines for word in _CAPTION_WORDS):
            continue
        gap = header_top - block.box.y1
        if gap < 0 or gap > _CAPTION_MAX_GAP:
            continue
        if not (core_left - _CAPTION_MARGIN <= block.box.x0 <= core_right + _CAPTION_MARGIN):
            continue
        if best_gap is None or gap < best_gap:
            best_block, best_gap = block, gap
    return best_block.text if best_block else None


def _find_table_anchors(page: ExtractedPage) -> list[_TableAnchor]:
    all_lines = [line for block in page.blocks for line in block.lines]
    raw = []

    for name_line in all_lines:
        if name_line.text.strip().lower() not in _NAME_HEADER_TEXTS:
            continue

        # Школа, лист 19/20: seven near-identical tables sit side by side in
        # the same header row, so several "№" (or "Площадь") cells all share
        # this name-header's y-range. Only the nearest one in x is this
        # table's own column; picking the first match in document order once
        # gave every table on the page the same (wrong) right-hand table's
        # category column.
        number_line = min(
            (l for l in all_lines
             if l.text.strip().lower() in _NUMBER_HEADER_TEXTS
             and l.box.x0 < name_line.box.x0
             and _overlaps(l.box.y0, l.box.y1, name_line.box.y0, name_line.box.y1, _ROW_TOLERANCE)),
            key=lambda l: name_line.box.x0 - l.box.x0,
            default=None,
        )
        area_line = min(
            (l for l in all_lines
             if l.text.strip().startswith("Площадь")
             and l.box.x0 > name_line.box.x0
             and _overlaps(l.box.y0, l.box.y1, name_line.box.y0, name_line.box.y1, _ROW_TOLERANCE)),
            key=lambda l: l.box.x0 - name_line.box.x0,
            default=None,
        )
        if number_line is None or area_line is None:
            continue

        category_line = min(
            (l for l in all_lines
             if l.text.strip().startswith("Кат")
             and l.box.x0 > area_line.box.x0
             and _overlaps(l.box.y0, l.box.y1, name_line.box.y0, name_line.box.y1, _ROW_TOLERANCE)),
            key=lambda l: l.box.x0 - area_line.box.x0,
            default=None,
        )

        core_left = number_line.box.x0
        core_right = category_line.box.x1 if category_line else area_line.box.x1
        y_top = max(number_line.box.y1, name_line.box.y1, area_line.box.y1)
        header_top = min(number_line.box.y0, name_line.box.y0, area_line.box.y0)
        raw.append({
            "core_left": core_left, "core_right": core_right,
            "y_top": y_top, "header_top": header_top, "name_right": area_line.box.x0,
        })

    # Школа, лист 19/20: seven tables sit side by side with only ~0.01-0.02
    # of page width between one table's category column and the next one's
    # number column. A fixed margin on both sides of that gap used to make
    # neighbouring bands overlap, and a room number from one table (e.g.
    # "1.43") would then be paired against another table's area value,
    # shifting every room below it by one row. Margins are capped at half the
    # actual gap to a neighbour, so adjacent bands never touch.
    #
    # That clipping only makes sense between tables that actually compete for
    # the same rows - i.e. side by side, headers at the same height. Полярная,
    # лист 21/22 stacks two explication tables in the same x-range, one above
    # the other (headers ~0.27 of the page apart); sorted by x alone they look
    # like neighbours too, and clipping against a table nowhere near the same
    # rows shrank the lower table's own left margin until it excluded its own
    # first row's number.
    raw.sort(key=lambda item: item["core_left"])
    anchors = []
    for index, item in enumerate(raw):
        left_margin = _BAND_LEFT_MARGIN
        if index > 0 and abs(item["y_top"] - raw[index - 1]["y_top"]) < _SAME_ROW_Y_TOLERANCE:
            gap = item["core_left"] - raw[index - 1]["core_right"]
            left_margin = min(_BAND_LEFT_MARGIN, max(gap / 2, 0.0))
        right_margin = _BAND_RIGHT_MARGIN
        if index < len(raw) - 1 and abs(item["y_top"] - raw[index + 1]["y_top"]) < _SAME_ROW_Y_TOLERANCE:
            gap = raw[index + 1]["core_left"] - item["core_right"]
            right_margin = min(_BAND_RIGHT_MARGIN, max(gap / 2, 0.0))

        x_left = item["core_left"] - left_margin
        x_right = item["core_right"] + right_margin
        y_top = item["y_top"]

        total_line = next(
            (l for l in all_lines
             if l.text.strip().rstrip(":").strip().lower() in _TOTAL_LABEL_TEXTS
             and x_left <= l.box.x0 <= x_right
             and l.box.y0 > y_top),
            None,
        )
        # Школа, лист 19: past the table's own total, the sheet's title block
        # (revision dates, sign-offs) briefly shares this x-band too, and a
        # date like "04.04.25" reads as a composite number. It never becomes
        # a room in practice, because nothing area-shaped sits next to it -
        # the y bound below is only tightened when a real total marks a
        # cleaner edge; without one, the row-pairing requirement is already
        # what keeps the table's rows from the stamp's, so the table simply
        # extends to the bottom of the page.
        y_bottom = total_line.box.y1 + _ROW_TOLERANCE if total_line else 1.0

        # The caption identifies the table to a caller (Алтуфьевское's two
        # tables reuse "1", "2", "А", "Б" for different rooms); a table
        # without one still needs a scope that stays the same across calls,
        # so its position among this page's tables stands in for a name.
        scope = _find_caption(page, item["core_left"], item["core_right"], item["header_top"])
        if scope is None:
            scope = f"table#{index}"

        anchors.append(_TableAnchor(
            x_left=x_left, x_right=x_right, y_top=y_top, y_bottom=y_bottom,
            name_right=item["name_right"], scope=scope,
        ))

    return anchors


def _y_mid(box: NormalizedBox) -> float:
    return (box.y0 + box.y1) / 2


def _group_rows(page: ExtractedPage, anchor: _TableAnchor) -> list[dict]:
    """Every line inside one table's column band, folded into rows by shared
    y-position - the row-finding half of Detector 2, split out so both a
    room's own evidence box and a floor total's (in `find_floor_totals`) can
    borrow "the row above" or "the row below" from the same table without
    re-deriving it.

    Each row dict carries its cells (`number_line`, `area_line`, `name_lines`,
    `inline_name`) for `_rooms_from_table` to turn into a `Room`, plus
    `span`: the row's own full vertical extent, wrapped name lines included -
    a room's name routinely wraps two or three lines (СОШ25's "1.109", школа
    лист 20), and a neighbouring row's padding has to carry that whole name,
    not just its number and area cells, to mean anything as evidence.
    """
    numbers: list[tuple[ExtractedLine, str, str | None]] = []
    areas: list[tuple[ExtractedLine, float]] = []
    name_candidates: list[ExtractedLine] = []

    for block in page.blocks:
        for line in block.lines:
            if not (anchor.x_left <= line.box.x0 <= anchor.x_right):
                continue
            if not (anchor.y_top <= line.box.y0 <= anchor.y_bottom):
                continue
            stripped = line.text.strip().lower()
            if stripped in _NAME_HEADER_TEXTS or stripped in _NUMBER_HEADER_TEXTS:
                continue  # the header row itself, not a room
            if stripped.rstrip(":").strip() in _TOTAL_LABEL_TEXTS:
                # Алтуфьевское, лист 2: "Общий итог по этажу" sits directly
                # below the table's last row ("Б"), close enough in y to
                # otherwise be picked up as that room's name.
                continue

            # Area is checked first: a dotted number followed by the m² unit
            # ("11.33 м²", Алтуфьевское лист 2) also matches the number
            # pattern's "number, then trailing text" shape, and the unit is
            # what tells the two apart (Наблюдение 3 of the plan).
            area_value = _area_value(line.text)
            number_match = _TABLE_NUMBER_RE.match(line.text)
            if area_value is not None:
                areas.append((line, area_value))
            elif number_match:
                numbers.append((line, number_match.group(1), number_match.group(2)))
            elif line.box.x0 < anchor.name_right:
                name_candidates.append(line)

    numbers.sort(key=lambda item: item[0].box.y0)
    used_areas: set[int] = set()
    rows = []

    for number_line, number, inline_name in numbers:
        best_index, best_gap = None, None
        for index, (area_line, _) in enumerate(areas):
            if index in used_areas:
                continue
            if not _overlaps(number_line.box.y0, number_line.box.y1,
                              area_line.box.y0, area_line.box.y1, _ROW_TOLERANCE):
                continue
            gap = abs(_y_mid(number_line.box) - _y_mid(area_line.box))
            if best_gap is None or gap < best_gap:
                best_index, best_gap = index, gap

        if best_index is None:
            # No area shares this row: a bare number here proves nothing
            # (Наблюдение 4 restricts plain numbers to table context, but the
            # row must still be complete - an unmatched number is left out
            # rather than guessed at).
            continue
        used_areas.add(best_index)
        area_line, area_value = areas[best_index]
        rows.append({
            "number": number, "number_line": number_line,
            "area_value": area_value, "area_line": area_line,
            "inline_name": inline_name, "name_lines": [],
        })

    # Names are bound to whichever row's number sits closest in y, not by an
    # absolute distance threshold: Алтуфьевское's antresol table (лист 2)
    # packs rows only ~0.008 apart, tighter than the ~0.013 that separates
    # rows on the school sheet, so no single tolerance is safe for both. A
    # fixed tolerance there pulled the next row's own name into this one's.
    for line in name_candidates:
        if not rows:
            break
        nearest = min(rows, key=lambda r: abs(_y_mid(line.box) - _y_mid(r["number_line"].box)))
        if abs(_y_mid(line.box) - _y_mid(nearest["number_line"].box)) <= _NAME_MAX_DISTANCE:
            nearest["name_lines"].append(line)

    for row in rows:
        parts = [row["number_line"].box, row["area_line"].box, *(l.box for l in row["name_lines"])]
        row["span"] = _union(parts)

    rows.sort(key=lambda r: r["span"].y0)
    return rows


# A finding's evidence box is padded with this many table rows on each side -
# the one free parameter of the widening rule below, not a page-specific
# offset. Measured against СОШ25-V01, the reference package's only reference
# bbox for an explication finding: room 1.109's reference box (RD, лист 20)
# covers its own row plus its immediate neighbours, and the reference box for
# its absence (PD, лист 19) covers the two rows bounding the gap plus one
# further row past each of them - which is exactly what padding *each*
# neighbour's own evidence box by one row already produces once
# `compare.py` unions the two neighbours together. Padding by 0 rows (the row
# alone) undershoots both reference boxes (IoU 0.32 and 0.17); padding by 2
# overshoots the absence box (IoU drops back to 0.38) even as it improves the
# single-room box further. 1 is the only value that clears the ТЗ's IoU >=
# 0.50 threshold on both of this package's reference boxes at once.
_ROW_PADDING = 1


def _row_neighbourhood(rows: list[dict], index: int, anchor: _TableAnchor) -> NormalizedBox:
    """`rows[index]`'s own row, padded with `_ROW_PADDING` rows on each side,
    spanning every column the table anchor bounds (i.e. including the name
    column that `Room.box` itself leaves out, and stopping short of the next
    table the same way `anchor.x_right` already does)."""
    lo = max(0, index - _ROW_PADDING)
    hi = min(len(rows) - 1, index + _ROW_PADDING)
    y0 = min(rows[i]["span"].y0 for i in range(lo, hi + 1))
    y1 = max(rows[i]["span"].y1 for i in range(lo, hi + 1))
    return NormalizedBox(anchor.x_left, y0, anchor.x_right, y1)


def _rooms_from_table(page: ExtractedPage, anchor: _TableAnchor) -> list[Room]:
    rows = _group_rows(page, anchor)

    rooms = []
    for index, row in enumerate(rows):
        if row["inline_name"]:
            name = row["inline_name"].strip()
        else:
            ordered = sorted(row["name_lines"], key=lambda l: l.box.y0)
            name = " ".join(l.text for l in ordered) if ordered else None
        box = _union([row["number_line"].box, row["area_line"].box])
        rooms.append(Room(number=row["number"], area=row["area_value"], name=name,
                           box=box, scope=anchor.scope,
                           evidence_box=_row_neighbourhood(rows, index, anchor)))

    return rooms


# Two areas this close are "the same room", not a coincidence: the two
# detectors routinely re-find the identical Полярная room (a plan label and
# its twin table row), and the reported area is the same value rounded the
# same way, never off by more than a rounding error.
_AREA_MERGE_TOLERANCE = 0.005


def _cluster_by_area(rooms: list[Room]) -> list[list[Room]]:
    ordered = sorted(rooms, key=lambda r: r.area)
    clusters: list[list[Room]] = []
    for room in ordered:
        if clusters and abs(room.area - clusters[-1][-1].area) <= _AREA_MERGE_TOLERANCE:
            clusters[-1].append(room)
        else:
            clusters.append([room])
    return clusters


def _box_area(box: NormalizedBox) -> float:
    return (box.x1 - box.x0) * (box.y1 - box.y0)


def _merge_cluster(number: str, cluster: list[Room]) -> Room:
    name = next((r.name for r in cluster if r.name), None)
    scope = next((r.scope for r in cluster if r.scope), None)

    # The box is one detection's own, not a union: Полярная, лист 21/22
    # tags the same room twice - a small label on the plan and a row in the
    # explication table, often far apart on the sheet - and a union of the
    # two used to stretch the evidence rectangle across a third of the
    # page, which both fails the specification's IoU >= 0.50 localisation
    # check against a small reference bbox and would highlight half the
    # drawing in the inspector's card. A plan label sits where the room
    # physically is, so it is preferred; the table row is only a fallback
    # for numbers no plan label ever tagged.
    plan_labels = [r for r in cluster if r.scope is None]
    candidates = plan_labels if plan_labels else cluster
    representative = min(candidates, key=lambda r: _box_area(r.box))

    # Carried over explicitly, not left to `Room`'s own default: leaving it
    # off would default the merged room's evidence box back to
    # `representative.box` (the narrow one), throwing away whatever row
    # padding `_row_neighbourhood` already computed for it.
    return Room(number=number, area=cluster[0].area, name=name,
                box=representative.box, scope=scope,
                evidence_box=representative.evidence_box)


def _dedupe_rooms(rooms: list[Room]) -> list[Room]:
    """Fold every detector's raw hits for one number into 0, 1, or more rooms.

    The two detectors above routinely find the same physical room twice (a
    plan label and its twin table row), and Алтуфьевское, лист 2 reuses
    plain numbers ("1", "2", "А", "Б") for genuinely different rooms in two
    separate tables. Both are ordinary; what is not resolvable - the same
    number, conflicting areas, and no table boundary to blame it on - is
    exactly the kind of value the FPR <= 0.10 threshold says must not be
    reported rather than guessed at.
    """
    by_number: dict[str, list[Room]] = {}
    for room in rooms:
        by_number.setdefault(room.number, []).append(room)

    merged: list[Room] = []
    for number, entries in by_number.items():
        clusters = _cluster_by_area(entries)
        if len(clusters) == 1:
            merged.append(_merge_cluster(number, clusters[0]))
            continue

        # More than one area survives clustering: acceptable only when every
        # cluster is confined to its own, otherwise unused table scope - the
        # ground floor's "1" (165.05 m²) and the antresol's "1" (11.33 m²)
        # are different rooms precisely because they come from different
        # tables. A None scope (a plan label) or a scope shared by two
        # clusters proves nothing, so the whole number is dropped.
        scope_sets = [{room.scope for room in cluster} for cluster in clusters]
        distinct_scopes = {next(iter(scopes)) for scopes in scope_sets}
        clean_split = (
            all(len(scopes) == 1 and None not in scopes for scopes in scope_sets)
            and len(distinct_scopes) == len(clusters)
        )
        if not clean_split:
            continue
        for cluster in clusters:
            merged.append(_merge_cluster(number, cluster))

    return merged


def find_rooms(page: ExtractedPage) -> list[Room]:
    anchors = _find_table_anchors(page)
    rooms = _rooms_from_plan_labels(page, anchors)
    for anchor in anchors:
        rooms.extend(_rooms_from_table(page, anchor))

    rooms = _dedupe_rooms(rooms)

    # Ordered top-to-bottom for a stable, reproducible result. (Deduplication
    # above already resolves the one case where page order used to matter -
    # Алтуфьевское's two same-numbered tables - so this is no longer load
    # bearing for that, just a predictable order for callers.)
    rooms.sort(key=lambda r: (r.box.y0, r.box.x0))
    return rooms


def room_key(room: Room, rooms: list[Room]) -> str:
    """Stable identity for a room within one page's `find_rooms` result.

    Plain numbers are only unique within their own table (Алтуфьевское,
    лист 2), so a comparator that keys rooms by number alone needs a
    fallback for the pages where that is not enough.
    """
    if sum(1 for r in rooms if r.number == room.number) == 1:
        return room.number
    return f"{room.scope}|{room.number}"


# --- Floor totals --------------------------------------------------------
#
# Наблюдение 7: a labelled line ("Общий итог по этажу", "Итого:") with an
# area value on the same horizontal. Школа, лист 20 carries a decoy: a red
# organizer's annotation reading "Итоговая площадь стала 6252,3 м²." in one
# sentence - it never matches because the label and the value must each be
# a whole line on their own, and here they are one sentence together.
def _total_evidence_box(page: ExtractedPage, anchors: list[_TableAnchor],
                         label_line: ExtractedLine, own_box: NormalizedBox) -> NormalizedBox:
    """Widen a floor total's box the same way a table row is widened - one
    neighbouring row of context (`_ROW_PADDING`), here the table's own last
    room row, since a total is always the table's last line and never has a
    row below it to pad with instead.

    A total whose label does not sit inside any of the page's own table
    column bands (a shape `_find_table_anchors` never expected) keeps its own
    narrow box rather than guessing which table it belongs to.
    """
    anchor = next(
        (a for a in anchors if a.x_left <= label_line.box.x0 <= a.x_right),
        None,
    )
    if anchor is None:
        return own_box

    rows = _group_rows(page, anchor)
    if not rows:
        return NormalizedBox(anchor.x_left, own_box.y0, anchor.x_right, own_box.y1)

    last_row = rows[-1]["span"]
    y0 = min(own_box.y0, last_row.y0)
    y1 = max(own_box.y1, last_row.y1)
    return NormalizedBox(anchor.x_left, y0, anchor.x_right, y1)


def find_floor_totals(page: ExtractedPage) -> list[FloorTotal]:
    anchors = _find_table_anchors(page)
    all_lines = [line for block in page.blocks for line in block.lines]
    totals = []
    used_values: set[int] = set()

    label_lines = [
        line for line in all_lines
        if line.text.strip().rstrip(":").strip().lower() in _TOTAL_LABEL_TEXTS
    ]
    label_lines.sort(key=lambda l: l.box.y0)

    for label_line in label_lines:
        best_index, best_gap = None, None
        for index, value_line in enumerate(all_lines):
            if index in used_values:
                continue
            area_value = _area_value(value_line.text)
            if area_value is None:
                continue
            if value_line.box.x0 <= label_line.box.x0:
                continue
            if not _overlaps(label_line.box.y0, label_line.box.y1,
                              value_line.box.y0, value_line.box.y1, _ROW_TOLERANCE):
                continue
            gap = abs((label_line.box.y0 + label_line.box.y1) / 2
                      - (value_line.box.y0 + value_line.box.y1) / 2)
            if best_gap is None or gap < best_gap:
                best_index, best_gap = index, gap

        if best_index is None:
            continue
        used_values.add(best_index)
        value_line = all_lines[best_index]
        own_box = _union([label_line.box, value_line.box])
        totals.append(FloorTotal(
            label=label_line.text,
            area=_area_value(value_line.text),
            box=own_box,
            evidence_box=_total_evidence_box(page, anchors, label_line, own_box),
        ))

    return totals
