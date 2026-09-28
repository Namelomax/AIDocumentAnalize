-- CreateTable
CREATE TABLE "gold_labels" (
    "id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "protocol_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "process_id" TEXT NOT NULL,
    "evidence_group_id" TEXT NOT NULL,
    "param_code" VARCHAR(20) NOT NULL,
    "modality" VARCHAR(20),
    "detection_method" VARCHAR(20),
    "label" VARCHAR(10) NOT NULL,
    "engine_status" VARCHAR(30),
    "final_status" VARCHAR(30) NOT NULL,
    "reason_code" VARCHAR(30),
    "expert_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "matrix_version" VARCHAR(20) NOT NULL,
    "model_version" VARCHAR(40) NOT NULL,
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gold_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_versions" (
    "id" TEXT NOT NULL,
    "version_tag" VARCHAR(40) NOT NULL,
    "notes" TEXT,
    "manifest_hash" CHAR(64) NOT NULL,
    "label_count" INTEGER NOT NULL,
    "released_by" TEXT NOT NULL,
    "released_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_version_labels" (
    "dataset_version_id" TEXT NOT NULL,
    "gold_label_id" TEXT NOT NULL,

    CONSTRAINT "dataset_version_labels_pkey" PRIMARY KEY ("dataset_version_id","gold_label_id")
);

-- CreateTable
CREATE TABLE "quality_reports" (
    "id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "generated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gold_labels_protocol_id_check_id_key" ON "gold_labels"("protocol_id", "check_id");

-- CreateIndex
CREATE INDEX "gold_labels_object_id_idx" ON "gold_labels"("object_id");

-- CreateIndex
CREATE INDEX "gold_labels_param_code_idx" ON "gold_labels"("param_code");

-- CreateIndex
CREATE INDEX "gold_labels_label_idx" ON "gold_labels"("label");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_version_tag_key" ON "dataset_versions"("version_tag");

-- CreateIndex
CREATE INDEX "dataset_version_labels_gold_label_id_idx" ON "dataset_version_labels"("gold_label_id");

-- CreateIndex
CREATE INDEX "quality_reports_period_start_idx" ON "quality_reports"("period_start");

-- AddForeignKey
ALTER TABLE "dataset_version_labels" ADD CONSTRAINT "dataset_version_labels_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_version_labels" ADD CONSTRAINT "dataset_version_labels_gold_label_id_fkey" FOREIGN KEY ("gold_label_id") REFERENCES "gold_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Section 14.1: a positive label is admissible only for a CONFIRMED_VIOLATION
-- final status, a negative one only for NEGATIVE_VERIFIED - enforced here so
-- a bug in quality/goldLabels.ts can never write a label the ТЗ disallows.
ALTER TABLE "gold_labels" ADD CONSTRAINT "gold_label_matches_final_status"
  CHECK (("label" = 'POSITIVE' AND "final_status" = 'CONFIRMED_VIOLATION')
         OR ("label" = 'NEGATIVE' AND "final_status" = 'NEGATIVE_VERIFIED'));
