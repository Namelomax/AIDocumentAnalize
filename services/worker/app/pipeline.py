"""The process.start pipeline: parse the registry, enrich file rows, compute
completeness/scenario, select the current source per document, compare room
explications between design and working documentation, and record a check
row for every parameter of the matrix.

Everything this module learns about the input package is a data-quality
statement, never a processing error: a missing registry, an unreadable one,
or a dangling predecessor reference must not stop the run. Every code path
ends with the process moved to READY, because nothing else drives it out of
PARSING on a stand no one is watching.

db and storage are passed in rather than constructed here so the pipeline can
be driven by fakes in tests without a real PostgreSQL or MinIO.
"""

import asyncio
import hashlib
import logging
import time
from dataclasses import replace
from datetime import date, datetime

from app.domain.completeness import STAGES, compute_completeness, determine_scenario
from app.domain.manifest import parse_manifest
from app.domain.revisions import FileMeta, select_source_revision
from app.explication.compare import (
    DEFAULT_AREA_RELATIVE_THRESHOLD, RoomFinding, SheetRooms, compare_sheets, pair_sheets,
)
from app.explication.functions import NamePair, compare_room_functions, normalize_room_name
from app.explication.parse import Room, find_floor_totals, find_rooms, room_key
from app.llm.provider import LlmUnavailable, provider_from_config
from app.metrics import (
    file_attempts_total, files_processed_total, findings_total,
    process_duration_seconds, processes_total,
)
from app.params.engine import evaluate_all
from app.params.specs import ParamSpec, load_specs
from app.pdf.extract import ExtractedBlock, ExtractedLine, ExtractedPage, extract_pages
from app.pdf.geometry import NormalizedBox
from app.pdf.render import render_page_png

logger = logging.getLogger(__name__)

# Explication comparison only ever concerns the design/working pair; the
# executive documentation (ID) stage has no explication of its own to read
# (see "Что этот план сознательно не делает").
_COMPARABLE_STAGES = ("PD", "RD")

# Section 9.5's "semantic dissonance" rule. Free-search, not part of the
# GOLD matrix (plan 8, Task 4, rule 6): no params.yaml spec exists for it, so
# save_checks's own param_id subquery returns NULL for it by design, not by
# omission.
_SEM_ROOM_FN_CODE = "SEM-ROOM-FN"
_SEM_ROOM_FN_PRIORITY = "MEDIUM"


def _as_date(value: date | datetime | None) -> date | None:
    # Postgres TIMESTAMP columns come back as datetime; the domain layer
    # compares against plain dates.
    if isinstance(value, datetime):
        return value.date()
    return value


def _is_manifest_row(file_row, process) -> bool:
    return file_row.doc_stage is None and file_row.file_hash == process.input_manifest_hash


def _extract_and_render_sync(raw: bytes) -> list[tuple[ExtractedPage, bytes]]:
    """The CPU-bound half of one file's extraction: PyMuPDF text extraction
    and page rendering, both synchronous. Run through asyncio.to_thread so
    asyncio.wait_for's timeout (customer's ТЗ p.17: "Таймаут при обработке
    файла") can actually cut it off - a synchronous call awaited directly
    would block the event loop past any timeout instead.
    """
    pages = extract_pages(raw)
    return [(page, render_page_png(raw, page.page_no)) for page in pages]


async def _extract_one_file(record, db, storage, timeout_s: float) -> list[dict]:
    """One attempt at reading a single PDF's text layer and rendering its
    pages. Raises (TimeoutError on a timeout, whatever extract_pages/
    render_page_png raise otherwise) rather than catching anything itself -
    the retry loop in _extract_document_pages owns deciding when to give up.
    """
    raw = await storage.get_object(record.storage_key)
    pairs = await asyncio.wait_for(asyncio.to_thread(_extract_and_render_sync, raw), timeout=timeout_s)
    stored = []
    for page, png in pairs:
        image_key = f"pages/{record.id}/{page.page_no}.png"
        await storage.put_object(image_key, png, "image/png")
        stored.append({
            "page_no": page.page_no,
            "width_pt": page.width_pt,
            "height_pt": page.height_pt,
            "rotation": page.rotation,
            "char_count": page.char_count,
            "needs_ocr": page.needs_ocr,
            "image_key": image_key,
            "blocks": [
                {"block_no": b.block_no, "line_no": line.line_no, "text": line.text,
                 "x0": line.box.x0, "y0": line.box.y0,
                 "x1": line.box.x1, "y1": line.box.y1}
                for b in page.blocks
                for line in b.lines
            ],
        })
    await db.save_pages(record.id, stored)
    return stored


