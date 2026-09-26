# План 3. Матрица из 132 параметров

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Матрица заказчика `Задание/Матрица_параметров_редакция1.1.xlsx` превращается в 132 спецификации параметров, загружается в таблицу `params` с полями из п. 8.1 ТЗ и отдаётся через API; движок по каждому из 132 параметров возвращает результат, а по нереализованным — честный `NOT_COMPARABLE` с причиной, а не молчание и не сбой.

**Architecture:** Решение 2 архитектуры: параметры описываются декларативно, один общий движок исполняет все. Генератор (`services/worker/tools/matrix2specs.py`) делает из матрицы по одному YAML на параметр — заготовки, которые команда затем доводит вручную, поэтому генератор по умолчанию не перезаписывает существующие файлы. Воркер при старте досеивает в базу только отсутствующие параметры: после первой загрузки источником истины становится база, где пороги правит администратор (модуль 8 ТЗ).

**Tech Stack:** Python 3.11, openpyxl, PyYAML, asyncpg; Node.js, Fastify, Prisma, Zod.

## Global Constraints

- Внешние сетевые вызовы запрещены полностью.
- Поля таблицы `params` берутся из п. 8.1 ТЗ **поимённо**: `id, code, section, parameter_name, unit, source_pd, source_rd, source_id, trigger_logic, review_priority, sp_reference, gost_reference, fz_reference, other_normative, data_type, min_value, max_value, regex_pattern, is_active, created_at, updated_at`. Жюри сверяет схему с ТЗ.
- Допустимые `data_type` по ТЗ: `number`, `string`, `boolean`, `coordinate`, `enum`.
- `review_priority` — только очерёдность экспертной проверки, не юридическое действие (п. 8.1 ТЗ). Нигде не превращается в статус нарушения.
- Порог выводится из текста триггера **только когда он однозначен**. Диапазон («< 10-12 м»), два порога в одной фразе, доля от общего числа — порог не выводится, параметр остаётся на ручную доводку. Угадывание запрещено: ложный порог даёт ложное нарушение и бьёт по Precision ≥ 0,90.
- Коды параметров — как в матрице: `M-001` … `M-132`.
- Комментарии в коде — по-английски, объясняют *почему*. Комментарии вида «добавлено», «изменено» запрещены.
- Структурный лог и изоляция ошибок в цикле потребления воркера не меняются.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `services/api/prisma/schema.prisma` | модель `Param`, таблица `params` |
| `services/worker/tools/matrix2specs.py` | генератор спецификаций из xlsx |
| `services/worker/specs/params/M-*.yaml` | 132 спецификации, результат генератора |
| `services/worker/specs/params/_matrix.yaml` | версия матрицы и SHA-256 исходного файла |
| `services/worker/app/params/__init__.py` | пакет |
| `services/worker/app/params/specs.py` | загрузка и проверка спецификаций |
| `services/worker/app/params/engine.py` | прогон всех 132 параметров, `NOT_COMPARABLE` для нереализованных |
| `services/worker/app/db.py` | досев параметров в базу |
| `services/worker/app/main.py` | досев при старте |
| `services/worker/Dockerfile` | спецификации внутри образа |
| `services/api/src/routes/params.ts` | `GET /api/v1/params` |

---

### Task 1: Таблица `params`

**Files:**
- Modify: `services/api/prisma/schema.prisma`
- Create: миграция через `prisma migrate dev`

**Interfaces:**
- Produces: таблица `params`. Воркер пишет в неё через asyncpg, поэтому имена колонок — контракт: поля из п. 8.1 ТЗ плюс `modality`, `compare_op`, `compare_threshold`, `implemented`, `matrix_version`. `id` — автоинкремент, `code` уникален, `updated_at` **не имеет значения по умолчанию в базе** (Prisma проставляет его на стороне клиента), поэтому вставка из воркера обязана задавать его явно.

- [ ] **Step 1: Добавить модель**

В `services/api/prisma/schema.prisma`:

```prisma
// Field names follow section 8.1 of the customer's specification verbatim:
// the jury compares the schema against it.
model Param {
  id               Int      @id @default(autoincrement())
  code             String   @unique @db.VarChar(20)
  section          String   @db.VarChar(50)
  parameterName    String   @map("parameter_name") @db.VarChar(255)
  unit             String   @db.VarChar(20)
  sourcePd         String?  @map("source_pd")
  sourceRd         String?  @map("source_rd")
  sourceId         String?  @map("source_id")
  triggerLogic     String?  @map("trigger_logic")
  // Order of expert review only; the specification states it is not a legal
  // action and it must never be read as a violation status.
  reviewPriority   String   @map("review_priority") @db.VarChar(20)
  spReference      String?  @map("sp_reference")
  gostReference    String?  @map("gost_reference")
  fzReference      String?  @map("fz_reference")
  otherNormative   String?  @map("other_normative")
  dataType         String   @map("data_type") @db.VarChar(20)
  minValue         Float?   @map("min_value")
  maxValue         Float?   @map("max_value")
  regexPattern     String?  @map("regex_pattern") @db.VarChar(255)
  isActive         Boolean  @default(true) @map("is_active")
  // Beyond section 8.1: how the value is extracted, the inter-stage rule the
  // trigger text describes, and whether an extractor exists at all.
  modality         String   @db.VarChar(20)
  compareOp        String?  @map("compare_op") @db.VarChar(30)
  compareThreshold Float?   @map("compare_threshold")
  implemented      Boolean  @default(false)
  matrixVersion    String   @map("matrix_version") @db.VarChar(20)
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  @@index([section])
  @@map("params")
}
```

