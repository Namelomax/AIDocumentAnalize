-- CreateTable
CREATE TABLE "integrity_runs" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "files_checked" INTEGER NOT NULL DEFAULT 0,
    "mismatches" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL,
    "triggered_by" TEXT,

    CONSTRAINT "integrity_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_failures" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "expected_hash" CHAR(64) NOT NULL,
    "actual_hash" CHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrity_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrity_runs_started_at_idx" ON "integrity_runs"("started_at");

-- CreateIndex
CREATE INDEX "integrity_failures_run_id_idx" ON "integrity_failures"("run_id");

-- AddForeignKey
ALTER TABLE "integrity_failures" ADD CONSTRAINT "integrity_failures_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "integrity_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
