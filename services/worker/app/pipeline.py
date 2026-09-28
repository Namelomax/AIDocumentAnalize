"""The process.start pipeline: parse the registry, enrich file rows, compute
completeness/scenario, select the current source per document, compare room
explications between design and working documentation, and record a check
row for every parameter of the matrix.

Everything this module learns about the input package is a data-quality
statement, never a processing error: a missing registry, an unreadable one,
or a dangling predecessor reference must not stop the run. Every code path
ends with the process moved to READY, because nothing else drives it out of
PARSING on a stand no one is watching.

Section 9.5's free-search hypotheses (SEM-ROOM-FN) are NOT computed here.
Asking a local model about every PD/RD room-name pair of a real package (the
reference school package has 23) in one request routinely outran
LLM_TIMEOUT_S's default 60s, which broke customer's ТЗ's own "Инкрементальное
обновление протокола (при дозагрузке) — не более 1 минуты" - the matrix
protocol was only reaching READY once the model call finished. process_start
and process_update now finish their own matrix work, save it, issue/update the
protocol and notify the owner without ever calling the model, then publish a
"process.hypotheses" follow-up task onto the same queue (app.consumer's own
Publisher) for process_hypotheses below to pick up once the protocol is
already usable. A failure to publish that follow-up is logged, not fatal -
the matrix protocol has already reached a resolved status without it.

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
from app.incremental import build_merge_plan
from app.llm.provider import LlmUnavailable, provider_from_config
from app.metrics import (
    file_attempts_total, files_processed_total, findings_total,
    hypotheses_duration_seconds, incremental_update_duration_seconds, process_duration_seconds,
    processes_total,
)
from app.params.engine import evaluate_all
from app.params.specs import ParamSpec, load_specs
from app.pdf.extract import ExtractedBlock, ExtractedLine, ExtractedPage, PARSER_VERSION, extract_pages
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


def _validated_cached_page(page: dict) -> dict:
    """Pull one page's fields out of a cache entry, raising KeyError/TypeError
    on anything that does not hold what a real entry always does - the
    caller (_pages_from_cache_entry) treats that the same as a miss.
    """
    blocks = page["blocks"]
    for b in blocks:
        # Accessed, not just presence-checked: a block dict missing a field
        # would otherwise only fail later, inside db.save_pages, by which
        # point some page images have already been copied under the new
        # file id - see _pages_from_cache_entry's own docstring.
        _ = (b["block_no"], b["line_no"], b["text"], b["x0"], b["y0"], b["x1"], b["y1"])
    return {
        "page_no": page["page_no"],
        "width_pt": page["width_pt"],
        "height_pt": page["height_pt"],
        "rotation": page["rotation"],
        "char_count": page["char_count"],
        "needs_ocr": page["needs_ocr"],
        "blocks": blocks,
    }


async def _pages_from_cache_entry(entry: dict, record, storage, process_id: str) -> list[dict] | None:
    """Rebuild `stored` (the shape db.save_pages and _extract_one_file's own
    miss path both produce) from a cache hit.

    Each page's rendered image is copied to this file's own object key
    rather than downloading and re-uploading it through the worker - except
    when the source image is simply gone from MinIO (evicted, or the source
    file itself was since deleted), which is not corruption: that one page is
    re-rendered from this file's own bytes instead, identical to the
    source's PDF bytes since the cache key is the file's content hash.

    Returns None - handled by the caller exactly like a cache miss - if the
    entry's shape does not hold what a real one always does.
    """
    try:
        pages = entry["pages"]
        if not isinstance(pages, list):
            raise TypeError("entry['pages'] is not a list")

        stored: list[dict] = []
        raw: bytes | None = None
        for page in pages:
            validated = _validated_cached_page(page)
            page_no = validated["page_no"]
            source_image_key = page["image_key"]
            dest_key = f"pages/{record.id}/{page_no}.png"
            try:
                await storage.copy_object(source_image_key, dest_key)
            except Exception as exc:  # noqa: BLE001 - the source image may simply be gone
                logger.warning("cached page image missing, re-rendering", extra={
                    "process_id": process_id, "file_id": record.id,
                    "page_no": page_no, "error": str(exc),
                })
                if raw is None:
                    raw = await storage.get_object(record.storage_key)
                png = await asyncio.to_thread(render_page_png, raw, page_no)
                await storage.put_object(dest_key, png, "image/png")
            stored.append({**validated, "image_key": dest_key})
    except (KeyError, TypeError) as exc:
        logger.warning("parse cache entry corrupt", extra={
            "process_id": process_id, "file_id": record.id, "error": str(exc),
        })
        return None

    return stored


async def _extract_one_file(record, db, storage, timeout_s: float, *,
                             process_id: str, cache=None) -> list[dict]:
    """One attempt at reading a single PDF's text layer and rendering its
    pages. Raises (TimeoutError on a timeout, whatever extract_pages/
    render_page_png raise otherwise) rather than catching anything itself -
    the retry loop in _extract_document_pages owns deciding when to give up.

    Customer's ТЗ p.16, п.5 "Кеширование": a cache hit on record.file_hash
    (app.pdf.cache) skips extract_pages/render_page_png entirely and copies
    the earlier run's page images instead - but still goes through
    db.save_pages below just like a fresh parse, since every file id needs
    its own pages/text_blocks rows regardless of whether its bytes were ever
    seen before.
    """
    if cache is not None:
        entry = await cache.get(
            PARSER_VERSION, record.file_hash, process_id=process_id, file_id=record.id,
        )
        if entry is not None:
            stored = await _pages_from_cache_entry(entry, record, storage, process_id)
            if stored is not None:
                await db.save_pages(record.id, stored)
                return stored

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
    if cache is not None:
        await cache.set(
            PARSER_VERSION, record.file_hash, {"source_file_id": record.id, "pages": stored},
            process_id=process_id, file_id=record.id,
        )
    return stored


async def _extract_document_pages(process_id: str, files, db, storage, config, *, cache=None) -> None:
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
                stored = await _extract_one_file(
                    record, db, storage, config.file_processing_timeout_s,
                    process_id=process_id, cache=cache,
                )
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


def _sem_room_fn_name_pairs(
    pairs: list[tuple[SheetRooms, SheetRooms]],
) -> tuple[list[NamePair], dict[str, tuple[SheetRooms, SheetRooms, str, Room, Room]]]:
    """Every room that kept its number on both sheets of a PD/RD pair but
    reads differently after normalize_room_name, across every pair handed
    in - the model-ready input _room_function_checks batches into calls, and
    the lookup back to the sheets/rooms each pair key came from.
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
    return name_pairs, lookup


