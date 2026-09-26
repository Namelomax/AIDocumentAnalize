# План 4. Экспликации помещений и первые находки

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** По пакету, где есть ПД и РД одного объекта, система находит экспликации помещений на листах обеих стадий, сопоставляет помещения и итоги этажей и записывает результат в таблицы `checks` и `evidence_fragments` (раздел 10 ТЗ): совпавшие помещения — `NEGATIVE_VERIFIED`, расхождения — `CANDIDATE` с доказательствами на обоих листах, остальные параметры матрицы — `NOT_COMPARABLE` с причиной.

**Architecture:** Выбор именно экспликаций обоснован данными: шесть из девяти пилотных нарушений в матрице заказчика — это изменения площадей и назначений помещений между ПД и РД, и всё это текстовый слой, который мы уже читаем с координатами. Разбор идёт по **строкам** PDF, а не по склеенным блокам: разведка показала, что подпись помещения «1.0.9» и площадь «5,95» — две отдельные строки одного блока, а склейка давала неразрешимое «1.0.95,95». Результат сравнения привязывается к параметру M-003 матрицы атомарно, по одной доказательной группе на помещение.

**Tech Stack:** Python 3.11, PyMuPDF, asyncpg, Prisma (схема и миграции), PostgreSQL 16.

## Global Constraints

- Внешние сетевые вызовы запрещены полностью.
- `CONFIRMED_VIOLATION` не выставляется никогда: движок даёт только `CANDIDATE` или `NEGATIVE_VERIFIED` (п. 9.2 ТЗ).
- **Устаревшая редакция не может быть эталоном.** Сравниваются только файлы, которые `select_source_revision` признал актуальными. Если актуальную редакцию выбрать нельзя — результат `CLARIFICATION_REQUIRED`, сравнение не выполняется.
- Отсутствие данных, неоднозначность, нечитаемость — утверждения о качестве входа, а не нарушения. Они не становятся `CANDIDATE`.
- **Порог ложных срабатываний ТЗ — FPR ≤ 0,10.** При сомнении разборщик не сообщает о расхождении. Пропущенное нарушение стоит Recall, выдуманное — Precision и FPR сразу.
- Координаты доказательств — нормализованные `[0;1]` через существующий `normalize_box` с учётом поворота листа.
- Комментарии в коде — по-английски, объясняют *почему*. Комментарии вида «добавлено», «изменено» запрещены.

## Эталонные данные для тестов

Файл `Задание/Комплект_предметной_разметки.pdf` содержит фрагменты настоящих листов девяти объектов пилотной разметки. Установлено разведкой:

| Страницы | Объект | Что это | Ожидаемый результат |
|---|---|---|---|
| 21 ↔ 22 | Полярная, 17 | ПД и РД 1-го этажа, секция 1 | ноль расхождений — **отрицательный эталон** |
| 23 ↔ 24 | Полярная, 17 | ПД и РД 1-го этажа, секция 2 | ноль расхождений — **отрицательный эталон** |
| 19 ↔ 20 | Полярная, 25, СОШ | ПД и РД 1-го этажа | в РД добавлено помещение 1.109 площадью 18,2; итог этажа 6234,1 → 6252,3 |
| 2 | Алтуфьевское, 79Б | лист РД с таблицами «Спецификация помещений» | таблица читается: номер, имя, площадь; итоги «Общий итог по этажу» 71,01 и 2797,27 |

Пилотная разметка (лист «ПРИМЕРЫ РАЗМЕТКИ» матрицы) обосновывает нарушение школы так: *«в экспликации после 1.108 следует 1.110»*. Это правило соседей положено в основу обработки отсутствующих помещений, см. Task 2.

На листах эталонного комплекта есть и надписи организаторов красным («ПД — ПОМЕЩЕНИЯ 1.109 НЕТ»). Это не часть чертежа, и разборщик не должен находить в них помещения: номер помещения — это отдельная строка, состоящая только из номера.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `services/api/prisma/schema.prisma` | `line_no` у `TextBlock`; модели `Check` и `EvidenceFragment` |
| `services/worker/app/pdf/extract.py` | строки текста с собственными координатами |
| `services/worker/app/pipeline.py` | сохранение строк; вызов сравнения; запись результатов |
| `services/worker/app/db.py` | сохранение строк, чтение строк страниц, запись `checks` и `evidence_fragments` |
| `services/worker/app/explication/__init__.py` | пакет |
| `services/worker/app/explication/parse.py` | помещения и итоги этажей со страницы, чистые функции |
| `services/worker/app/explication/compare.py` | сопоставление листов и помещений, чистые функции |
| `services/worker/specs/params/M-003.yaml` | `implemented: true` |

---

### Task 1: Строки текста вместо склеенных блоков

**Files:**
- Modify: `services/api/prisma/schema.prisma`
- Modify: `services/worker/app/pdf/extract.py`
- Modify: `services/worker/app/pipeline.py` (формирование строк для записи)
- Modify: `services/worker/app/db.py` (`save_pages`)
- Test: `services/worker/tests/test_extract.py`, `services/worker/tests/test_pipeline.py`

