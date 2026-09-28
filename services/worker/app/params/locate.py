"""Finding one matrix parameter's own value on one stage's documents.

A "scalar_text" parameter (95 of the matrix's 132) is a number, an enum code
or a short string printed once per document - a ТЭП table row ("Площадь
застройки, м2 | 1520,4"), or a sentence in a text section ("Этажность здания
- 9 эт."). There is no layout metadata that says "this is the ТЭП table" the
way an explication table's header row does (app.explication.parse's own
module docstring); the label text itself is what locates the row.

Matching is deliberately conservative (ТЗ FPR <= 0.10, same rule
app.explication.parse leans on): a label is only accepted when the whole
phrase - not just a shared word like "площадь" - appears in a line, so
"Площадь застройки" and "Площадь участка" never cross-match just because
they share a word. A value is only read off a line once a label matched
there, in the same row, or in the line directly below it; nothing is ever
guessed from an unrelated number on the page.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from app.params.specs import ParamSpec
from app.pdf.extract import ExtractedPage
from app.pdf.geometry import NormalizedBox

LOCATORS_PATH = Path(__file__).resolve().parents[2] / "specs" / "locators.yaml"

# Two lines whose vertical gap is smaller than this sit in the same table row
# (app.explication.parse._ROW_TOLERANCE uses the same order of magnitude for
# the same reason: a row's own cells share a y-box to within rounding).
_ROW_TOLERANCE = 0.01

# How far below a label line its value is still "the cell directly under it"
# rather than the next, unrelated row.
_BELOW_BAND = 0.025

# A value cell one column over from its label is allowed to drift this far
# out of the label's own x-range before it no longer counts as "the same
# column" for the next-line-down fallback.
_COLUMN_MARGIN = 0.03


@dataclass(frozen=True)
class StageDocument:
    """One winning file of one stage (PD/RD/ID), its text already rebuilt
    into pages the way app.pipeline._pages_from_lines does for every other
    consumer of stored text_blocks rows."""
    file_id: str
    file_name: str
    doc_stage: str
    discipline: str | None
    document_code: str | None
    pages: dict[int, ExtractedPage]


@dataclass(frozen=True)
class EvidenceRef:
    """Just enough to let app.pipeline build a real evidence_fragments row
    later, the same split RoomFinding uses: this module never sees a FileRow,
    only file_id, so the file's own hash/stage/document_code/revision are
    looked up by the caller instead of being duplicated here."""
    file_id: str
    page_no: int
    box: NormalizedBox
    extracted_value: str | None
    role: str  # "expected" | "actual"


@dataclass(frozen=True)
class ValueCandidate:
    raw_text: str            # the value cell as printed, e.g. "1 580,0 м²"
    value: float | str       # parsed number, or the normalized enum/string text
    unit_text: str | None    # the unit token found next to the value, if any
    file_id: str
    file_name: str
    page_no: int
    label_box: NormalizedBox
    value_box: NormalizedBox
    confidence: float        # 0..1 - see _confidence
    method: str              # "same_line" | "same_row" | "next_line"

    @property
    def combined_box(self) -> NormalizedBox:
        return NormalizedBox(
            x0=min(self.label_box.x0, self.value_box.x0),
            y0=min(self.label_box.y0, self.value_box.y0),
            x1=max(self.label_box.x1, self.value_box.x1),
            y1=max(self.label_box.y1, self.value_box.y1),
        )


@dataclass(frozen=True)
class LocatorEntry:
    synonyms: tuple[str, ...] = ()


@dataclass(frozen=True)
class Locators:
    by_code: dict[str, LocatorEntry] = field(default_factory=dict)

    def get(self, code: str) -> LocatorEntry | None:
        return self.by_code.get(code)


@dataclass(frozen=True)
class ParamContext:
    """Everything app.params.scalar needs to evaluate one process's own
    scalar_text/doc_presence parameters - the winning PD/RD/ID files
    (app.pipeline._select_stage_files), already turned into pages, plus the
    curated synonym table. Built once per run (app.pipeline._param_context)
    and reused across all ~110 parameters routed through it.
    """
    pd_docs: list[StageDocument]
    rd_docs: list[StageDocument]
    id_docs: list[StageDocument]
    locators: Locators


def load_locators(path: Path = LOCATORS_PATH) -> Locators:
    if not path.exists():
        return Locators({})
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    by_code = {}
    for code, entry in raw.items():
        synonyms = tuple(entry.get("synonyms") or []) if isinstance(entry, dict) else ()
        by_code[code] = LocatorEntry(synonyms=synonyms)
    return Locators(by_code)


# --- Normalization -----------------------------------------------------------

_YO_MAP = str.maketrans({"ё": "е", "Ё": "Е"})
_PUNCT_RE = re.compile(r"[«»\"'.,:;()\[\]–—\-]+")
_SPACE_RE = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    text = text.translate(_YO_MAP).lower()
    text = _PUNCT_RE.sub(" ", text)
    text = _SPACE_RE.sub(" ", text).strip()
    return text


# --- Label variants ------------------------------------------------------

# Only a genuine alternative-name slash ("Полезная / Расчетная площадь") has
# spaces on both sides; a compound code's own slash ("В1/Т3", "колоннах/
# пилонах") never does, so requiring the spaces is what keeps this from
# splitting those into nonsense.
_SLASH_ALT_RE = re.compile(r"(\S+)\s+/\s+(\S+)")

# A parenthesised abbreviation ("Коэффициент застройки (КЗ)") is only ever a
# short all-caps acronym; a parenthesised qualifier ("(надземная)",
# "(в том числе...)") is not a usable standalone label on its own.
_ACRONYM_RE = re.compile(r"\(([A-ZА-ЯЁ]{1,6})\)")


def _slash_variants(name: str) -> list[str]:
    match = _SLASH_ALT_RE.search(name)
    if not match:
        return [name]
    return [name[:match.start()] + alt + name[match.end():] for alt in match.groups()]


def _acronym_variants(name: str) -> list[str]:
    variants = [name]
    for match in _ACRONYM_RE.finditer(name):
        variants.append(match.group(1))
        variants.append((name[:match.start()] + name[match.end():]).strip())
    return variants


def label_variants(spec: ParamSpec, locator: LocatorEntry | None) -> list[str]:
    """Every normalized phrase that counts as this parameter's own label."""
    names: list[str] = []
    for base in _slash_variants(spec.parameter_name):
        names.extend(_acronym_variants(base))
    if locator:
        names.extend(locator.synonyms)

    normalized = []
    seen = set()
    for name in names:
        norm = normalize_text(name)
        if norm and norm not in seen:
            seen.add(norm)
            normalized.append(norm)
    return normalized


