# План 8. Языковая модель за интерфейсом и семантический диссонанс назначений помещений

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Воркер получает доступ к локальной языковой модели через OpenAI-совместимый интерфейс и использует её для первого подхода модуля свободного поиска гипотез (п. 9.5 ТЗ) — семантического диссонанса: помещение с одним номером и площадью в ПД и РД, но с разным **назначением** («Техническое помещение» → «Склад ГСМ»), становится гипотезой `SUSPICION` с доказательствами на обоих листах. Гипотезы попадают в протокол отдельным разделом, в таблицу `Suspicions` ТЗ и на экран гипотез интерфейса.

**Architecture:** Решение 3 архитектуры — модель закрыта интерфейсом, а не именем. Воркер знает только адрес OpenAI-совместимого сервера и имя модели из конфигурации: при разработке это LM Studio (`qwen/qwen3.8-27b`, мультимодальная, на `http://127.0.0.1:1234`), на стенде — vLLM на H100. Без адреса функция не выполняется и честно отвечает `NOT_COMPARABLE`. Названия сначала нормализуются без модели («Тех.помещение» = «Техническое помещение»); к модели идут только пары, различающиеся после нормализации, **все одним запросом**. Гипотезы хранятся в `checks` со статусом `SUSPICION` — так их задумал интерфейс дизайнера (у типа находки есть `detectionMethod` и `confidence`), — а таблица `Suspicions` раздела 10 ТЗ отдаётся представлением базы.

**Tech Stack:** Python 3.11 (стандартная библиотека для HTTP), asyncpg; Prisma (миграция и представление), Fastify.

## Global Constraints

- **Гипотеза не нарушение.** `SUSPICION` не входит в число нарушений и не используется как положительная учебная метка (п. 9.5). Движок не создаёт `CANDIDATE` по суждению модели.
- **Внешние API запрещены.** Модель — только локальная, адрес задаётся конфигурацией. В образ и код не попадает ни одного внешнего адреса.
- **Без модели система работает.** Если `LLM_BASE_URL` не задан, модель недоступна или ответила мусором — проверка по этому правилу получает `NOT_COMPARABLE` с причиной, пакет обрабатывается до конца.
- **Ответ модели проверяется, а не принимается на веру.** Ответ должен разобраться как JSON заданной формы; каждая пара в ответе сопоставляется с запрошенной по идентификатору; всё, что не сопоставилось или не прошло проверку формы, — не гипотеза.
- **Норматив ТЗ** — ML-анализ одного параметра (NLP) не дольше 500 мс (п. 11). Один вызов модели на машине разработки занимает около 5–6 с. Поэтому модель вызывается один раз на пакет со всеми парами сразу, а время вызова пишется в лог; соответствие нормативу оценивается на стенде с vLLM, и итог честно фиксируется в отчёте.
- Комментарии в коде — по-английски, объясняют *почему*. Тексты для инспектора и запросы к модели — по-русски.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `services/api/prisma/schema.prisma` | `detection_method`, `confidence` у `Check`; представление `suspicions` в миграции |
| `services/worker/app/llm/__init__.py` | пакет |
| `services/worker/app/llm/provider.py` | OpenAI-совместимый клиент, проверка ответа |
| `services/worker/app/explication/functions.py` | нормализация названий и сравнение назначений |
| `services/worker/app/pipeline.py` | гипотезы по назначениям после сравнения экспликаций |
| `services/worker/app/config.py` | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_S` |
| `services/api/src/protocol/view.ts` | раздел гипотез в протоколе |

---

### Task 1: Поля гипотезы и представление `suspicions`

**Files:**
- Modify: `services/api/prisma/schema.prisma`
- Create: миграция `suspicions`

- [ ] **Step 1: Поля в `Check`**

```prisma
  // How a free-search hypothesis was found (section 9.5): LOGICAL,
  // SEMANTIC, NORMATIVE or ML. Null for matrix checks.
  detectionMethod String? @map("detection_method") @db.VarChar(20)
  // The model's own confidence for a hypothesis. Kept for the inspector's
  // ordering only; it never turns a hypothesis into a candidate.
  confidence      Float?
