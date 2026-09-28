"""Build a synthetic PD/RD package with a real ТЭП table for the matrix
parameters app.params.scalar now answers.

The reference package (tests/e2e/make_reference_package.py) has no ТЭП
table at all - it only ever exercises M-003's room-explication comparison.
This generator plants a small, known set of differences in a two-column
"наименование | значение" table (drawn as separate text boxes on the same
horizontal, the way a real CAD export's cells land in separate PyMuPDF
blocks - see _row below and app.explication.parse's own module docstring
for the same shape), plus a small спецификация окон table, and writes the
ground truth alongside the PDFs so tests/e2e/test_params_flow.sh can assert
against it without repeating the plan here.

Usage: python make_params_package.py <out_dir> <object_id>
"""

import csv
import json
import sys
from pathlib import Path

import pymupdf

# (code, label, PD value, RD value) - None means "not present on this side".
# See this module's own docstring for what each row is planted to prove.
ROWS = [
    ("M-001", "Площадь застройки, м²", "1520,4", "1580,0"),         # CANDIDATE: real change
    ("M-002", "Общая площадь здания, м²", "4521,3", "4521,4"),      # NEGATIVE_VERIFIED: rounding
    ("M-007", "Этажность, эт.", "9", "10"),                          # CANDIDATE: real change
    ("M-008", "Высота здания, м", "27,3", None),                     # MISSING_EVIDENCE: PD only
    ("M-022", "Степень огнестойкости", "II", "III"),                 # CANDIDATE: enum change
    ("M-104", "Ширина и высота эвакуационных проходов, м", None, "1,1"),  # CANDIDATE: value_lt 1.2
]

# Спецификация окон: an unchanged value, on both sides - proof the locator
# also works off a second, differently-captioned table on the same page.
WINDOW_ROWS = [
    ("M-127", "Коэффициент сопротивления теплопередаче окон (Ro)", "0,70", "0,70"),  # NEGATIVE_VERIFIED
]

GROUND_TRUTH = {
    "M-001": "CANDIDATE",
    "M-002": "NEGATIVE_VERIFIED",
    "M-007": "CANDIDATE",
    "M-008": "MISSING_EVIDENCE",
    "M-022": "CANDIDATE",
    "M-104": "CANDIDATE",
    "M-127": "NEGATIVE_VERIFIED",
}


def _row(page: pymupdf.Page, y: float, label: str, value: str | None) -> None:
    page.insert_htmlbox(pymupdf.Rect(20, y, 340, y + 22), label, css="* {font-size:13px;}")
    if value is not None:
        page.insert_htmlbox(pymupdf.Rect(360, y, 460, y + 22), value, css="* {font-size:13px;}")


def _build_pd(rows) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=550, height=700)
    page.insert_htmlbox(pymupdf.Rect(20, 20, 500, 44), "Раздел ПЗ: Таблица ТЭП",
                         css="* {font-size:16px; font-weight:bold;}")
    y = 60
    for _code, label, pd_value, _rd_value in rows:
        if pd_value is not None:
            _row(page, y, label, pd_value)
            y += 26

    page.insert_htmlbox(pymupdf.Rect(20, y + 20, 500, y + 44), "Спецификация окон (АР)",
                         css="* {font-size:14px; font-weight:bold;}")
    y += 46
    for _code, label, pd_value, _rd_value in WINDOW_ROWS:
        _row(page, y, label, pd_value)
        y += 26

    raw = document.tobytes()
    document.close()
    return raw


def _build_rd(rows) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=550, height=700)
    page.insert_htmlbox(pymupdf.Rect(20, 20, 500, 44), 'Раздел ПП (ГП): Лист "Общие данные", Таблица ТЭП',
                         css="* {font-size:16px; font-weight:bold;}")
    y = 60
    for _code, label, _pd_value, rd_value in rows:
        if rd_value is not None:
            _row(page, y, label, rd_value)
            y += 26

    page.insert_htmlbox(pymupdf.Rect(20, y + 20, 500, y + 44), "Спецификация окон (АР)",
                         css="* {font-size:14px; font-weight:bold;}")
    y += 46
    for _code, label, _pd_value, rd_value in WINDOW_ROWS:
        _row(page, y, label, rd_value)
        y += 26

    raw = document.tobytes()
    document.close()
    return raw


def main() -> None:
    out_dir, object_id = Path(sys.argv[1]), sys.argv[2]
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "params-pd.pdf").write_bytes(_build_pd(ROWS))
    (out_dir / "params-rd.pdf").write_bytes(_build_rd(ROWS))

    with open(out_dir / "reestr.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["object_id", "file_name", "doc_stage", "discipline",
                          "document_code", "revision", "approval_status"])
        writer.writerow([object_id, "params-pd.pdf", "PD", "ПЗ", "PZ-TEP-01", "1", "APPROVED"])
        writer.writerow([object_id, "params-rd.pdf", "RD", "АР", "AR-GP-01", "1", "FOR_CONSTRUCTION"])

    (out_dir / "ground-truth.json").write_text(
        json.dumps(GROUND_TRUTH, ensure_ascii=False, indent=2), encoding="utf-8",
    )


if __name__ == "__main__":
    main()
