"""app.params.locate: finding one parameter's own value on a page.

Built off hand-made ExtractedPage objects (the same style
test_explication_compare.py uses for Room/SheetRooms) rather than a real
PDF - the three value-extraction paths (same line, same table row, the line
directly below) are each a specific, narrow layout, cheaper and more
reliable to construct directly than to render.
"""

from dataclasses import replace

import pytest

from app.params.locate import (
    StageDocument, label_variants, locate_value, normalize_text,
)
from app.params.specs import ParamSpec
from app.pdf.extract import ExtractedBlock, ExtractedLine, ExtractedPage
from app.pdf.geometry import NormalizedBox


def _spec(**overrides) -> ParamSpec:
    base = dict(
        code="M-TEST", section="ПЗ", parameter_name="Площадь застройки", unit="м²",
        data_type="number", modality="scalar_text", review_priority="HIGH",
        source_pd="Раздел ПЗУ: Таблица ТЭП", source_rd="Раздел ГП: Таблица ТЭП", source_id=None,
        trigger_logic="", compare_op=None, compare_threshold=None, min_value=None, max_value=None,
        sp_reference=None, gost_reference=None, fz_reference=None, other_normative=None,
        regex_pattern=None, implemented=True,
    )
    base.update(overrides)
    return ParamSpec(**base)


def _box(x0, y0, x1, y1) -> NormalizedBox:
    return NormalizedBox(x0, y0, x1, y1)


def _line(line_no, text, x0, y0, x1, y1) -> ExtractedLine:
    return ExtractedLine(line_no=line_no, text=text, box=_box(x0, y0, x1, y1))


def _block(block_no, line) -> ExtractedBlock:
    return ExtractedBlock(block_no=block_no, text=line.text, box=line.box, lines=[line])


def _page(page_no, lines) -> ExtractedPage:
    blocks = [_block(i, line) for i, line in enumerate(lines)]
    return ExtractedPage(page_no=page_no, width_pt=0.0, height_pt=0.0, rotation=0,
                          char_count=0, needs_ocr=False, blocks=blocks)


def _doc(file_id, pages, *, file_name="pd.pdf", doc_stage="PD",
          discipline=None, document_code=None) -> StageDocument:
    return StageDocument(file_id=file_id, file_name=file_name, doc_stage=doc_stage,
                          discipline=discipline, document_code=document_code, pages=pages)


# --- normalize_text / label_variants -----------------------------------------

def test_normalize_text_folds_yo_and_punctuation():
    assert normalize_text("Общий  объём,  ЗДАНИЯ.") == "общий объем здания"


def test_label_variants_split_slash_alternatives():
    spec = _spec(parameter_name="Полезная / Расчетная площадь")
    variants = label_variants(spec, None)
    assert "полезная площадь" in variants
    assert "расчетная площадь" in variants


def test_label_variants_add_parenthesised_acronym():
    spec = _spec(parameter_name="Коэффициент застройки (КЗ)")
    variants = label_variants(spec, None)
    assert "кз" in variants
    assert "коэффициент застройки" in variants


def test_label_variants_do_not_split_a_compound_code_slash():
    spec = _spec(parameter_name="Диаметры стояков и разводящих трубопроводов В1/Т3")
    variants = label_variants(spec, None)
    # No spaces around this slash - it must not be treated as an alternative
    # name split (the module docstring's own "В1/Т3" example).
    assert not any("в1" == v or "т3" == v for v in variants)


# --- value extraction: same line / same row / next line ---------------------

def test_value_found_on_the_same_line():
    page = _page(1, [_line(0, "Площадь застройки, м2: 1520,4", 0.1, 0.1, 0.5, 0.12)])
    doc = _doc("f1", {1: page})
    spec = _spec()

    candidates = locate_value(spec, [doc], spec.source_pd, None)

    assert len(candidates) == 1
    assert candidates[0].value == pytest.approx(1520.4)
    assert candidates[0].method == "same_line"


def test_value_found_in_the_same_table_row():
    label = _line(0, "Площадь застройки", 0.1, 0.30, 0.30, 0.32)
    value = _line(1, "1580,0 м²", 0.55, 0.301, 0.65, 0.319)
    page = _page(1, [label, value])
    doc = _doc("f1", {1: page})
    spec = _spec()

    candidates = locate_value(spec, [doc], spec.source_pd, None)

    assert len(candidates) == 1
    assert candidates[0].value == pytest.approx(1580.0)
    assert candidates[0].method == "same_row"


def test_value_found_on_the_line_directly_below():
    label = _line(0, "Площадь застройки", 0.1, 0.40, 0.30, 0.42)
    value = _line(1, "1520,4 м²", 0.1, 0.425, 0.30, 0.445)
    page = _page(1, [label, value])
    doc = _doc("f1", {1: page})
    spec = _spec()

    candidates = locate_value(spec, [doc], spec.source_pd, None)

    assert len(candidates) == 1
    assert candidates[0].value == pytest.approx(1520.4)
    assert candidates[0].method == "next_line"


def test_thousands_spaces_are_parsed():
    page = _page(1, [_line(0, "Площадь застройки: 1 520,4 м²", 0.1, 0.1, 0.6, 0.12)])
    doc = _doc("f1", {1: page})
    spec = _spec()

    candidates = locate_value(spec, [doc], spec.source_pd, None)

    assert candidates[0].value == pytest.approx(1520.4)


def test_curated_synonym_is_matched():
    from app.params.locate import LocatorEntry

    page = _page(1, [_line(0, "Площадь застройки участка: 1520,4 м²", 0.1, 0.1, 0.6, 0.12)])
    doc = _doc("f1", {1: page})
    spec = _spec(parameter_name="Совсем другое имя")

    candidates = locate_value(spec, [doc], spec.source_pd, LocatorEntry(synonyms=("площадь застройки",)))

    assert candidates and candidates[0].value == pytest.approx(1520.4)


def test_different_param_with_a_shared_word_does_not_match():
    """"Площадь участка" must never satisfy "Площадь застройки"."""
    page = _page(1, [_line(0, "Площадь участка: 1520,4 м²", 0.1, 0.1, 0.6, 0.12)])
    doc = _doc("f1", {1: page})
    spec = _spec(parameter_name="Площадь застройки")

    candidates = locate_value(spec, [doc], spec.source_pd, None)

    assert candidates == []


def test_incompatible_unit_is_rejected():
    page = _page(1, [_line(0, "Площадь застройки: 12 %", 0.1, 0.1, 0.5, 0.12)])
    doc = _doc("f1", {1: page})
    spec = _spec(unit="м²")

    candidates = locate_value(spec, [doc], spec.source_pd, None)

    assert candidates == []


def test_enum_value_is_read_as_normalized_text():
    page = _page(1, [_line(0, "Степень огнестойкости: II", 0.1, 0.1, 0.5, 0.12)])
    doc = _doc("f1", {1: page})
    spec = _spec(parameter_name="Степень огнестойкости", data_type="enum", unit="Степень")

    candidates = locate_value(spec, [doc], spec.source_pd, None)

    assert candidates[0].value == "II"


def test_no_match_when_label_is_entirely_absent():
    page = _page(1, [_line(0, "Некоторый другой текст листа", 0.1, 0.1, 0.5, 0.12)])
    doc = _doc("f1", {1: page})
    spec = _spec()

    assert locate_value(spec, [doc], spec.source_pd, None) == []
