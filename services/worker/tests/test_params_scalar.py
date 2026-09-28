"""app.params.scalar: PD-vs-RD (and RD-vs-ID) comparison once a value has
been located on each side, plus the value_lt/value_gt normative-limit path
and doc_presence.

Built the same way test_params_locate.py builds its pages: hand-made
ExtractedPage objects wrapped in a StageDocument/ParamContext, standing in
for one process's own winning PD/RD/ID files.
"""

import pytest

from app.params.locate import LocatorEntry, Locators, ParamContext, StageDocument
from app.params.scalar import evaluate_doc_presence_param, evaluate_scalar_param
from app.params.specs import ParamSpec
from app.pdf.extract import ExtractedBlock, ExtractedLine, ExtractedPage
from app.pdf.geometry import NormalizedBox


def _spec(**overrides) -> ParamSpec:
    base = dict(
        code="M-TEST", section="ПЗ", parameter_name="Площадь застройки", unit="м²",
        data_type="number", modality="scalar_text", review_priority="HIGH",
        source_pd="Раздел ПЗУ: Таблица ТЭП", source_rd="Раздел ГП: Таблица ТЭП", source_id=None,
        trigger_logic="Расхождение > 0.", compare_op=None, compare_threshold=None,
        min_value=None, max_value=None, sp_reference=None, gost_reference=None,
        fz_reference=None, other_normative=None, regex_pattern=None, implemented=True,
    )
    base.update(overrides)
    return ParamSpec(**base)


def _line(text, x0=0.1, y0=0.1, x1=0.6, y1=0.12) -> ExtractedLine:
    return ExtractedLine(line_no=0, text=text, box=NormalizedBox(x0, y0, x1, y1))


def _page(line) -> ExtractedPage:
    block = ExtractedBlock(block_no=0, text=line.text, box=line.box, lines=[line])
    return ExtractedPage(page_no=1, width_pt=0.0, height_pt=0.0, rotation=0,
                          char_count=0, needs_ocr=False, blocks=[block])


def _doc(file_id, text, *, file_name="doc.pdf", doc_stage="PD") -> StageDocument:
    return StageDocument(file_id=file_id, file_name=file_name, doc_stage=doc_stage,
                          discipline=None, document_code=None, pages={1: _page(_line(text))})


def _context(pd_text=None, rd_text=None, id_text=None, label="Площадь застройки") -> ParamContext:
    pd_docs = [_doc("pd1", f"{label}: {pd_text}")] if pd_text else []
    rd_docs = [_doc("rd1", f"{label}: {rd_text}", doc_stage="RD")] if rd_text else []
    id_docs = [_doc("id1", f"{label}: {id_text}", doc_stage="ID")] if id_text else []
    return ParamContext(pd_docs=pd_docs, rd_docs=rd_docs, id_docs=id_docs, locators=Locators({}))


# --- equality up to rounding (compare_op None) -------------------------------

def test_equal_values_are_negative_verified():
    spec = _spec()
    context = _context(pd_text="1520,4 м²", rd_text="1520,4 м²")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "NEGATIVE_VERIFIED"
    assert outcome.expected_value == "1520.40" or outcome.expected_value == "1520.4"


def test_a_real_change_is_a_candidate():
    spec = _spec()
    context = _context(pd_text="1520,4 м²", rd_text="1580,0 м²")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "CANDIDATE"
    assert outcome.expected_value == "1520.4"
    assert outcome.actual_value == "1580"
    assert len(outcome.fragments) == 2


def test_one_rounding_step_is_not_a_candidate():
    spec = _spec()
    context = _context(pd_text="4521,3 м²", rd_text="4521,4 м²")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "NEGATIVE_VERIFIED"


# --- delta_gt / relative_delta_gt --------------------------------------------

def test_delta_gt_flags_only_past_the_threshold():
    spec = _spec(compare_op="delta_gt", compare_threshold=0.0)
    context = _context(pd_text="10,0 м²", rd_text="10,1 м²")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "CANDIDATE"


def test_relative_delta_gt_under_threshold_is_negative_verified():
    spec = _spec(compare_op="relative_delta_gt", compare_threshold=0.05)
    context = _context(pd_text="1000,0 м²", rd_text="1030,0 м²")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "NEGATIVE_VERIFIED"


def test_relative_delta_gt_over_threshold_is_a_candidate():
    spec = _spec(compare_op="relative_delta_gt", compare_threshold=0.05)
    context = _context(pd_text="1000,0 м²", rd_text="1200,0 м²")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "CANDIDATE"


# --- enum equality ------------------------------------------------------