**Interfaces:**
- Produces:
  - `ExtractedLine(line_no: int, text: str, box: NormalizedBox)`;
  - `ExtractedBlock` получает поле `lines: list[ExtractedLine]`; поле `text` остаётся и равно строкам блока, **соединённым переводом строки**;
  - в таблице `text_blocks` одна строка базы на одну строку PDF, с колонками `block_no` и `line_no`.

- [ ] **Step 1: Добавить колонку**

В модели `TextBlock` в `services/api/prisma/schema.prisma`:

```prisma
  blockNo Int    @map("block_no")
  // One row per PDF line, not per block: a room label keeps its number and
  // its area on separate lines, and gluing them produced "1.0.95,95", which
  // no parser can split back into room 1.0.9 and 5.95 m².
  lineNo  Int    @default(0) @map("line_no")
```

Run: `cd services/api && npx prisma migrate dev --name text_lines`

- [ ] **Step 2: Написать падающий тест**

Дописать в `services/worker/tests/test_extract.py`:

```python
def test_lines_keep_their_own_text_and_box():
    """Adjacent lines of a block must not be glued together.

    A CAD room label is one block with the room number on one line and the
    area on the next. Joined without a separator they read "1.0.95,95" -
    room 1.0.9 of 5.95 m², or room 1.0.95 of 0.95? The file knows; a glued
    string does not.
    """
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    page.insert_htmlbox(pymupdf.Rect(20, 20, 200, 80), "<p>1.0.9<br>5,95</p>")
    raw = document.tobytes()
    document.close()

    block = extract_pages(raw, scan_char_threshold=0)[0].blocks[0]

    assert [line.text for line in block.lines] == ["1.0.9", "5,95"]
    assert block.text == "1.0.9\n5,95"
    first, second = block.lines
    assert first.box.y1 <= second.box.y0 + 0.01


def test_reference_room_label_is_split_into_lines():
    """The label that produced "1.0.95,95" on the reference sheet."""
    if not REFERENCE_PDF.exists():
        pytest.skip("reference package is not in the checkout")
    page = extract_pages(REFERENCE_PDF.read_bytes())[21]  # page 22

    texts = [[line.text for line in b.lines] for b in page.blocks]
    assert ["1.0.9", "5,95"] in texts
```

Если `insert_htmlbox` раскладывает `<br>` не в две строки одного блока, а в два блока — подобрать разметку, дающую именно две строки одного блока (например, две вставки `insert_text` с малым шагом по вертикали дают два блока, поэтому не подходят). Проверку второго теста на реальном листе не ослаблять.

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_extract.py -q`
Expected: FAIL — у `ExtractedBlock` нет поля `lines`.

- [ ] **Step 4: Реализовать**

В `services/worker/app/pdf/extract.py`:

```python
@dataclass(frozen=True)
class ExtractedLine:
    line_no: int
    text: str
    box: NormalizedBox


@dataclass(frozen=True)
class ExtractedBlock:
    block_no: int
    text: str
    box: NormalizedBox
    lines: list[ExtractedLine]


def _line_text(line: dict) -> str:
    # Spans are style runs within one line and may split a word, so they are
    # joined without a separator. Lines are distinct text objects and are not.
    return "".join(span.get("text", "") for span in line.get("spans", []))
```

Внутри цикла по блокам:

```python
                lines: list[ExtractedLine] = []
                for line in block.get("lines", []):
                    text = _line_text(line).strip()
                    if not text:
                        continue
                    shown = pymupdf.Rect(line["bbox"]) * rotation_matrix
                    lines.append(ExtractedLine(
                        line_no=len(lines),
                        text=text,
                        box=normalize_box((shown.x0, shown.y0, shown.x1, shown.y1), page_box),
                    ))
                if not lines:
                    continue
                block_text = "\n".join(line.text for line in lines)
                char_count += sum(len(line.text) for line in lines)
                displayed = pymupdf.Rect(block["bbox"]) * rotation_matrix
                blocks.append(ExtractedBlock(
                    block_no=len(blocks),
                    text=block_text,
                    box=normalize_box(
                        (displayed.x0, displayed.y0, displayed.x1, displayed.y1), page_box
                    ),
                    lines=lines,
                ))
```

Функцию `_block_text` удалить — она больше не используется.

- [ ] **Step 5: Записывать строки**

В `services/worker/app/pipeline.py`, где формируется словарь блоков для `save_pages`, заменить блочный список на построчный:

```python
                    "blocks": [
                        {"block_no": b.block_no, "line_no": line.line_no, "text": line.text,
                         "x0": line.box.x0, "y0": line.box.y0,
                         "x1": line.box.x1, "y1": line.box.y1}
                        for b in page.blocks
                        for line in b.lines
                    ],
