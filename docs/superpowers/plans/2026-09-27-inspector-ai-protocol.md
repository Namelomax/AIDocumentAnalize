# План 6. Протокол и верификация инспектором

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** По завершении обработки пакета формируется версионированный протокол (п. 9.2 ТЗ, таблица `Protocols` раздела 10); API отдаёт протокол, находки и карточки доказательств с изображениями страниц; инспектор выносит решение по каждому кандидату — подтвердить, отклонить с кодированной причиной или запросить уточнение; протокол финализируется только когда все кандидаты обработаны, а отмена финализации доступна лишь администратору и супервизору с обязательной причиной.

**Architecture:** Протокол создаёт воркер в момент перевода процесса в `READY` — вместе с версиями матрицы, модели, набора данных и хешем входного реестра, которые ТЗ требует фиксировать в каждом протоколе. Решения инспектора пишутся в ту же строку `checks`, что и находка движка, с сохранением исходного статуса движка: сравнение «что сказала система — что решил инспектор» и есть материал для контура дообучения (п. 9.4). Правило «нарушение подтверждает только инспектор» закреплено ограничением базы, а не только кодом. API — в snake_case по именам полей ТЗ; интерфейс дизайнера получит тонкий слой преобразования в свои типы при интеграции.

**Tech Stack:** Node.js 20, Fastify 4.29, Prisma, Zod, MinIO; Python 3.11, asyncpg.

## Global Constraints

- **`CONFIRMED_VIOLATION` ставится только решением инспектора** и только с непустым `verified_by`. Ограничение базы: `finding_status <> 'CONFIRMED_VIOLATION' OR verified_by IS NOT NULL`.
- **Отклонение (`NEGATIVE_VERIFIED` решением инспектора) требует `reason_code` и комментария** (п. 9.3 ТЗ). Проверяется в Zod-схеме и ограничением базы.
- **Финализация** разрешена только когда не осталось кандидатов без решения (п. 9.3, алгоритм, шаг 4). После финализации решения и дозагрузка по этому процессу невозможны.
- **Отмена финализации** — только `ADMIN` или `SUPERVISOR`, с обязательной причиной, с записью в журнал аудита; протокол возвращается в `VERIFICATION_COMPLETED`.
- Коды причин отклонения — из интерфейса дизайнера: `WRONG_REVISION`, `APPROVED_CHANGE`, `OCR_ERROR`, `BINDING_ERROR`, `NOT_APPLICABLE`, `OTHER`. ТЗ задаёт причины словами («актуальная редакция выбрана неверно, согласованное изменение, ошибка OCR, ошибка привязки, параметр неприменим»), коды берутся из уже существующего интерфейса.
- Каждое решение, финализация и её отмена пишутся в журнал аудита через существующий `audit()`.
- Уровень риска (`review_priority`) — только очерёдность экспертной проверки, никогда не статус нарушения (п. 9.2).
- Комментарии в коде — по-английски, объясняют *почему*. Тексты для пользователя — по-русски.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `services/api/prisma/schema.prisma` | модель `Protocol`, поля решения в `Check`, модель `RejectionLog`, ограничения |
| `services/worker/app/db.py` | `create_protocol` |
| `services/worker/app/pipeline.py` | протокол при переходе в `READY` |
| `services/api/src/routes/protocols.ts` | чтение протокола, находок, карточки доказательства |
| `services/api/src/routes/pages.ts` | изображение страницы для карточки |
| `services/api/src/routes/verdicts.ts` | решение по находке, финализация и её отмена |
| `services/api/src/protocol/view.ts` | сборка ответа протокола и находки из строк базы |

---

### Task 1: Таблицы протоколов, решений и журнала отклонений

**Files:**
- Modify: `services/api/prisma/schema.prisma`
- Create: миграция `protocols_and_verdicts` с дописанными вручную ограничениями `CHECK`