- [ ] **Step 2: Создать миграцию**

Run: `cd services/api && npx prisma migrate dev --name params`
Expected: `Your database is now in sync with your schema.`

- [ ] **Step 3: Проверить таблицу**

Run: `docker compose exec -T postgres psql -U inspector -d inspector -c "\d params"`
Expected: все поля из п. 8.1 ТЗ присутствуют с этими именами, `code` уникален.

- [ ] **Step 4: Проверить, что ничего не сломано**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`
Expected: без ошибок типов, все тесты проходят.

- [ ] **Step 5: Commit**

```bash
git add services/api/prisma
git commit -m "feat(db): add the params table with the fields named in section 8.1"
```

---

### Task 2: Генератор спецификаций из матрицы

**Files:**
- Create: `services/worker/tools/__init__.py` (пустой)
- Create: `services/worker/tools/matrix2specs.py`
- Create: `services/worker/tests/test_matrix2specs.py`
- Create (результат запуска): `services/worker/specs/params/M-001.yaml` … `M-132.yaml`, `services/worker/specs/params/_matrix.yaml`
- Modify: `services/worker/pyproject.toml` — зависимость `pyyaml>=6.0`

**Interfaces:**
- Produces: функции `build_specs(xlsx_path: Path) -> tuple[dict, list[dict]]` (манифест матрицы и список спецификаций) и `write_specs(xlsx_path: Path, out_dir: Path, force: bool = False) -> int` (число записанных файлов). Формат YAML-файла — ключи ровно такие:

```yaml
code: M-041
section: АР
parameter_name: Ширина эвакуационных выходов (дверей)
unit: м
data_type: number
modality: scalar_text
review_priority: HIGH
source_pd: Ведомость заполнения проемов (АР)
source_rd: Спецификация дверей (ГОСТ 21.101); Детальные узлы (АР)
source_id: Паспорта на двери; Акты АОСР (фактический замер)
trigger_logic: Ширина дверного полотна на путях эвакуации в РД/ИД < 0.9 м.
compare_op: value_lt
compare_threshold: 0.9
min_value: 0.9
max_value: null
sp_reference: null
gost_reference: ГОСТ 21.101
fz_reference: null
other_normative: null
regex_pattern: null
implemented: false
```

  Манифест `_matrix.yaml`: `matrix_version`, `source_file`, `source_sha256`, `params_count`.

  Используется в Task 3.

- [ ] **Step 1: Добавить зависимость**

В `services/worker/pyproject.toml` в `dependencies` добавить `"pyyaml>=6.0",`.

Run: `cd services/worker && .venv/Scripts/python.exe -m pip install pyyaml`

- [ ] **Step 2: Написать падающий тест**

Создать `services/worker/tests/test_matrix2specs.py`:

```python
from pathlib import Path

import pytest
import yaml

from tools.matrix2specs import build_specs, write_specs

MATRIX = Path(__file__).resolve().parents[3] / "Задание" / "Матрица_параметров_редакция1.1.xlsx"

pytestmark = pytest.mark.skipif(not MATRIX.exists(), reason="customer matrix is not in the checkout")


@pytest.fixture(scope="module")
def built():
    manifest, specs = build_specs(MATRIX)
    return manifest, {s["code"]: s for s in specs}


def test_every_parameter_of_the_matrix_becomes_a_spec(built):
    manifest, by_code = built
    assert len(by_code) == 132
    assert sorted(by_code) == [f"M-{i:03d}" for i in range(1, 133)]
    assert manifest["params_count"] == 132
    assert manifest["matrix_version"] == "1.1"
    assert len(manifest["source_sha256"]) == 64


def test_section_is_the_short_code_the_specification_uses(built):
    _, by_code = built
    assert by_code["M-002"]["section"] == "ПЗ"
    assert by_code["M-068"]["section"] == "ИОС1"
    assert by_code["M-132"]["section"] == "СМ"


