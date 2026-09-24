# План 2. Страницы, текстовый слой и координаты

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Из каждого принятого PDF извлекаются страницы с текстовыми фрагментами и нормализованными координатами `[0;1]`, устойчивыми к повороту листа и обрезке; страницы без текстового слоя помечаются как требующие OCR; результат лежит в базе и готов к индексации.

**Architecture:** Этап B конвейера из раздела 4 архитектуры. Чистые функции над байтами PDF (`app/pdf/`), отделённые от доступа к базе и хранилищу, как это уже сделано для доменной логики. Нормализация координат — отдельная функция с собственным тестовым шлюзом, потому что ошибка в ней не проявляется как сбой: подсветка просто оказывается не там, а система выглядит работающей.

**Tech Stack:** Python 3.11, PyMuPDF, asyncpg, MinIO, Prisma (только схема и миграция), PostgreSQL 16.

## Global Constraints

- Внешние сетевые вызовы запрещены полностью, включая загрузку моделей при старте.
- GPU на машине разработки отсутствует. Весь код этого плана — CPU-только. OCR (этап C) в объём **не входит**: страницы-сканы лишь помечаются.
- Комментарии в коде — по-английски, объясняют *почему*, а не *что*. Комментарии вида «добавлено», «изменено», «было/стало» запрещены.
- Доменные модули `services/worker/app/domain/` в этом плане не изменяются.
- Структурный лог: `timestamp`, `level`, `service`, `message`, `request_id`, `user_id`. Уже обеспечивается `app/logging_setup.py`, ломать формат нельзя.
- Изоляция ошибок в цикле потребления (`_consume_messages`, `_process_message` в `app/consumer.py`) не изменяется.
- PyMuPDF распространяется под AGPL-3.0. Для хакатона это приемлемо, но если возникнет вопрос лицензирования поставки — заменой служит `pypdfium2` (Apache-2.0) с тем же контрактом извлечения. Код поэтому обращается к PyMuPDF только внутри `app/pdf/`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `services/api/prisma/schema.prisma` | таблицы `pages` и `text_blocks` |
| `services/worker/app/pdf/__init__.py` | пакет |
| `services/worker/app/pdf/geometry.py` | нормализация координат, чистая функция |
| `services/worker/app/pdf/extract.py` | извлечение страниц и текстовых блоков из байтов PDF |
| `services/worker/app/pdf/render.py` | рендер страницы в PNG |
| `services/worker/app/db.py` | добавляется сохранение страниц и блоков |
| `services/worker/app/storage.py` | добавляется запись объекта |
| `services/worker/app/pipeline.py` | вызов этапа B после разбора реестра |
| `services/worker/tests/test_geometry.py` | тесты нормализации, включая четыре угла поворота |
| `services/worker/tests/test_extract.py` | тесты извлечения, включая реальный PDF из `Задание/` |
| `services/worker/tests/test_render.py` | тесты рендера |

---

### Task 1: Таблицы страниц и текстовых блоков

**Files:**
- Modify: `services/api/prisma/schema.prisma`
- Create: миграция через `prisma migrate dev`

**Interfaces:**
- Consumes: существующая модель `FileRecord`.
- Produces: таблицы `pages` и `text_blocks`. Воркер пишет в них напрямую через asyncpg, поэтому имена колонок — часть контракта: `pages(id, file_id, page_no, width_pt, height_pt, rotation, char_count, needs_ocr, image_key, created_at)`, `text_blocks(id, page_id, block_no, text, x0, y0, x1, y1)`.

- [ ] **Step 1: Добавить модели в схему**

В `services/api/prisma/schema.prisma` добавить:

```prisma
model Page {
  id        String   @id @default(uuid())
  fileId    String   @map("file_id")
  pageNo    Int      @map("page_no")
  widthPt   Float    @map("width_pt")
  heightPt  Float    @map("height_pt")
  rotation  Int
  charCount Int      @map("char_count")
  // Set when the page carries too little text to be read without OCR. Stage C
  // is out of scope here, so the flag is recorded and acted on later.
  needsOcr  Boolean  @default(false) @map("needs_ocr")
  imageKey  String?  @map("image_key")
  createdAt DateTime @default(now()) @map("created_at")

  file   FileRecord  @relation(fields: [fileId], references: [id], onDelete: Cascade)
  blocks TextBlock[]

  @@unique([fileId, pageNo])
  @@map("pages")
}

model TextBlock {
  id      String @id @default(uuid())
  pageId  String @map("page_id")
  blockNo Int    @map("block_no")
  text    String
  // Normalized to [0;1] against the displayed page box, so a highlight drawn
  // from these numbers lands correctly whatever the sheet size or rotation.
  x0      Float
  y0      Float
  x1      Float
  y1      Float

  page Page @relation(fields: [pageId], references: [id], onDelete: Cascade)

  @@index([pageId])
  @@map("text_blocks")
}
```

В модель `FileRecord` добавить обратную связь:

```prisma
  pages Page[]
```

- [ ] **Step 2: Создать миграцию**

Run: `cd services/api && npx prisma migrate dev --name pages_and_text_blocks`
Expected: создаётся каталог миграции, вывод содержит `Your database is now in sync with your schema.`

- [ ] **Step 3: Проверить, что таблицы существуют**

Run:
```bash
docker compose exec -T postgres psql -U inspector -d inspector -c "\d pages" -c "\d text_blocks"
```
Expected: обе таблицы выведены, у `pages` есть уникальный индекс по `(file_id, page_no)`.

- [ ] **Step 4: Commit**

```bash
git add services/api/prisma
git commit -m "feat(db): add pages and text blocks tables"
```

---

### Task 2: Нормализация координат

Это ядро всего плана. Архитектура называет ошибку нормализации самым дорогим тихим дефектом: повёрнутый лист без учёта `Rotate` даёт подсветку, смещённую на 90°, при этом ничего не падает и всё выглядит работающим. Поэтому функция пишется и покрывается тестами **до** того, как попадёт в конвейер.

**Files:**
- Create: `services/worker/app/pdf/__init__.py`
- Create: `services/worker/app/pdf/geometry.py`
- Test: `services/worker/tests/test_geometry.py`

**Interfaces:**
- Produces: `NormalizedBox(x0: float, y0: float, x1: float, y1: float)` и `normalize_box(box: tuple[float, float, float, float], page_rect: tuple[float, float, float, float]) -> NormalizedBox`. Используется в Task 3.

- [ ] **Step 1: Написать падающий тест**

Создать `services/worker/tests/test_geometry.py`:

```python
import pytest

from app.pdf.geometry import NormalizedBox, normalize_box


def test_box_covering_the_whole_page_is_the_unit_square():
    assert normalize_box((0, 0, 400, 800), (0, 0, 400, 800)) == NormalizedBox(0.0, 0.0, 1.0, 1.0)


def test_box_in_the_top_left_quarter():
    box = normalize_box((0, 0, 200, 400), (0, 0, 400, 800))
    assert box == NormalizedBox(0.0, 0.0, 0.5, 0.5)


def test_page_origin_is_subtracted():
    """A CropBox that does not start at zero must not shift every coordinate.

    Sheets exported from CAD routinely carry a non-zero origin, and ignoring it
    offsets every highlight on the page by the same amount - a defect that looks
    like a systematic drawing error rather than a coordinate bug.
    """
    box = normalize_box((100, 200, 300, 600), (100, 200, 500, 1000))
    assert box == NormalizedBox(0.0, 0.0, 0.5, 0.5)


def test_coordinates_outside_the_page_are_clamped():
    box = normalize_box((-50, -50, 450, 900), (0, 0, 400, 800))
    assert box == NormalizedBox(0.0, 0.0, 1.0, 1.0)


def test_inverted_input_is_returned_in_order():
    box = normalize_box((300, 600, 100, 200), (0, 0, 400, 800))
    assert box.x0 <= box.x1 and box.y0 <= box.y1


def test_degenerate_page_is_refused():
    with pytest.raises(ValueError):
        normalize_box((0, 0, 10, 10), (0, 0, 0, 800))
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_geometry.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'app.pdf'`