def _label_pattern(normalized_variant: str) -> re.Pattern:
    words = [w for w in normalized_variant.split(" ") if w]
    parts = [re.escape(w).replace("е", "[её]") for w in words]
    # \b on both ends: a short label (an acronym like "EI", "КЗ") must be its
    # own word, never a substring inside an unrelated one - without this, a
    # 2-letter acronym could match almost anywhere, exactly the guess ТЗ's
    # FPR <= 0.10 rules out.
    return re.compile(r"\b" + r"[\s,;:()]*".join(parts) + r"\b", re.IGNORECASE)


# --- Discipline hints ------------------------------------------------------

_HINT_RE = re.compile(r"[（(]([A-ZА-ЯЁ0-9/]{2,8})[）)]|Раздел\s+([А-ЯЁ]{2,8})")


def _discipline_hints(source_text: str | None) -> set[str]:
    if not source_text:
        return set()
    hints: set[str] = set()
    for match in _HINT_RE.finditer(source_text):
        token = match.group(1) or match.group(2)
        hints.update(token.split("/"))
    return hints


# --- Value extraction --------------------------------------------------------

# A negative lookbehind for a letter directly in front of the digit keeps a
# unit token glued to a number without a separator ("м2", "м3") from being
# read as the value itself - "Площадь застройки, м2: 1520,4" must find
# 1520,4, not the "2" inside its own unit.
_NOT_AFTER_LETTER = r"(?<![^\W\d_])"
_NUMBER_TOKEN_RE = re.compile(
    _NOT_AFTER_LETTER + r"\d{1,3}(?:[  ]\d{3})+(?:,\d+)?|" + _NOT_AFTER_LETTER + r"\d+(?:,\d+)?"
)