```

В `services/worker/app/db.py`, в `save_pages`, вставка в `text_blocks` получает колонку `line_no`:

```python
                    await connection.executemany(
                        """
                        INSERT INTO text_blocks (id, page_id, block_no, line_no, text, x0, y0, x1, y1)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        """,
                        [
                            (str(uuid.uuid4()), page_id, b["block_no"], b["line_no"], b["text"],
                             b["x0"], b["y0"], b["x1"], b["y1"])
                            for b in page["blocks"]
                        ],
                    )
```

В тесте конвейера `test_pdf_documents_get_their_pages_extracted` проверить, что у записанного блока есть ключ `line_no`.

- [ ] **Step 6: Прогнать тесты**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest -q`
Expected: всё проходит, включая шлюзы поворота.

- [ ] **Step 7: Commit**

```bash
git add services/api/prisma services/worker
git commit -m "feat(worker): store pdf lines with their own boxes instead of glued blocks"
```

---

### Task 2: Разбор экспликаций со страницы

Это единственная задача плана, для которой код не приводится целиком, и это решение, а не пропуск. Разбор подписей и таблиц на настоящих чертежах — эвристика, которая доводится только против настоящих страниц: прототип, написанный при подготовке плана, ошибался трижды, и каждая ошибка проявлялась только на реальном листе. Поэтому план задаёт контракт, приёмочные тесты на эталонных страницах и накопленные наблюдения; реализация доводится, пока тесты не пройдут.

**Files:**
- Create: `services/worker/app/explication/__init__.py` (пустой)
- Create: `services/worker/app/explication/parse.py`
- Test: `services/worker/tests/test_explication_parse.py`

**Interfaces:**
- Consumes: `ExtractedPage`, `ExtractedLine` из Task 1.
- Produces:

```python
@dataclass(frozen=True)
class Room:
    number: str             # as written on the sheet: "1.0.9", "1.109", "7"
    area: float             # m²
    name: str | None        # "Тамбур", "Зона ожидания" or None when not found
    box: NormalizedBox      # union of the lines that make up the room


@dataclass(frozen=True)
class FloorTotal:
    label: str              # "Общий итог по этажу", "итоговая площадь"...
    area: float
    box: NormalizedBox


def find_rooms(page: ExtractedPage) -> list[Room]: ...
def find_floor_totals(page: ExtractedPage) -> list[FloorTotal]: ...
```

  Используется в Task 4.

**Наблюдения из разведки, на которые опираться:**

1. **Подпись на плане** — один блок, где строка с номером помещения стоит непосредственно перед строкой с площадью (Полярная, 17: блок `["1.0.9", "5,95"]`, иногда третьей строкой — название).
2. **Строка таблицы** — ячейки номер / имя / площадь, лежащие на одной горизонтали. Бывают как строками одного блока (Алтуфьевское, стр. 2: `["1", "Тех.помещение", "11.33 м²"]`), так и **разными блоками** (СОШ, стр. 20: «1.109» и «18,2» в разных блоках на одной высоте). Поэтому ряды таблицы собираются по вертикальному положению строк, а не по блокам.
3. **Номер помещения и площадь различаются записью.** Номера пишутся через точку («1.109», «1.0.9»), площади — через запятую («18,2», «5,95»). Число через точку считается площадью, только если за ним стоит единица «м²» («11.33 м²»). Без этого различителя «1.04» становится площадью соседнего помещения.
4. **Простое целое как номер помещения** («1», «7») допустимо только внутри таблицы экспликации — там, где рядом есть заголовок вида «Спецификация помещений», «Экспликация помещений», «Номер / Имя / Площадь». На плане целые числа — размеры («2390», «7000»).
5. **Номера на одном листе однородны по форме.** На Полярной номера трёхуровневые («1.0.9»); двухуровневые «2.1», «9.1» там — обозначения осей. В школе, наоборот, двухуровневые номера («1.109») настоящие. Форма доминирующих номеров листа определяет, что считать помещением на этом листе.
6. **Высотные отметки** («151,70», «+146,530», «-0,080») не площади. Отметка обычно со знаком или стоит отдельно, без номера помещения рядом.
7. **Итоги этажа** — строка с меткой («Общий итог по этажу», «итоговая площадь», «Итого по этажу») и значением площади в той же горизонтали.

- [ ] **Step 1: Написать приёмочные тесты**

Создать `services/worker/tests/test_explication_parse.py`:

```python
from pathlib import Path

import pytest

from app.explication.parse import find_floor_totals, find_rooms
from app.pdf.extract import extract_pages

REFERENCE_PDF = Path(__file__).resolve().parents[3] / "Задание" / "Комплект_предметной_разметки.pdf"

pytestmark = pytest.mark.skipif(not REFERENCE_PDF.exists(), reason="reference package is not in the checkout")


@pytest.fixture(scope="module")
def pages():
    return extract_pages(REFERENCE_PDF.read_bytes())


def rooms_of(pages, page_no):
    return {room.number: room for room in find_rooms(pages[page_no - 1])}


@pytest.mark.parametrize("pd_page,rd_page", [(21, 22), (23, 24)])
def test_negative_reference_pair_reads_the_same_rooms_on_both_sheets(pages, pd_page, rd_page):
    """Полярная, 17: the pilot markup's verified negative pair.

    The same floor in design and working documentation, with no substantive
    difference. Any room found on one sheet and not the other here is a parse
    error, and in the protocol it would be a false violation - exactly what
    the FPR <= 0.10 threshold of the specification counts.
    """
    pd_rooms, rd_rooms = rooms_of(pages, pd_page), rooms_of(pages, rd_page)

    assert len(pd_rooms) >= 20
    assert set(pd_rooms) == set(rd_rooms), (
        sorted(set(pd_rooms) ^ set(rd_rooms))
    )
    for number in pd_rooms:
        assert pd_rooms[number].area == pytest.approx(rd_rooms[number].area), number


def test_room_label_on_a_plan_is_read(pages):
    rooms = rooms_of(pages, 22)
    assert rooms["1.0.9"].area == pytest.approx(5.95)


def test_the_added_school_room_is_read_from_the_working_documentation(pages):
    """Полярная, 25: the pilot's candidate. RD adds room 1.109 of 18.2 m²."""
    rd_rooms = rooms_of(pages, 20)
    assert rd_rooms["1.109"].area == pytest.approx(18.2)


def test_the_design_documentation_has_the_neighbours_but_not_the_added_room(pages):
    """The pilot's own argument: after 1.108 comes 1.110 in the design sheet."""
    pd_rooms = rooms_of(pages, 19)
    assert "1.109" not in pd_rooms
    assert "1.108" in pd_rooms and "1.110" in pd_rooms


def test_floor_totals_of_the_school_are_read(pages):
    pd_totals = [t.area for t in find_floor_totals(pages[18])]
    rd_totals = [t.area for t in find_floor_totals(pages[19])]
    assert 6234.1 in pd_totals
    assert 6252.3 in rd_totals


def test_explication_table_with_plain_room_numbers_is_read(pages):
    """Алтуфьевское, 79Б: a room table where numbers are plain integers."""
    rooms = rooms_of(pages, 2)
    assert rooms["1"].area == pytest.approx(11.33)
    assert rooms["1"].name == "Тех.помещение"
    totals = sorted(t.area for t in find_floor_totals(pages[1]))
    assert totals == pytest.approx([71.01, 2797.27])


def test_dimension_numbers_on_a_plan_are_not_rooms(pages):
    """Plain integers on a plan are dimensions in millimetres, not rooms."""
    for page_no in (21, 22, 23, 24):
        numbers = set(rooms_of(pages, page_no))
        assert not any(n.isdigit() for n in numbers), (page_no, sorted(n for n in numbers if n.isdigit()))


def test_every_room_box_lies_inside_the_page(pages):
    for page_no in (2, 19, 20, 21, 22):
        for room in find_rooms(pages[page_no - 1]):
            box = room.box
            assert 0.0 <= box.x0 <= box.x1 <= 1.0
            assert 0.0 <= box.y0 <= box.y1 <= 1.0
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_explication_parse.py -q`
Expected: FAIL, модуль не существует.

- [ ] **Step 3: Реализовать и довести**

Реализовать `find_rooms` и `find_floor_totals`, опираясь на наблюдения выше. Каждая эвристика — отдельная функция с комментарием, **на каком реальном листе она обнаружена необходимой**.

Правила доводки:

- **Тесты не ослаблять.** Нельзя менять номера страниц, ожидаемые значения, заменять точное равенство множеств на «почти равно» или снижать `>= 20`.
- Если какой-то тест не удаётся пройти, не нарушая другие, — остановиться и описать в отчёте: какой тест, какие фактические значения, что пробовалось и почему не вышло. Частичный результат с честным описанием ценнее подогнанного.
- При сомнении эвристика **не** сообщает помещение. Пропущенное помещение не даёт ложного нарушения, выдуманное — даёт.