- [ ] **Step 3: Реализовать**

Создать пустой `services/worker/app/pdf/__init__.py` и `services/worker/app/pdf/geometry.py`:

```python
"""Page coordinates expressed in the space a reader actually sees.

Every highlight the inspector is shown, and every bbox stored as evidence, is
built from these numbers. They are normalized to [0;1] against the displayed
page box so they stay correct across sheet sizes, and they are taken relative
to that box's own origin so a non-zero CropBox does not shift them.
"""

from dataclasses import dataclass

Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class NormalizedBox:
    x0: float
    y0: float
    x1: float
    y1: float


def _clamp(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


def normalize_box(box: Box, page_rect: Box) -> NormalizedBox:
    page_x0, page_y0, page_x1, page_y1 = page_rect
    width = page_x1 - page_x0
    height = page_y1 - page_y0
    if width <= 0 or height <= 0:
        raise ValueError(f"page box has no area: {page_rect!r}")

    xs = sorted((_clamp((box[0] - page_x0) / width), _clamp((box[2] - page_x0) / width)))
    ys = sorted((_clamp((box[1] - page_y0) / height), _clamp((box[3] - page_y0) / height)))
    return NormalizedBox(xs[0], ys[0], xs[1], ys[1])
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_geometry.py -q`
Expected: `6 passed`

- [ ] **Step 5: Написать тест на четыре угла поворота**

Это тот самый шлюз. PDF-страницы создаются прямо в тесте, чтобы положение метки было известно точно.

Дописать в `services/worker/tests/test_geometry.py`:

```python
import pymupdf

from app.pdf.geometry import normalize_box


def _page_with_marker(rotation: int) -> tuple[Box, Box]:
    """Build a one-page PDF with a marker near the unrotated top-left corner.

    Returns the marker's bbox and the page box, both as PyMuPDF reports them
    after the rotation has been applied.
    """
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    page.insert_text((20, 40), "MARKER", fontsize=24)
    page.set_rotation(rotation)

    raw = document.tobytes()
    document.close()

    reopened = pymupdf.open(stream=raw, filetype="pdf")
    page = reopened[0]
    rect = page.rect
    marker = next(
        block for block in page.get_text("dict")["blocks"]
        if block.get("type") == 0
    )
    box = tuple(marker["bbox"])
    page_box = (rect.x0, rect.y0, rect.x1, rect.y1)
    reopened.close()
    return box, page_box


def test_rotation_moves_the_marker_to_a_different_corner():
    """Four rotations must give four different positions.

    If Rotate is ignored, all four come out identical - the page still renders
    rotated, so the highlight silently lands 90 degrees away from its subject.
    This assertion is the one that fails when that happens.
    """
    positions = {}
    for rotation in (0, 90, 180, 270):
        box, page_box = _page_with_marker(rotation)
        normalized = normalize_box(box, page_box)
        positions[rotation] = (round(normalized.x0, 2), round(normalized.y0, 2))

    assert len(set(positions.values())) == 4, positions


def test_rotation_maps_the_marker_to_the_expected_quadrant():
    """Pins the mapping found empirically, so a later change cannot flip it.

    If this fails while the test above passes, rotation is still honoured but
    the direction changed - check the PyMuPDF version before touching the code.
    """
    expected = {0: "left-top", 90: "right-top", 180: "right-bottom", 270: "left-bottom"}
    for rotation, quadrant in expected.items():
        box, page_box = _page_with_marker(rotation)
        normalized = normalize_box(box, page_box)
        horizontal = "left" if normalized.x0 < 0.5 else "right"
        vertical = "top" if normalized.y0 < 0.5 else "bottom"
        assert f"{horizontal}-{vertical}" == quadrant, (rotation, normalized)
```

