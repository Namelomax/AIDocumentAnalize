-- Customer's ТЗ p.16, п.1 "Распознавание текста (OCR)": a page with no text
-- layer (pages.needs_ocr) is now handed to a local OCR model
-- (services/worker's app.ocr.tiling) instead of being left blank. These
-- columns let its result be told apart from the PDF's own text layer and
-- let a page the model could not read say so, instead of silently having
-- fewer lines than expected.

-- AlterTable
-- quality_status: set to 'LOW_QUALITY' when a page needed OCR and nothing
-- legible came back (model not configured, unreachable, or every strip's
-- answer was empty) - "система обязана вернуть LOW_QUALITY или ABSTAIN".
-- Null for every page whose own text layer was readable, and for a page OCR
-- did recover text for.
ALTER TABLE "pages" ADD COLUMN     "quality_status" TEXT;

-- AlterTable
-- source: 'text' for a line read from the PDF's own text layer (every row
-- that predates this column, via the default, and every one a fresh text-
-- layer extraction writes), 'ocr' for one app.ocr.tiling recovered from a
-- scanned page.
-- confidence: null for both sources today - see schema.prisma's own
-- comment on why - kept for a future OCR model that does report one.
ALTER TABLE "text_blocks" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'text';