- [ ] **Step 4: Прогнать тесты**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest -q`
Expected: всё проходит.

- [ ] **Step 5: Commit**

```bash
git add services/worker/app/explication services/worker/tests/test_explication_parse.py
git commit -m "feat(worker): read room explications from plan labels and room tables"
```

---

### Task 3: Таблицы `checks` и `evidence_fragments`

**Files:**
- Modify: `services/api/prisma/schema.prisma`
- Create: миграция

**Interfaces:**
- Produces: таблицы `checks` и `evidence_fragments`. Поля — из раздела 10 ТЗ и листа «СХЕМА GOLD» матрицы. Воркер пишет в них через asyncpg; колонки — контракт.

- [ ] **Step 1: Добавить модели**

В `services/api/prisma/schema.prisma`:

```prisma
// One evidence group: object + atomic parameter/rule + the current sources
// compared (section 9.2). Field names follow section 10 of the specification
// and the GOLD schema sheet of the customer's matrix.
model Check {
  id                 String   @id @default(uuid())
  processId          String   @map("process_id")
  objectId           String   @map("object_id")
  paramId            Int?     @map("param_id")
  paramCode          String   @map("param_code") @db.VarChar(20)
  // Stable across re-runs of the same package, so an incremental update can
  // replace a group instead of duplicating it.
  evidenceGroupId    String   @map("evidence_group_id")
  // What this group is about within the parameter: a room number, a floor
  // total, or null for a parameter-level outcome.
  subject            String?
  expectedValue      String?  @map("expected_value")
  actualValue        String?  @map("actual_value")
  delta              String?
  // COMPLETE / MISSING_EVIDENCE / NOT_APPLICABLE / NOT_COMPARABLE /
  // CLARIFICATION_REQUIRED - a statement about the input, never a violation.
  completenessStatus String   @map("completeness_status") @db.VarChar(30)
  // CANDIDATE / NEGATIVE_VERIFIED from the engine; CONFIRMED_VIOLATION only
  // ever from an inspector's verdict. Null when nothing could be compared.
  findingStatus      String?  @map("finding_status") @db.VarChar(30)
  reviewPriority     String   @map("review_priority") @db.VarChar(20)
  rationale          String?
  matrixVersion      String   @map("matrix_version") @db.VarChar(20)
  createdAt          DateTime @default(now()) @map("created_at")

  process   Process            @relation(fields: [processId], references: [id], onDelete: Cascade)
  fragments EvidenceFragment[]

  @@unique([processId, evidenceGroupId])
  @@index([processId, findingStatus])
  @@map("checks")
}

model EvidenceFragment {
  id              String @id @default(uuid())
  checkId         String @map("check_id")
  evidenceGroupId String @map("evidence_group_id")
  fileId          String @map("file_id")
  fileSha256      String @map("file_sha256") @db.Char(64)
  stage           DocStage
  documentCode    String? @map("document_code")
  revision        String?
  approvalStatus  ApprovalStatus @map("approval_status")
  sheetPage       Int    @map("sheet_page")
  // Normalized to [0;1] against the displayed page, after CropBox, MediaBox
  // and Rotate (section 9.1, item 4).
  x0              Float
  y0              Float
  x1              Float
  y1              Float
  extractedValue  String? @map("extracted_value")
  // "expected" for the reference source, "actual" for the one checked against it.
  role            String @db.VarChar(10)

  check Check      @relation(fields: [checkId], references: [id], onDelete: Cascade)
  file  FileRecord @relation(fields: [fileId], references: [id])

  @@index([checkId])
  @@map("evidence_fragments")
}
```

В модель `Process` добавить `checks Check[]`, в модель `FileRecord` — `evidence EvidenceFragment[]`.

- [ ] **Step 2: Создать миграцию и проверить**

Run: `cd services/api && npx prisma migrate dev --name checks_and_evidence`
Затем: `npx tsc -p tsconfig.json --noEmit && npm test`
Expected: миграция применена, типы чистые, тесты проходят.

- [ ] **Step 3: Commit**

```bash
git add services/api/prisma
git commit -m "feat(db): add checks and evidence fragments from section 10"
```

---

### Task 4: Сравнение экспликаций и запись результатов

**Files:**
- Create: `services/worker/app/explication/compare.py`
- Modify: `services/worker/app/db.py`
- Modify: `services/worker/app/pipeline.py`
- Modify: `services/worker/specs/params/M-003.yaml` — `implemented: true`
- Test: `services/worker/tests/test_explication_compare.py`, `services/worker/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `Room`, `FloorTotal`, `find_rooms`, `find_floor_totals` из Task 2; `select_source_revision` из `app/domain/revisions.py`; `evaluate_all`, `load_specs` из `app/params/`; таблицы из Task 3.
- Produces:

```python
@dataclass(frozen=True)
class SheetRooms:
    file_id: str
    page_no: int
    # Keyed by room_key(room, rooms) from parse.py: the bare number when it is
    # unique on the sheet, "scope|number" when two tables reuse it.
    rooms: dict[str, Room]
    totals: list[FloorTotal]


@dataclass(frozen=True)
class RoomFinding:
    subject: str                 # "room 1.109" or "floor total"
    status: str                  # "CANDIDATE" or "NEGATIVE_VERIFIED"
    expected: str | None         # value on the design sheet, None when absent
    actual: str | None           # value on the working sheet, None when absent
    delta: str | None
    rationale: str
    expected_sheet: SheetRooms
    expected_box: NormalizedBox
    actual_sheet: SheetRooms
    actual_box: NormalizedBox


def pair_sheets(pd: list[SheetRooms], rd: list[SheetRooms]) -> list[tuple[SheetRooms, SheetRooms]]: ...
def compare_sheets(pd: SheetRooms, rd: SheetRooms) -> list[RoomFinding]: ...
```

**Правила сравнения:**