```

- [ ] **Step 2: Миграция с представлением**

`npx prisma migrate dev --create-only --name suspicions`, затем дописать в конец `migration.sql`:

```sql
-- Section 10, table Suspicions. Hypotheses live in checks with status
-- SUSPICION, where they get evidence fragments, verdicts and a place in the
-- protocol like any finding; this view gives them the table the
-- specification names, with its field names.
CREATE VIEW "suspicions" AS
SELECT c."id",
       c."object_id",
       c."process_id",
       c."detection_method" AS "discovery_method",
       c."confidence",
       c."rationale"        AS "description",
       c."review_priority",
       c."finding_status",
       CASE WHEN c."verified_by" IS NULL THEN 'PENDING' ELSE c."finding_status" END AS "inspector_status",
       c."created_at"
FROM "checks" c
WHERE c."finding_status" = 'SUSPICION' OR c."engine_status" = 'SUSPICION';
```

`npx prisma migrate dev`, затем `npx tsc --noEmit && npm test` в `services/api`.

- [ ] **Step 3: Commit**

```bash
git add services/api/prisma
git commit -m "feat(db): store free-search hypotheses as checks and expose the suspicions table"
```

---

### Task 2: Клиент модели

**Files:**
- Create: `services/worker/app/llm/__init__.py`, `services/worker/app/llm/provider.py`, `services/worker/tests/test_llm_provider.py`
- Modify: `services/worker/app/config.py`, `docker-compose.yml`, `.env.example`

**Interfaces:**
- `class LlmUnavailable(Exception)` — модель не настроена, недоступна, не уложилась во время или ответила не по форме.
- `class ChatProvider(base_url: str, model: str, timeout_s: float)` с методом `async complete_json(system: str, user: str) -> object` — возвращает разобранный JSON ответа; всё остальное — `LlmUnavailable` с причиной.
- `def provider_from_config(config) -> ChatProvider | None` — `None`, если `LLM_BASE_URL` пуст.

Конфигурация: `LLM_BASE_URL` (по умолчанию пусто — модель выключена), `LLM_MODEL` (по умолчанию пусто), `LLM_TIMEOUT_S` (по умолчанию 60). В `docker-compose.yml` для сервиса `worker` — те же переменные в форме `${VAR:-}` и комментарий: на стенде адрес указывает на сервис vLLM, при разработке на Windows с LM Studio — `http://host.docker.internal:1234/v1`, при этом в LM Studio должна быть включена раздача в локальную сеть.

- [ ] **Step 1: Тесты на поддельном сервере**

Поднимать внутри теста локальный HTTP-сервер из стандартной библиотеки (`http.server` в потоке), отдающий заданные ответы. Проверить:

1. Ответ `{"choices":[{"message":{"content":"{\"a\": 1}"}}]}` → `{"a": 1}`.
2. Ответ, где JSON обёрнут в блок ```` ```json … ``` ```` или предварён рассуждением модели в `<think>…</think>`, — всё равно разбирается: модели семейства Qwen так делают.
3. Ответ без JSON → `LlmUnavailable`.
4. Сервер не отвечает дольше таймаута → `LlmUnavailable`, а не зависание.
5. Отказ соединения → `LlmUnavailable`.
6. Тело запроса: `model` из конфигурации, `temperature: 0`, два сообщения `system` и `user`.

- [ ] **Step 2: Реализация**