- [ ] **Step 6: Запустить и разобраться с результатом**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_geometry.py -q`

Первый тест (`test_rotation_moves_the_marker_to_a_different_corner`) обязан пройти. Если он падает — координаты не учитывают поворот, и это дефект реализации, а не теста.

Второй тест закрепляет направление поворота. Если он падает, **сначала выясните фактическое соответствие** — выведите значения для всех четырёх углов, — и приведите в тесте то, что даёт библиотека, сопроводив комментарием. Не подгоняйте первый тест.

Expected: `8 passed`

- [ ] **Step 7: Commit**

```bash
git add services/worker/app/pdf services/worker/tests/test_geometry.py
git commit -m "feat(worker): normalize page coordinates, with a gate on all four rotations"
```

---

### Task 3: Извлечение страниц и текстовых блоков

**Files:**
- Create: `services/worker/app/pdf/extract.py`
- Test: `services/worker/tests/test_extract.py`

**Interfaces:**
- Consumes: `normalize_box`, `NormalizedBox` из Task 2.
- Produces:
  - `ExtractedBlock(block_no: int, text: str, box: NormalizedBox)`
  - `ExtractedPage(page_no: int, width_pt: float, height_pt: float, rotation: int, char_count: int, needs_ocr: bool, blocks: list[ExtractedBlock])`
  - `extract_pages(raw: bytes, scan_char_threshold: int = 100) -> list[ExtractedPage]`

  Используется в Task 5.

- [ ] **Step 1: Написать падающий тест**

Создать `services/worker/tests/test_extract.py`:

```python
from pathlib import Path

import pymupdf
import pytest

from app.pdf.extract import extract_pages

REFERENCE_PDF = Path(__file__).resolve().parents[3] / "Задание" / "Комплект_предметной_разметки.pdf"


def _one_page_pdf(text: str, rotation: int = 0) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    if text:
        page.insert_text((20, 40), text, fontsize=24)
    page.set_rotation(rotation)
    raw = document.tobytes()
    document.close()
    return raw


def test_reads_text_and_page_geometry():
    pages = extract_pages(_one_page_pdf("Площадь застройки"))

    assert len(pages) == 1
    page = pages[0]
    assert page.page_no == 1
    assert page.rotation == 0
    assert "Площадь застройки" in "".join(b.text for b in page.blocks)
    assert page.char_count > 0
    assert page.needs_ocr is False


def test_every_box_lies_inside_the_unit_square():
    pages = extract_pages(_one_page_pdf("Экспликация помещений", rotation=90))

    boxes = [b.box for p in pages for b in p.blocks]
    assert boxes
    for box in boxes:
        assert 0.0 <= box.x0 <= box.x1 <= 1.0
        assert 0.0 <= box.y0 <= box.y1 <= 1.0


def test_a_page_without_a_text_layer_is_marked_for_ocr():
    """A scan is a statement about the input, not a failure.

    The page is still recorded, with its geometry, so stage C can come back to
    it later instead of the document silently losing a page.
    """
    pages = extract_pages(_one_page_pdf(""))

    assert len(pages) == 1
    assert pages[0].needs_ocr is True
    assert pages[0].blocks == []


def test_threshold_decides_what_counts_as_a_scan():
    pages = extract_pages(_one_page_pdf("короткая подпись"), scan_char_threshold=1000)
    assert pages[0].needs_ocr is True