async def _room_function_checks(process_id: str, object_id: str, matrix_version: str,
                                 pairs: list[tuple[SheetRooms, SheetRooms]],
                                 file_by_id: dict, provider, batch_size: int) -> list[dict]:
    """Section 9.5 semantic dissonance: every room that kept its number on
    both sheets but reads differently after normalize_room_name, across
    every PD/RD pair of the package, asked about in batches of `batch_size`
    pairs per model call (LLM_BATCH_SIZE) rather than the whole package in
    one request - see this module's own docstring for why: the reference
    package's 23 pairs in one call routinely outran LLM_TIMEOUT_S entirely.

    Called only from process_hypotheses, never from process_start/
    process_update's own critical path - see this module's own docstring.
    One batch that times out or errors writes a single NOT_COMPARABLE row
    covering that batch's own pairs (reusing _sem_room_fn_not_comparable, the
    same helper a package with no provider at all gets) and the remaining
    batches still go on - a slow or unreachable model must never cost every
    other pair its hypothesis.
    """
    name_pairs, lookup = _sem_room_fn_name_pairs(pairs)
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

    batch_size = max(batch_size, 1)
    checks: list[dict] = []
    different = 0
    total_started = time.monotonic()
    for batch_no, start in enumerate(range(0, len(name_pairs), batch_size)):
        batch = name_pairs[start:start + batch_size]
        started = time.monotonic()
        try:
            verdicts = await compare_room_functions(batch, provider)
        except LlmUnavailable as exc:
            logger.info("room functions batch compared", extra={
                "process_id": process_id, "batch": batch_no, "pairs": len(batch),
                "elapsed_s": round(time.monotonic() - started, 3), "configured": True, "error": str(exc),
            })
            checks.append(_sem_room_fn_not_comparable(
                object_id, matrix_version, f"unavailable:{batch_no}", str(exc),
            ))
            continue

        logger.info("room functions batch compared", extra={
            "process_id": process_id, "batch": batch_no, "pairs": len(batch),
            "elapsed_s": round(time.monotonic() - started, 3), "configured": True,
            "different": sum(1 for v in verdicts if not v.same_function),
        })
        for verdict in verdicts:
            if verdict.same_function:
                continue  # Global Constraint: same_function never produces a row.
            pd_sheet, rd_sheet, key, pd_room, rd_room = lookup[verdict.key]
            checks.append(_room_function_check(
                object_id, matrix_version, pd_sheet, rd_sheet, key, pd_room, rd_room, verdict, file_by_id,
            ))
            different += 1

    logger.info("room functions compared", extra={
        "process_id": process_id, "pairs": len(name_pairs),
        "batches": (len(name_pairs) + batch_size - 1) // batch_size,
        "elapsed_s": round(time.monotonic() - total_started, 3), "configured": True, "different": different,
    })
    return checks