**Interfaces:**
- Produces: таблицы `protocols`, `rejection_log`; новые колонки `checks`. Воркер пишет в `protocols` через asyncpg — имена колонок контракт.

- [ ] **Step 1: Модели**

```prisma
// One version of the protocol of a process (section 9.2, table Protocols of
// section 10). A re-run or an incremental update adds a version; earlier ones
// stay for the record.
model Protocol {
  id                String    @id @default(uuid())
  objectId          String    @map("object_id")
  processId         String    @map("process_id")
  version           Int
  matrixVersion     String    @map("matrix_version") @db.VarChar(20)
  datasetVersion    String    @map("dataset_version") @db.VarChar(40)
  modelVersion      String    @map("model_version") @db.VarChar(40)
  inputManifestHash String    @map("input_manifest_hash") @db.Char(64)
  // READY -> VERIFYING -> VERIFICATION_COMPLETED -> PROTOCOL_FINALIZED
  // (section 9.3); unfinalizing returns it to VERIFICATION_COMPLETED.
  status            String    @db.VarChar(30)
  // PENDING_SYNC / SYNCED for the transfer to ИАИС «РиН» (section 9.6); null
  // until a transfer is attempted.
  syncStatus        String?   @map("sync_status") @db.VarChar(20)
  createdAt         DateTime  @default(now()) @map("created_at")
  finalizedAt       DateTime? @map("finalized_at")
  finalizedBy       String?   @map("finalized_by")

  process Process @relation(fields: [processId], references: [id], onDelete: Cascade)

  @@unique([objectId, version])
  @@index([processId])
  @@map("protocols")
}

// Section 10, table Rejection_Log: every candidate an inspector rejected,
// with what the system had said, for the retraining loop of section 9.4.
model RejectionLog {
  id               String   @id @default(uuid())
  checkId          String   @map("check_id")
  rejectionReason  String   @map("rejection_reason") @db.VarChar(30)
  aiVerdict        String   @map("ai_verdict") @db.VarChar(30)
  comment          String
  // Section 9.4: a rejection enters a dataset only after a curator's review.
  retrainingStatus String   @default("DRAFT") @map("retraining_status") @db.VarChar(20)
  createdAt        DateTime @default(now()) @map("created_at")

  check Check @relation(fields: [checkId], references: [id], onDelete: Cascade)

  @@index([checkId])
  @@map("rejection_log")
}
```

В модель `Check` добавить:

```prisma
  // What the engine said before any inspector decision. Kept so the pair
  // "system said / inspector decided" survives for the retraining loop.
  engineStatus      String?   @map("engine_status") @db.VarChar(30)
  verifiedBy        String?   @map("verified_by")
  verifiedAt        DateTime? @map("verified_at")
  verdictReasonCode String?   @map("verdict_reason_code") @db.VarChar(30)
  verdictComment    String?   @map("verdict_comment")
  // When the inspector resolves a revision conflict, the file they chose as
  // authoritative and why (section 9.2: "выбрать авторитетную редакцию и
  // зафиксировать основание").
  authoritativeFileId String? @map("authoritative_file_id")

  rejections RejectionLog[]
```

В `Process` добавить `protocols Protocol[]`.

- [ ] **Step 2: Миграция с ограничениями**

Run: `cd services/api && npx prisma migrate dev --create-only --name protocols_and_verdicts`

В созданный `migration.sql` дописать в конец:

```sql
-- Section 9.2: only an inspector confirms a violation. Enforced by the
-- database so that no worker, script or hurried fix can write one.
ALTER TABLE "checks" ADD CONSTRAINT "confirmed_requires_inspector"
  CHECK ("finding_status" <> 'CONFIRMED_VIOLATION' OR "verified_by" IS NOT NULL);

-- Section 9.3: an inspector's rejection carries a coded reason and a comment.
ALTER TABLE "checks" ADD CONSTRAINT "rejection_requires_reason"
  CHECK ("verified_by" IS NULL OR "finding_status" <> 'NEGATIVE_VERIFIED'
         OR ("verdict_reason_code" IS NOT NULL AND "verdict_comment" IS NOT NULL));
```