HTTP — стандартной библиотекой (`urllib.request` через `asyncio.to_thread`), без новых зависимостей. Разбор ответа: взять `choices[0].message.content`, убрать блок `<think>…</think>` и обёртку ```` ``` ````, найти первый JSON-объект или массив, разобрать. Время вызова и число токенов (`usage`), если сервер их вернул, — в структурный лог.

- [ ] **Step 3: Живой тест против LM Studio**

Отдельный тест с маркером `@pytest.mark.live_llm`, пропускаемый, если `LLM_BASE_URL` не задан в окружении: реальный запрос к модели с просьбой вернуть `{"ok": true}`. В `pyproject.toml` зарегистрировать маркер. Запуск: `LLM_BASE_URL=http://127.0.0.1:1234/v1 LLM_MODEL=qwen/qwen3.8-27b .venv/Scripts/python.exe -m pytest -m live_llm -v`.

- [ ] **Step 4: Commit**

```bash
git add services/worker docker-compose.yml .env.example
git commit -m "feat(worker): reach a local language model through an openai-compatible interface"
```

---

### Task 3: Сравнение назначений помещений

**Files:**
- Create: `services/worker/app/explication/functions.py`, `services/worker/tests/test_room_functions.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class NamePair:
    key: str          # stable id of the pair inside one request, e.g. "p1"
    pd_name: str
    rd_name: str


@dataclass(frozen=True)
class FunctionVerdict:
    key: str
    same_function: bool
    confidence: float     # 0..1, as the model stated it
    reason: str           # one Russian sentence for the inspector


def normalize_room_name(name: str) -> str: ...
async def compare_room_functions(pairs: list[NamePair], provider: ChatProvider) -> list[FunctionVerdict]: ...
```

**Правила:**

1. `normalize_room_name`: нижний регистр, `ё` → `е`, раскрытие частых сокращений строительных экспликаций (`тех.` → `техническое`, `пом.` → `помещение`, `с/у` и `су` → `санузел`, `кл.` → `клетка`, `лк` → `лестничная клетка`, `пуи` → `помещение уборочного инвентаря`), схлопывание пробелов и знаков препинания. Пары, равные после нормализации, **к модели не идут** — это одно назначение.
2. Все оставшиеся пары — **одним запросом**. Запрос: системная инструкция о сравнении назначений помещений в ПД и РД строительной документации, ответ — JSON-массив объектов `{ "key", "same_function", "confidence", "reason" }`. Отличие в формулировке без смены назначения («Кабинет» — «Кабинет врача» в медицинском блоке) — одно назначение; смена функции («Техническое» — «Склад ГСМ», «Кладовая» — «Санузел») — разные.
3. Ответ проверяется: каждый элемент — нужных типов; `key` — из запрошенных; `confidence` в `[0, 1]`. Элементы, не прошедшие проверку, отбрасываются. Если модель вернула не все пары — вернуть только те, что вернулись: пропущенная пара не становится гипотезой.
4. Пустой список пар — пустой результат без обращения к модели.

- [ ] **Step 1: Тесты**

На подделке `ChatProvider` (класс с тем же методом):
- нормализация: «Тех.помещение» = «Техническое помещение», «С/у» = «Санузел», «ЛК» = «Лестничная клетка»;
- пары, равные после нормализации, до подделки не доходят (подделка считает вызовы);
- три пары — один вызов;
- ответ с чужим `key`, с `confidence = 1.7`, с отсутствующим полем — такие элементы отброшены;
- модель вернула две пары из трёх — результат из двух.

Живой тест `@pytest.mark.live_llm`: пары «Техническое помещение» / «Склад ГСМ» (разные), «Кабинет» / «Кабинет» с разным регистром (не дойдёт до модели), «Тамбур» / «Тамбур-шлюз» и «Кладовая» / «Санузел» (разные). Вывести фактические вердикты и время вызова. **Не закреплять в тесте** спорные случаи вроде «Тамбур» / «Тамбур-шлюз» — только однозначные.

- [ ] **Step 2: Реализация и commit**

```bash
git add services/worker
git commit -m "feat(worker): tell a changed room function from a reworded one"
```

---

### Task 4: Гипотезы в конвейере и в протоколе

**Files:**
- Modify: `services/worker/app/pipeline.py`, `services/worker/app/db.py`, `services/worker/tests/test_pipeline.py`
- Modify: `services/api/src/protocol/view.ts`, `services/api/tests/protocols.test.ts`

