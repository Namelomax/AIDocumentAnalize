from datetime import date
import pytest
from app.domain.revisions import FileMeta, select_source_revision


def mk(file_id, approval_status="APPROVED", approval_date=date(2026, 1, 1),
       predecessor_id=None, readable=True, stage="PD", discipline="АР"):
    return FileMeta(
        file_id=file_id, doc_stage=stage, discipline=discipline,
        document_code="AR-01", revision="1", approval_status=approval_status,
        approval_date=approval_date, predecessor_id=predecessor_id, readable=readable,
    )


def test_single_approved_revision_is_selected():
    result = select_source_revision([mk("f1")], "PD", "АР")
    assert result.status == "COMPLETE"
    assert result.file_id == "f1"


def test_superseded_revision_is_excluded():
    # f2 явно заменяет f1
    files = [mk("f1"), mk("f2", predecessor_id="f1")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "COMPLETE"
    assert result.file_id == "f2"


def test_cancelled_revision_is_excluded():
    files = [mk("f1", approval_status="CANCELLED")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "MISSING_EVIDENCE"


def test_ambiguous_revisions_require_clarification():
    # две утверждённые редакции одной датой, связи predecessor нет
    files = [mk("f1"), mk("f2")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "CLARIFICATION_REQUIRED"
    assert result.file_id is None


def test_missing_document_is_missing_evidence():
    result = select_source_revision([], "PD", "АР")
    assert result.status == "MISSING_EVIDENCE"


def test_unreadable_file_is_not_comparable():
    files = [mk("f1", readable=False)]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "NOT_COMPARABLE"


def test_only_draft_requires_clarification():
    files = [mk("f1", approval_status="DRAFT")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "CLARIFICATION_REQUIRED"


def test_for_construction_counts_as_approved():
    files = [mk("f1", approval_status="FOR_CONSTRUCTION", stage="RD")]
    result = select_source_revision(files, "RD", "АР")
    assert result.status == "COMPLETE"
    assert result.file_id == "f1"


def test_file_of_another_stage_is_not_used():
    files = [mk("f1", stage="RD")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "MISSING_EVIDENCE"


def test_later_approval_date_wins_when_chain_is_explicit():
    files = [
        mk("f1", approval_date=date(2026, 1, 1)),
        mk("f2", approval_date=date(2026, 5, 1), predecessor_id="f1"),
    ]
    result = select_source_revision(files, "PD", "АР")
    assert result.file_id == "f2"
