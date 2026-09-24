"""Selecting the authoritative revision of a document for comparison.

Rules come from "Перечень исполнительной документации", section
"ПРАВИЛА ВЫБОРА ИСТОЧНИКА ДЛЯ СРАВНЕНИЯ". An outdated revision must never be
used as the reference, and any ambiguity blocks the violation verdict rather
than guessing.
"""

from dataclasses import dataclass
from datetime import date

APPROVED_STATUSES = {"APPROVED", "FOR_CONSTRUCTION"}
EXCLUDED_STATUSES = {"CANCELLED", "SUPERSEDED"}


@dataclass(frozen=True)
class FileMeta:
    file_id: str
    doc_stage: str
    discipline: str | None
    document_code: str | None
    revision: str | None
    approval_status: str
    approval_date: date | None
    predecessor_id: str | None
    readable: bool = True


@dataclass(frozen=True)
class SourceSelection:
    file_id: str | None
    status: str
    reason: str


def select_source_revision(
    files: list[FileMeta], stage: str, discipline: str | None
) -> SourceSelection:
    applicable = [
        f for f in files
        if f.doc_stage == stage and (discipline is None or f.discipline == discipline)
    ]

    if not applicable:
        return SourceSelection(None, "MISSING_EVIDENCE",
                               "no file for the requested stage and discipline")

    applicable = [f for f in applicable if f.approval_status not in EXCLUDED_STATUSES]

    if not applicable:
        return SourceSelection(None, "MISSING_EVIDENCE",
                               "all revisions are cancelled or superseded")

    # A file that some other file names as its predecessor has been replaced.
    # The chain is built over every applicable file, readable or not. Dropping
    # unreadable files first would erase the evidence that a newer revision
    # exists and let the superseded one pass as the reference — the exact
    # failure this function exists to prevent.
    superseded_ids = {f.predecessor_id for f in applicable if f.predecessor_id}
    current = [f for f in applicable if f.file_id not in superseded_ids]

    # An unreadable draft can never be the reference, so it does not block
    # anything. An unreadable approved revision does: it may well be the
    # authoritative one, and we cannot tell.
    if any(not f.readable and f.approval_status in APPROVED_STATUSES for f in current):
        return SourceSelection(None, "NOT_COMPARABLE",
                               "the current approved revision cannot be read")

    approved = [f for f in current if f.approval_status in APPROVED_STATUSES]

    if not approved:
        return SourceSelection(None, "CLARIFICATION_REQUIRED",
                               "no approved revision among the current ones")

    if len(approved) == 1:
        return SourceSelection(approved[0].file_id, "COMPLETE", "single approved revision")

    dated = [f for f in approved if f.approval_date is not None]
    if len(dated) == len(approved):
        latest = max(f.approval_date for f in dated)
        newest = [f for f in dated if f.approval_date == latest]
        if len(newest) == 1:
            return SourceSelection(newest[0].file_id, "COMPLETE",
                                   "latest approved revision by approval date")

    return SourceSelection(None, "CLARIFICATION_REQUIRED",
                           "several approved revisions without an unambiguous order")