@pytest.mark.skipif(not REFERENCE_PDF.exists(), reason="reference package is not in the checkout")
def test_reads_the_reference_package_without_ocr():
    """The architecture's central assumption, checked against the real file.

    Design documentation is exported from CAD and carries a text layer, so
    level 1 alone covers it. If this ever fails, the cost model of the whole
    pipeline changes and the OCR stage stops being optional.
    """
    pages = extract_pages(REFERENCE_PDF.read_bytes())

    assert len(pages) == 24
    assert all(p.needs_ocr is False for p in pages)
    assert all(p.blocks for p in pages)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_extract.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'app.pdf.extract'`

- [ ] **Step 3: Добавить зависимость**

В `services/worker/pyproject.toml` в `dependencies` добавить `"pymupdf>=1.24.0",`.

Run: `cd services/worker && .venv/Scripts/python.exe -m pip install pymupdf`
Expected: установлено без ошибок.

- [ ] **Step 4: Реализовать**

Создать `services/worker/app/pdf/extract.py`:

```python
"""Level 1 of the extraction pipeline: the PDF's own text layer.

Design documentation is exported from CAD, so the text and its coordinates are
already in the file and cost milliseconds to read. Only pages that carry no
text layer are handed on to OCR, which is what keeps 500 pages inside the ten
minute budget.
"""

from dataclasses import dataclass

import pymupdf

from app.pdf.geometry import NormalizedBox, normalize_box


@dataclass(frozen=True)
class ExtractedBlock:
    block_no: int
    text: str
    box: NormalizedBox


@dataclass(frozen=True)
class ExtractedPage:
    page_no: int
    width_pt: float
    height_pt: float
    rotation: int
    char_count: int
    needs_ocr: bool
    blocks: list[ExtractedBlock]


def _block_text(block: dict) -> str:
    return "".join(
        span.get("text", "")
        for line in block.get("lines", [])
        for span in line.get("spans", [])
    )


def extract_pages(raw: bytes, scan_char_threshold: int = 100) -> list[ExtractedPage]:
    pages: list[ExtractedPage] = []

    with pymupdf.open(stream=raw, filetype="pdf") as document:
        for index, page in enumerate(document, start=1):
            rect = page.rect
            page_box = (rect.x0, rect.y0, rect.x1, rect.y1)

            blocks: list[ExtractedBlock] = []
            char_count = 0
            for block in page.get_text("dict").get("blocks", []):
                # Type 0 is text; images and drawings carry no readable value
                # at this level and are left to the VLM stage.
                if block.get("type") != 0:
                    continue
                text = _block_text(block)
                if not text.strip():
                    continue
                char_count += len(text.strip())
                blocks.append(ExtractedBlock(
                    block_no=len(blocks),
                    text=text,
                    box=normalize_box(tuple(block["bbox"]), page_box),
                ))

            pages.append(ExtractedPage(
                page_no=index,
                width_pt=rect.width,
                height_pt=rect.height,
                rotation=page.rotation,
                char_count=char_count,
                needs_ocr=char_count < scan_char_threshold,
                blocks=blocks,
            ))

    return pages
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_extract.py -q`
Expected: `5 passed`

- [ ] **Step 6: Commit**

```bash
git add services/worker/app/pdf/extract.py services/worker/tests/test_extract.py services/worker/pyproject.toml
git commit -m "feat(worker): extract page text and coordinates from the pdf text layer"
```

---

### Task 4: Рендер страницы в PNG

**Files:**
- Create: `services/worker/app/pdf/render.py`
- Test: `services/worker/tests/test_render.py`

**Interfaces:**
- Produces: `render_page_png(raw: bytes, page_no: int, dpi: int = 200, max_long_side_px: int = 4000) -> bytes`. Используется в Task 5.

- [ ] **Step 1: Написать падающий тест**

Создать `services/worker/tests/test_render.py`:

```python
import pymupdf
import pytest

from app.pdf.render import render_page_png


def _pdf(width: float, height: float) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=width, height=height)
    page.insert_text((20, 40), "MARKER", fontsize=24)
    raw = document.tobytes()
    document.close()
    return raw


def test_renders_a_png():
    data = render_page_png(_pdf(400, 800), page_no=1)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"


