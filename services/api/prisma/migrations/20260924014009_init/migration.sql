-- CreateEnum
CREATE TYPE "DocStage" AS ENUM ('PD', 'RD', 'ID');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'APPROVED', 'FOR_CONSTRUCTION', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcessStatus" AS ENUM ('PENDING', 'PARSING', 'READY', 'VERIFYING', 'COMPLETED', 'FINALIZED');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('CANDIDATE', 'CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED', 'MISSING_EVIDENCE', 'NOT_APPLICABLE', 'NOT_COMPARABLE', 'CLARIFICATION_REQUIRED', 'SUSPICION');

-- CreateEnum
CREATE TYPE "CompletenessStatus" AS ENUM ('COMPLETE', 'MISSING_EVIDENCE', 'NOT_APPLICABLE', 'NOT_COMPARABLE', 'CLARIFICATION_REQUIRED');

-- CreateEnum
CREATE TYPE "ReviewPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "LoadScenario" AS ENUM ('FULL', 'PD_RD_ONLY', 'PD_ID_ONLY', 'RD_ID_ONLY', 'SINGLE_ONLY', 'PARTIALLY_LOADED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('INSPECTOR', 'SUPERVISOR', 'ADMIN', 'ML_ENGINEER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'INSPECTOR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "objects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "customer" TEXT,
    "contractor" TEXT,
    "permit_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "process_id" TEXT,
    "file_name" TEXT NOT NULL,
    "file_hash" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "doc_stage" "DocStage",
    "discipline" TEXT,
    "document_code" TEXT,
    "revision" TEXT,
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "approval_date" TIMESTAMP(3),
    "sheet_page_range" TEXT,
    "predecessor_id" TEXT,
    "signature_status" TEXT,
    "page_count" INTEGER,
    "from_manifest" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processes" (
    "id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "status" "ProcessStatus" NOT NULL DEFAULT 'PENDING',
    "scenario" "LoadScenario",
    "pd_completeness" TEXT,
    "rd_completeness" TEXT,
    "id_completeness" TEXT,
    "manifest_uploaded" BOOLEAN NOT NULL DEFAULT false,
    "input_manifest_hash" CHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "object_id" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_login_key" ON "users"("login");

-- CreateIndex
CREATE INDEX "files_object_id_doc_stage_discipline_idx" ON "files"("object_id", "doc_stage", "discipline");

-- CreateIndex
CREATE UNIQUE INDEX "files_object_id_file_hash_key" ON "files"("object_id", "file_hash");

-- CreateIndex
CREATE INDEX "audit_log_timestamp_idx" ON "audit_log"("timestamp");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_predecessor_id_fkey" FOREIGN KEY ("predecessor_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processes" ADD CONSTRAINT "processes_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