async def _extract_document_pages(process_id: str, files, db, storage, config) -> None:
    """Read the text layer of every PDF in the package.

    One unreadable file must not cost the package its other documents: a
    timeout or error here is retried up to config.processing_retries further
    times (customer's ТЗ p.17: "Повторная попытка обработки (до 2 раз)"), and
    only once every attempt has failed is it recorded against that file and
    an admin notified - the rest of the package continues either way.
    """
    attempts_allowed = 1 + max(config.processing_retries, 0)
    for record in files:
        if record.mime_type != "application/pdf":
            continue

        last_exc: BaseException | None = None
        for attempt in range(1, attempts_allowed + 1):
            file_attempts_total.inc()
            try:
                stored = await _extract_one_file(record, db, storage, config.file_processing_timeout_s)
                logger.info("pages extracted", extra={
                    "process_id": process_id,
                    "file_id": record.id,
                    "pages": len(stored),
                    "scans": sum(1 for p in stored if p["needs_ocr"]),
                    "attempt": attempt,
                })
                last_exc = None
                break
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - retried in-process, recorded once exhausted
                last_exc = exc
                logger.error("page extraction attempt failed", extra={
                    "process_id": process_id,
                    "file_id": record.id,
                    "attempt": attempt,
                    "attempts": attempts_allowed,
                    "timeout": isinstance(exc, asyncio.TimeoutError),
                    "error": str(exc) or exc.__class__.__name__,
                })

        if last_exc is None:
            files_processed_total.labels(result="ok").inc()
            continue

        files_processed_total.labels(result="failed").inc()
        message = (
            f"Не удалось обработать файл «{record.file_name}» после "
            f"{attempts_allowed} попыток: {last_exc}"
        )
        try:
            await db.record_file_processing_error(record.id, message)
        except Exception as exc:  # noqa: BLE001 - the package still continues without it
            logger.error("recording file processing error failed", extra={
                "process_id": process_id, "file_id": record.id, "error": str(exc),
            })
        try:
            await db.notify_admins(
                "FILE_PROCESSING_FAILED", "Не удалось обработать файл", message,
                process_id=process_id, object_id=record.object_id,
            )
        except Exception as exc:  # noqa: BLE001 - a failed notification must not cost the package
            logger.error("admin notification failed", extra={
                "process_id": process_id, "file_id": record.id, "error": str(exc),
            })


def _pages_from_lines(rows) -> dict[int, ExtractedPage]:
    """Rebuild the block/line shape app.explication.parse expects.

    Storage keeps one row per PDF line (Task 1), not the block object PyMuPDF
    produced it from, so a block's own box is not read back - it is retaken
    as the union of its lines. Geometry fields other than page_no are not
    read back either: find_rooms and find_floor_totals only ever look at
    page.blocks, never at a page's rotation, size or character count.
    """
    by_page: dict[int, dict[int, list]] = {}
    for row in rows:
        by_page.setdefault(row.page_no, {}).setdefault(row.block_no, []).append(row)

    pages: dict[int, ExtractedPage] = {}
    for page_no, blocks_by_no in by_page.items():
        blocks: list[ExtractedBlock] = []
        for block_no in sorted(blocks_by_no):
            block_rows = sorted(blocks_by_no[block_no], key=lambda r: r.line_no)
            lines = [
                ExtractedLine(
                    line_no=row.line_no, text=row.text,
                    box=NormalizedBox(row.x0, row.y0, row.x1, row.y1),
                )
                for row in block_rows
            ]
            blocks.append(ExtractedBlock(
                block_no=block_no,
                text="\n".join(line.text for line in lines),
                box=NormalizedBox(
                    x0=min(line.box.x0 for line in lines),
                    y0=min(line.box.y0 for line in lines),
                    x1=max(line.box.x1 for line in lines),
                    y1=max(line.box.y1 for line in lines),
                ),
                lines=lines,
            ))
        pages[page_no] = ExtractedPage(
            page_no=page_no, width_pt=0.0, height_pt=0.0, rotation=0,
            char_count=0, needs_ocr=False, blocks=blocks,
        )
    return pages