def test_large_sheet_is_capped_instead_of_rendered_at_full_dpi():
    """CAD sheets are metres wide on paper.

    A 3370 pt sheet at 200 dpi is over nine thousand pixels across, and a
    package of them exhausts memory and disk long before it is useful. The cap
    trades resolution for a render that actually completes.
    """
    data = render_page_png(_pdf(3370, 2384), page_no=1, max_long_side_px=4000)

    pixmap = pymupdf.Pixmap(data)
    assert max(pixmap.width, pixmap.height) <= 4000


def test_small_sheet_keeps_the_requested_dpi():
    data = render_page_png(_pdf(400, 800), page_no=1, dpi=200, max_long_side_px=4000)

    pixmap = pymupdf.Pixmap(data)
    # 800 pt at 200 dpi is 800 / 72 * 200 pixels, within rounding.
    assert abs(pixmap.height - round(800 / 72 * 200)) <= 2


def test_unknown_page_is_refused():
    with pytest.raises(ValueError):
        render_page_png(_pdf(400, 800), page_no=7)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_render.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'app.pdf.render'`

- [ ] **Step 3: Реализовать**

Создать `services/worker/app/pdf/render.py`:

```python
"""Page images for the inspector's split view.

Rendering is capped by pixel count rather than run at a fixed dpi: construction
sheets are printed at A0 and larger, and a fixed 200 dpi on those produces
images too big to store or open.
"""

import pymupdf

POINTS_PER_INCH = 72.0


def render_page_png(
    raw: bytes,
    page_no: int,
    dpi: int = 200,
    max_long_side_px: int = 4000,
) -> bytes:
    with pymupdf.open(stream=raw, filetype="pdf") as document:
        if page_no < 1 or page_no > document.page_count:
            raise ValueError(
                f"page {page_no} is outside the document's {document.page_count} pages"
            )

        page = document[page_no - 1]
        long_side_pt = max(page.rect.width, page.rect.height)
        effective_dpi = min(dpi, max_long_side_px * POINTS_PER_INCH / long_side_pt)

        return page.get_pixmap(dpi=round(effective_dpi)).tobytes("png")
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_render.py -q`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add services/worker/app/pdf/render.py services/worker/tests/test_render.py
git commit -m "feat(worker): render page images with a pixel cap for large sheets"
```

---

### Task 5: Подключение этапа B к конвейеру

**Files:**
- Modify: `services/worker/app/storage.py`
- Modify: `services/worker/app/db.py`
- Modify: `services/worker/app/pipeline.py`
- Test: `services/worker/tests/test_pipeline.py`
- Modify: `tests/e2e/test_upload_flow.sh`

**Interfaces:**
- Consumes: `extract_pages`, `render_page_png`, существующие `Database` и `ManifestStorage`.
- Produces: страницы и блоки в базе; ключ изображения в `pages.image_key`.

- [ ] **Step 1: Добавить запись объекта в хранилище**

В `services/worker/app/storage.py` добавить метод рядом с `get_object`:

```python
    async def put_object(self, storage_key: str, data: bytes, content_type: str) -> None:
        # The minio client is blocking; off-loading it keeps the consumer loop
        # free to handle other messages while a large sheet is being written.
        await asyncio.to_thread(
            self._client.put_object,
            self._bucket,
            storage_key,
            io.BytesIO(data),
            length=len(data),
            content_type=content_type,
        )
```

Добавить `import io` в начало файла, если его нет.

- [ ] **Step 2: Добавить сохранение страниц в шлюз базы**

В `services/worker/app/db.py` добавить метод класса `Database`:

```python
    async def save_pages(self, file_id: str, pages: list[dict]) -> None:
        """Replace the pages recorded for a file.

        A re-run must not double the rows: the delete cascades to text_blocks,
        so the file ends up with exactly one set of pages whatever happened
        before.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM pages WHERE file_id = $1", file_id)
                for page in pages:
                    page_id = str(uuid.uuid4())
                    await connection.execute(
                        """
                        INSERT INTO pages (id, file_id, page_no, width_pt, height_pt,
                                           rotation, char_count, needs_ocr, image_key)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        """,
                        page_id, file_id, page["page_no"], page["width_pt"],
                        page["height_pt"], page["rotation"], page["char_count"],
                        page["needs_ocr"], page.get("image_key"),
                    )
                    if not page["blocks"]:
                        continue
                    await connection.executemany(
                        """
                        INSERT INTO text_blocks (id, page_id, block_no, text, x0, y0, x1, y1)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        """,
                        [
                            (str(uuid.uuid4()), page_id, b["block_no"], b["text"],
                             b["x0"], b["y0"], b["x1"], b["y1"])
                            for b in page["blocks"]
                        ],
                    )
```

