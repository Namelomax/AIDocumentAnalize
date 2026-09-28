"""PostgreSQL gateway for the worker.

Data access only: no parsing, no completeness, no scenario logic lives here.
Row shapes are plain dataclasses rather than raw asyncpg Records so the
pipeline can be driven by hand-built fakes of the same shape in tests.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime

import asyncpg


@dataclass
class ProcessRow:
    id: str
    object_id: str
    status: str
    scenario: str | None
    pd_completeness: str | None
    rd_completeness: str | None
    id_completeness: str | None
    manifest_uploaded: bool
    input_manifest_hash: str | None
    updated_at: datetime


@dataclass
class PageLineRow:
    page_no: int
    block_no: int
    line_no: int
    text: str
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass
class FileRow:
    id: str
    object_id: str
    process_id: str | None
    file_name: str
    file_hash: str
    storage_key: str
    size_bytes: int
    mime_type: str
    doc_stage: str | None
    discipline: str | None
    document_code: str | None
    revision: str | None
    approval_status: str
    approval_date: date | datetime | None
    sheet_page_range: str | None
    predecessor_id: str | None
    signature_status: str | None
    page_count: int | None
    from_manifest: bool
    uploaded_at: datetime


def _process_row(record: asyncpg.Record) -> ProcessRow:
    return ProcessRow(
        id=record["id"],
        object_id=record["object_id"],
        status=record["status"],
        scenario=record["scenario"],
        pd_completeness=record["pd_completeness"],
        rd_completeness=record["rd_completeness"],
        id_completeness=record["id_completeness"],
        manifest_uploaded=record["manifest_uploaded"],
        input_manifest_hash=record["input_manifest_hash"],
        updated_at=record["updated_at"],
    )


def _page_line_row(record: asyncpg.Record) -> PageLineRow:
    return PageLineRow(
        page_no=record["page_no"],
        block_no=record["block_no"],
        line_no=record["line_no"],
        text=record["text"],
        x0=record["x0"],
        y0=record["y0"],
        x1=record["x1"],
        y1=record["y1"],
    )


def _file_row(record: asyncpg.Record) -> FileRow:
    return FileRow(
        id=record["id"],
        object_id=record["object_id"],
        process_id=record["process_id"],
        file_name=record["file_name"],
        file_hash=record["file_hash"],
        storage_key=record["storage_key"],
        size_bytes=record["size_bytes"],
        mime_type=record["mime_type"],
        doc_stage=record["doc_stage"],
        discipline=record["discipline"],
        document_code=record["document_code"],
        revision=record["revision"],
        approval_status=record["approval_status"],
        approval_date=record["approval_date"],
        sheet_page_range=record["sheet_page_range"],
        predecessor_id=record["predecessor_id"],
        signature_status=record["signature_status"],
        page_count=record["page_count"],
        from_manifest=record["from_manifest"],
        uploaded_at=record["uploaded_at"],
    )


class Database:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    @classmethod
    async def connect(cls, database_url: str) -> "Database":
        pool = await asyncpg.create_pool(database_url)
        return cls(pool)

    async def close(self) -> None:
        await self._pool.close()

    async def get_process(self, process_id: str) -> ProcessRow | None:
        record = await self._pool.fetchrow(
            """
            SELECT id, object_id, status, scenario, pd_completeness,
                   rd_completeness, id_completeness, manifest_uploaded,
                   input_manifest_hash, updated_at
            FROM processes
            WHERE id = $1
            """,
            process_id,
        )
        return _process_row(record) if record is not None else None

    async def get_files(self, process_id: str) -> list[FileRow]:
        records = await self._pool.fetch(
            """
            SELECT id, object_id, process_id, file_name, file_hash,
                   storage_key, size_bytes, mime_type, doc_stage, discipline,
                   document_code, revision, approval_status, approval_date,
                   sheet_page_range, predecessor_id, signature_status,
                   page_count, from_manifest, uploaded_at
            FROM files
            WHERE process_id = $1
            """,
            process_id,
        )
        return [_file_row(record) for record in records]

    async def update_file_metadata(
        self,
        file_id: str,
        *,
        doc_stage: str | None,
        discipline: str | None,
        document_code: str | None,
        revision: str | None,
        approval_status: str,
        approval_date: date | None,
        sheet_page_range: str | None,
        predecessor_id: str | None,
        signature_status: str | None,
    ) -> None:
        await self._pool.execute(
            """
            UPDATE files
            SET doc_stage = $2::"DocStage",
                discipline = $3,
                document_code = $4,
                revision = $5,
                approval_status = $6::"ApprovalStatus",
                approval_date = $7,
                sheet_page_range = $8,
                predecessor_id = $9,
                signature_status = $10,
                from_manifest = true
            WHERE id = $1
            """,
            file_id,
            doc_stage,
            discipline,
            document_code,
            revision,
            approval_status,
            approval_date,
            sheet_page_range,
            predecessor_id,
            signature_status,
        )

    async def save_processing_result(
        self,
        process_id: str,
        *,
        pd_completeness: str,
        rd_completeness: str,
        id_completeness: str,
        scenario: str | None,
        status: str,
    ) -> None:
        await self._pool.execute(
            """
            UPDATE processes
            SET pd_completeness = $2::"StageCompleteness",
                rd_completeness = $3::"StageCompleteness",
                id_completeness = $4::"StageCompleteness",
                scenario = $5::"LoadScenario",
                status = $6::"ProcessStatus",
                updated_at = now()
            WHERE id = $1
            """,
            process_id,
            pd_completeness,
            rd_completeness,
            id_completeness,
            scenario,
            status,
        )

    async def save_pages(self, file_id: str, pages: list[dict]) -> None:
        """Replace the pages recorded for a file.

        A re-run must not double the rows: the delete cascades to text_blocks,
        so the file ends up with exactly one set of pages whatever happened
        before.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM pages WHERE file_id = $1", file_id)
                for page in pages:
                    page_id = str(uuid.uuid4())
                    await connection.execute(
                        """
                        INSERT INTO pages (id, file_id, page_no, width_pt, height_pt,
                                           rotation, char_count, needs_ocr, image_key)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        """,
                        page_id, file_id, page["page_no"], page["width_pt"],
                        page["height_pt"], page["rotation"], page["char_count"],
                        page["needs_ocr"], page.get("image_key"),
                    )
                    if not page["blocks"]:
                        continue
                    await connection.executemany(
                        """
                        INSERT INTO text_blocks (id, page_id, block_no, line_no, text, x0, y0, x1, y1)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        """,
                        [
                            (str(uuid.uuid4()), page_id, b["block_no"], b["line_no"], b["text"],
                             b["x0"], b["y0"], b["x1"], b["y1"])
                            for b in page["blocks"]
                        ],
                    )

    async def get_page_lines(self, file_id: str) -> list[PageLineRow]:
        """Every text line of a file's pages, in reading order.

        The explication comparator (app.explication.parse) rebuilds its own
        block/line shape out of this flat list, so the order it is read back
        in - page, then block, then line - is part of the contract, not an
        incidental default.
        """
        records = await self._pool.fetch(
            """
            SELECT p.page_no, tb.block_no, tb.line_no, tb.text,
                   tb.x0, tb.y0, tb.x1, tb.y1
            FROM pages p
            JOIN text_blocks tb ON tb.page_id = p.id
            WHERE p.file_id = $1
            ORDER BY p.page_no, tb.block_no, tb.line_no
            """,
            file_id,
        )
        return [_page_line_row(record) for record in records]

    async def save_checks(self, process_id: str, object_id: str, checks: list[dict]) -> None:
        """Replace every check recorded for a process with a fresh set.

        A re-run must not accumulate stale findings alongside new ones: the
        delete cascades to evidence_fragments, so the process ends up with
        exactly one set of checks whatever was there before - the same
        replace-in-one-transaction shape as save_pages uses for a file.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM checks WHERE process_id = $1", process_id)
                for check in checks:
                    check_id = str(uuid.uuid4())
                    await connection.execute(
                        """
                        INSERT INTO checks (
                            id, process_id, object_id, param_id, param_code,
                            evidence_group_id, subject, expected_value, actual_value,
                            delta, completeness_status, finding_status, review_priority,
                            rationale, matrix_version, detection_method, confidence
                        )
                        VALUES (
                            $1, $2, $3, (SELECT id FROM params WHERE code = $4), $4,
                            $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                        )
                        """,
                        check_id,
                        process_id,
                        object_id,
                        check["param_code"],
                        check["evidence_group_id"],
                        check.get("subject"),
                        check.get("expected_value"),
                        check.get("actual_value"),
                        check.get("delta"),
                        check["completeness_status"],
                        check.get("finding_status"),
                        check["review_priority"],
                        check.get("rationale"),
                        check["matrix_version"],
                        # Free-search hypotheses only (section 9.5): how the
                        # model found this and how sure it was. Null for
                        # every matrix check - (SELECT id FROM params …)
                        # above is null for SEM-ROOM-FN the same way, since
                        # it is not a matrix parameter either.
                        check.get("detection_method"),
                        check.get("confidence"),
                    )

                    fragments = check.get("fragments") or []
                    if not fragments:
                        continue
                    await connection.executemany(
                        """
                        INSERT INTO evidence_fragments (
                            id, check_id, evidence_group_id, file_id, file_sha256,
                            stage, document_code, revision, approval_status,
                            sheet_page, x0, y0, x1, y1, extracted_value, role
                        )
                        VALUES (
                            $1, $2, $3, $4, $5, $6::"DocStage", $7, $8,
                            $9::"ApprovalStatus", $10, $11, $12, $13, $14, $15, $16
                        )
                        """,
                        [
                            (
                                str(uuid.uuid4()), check_id, check["evidence_group_id"],
                                fragment["file_id"], fragment["file_sha256"], fragment["stage"],
                                fragment.get("document_code"), fragment.get("revision"),
                                fragment["approval_status"], fragment["sheet_page"],
                                fragment["x0"], fragment["y0"], fragment["x1"], fragment["y1"],
                                fragment.get("extracted_value"), fragment["role"],
                            )
                            for fragment in fragments
                        ],
                    )

    async def create_protocol(
        self,
        process_id: str,
        object_id: str,
        matrix_version: str,
        model_version: str,
        dataset_version: str,
        input_manifest_hash: str,
    ) -> int:
        """Add the next protocol version of the object.

        Versions count per object, not per process: section 9.2 keeps the
        previous version in the history when a package is reprocessed, and the
        inspector reads them as successive versions of one object's protocol.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                # Serialises concurrent protocol creation for one object, so
                # two finishing processes cannot both take the same version.
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", object_id
                )
                version = await connection.fetchval(
                    "SELECT COALESCE(MAX(version), 0) + 1 FROM protocols WHERE object_id = $1",
                    object_id,
                )
                await connection.execute(
                    """
                    INSERT INTO protocols (id, object_id, process_id, version, matrix_version,
                                           model_version, dataset_version, input_manifest_hash, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY')
                    """,
                    str(uuid.uuid4()), object_id, process_id, version, matrix_version,
                    model_version, dataset_version, input_manifest_hash,
                )
                return version

    async def seed_params(self, matrix) -> int:
        """Insert the parameters the table does not have yet.

        Existing rows are left alone on purpose: after the first start the
        database is the source of truth, and section 7 (module 8) lets an
        administrator change thresholds there without a redeploy. Overwriting
        from the spec files on every start would silently undo that.
        """
        inserted = 0
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                for spec in matrix.params:
                    status = await connection.execute(
                        """
                        INSERT INTO params (
                            code, section, parameter_name, unit, source_pd, source_rd,
                            source_id, trigger_logic, review_priority, sp_reference,
                            gost_reference, fz_reference, other_normative, data_type,
                            min_value, max_value, regex_pattern, modality, compare_op,
                            compare_threshold, implemented, matrix_version, updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                                $14, $15, $16, $17, $18, $19, $20, $21, $22, now())
                        ON CONFLICT (code) DO NOTHING
                        """,
                        spec.code, spec.section, spec.parameter_name, spec.unit,
                        spec.source_pd, spec.source_rd, spec.source_id, spec.trigger_logic,
                        spec.review_priority, spec.sp_reference, spec.gost_reference,
                        spec.fz_reference, spec.other_normative, spec.data_type,
                        spec.min_value, spec.max_value, spec.regex_pattern, spec.modality,
                        spec.compare_op, spec.compare_threshold, spec.implemented,
                        matrix.version,
                    )
                    # asyncpg reports "INSERT 0 1" for a new row, "INSERT 0 0" for a skip.
                    if status.endswith(" 1"):
                        inserted += 1
        return inserted
