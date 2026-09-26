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
                        INSERT INTO text_blocks (id, page_id, block_no, text, x0, y0, x1, y1)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        """,
                        [
                            (str(uuid.uuid4()), page_id, b["block_no"], b["text"],
                             b["x0"], b["y0"], b["x1"], b["y1"])
                            for b in page["blocks"]
                        ],
                    )

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