# Longest first, so "кв.м" is tried before a bare "м" would otherwise win.
_UNIT_TOKENS = sorted(
    ["м²", "кв.м", "м2", "м³", "куб.м", "м3", "%", "доли", "ед.", "ед",
     "шт.", "шт", "чел.", "чел", "мм", "м"],
    key=len, reverse=True,
)

_UNIT_FAMILY = {
    "м²": "area", "кв.м": "area", "м2": "area",
    "м³": "volume", "куб.м": "volume", "м3": "volume",
    "%": "percent", "доли": "fraction",
}


def _parse_number(token: str) -> float | None:
    cleaned = token.replace(" ", " ")
    cleaned = re.sub(r"(?<=\d)\s+(?=\d{3}(?:\D|$))", "", cleaned)
    cleaned = cleaned.replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _match_unit(text: str) -> str | None:
    stripped = text.lstrip()
    for token in _UNIT_TOKENS:
        if stripped.lower().startswith(token.lower()):
            return token
    return None


def _unit_compatible(spec_unit: str | None, found_unit: str | None) -> tuple[bool, float]:
    """(compatible, factor) - factor multiplies the parsed value to bring it
    into spec_unit's own scale. Only м²/кв.м/м2, м³/куб.м/м3 and %/доли are
    ever converted (design's own list); anything else - a unit spec.py never
    modelled (Статус, Марка, compound units like "шт. / м") or a unit the
    value cell simply did not state - is accepted unchecked rather than
    guessed at.
    """
    if not found_unit:
        return True, 1.0
    spec_family = _UNIT_FAMILY.get((spec_unit or "").strip())
    found_family = _UNIT_FAMILY.get(found_unit)
    if spec_family is None or found_family is None:
        return True, 1.0
    if spec_family == found_family:
        return True, 1.0
    if {spec_family, found_family} == {"percent", "fraction"}:
        return True, (100.0 if spec_family == "percent" else 0.01)
    return False, 1.0


def _extract_value(text: str, spec: ParamSpec) -> tuple[str, float | str, str | None] | None:
    text = text.strip(" \t:;,.—-")
    if not text:
        return None

    if spec.data_type == "number":
        match = _NUMBER_TOKEN_RE.search(text)
        if not match:
            return None
        number = _parse_number(match.group())
        if number is None:
            return None
        unit = _match_unit(text[match.end():])
        compatible, factor = _unit_compatible(spec.unit, unit)
        if not compatible:
            return None
        raw = match.group() + (f" {unit}" if unit else "")
        return raw, number * factor, unit

    # enum / string / coordinate: the normalized text of the value cell,
    # taken whole (an enum code is always short - "II", "B", "Ф1.3" - so
    # nothing is lost by not splitting it further).
    return text, text, None


# --- Locating a label on one page --------------------------------------------

def _line_extras(remainder: str) -> int:
    """A rough count of "extra" words the value cell carries beyond the
    value itself - used only to keep the confidence penalty proportionate,
    never to reject a match outright."""
    return len(re.findall(r"[^\W\d_]+", remainder, flags=re.UNICODE))


def _confidence(method: str, unit_stated: bool, extras: int, discipline_bonus: bool) -> float:
    base = {"same_line": 1.0, "same_row": 0.85, "next_line": 0.7}[method]
    if extras > 2:
        base -= 0.1
    if not unit_stated:
        base -= 0.1
    if discipline_bonus:
        base += 0.05
    return max(0.3, min(1.0, base))


