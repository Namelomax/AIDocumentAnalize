-- gold_labels.check_id is a real FK (onDelete: Cascade), the same convention
-- rejection_log's own check_id follows - so deleting a check (in practice
-- only ever via its process cascading away, e.g. test cleanup) removes any
-- GOLD label built from it rather than leaving an orphan row behind.
ALTER TABLE "gold_labels" ADD CONSTRAINT "gold_labels_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