async def _sheet_rooms_for_file(db, file) -> list[SheetRooms]:
    rows = await db.get_page_lines(file.id)
    pages = _pages_from_lines(rows)

    sheets: list[SheetRooms] = []
    for page_no in sorted(pages):
        rooms = find_rooms(pages[page_no])
        if not rooms:
            # A page with no rooms at all is not evidence of anything: it has
            # no numbers to pair against, and would only ever match another
            # empty page by accident.
            continue
        keyed = {room_key(room, rooms): room for room in rooms}
        sheets.append(SheetRooms(
            file_id=file.id, page_no=page_no, rooms=keyed,
            totals=find_floor_totals(pages[page_no]),
        ))
    return sheets


# select_source_revision (app/domain/revisions.py, out of scope for this
# task) reports in English for its own log-facing callers; checks.rationale
# is read by the inspector, so its five non-COMPLETE outcomes are mapped to
# Russian here rather than changing that module's own wording.
_SELECTION_REASON_RU = {
    "no file for the requested stage and discipline":
        "нет файла для этой стадии и раздела",
    "all revisions are cancelled or superseded":
        "все редакции отменены или заменены",
    "the current approved revision cannot be read":
        "текущая утверждённая редакция не читается",
    "no approved revision among the current ones":
        "среди текущих редакций нет утверждённой",
    "several approved revisions without an unambiguous order":
        "несколько утверждённых редакций без однозначного порядка",
}


def _reason_ru(reason: str) -> str:
    return _SELECTION_REASON_RU.get(reason, reason)


def _select_stage_files(files, stage: str, process_id: str):
    """Pick the one current file per document within a stage.

    select_source_revision decides between revisions of a single *document*
    (app.domain.revisions docstring); a stage is many documents under
    different codes, so it is called once per (discipline, document_code)
    group and never on the whole stage at once. Calling it on the whole
    stage - the pipeline's own previous behaviour - would read two different
    approved documents as competing revisions of "the same" thing and
    declare a revision conflict on almost any real package.

    Returns the winning file per document (comparable), plus a
    (label, status, reason) tuple for every group that produced none: a file
    with no document code (section 9.1 names the code mandatory for revision
    selection, so guessing which document it belongs to is not an option),
    or a group select_source_revision could not settle unambiguously.
    """
    stage_files = [f for f in files if f.doc_stage == stage]
    winners = []
    problems: list[tuple[str, str, str]] = []

    without_code = [f for f in stage_files if f.document_code is None]
    for f in without_code:
        problems.append((f"file:{f.id}", "CLARIFICATION_REQUIRED", "не указан шифр документа"))
        logger.info("source selection", extra={
            "process_id": process_id, "stage": stage, "discipline": f.discipline,
            "document_code": None, "selection_status": "CLARIFICATION_REQUIRED",
            "reason": "не указан шифр документа", "file_id": None,
        })

    groups: dict[tuple, list] = {}
    for f in stage_files:
        if f.document_code is not None:
            groups.setdefault((f.discipline, f.document_code), []).append(f)

    for (discipline, document_code), group_files in groups.items():
        metas = [
            FileMeta(
                file_id=f.id, doc_stage=f.doc_stage, discipline=f.discipline,
                document_code=f.document_code, revision=f.revision,
                approval_status=f.approval_status, approval_date=_as_date(f.approval_date),
                predecessor_id=f.predecessor_id, readable=True,
            )
            for f in group_files
        ]
        selection = select_source_revision(metas, stage, discipline)
        logger.info("source selection", extra={
            "process_id": process_id, "stage": stage, "discipline": discipline,
            "document_code": document_code, "selection_status": selection.status,
            "reason": selection.reason, "file_id": selection.file_id,
        })
        if selection.status == "COMPLETE":
            winners.append(next(f for f in group_files if f.id == selection.file_id))
        else:
            problems.append((f"document:{discipline}:{document_code}",
                             selection.status, _reason_ru(selection.reason)))

    return winners, problems


def _completeness_check(object_id: str, spec: ParamSpec, matrix_version: str,
                         group_label: str, status: str, reason: str) -> dict:
    """A checks row that states input quality only - never a finding.

    Used both for M-003 groups that could not be compared (an outdated or
    ambiguous revision must never stand in for the reference) and for every
    parameter this stage of the worker has no extractor for at all.
    """
    return {
        "param_code": spec.code,
        "evidence_group_id": f"{object_id}:{spec.code}:{group_label}",
        "subject": None,
        "expected_value": None,
        "actual_value": None,
        "delta": None,
        "completeness_status": status,
        "finding_status": None,
        "review_priority": spec.review_priority,
        "rationale": reason,
        "matrix_version": matrix_version,
        "fragments": [],
    }


