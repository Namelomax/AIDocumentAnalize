-- CreateTable
CREATE TABLE "checks" (
    "id" TEXT NOT NULL,
    "process_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "param_id" INTEGER,
    "param_code" VARCHAR(20) NOT NULL,
    "evidence_group_id" TEXT NOT NULL,
    "subject" TEXT,
    "expected_value" TEXT,
    "actual_value" TEXT,
    "delta" TEXT,
    "completeness_status" VARCHAR(30) NOT NULL,
    "finding_status" VARCHAR(30),
    "review_priority" VARCHAR(20) NOT NULL,
    "rationale" TEXT,
    "matrix_version" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_fragments" (
    "id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "evidence_group_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "stage" "DocStage" NOT NULL,
    "document_code" TEXT,
    "revision" TEXT,
    "approval_status" "ApprovalStatus" NOT NULL,
    "sheet_page" INTEGER NOT NULL,
    "x0" DOUBLE PRECISION NOT NULL,
    "y0" DOUBLE PRECISION NOT NULL,
    "x1" DOUBLE PRECISION NOT NULL,
    "y1" DOUBLE PRECISION NOT NULL,
    "extracted_value" TEXT,
    "role" VARCHAR(10) NOT NULL,

    CONSTRAINT "evidence_fragments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checks_process_id_finding_status_idx" ON "checks"("process_id", "finding_status");

-- CreateIndex
CREATE UNIQUE INDEX "checks_process_id_evidence_group_id_key" ON "checks"("process_id", "evidence_group_id");

-- CreateIndex
CREATE INDEX "evidence_fragments_check_id_idx" ON "evidence_fragments"("check_id");

-- AddForeignKey
ALTER TABLE "checks" ADD CONSTRAINT "checks_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_fragments" ADD CONSTRAINT "evidence_fragments_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_fragments" ADD CONSTRAINT "evidence_fragments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