Добавить `import uuid` в начало файла, если его нет.

- [ ] **Step 3: Написать падающий тест конвейера**

Дописать в `services/worker/tests/test_pipeline.py`:

```python
@pytest.mark.asyncio
async def test_pdf_documents_get_their_pages_extracted():
    process = mk_process(manifest_uploaded=False)
    doc = mk_file(id="f-doc", file_name="ar-01.pdf", storage_key="key-doc",
                  mime_type="application/pdf")
    db = FakeDb(process, [doc])
    storage = FakeStorage({"key-doc": _one_page_pdf("Площадь застройки")})

    await process_start("p1", db, storage)

    assert "f-doc" in db.saved_pages
    page = db.saved_pages["f-doc"][0]
    assert page["page_no"] == 1
    assert page["blocks"]
    assert page["image_key"]


@pytest.mark.asyncio
async def test_a_file_that_is_not_a_pdf_is_left_alone():
    """Only PDFs have a text layer to read; the registry itself is not a document."""
    process = mk_process(manifest_uploaded=False)
    doc = mk_file(id="f-doc", file_name="note.xml", storage_key="key-doc",
                  mime_type="application/xml")
    db = FakeDb(process, [doc])
    storage = FakeStorage({"key-doc": b"<root/>"})

    await process_start("p1", db, storage)

    assert db.saved_pages == {}
    assert db.saved["status"] == "READY"


@pytest.mark.asyncio
async def test_one_unreadable_pdf_does_not_stop_the_package():
    """A broken file is a data quality statement, not a reason to strand the rest."""
    process = mk_process(manifest_uploaded=False)
    good = mk_file(id="f-good", file_name="a.pdf", storage_key="key-good",
                   mime_type="application/pdf")
    bad = mk_file(id="f-bad", file_name="b.pdf", storage_key="key-bad",
                  mime_type="application/pdf")
    db = FakeDb(process, [good, bad])
    storage = FakeStorage({"key-good": _one_page_pdf("текст"), "key-bad": b"not a pdf"})

    await process_start("p1", db, storage)

    assert "f-good" in db.saved_pages
    assert "f-bad" not in db.saved_pages
    assert db.saved["status"] == "READY"
```

В том же файле добавить вспомогательную функцию и расширить подделки. `mk_file` уже принимает `mime_type` со значением по умолчанию `"application/pdf"`, менять её не нужно.

```python
import pymupdf


def _one_page_pdf(text: str, rotation: int = 0) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=400, height=800)
    if text:
        page.insert_text((20, 40), text, fontsize=24)
    page.set_rotation(rotation)
    raw = document.tobytes()
    document.close()
    return raw
```

В `FakeDb.__init__` добавить строку:

```python
        self.saved_pages: dict[str, list[dict]] = {}
```

и метод:

```python
    async def save_pages(self, file_id, pages):
        self.saved_pages[file_id] = pages
```

В `FakeStorage` добавить метод:

```python
    async def put_object(self, storage_key: str, data: bytes, content_type: str) -> None:
        self._objects[storage_key] = data
```