def _fragment(file, sheet: SheetRooms, box: NormalizedBox,
              extracted_value: str | None, role: str) -> dict:
    return {
        "file_id": file.id,
        "file_sha256": file.file_hash,
        "stage": file.doc_stage,
        "document_code": file.document_code,
        "revision": file.revision,
        "approval_status": file.approval_status,
        "sheet_page": sheet.page_no,
        "x0": box.x0, "y0": box.y0, "x1": box.x1, "y1": box.y1,
        "extracted_value": extracted_value,
        "role": role,
    }


def _room_finding_check(object_id: str, spec: ParamSpec, matrix_version: str,
                         pd_sheet: SheetRooms, rd_sheet: SheetRooms,
                         finding: RoomFinding, file_by_id: dict) -> dict:
    expected_file = file_by_id[finding.expected_sheet.file_id]
    actual_file = file_by_id[finding.actual_sheet.file_id]
    # A subject alone ("floor total", or a room number reused on another
    # floor or in another table) is not unique across a package with more
    # than one PD/RD sheet pair: the pair the finding came from - fixed
    # across re-runs, since file ids and page numbers do not change - is
    # what actually makes the group id unique within the process. A
    # composite's own subject ("rooms 134..149") is built the same way as an
    # ordinary room's ("room 134"), so this scheme already keeps a composite
    # and its own atoms apart without any change here.
    pair_id = f"{pd_sheet.file_id}#{pd_sheet.page_no}~{rd_sheet.file_id}#{rd_sheet.page_no}"
    check = {
        "param_code": spec.code,
        "evidence_group_id": f"{object_id}:{spec.code}:{pair_id}:{finding.subject}",
        "subject": finding.subject,
        "expected_value": finding.expected,
        "actual_value": finding.actual,
        "delta": finding.delta,
        "completeness_status": "COMPLETE",
        "finding_status": finding.status,
        "review_priority": spec.review_priority,
        "rationale": finding.rationale,
        "matrix_version": matrix_version,
        "fragments": [
            _fragment(expected_file, finding.expected_sheet, finding.expected_box,
                      finding.expected, "expected"),
            _fragment(actual_file, finding.actual_sheet, finding.actual_box,
                      finding.actual, "actual"),
        ],
    }
    # A composite candidate (app.explication.compare's module docstring)
    # carries its own members as ordinary check dicts, built exactly the way
    # every atomic finding always was - db.save_checks inserts them under
    # this check's id (parent_check_id), invisible until an inspector splits
    # the composite (POST /findings/:id/split, services/api).
    if finding.atoms:
        check["atoms"] = [
            _room_finding_check(object_id, spec, matrix_version, pd_sheet, rd_sheet, atom, file_by_id)
            for atom in finding.atoms
        ]
    return check


def _sem_room_fn_not_comparable(object_id: str, matrix_version: str, group_label: str, reason: str) -> dict:
    """A checks row that states the model could not be asked - never a
    hypothesis (Global Constraint: without a model, the package still
    finishes). SEM-ROOM-FN has no ParamSpec of its own - it is a free-search
    rule (section 9.5), not a matrix parameter - so its fields are supplied
    directly here rather than read off a spec, the way _completeness_check
    does for M-003 and the matrix.
    """
    return {
        "param_code": _SEM_ROOM_FN_CODE,
        "evidence_group_id": f"{object_id}:{_SEM_ROOM_FN_CODE}:{group_label}",
        "subject": None,
        "expected_value": None,
        "actual_value": None,
        "delta": None,
        "completeness_status": "NOT_COMPARABLE",
        "finding_status": None,
        "review_priority": _SEM_ROOM_FN_PRIORITY,
        "rationale": reason,
        "matrix_version": matrix_version,
        "fragments": [],
    }