1. **Пары листов** — по пересечению множеств номеров помещений. Лист РД сопоставляется с листом ПД, с которым у него наибольшая доля общих номеров, если эта доля не меньше половины меньшего из множеств. Лист без пары не сравнивается и не порождает находок.
2. **Помещение есть на обоих листах, площади равны** (с точностью до 0,005 м²) — `NEGATIVE_VERIFIED`. Такие группы ТЗ требует формировать обязательно: по ним считается доля ложных срабатываний.
3. **Площади различаются** — `CANDIDATE`, дельта со знаком.
4. **Помещение есть только на одном листе** — `CANDIDATE` **только если на другом листе есть оба соседа по номеру**: для 1.109 — 1.108 и 1.110. Это доказательство пилотной разметки. Без соседей отсутствие ничего не доказывает — находка не создаётся. Доказательство отсутствия на другом листе — прямоугольник, охватывающий обоих соседей.
5. **Итоги этажа** — если на обоих листах пары ровно по одному итогу этажа: равны — `NEGATIVE_VERIFIED`, различаются — `CANDIDATE`. Иначе итоги не сравниваются.

Соседи номера определяются так: номер разбивается по точкам, последняя часть — целое; соседи — та же приставка с последней частью на единицу меньше и больше, записанные той же шириной. Для «1.0.9» — «1.0.8» и «1.0.10»; для «1.109» — «1.108» и «1.110»; для простого «7» — «6» и «8». **Соседи ищутся в той же области (`Room.scope`)**, что и само помещение: на листе торгового здания «6» антресоли не сосед «7» первого этажа. Буквенные номера («А», «Б») соседей не имеют, и их отсутствие находкой не становится.

Помещения на листе ключуются функцией `room_key` из `parse.py`, а не голым номером: две таблицы одного листа могут нумеровать помещения одинаково. Пары листов считаются по пересечению этих ключей.

- [ ] **Step 1: Написать тесты сравнения**

Создать `services/worker/tests/test_explication_compare.py`:

```python
from pathlib import Path

import pytest

from app.explication.compare import SheetRooms, compare_sheets, pair_sheets
from app.explication.parse import Room, find_floor_totals, find_rooms
from app.pdf.extract import extract_pages
from app.pdf.geometry import NormalizedBox

REFERENCE_PDF = Path(__file__).resolve().parents[3] / "Задание" / "Комплект_предметной_разметки.pdf"
BOX = NormalizedBox(0.1, 0.1, 0.2, 0.2)


def sheet(file_id, rooms, totals=()):
    return SheetRooms(file_id, 1, {r.number: r for r in rooms}, list(totals))


def room(number, area):
    return Room(number, area, None, BOX)


def test_equal_rooms_are_verified_negatives():
    findings = compare_sheets(sheet("pd", [room("1.1", 10.0)]), sheet("rd", [room("1.1", 10.0)]))
    assert [(f.subject, f.status) for f in findings] == [("room 1.1", "NEGATIVE_VERIFIED")]


def test_a_changed_area_is_a_candidate_with_a_signed_delta():
    findings = compare_sheets(sheet("pd", [room("1.1", 10.0)]), sheet("rd", [room("1.1", 12.5)]))
    finding = findings[0]
    assert finding.status == "CANDIDATE"
    assert (finding.expected, finding.actual, finding.delta) == ("10.00", "12.50", "+2.50")


def test_an_added_room_between_present_neighbours_is_a_candidate():
    pd = sheet("pd", [room("1.108", 5.0), room("1.110", 6.0)])
    rd = sheet("rd", [room("1.108", 5.0), room("1.109", 18.2), room("1.110", 6.0)])

    added = [f for f in compare_sheets(pd, rd) if f.subject == "room 1.109"]
    assert len(added) == 1
    assert added[0].status == "CANDIDATE"
    assert (added[0].expected, added[0].actual) == (None, "18.20")


def test_an_absence_without_neighbours_proves_nothing():
    """A room missing from a sheet whose neighbours are missing too is a gap in
    parsing or in the sheet, not evidence that the room was added."""
    pd = sheet("pd", [room("1.100", 5.0)])
    rd = sheet("rd", [room("1.100", 5.0), room("1.109", 18.2)])

    assert not [f for f in compare_sheets(pd, rd) if f.subject == "room 1.109"]


def test_sheets_are_paired_by_shared_room_numbers():
    first = sheet("pd-1", [room(f"1.{i}", 1.0) for i in range(1, 11)])
    second = sheet("pd-2", [room(f"2.{i}", 1.0) for i in range(1, 11)])
    rd = sheet("rd-2", [room(f"2.{i}", 1.0) for i in range(1, 10)])

    assert [(p.file_id, r.file_id) for p, r in pair_sheets([first, second], [rd])] == [("pd-2", "rd-2")]


def test_a_sheet_without_a_counterpart_is_not_compared():
    pd = sheet("pd", [room(f"1.{i}", 1.0) for i in range(1, 11)])
    rd = sheet("rd", [room(f"9.{i}", 1.0) for i in range(1, 11)])
    assert pair_sheets([pd], [rd]) == []


@pytest.mark.skipif(not REFERENCE_PDF.exists(), reason="reference package is not in the checkout")
class TestReferencePairs:
    @pytest.fixture(scope="class")
    def pages(self):
        return extract_pages(REFERENCE_PDF.read_bytes())

    def sheet_of(self, pages, page_no, file_id):
        page = pages[page_no - 1]
        return SheetRooms(file_id, page_no, {r.number: r for r in find_rooms(page)},
                          find_floor_totals(page))

    @pytest.mark.parametrize("pd_page,rd_page", [(21, 22), (23, 24)])
    def test_negative_pair_yields_no_candidates(self, pages, pd_page, rd_page):
        """The pilot's verified negative pair must come out clean."""
        findings = compare_sheets(self.sheet_of(pages, pd_page, "pd"), self.sheet_of(pages, rd_page, "rd"))

        assert [f.subject for f in findings if f.status == "CANDIDATE"] == []
        assert sum(f.status == "NEGATIVE_VERIFIED" for f in findings) >= 20

    def test_school_pair_yields_the_added_room_and_the_changed_total(self, pages):
        findings = compare_sheets(self.sheet_of(pages, 19, "pd"), self.sheet_of(pages, 20, "rd"))

        candidates = {f.subject: f for f in findings if f.status == "CANDIDATE"}
        assert candidates["room 1.109"].actual == "18.20"
        assert candidates["floor total"].expected == "6234.10"
        assert candidates["floor total"].actual == "6252.30"
        assert candidates["floor total"].delta == "+18.20"
```

