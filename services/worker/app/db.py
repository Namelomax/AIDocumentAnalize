"""PostgreSQL gateway for the worker.

Data access only: no parsing, no completeness, no scenario logic lives here.
Row shapes are plain dataclasses rather than raw asyncpg Records so the
pipeline can be driven by hand-built fakes of the same shape in tests.
"""

import json
import uuid
from dataclasses import dataclass
from datetime import date, datetime

import asyncpg

from app.incremental import MergePlan


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
    # Who started this process (services/api's /processes/:id/start route),
    # null for a process started before this column existed. READY's own
    # notification (customer's ТЗ p.19) goes to this user; with no owner
    # recorded, notify_process_owner falls back to every INSPECTOR instead of
    # guessing who to tell.
    started_by: str | None = None


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
        started_by=record["started_by"],
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


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


# The shape services/api/src/routes/protocols.ts's SnapshotCheck/
# SnapshotFragment expect inside protocols.snapshot - camelCase, matching
# the Prisma field names the API's own view-building code
# (protocol/view.ts's buildFinding et al.) already reads, not the snake_case
# `checks`/`evidence_fragments` columns these two read from. Kept next to the
# other _*_row helpers even though they build dicts, not dataclasses: same
# job, turning a raw asyncpg.Record into the one shape a caller actually
# wants.
def _snapshot_fragment(record: asyncpg.Record) -> dict:
    return {
        "id": record["id"], "fileId": record["file_id"], "fileSha256": record["file_sha256"],
        "stage": record["stage"], "documentCode": record["document_code"], "revision": record["revision"],
        "approvalStatus": record["approval_status"], "sheetPage": record["sheet_page"],
        "x0": record["x0"], "y0": record["y0"], "x1": record["x1"], "y1": record["y1"],
        "extractedValue": record["extracted_value"], "role": record["role"],
    }