def test_relative_delta_threshold_is_read_from_a_percentage(built):
    _, by_code = built
    spec = by_code["M-002"]  # "Дельта общей площади между ПД и РД (или ИД) > 1%."
    assert spec["compare_op"] == "relative_delta_gt"
    assert spec["compare_threshold"] == pytest.approx(0.01)
    # An inter-stage tolerance is not an absolute bound on the value.
    assert spec["min_value"] is None and spec["max_value"] is None


def test_a_lower_bound_becomes_min_value(built):
    _, by_code = built
    spec = by_code["M-041"]  # "... < 0.9 м."
    assert spec["compare_op"] == "value_lt"
    assert spec["min_value"] == pytest.approx(0.9)
    assert spec["max_value"] is None


def test_an_upper_bound_becomes_max_value(built):
    _, by_code = built
    spec = by_code["M-118"]  # "Высота порога > 0.014 м"
    assert spec["compare_op"] == "value_gt"
    assert spec["max_value"] == pytest.approx(0.014)


def test_a_displacement_is_a_delta_not_a_bound(built):
    _, by_code = built
    spec = by_code["M-034"]  # "Смещение точки подключения ... > 0.5 м."
    assert spec["compare_op"] == "delta_gt"
    assert spec["compare_threshold"] == pytest.approx(0.5)
    assert spec["data_type"] == "coordinate"


@pytest.mark.parametrize("code", ["M-031", "M-042", "M-038"])
def test_ambiguous_triggers_get_no_threshold(built, code):
    """A guessed threshold manufactures violations, which is worse than none.

    M-031 gives a range ("< 10-12 м"), M-042 two thresholds in one sentence,
    M-038 a share of a total. None of them names one number to compare with.
    """
    _, by_code = built
    spec = by_code[code]
    assert spec["compare_op"] is None
    assert spec["compare_threshold"] is None
    assert spec["min_value"] is None and spec["max_value"] is None


def test_normative_references_are_lifted_from_the_text(built):
    _, by_code = built
    assert by_code["M-040"]["sp_reference"] == "СП 1.13130"
    assert by_code["M-041"]["gost_reference"] == "ГОСТ 21.101"


def test_data_type_and_modality_follow_the_unit_and_sources(built):
    _, by_code = built
    assert by_code["M-055"]["data_type"] == "enum"          # Марка (B)
    assert by_code["M-098"]["modality"] == "doc_presence"   # Статус
    assert by_code["M-041"]["modality"] == "scalar_text"    # ведомость проёмов
    assert by_code["M-040"]["modality"] == "drawing_measure"  # планы, линейные размеры
    assert by_code["M-043"]["modality"] == "drawing_entity"   # направление открывания


def test_every_value_fits_the_column_widths_of_section_8_1(built):
    _, by_code = built
    for spec in by_code.values():
        assert len(spec["code"]) <= 20
        assert len(spec["section"]) <= 50
        assert len(spec["parameter_name"]) <= 255
        assert len(spec["unit"]) <= 20, (spec["code"], spec["unit"])
        assert spec["data_type"] in {"number", "string", "boolean", "coordinate", "enum"}
        assert spec["review_priority"] in {"HIGH", "MEDIUM", "LOW"}
        assert spec["implemented"] is False


def test_hand_edited_specs_are_not_overwritten(tmp_path):
    """Generated specs are a starting point the team refines by hand.

    A second run that silently regenerated them would throw that work away.
    """
    assert write_specs(MATRIX, tmp_path) == 133  # 132 specs and the manifest
    edited = tmp_path / "M-041.yaml"
    spec = yaml.safe_load(edited.read_text(encoding="utf-8"))
    spec["implemented"] = True
    edited.write_text(yaml.safe_dump(spec, allow_unicode=True, sort_keys=False), encoding="utf-8")

    assert write_specs(MATRIX, tmp_path) == 0
    assert yaml.safe_load(edited.read_text(encoding="utf-8"))["implemented"] is True

    assert write_specs(MATRIX, tmp_path, force=True) == 133
    assert yaml.safe_load(edited.read_text(encoding="utf-8"))["implemented"] is False
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_matrix2specs.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'tools'`

- [ ] **Step 4: Реализовать генератор**

Создать пустой `services/worker/tools/__init__.py` и `services/worker/tools/matrix2specs.py`:

```python
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


