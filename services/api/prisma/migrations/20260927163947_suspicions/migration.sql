-- AlterTable
ALTER TABLE "checks" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "detection_method" VARCHAR(20);

-- Section 10, table Suspicions. Hypotheses live in checks with status
-- SUSPICION, where they get evidence fragments, verdicts and a place in the
-- protocol like any finding; this view gives them the table the
-- specification names, with its field names.
CREATE VIEW "suspicions" AS
SELECT c."id",
       c."object_id",
       c."process_id",
       c."detection_method" AS "discovery_method",
       c."confidence",
       c."rationale"        AS "description",
       c."review_priority",
       c."finding_status",
       CASE WHEN c."verified_by" IS NULL THEN 'PENDING' ELSE c."finding_status" END AS "inspector_status",
       c."created_at"
FROM "checks" c
WHERE c."finding_status" = 'SUSPICION' OR c."engine_status" = 'SUSPICION';
