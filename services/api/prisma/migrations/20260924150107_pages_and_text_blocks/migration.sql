-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "page_no" INTEGER NOT NULL,
    "width_pt" DOUBLE PRECISION NOT NULL,
    "height_pt" DOUBLE PRECISION NOT NULL,
    "rotation" INTEGER NOT NULL,
    "char_count" INTEGER NOT NULL,
    "needs_ocr" BOOLEAN NOT NULL DEFAULT false,
    "image_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "text_blocks" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "block_no" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "x0" DOUBLE PRECISION NOT NULL,
    "y0" DOUBLE PRECISION NOT NULL,
    "x1" DOUBLE PRECISION NOT NULL,
    "y1" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "text_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pages_file_id_page_no_key" ON "pages"("file_id", "page_no");

-- CreateIndex
CREATE INDEX "text_blocks_page_id_idx" ON "text_blocks"("page_id");

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_blocks" ADD CONSTRAINT "text_blocks_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