Run: `npx prisma migrate dev`

- [ ] **Step 3: Проверить ограничение на живой базе**

```bash
docker compose exec -T postgres psql -U inspector -d inspector -c \
  "UPDATE checks SET finding_status = 'CONFIRMED_VIOLATION' WHERE id = (SELECT id FROM checks LIMIT 1);"
```

Expected: `ERROR: new row for relation "checks" violates check constraint "confirmed_requires_inspector"`.

- [ ] **Step 4: Прогнать тесты и commit**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`

```bash
git add services/api/prisma
git commit -m "feat(db): add protocols, verdict fields and the rejection log"
```

---

### Task 2: Воркер создаёт протокол

**Files:**
- Modify: `services/worker/app/db.py`, `services/worker/app/pipeline.py`, `services/worker/app/config.py`, `docker-compose.yml`
- Test: `services/worker/tests/test_pipeline.py`, `services/worker/tests/test_db_checks.py`

**Interfaces:**
- Produces: `Database.create_protocol(process_id: str, object_id: str, matrix_version: str, model_version: str, dataset_version: str, input_manifest_hash: str) -> int` — номер версии.

- [ ] **Step 1: Версии в конфигурации**

В `app/config.py` — поля `model_version` и `dataset_version` из переменных `MODEL_VERSION` (по умолчанию `rules-2026.09`) и `DATASET_VERSION` (по умолчанию `none`), с комментарием:

```python
    # Honest values, not placeholders: the comparison is a rule engine with no
    # trained model behind it yet, and no GOLD dataset has been released. The
    # specification requires both versions in every protocol; claiming a model
    # or a dataset that does not exist would misstate how a result was made.
```

Те же переменные — в `environment` сервиса `worker` в `docker-compose.yml` в форме `${VAR:-значение}`.

- [ ] **Step 2: Метод `create_protocol`**

```python
    async def create_protocol(self, process_id, object_id, matrix_version,
                              model_version, dataset_version, input_manifest_hash) -> int:
        """Add the next protocol version of the object.

        Versions count per object, not per process: section 9.2 keeps the
        previous version in the history when a package is reprocessed, and the
        inspector reads them as successive versions of one object's protocol.
        """
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                # Serialises concurrent protocol creation for one object, so
                # two finishing processes cannot both take the same version.
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", object_id
                )
                version = await connection.fetchval(
                    "SELECT COALESCE(MAX(version), 0) + 1 FROM protocols WHERE object_id = $1",
                    object_id,
                )
                await connection.execute(
                    """
                    INSERT INTO protocols (id, object_id, process_id, version, matrix_version,
                                           model_version, dataset_version, input_manifest_hash, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY')
                    """,
                    str(uuid.uuid4()), object_id, process_id, version, matrix_version,
                    model_version, dataset_version, input_manifest_hash,
                )
                return version
```

- [ ] **Step 3: Хеш входного реестра и вызов из конвейера**

В `pipeline.py`, после записи проверок и до перевода процесса в `READY`:

```python
def input_manifest_hash(process, files) -> str:
    """The fingerprint of what a protocol was computed from.

    The uploaded registry's hash when there is one. Without a registry, the
    sorted hashes of the package's files: section 14.2 requires every result
    to carry an input fingerprint, and a package without a registry is still
    a definite set of inputs.
    """
    if process.input_manifest_hash:
        return process.input_manifest_hash
    joined = "\n".join(sorted(f.file_hash for f in files))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()