def derive_compare(logic: str) -> dict:
    empty = {"compare_op": None, "compare_threshold": None, "min_value": None, "max_value": None}
    matches = list(COMPARISON_RE.finditer(logic))
    if len(matches) != 1:
        return empty

    operator, number, range_tail, unit = matches[0].groups()
    if range_tail:
        return empty
    value = float(number.replace(",", "."))
    greater = operator.lower() in (">", "более")

    if unit == "%":
        # "> N%" is a tolerance between stages. "< N%" in this matrix is a
        # share of some total, which needs the total, not a threshold.
        if not greater:
            return empty
        return {**empty, "compare_op": "relative_delta_gt", "compare_threshold": value / 100}

    if greater:
        if any(word in logic.lower() for word in DELTA_WORDS):
            return {**empty, "compare_op": "delta_gt", "compare_threshold": value}
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
            **derive_compare(logic),
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
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_matrix2specs.py -q`
Expected: все тесты проходят.

Если какой-то из закреплённых в тестах параметров даёт другой результат — сначала посмотреть на его фактический текст триггера в матрице. Тесты описывают правила, выведенные из реального текста; если правило в коде расходится с реальным текстом, чинится код, а не ожидание в тесте.

- [ ] **Step 6: Сгенерировать спецификации**

Run: `cd services/worker && .venv/Scripts/python.exe -m tools.matrix2specs "../../Задание/Матрица_параметров_редакция1.1.xlsx" specs/params`
Expected: `written: 133`

Посчитать, сколько параметров получили порог автоматически:

```bash
cd services/worker && grep -l "^compare_op: [a-z]" specs/params/M-*.yaml | wc -l
```

Число записать в отчёт — оно показывает, какая доля матрицы требует ручной доводки.

- [ ] **Step 7: Commit**

```bash
git add services/worker/tools services/worker/specs services/worker/tests/test_matrix2specs.py services/worker/pyproject.toml
git commit -m "feat(worker): generate the 132 parameter specs from the customer matrix"
```

---

### Task 3: Загрузка спецификаций и движок

**Files:**
- Create: `services/worker/app/params/__init__.py` (пустой)
- Create: `services/worker/app/params/specs.py`
- Create: `services/worker/app/params/engine.py`
- Create: `services/worker/tests/test_params.py`

**Interfaces:**
- Consumes: формат файлов из Task 2.
- Produces:
  - `ParamSpec` — замороженный датакласс с полями, повторяющими ключи YAML;
  - `MatrixSpecs(version: str, source_sha256: str, params: tuple[ParamSpec, ...])`;
  - `SPECS_DIR: Path` — каталог спецификаций внутри пакета воркера;
  - `load_specs(directory: Path = SPECS_DIR) -> MatrixSpecs`;
  - `ParamOutcome(code: str, status: str, reason: str)`;
  - `evaluate_all(specs: MatrixSpecs, evaluators: dict[str, Callable[[ParamSpec], ParamOutcome]]) -> list[ParamOutcome]`.

  Используется в Task 4 и в следующем плане.

- [ ] **Step 1: Написать падающий тест**

Создать `services/worker/tests/test_params.py`:

```python
import shutil

import pytest
import yaml

from app.params.engine import ParamOutcome, evaluate_all
from app.params.specs import SPECS_DIR, load_specs


def test_the_committed_matrix_loads_whole():
    matrix = load_specs()

    assert matrix.version == "1.1"
    assert len(matrix.params) == 132
    assert len({p.code for p in matrix.params}) == 132


def test_every_parameter_gets_an_outcome_even_with_no_extractor():
    """The engine answers for all 132, from the very first day.

    A parameter nobody has implemented yet says so, with a reason, instead of
    disappearing from the protocol. Silence would read as "checked, fine".
    """
    outcomes = evaluate_all(load_specs(), evaluators={})

    assert len(outcomes) == 132
    assert {o.status for o in outcomes} == {"NOT_COMPARABLE"}
    assert all(o.reason for o in outcomes)


def test_an_implemented_parameter_uses_its_evaluator():
    outcomes = evaluate_all(
        load_specs(),
        evaluators={"M-041": lambda spec: ParamOutcome(spec.code, "NEGATIVE_VERIFIED", "checked")},
    )

    by_code = {o.code: o for o in outcomes}
    assert by_code["M-041"].status == "NEGATIVE_VERIFIED"
    assert by_code["M-040"].status == "NOT_COMPARABLE"


def test_a_failing_evaluator_does_not_sink_the_other_parameters():
    """One broken rule must not cost the protocol its other 131 results."""
    def broken(spec):
        raise RuntimeError("table layout not recognised")

    outcomes = evaluate_all(load_specs(), evaluators={"M-041": broken})

    by_code = {o.code: o for o in outcomes}
    assert len(outcomes) == 132
    assert by_code["M-041"].status == "NOT_COMPARABLE"
    assert "table layout not recognised" in by_code["M-041"].reason


def test_an_evaluator_cannot_confirm_a_violation():
    """CONFIRMED_VIOLATION is the inspector's decision alone (section 9.2).

    If a rule ever returns it, the engine refuses rather than passing it on.
    """
    outcomes = evaluate_all(
        load_specs(),
        evaluators={"M-041": lambda spec: ParamOutcome(spec.code, "CONFIRMED_VIOLATION", "sure")},
    )

    by_code = {o.code: o for o in outcomes}
    assert by_code["M-041"].status == "NOT_COMPARABLE"
    assert "inspector" in by_code["M-041"].reason