def test_enum_mismatch_is_a_candidate():
    spec = _spec(parameter_name="Степень огнестойкости", data_type="enum", unit="Степень",
                 source_pd="Раздел ПЗ", source_rd="Раздел АР")
    context = _context(pd_text="II", rd_text="III", label="Степень огнестойкости")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "CANDIDATE"
    assert outcome.expected_value == "II" and outcome.actual_value == "III"


def test_enum_match_is_negative_verified():
    spec = _spec(parameter_name="Степень огнестойкости", data_type="enum", unit="Степень")
    context = _context(pd_text="II", rd_text="II", label="Степень огнестойкости")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "NEGATIVE_VERIFIED"


# --- absence / conflict --------------------------------------------------

def test_missing_on_one_side_is_missing_evidence():
    spec = _spec()
    context = _context(pd_text="1520,4 м²", rd_text=None)

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "MISSING_EVIDENCE"
    assert "РД" in outcome.reason


def test_absent_everywhere_is_not_comparable():
    spec = _spec()
    context = _context(pd_text=None, rd_text=None)

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "NOT_COMPARABLE"


def test_two_different_values_on_one_stage_is_clarification_required():
    label = "Площадь застройки"
    page1 = _page(_line(f"{label}: 1520,4 м²"))
    page2 = ExtractedPage(page_no=2, width_pt=0.0, height_pt=0.0, rotation=0, char_count=0,
                           needs_ocr=False,
                           blocks=[ExtractedBlock(block_no=0, text="x",
                                                   box=NormalizedBox(0.1, 0.1, 0.6, 0.12),
                                                   lines=[_line(f"{label}: 1600,0 м²")])])
    pd_doc = StageDocument(file_id="pd1", file_name="pd.pdf", doc_stage="PD",
                            discipline=None, document_code=None, pages={1: page1, 2: page2})
    rd_doc = _doc("rd1", f"{label}: 1520,4 м²", doc_stage="RD")
    spec = _spec()
    context = ParamContext(pd_docs=[pd_doc], rd_docs=[rd_doc], id_docs=[], locators=Locators({}))

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "CLARIFICATION_REQUIRED"


# --- RD<->ID fallback ------------------------------------------------------

def test_rd_id_pair_is_used_when_pd_is_absent():
    spec = _spec(source_id="Исполнительная схема")
    context = _context(pd_text=None, rd_text="1,1 м", id_text="1,1 м")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "NEGATIVE_VERIFIED"


# --- value_lt / value_gt normative limit -------------------------------

def test_value_lt_violation_on_rd_is_a_candidate():
    spec = _spec(parameter_name="Ширина эвакуационного выхода", unit="м",
                 compare_op="value_lt", compare_threshold=1.2, min_value=1.2,
                 source_pd="Раздел ПЗ", source_rd="Раздел АР")
    context = _context(rd_text="1,1 м", label="Ширина эвакуационного выхода")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "CANDIDATE"
    assert outcome.actual_value == "1.1"


def test_value_lt_within_norm_is_negative_verified():
    spec = _spec(parameter_name="Ширина эвакуационного выхода", unit="м",
                 compare_op="value_lt", compare_threshold=1.2, min_value=1.2)
    context = _context(rd_text="1,3 м", label="Ширина эвакуационного выхода")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "NEGATIVE_VERIFIED"


def test_value_lt_falls_back_to_pd_when_rd_absent():
    spec = _spec(parameter_name="Ширина эвакуационного выхода", unit="м",
                 compare_op="value_lt", compare_threshold=1.2, min_value=1.2)
    context = _context(pd_text="1,0 м", rd_text=None, label="Ширина эвакуационного выхода")

    outcome = evaluate_scalar_param(spec, context)

    assert outcome.status == "CANDIDATE"


# --- doc_presence --------------------------------------------------------

def test_doc_presence_found_is_negative_verified():
    spec = _spec(parameter_name="Наличие документа", data_type="enum", modality="doc_presence",
                 source_pd="Технологический регламент", source_rd=None, source_id=None)
    context = ParamContext(
        pd_docs=[StageDocument(file_id="p1", file_name="Технологический регламент.pdf",
                                doc_stage="PD", discipline=None, document_code=None, pages={})],
        rd_docs=[], id_docs=[], locators=Locators({}),
    )

    outcome = evaluate_doc_presence_param(spec, context)

    assert outcome.status == "NEGATIVE_VERIFIED"


def test_doc_presence_absent_is_missing_evidence():
    spec = _spec(parameter_name="Наличие документа", data_type="enum", modality="doc_presence",
                 source_pd="Электронный паспорт в АИС ОСИГ", source_rd=None, source_id=None)
    context = ParamContext(pd_docs=[], rd_docs=[], id_docs=[], locators=Locators({}))

    outcome = evaluate_doc_presence_param(spec, context)

    assert outcome.status == "MISSING_EVIDENCE"
