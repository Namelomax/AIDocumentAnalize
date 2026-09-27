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

import logging
from dataclasses import replace
from datetime import date, datetime

from app.domain.completeness import STAGES, compute_completeness, determine_scenario
from app.domain.manifest import parse_manifest
from app.domain.revisions import FileMeta, select_source_revision
from app.explication.compare import RoomFinding, SheetRooms, compare_sheets, pair_sheets
from app.explication.parse import find_floor_totals, find_rooms, room_key
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


def _as_date(value: date | datetime | None) -> date | None:
    # Postgres TIMESTAMP columns come back as datetime; the domain layer
    # compares against plain dates.
    if isinstance(value, datetime):
        return value.date()
    return value


def _is_manifest_row(file_row, process) -> bool:
    return file_row.doc_stage is None and file_row.file_hash == process.input_manifest_hash


async def _extract_document_pages(process_id: str, files, db, storage) -> None:
    """Read the text layer of every PDF in the package.

    One unreadable file must not cost the package its other documents, so a
    failure here is recorded against that file and the rest continue.
    """
    for record in files:
        if record.mime_type != "application/pdf":
            continue
        try:
            raw = await storage.get_object(record.storage_key)
            pages = extract_pages(raw)
            stored = []
            for page in pages:
                image_key = f"pages/{record.id}/{page.page_no}.png"
                await storage.put_object(
                    image_key, render_page_png(raw, page.page_no), "image/png"
                )
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
            logger.info("pages extracted", extra={
                "process_id": process_id,
                "file_id": record.id,
                "pages": len(stored),
                "scans": sum(1 for p in stored if p["needs_ocr"]),
            })
        except Exception as exc:  # noqa: BLE001 - reported per file, never fatal
            logger.error("page extraction failed", extra={
                "process_id": process_id,
                "file_id": record.id,
                "error": str(exc),
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
    # what actually makes the group id unique within the process.
    pair_id = f"{pd_sheet.file_id}#{pd_sheet.page_no}~{rd_sheet.file_id}#{rd_sheet.page_no}"
    return {
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


async def _explication_checks(process_id: str, object_id: str, files, db,
                               m003: ParamSpec, matrix_version: str) -> list[dict]:
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
        for finding in compare_sheets(pd_sheet, rd_sheet):
            checks.append(_room_finding_check(
                object_id, m003, matrix_version, pd_sheet, rd_sheet, finding, file_by_id,
            ))

    return checks


async def process_start(process_id: str, db, storage) -> None:
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
    await _extract_document_pages(process_id, document_files, db, storage)

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

    try:
        checks = await _explication_checks(
            process_id, process.object_id, final_files, db, m003, specs.version,
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

    try:
        await db.save_checks(process_id, process.object_id, checks)
    except Exception as exc:  # noqa: BLE001 - the protocol still reaches READY without it
        logger.error("saving checks failed", extra={
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