async def _pd_rd_sheet_pairs(process_id: str, files, db) -> tuple[list[tuple[SheetRooms, SheetRooms]], dict]:
    """The same current-PD/current-RD sheet pairs M-003's own comparison
    uses (_explication_checks), recomputed independently for
    process_hypotheses - cheap, since it only rereads stored text
    (app.db.Database.get_page_lines), never the PDF bytes or the pages/
    text_blocks tables' own write path. Returns ([], {}) when no PD/RD
    source could be selected or no sheet could be paired - process_hypotheses
    then has nothing to ask the model about, exactly as M-003 itself has
    nothing to compare in that case.
    """
    pdf_files = [f for f in files if f.mime_type == "application/pdf"]
    winners_by_stage: dict[str, list] = {}
    for stage in _COMPARABLE_STAGES:
        winners, _problems = _select_stage_files(pdf_files, stage, process_id)
        winners_by_stage[stage] = winners
    if not winners_by_stage["PD"] or not winners_by_stage["RD"]:
        return [], {}

    file_by_id = {f.id: f for f in pdf_files}
    pd_sheets: list[SheetRooms] = []
    for f in winners_by_stage["PD"]:
        pd_sheets.extend(await _sheet_rooms_for_file(db, f))
    rd_sheets: list[SheetRooms] = []
    for f in winners_by_stage["RD"]:
        rd_sheets.extend(await _sheet_rooms_for_file(db, f))

    return pair_sheets(pd_sheets, rd_sheets), file_by_id


