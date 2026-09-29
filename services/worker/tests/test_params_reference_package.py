"""app.params.scalar run against the real reference package's own sheets.

tests/e2e/make_reference_package.py cuts the same four sheets (school PD/RD -
the pilot's positive reference, and Полярная 17 PD/RD - the pilot's verified
negative pair) into a real upload; this test reads them the same way, off
the checked-in markup PDF directly, to answer one question for every
scalar_text/doc_presence parameter at once: a room-explication sheet carries
no ТЭП table, so nothing must ever be reported as a CANDIDATE off it - the
same "no spurious findings on Полярная 17" guarantee
tests/e2e/test_upload_flow.sh's own step 16 already gives M-003, extended
here to the ~94 other parameters app.params.scalar now answers.
"""

from pathlib import Path

import pytest

from app.params.engine import build_evaluators, evaluate_all
from app.params.locate import ParamContext, StageDocument, load_locators
from app.params.specs import load_specs
from app.pdf.extract import extract_pages

REFERENCE_PDF = Path(__file__).resolve().parents[3] / ".e2e-tmp" / "Задание" / "Комплект_предметной_разметки.pdf"

pytestmark = pytest.mark.skipif(not REFERENCE_PDF.exists(), reason="reference package is not in the checkout")

# The same four sheets tests/e2e/make_reference_package.py cuts into a real
# upload (its own SHEETS list) - two PD/RD pairs, school and Полярная 17.
_SHEETS = [
    ("sosh-pd.pdf", 19, "PD"),
    ("sosh-rd.pdf", 20, "RD"),
    ("pol17-pd.pdf", 21, "PD"),
    ("pol17-rd.pdf", 22, "RD"),
]


@pytest.fixture(scope="module")
def pages():
    return extract_pages(REFERENCE_PDF.read_bytes())


def _context(pages) -> ParamContext:
    pd_docs, rd_docs = [], []
    for name, source_page_no, stage in _SHEETS:
        page = pages[source_page_no - 1]
        doc = StageDocument(file_id=name, file_name=name, doc_stage=stage,
                             discipline="АР", document_code=name.upper(), pages={page.page_no: page})
        (pd_docs if stage == "PD" else rd_docs).append(doc)
    return ParamContext(pd_docs=pd_docs, rd_docs=rd_docs, id_docs=[], locators=load_locators())


def test_no_spurious_candidates_on_the_real_reference_sheets(pages):
    context = _context(pages)
    specs = load_specs()
    evaluators = build_evaluators(specs, context)

    outcomes = evaluate_all(specs, evaluators)

    candidates = [o for o in outcomes if o.status == "CANDIDATE"]
    assert candidates == [], [(c.code, c.reason) for c in candidates]


def test_m103_conflict_is_a_real_one_not_a_bug(pages):
    """The school sheet (19) genuinely marks several doors "EI-30", "EI-15",
    "EI-45"... - different doors, different fire-resistance limits, not one
    document-level ТЭП value. M-103's own label legitimately matches every
    one of them, so locate_value finds several different values on the PD
    side - exactly the "do not guess" case app.params.locate's own module
    docstring describes, correctly reported as CLARIFICATION_REQUIRED rather
    than either a guessed CANDIDATE or a silently dropped result.
    """
    context = _context(pages)
    specs = load_specs()
    evaluators = build_evaluators(specs, context)

    outcomes = evaluate_all(specs, evaluators)

    by_code = {o.code: o for o in outcomes}
    assert by_code["M-103"].status == "CLARIFICATION_REQUIRED"