```

Вызов: `await db.create_protocol(process.id, process.object_id, matrix.version, config.model_version, config.dataset_version, input_manifest_hash(process, files))`. Конфигурацию передать в `process_start` так же, как передаются база и хранилище (сверить с фактической сигнатурой). Сбой создания протокола логируется и не мешает переводу процесса в `READY`.

- [ ] **Step 4: Тесты**

- На подделках: после `process_start` вызван `create_protocol` с версией матрицы `1.1`, версией модели из конфигурации и хешем реестра процесса; для пакета без реестра — с хешем, одинаковым при перестановке файлов.
- Против живой базы (в `test_db_checks.py`, с уборкой за собой): два вызова `create_protocol` по одному объекту дают версии 1 и 2.

- [ ] **Step 5: Commit**

```bash
git add services/worker docker-compose.yml
git commit -m "feat(worker): issue a versioned protocol when a package is processed"
```

---

### Task 3: Чтение протокола, находок и карточки доказательства

**Files:**
- Create: `services/api/src/protocol/view.ts`, `services/api/src/routes/protocols.ts`, `services/api/src/routes/pages.ts`
- Modify: `services/api/src/server.ts`, `services/api/src/storage.ts`
- Test: `services/api/tests/protocols.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/processes/:process_id/protocol` → последняя версия протокола процесса;
  - `GET /api/v1/protocols/:protocol_id` → протокол: `{ id, object_id, process_id, version, status, sync_status, matrix_version, model_version, dataset_version, input_manifest_hash, created_at, finalized_at, summary, completeness, findings }`;
  - `GET /api/v1/protocols/:protocol_id/findings?status=` — только находки, фильтр по `finding_status`;
  - `GET /api/v1/findings/:check_id` → одна находка с доказательствами;
  - `GET /api/v1/files/:file_id/pages/:page_no/image` → PNG страницы из хранилища.

**Форма находки** (`finding`):

```json
{
  "id": "…", "evidence_group_id": "…",
  "param_code": "M-003", "section": "ПЗ",
  "title": "Полезная / Расчетная площадь — room 1.109",
  "unit": "м²",
  "expected_value": null, "actual_value": "18.20", "delta": null,
  "trigger_logic": "…", "norm_reference": "СП … ; ГОСТ …",
  "rationale": "В РД добавлено помещение 1.109 …",
  "review_priority": "MEDIUM",
  "finding_status": "CANDIDATE", "engine_status": "CANDIDATE",
  "completeness_status": "COMPLETE",
  "sources": ["PD", "RD"],
  "evidence": [
    { "role": "expected", "file_id": "…", "file_sha256": "…", "stage": "PD",
      "document_code": "…", "revision": "1", "approval_status": "APPROVED",
      "sheet_page": 1, "bbox": [0.1, 0.2, 0.3, 0.4], "extracted_value": null,
      "image_url": "/api/v1/files/…/pages/1/image" }
  ],
  "decision": null
}
```

`decision` после решения — `{ status, reason_code, comment, inspector: { id, full_name }, decided_at }`.

**`summary`** — счётчики, из которых собирается шапка протокола: `checked` (все проверки), `candidates`, `confirmed`, `negative`, `missing_evidence`, `not_applicable`, `not_comparable`, `clarification_required`.

**`completeness`** — отдельная таблица комплектности и сопоставимости, как требует п. 9.2 («раздельные таблицы: комплектность и сопоставимость; кандидаты; подтверждённые; отрицательные; гипотезы»): проверки без `finding_status`, по одной строке `{ param_code, parameter_name, completeness_status, rationale }`. **Находки (`findings`) и комплектность не смешиваются** — это два раздела протокола.

- [ ] **Step 1: Тесты**

`services/api/tests/protocols.test.ts` — данные создаются прямо через Prisma (объект, процесс, файл с фрагментом, три проверки: `CANDIDATE`, `NEGATIVE_VERIFIED` и одна `NOT_COMPARABLE` без статуса находки, параметр `M-003` должен существовать в `params` — создать тестовую строку, если таблица пуста), протокол версии 1, и удаляются после.

Проверить:
1. `GET /api/v1/processes/:id/protocol` отдаёт протокол с версиями и `input_manifest_hash`.
2. `summary` считает правильно: `checked = 3`, `candidates = 1`, `negative = 1`, `not_comparable = 1`.
3. `findings` содержит две находки, `completeness` — одну строку `NOT_COMPARABLE`; ни одна проверка не попадает в оба раздела.
4. У кандидата `evidence` содержит фрагмент с `bbox` из четырёх чисел и `image_url` вида `/api/v1/files/<file_id>/pages/<page>/image`, а `norm_reference` собран из `sp_reference`/`gost_reference` параметра.
5. `?status=CANDIDATE` оставляет одну находку; неизвестный статус — `400`.
6. Несуществующий протокол — `404`; без токена — `401`.
7. Изображение страницы: положить в хранилище PNG по ключу `pages/<file_id>/1.png` и запись в `pages`; ответ `200` с `content-type: image/png` и теми же байтами; несуществующая страница — `404`.

- [ ] **Step 2: Реализовать**

Сборку ответа вынести в `protocol/view.ts` — чистые функции над строками Prisma, чтобы их можно было проверить без HTTP. Заголовок находки — `parameter_name` параметра и `subject` проверки через тире. Изображение страницы — потоком из MinIO через новый `getObjectStream(key)` в `storage.ts`; ключ берётся из `pages.image_key`, а не собирается из параметров запроса: так клиент не может запросить произвольный объект хранилища.

- [ ] **Step 3: Прогнать и commit**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`