def _snapshot_check(record: asyncpg.Record, fragments: list[dict]) -> dict:
    return {
        "id": record["id"], "processId": record["process_id"], "objectId": record["object_id"],
        "paramId": record["param_id"], "paramCode": record["param_code"],
        "evidenceGroupId": record["evidence_group_id"], "subject": record["subject"],
        "expectedValue": record["expected_value"], "actualValue": record["actual_value"],
        "delta": record["delta"], "completenessStatus": record["completeness_status"],
        "findingStatus": record["finding_status"], "reviewPriority": record["review_priority"],
        "rationale": record["rationale"], "matrixVersion": record["matrix_version"],
        "createdAt": _iso(record["created_at"]), "engineStatus": record["engine_status"],
        "verifiedBy": record["verified_by"], "verifiedAt": _iso(record["verified_at"]),
        "verdictReasonCode": record["verdict_reason_code"], "verdictComment": record["verdict_comment"],
        "authoritativeFileId": record["authoritative_file_id"], "detectionMethod": record["detection_method"],
        "confidence": record["confidence"], "parentCheckId": record["parent_check_id"],
        "splitBy": record["split_by"], "splitAt": _iso(record["split_at"]),
        "fragments": fragments,
    }


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
                   input_manifest_hash, updated_at, started_by
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

    async def mark_process_failed(self, process_id: str, error_message: str) -> None:
        """The whole-task retry (app.pipeline.process_start) exhausted every
        attempt: the process is moved to FAILED with a short reason, instead
        of staying in PARSING forever with nothing left to drive it out.
        """
        await self._pool.execute(
            """
            UPDATE processes
            SET status = 'FAILED'::"ProcessStatus",
                error_message = $2,
                updated_at = now()
            WHERE id = $1
            """,
            process_id,
            error_message,
        )

    async def record_file_processing_error(self, file_id: str, error_message: str) -> None:
        """One file's extraction failed after every retry (customer's ТЗ,
        "Обработка ошибок при загрузке"). The rest of the package keeps
        going - this only marks the one file that could not be read.
        """
        await self._pool.execute(
            "UPDATE files SET processing_error = $2 WHERE id = $1",
            file_id,
            error_message,
        )

    async def _insert_notifications(
        self, connection, user_ids: list[str], kind: str, title: str, body: str,
        process_id: str | None, object_id: str | None,
    ) -> None:
        # Role-targeted notifications fan out to one row per user at creation
        # time - simplest shape for the API to read a per-user list and
        # unread count from later.
        if not user_ids:
            return
        await connection.executemany(
            """
            INSERT INTO notifications (id, user_id, kind, title, body, process_id, object_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            [
                (str(uuid.uuid4()), user_id, kind, title, body, process_id, object_id)
                for user_id in user_ids
            ],
        )

    async def notify_admins(
        self, kind: str, title: str, body: str,
        *, process_id: str | None = None, object_id: str | None = None,
    ) -> None:
        """A processing failure an administrator needs to act on (customer's
        ТЗ p.17: "При неудаче - уведомление администратора"), never routed
        through a role no one is watching.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                admins = await connection.fetch("SELECT id FROM users WHERE role = 'ADMIN'")
                await self._insert_notifications(
                    connection, [row["id"] for row in admins], kind, title, body, process_id, object_id,
                )

    async def notify_process_owner(self, process: ProcessRow, kind: str, title: str, body: str) -> None:
        """The protocol reached READY (customer's ТЗ p.19: "Инспектор
        получает уведомление о готовности протокола") - notify whoever
        started this process. With no owner recorded (started_by is null,
        e.g. a process started before this column existed), every INSPECTOR
        is notified instead of guessing which one to tell.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                if process.started_by:
                    user_ids = [process.started_by]
                else:
                    inspectors = await connection.fetch("SELECT id FROM users WHERE role = 'INSPECTOR'")
                    user_ids = [row["id"] for row in inspectors]
                await self._insert_notifications(
                    connection, user_ids, kind, title, body, process.id, process.object_id,
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

    async def _insert_check(self, connection, process_id: str, object_id: str,
                             check: dict, parent_check_id: str | None) -> str:
        """One row of `checks` (plus its evidence_fragments), atomic or a
        composite's own row - the two only differ in whether
        `parent_check_id` is set. Returns the new row's id, so a composite's
        atoms (see save_checks) can be inserted under it.
        """
        check_id = str(uuid.uuid4())
        await connection.execute(
            """
            INSERT INTO checks (
                id, process_id, object_id, param_id, param_code,
                evidence_group_id, subject, expected_value, actual_value,
                delta, completeness_status, finding_status, review_priority,
                rationale, matrix_version, detection_method, confidence,
                parent_check_id
            )
            VALUES (
                $1, $2, $3, (SELECT id FROM params WHERE code = $4), $4,
                $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
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
            parent_check_id,
        )

        fragments = check.get("fragments") or []
        if fragments:
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
        return check_id

    async def save_checks(self, process_id: str, object_id: str, checks: list[dict]) -> None:
        """Replace every check recorded for a process with a fresh set.

        A re-run must not accumulate stale findings alongside new ones: the
        delete cascades to evidence_fragments (and, via parent_check_id ON
        DELETE CASCADE, to any composite's atoms), so the process ends up
        with exactly one set of checks whatever was there before - the same
        replace-in-one-transaction shape as save_pages uses for a file.

        A composite candidate (app.explication.compare) carries its own
        members under `check["atoms"]`, each an ordinary check dict built
        the same way an atomic finding always was. The composite's own row
        is inserted first so its atoms can be linked to it by id; an atom
        stays invisible to the inspector (services/api's visibility rule)
        until the composite is split.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM checks WHERE process_id = $1", process_id)
                for check in checks:
                    check_id = await self._insert_check(connection, process_id, object_id, check, None)
                    for atom in check.get("atoms") or []:
                        await self._insert_check(connection, process_id, object_id, atom, check_id)

    async def get_checks_for_merge(self, process_id: str) -> list[dict]:
        """Every check of a process, with its own fragments nested under it,
        as plain snake_case dicts - the shape app.incremental.build_merge_plan
        reads (composites and atoms alike; build_merge_plan is what tells
        them apart, not this query). Read-only, called before a дозагрузка's
        merge touches `checks` at all (app.pipeline._process_update_once).
        """
        async with self._pool.acquire() as connection:
            check_rows = await connection.fetch("SELECT * FROM checks WHERE process_id = $1", process_id)
            check_ids = [row["id"] for row in check_rows]
            fragment_rows = (
                await connection.fetch(
                    "SELECT * FROM evidence_fragments WHERE check_id = ANY($1::text[])", check_ids,
                )
                if check_ids else []
            )
        fragments_by_check: dict[str, list[dict]] = {}
        for fragment in fragment_rows:
            fragments_by_check.setdefault(fragment["check_id"], []).append(dict(fragment))
        return [{**dict(row), "fragments": fragments_by_check.get(row["id"], [])} for row in check_rows]

    async def apply_merge_plan(self, process_id: str, object_id: str, plan: MergePlan) -> None:
        """Execute a MergePlan (app.incremental.build_merge_plan) in one
        transaction: touch only the rows the plan actually names, instead of
        save_checks's delete-everything-and-reinsert - an untouched row
        (including any inspector decision on it) is never even sent to the
        database here.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                for check_id, rationale in plan.rationale_updates:
                    await connection.execute(
                        "UPDATE checks SET rationale = $2 WHERE id = $1", check_id, rationale,
                    )
                if plan.delete_ids:
                    await connection.execute(
                        "DELETE FROM checks WHERE id = ANY($1::text[])", plan.delete_ids,
                    )
                for check in plan.insert:
                    check_id = await self._insert_check(connection, process_id, object_id, check, None)
                    for atom in check.get("atoms") or []:
                        await self._insert_check(connection, process_id, object_id, atom, check_id)

    async def upsert_hypothesis_checks(
        self, process_id: str, object_id: str, checks: list[dict],
    ) -> int | None:
        """SEM-ROOM-FN's own write path (section 9.5's free-search
        hypotheses, app.pipeline.process_hypotheses) - one row inserted or
        replaced per evidence_group_id, never a blanket delete-and-reinsert
        the way save_checks writes the matrix (a дозагрузка's own merge,
        app.pipeline._process_update_once, never touches SEM-ROOM-FN rows at
        all - see app.pipeline._matrix_rows_for_merge).

        A row an inspector has already decided on is left exactly as it is:
        either verified_by is set (an ordinary verdict), or it was promoted
        from a hypothesis to a candidate (POST /findings/:id/promote,
        services/api's routes/verdicts.ts) - that action leaves verified_by
        null but moves finding_status off SUSPICION while engine_status
        stays SUSPICION, the same pair app.incremental's own _has_decision
        reads a verdict by, just without a verified_by to check here.

        Returns the number of SUSPICION rows actually written (inserted, or
        replacing a not-yet-decided row) - process_hypotheses reports this
        to the process owner - or None when the process's own current
        protocol has since been finalized or superseded and nothing here was
        written at all.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                protocol = await connection.fetchrow(
                    """
                    SELECT status FROM protocols
                    WHERE process_id = $1 AND status != 'SUPERSEDED'
                    ORDER BY version DESC LIMIT 1
                    """,
                    process_id,
                )
                if protocol is None or protocol["status"] == "PROTOCOL_FINALIZED":
                    return None

                added = 0
                for check in checks:
                    existing = await connection.fetchrow(
                        """
                        SELECT id, verified_by, engine_status, finding_status
                        FROM checks WHERE process_id = $1 AND evidence_group_id = $2
                        """,
                        process_id, check["evidence_group_id"],
                    )
                    if existing is not None:
                        decided = bool(existing["verified_by"]) or (
                            existing["engine_status"] == "SUSPICION"
                            and existing["finding_status"] != "SUSPICION"
                        )
                        if decided:
                            continue
                        await connection.execute("DELETE FROM checks WHERE id = $1", existing["id"])
                    await self._insert_check(connection, process_id, object_id, check, None)
                    if check.get("finding_status") == "SUSPICION":
                        added += 1
                return added

    async def get_user_names(self, user_ids: list[str]) -> dict[str, str]:
        """Names for a merge's "previous decision by X" notes
        (app.incremental._changed_note/_decision_label) - an id alone would
        read like a database dump to the inspector reading the note."""
        ids = [user_id for user_id in {*user_ids} if user_id]
        if not ids:
            return {}
        rows = await self._pool.fetch("SELECT id, full_name FROM users WHERE id = ANY($1::text[])", ids)
        return {row["id"]: row["full_name"] for row in rows}

    async def mark_files_added_in_protocol(self, file_ids: list[str], version: int) -> None:
        """Customer's ТЗ "Дозагрузка файлов": which protocol version a
        дозагрузка's own files arrived with, for the document list to badge
        them. Never called for a process's original package - those files
        have nothing incremental to show and stay null."""
        if not file_ids:
            return
        await self._pool.execute(
            "UPDATE files SET added_in_protocol_version = $2 WHERE id = ANY($1::text[])",
            file_ids, version,
        )

    async def snapshot_and_supersede_protocol(self, process_id: str) -> int | None:
        """Freeze the process's current (non-SUPERSEDED) protocol exactly as
        it stood right before a дозагрузка's merge changes `checks` - the
        same rows services/api's routes/protocols.ts would otherwise have
        read live for it (loadProtocolResponse), captured here because a
        later merge may delete or replace any of them (customer's ТЗ:
        "Предыдущая версия протокола сохраняется в истории").

        Returns the superseded version number, or None if the process has no
        protocol yet - process.update only ever reaches a process that has
        already run process.start once (services/api's routes/
        processDocuments.ts refuses a дозагрузка while PENDING), so this is
        defensive rather than an expected path.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                protocol = await connection.fetchrow(
                    """
                    SELECT id, version FROM protocols
                    WHERE process_id = $1 AND status != 'SUPERSEDED'
                    ORDER BY version DESC LIMIT 1
                    """,
                    process_id,
                )
                if protocol is None:
                    return None

                check_rows = await connection.fetch("SELECT * FROM checks WHERE process_id = $1", process_id)
                check_ids = [row["id"] for row in check_rows]
                fragment_rows = (
                    await connection.fetch(
                        "SELECT * FROM evidence_fragments WHERE check_id = ANY($1::text[])", check_ids,
                    )
                    if check_ids else []
                )
                fragments_by_check: dict[str, list[dict]] = {}
                for fragment in fragment_rows:
                    fragments_by_check.setdefault(fragment["check_id"], []).append(
                        _snapshot_fragment(fragment),
                    )
                snapshot = {
                    "checks": [
                        _snapshot_check(row, fragments_by_check.get(row["id"], []))
                        for row in check_rows
                    ],
                }
                await connection.execute(
                    "UPDATE protocols SET status = 'SUPERSEDED', snapshot = $2::jsonb WHERE id = $1",
                    protocol["id"], json.dumps(snapshot),
                )
                return protocol["version"]

    async def create_protocol(
        self,
        process_id: str,
        object_id: str,
        matrix_version: str,
        model_version: str,
        dataset_version: str,
        input_manifest_hash: str,
        *,
        # READY for a fresh run (app.pipeline._process_start_once); a
        # дозагрузка's incremental update (app.pipeline._process_update_once)
        # opens VERIFYING instead when a decision survived its merge - the
        # new version already has an undecided candidate sitting next to a
        # kept verdict, the same state a first run would never actually be
        # in but VERIFYING already means exactly (section 9.3). Defaulted so
        # every existing call site - every test fixture among them - keeps
        # working unchanged.
        status: str = "READY",
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
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    """,
                    str(uuid.uuid4()), object_id, process_id, version, matrix_version,
                    model_version, dataset_version, input_manifest_hash, status,
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
