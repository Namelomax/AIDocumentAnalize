-- Customer's ТЗ "Дозагрузка файлов" / "Инкрементальное обновление при
-- дозагрузке": a дозагрузка no longer deletes and re-inserts every check of
-- a process - it merges by evidence_group_id (services/worker's
-- app.db.Database.merge_checks) and freezes the protocol version it
-- replaces instead of overwriting it, so the earlier version stays in the
-- history exactly as the inspector last saw it.

-- AlterTable
-- snapshot: a frozen copy of the protocol view (completeness, findings with
-- their verdicts, suspicions) at the moment a дозагрузка superseded this
-- version. Null for every protocol that was never superseded - which is
-- every one that predates this column, and every version that is still the
-- current one for its process.
-- Protocol.status stays a plain varchar (no enum here, see schema.prisma):
-- SUPERSEDED is simply a new value it can hold, alongside READY, VERIFYING,
-- VERIFICATION_COMPLETED and PROTOCOL_FINALIZED.
ALTER TABLE "protocols" ADD COLUMN     "snapshot" JSONB;

-- AlterTable
-- added_in_protocol_version: which protocol version this file arrived with,
-- so the document list can badge a file that came in through a дозагрузка.
-- Null for a file that was part of the process's original package.
ALTER TABLE "files" ADD COLUMN     "added_in_protocol_version" INTEGER;
