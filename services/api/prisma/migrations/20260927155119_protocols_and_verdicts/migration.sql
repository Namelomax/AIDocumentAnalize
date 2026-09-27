-- AlterTable
ALTER TABLE "checks" ADD COLUMN     "authoritative_file_id" TEXT,
ADD COLUMN     "engine_status" VARCHAR(30),
ADD COLUMN     "verdict_comment" TEXT,
ADD COLUMN     "verdict_reason_code" VARCHAR(30),
ADD COLUMN     "verified_at" TIMESTAMP(3),
ADD COLUMN     "verified_by" TEXT;

-- CreateTable
CREATE TABLE "protocols" (
    "id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "process_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "matrix_version" VARCHAR(20) NOT NULL,
    "dataset_version" VARCHAR(40) NOT NULL,
    "model_version" VARCHAR(40) NOT NULL,
    "input_manifest_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "sync_status" VARCHAR(20),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMP(3),
    "finalized_by" TEXT,

    CONSTRAINT "protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rejection_log" (
    "id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "rejection_reason" VARCHAR(30) NOT NULL,
    "ai_verdict" VARCHAR(30) NOT NULL,
    "comment" TEXT NOT NULL,
    "retraining_status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rejection_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "protocols_process_id_idx" ON "protocols"("process_id");

-- CreateIndex
CREATE UNIQUE INDEX "protocols_object_id_version_key" ON "protocols"("object_id", "version");

-- CreateIndex
CREATE INDEX "rejection_log_check_id_idx" ON "rejection_log"("check_id");

-- AddForeignKey
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_log" ADD CONSTRAINT "rejection_log_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Section 9.2: only an inspector confirms a violation. Enforced by the
-- database so that no worker, script or hurried fix can write one.
ALTER TABLE "checks" ADD CONSTRAINT "confirmed_requires_inspector"
  CHECK ("finding_status" <> 'CONFIRMED_VIOLATION' OR "verified_by" IS NOT NULL);

-- Section 9.3: an inspector's rejection carries a coded reason and a comment.
ALTER TABLE "checks" ADD CONSTRAINT "rejection_requires_reason"
  CHECK ("verified_by" IS NULL OR "finding_status" <> 'NEGATIVE_VERIFIED'
         OR ("verdict_reason_code" IS NOT NULL AND "verdict_comment" IS NOT NULL));