async def _explication_checks(process_id: str, object_id: str, files, db,
                               m003: ParamSpec, matrix_version: str,
                               area_relative_threshold: float) -> list[dict]:
    """M-003: compare room explications between the current PD and RD sources.

    Every group that could not contribute a comparable file records its own
    completeness statement rather than being silently skipped, so a package
    that could not be compared still says why, instead of just having fewer
    checks than expected.

    Section 9.5's SEM-ROOM-FN hypotheses are not computed here any more -
    see this module's own docstring; process_hypotheses recomputes its own
    PD/RD pairing independently (_pd_rd_sheet_pairs), on its own schedule.
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


async def _compute_checks(process_id: str, object_id: str, final_files, db, config):
    """The full candidate set for a package: M-003's explication comparison
    (composites included) plus a completeness statement for every other
    matrix parameter.

    Shared between a fresh run (_process_start_once) and a дозагрузка's
    incremental update (_process_update_once) - both simply recompute this
    in full, reading only stored text, which is cheap enough either way
    ("recompute the full candidate set in memory"). Section 9.5's SEM-ROOM-FN
    hypotheses are not part of this set any more - see this module's own
    docstring; process_hypotheses computes and writes them on its own
    schedule, entirely off process_start/process_update's own critical path.

    Returns (checks, specs) - specs.version is also what the caller's own
    protocol records as matrix_version.
    """
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

    try:
        checks = await _explication_checks(
            process_id, object_id, final_files, db, m003, specs.version, area_relative_threshold,
        )
    except Exception as exc:  # noqa: BLE001 - a failed comparison is one finding, not a lost package
        logger.error("explication comparison failed", extra={
            "process_id": process_id, "error": str(exc),
        })
        checks = [_completeness_check(
            object_id, m003, specs.version, "error", "NOT_COMPARABLE",
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
            object_id, spec, specs.version, "matrix", outcome.status, outcome.reason,
        ))

    return checks, specs


async def _apply_manifest(process_id: str, process, files, db, storage):
    """Parse the registry (if the package carries one) and apply its entries
    to every document file's metadata.

    Shared between a fresh run (_process_start_once) and a дозагрузка's
    incremental update (_process_update_once) - both need the SAME metadata
    recomputed over the FULL current file set, new files included, exactly
    as customer's ТЗ "Инкрементальное обновление при дозагрузке" asks: the
    worker "recomputes the full candidate set", not just the delta.

    Returns (document_files, final_files, entries): document_files excludes
    the registry row itself (not a document, has no text layer of its own);
    final_files carries every document file with the manifest's own fields
    applied in memory, the same values db.update_file_metadata just
    persisted for it; entries is the registry's own parsed rows (empty
    without one), for the caller's "expected per stage" count.
    """
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

    return document_files, list(updated.values()), entries


async def _process_start_once(process_id: str, db, storage, config, *, cache=None, publisher=None) -> None:
    process = await db.get_process(process_id)
    if process is None:
        # A race with the API (task published before the row is visible, or
        # the process was since deleted) is a data-quality statement about
        # the queue, not a reason to crash the consumer over one message.
        logger.error("process not found", extra={"process_id": process_id})
        return

    files = await db.get_files(process_id)
    document_files, final_files, entries = await _apply_manifest(process_id, process, files, db, storage)

    # The registry row was already excluded from document_files above; it has
    # no text layer of its own and is not a document of the package.
    await _extract_document_pages(process_id, document_files, db, storage, config, cache=cache)

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

    checks, specs = await _compute_checks(process_id, process.object_id, final_files, db, config)

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

    # Section 9.5's hypotheses are computed off this critical path entirely -
    # see this module's own docstring. file_ids=None means "every PD/RD
    # pair"; process_hypotheses recomputes the pairing itself.
    await _publish_hypotheses_task(publisher, process_id, process.object_id, file_ids=None)


def _matrix_rows_for_merge(old_rows: list[dict]) -> list[dict]:
    """old_rows (app.db.Database.get_checks_for_merge) with every SEM-ROOM-FN
    row dropped, before app.incremental.build_merge_plan ever sees them.

    build_merge_plan deletes an old row whose group has no counterpart in the
    freshly computed "new" set (unless an inspector decided it - see its own
    docstring); _compute_checks no longer produces any SEM-ROOM-FN checks at
    all (this module's own docstring), so passing SEM-ROOM-FN's own old rows
    through unfiltered would make every hypothesis process_hypotheses had
    already written look abandoned and delete it on the very next дозагрузка.
    They are left in the `checks` table untouched instead - apply_merge_plan
    (app.db.Database) only ever touches rows the plan actually names.
    """
    return [row for row in old_rows if row["param_code"] != _SEM_ROOM_FN_CODE]


async def _process_update_once(process_id: str, new_file_ids: set[str], db, storage, config, *,
                                cache=None, publisher=None) -> None:
    """A дозагрузка's incremental update (customer's ТЗ "Инкрементальное
    обновление при дозагрузке"): recompute the full candidate set exactly as
    _process_start_once would, but merge it into the process's existing
    checks by evidence_group_id (app.incremental.build_merge_plan) instead of
    replacing them outright - "без сброса верификации".

    Section 9.5's SEM-ROOM-FN hypotheses (see this module's own docstring)
    are entirely outside this merge: _compute_checks no longer produces them
    at all, and old_rows's own SEM-ROOM-FN rows are filtered out before
    build_merge_plan ever sees them - see _matrix_rows_for_merge's own
    docstring for why leaving them in would silently delete every hypothesis
    process_hypotheses has written so far. A follow-up "process.hypotheses"
    task (published at the end of this function, file_ids=new_file_ids) is
    what keeps them current instead.

    Mirrors _process_start_once's own error handling throughout: every step
    that can fail on its own is caught and logged rather than raised, so one
    failed side-effect (a notification, a metric) never costs the process
    reaching a resolved status.
    """
    process = await db.get_process(process_id)
    if process is None:
        logger.error("process not found", extra={"process_id": process_id})
        return

    files = await db.get_files(process_id)
    all_old_rows = await db.get_checks_for_merge(process_id)
    old_rows = _matrix_rows_for_merge(all_old_rows)

    document_files, final_files, entries = await _apply_manifest(process_id, process, files, db, storage)

    new_document_files = [f for f in document_files if f.id in new_file_ids]
    await _extract_document_pages(process_id, new_document_files, db, storage, config, cache=cache)

    metas = [
        FileMeta(
            file_id=f.id, doc_stage=f.doc_stage, discipline=f.discipline,
            document_code=f.document_code, revision=f.revision,
            approval_status=f.approval_status, approval_date=_as_date(f.approval_date),
            predecessor_id=f.predecessor_id, readable=True,
        )
        for f in final_files
    ]
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
        scenario = None

    checks, specs = await _compute_checks(process_id, process.object_id, final_files, db, config)
    _record_findings_metrics(checks)

    user_ids = [row["verified_by"] for row in old_rows if row.get("verified_by")]
    try:
        user_names = await db.get_user_names(user_ids)
    except Exception as exc:  # noqa: BLE001 - a merge note naming raw ids is still a note
        logger.error("looking up user names for merge notes failed", extra={
            "process_id": process_id, "error": str(exc),
        })
        user_names = {}

    plan = build_merge_plan(old_rows, checks, user_names)
    logger.info("incremental merge computed", extra={
        "process_id": process_id, "added": plan.added, "changed": plan.changed,
        "removed": plan.removed, "kept": plan.kept,
    })

    new_status = "VERIFYING" if plan.decision_survived else "READY"
    protocol_version = None
    try:
        superseded_version = await db.snapshot_and_supersede_protocol(process_id)
        await db.apply_merge_plan(process_id, process.object_id, plan)
        protocol_version = await db.create_protocol(
            process.id, process.object_id, specs.version, config.model_version,
            config.dataset_version, input_manifest_hash(process, final_files),
            status=new_status,
        )
        logger.info("protocol superseded and reissued", extra={
            "process_id": process_id, "object_id": process.object_id,
            "superseded_version": superseded_version, "version": protocol_version,
        })
    except Exception as exc:  # noqa: BLE001 - the process still reaches a resolved status without it
        logger.error("incremental merge failed", extra={
            "process_id": process_id, "error": str(exc),
        })

    if protocol_version is not None:
        try:
            await db.mark_files_added_in_protocol(sorted(new_file_ids), protocol_version)
        except Exception as exc:  # noqa: BLE001 - cosmetic only (document list badge)
            logger.error("marking files' protocol version failed", extra={
                "process_id": process_id, "error": str(exc),
            })

    await db.save_processing_result(
        process_id,
        pd_completeness=by_stage["PD"].status,
        rd_completeness=by_stage["RD"].status,
        id_completeness=by_stage["ID"].status,
        scenario=scenario,
        status=new_status,
    )

    logger.info("process updated", extra={
        "process_id": process_id, "scenario": scenario, "status": new_status,
    })

    try:
        # Customer's ТЗ "Инкрементальное обновление при дозагрузке": the
        # inspector is told the protocol changed and by how much, not just
        # that it exists (PROCESS_READY, the fresh-run notification, would
        # read as if nothing had been decided before).
        await db.notify_process_owner(
            process, "PROTOCOL_UPDATED", "Протокол обновлён после дозагрузки",
            f"Протокол по процессу {process.id} обновлён после дозагрузки: "
            f"добавлено {plan.added}, изменено {plan.changed}, "
            f"удалено {plan.removed}, сохранено {plan.kept}.",
        )
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.error("notifying process owner failed", extra={
            "process_id": process_id, "error": str(exc),
        })

    # Only the дозагрузка's own new files can have changed anything
    # SEM-ROOM-FN-relevant - see this module's own docstring.
    await _publish_hypotheses_task(publisher, process_id, process.object_id, file_ids=sorted(new_file_ids))


async def process_update(process_id: str, db, storage, config, *, cache=None, publisher=None, file_ids=None) -> None:
    """Entry point routed from the queue (app.consumer.HANDLERS) for
    "process.update" - a дозагрузка's incremental update. Retries the whole
    task in-process the same number of times, and on the same terms, as
    process_start below; the two share every bit of that behaviour (attempts,
    FAILED, admin notification) precisely because a дозагрузка's failure
    mode must read identically to a fresh run's to an inspector or an
    administrator watching the process list.
    """
    new_file_ids = set(file_ids or [])
    attempts_allowed = 1 + max(config.processing_retries, 0)
    last_exc: BaseException | None = None
    started = time.monotonic()
    for attempt in range(1, attempts_allowed + 1):
        try:
            await _process_update_once(process_id, new_file_ids, db, storage, config, cache=cache, publisher=publisher)
            elapsed = time.monotonic() - started
            incremental_update_duration_seconds.observe(elapsed)
            # Customer's ТЗ: "Инкрементальное обновление протокола (при
            # дозагрузке) — не более 1 минуты" - logged, not enforced: a slow
            # update still finishes and still updates the protocol, but an
            # operator needs to see it broke the budget.
            if elapsed > 60:
                logger.warning("incremental update exceeded the 1-minute budget", extra={
                    "process_id": process_id, "elapsed_s": round(elapsed, 3),
                })
            processes_total.labels(result="ready").inc()
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - retried in-process, reported once exhausted
            last_exc = exc
            logger.error("process.update attempt failed", extra={
                "process_id": process_id, "attempt": attempt, "attempts": attempts_allowed,
                "error": str(exc) or exc.__class__.__name__,
            })

    incremental_update_duration_seconds.observe(time.monotonic() - started)
    processes_total.labels(result="failed").inc()

    message = f"Дозагрузка завершилась ошибкой: {last_exc}"
    try:
        await db.mark_process_failed(process_id, message)
    except Exception as exc:  # noqa: BLE001 - never raised back into the consumer
        logger.error("marking process failed did not succeed", extra={
            "process_id": process_id, "error": str(exc),
        })
    try:
        process = await db.get_process(process_id)
        await db.notify_admins(
            "PROCESS_FAILED", "Дозагрузка завершилась ошибкой", message,
            process_id=process_id, object_id=process.object_id if process is not None else None,
        )
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.error("admin notification failed", extra={
            "process_id": process_id, "error": str(exc),
        })


async def process_start(process_id: str, db, storage, config, *, cache=None, publisher=None) -> None:
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

    `cache` (app.pdf.cache.ParseCache) is keyword-only with a default of None
    so every call site that predates the parse cache - every test fixture
    among them - keeps working unchanged; None behaves exactly like a cache
    that is configured off. `publisher` (app.consumer.Publisher) is None the
    same way for every test fixture that predates process.hypotheses - the
    follow-up task publish is then simply skipped (_publish_hypotheses_task).
    """
    attempts_allowed = 1 + max(config.processing_retries, 0)
    last_exc: BaseException | None = None
    started = time.monotonic()
    for attempt in range(1, attempts_allowed + 1):
        try:
            await _process_start_once(process_id, db, storage, config, cache=cache, publisher=publisher)
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