def _room_function_check(object_id: str, matrix_version: str,
                          pd_sheet: SheetRooms, rd_sheet: SheetRooms, key: str,
                          pd_room: Room, rd_room: Room, verdict, file_by_id: dict) -> dict:
    """A SUSPICION row for one room the model says changed function.

    Global Constraint: a hypothesis is not a violation - finding_status is
    SUSPICION, never CANDIDATE, and detection_method/confidence exist only
    for the inspector's screen (section 9.5), never to gate anything here.
    """
    expected_file = file_by_id[pd_sheet.file_id]
    actual_file = file_by_id[rd_sheet.file_id]
    # Same scheme as M-003's own findings (_room_finding_check): the sheet
    # pair a room came from, not the room key alone, is what keeps the group
    # id unique across a package with more than one PD/RD pair.
    pair_id = f"{pd_sheet.file_id}#{pd_sheet.page_no}~{rd_sheet.file_id}#{rd_sheet.page_no}"
    subject = f"function {key}"
    return {
        "param_code": _SEM_ROOM_FN_CODE,
        "evidence_group_id": f"{object_id}:{_SEM_ROOM_FN_CODE}:{pair_id}:{subject}",
        "subject": subject,
        "expected_value": pd_room.name,
        "actual_value": rd_room.name,
        "delta": None,
        "completeness_status": "COMPLETE",
        "finding_status": "SUSPICION",
        "detection_method": "SEMANTIC",
        "confidence": verdict.confidence,
        "review_priority": _SEM_ROOM_FN_PRIORITY,
        "rationale": (
            f"Назначение помещения {pd_room.number} изменено: в ПД «{pd_room.name}», "
            f"в РД «{rd_room.name}». {verdict.reason}"
        ),
        "matrix_version": matrix_version,
        "fragments": [
            _fragment(expected_file, pd_sheet, pd_room.evidence_box, pd_room.name, "expected"),
            _fragment(actual_file, rd_sheet, rd_room.evidence_box, rd_room.name, "actual"),
        ],
    }


async def _room_function_checks(process_id: str, object_id: str, matrix_version: str,
                                 pairs: list[tuple[SheetRooms, SheetRooms]],
                                 file_by_id: dict, provider) -> list[dict]:
    """Section 9.5 semantic dissonance: every room that kept its number on
    both sheets but reads differently after normalize_room_name, across
    every PD/RD pair of the package, asked about in one model call total
    (Global Constraint: one call per package, not one per sheet pair).
    """
    name_pairs: list[NamePair] = []
    lookup: dict[str, tuple[SheetRooms, SheetRooms, str, Room, Room]] = {}
    for pd_sheet, rd_sheet in pairs:
        for key in sorted(set(pd_sheet.rooms) & set(rd_sheet.rooms)):
            pd_room, rd_room = pd_sheet.rooms[key], rd_sheet.rooms[key]
            if not pd_room.name or not rd_room.name:
                continue
            if normalize_room_name(pd_room.name) == normalize_room_name(rd_room.name):
                continue
            pair_key = f"p{len(name_pairs) + 1}"
            name_pairs.append(NamePair(key=pair_key, pd_name=pd_room.name, rd_name=rd_room.name))
            lookup[pair_key] = (pd_sheet, rd_sheet, key, pd_room, rd_room)

    if not name_pairs:
        # Nothing disagrees after normalization: there is no hypothesis to
        # raise and nothing a model call could have told us, so no
        # SEM-ROOM-FN row at all - not even NOT_COMPARABLE, the same way
        # M-003 itself never reports on a pair with nothing to compare.
        return []

    if provider is None:
        logger.info("room functions compared", extra={
            "process_id": process_id, "pairs": len(name_pairs), "elapsed_s": 0.0, "configured": False,
        })
        return [_sem_room_fn_not_comparable(
            object_id, matrix_version, "no-provider",
            "Языковая модель не подключена: сравнение назначений помещений не выполнялось",
        )]

    started = time.monotonic()
    try:
        verdicts = await compare_room_functions(name_pairs, provider)
    except LlmUnavailable as exc:
        logger.info("room functions compared", extra={
            "process_id": process_id, "pairs": len(name_pairs),
            "elapsed_s": round(time.monotonic() - started, 3), "configured": True, "error": str(exc),
        })
        return [_sem_room_fn_not_comparable(object_id, matrix_version, "unavailable", str(exc))]

    logger.info("room functions compared", extra={
        "process_id": process_id, "pairs": len(name_pairs),
        "elapsed_s": round(time.monotonic() - started, 3), "configured": True,
        "different": sum(1 for v in verdicts if not v.same_function),
    })

    checks = []
    for verdict in verdicts:
        if verdict.same_function:
            continue  # Global Constraint: same_function never produces a row.
        pd_sheet, rd_sheet, key, pd_room, rd_room = lookup[verdict.key]
        checks.append(_room_function_check(
            object_id, matrix_version, pd_sheet, rd_sheet, key, pd_room, rd_room, verdict, file_by_id,
        ))
    return checks