- [ ] **Step 2: Убедиться, что тесты падают, реализовать `compare.py`, добиться прохождения**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_explication_compare.py -q`

Значения в находках — строки с двумя знаками после точки (`"18.20"`), дельта со знаком (`"+2.50"`, `"-1.00"`). Обоснование (`rationale`) — одна фраза по-русски, её увидит инспектор: например, «В РД добавлено помещение 1.109 площадью 18,20 м²; в ПД между 1.108 и 1.110 его нет».

Тест школы проверяет наличие двух ожидаемых кандидатов, но не запрещает другие. Если сравнение даёт **другие** кандидаты на паре 19↔20, перечислить их в отчёте с фактическими значениями: пилотная разметка описывает только добавление 1.109, и лишние кандидаты — вероятно, ошибки разбора.

- [ ] **Step 3: Запись результатов в базу**

В `services/worker/app/db.py` добавить метод `save_checks(process_id: str, object_id: str, checks: list[dict]) -> None`: в одной транзакции удаляет прежние `checks` процесса (каскадом уходят фрагменты) и вставляет новые вместе с их фрагментами. Каждый элемент `checks` — словарь с ключами колонок таблицы `checks` и списком `fragments` с ключами колонок `evidence_fragments`. Идентификаторы — `uuid4` на стороне воркера. `param_id` заполнять подзапросом `(SELECT id FROM params WHERE code = $n)`.

- [ ] **Step 4: Вызов из конвейера**

В `services/worker/app/pipeline.py` после извлечения страниц и до перевода процесса в `READY`:

1. Для стадий ПД и РД определить актуальные файлы. **Редакции конкурируют только внутри одного документа**: PDF-файлы стадии группируются по `(discipline, document_code)`, и `select_source_revision` вызывается на каждую группу отдельно.

   Это не деталь реализации, а исправление модели. `select_source_revision` возвращает один файл — она выбирает редакцию **документа**. Стадия же состоит из многих документов с разными шифрами. Вызванная на всю стадию или марку, функция объявит два разных утверждённых листа «конфликтом редакций» и заблокирует сравнение почти на любом настоящем пакете. Нынешний вызов в конвейере (по стадии целиком, только для лога) делает именно это — заменить его группировкой по документу.

   - Группа с результатом `COMPLETE` отдаёт свой файл в сравнение.
   - Группа с `CLARIFICATION_REQUIRED` или `NOT_COMPARABLE` в сравнение **не** попадает: устаревшая редакция не может быть эталоном. На такую группу записывается проверка M-003 с этим статусом комплектности и причиной.
   - Файл без `document_code` — неполные метаданные: п. 9.1 ТЗ называет шифр обязательным для выбора актуальной редакции. Такой файл не сравнивается, по нему записывается `CLARIFICATION_REQUIRED` с причиной «не указан шифр документа». Угадывать, редакцией какого документа он является, нельзя.
2. Для каждой страницы актуальных файлов прочитать строки из базы, построить `SheetRooms` (`find_rooms`, `find_floor_totals`). Чтение строк страницы — новый метод `Database.get_page_lines(file_id)`, возвращающий страницы файла со строками в порядке `page_no, block_no, line_no`.
3. `pair_sheets`, затем `compare_sheets` по каждой паре. Каждая `RoomFinding` → одна запись `checks` для M-003:
   - `evidence_group_id` = `f"{object_id}:M-003:{subject}"`;
   - `completeness_status = "COMPLETE"`, `finding_status` = статус находки;
   - два фрагмента: `role="expected"` с листа ПД, `role="actual"` с листа РД; `file_sha256`, `stage`, `document_code`, `revision`, `approval_status` — из строки файла.
4. Если сравнивать нечего (нет пары листов ПД и РД) — одна запись M-003 со статусом комплектности `MISSING_EVIDENCE` или `NOT_COMPARABLE` и причиной.
5. Для **остальных** параметров матрицы — `evaluate_all(load_specs(), evaluators={})`, по одной записи на параметр с `completeness_status = "NOT_COMPARABLE"`, `finding_status = NULL` и причиной из движка. M-003 из этого списка исключается — он уже записан выше.
6. `db.save_checks(...)` одним вызовом.

Сбой на этом этапе, как и на извлечении страниц, логируется и не останавливает обработку пакета: процесс всё равно доходит до `READY`, а M-003 получает `NOT_COMPARABLE` с текстом ошибки.

В `services/worker/specs/params/M-003.yaml` выставить `implemented: true`. База его не перезапишет (досев не трогает существующие строки) — поэтому дополнительно выполнить на живой базе `UPDATE params SET implemented = true WHERE code = 'M-003'` и описать это в отчёте. Для чистой базы стенда достаточно файла.

- [ ] **Step 5: Тесты конвейера**

В `services/worker/tests/test_pipeline.py` добавить тест на подделках: пакет из двух PDF (ПД и РД одного этажа, разные площади одного помещения) приводит к сохранённым проверкам, среди которых одна `CANDIDATE` по M-003 с двумя фрагментами, и 131 запись `NOT_COMPARABLE` по остальным параметрам. `FakeDb` дополнить методами `get_page_lines` и `save_checks`.

Ещё три теста на выбор актуальных файлов:

- два **разных** документа ПД (разные `document_code`), оба утверждены — оба участвуют в сравнении, `CLARIFICATION_REQUIRED` не возникает;
- две редакции **одного** документа ПД (одинаковый `document_code`) без связи через `predecessor_id` и без дат — по M-003 записан `CLARIFICATION_REQUIRED`, кандидатов нет;
- файл ПД без `document_code` — по нему `CLARIFICATION_REQUIRED` с причиной про шифр, в сравнение он не попадает.

- [ ] **Step 6: Прогнать тесты и commit**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest -q`

