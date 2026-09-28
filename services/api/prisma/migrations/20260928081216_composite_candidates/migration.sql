-- Composite candidates (worker's app.explication.compare module docstring):
-- a run of >= 2 consecutive changed rooms in one explication table is
-- recorded as ONE candidate check with its members nested under it, so an
-- inspector cannot confirm or reject part of a run without splitting it
-- first (POST /api/v1/findings/:id/split). parent_check_id links an atom to
-- the composite it was split out of; split_by/split_at record who split the
-- composite, and when. Cascades with the composite, same as every other
-- check-owned row (evidence_fragments, rejection_log).
ALTER TABLE "checks" ADD COLUMN     "parent_check_id" TEXT,
ADD COLUMN     "split_at" TIMESTAMP(3),
ADD COLUMN     "split_by" TEXT;

-- CreateIndex
CREATE INDEX "checks_parent_check_id_idx" ON "checks"("parent_check_id");

-- AddForeignKey
ALTER TABLE "checks" ADD CONSTRAINT "checks_parent_check_id_fkey" FOREIGN KEY ("parent_check_id") REFERENCES "checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The worker only ever nests one level: a composite's own atoms never carry
-- a parent_check_id of their own, and an atom is never itself split (there
-- is nothing further beneath it to split into). Enforced here so a bug
-- cannot silently build a chain the visibility rule (services/api) was never
-- designed to read.
ALTER TABLE "checks" ADD CONSTRAINT "split_only_on_a_composite"
  CHECK ("parent_check_id" IS NULL OR "split_at" IS NULL);