def _find_value_same_row(page: ExtractedPage, label_box: NormalizedBox, spec: ParamSpec):
    best = None
    for block in page.blocks:
        for line in block.lines:
            if line.box.x0 <= label_box.x1 - 0.002:
                continue  # not to the right of the label
            if not (label_box.y0 - _ROW_TOLERANCE <= line.box.y0 <= label_box.y1 + _ROW_TOLERANCE):
                continue
            extracted = _extract_value(line.text, spec)
            if extracted is None:
                continue
            if best is None or line.box.x0 < best[0].box.x0:
                best = (line, extracted)
    return best


def _find_value_next_line(page: ExtractedPage, label_box: NormalizedBox, spec: ParamSpec):
    best = None
    for block in page.blocks:
        for line in block.lines:
            if not (label_box.y1 < line.box.y0 <= label_box.y1 + _BELOW_BAND):
                continue
            if line.box.x1 < label_box.x0 - _COLUMN_MARGIN or line.box.x0 > label_box.x1 + _COLUMN_MARGIN:
                continue
            extracted = _extract_value(line.text, spec)
            if extracted is None:
                continue
            if best is None or line.box.y0 < best[0].box.y0:
                best = (line, extracted)
    return best


def locate_value(spec: ParamSpec, documents: list[StageDocument], source_hint: str | None,
                  locator: LocatorEntry | None) -> list[ValueCandidate]:
    """Every candidate found for `spec` across `documents` (one stage's
    winning files). More than one candidate is normal - the same label can
    repeat across pages/files - the caller decides whether they agree.
    """
    variants = label_variants(spec, locator)
    if not variants:
        return []
    patterns = [_label_pattern(v) for v in variants]
    hints = _discipline_hints(source_hint)

    candidates: list[ValueCandidate] = []
    seen_lines: set[tuple[str, int, int, int]] = set()

    for doc in documents:
        discipline_bonus = bool(doc.discipline and doc.discipline.upper() in hints)
        for page_no, page in doc.pages.items():
            for block in page.blocks:
                for line in block.lines:
                    key = (doc.file_id, page_no, block.block_no, line.line_no)
                    if key in seen_lines:
                        continue
                    match = next((p.search(line.text) for p in patterns if p.search(line.text)), None)
                    if match is None:
                        continue

                    remainder = line.text[match.end():]
                    extracted = _extract_value(remainder, spec)
                    if extracted is not None:
                        raw, value, unit = extracted
                        seen_lines.add(key)
                        candidates.append(ValueCandidate(
                            raw_text=raw, value=value, unit_text=unit,
                            file_id=doc.file_id, file_name=doc.file_name, page_no=page_no,
                            label_box=line.box, value_box=line.box,
                            confidence=_confidence("same_line", unit is not None,
                                                    _line_extras(remainder), discipline_bonus),
                            method="same_line",
                        ))
                        continue

                    row_hit = _find_value_same_row(page, line.box, spec)
                    if row_hit is not None:
                        value_line, (raw, value, unit) = row_hit
                        seen_lines.add(key)
                        candidates.append(ValueCandidate(
                            raw_text=raw, value=value, unit_text=unit,
                            file_id=doc.file_id, file_name=doc.file_name, page_no=page_no,
                            label_box=line.box, value_box=value_line.box,
                            confidence=_confidence("same_row", unit is not None, 0, discipline_bonus),
                            method="same_row",
                        ))
                        continue

                    below_hit = _find_value_next_line(page, line.box, spec)
                    if below_hit is not None:
                        value_line, (raw, value, unit) = below_hit
                        seen_lines.add(key)
                        candidates.append(ValueCandidate(
                            raw_text=raw, value=value, unit_text=unit,
                            file_id=doc.file_id, file_name=doc.file_name, page_no=page_no,
                            label_box=line.box, value_box=value_line.box,
                            confidence=_confidence("next_line", unit is not None, 0, discipline_bonus),
                            method="next_line",
                        ))

    return candidates