async def _explication_checks(process_id: str, object_id: str, files, db,
                               m003: ParamSpec, matrix_version: str, provider,
                               area_relative_threshold: float) -> list[dict]:
    """M-003: compare room explications between the current PD and RD sources.

    Every group that could not contribute a comparable file records its own
    completeness statement rather than being silently skipped, so a package
    that could not be compared still says why, instead of just having fewer
    checks than expected.
    """
    pdf_files = [f for f in files if f.mime_type == "application/pdf"]

    checks: list[dict] = []
    winners_by_stage: dict[str, list] = {}
    for stage in _COMPARABLE_STAGES:
        winners, problems = _select_stage_files(pdf_files, stage, process_id)
        winners_by_stage[stage] = winners
        for label, status, reason in problems:
            checks.append(_completeness_check(
                object_id, m003, matrix_version, f"{stage}:{label}", status, reason,
            ))

    if not winners_by_stage["PD"] or not winners_by_stage["RD"]:
        checks.append(_completeness_check(
            object_id, m003, matrix_version, "no-source", "MISSING_EVIDENCE",
            "нет актуального файла ПД или РД для сравнения экспликаций помещений",
        ))
        return checks

    file_by_id = {f.id: f for f in pdf_files}
    pd_sheets: list[SheetRooms] = []
    for f in winners_by_stage["PD"]:
        pd_sheets.extend(await _sheet_rooms_for_file(db, f))
    rd_sheets: list[SheetRooms] = []
    for f in winners_by_stage["RD"]:
        rd_sheets.extend(await _sheet_rooms_for_file(db, f))

    pairs = pair_sheets(pd_sheets, rd_sheets)
    if not pairs:
        checks.append(_completeness_check(
            object_id, m003, matrix_version, "no-pair", "NOT_COMPARABLE",
            "не удалось сопоставить листы ПД и РД по номерам помещений",
        ))
        return checks

    for pd_sheet, rd_sheet in pairs:
        for finding in compare_sheets(pd_sheet, rd_sheet, area_relative_threshold):
            checks.append(_room_finding_check(
                object_id, m003, matrix_version, pd_sheet, rd_sheet, finding, file_by_id,
            ))

    checks.extend(await _room_function_checks(
        process_id, object_id, matrix_version, pairs, file_by_id, provider,
    ))

    return checks


# The three statuses an inspector's screen ever shows as a finding (section
# 9.2/9.5). A completeness-only row (finding_status None) is a statement
# about input quality, never a finding - see _completeness_check's docstring.
_FINDING_STATUSES = ("CANDIDATE", "NEGATIVE_VERIFIED", "SUSPICION")


def _record_findings_metrics(checks: list[dict]) -> None:
    """Count one run's findings by status, composite atoms included -
    save_checks inserts them as their own rows (_room_finding_check's own
    comment), so they are findings of their own for this count too."""
    for check in checks:
        if check.get("finding_status") in _FINDING_STATUSES:
            findings_total.labels(status=check["finding_status"]).inc()
        for atom in check.get("atoms", []):
            if atom.get("finding_status") in _FINDING_STATUSES:
                findings_total.labels(status=atom["finding_status"]).inc()


def input_manifest_hash(process, files) -> str:
    """The fingerprint of what a protocol was computed from.

    The uploaded registry's hash when there is one. Without a registry, the
    sorted hashes of the package's files: section 14.2 requires every result
    to carry an input fingerprint, and a package without a registry is still
    a definite set of inputs.
    """
    if process.input_manifest_hash:
        return process.input_manifest_hash
    joined = "\n".join(sorted(f.file_hash for f in files))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


