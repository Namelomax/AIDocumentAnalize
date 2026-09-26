"""The process.start pipeline: parse the registry, enrich file rows, compute
completeness/scenario, and log the per-stage source selection.

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
from app.pdf.extract import extract_pages
from app.pdf.render import render_page_png

logger = logging.getLogger(__name__)


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

    for stage in STAGES:
        selection = select_source_revision(metas, stage, None)
        logger.info("source selection", extra={
            "process_id": process_id,
            "stage": stage,
            "selection_status": selection.status,
            "reason": selection.reason,
            "file_id": selection.file_id,
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