async def _publish_hypotheses_task(publisher, process_id: str, object_id: str, *,
                                    file_ids: list[str] | None) -> None:
    """Publish the "process.hypotheses" follow-up task process_start/
    process_update end on (this module's own docstring) - file_ids=None asks
    process_hypotheses to consider every PD/RD pair (a fresh run), a list
    asks it to consider only pairs a дозагрузка's own new files touch.

    publisher is None for every test fixture that predates process.hypotheses
    (app.consumer.consume always builds a real one) - skipped rather than
    raising, the same way cache=None already behaves for the parse cache. A
    publish failure once a real one is configured is logged, not fatal: the
    matrix protocol already reached its own resolved status without it, and
    an operator watching the logs is the only recovery this needs - nothing
    downstream is blocked on it either way, only degraded.
    """
    if publisher is None:
        return
    try:
        await publisher.publish({
            "type": "process.hypotheses",
            "process_id": process_id,
            "object_id": object_id,
            "file_ids": file_ids,
        })
    except Exception as exc:  # noqa: BLE001 - see docstring
        logger.error("publishing process.hypotheses task failed", extra={
            "process_id": process_id, "error": str(exc),
        })


async def _process_hypotheses_once(process_id: str, file_ids: list[str] | None, db, config) -> None:
    """One run of process_hypotheses: recompute the PD/RD sheet pairing
    (cheap - stored text only, no PDF bytes), ask the model about the pairs
    in scope, and upsert whatever it produced into the process's current
    protocol.

    file_ids=None (a fresh run's own follow-up) considers every pair;
    file_ids=[...] (a дозагрузка's own follow-up) narrows to pairs where the
    PD or the RD sheet came from one of those files - a дозагрузка that
    touched nothing SEM-ROOM-FN-relevant then has nothing to ask about at
    all, and nothing is written.
    """
    process = await db.get_process(process_id)
    if process is None:
        logger.error("process not found", extra={"process_id": process_id})
        return

    files = await db.get_files(process_id)
    pairs, file_by_id = await _pd_rd_sheet_pairs(process_id, files, db)
    if not pairs:
        return

    if file_ids is not None:
        touched_ids = set(file_ids)
        pairs = [
            (pd_sheet, rd_sheet) for pd_sheet, rd_sheet in pairs
            if pd_sheet.file_id in touched_ids or rd_sheet.file_id in touched_ids
        ]
        if not pairs:
            return

    specs = load_specs()
    # None when LLM_BASE_URL is unset (see app.config's own docstring): every
    # call downstream already treats that the same as LlmUnavailable, so no
    # branch is needed here beyond building it once for the pairs in scope.
    provider = provider_from_config(config)
    checks = await _room_function_checks(
        process_id, process.object_id, specs.version, pairs, file_by_id, provider, config.llm_batch_size,
    )
    if not checks:
        return

    added = await db.upsert_hypothesis_checks(process_id, process.object_id, checks)
    if added is None:
        logger.info("hypotheses not written: protocol finalized or superseded", extra={
            "process_id": process_id,
        })
        return

    logger.info("hypotheses written", extra={"process_id": process_id, "added": added})

    if added > 0:
        try:
            # Section 9.5: the inspector who owns this process is told a
            # hypothesis is waiting on their screen - never sent for a batch
            # that only ever produced NOT_COMPARABLE rows (added == 0, no
            # model configured or every batch failed), which has nothing new
            # for them to look at.
            await db.notify_process_owner(
                process, "HYPOTHESES_READY", "Гипотезы свободного поиска готовы",
                f"Гипотезы свободного поиска готовы: {added}.",
            )
        except Exception as exc:  # noqa: BLE001 - the hypotheses are already written without it
            logger.error("notifying process owner failed", extra={
                "process_id": process_id, "error": str(exc),
            })