**Правила:**

1. После сравнения экспликаций для каждой пары листов собрать помещения, найденные на обоих листах, **у обоих есть название**, и названия различаются после нормализации.
2. Если провайдер модели не настроен — одна проверка правила `SEM-ROOM-FN` со статусом комплектности `NOT_COMPARABLE` и причиной «Языковая модель не подключена: сравнение назначений помещений не выполнялось». Если модель недоступна — то же, с причиной из `LlmUnavailable`.
3. Для каждого вердикта `same_function = false` — запись в `checks`: `param_code = 'SEM-ROOM-FN'`, `param_id = NULL`, `finding_status = 'SUSPICION'`, `detection_method = 'SEMANTIC'`, `confidence` из ответа, `completeness_status = 'COMPLETE'`, `review_priority = 'MEDIUM'`, `expected_value` — название в ПД, `actual_value` — название в РД, `rationale` — «Назначение помещения {номер} изменено: в ПД «…», в РД «…». {reason модели}», два фрагмента доказательств (`expected` — лист ПД, `actual` — лист РД) с прямоугольниками помещений. `evidence_group_id` — по той же схеме, что у находок M-003, с предметом `function {room_key}`.
4. Вердикты `same_function = true` записей не порождают.
5. Время вызова модели и число пар — в структурный лог строкой `room functions compared`.
6. `save_checks` уже вставляет `param_id` подзапросом по коду — для `SEM-ROOM-FN` подзапрос вернёт `NULL`; проверить, что это так, а не ошибка.

В API: `buildProtocolResponse` получает раздел `suspicions` — проверки со статусом `SUSPICION`, в форме находки, с полями `detection_method` и `confidence`; в `summary` — счётчик `suspicions`. Гипотезы **не входят** ни в `findings`, ни в счётчики нарушений и кандидатов, и **не блокируют** финализацию (проверить тестом маршрута финализации).

- [ ] **Step 1: Тесты на подделках и commit**

Воркер: пакет с помещением, у которого в ПД «Техническое помещение», а в РД «Склад ГСМ», и подделка модели, отвечающая `same_function = false`, → одна запись `SUSPICION` с двумя фрагментами; без провайдера → одна запись `NOT_COMPARABLE` по `SEM-ROOM-FN`; модель бросает `LlmUnavailable` → то же с причиной, пакет доходит до `READY`.

API: протокол с одной гипотезой — она в `suspicions`, не в `findings`; `summary.suspicions = 1`; финализация при одной гипотезе и ни одного кандидата — проходит.

```bash
git add services/worker services/api
git commit -m "feat: raise a hypothesis when a room keeps its number but changes its function"
```

- [ ] **Step 2: Живая проверка на эталонных листах**

Страница 2 эталонного комплекта (Алтуфьевское, 79Б) — лист РД. Пилотная разметка говорит: «В РД изменены назначения помещений и итоговые площади этажей». Листа ПД этого объекта в комплекте нет, поэтому живая проверка на реальной паре невозможна; проверить на паре, собранной из страницы 2 как РД и синтетического листа ПД с теми же номерами помещений и изменёнными названиями, через модель в LM Studio. Привести фактические гипотезы, уверенность, обоснования и время вызова модели.

---

## Что этот план сознательно не делает

- **Зрительная модель на чертежах** (модальности `drawing_entity`, `drawing_measure`). Модель в LM Studio мультимодальная, и это следующий шаг — но он требует отбора страниц-кандидатов и калибровки масштаба; отдельный план.
- **Логический и нормативный анализ** (п. 9.5, подходы 1 и 3) — отдельный план с базой правил `logical_rules` и `normative_base`.
- **Перевод гипотезы в кандидата инспектором** — появится вместе с экраном гипотез на живых данных.
- **Сервис vLLM в `docker-compose.yml`** с весами в образе — задача сборки стенда; здесь модель подключается по адресу.