- [ ] **Step 4: Убедиться, что тесты падают**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest tests/test_pipeline.py -q`
Expected: FAIL — `saved_pages` пуст, метода `save_pages` у подделки нет.

- [ ] **Step 5: Вызвать этап B в конвейере**

В `services/worker/app/pipeline.py` после сохранения метаданных из реестра и до расчёта комплектности добавить обработку страниц:

```python
async def _extract_document_pages(process_id: str, files, db, storage) -> None:
    """Read the text layer of every PDF in the package.

    One unreadable file must not cost the package its other documents, so a
    failure here is recorded against that file and the rest continue.
    """
    for record in files:
        if record.mime_type != "application/pdf":
            continue
        try:
            raw = await storage.get_object(record.storage_key)
            pages = extract_pages(raw)
            stored = []
            for page in pages:
                image_key = f"pages/{record.id}/{page.page_no}.png"
                await storage.put_object(
                    image_key, render_page_png(raw, page.page_no), "image/png"
                )
                stored.append({
                    "page_no": page.page_no,
                    "width_pt": page.width_pt,
                    "height_pt": page.height_pt,
                    "rotation": page.rotation,
                    "char_count": page.char_count,
                    "needs_ocr": page.needs_ocr,
                    "image_key": image_key,
                    "blocks": [
                        {"block_no": b.block_no, "text": b.text,
                         "x0": b.box.x0, "y0": b.box.y0, "x1": b.box.x1, "y1": b.box.y1}
                        for b in page.blocks
                    ],
                })
            await db.save_pages(record.id, stored)
            logger.info("pages extracted", extra={
                "process_id": process_id,
                "file_id": record.id,
                "pages": len(stored),
                "scans": sum(1 for p in stored if p["needs_ocr"]),
            })
        except Exception as exc:  # noqa: BLE001 - reported per file, never fatal
            logger.error("page extraction failed", extra={
                "process_id": process_id,
                "file_id": record.id,
                "error": str(exc),
            })
```

Импорты в начале файла:

```python
from app.pdf.extract import extract_pages
from app.pdf.render import render_page_png
```

Вызов внутри `process_start`, после записи метаданных из реестра, с передачей списка файлов **без строки реестра**.

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `cd services/worker && .venv/Scripts/python.exe -m pytest -q`
Expected: все тесты проходят, включая ранее существовавшие.

- [ ] **Step 7: Проверить на живой системе**

Run:
```bash
docker compose up -d --build
bash tests/e2e/test_upload_flow.sh
```
Expected: `PASS`

Затем загрузить реальный многостраничный PDF и убедиться, что страницы появились:

```bash
docker compose exec -T postgres psql -U inspector -d inspector \
  -c "SELECT count(*) AS pages, sum(char_count) AS chars FROM pages;" \
  -c "SELECT count(*) AS blocks FROM text_blocks;"
```
Expected: ненулевые значения.

- [ ] **Step 8: Дополнить сквозной сценарий**

В `tests/e2e/test_upload_flow.sh` после шага 9 добавить шаг 10: после обработки пакета с реестром проверить, что у документов появились страницы с текстом. Проверка идёт запросом к базе через `docker compose exec`, потому что API страниц в этом плане не реализуется.

```bash
echo "10. pages with text are recorded for the uploaded documents"
PAGES=$(docker compose exec -T postgres psql -U inspector -d inspector -tA \
  -c "SELECT count(*) FROM pages p JOIN files f ON f.id = p.file_id WHERE f.process_id = '$PROCESS2';")
[ "$PAGES" -ge 1 ] || { echo "no pages extracted for process $PROCESS2"; exit 1; }
```

- [ ] **Step 9: Commit**

```bash
git add services/worker tests/e2e
git commit -m "feat(worker): read the text layer of uploaded documents into the database"
```

---

## Что этот план сознательно не делает

- **OCR (этап C).** Требует GPU, которого на машине разработки нет. Страницы-сканы помечаются `needs_ocr`, и на этом всё.
- **Индексация и эмбеддинги (этап E).** Следующий план.
- **Извлечение параметров (этап F).** Нужны спецификации, это План 3.
- **API страниц.** Подсветка нужна интерфейсу, которого ещё нет. Данные уже лежат в базе, эндпоинт добавится вместе с экраном верификации.
