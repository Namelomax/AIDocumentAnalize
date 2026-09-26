"""Turn the customer's parameter matrix into one spec file per parameter.

The output is a starting point, not a finished rule set: the team refines each
spec by hand, so existing files are left alone unless --force is given. Only
thresholds that the trigger text states unambiguously are derived. A guessed
threshold would manufacture violations, which costs more than leaving the
parameter to be completed by hand.

Usage:
    python -m tools.matrix2specs <matrix.xlsx> <out_dir> [--force]
"""

import argparse
import hashlib
import re
from pathlib import Path

import openpyxl
import yaml

SHEET = "МАТРИЦА"

VERSION_RE = re.compile(r"редакция\s*(\d+(?:\.\d+)*)", re.IGNORECASE)
SECTION_RE = re.compile(r"Раздел\s+\d+\.\s*(.+)$")
# One comparison: operator, number, an optional "-N" that makes it a range,
# and an optional unit.
COMPARISON_RE = re.compile(
    r"(<|>|менее|более)\s*(\d+(?:[.,]\d+)?)(\s*-\s*\d+(?:[.,]\d+)?)?\s*(%|мм|м)?",
    re.IGNORECASE,
)
SP_RE = re.compile(r"СП\s+\d+(?:\.\d+)+")
GOST_RE = re.compile(r"ГОСТ(?:\s+Р)?\s+\d+(?:\.\d+)+(?:-\d+)?")
FZ_RE = re.compile(r"\d+-ФЗ")

# A ">" in a sentence about a difference between stages bounds the difference;
# anywhere else it bounds the value itself.
DELTA_WORDS = ("расхожден", "дельта", "смещени")
ENUM_UNIT_WORDS = ("Класс", "Марка", "Буква", "Степень", "Кат.")
TABLE_WORDS = (
    "таблиц", "тэп", "ведомост", "спецификац", "экспликац", "общие данные",
    "общие указания", "текст", "расчет", "баланс",
)
DRAWING_UNITS = {"м", "мм", "мм²", "м²"}


def _clean(value) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def section_code(raw: str) -> str:
    match = SECTION_RE.match(raw.strip())
    return match.group(1).strip() if match else raw.strip()


def data_type_for(unit: str) -> str:
    if unit == "Коорд.":
        return "coordinate"
    if unit in ("—", "RAL / Артикул"):
        return "string"
    if unit == "Статус":
        return "enum"
    if any(word in unit for word in ENUM_UNIT_WORDS):
        return "enum"
    return "number"


def modality_for(unit: str, data_type: str, source_pd: str, source_rd: str) -> str:
    # Statuses live in registries of other systems, not in drawings: at most
    # the presence of the confirming document can be checked.
    if unit == "Статус":
        return "doc_presence"
    if data_type == "coordinate":
        return "drawing_measure"
    if data_type == "string" and unit == "—":
        return "drawing_entity"
    # Only design and working documentation decide the modality: the as-built
    # column is almost always acts and passports, whatever the parameter.
    sources = f"{source_pd} {source_rd}".lower()
    if any(word in sources for word in TABLE_WORDS):
        return "scalar_text"
    if unit in DRAWING_UNITS:
        return "drawing_measure"
    return "scalar_text"


def derive_compare(logic: str, unit: str = "") -> dict:
    empty = {"compare_op": None, "compare_threshold": None, "min_value": None, "max_value": None}
    matches = list(COMPARISON_RE.finditer(logic))
    if len(matches) != 1:
        return empty

    operator, number, range_tail, text_unit = matches[0].groups()
    if range_tail:
        return empty
    value = float(number.replace(",", "."))
    greater = operator.lower() in (">", "более")

    if text_unit == "%":
        # "> N%" is a tolerance between stages. "< N%" in this matrix is a
        # share of some total, which needs the total, not a threshold.
        if not greater:
            return empty
        return {**empty, "compare_op": "relative_delta_gt", "compare_threshold": value / 100}

    if greater and any(word in logic.lower() for word in DELTA_WORDS):
        return {**empty, "compare_op": "delta_gt", "compare_threshold": value}

    # A compound unit such as "шт. / м" means the parameter carries two
    # quantities, and an absolute bound names only one of them. M-121 bounds
    # the width of a parking space at 3.5 m while also counting the spaces:
    # applied to the count, "< 3.5" would call two spaces a violation.
    if "/" in unit:
        return empty

    if greater:
        return {**empty, "compare_op": "value_gt", "compare_threshold": value, "max_value": value}
    return {**empty, "compare_op": "value_lt", "compare_threshold": value, "min_value": value}


def _references(pattern: re.Pattern, *texts: str | None) -> str | None:
    found: list[str] = []
    for text in texts:
        for match in pattern.findall(text or ""):
            if match not in found:
                found.append(match)
    return "; ".join(found) or None


def build_specs(xlsx_path: Path) -> tuple[dict, list[dict]]:
    raw = xlsx_path.read_bytes()
    version = VERSION_RE.search(xlsx_path.stem)
    workbook = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)

    specs: list[dict] = []
    for row in workbook[SHEET].iter_rows(min_row=2, values_only=True):
        if not row or not row[1]:
            continue
        _, code, section, name, unit, source_pd, source_rd, source_id, logic, priority = row[:10]
        unit = _clean(unit) or "—"
        source_pd, source_rd, source_id = _clean(source_pd), _clean(source_rd), _clean(source_id)
        logic = _clean(logic) or ""
        data_type = data_type_for(unit)

        specs.append({
            "code": _clean(code),
            "section": section_code(str(section)),
            "parameter_name": _clean(name),
            "unit": unit,
            "data_type": data_type,
            "modality": modality_for(unit, data_type, source_pd or "", source_rd or ""),
            "review_priority": str(priority).split()[0].upper(),
            "source_pd": source_pd,
            "source_rd": source_rd,
            "source_id": source_id,
            "trigger_logic": logic,
            **derive_compare(logic, unit),
            "sp_reference": _references(SP_RE, logic, source_pd, source_rd, source_id),
            "gost_reference": _references(GOST_RE, logic, source_pd, source_rd, source_id),
            "fz_reference": _references(FZ_RE, logic, source_pd, source_rd, source_id),
            "other_normative": None,
            "regex_pattern": None,
            "implemented": False,
        })

    manifest = {
        "matrix_version": version.group(1) if version else "unknown",
        "source_file": xlsx_path.name,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "params_count": len(specs),
    }
    return manifest, specs


def _dump(data: dict) -> str:
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)


def write_specs(xlsx_path: Path, out_dir: Path, force: bool = False) -> int:
    manifest, specs = build_specs(xlsx_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    targets = [(out_dir / "_matrix.yaml", manifest)]
    targets += [(out_dir / f"{spec['code']}.yaml", spec) for spec in specs]
    for path, data in targets:
        if path.exists() and not force:
            continue
        path.write_text(_dump(data), encoding="utf-8")
        written += 1
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("matrix", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--force", action="store_true",
                        help="overwrite specs that already exist, discarding hand edits")
    args = parser.parse_args()
    print(f"written: {write_specs(args.matrix, args.out_dir, args.force)}")


if __name__ == "__main__":
    main()
