/*
  Warnings:

  - The `pd_completeness` column on the `processes` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `rd_completeness` column on the `processes` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `id_completeness` column on the `processes` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "StageCompleteness" AS ENUM ('UPLOADED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "processes" DROP COLUMN "pd_completeness",
ADD COLUMN     "pd_completeness" "StageCompleteness",
DROP COLUMN "rd_completeness",
ADD COLUMN     "rd_completeness" "StageCompleteness",
DROP COLUMN "id_completeness",
ADD COLUMN     "id_completeness" "StageCompleteness";