async def process_hypotheses(process_id: str, db, storage, config, *,
                              cache=None, publisher=None, file_ids=None) -> None:
    """Entry point routed from the queue (app.consumer.HANDLERS) for
    "process.hypotheses" - the follow-up task process_start/process_update
    publish once their own matrix work already reached a resolved status
    (this module's own docstring). Runs off the ТЗ's 1-minute budget
    entirely: the matrix protocol was already usable before this task was
    even published.

    Unlike process_start/process_update, a failure here is logged once and
    never retried whole, and never turns the process itself FAILED - the
    process already reached READY/VERIFYING without this task, and a slow or
    unreachable model already fails at the batch granularity inside
    _room_function_checks (one NOT_COMPARABLE row for that batch, the rest
    continue) rather than failing this task outright. `storage`, `cache` and
    `publisher` are accepted only so app.consumer can call every handler the
    same way - none of them do anything here: sheet pairing only ever reads
    stored text (app.db.Database.get_page_lines), and this task publishes no
    follow-up of its own.
    """
    started = time.monotonic()
    try:
        await _process_hypotheses_once(process_id, file_ids, db, config)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - never raised back into the consumer
        logger.error("process.hypotheses failed", extra={
            "process_id": process_id, "error": str(exc) or exc.__class__.__name__,
        })
    finally:
        hypotheses_duration_seconds.observe(time.monotonic() - started)
