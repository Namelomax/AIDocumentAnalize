-- Customer's ТЗ p.17, "Обработка ошибок при загрузке": "Таймаут при
-- обработке файла -> Повторная попытка обработки (до 2 раз). При неудаче -
-- уведомление администратора." A process.start task that still fails after
-- its own retries (services/worker/app/pipeline.py) needs a status of its
-- own instead of staying in PARSING forever with nothing to drive it out.
-- Not referenced anywhere else in this file, so this is safe inside the one
-- transaction `prisma migrate deploy` runs the file in (PostgreSQL forbids
-- only *using* a value added this way in the same transaction, not adding it).
ALTER TYPE "ProcessStatus" ADD VALUE 'FAILED';

-- AlterTable
-- One file's own extraction failure, recorded after every retry; the rest of
-- the package still finishes (see services/worker's _extract_document_pages).
ALTER TABLE "files" ADD COLUMN     "processing_error" TEXT;

-- AlterTable
-- started_by: who started this process (set by POST /processes/:id/start
-- from the auth context) - the READY notification (p.19: "Инспектор
-- получает уведомление о готовности протокола") goes to this user, falling
-- back to every INSPECTOR when it is null.
-- error_message: a short reason recorded when the process ends FAILED.
ALTER TABLE "processes" ADD COLUMN     "error_message" TEXT,
ADD COLUMN     "started_by" TEXT;

-- CreateTable
-- In-app notifications. A role-targeted notification (every ADMIN, or every
-- INSPECTOR when a process has no recorded owner) fans out to one row per
-- user at creation time - the simplest shape for GET /notifications to read
-- a per-user list and unread count from. process_id/object_id are plain ids,
-- not foreign keys, the same way audit_log.object_id already is: a
-- notification must survive whatever the process or object it refers to
-- does later, including deletion.
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "process_id" TEXT,
    "object_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