async def _process_start_once(process_id: str, db, storage, config) -> None:
    process = await db.get_process(process_id)
    if process is None:
        # A race with the API (task published before the row is visible, or
        # the process was since deleted) is a data-quality statement about
        # the queue, not a reason to crash the consumer over one message.
        logger.error("process not found", extra={"process_id": process_id})
        return

    files = await db.get_files(process_id)

    manifest_row = None
    if process.manifest_uploaded:
        manifest_row = next((f for f in files if _is_manifest_row(f, process)), None)

    entries = []
    if manifest_row is not None:
        raw = await storage.get_object(manifest_row.storage_key)
        parse_result = parse_manifest(raw, manifest_row.file_name)
        for error in parse_result.errors:
            logger.warning("manifest parse issue", extra={
                "process_id": process_id,
                "manifest_file_name": manifest_row.file_name,
                "detail": error,
            })
        entries = parse_result.entries

    # The registry row itself is not a document and must not be treated as
    # one when computing completeness or selecting sources.
    document_files = [f for f in files if manifest_row is None or f.id != manifest_row.id]
    by_name = {f.file_name: f for f in document_files}
    updated = {f.id: f for f in document_files}
    matched_ids: set[str] = set()

    for entry in entries:
        target = by_name.get(entry.file_name)
        if target is None:
            continue
        matched_ids.add(target.id)

        predecessor_id = None
        if entry.predecessor_id:
            predecessor = by_name.get(entry.predecessor_id)
            if predecessor is not None:
                predecessor_id = predecessor.id
            else:
                logger.warning("manifest predecessor not found", extra={
                    "process_id": process_id,
                    "file_name": entry.file_name,
                    "predecessor_name": entry.predecessor_id,
                })

        await db.update_file_metadata(
            target.id,
            doc_stage=entry.doc_stage,
            discipline=entry.discipline,
            document_code=entry.document_code,
            revision=entry.revision,
            approval_status=entry.approval_status,
            approval_date=entry.approval_date,
            sheet_page_range=entry.sheet_page_range,
            predecessor_id=predecessor_id,
            signature_status=entry.signature_status,
        )

        updated[target.id] = replace(
            target,
            doc_stage=entry.doc_stage,
            discipline=entry.discipline,
            document_code=entry.document_code,
            revision=entry.revision,
            approval_status=entry.approval_status,
            approval_date=entry.approval_date,
            sheet_page_range=entry.sheet_page_range,
            predecessor_id=predecessor_id,
            signature_status=entry.signature_status,
            from_manifest=True,
        )

    unmatched_entries = sum(1 for e in entries if e.file_name not in by_name)
    unmatched_files = sum(1 for f in document_files if f.id not in matched_ids)
    if unmatched_entries or unmatched_files:
        logger.warning("manifest coverage gap", extra={
            "process_id": process_id,
            "unmatched_manifest_entries": unmatched_entries,
            "unmatched_files": unmatched_files,
        })

    # The registry row was already excluded from document_files above; it has
    # no text layer of its own and is not a document of the package.
    await _extract_document_pages(process_id, document_files, db, storage, config)

    final_files = list(updated.values())
    metas = [
        FileMeta(
            file_id=f.id,
            doc_stage=f.doc_stage,
            discipline=f.discipline,
            document_code=f.document_code,
            revision=f.revision,
            approval_status=f.approval_status,
            approval_date=_as_date(f.approval_date),
            predecessor_id=f.predecessor_id,
            # No unreadability signal exists in the schema: unreadable
            # uploads are rejected at intake, before a row is ever created.
            readable=True,
        )
        for f in final_files
    ]

    # Expected counts are known only when the registry actually yielded rows.
    # A registry that was uploaded but could not be read tells us nothing, and
    # counting its zero entries as "zero expected" would report a genuinely
    # absent stage as NOT_APPLICABLE - claiming the stage does not apply to
    # this object, which is a stronger statement than the data supports.
    expected = None
    if entries:
        expected = {stage: 0 for stage in STAGES}
        for entry in entries:
            expected[entry.doc_stage] = expected.get(entry.doc_stage, 0) + 1

    completeness = compute_completeness(metas, expected)
    by_stage = {c.stage: c for c in completeness}

    try:
        scenario = determine_scenario(completeness)
    except ValueError:
        # Nothing was uploaded for any stage: there is no scenario to name,
        # and that absence is itself the finding, not a pipeline failure.
        scenario = None

    specs = load_specs()
    m003 = next(spec for spec in specs.params if spec.code == "M-003")

    # M-003's own room/floor-total area deltas reuse M-002's relative
    # ceiling ("Дельта общей площади ... > 1%") rather than a threshold of
    # their own - see app.explication.compare's module docstring. M-002 is
    # looked up defensively, not with M-003's own next(...) that raises: a
    # matrix missing this one spec must not cost the run every explication
    # comparison over a threshold it can fall back on instead.
    m002 = next((spec for spec in specs.params if spec.code == "M-002"), None)
    area_relative_threshold = (
        m002.compare_threshold
        if m002 is not None and m002.compare_threshold is not None
        else DEFAULT_AREA_RELATIVE_THRESHOLD
    )

    # None when LLM_BASE_URL is unset (see app.config's own docstring): every
    # call downstream already treats that the same as LlmUnavailable, so no
    # branch is needed here beyond building it once for the whole package.
    provider = provider_from_config(config)

    try:
        checks = await _explication_checks(
            process_id, process.object_id, final_files, db, m003, specs.version, provider,
            area_relative_threshold,
        )
    except Exception as exc:  # noqa: BLE001 - a failed comparison is one finding, not a lost package
        logger.error("explication comparison failed", extra={
            "process_id": process_id, "error": str(exc),
        })
        checks = [_completeness_check(
            process.object_id, m003, specs.version, "error", "NOT_COMPARABLE",
            f"сравнение экспликаций не выполнено: {exc}",
        )]

    # Every other parameter of the matrix has no extractor wired up yet
    # (section 9.2: an honest refusal, not a guess). M-003 is excluded here
    # because it was just answered above, by the comparison itself.
    for outcome in evaluate_all(specs, {}):
        if outcome.code == "M-003":
            continue
        spec = next(s for s in specs.params if s.code == outcome.code)
        checks.append(_completeness_check(
            process.object_id, spec, specs.version, "matrix", outcome.status, outcome.reason,
        ))

    _record_findings_metrics(checks)

    try:
        await db.save_checks(process_id, process.object_id, checks)
    except Exception as exc:  # noqa: BLE001 - the protocol still reaches READY without it
        logger.error("saving checks failed", extra={
            "process_id": process_id, "error": str(exc),
        })

    try:
        # Section 9.2: a versioned protocol is issued once processing has run,
        # carrying the matrix/model/dataset versions and input fingerprint
        # section 14.2 requires. A failure here is logged, not fatal: the
        # process must still reach READY so an inspector is not blocked by it.
        protocol_version = await db.create_protocol(
            process.id, process.object_id, specs.version, config.model_version,
            config.dataset_version, input_manifest_hash(process, final_files),
        )
        logger.info("protocol created", extra={
            "process_id": process_id,
            "object_id": process.object_id,
            "version": protocol_version,
        })
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.error("protocol creation failed", extra={
            "process_id": process_id, "error": str(exc),
        })

    await db.save_processing_result(
        process_id,
        pd_completeness=by_stage["PD"].status,
        rd_completeness=by_stage["RD"].status,
        id_completeness=by_stage["ID"].status,
        scenario=scenario,
        status="READY",
    )

    logger.info("process ready", extra={
        "process_id": process_id,
        "scenario": scenario,
        "pd_completeness": by_stage["PD"].status,
        "rd_completeness": by_stage["RD"].status,
        "id_completeness": by_stage["ID"].status,
    })

    try:
        # Customer's ТЗ p.19: "Инспектор получает уведомление о готовности
        # протокола". A failure here is logged, not fatal - the process has
        # already reached READY and must not be undone by a notification
        # that could not be written.
        await db.notify_process_owner(
            process, "PROCESS_READY", "Протокол готов к проверке",
            f"Протокол по процессу {process.id} готов к проверке.",
        )
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.error("notifying process owner failed", extra={
            "process_id": process_id, "error": str(exc),
        })


