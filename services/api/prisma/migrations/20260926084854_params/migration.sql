-- CreateTable
CREATE TABLE "params" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "section" VARCHAR(50) NOT NULL,
    "parameter_name" VARCHAR(255) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "source_pd" TEXT,
    "source_rd" TEXT,
    "source_id" TEXT,
    "trigger_logic" TEXT,
    "review_priority" VARCHAR(20) NOT NULL,
    "sp_reference" TEXT,
    "gost_reference" TEXT,
    "fz_reference" TEXT,
    "other_normative" TEXT,
    "data_type" VARCHAR(20) NOT NULL,
    "min_value" DOUBLE PRECISION,
    "max_value" DOUBLE PRECISION,
    "regex_pattern" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "modality" VARCHAR(20) NOT NULL,
    "compare_op" VARCHAR(30),
    "compare_threshold" DOUBLE PRECISION,
    "implemented" BOOLEAN NOT NULL DEFAULT false,
    "matrix_version" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "params_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "params_code_key" ON "params"("code");

-- CreateIndex
CREATE INDEX "params_section_idx" ON "params"("section");