```bash
git add services/worker
git commit -m "feat(worker): compare room explications between design and working documentation"
```

---

### Task 5: Сквозная проверка на эталонных листах

**Files:**
- Modify: `tests/e2e/test_upload_flow.sh`
- Create: `tests/e2e/make_reference_package.py`

**Interfaces:**
- Consumes: всё выше.

- [ ] **Step 1: Собрать пакет из эталонных листов**

Создать `tests/e2e/make_reference_package.py`: из `Задание/Комплект_предметной_разметки.pdf` вырезать страницы в отдельные файлы и написать реестр.

```python
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

SOURCE = Path(__file__).resolve().parents[2] / "Задание" / "Комплект_предметной_разметки.pdf"

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
```

Школа и Полярная — разные объекты, но в одном пакете это не мешает проверке: листы спариваются по номерам помещений, а номера двух объектов не пересекаются. Если окажется, что пересекаются, — разнести их в два пакета.

- [ ] **Step 2: Шаги 11 и 12 сквозного сценария**

Дописать в `tests/e2e/test_upload_flow.sh` перед финальным `PASS`: создать объект, собрать пакет скриптом, загрузить четыре PDF и реестр, запустить процесс, дождаться `READY`, затем запросами к базе проверить:

- есть `CANDIDATE` по M-003 с `subject = 'room 1.109'` и `actual_value = '18.20'`;
- среди проверок пары Полярной нет ни одного `CANDIDATE`;
- у каждого `CANDIDATE` ровно два фрагмента доказательств, `expected` и `actual`;
- проверок по процессу — не меньше 132.

- [ ] **Step 3: Прогнать на живой системе**

```bash
docker compose up -d --build
bash tests/e2e/test_upload_flow.sh
```

Expected: `PASS`.

Показать фактическое содержимое кандидатов:

```bash
docker compose exec -T postgres psql -U inspector -d inspector -c \
  "SELECT subject, expected_value, actual_value, delta, left(rationale, 80) FROM checks WHERE finding_status = 'CANDIDATE' ORDER BY created_at DESC LIMIT 10;"
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): run the explication comparison on real reference sheets"
```

---

## Что этот план сознательно не делает

- **Назначение помещений.** Пилот Алтуфьевского касается и смены назначений. Название помещения разбор находит, но сравнение названий между стадиями — это семантическое сопоставление («Техническое» против «Склад ГСМ»), то есть модуль свободного поиска гипотез (п. 9.5 ТЗ). Отдельный план.
- **ТЭП и общая площадь здания (M-002).** Таблицы ТЭП — следующий шаг извлечения после экспликаций.
- **Сопоставление по ИД.** Исполнительная документация — акты и схемы, а не экспликации.
- **API протокола и карточек.** Данные для экрана верификации появляются в этом плане; эндпоинты, которые их отдают в форме типов фронтенда, — следующий план.