def test_a_duplicated_code_is_refused(tmp_path):
    target = tmp_path / "params"
    shutil.copytree(SPECS_DIR, target)
    duplicate = yaml.safe_load((target / "M-001.yaml").read_text(encoding="utf-8"))
    (target / "M-999.yaml").write_text(
        yaml.safe_dump(duplicate, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )

    with pytest.raises(ValueError, match="M-001"):
        load_specs(target)


def test_a_count_that_disagrees_with_the_manifest_is_refused(tmp_path):
    """A lost spec file must not quietly shrink the matrix to 131 parameters."""
    target = tmp_path / "params"
    shutil.copytree(SPECS_DIR, target)
    (target / "M-132.yaml").unlink()

    with pytest.raises(ValueError, match="132"):
        load_specs(target)


def test_an_unknown_data_type_is_refused(tmp_path):
    target = tmp_path / "params"
    shutil.copytree(SPECS_DIR, target)
    spec = yaml.safe_load((target / "M-001.yaml").read_text(encoding="utf-8"))
    spec["data_type"] = "float"
    (target / "M-001.yaml").write_text(
        yaml.safe_dump(spec, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )

    with pytest.raises(ValueError, match="data_type"):
        load_specs(target)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_params.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'app.params'`

- [ ] **Step 3: Реализовать загрузку**

Создать пустой `services/worker/app/params/__init__.py` и `services/worker/app/params/specs.py`:

```python
"""The parameter matrix as the worker sees it.

Specs are validated on load rather than trusted: a spec with a wrong data type
or a duplicated code would otherwise surface much later as a wrong comparison
in a signed protocol.
"""

from dataclasses import dataclass, fields
from pathlib import Path

import yaml

SPECS_DIR = Path(__file__).resolve().parents[2] / "specs" / "params"

DATA_TYPES = {"number", "string", "boolean", "coordinate", "enum"}
MODALITIES = {"scalar_text", "doc_presence", "drawing_entity", "drawing_measure"}
PRIORITIES = {"HIGH", "MEDIUM", "LOW"}


@dataclass(frozen=True)
class ParamSpec:
    code: str
    section: str
    parameter_name: str
    unit: str
    data_type: str
    modality: str
    review_priority: str
    source_pd: str | None
    source_rd: str | None
    source_id: str | None
    trigger_logic: str
    compare_op: str | None
    compare_threshold: float | None
    min_value: float | None
    max_value: float | None
    sp_reference: str | None
    gost_reference: str | None
    fz_reference: str | None
    other_normative: str | None
    regex_pattern: str | None
    implemented: bool


@dataclass(frozen=True)
class MatrixSpecs:
    version: str
    source_sha256: str
    params: tuple[ParamSpec, ...]


_FIELDS = {f.name for f in fields(ParamSpec)}


def _check(spec: dict, path: Path) -> ParamSpec:
    missing = _FIELDS - spec.keys()
    if missing:
        raise ValueError(f"{path.name}: missing keys {sorted(missing)}")
    if spec["data_type"] not in DATA_TYPES:
        raise ValueError(f"{path.name}: data_type {spec['data_type']!r} is not one of {sorted(DATA_TYPES)}")
    if spec["modality"] not in MODALITIES:
        raise ValueError(f"{path.name}: modality {spec['modality']!r} is not one of {sorted(MODALITIES)}")
    if spec["review_priority"] not in PRIORITIES:
        raise ValueError(f"{path.name}: review_priority {spec['review_priority']!r} is not one of {sorted(PRIORITIES)}")
    return ParamSpec(**{name: spec[name] for name in _FIELDS})


def load_specs(directory: Path = SPECS_DIR) -> MatrixSpecs:
    manifest = yaml.safe_load((directory / "_matrix.yaml").read_text(encoding="utf-8"))

    params: list[ParamSpec] = []
    seen: dict[str, str] = {}
    for path in sorted(directory.glob("M-*.yaml")):
        spec = _check(yaml.safe_load(path.read_text(encoding="utf-8")), path)
        if spec.code in seen:
            raise ValueError(f"{spec.code} is defined in both {seen[spec.code]} and {path.name}")
        seen[spec.code] = path.name
        params.append(spec)

    if len(params) != manifest["params_count"]:
        raise ValueError(
            f"{len(params)} spec files found, the matrix declares {manifest['params_count']}"
        )

    return MatrixSpecs(
        version=str(manifest["matrix_version"]),
        source_sha256=manifest["source_sha256"],
        params=tuple(params),
    )
```

- [ ] **Step 4: Реализовать движок**

Создать `services/worker/app/params/engine.py`:

```python
"""Runs every parameter of the matrix and answers for each one.

A parameter without an extractor, or whose extractor fails, comes back as
NOT_COMPARABLE with the reason. That is the behaviour the specification asks
for (section 9.2), and on the hidden test it costs nothing: an honest refusal
is not a false positive, while a guess would be.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass

from app.params.specs import MatrixSpecs, ParamSpec

logger = logging.getLogger(__name__)

NOT_IMPLEMENTED = "no extractor is implemented for this parameter yet"


@dataclass(frozen=True)
class ParamOutcome:
    code: str
    status: str
    reason: str


Evaluator = Callable[[ParamSpec], ParamOutcome]


def evaluate_all(specs: MatrixSpecs, evaluators: dict[str, Evaluator]) -> list[ParamOutcome]:
    outcomes: list[ParamOutcome] = []
    for spec in specs.params:
        evaluator = evaluators.get(spec.code)
        if evaluator is None:
            outcomes.append(ParamOutcome(spec.code, "NOT_COMPARABLE", NOT_IMPLEMENTED))
            continue
        try:
            outcome = evaluator(spec)
        except Exception as exc:  # noqa: BLE001 - one rule must not sink the protocol
            logger.error("parameter evaluation failed",
                         extra={"param_code": spec.code, "error": str(exc)})
            outcomes.append(ParamOutcome(spec.code, "NOT_COMPARABLE", f"evaluation failed: {exc}"))
            continue

        # Section 9.2: CONFIRMED_VIOLATION is assigned by the inspector only.
        # A rule that returns it is a defect, and passing it on would put an
        # unverified violation into the protocol.
        if outcome.status == "CONFIRMED_VIOLATION":
            logger.error("evaluator tried to confirm a violation",
                         extra={"param_code": spec.code})
            outcomes.append(ParamOutcome(
                spec.code, "NOT_COMPARABLE",
                "only an inspector can confirm a violation; the rule returned it itself",
            ))
            continue

        outcomes.append(outcome)
    return outcomes
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_params.py -q`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add services/worker/app/params services/worker/tests/test_params.py
git commit -m "feat(worker): load the parameter matrix and answer for all 132 parameters"
```

---

### Task 4: Досев параметров в базу при старте воркера

**Files:**
- Modify: `services/worker/app/db.py`
- Modify: `services/worker/app/main.py`
- Modify: `services/worker/Dockerfile`
- Create: `services/worker/tests/test_seed_params.py`

**Interfaces:**
- Consumes: `load_specs`, `MatrixSpecs` из Task 3; таблица `params` из Task 1.
- Produces: `Database.seed_params(matrix: MatrixSpecs) -> int` — число вставленных строк.

- [ ] **Step 1: Добавить метод досева**

В `services/worker/app/db.py`, метод класса `Database`:

```python
    async def seed_params(self, matrix) -> int:
        """Insert the parameters the table does not have yet.

        Existing rows are left alone on purpose: after the first start the
        database is the source of truth, and section 7 (module 8) lets an
        administrator change thresholds there without a redeploy. Overwriting
        from the spec files on every start would silently undo that.
        """
        inserted = 0
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                for spec in matrix.params:
                    status = await connection.execute(
                        """
                        INSERT INTO params (
                            code, section, parameter_name, unit, source_pd, source_rd,
                            source_id, trigger_logic, review_priority, sp_reference,
                            gost_reference, fz_reference, other_normative, data_type,
                            min_value, max_value, regex_pattern, modality, compare_op,
                            compare_threshold, implemented, matrix_version, updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                                $14, $15, $16, $17, $18, $19, $20, $21, $22, now())
                        ON CONFLICT (code) DO NOTHING
                        """,
                        spec.code, spec.section, spec.parameter_name, spec.unit,
                        spec.source_pd, spec.source_rd, spec.source_id, spec.trigger_logic,
                        spec.review_priority, spec.sp_reference, spec.gost_reference,
                        spec.fz_reference, spec.other_normative, spec.data_type,
                        spec.min_value, spec.max_value, spec.regex_pattern, spec.modality,
                        spec.compare_op, spec.compare_threshold, spec.implemented,
                        matrix.version,
                    )
                    # asyncpg reports "INSERT 0 1" for a new row, "INSERT 0 0" for a skip.
                    if status.endswith(" 1"):
                        inserted += 1
        return inserted
```

`updated_at` задаётся явно: у колонки нет значения по умолчанию в базе, Prisma проставляет его на своей стороне.

- [ ] **Step 2: Вызвать досев при старте**

Привести `services/worker/app/main.py` к виду:

```python
import asyncio
import logging

from app.config import load_config
from app.consumer import consume
from app.db import Database
from app.logging_setup import setup_logging
from app.params.specs import load_specs
from app.storage import ManifestStorage

logger = logging.getLogger(__name__)


async def _run() -> None:
    config = load_config()
    setup_logging(config.log_level)
    db = await Database.connect(config.database_url)
    try:
        # Loaded before consuming so a broken spec stops the worker at start,
        # visibly, instead of failing the first package it is given.
        matrix = load_specs()
        inserted = await db.seed_params(matrix)
        logger.info("parameter matrix loaded", extra={
            "matrix_version": matrix.version,
            "params": len(matrix.params),
            "inserted": inserted,
        })
        storage = ManifestStorage(config)
        await consume(config.rabbitmq_url, db, storage)
    finally:
        await db.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Положить спецификации в образ**

В `services/worker/Dockerfile` рядом с `COPY app ./app` добавить:

```dockerfile
COPY specs ./specs
```

Без этой строки образ собирается, а воркер падает при старте: `load_specs` не найдёт каталог. Путь `SPECS_DIR` вычисляется от пакета `app`, поэтому в контейнере это `/app/specs/params`.

- [ ] **Step 4: Написать тест досева против живой базы**

Досев — единственное место этого плана, где ошибка видна только на настоящей базе (приведение типов, `updated_at`, `ON CONFLICT`). Поэтому тест идёт против поднятого Postgres, а не подделки.

Создать `services/worker/tests/test_seed_params.py`:

```python
import os

import pytest
import pytest_asyncio

from app.db import Database
from app.params.specs import load_specs

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://inspector:inspector@localhost:5432/inspector"
)


# Strict mode of pytest-asyncio only runs async fixtures declared this way.
@pytest_asyncio.fixture
async def db():
    try:
        database = await Database.connect(DATABASE_URL)
    except OSError:
        pytest.skip("PostgreSQL is not reachable; start it with docker compose up -d")
    yield database
    await database.close()


@pytest.mark.asyncio
async def test_seeding_fills_the_table_once_and_keeps_admin_edits(db):
    matrix = load_specs()
    async with db._pool.acquire() as connection:
        await connection.execute("DELETE FROM params")

    assert await db.seed_params(matrix) == 132

    async with db._pool.acquire() as connection:
        await connection.execute("UPDATE params SET min_value = 1.0 WHERE code = 'M-041'")

    # A second start must not undo what an administrator changed.
    assert await db.seed_params(matrix) == 0

    async with db._pool.acquire() as connection:
        row = await connection.fetchrow(
            "SELECT min_value, matrix_version, parameter_name FROM params WHERE code = 'M-041'"
        )
    assert row["min_value"] == 1.0
    assert row["matrix_version"] == "1.1"
    assert row["parameter_name"].startswith("Ширина эвакуационных")
```

`Database.connect(database_url)` и `Database.close()` в `app/db.py` уже существуют.

- [ ] **Step 5: Прогнать тесты и проверить на живой системе**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest -q`
Expected: всё проходит.

Затем:

```bash
docker compose up -d --build worker
docker compose logs worker | grep "parameter matrix loaded"
docker compose exec -T postgres psql -U inspector -d inspector \
  -c "SELECT count(*), count(*) FILTER (WHERE compare_op IS NOT NULL) AS with_threshold FROM params;"
```

Expected: строка лога с `matrix_version` 1.1 и `params` 132; в таблице 132 строки.

После пересоздания контейнера лог должен показать `inserted: 0` — досев не трогает существующие строки.

- [ ] **Step 6: Commit**

```bash
git add services/worker
git commit -m "feat(worker): seed the parameter matrix on start without overwriting admin edits"
```

---

### Task 5: `GET /api/v1/params`

**Files:**
- Create: `services/api/src/routes/params.ts`
- Modify: `services/api/src/server.ts`
- Test: `services/api/tests/params.test.ts`

**Interfaces:**
- Consumes: таблица `params` из Task 1.
- Produces: `GET /api/v1/params?section=&priority=&active=` → `{ matrix_version: string | null, total: number, items: Param[] }`. Поля каждого элемента — имена из п. 8.1 ТЗ в snake_case плюс `modality`, `compare_op`, `compare_threshold`, `implemented`, `matrix_version`.

- [ ] **Step 1: Написать падающий тест**

Создать `services/api/tests/params.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';

const PREFIX = `T${Date.now().toString(36)}`;

beforeAll(async () => {
  await prisma.param.createMany({
    data: [
      {
        code: `${PREFIX}-A`, section: 'ТЕСТ-А', parameterName: 'Ширина проёма', unit: 'м',
        reviewPriority: 'HIGH', dataType: 'number', modality: 'scalar_text',
        minValue: 0.9, compareOp: 'value_lt', compareThreshold: 0.9, matrixVersion: '1.1',
      },
      {
        code: `${PREFIX}-B`, section: 'ТЕСТ-Б', parameterName: 'Класс бетона', unit: 'Марка (B)',
        reviewPriority: 'MEDIUM', dataType: 'enum', modality: 'scalar_text',
        isActive: false, matrixVersion: '1.1',
      },
    ],
  });
});

afterAll(async () => {
  await prisma.param.deleteMany({ where: { code: { startsWith: PREFIX } } });
});

describe('GET /api/v1/params', () => {
  it('returns parameters under the field names of section 8.1', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/params?section=ТЕСТ-А' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      code: `${PREFIX}-A`,
      parameter_name: 'Ширина проёма',
      review_priority: 'HIGH',
      data_type: 'number',
      min_value: 0.9,
      is_active: true,
      implemented: false,
      matrix_version: '1.1',
    });
    await app.close();
  });

  it('filters by priority and by activity', async () => {
    const app = await buildServer();

    const inactive = await app.inject({ method: 'GET', url: '/api/v1/params?section=ТЕСТ-Б&active=false' });
    expect(inactive.json().items.map((p: { code: string }) => p.code)).toEqual([`${PREFIX}-B`]);

    const medium = await app.inject({ method: 'GET', url: '/api/v1/params?section=ТЕСТ-Б&priority=MEDIUM' });
    expect(medium.json().total).toBe(1);
    await app.close();
  });

  it('refuses an unknown priority', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/params?priority=URGENT' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd services/api && npx vitest run tests/params.test.ts`
Expected: FAIL — маршрут отвечает 404.

- [ ] **Step 3: Реализовать маршрут**

Создать `services/api/src/routes/params.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Param } from '@prisma/client';
import { prisma } from '../db.js';

const querySchema = z.object({
  section: z.string().trim().min(1).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  // Query strings carry text, so "false" has to be read explicitly: a plain
  // coercion would turn it into true.
  active: z.enum(['true', 'false']).optional(),
});

// Field names from section 8.1 of the specification, which the jury checks
// the API against, rather than Prisma's camelCase.
function toResponse(param: Param) {
  return {
    id: param.id,
    code: param.code,
    section: param.section,
    parameter_name: param.parameterName,
    unit: param.unit,
    source_pd: param.sourcePd,
    source_rd: param.sourceRd,
    source_id: param.sourceId,
    trigger_logic: param.triggerLogic,
    review_priority: param.reviewPriority,
    sp_reference: param.spReference,
    gost_reference: param.gostReference,
    fz_reference: param.fzReference,
    other_normative: param.otherNormative,
    data_type: param.dataType,
    min_value: param.minValue,
    max_value: param.maxValue,
    regex_pattern: param.regexPattern,
    is_active: param.isActive,
    modality: param.modality,
    compare_op: param.compareOp,
    compare_threshold: param.compareThreshold,
    implemented: param.implemented,
    matrix_version: param.matrixVersion,
    created_at: param.createdAt,
    updated_at: param.updatedAt,
  };
}

export async function paramRoutes(app: FastifyInstance) {
  app.get('/api/v1/params', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const { section, priority, active } = parsed.data;

    const params = await prisma.param.findMany({
      where: {
        ...(section ? { section } : {}),
        ...(priority ? { reviewPriority: priority } : {}),
        ...(active ? { isActive: active === 'true' } : {}),
      },
      orderBy: { code: 'asc' },
    });

    return {
      matrix_version: params[0]?.matrixVersion ?? null,
      total: params.length,
      items: params.map(toResponse),
    };
  });
}
```

В `services/api/src/server.ts` добавить импорт `import { paramRoutes } from './routes/params.js';` и регистрацию `await app.register(paramRoutes);` рядом с остальными.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`
Expected: без ошибок типов, все тесты проходят.

- [ ] **Step 5: Проверить на живой системе**

```bash
docker compose up -d --build api
curl -s "http://localhost:3000/api/v1/params?section=АР" | python -c "import sys,json; d=json.load(sys.stdin); print(d['matrix_version'], d['total'], d['items'][0]['code'])"
```

Expected: `1.1 14 M-040` — в разделе АР четырнадцать параметров.

- [ ] **Step 6: Commit**

```bash
git add services/api
git commit -m "feat(api): expose the parameter matrix under the field names of section 8.1"
```

---

## Что этот план сознательно не делает

- **Извлечение значений параметров.** Ни один параметр не получает `implemented: true`. Движок отвечает `NOT_COMPARABLE` по всем 132 — это честное стартовое состояние. Извлечение начинается в Плане 4 с экспликаций помещений и ТЭП: на них приходится шесть из девяти пилотных случаев разметки.
- **Правка порогов администратором.** Таблица и досев уже устроены так, чтобы правки не затирались; сам интерфейс — отдельный модуль 8 ТЗ.
- **Таблицы `checks` и `evidence_fragments`.** Появятся вместе с первыми результатами сравнения, в Плане 4.
