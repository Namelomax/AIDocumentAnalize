"""Turn one region of a real reference sheet into an image-only, one-page
PDF - a "scan" with no text layer at all, the input app.pdf.extract's own
needs_ocr flag exists for.

Cropped to the room explication table that carries room 1.109 (Полярная 25
школа, РД лист, "sosh-rd.pdf" in tests/e2e/make_reference_package.py) rather
than rasterizing that sheet's full ~3370x2384pt canvas: that sheet is a huge
CAD title-block drawing where legible text is a small fraction of a mostly
graphical page (services/worker/docs/quality/ocr-eval.json measures the real,
honest cost of OCR-ing a whole sheet like that) - tests/e2e/test_ocr_flow.sh
exists to prove the OCR pipeline is wired correctly end to end, not to
re-run that benchmark, so it works from a crop small enough to OCR in the
time an e2e script can reasonably spend polling.

Usage: python make_scanned_page.py <out.pdf>
"""

import sys
from pathlib import Path

import pymupdf

SOURCE = Path(__file__).resolve().parents[2] / ".e2e-tmp" / "Задание" / "Комплект_предметной_разметки.pdf"
SOURCE_PAGE_NO = 20  # sosh-rd.pdf's own source page (make_reference_package.py's SHEETS)
# Point-space crop (this page's own coordinates) around the "Экспликация
# помещений" table that carries room 1.109 - found by inspecting
# page.get_text("dict") for the text block reading "1.109".
CROP = (1600, 2100, 1995, 2330)
DPI = 300


def main() -> None:
    out_path = Path(sys.argv[1])
    source = pymupdf.open(SOURCE)
    page = source[SOURCE_PAGE_NO - 1]
    clip = pymupdf.Rect(*CROP)
    pixmap = page.get_pixmap(dpi=DPI, clip=clip)
    png = pixmap.tobytes("png")

    target = pymupdf.open()
    # Page sized in points to match the crop 1:1 (not the pixmap's own pixel
    # size) - insert_image below then places the raster at the page's own
    # native scale, the same relationship a real scan's page size has to its
    # own image.
    new_page = target.new_page(width=clip.width, height=clip.height)
    new_page.insert_image(new_page.rect, stream=png)
    target.save(out_path)
    target.close()
    source.close()


if __name__ == "__main__":
    main()
