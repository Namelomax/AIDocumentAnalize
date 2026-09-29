"""Build real design/working documentation pairs out of the reference markup.

The markup file carries genuine sheets of the pilot objects. Cut into
separate PDFs with a registry, they are the closest thing to a real package
this repository has.

Usage: python make_reference_package.py <out_dir> <object_id>
"""

import csv
import sys
from pathlib import Path

import pymupdf

SOURCE = Path(__file__).resolve().parents[2] / ".e2e-tmp" / "Задание" / "Комплект_предметной_разметки.pdf"

# (file name, source page, stage, discipline, code)
SHEETS = [
    ("sosh-pd.pdf", 19, "PD", "АР", "SOSH25-000214"),
    ("sosh-rd.pdf", 20, "RD", "АР", "SOSH25-000252"),
    ("pol17-pd.pdf", 21, "PD", "АР", "POL17-000031"),
    ("pol17-rd.pdf", 22, "RD", "АР", "POL17-000096"),
]


def main() -> None:
    out_dir, object_id = Path(sys.argv[1]), sys.argv[2]
    out_dir.mkdir(parents=True, exist_ok=True)
    source = pymupdf.open(SOURCE)
    for name, page_no, *_ in SHEETS:
        target = pymupdf.open()
        target.insert_pdf(source, from_page=page_no - 1, to_page=page_no - 1)
        target.save(out_dir / name)
        target.close()

    with open(out_dir / "reestr.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["object_id", "file_name", "doc_stage", "discipline",
                         "document_code", "revision", "approval_status"])
        for name, _, stage, discipline, code in SHEETS:
            writer.writerow([object_id, name, stage, discipline, code, "1",
                             "APPROVED" if stage == "PD" else "FOR_CONSTRUCTION"])


if __name__ == "__main__":
    main()