```bash
git add services/api
git commit -m "feat(api): read protocols, findings, evidence cards and page images"
```

---

### Task 4: Решение инспектора

**Files:**
- Create: `services/api/src/routes/verdicts.ts`
- Modify: `services/api/src/server.ts`
- Test: `services/api/tests/verdicts.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/findings/:check_id/verdict`:

```json
{ "decision": "CONFIRMED_VIOLATION | NEGATIVE_VERIFIED | CLARIFICATION_REQUIRED",
  "reason_code": "WRONG_REVISION | APPROVED_CHANGE | OCR_ERROR | BINDING_ERROR | NOT_APPLICABLE | OTHER",
  "comment": "строка",
  "authoritative_file_id": "uuid, только при разрешении конфликта редакций" }
```

Ответ — обновлённая находка в форме Task 3.

**Правила:**

1. Решение доступно ролям `INSPECTOR`, `SUPERVISOR`, `ADMIN`; `ML_ENGINEER` — `403`.
2. Решение выносится только по находке со статусом `CANDIDATE`, `CLARIFICATION_REQUIRED` или по уже принятому решению (его можно изменить до финализации). По `NEGATIVE_VERIFIED` движка и по проверкам без `finding_status` — `409 NOT_A_CANDIDATE`.
3. `NEGATIVE_VERIFIED` без `reason_code` или без непустого `comment` — `400`.
4. Протокол процесса в статусе `PROTOCOL_FINALIZED` — `409 PROTOCOL_FINALIZED`.
5. `engine_status` при первом решении получает прежний `finding_status` и дальше не меняется.
6. При отклонении — строка в `rejection_log` с `ai_verdict = engine_status`.
7. Первое решение по процессу переводит процесс в `VERIFYING`, протокол — в `VERIFYING`. Когда не остаётся ни одной находки со статусом `CANDIDATE`, процесс — `COMPLETED`, протокол — `VERIFICATION_COMPLETED`.
8. Каждое решение — запись `audit(request, 'VERDICT', object_id, { check_id, decision, reason_code })`.
9. Всё изменение — одна транзакция Prisma.

- [ ] **Step 1: Тесты**

Проверить каждое правило отдельным тестом, в том числе:

- подтверждение пишет `verified_by` = идентификатор пользователя токена и `verified_at`;
- отклонение без причины — `400`, в базе ничего не изменилось;
- попытка напрямую записать `CONFIRMED_VIOLATION` без `verified_by` через Prisma отвергается базой (ограничение из Task 1 — это проверка, что оно существует в миграции, а не только в коде);
- после решения по последнему кандидату протокол в `VERIFICATION_COMPLETED`;
- решение по финализированному протоколу — `409`.

- [ ] **Step 2: Реализовать и commit**

```bash
git add services/api
git commit -m "feat(api): take the inspector's verdict on each candidate"
```

---

### Task 5: Финализация и её отмена

**Files:**
- Modify: `services/api/src/routes/verdicts.ts`, `services/api/src/routes/documents.ts`
- Test: `services/api/tests/verdicts.test.ts`, `services/api/tests/upload.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/v1/protocols/:protocol_id/finalize` → протокол;
  - `POST /api/v1/protocols/:protocol_id/unfinalize` `{ reason }` → протокол.

**Правила:**

1. Финализация — роли `INSPECTOR`, `SUPERVISOR`, `ADMIN`. Если остались находки `CANDIDATE` — `409 CANDIDATES_PENDING` со списком их идентификаторов. Иначе протокол — `PROTOCOL_FINALIZED`, `finalized_at`, `finalized_by`; процесс — `FINALIZED`.
2. Отмена — только `SUPERVISOR` и `ADMIN` (п. 9.3), остальным `403`. Причина обязательна, пустая — `400`. Протокол — `VERIFICATION_COMPLETED`, `finalized_at` и `finalized_by` очищаются; процесс — `COMPLETED`.
3. Обе операции — в журнал аудита: `PROTOCOL_FINALIZED` и `PROTOCOL_UNFINALIZED` с причиной.
4. Финализация уже финализированного — `409`; отмена нефинализированного — `409`.
5. **После финализации загрузка документов в этот процесс невозможна.** Сейчас каждая загрузка создаёт новый процесс, поэтому блокировка касается будущей дозагрузки; в этом плане достаточно, чтобы старт процесса со статусом `FINALIZED` отвечал `409` — проверить, что существующая проверка статуса в `/start` это уже обеспечивает, и закрепить тестом.

- [ ] **Step 1: Тесты**

Каждое правило — отдельный тест. Отдельно: инспектор (`INSPECTOR`) не может отменить финализацию — `403`, супервизор может.

- [ ] **Step 2: Реализовать, прогнать всё, проверить на живой системе**

```bash
cd services/api && npx tsc -p tsconfig.json --noEmit && npm test
docker compose up -d --build
bash tests/e2e/test_upload_flow.sh
```

Затем вручную пройти по живой системе полный цикл на пакете из сквозного сценария: получить протокол процесса школы, вынести решение по обоим кандидатам (подтвердить итог этажа, отклонить помещение 1.109 с причиной `APPROVED_CHANGE`), финализировать, попробовать отменить под `inspector` (`403`), отменить под `supervisor` с причиной. Привести фактические ответы и строки `audit_log`.

- [ ] **Step 3: Commit**

```bash
git add services/api
git commit -m "feat(api): finalize a protocol once every candidate is decided"
```

---

## Что этот план сознательно не делает

- **Экспорт протокола в PDF, DOCX и XML** — следующий план, вместе с формой протокола.
- **Разбиение составного кандидата** (`POST /findings/:id/split`). Движок пока не порождает составных кандидатов; появится вместе с первым правилом, которое их порождает.
- **Инкрементальная дозагрузка** в существующий процесс и пересчёт только затронутых параметров (п. 9.1, 9.2) — отдельный план. Идентификаторы доказательных групп уже стабильны между запусками, это его основа.
- **Пересчёт после выбора авторитетной редакции.** Выбор записывается (`authoritative_file_id`), но сравнение по нему запускается в плане инкрементального обновления.
- **Передача в ИАИС «РиН»** — заглушка с журналированием, отдельная задача; поле `sync_status` уже есть.