async def process_start(process_id: str, db, storage, config) -> None:
    """Entry point routed from the queue (app.consumer.HANDLERS).

    Retries the whole task in-process up to config.processing_retries
    further times (customer's ТЗ p.17: "Повторная попытка обработки (до 2
    раз)") before giving up. Every attempt re-reads the process and its
    files from scratch (_process_start_once), so a transient failure (a
    dropped DB connection, for instance) never carries stale state into the
    next attempt. Once every attempt has failed, the process is moved to
    FAILED with a short reason and the admins are notified - never left
    stuck in PARSING with nothing to drive it out, and never raised back
    into the consumer loop (app.consumer._consume_messages), which must keep
    running whatever any one message does.
    """
    attempts_allowed = 1 + max(config.processing_retries, 0)
    last_exc: BaseException | None = None
    started = time.monotonic()
    for attempt in range(1, attempts_allowed + 1):
        try:
            await _process_start_once(process_id, db, storage, config)
            process_duration_seconds.observe(time.monotonic() - started)
            processes_total.labels(result="ready").inc()
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - retried in-process, reported once exhausted
            last_exc = exc
            logger.error("process.start attempt failed", extra={
                "process_id": process_id,
                "attempt": attempt,
                "attempts": attempts_allowed,
                "error": str(exc) or exc.__class__.__name__,
            })

    process_duration_seconds.observe(time.monotonic() - started)
    processes_total.labels(result="failed").inc()

    message = f"Обработка пакета завершилась ошибкой: {last_exc}"
    try:
        await db.mark_process_failed(process_id, message)
    except Exception as exc:  # noqa: BLE001 - never raised back into the consumer
        logger.error("marking process failed did not succeed", extra={
            "process_id": process_id, "error": str(exc),
        })
    try:
        process = await db.get_process(process_id)
        await db.notify_admins(
            "PROCESS_FAILED", "Обработка пакета завершилась ошибкой", message,
            process_id=process_id, object_id=process.object_id if process is not None else None,
        )
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.error("admin notification failed", extra={
            "process_id": process_id, "error": str(exc),
        })
