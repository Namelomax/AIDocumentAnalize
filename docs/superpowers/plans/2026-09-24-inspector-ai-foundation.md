# Инспектор ИИ — План 1: фундамент и приём документов

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Загруженный комплект ПД/РД/ИД принимается системой, сохраняется с контролем целостности, разбирается машиночитаемый реестр, определяется актуальная редакция каждого документа, вычисляется комплектность и сценарий проверки, задача уходит в очередь Python-воркеру.

**Architecture:** `docker compose` из семи сервисов. Node.js-API принимает файлы, кладёт в MinIO по контент-хешу, пишет метаданные в Postgres и публикует в RabbitMQ обычный JSON. Python-воркер читает очередь через `aio-pika` и ведёт статус процесса. Бизнес-логика выбора редакции и расчёта комплектности — чистые функции без ввода-вывода, покрытые табличными тестами.

**Tech Stack:** Node.js 20 · TypeScript · Fastify 4 · Prisma 5 · Zod · Vitest · Python 3.11 · aio-pika · pytest · PostgreSQL 16 + pgvector · Redis 7 · RabbitMQ 3.13 · MinIO · Docker Compose

## Global Constraints

- **Работа офлайн.** Ни один сервис не обращается в интернет во время выполнения. Все зависимости и веса вшиты в образы на этапе сборки.
- **Запуск одной командой:** `docker compose up`. По одному сервису на роль — одна база, один брокер, одно объектное хранилище.
- **Драйвер NVIDIA в образы не включается.** CUDA runtime — включается.
- **Перезапись файла под тем же `file_id` запрещена.** Повторная загрузка создаёт новую запись и новую версию протокола.
- **Лимиты загрузки:** не более 50 МБ на файл, не более 200 МБ на пакет. Форматы строго `PDF`, `DOCX`, `XML`.
- **Статус `CONFIRMED_VIOLATION` не может быть выставлен программно** — только эндпоинтом вердикта с непустым `verified_by`.
- **Все логи структурные, JSON**, обязательные поля: `timestamp`, `level`, `service`, `message`, `request_id`, `user_id`.
- **Имена статусов пишутся ровно так, как в ТЗ**, латиницей, в верхнем регистре. Русские подписи живут только в словарях интерфейса.
- **Язык кода, комментариев, коммитов — английский.** Русский — в пользовательских строках и документации.

## Карта файлов

```
docker-compose.yml               оркестрация семи сервисов
.env.example                     переменные окружения
services/api/                    Node.js
  src/server.ts                  сборка Fastify, регистрация плагинов
  src/config.ts                  типизированный конфиг из env
  src/logger.ts                  структурный JSON-логгер
  src/db.ts                      клиент Prisma
  src/storage.ts                 клиент MinIO
  src/queue.ts                   публикация JSON в RabbitMQ
  src/routes/health.ts           /api/v1/health
  src/routes/auth.ts             /api/v1/auth/login
  src/routes/objects.ts          CRUD объектов
  src/routes/documents.ts        загрузка файлов и реестра
  src/routes/processes.ts        статус процесса
  prisma/schema.prisma           схема БД
  tests/                         Vitest
services/worker/                 Python
  app/main.py                    точка входа, потребитель очереди
  app/config.py                  конфиг из env
  app/logging_setup.py           структурный JSON-логгер
  app/db.py                      подключение к Postgres
  app/consumer.py                aio-pika, маршрутизация задач
  app/domain/revisions.py        выбор актуальной редакции — чистые функции
  app/domain/completeness.py     комплектность и сценарий — чистые функции
  app/domain/manifest.py         разбор реестра CSV/XLSX/JSON
  tests/                         pytest
```

Доменные модули (`app/domain/*`) не знают ни про базу, ни про очередь, ни про файлы. Они принимают датаклассы и возвращают датаклассы. Это сделано намеренно: правила выбора редакции — самая ответственная логика в системе, и она должна проверяться табличными тестами без поднятия инфраструктуры.

---

## Task 1: Репозиторий и инфраструктурный каркас

**Files:**
- Create: `.gitignore`, `.env.example`, `docker-compose.yml`, `README.md`

**Interfaces:**
- Consumes: ничего
- Produces: работающие `postgres:5432`, `redis:6379`, `rabbitmq:5672`, `minio:9000` с healthcheck'ами

- [ ] **Step 1: Инициализировать репозиторий**

```bash
cd /d/Jacob/Programming/DocAi
git init
git branch -M main
```

- [ ] **Step 2: Создать `.gitignore`**

```
node_modules/
dist/
__pycache__/
*.pyc
.venv/
.env
data/
models/
*.log
```

- [ ] **Step 3: Создать `.env.example`**

```bash
POSTGRES_USER=inspector
POSTGRES_PASSWORD=inspector
POSTGRES_DB=inspector
DATABASE_URL=postgresql://inspector:inspector@postgres:5432/inspector
REDIS_URL=redis://redis:6379
RABBITMQ_URL=amqp://inspector:inspector@rabbitmq:5672/
RABBITMQ_DEFAULT_USER=inspector
RABBITMQ_DEFAULT_PASS=inspector
MINIO_ROOT_USER=inspector
MINIO_ROOT_PASSWORD=inspector123
MINIO_ENDPOINT=minio:9000
MINIO_BUCKET=documents
JWT_SECRET=change-me-in-production
MAX_FILE_BYTES=52428800
MAX_PACKAGE_BYTES=209715200
LOG_LEVEL=info
```

- [ ] **Step 4: Создать `docker-compose.yml` с инфраструктурными сервисами**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "5432:5432"
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_DEFAULT_USER}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_DEFAULT_PASS}
    ports:
      - "5672:5672"
      - "15672:15672"
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 5s
      retries: 20

  minio:
    image: quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - ./data/minio:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 20
```

- [ ] **Step 5: Проверить, что инфраструктура поднимается**

```bash
cp .env.example .env
docker compose up -d
docker compose ps
```

Ожидается: все четыре сервиса в состоянии `running (healthy)`. Если `minio` держится в `starting` дольше минуты — заменить его healthcheck на `["CMD-SHELL", "curl -f http://localhost:9000/minio/health/live || exit 1"]`.

- [ ] **Step 6: Коммит**

```bash
git add .gitignore .env.example docker-compose.yml README.md
git commit -m "chore: infrastructure skeleton with postgres, redis, rabbitmq, minio"
```

---

## Task 2: Схема базы данных

**Files:**
- Create: `services/api/prisma/schema.prisma`
- Create: `services/api/package.json`
- Test: `services/api/tests/schema.test.ts`

**Interfaces:**
- Consumes: `DATABASE_URL` из Task 1
- Produces: таблицы `users`, `objects`, `files`, `processes`, `audit_log`; enum'ы `DocStage`, `ApprovalStatus`, `ProcessStatus`, `FindingStatus`, `CompletenessStatus`, `ReviewPriority`, `UserRole`, `LoadScenario`.
  Таблицы `protocols`, `checks` и `evidence_fragments` вместе с ограничением `confirmed_requires_inspector` создаются Планом 4 — там они впервые получают данные.

**Подключение с хоста.** Миграции и тесты запускаются с хоста, а не из контейнера, поэтому им нужен адрес `localhost`, тогда как в корневом `.env` стоит имя сервиса Docker. Порты всех четырёх сервисов проброшены наружу (Task 1). Создайте `services/api/.env` — Prisma читает его сам — со строкой:

```
DATABASE_URL=postgresql://inspector:inspector@localhost:5432/inspector
```

Корневой `.env` не трогайте: он обслуживает контейнеры, где адресация идёт по именам сервисов. Файл `services/api/.env` попадает под общее правило `.env` в `.gitignore` и не коммитится.

- [ ] **Step 1: Создать `services/api/package.json`**

```json
{
  "name": "@inspector/api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "prisma:migrate": "prisma migrate deploy",
    "prisma:generate": "prisma generate"
  },
  "dependencies": {
    "@fastify/jwt": "^8.0.0",
    "@fastify/multipart": "^8.3.0",
    "@prisma/client": "^5.19.0",
    "amqplib": "^0.10.4",
    "fastify": "^4.28.0",
    "minio": "^8.0.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/amqplib": "^0.10.5",
    "@types/node": "^20.14.0",
    "prisma": "^5.19.0",
    "tsx": "^4.17.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Написать `services/api/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum DocStage {
  PD
  RD
  ID
}

enum ApprovalStatus {
  DRAFT
  APPROVED
  FOR_CONSTRUCTION
  SUPERSEDED
  CANCELLED
}

enum ProcessStatus {
  PENDING
  PARSING
  READY
  VERIFYING
  COMPLETED
  FINALIZED
}

enum FindingStatus {
  CANDIDATE
  CONFIRMED_VIOLATION
  NEGATIVE_VERIFIED
  MISSING_EVIDENCE
  NOT_APPLICABLE
  NOT_COMPARABLE
  CLARIFICATION_REQUIRED
  SUSPICION
}

/// Полнота доказательств по одному параметру Матрицы.
/// Применяется к находкам; таблицы под них создаются Планом 4.
enum CompletenessStatus {
  COMPLETE
  MISSING_EVIDENCE
  NOT_APPLICABLE
  NOT_COMPARABLE
  CLARIFICATION_REQUIRED
}

/// Полнота загрузки одной стадии документации — другой словарь и другой смысл.
/// Значения обязаны совпадать с теми, что возвращает
/// services/worker/app/domain/completeness.py.
enum StageCompleteness {
  UPLOADED
  PARTIAL
  MISSING
  NOT_APPLICABLE
}

enum ReviewPriority {
  HIGH
  MEDIUM
  LOW
}

enum LoadScenario {
  FULL
  PD_RD_ONLY
  PD_ID_ONLY
  RD_ID_ONLY
  SINGLE_ONLY
  PARTIALLY_LOADED
}

enum UserRole {
  INSPECTOR
  SUPERVISOR
  ADMIN
  ML_ENGINEER
}

model User {
  id           String   @id @default(uuid())
  login        String   @unique
  passwordHash String   @map("password_hash")
  fullName     String   @map("full_name")
  role         UserRole @default(INSPECTOR)
  createdAt    DateTime @default(now()) @map("created_at")

  @@map("users")
}

model ConstructionObject {
  id           String   @id @default(uuid())
  name         String
  address      String?
  customer     String?
  contractor   String?
  permitNumber String?  @map("permit_number")
  createdAt    DateTime @default(now()) @map("created_at")

  files     FileRecord[]
  processes Process[]

  @@map("objects")
}

model FileRecord {
  id              String         @id @default(uuid())
  objectId        String         @map("object_id")
  processId       String?        @map("process_id")
  fileName        String         @map("file_name")
  fileHash        String         @map("file_hash") @db.Char(64)
  storageKey      String         @map("storage_key")
  sizeBytes       Int            @map("size_bytes")
  mimeType        String         @map("mime_type")
  docStage        DocStage?      @map("doc_stage")
  discipline      String?
  documentCode    String?        @map("document_code")
  revision        String?
  approvalStatus  ApprovalStatus @default(DRAFT) @map("approval_status")
  approvalDate    DateTime?      @map("approval_date")
  sheetPageRange  String?        @map("sheet_page_range")
  predecessorId   String?        @map("predecessor_id")
  signatureStatus String?        @map("signature_status")
  pageCount       Int?           @map("page_count")
  fromManifest    Boolean        @default(false) @map("from_manifest")
  uploadedAt      DateTime       @default(now()) @map("uploaded_at")

  object       ConstructionObject @relation(fields: [objectId], references: [id])
  process      Process?           @relation(fields: [processId], references: [id])
  predecessor  FileRecord?        @relation("RevisionChain", fields: [predecessorId], references: [id])
  successors   FileRecord[]       @relation("RevisionChain")

  @@unique([objectId, fileHash])
  @@index([objectId, docStage, discipline])
  @@map("files")
}

model Process {
  id                String        @id @default(uuid())
  objectId          String        @map("object_id")
  status            ProcessStatus @default(PENDING)
  scenario          LoadScenario?
  pdCompleteness    StageCompleteness? @map("pd_completeness")
  rdCompleteness    StageCompleteness? @map("rd_completeness")
  idCompleteness    StageCompleteness? @map("id_completeness")
  manifestUploaded  Boolean       @default(false) @map("manifest_uploaded")
  inputManifestHash String?       @map("input_manifest_hash") @db.Char(64)
  createdAt         DateTime      @default(now()) @map("created_at")
  updatedAt         DateTime      @updatedAt @map("updated_at")

  object ConstructionObject @relation(fields: [objectId], references: [id])
  files  FileRecord[]

  @@map("processes")
}

model AuditLog {
  id        String   @id @default(uuid())
  userId    String?  @map("user_id")
  action    String
  objectId  String?  @map("object_id")
  details   Json?
  ipAddress String?  @map("ip_address")
  userAgent String?  @map("user_agent")
  timestamp DateTime @default(now())

  @@index([timestamp])
  @@map("audit_log")
}
```

- [ ] **Step 3: Применить миграцию**

```bash
cd services/api
npm install
npx prisma migrate dev --name init
```

Ожидается: миграция создана в `prisma/migrations/` и применена без ошибок.

- [ ] **Step 4: Написать тест схемы**

`services/api/tests/schema.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('schema', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejects duplicate file hash within the same object', async () => {
    const object = await prisma.constructionObject.create({
      data: { name: 'Test object' },
    });
    const hash = 'a'.repeat(64);

    await prisma.fileRecord.create({
      data: {
        objectId: object.id, fileName: 'a.pdf', fileHash: hash,
        storageKey: 'k1', sizeBytes: 10, mimeType: 'application/pdf',
      },
    });

    await expect(
      prisma.fileRecord.create({
        data: {
          objectId: object.id, fileName: 'b.pdf', fileHash: hash,
          storageKey: 'k2', sizeBytes: 10, mimeType: 'application/pdf',
        },
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Запустить тест**

```bash
npm test -- tests/schema.test.ts
```

Ожидается: PASS. Если падает с ошибкой подключения — проверить, что `DATABASE_URL` в `.env` указывает на `localhost:5432`, а не на `postgres:5432`, когда тест запускается вне контейнера.

- [ ] **Step 6: Коммит**

```bash
git add services/api/package.json services/api/prisma services/api/tests
git commit -m "feat(api): database schema with files, processes and objects"
```

---

## Task 3: Каркас Node-API со структурным логированием

**Files:**
- Create: `services/api/src/config.ts`, `services/api/src/logger.ts`, `services/api/src/db.ts`, `services/api/src/server.ts`, `services/api/src/routes/health.ts`, `services/api/tsconfig.json`
- Test: `services/api/tests/health.test.ts`

**Interfaces:**
- Consumes: Prisma-клиент из Task 2
- Produces: `buildServer(): FastifyInstance`, `config` с полями `port`, `databaseUrl`, `maxFileBytes`, `maxPackageBytes`, `jwtSecret`

- [ ] **Step 1: Написать падающий тест**

`services/api/tests/health.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('GET /api/v1/health', () => {
  it('returns ok with service name', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'api' });
    await app.close();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd services/api && npm test -- tests/health.test.ts
```

Ожидается: FAIL с `Cannot find module '../src/server.js'`.

- [ ] **Step 3: Создать `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Создать `src/config.ts`**

```typescript
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  RABBITMQ_URL: z.string(),
  MINIO_ENDPOINT: z.string(),
  MINIO_ROOT_USER: z.string(),
  MINIO_ROOT_PASSWORD: z.string(),
  MINIO_BUCKET: z.string().default('documents'),
  JWT_SECRET: z.string(),
  MAX_FILE_BYTES: z.coerce.number().default(52_428_800),
  MAX_PACKAGE_BYTES: z.coerce.number().default(209_715_200),
  LOG_LEVEL: z.string().default('info'),
  TASK_QUEUE: z.string().default('inspector.tasks'),
});

const parsed = schema.parse(process.env);

export const config = {
  port: parsed.PORT,
  databaseUrl: parsed.DATABASE_URL,
  rabbitmqUrl: parsed.RABBITMQ_URL,
  minio: {
    endPoint: parsed.MINIO_ENDPOINT.split(':')[0],
    port: Number(parsed.MINIO_ENDPOINT.split(':')[1] ?? 9000),
    accessKey: parsed.MINIO_ROOT_USER,
    secretKey: parsed.MINIO_ROOT_PASSWORD,
    bucket: parsed.MINIO_BUCKET,
  },
  jwtSecret: parsed.JWT_SECRET,
  maxFileBytes: parsed.MAX_FILE_BYTES,
  maxPackageBytes: parsed.MAX_PACKAGE_BYTES,
  logLevel: parsed.LOG_LEVEL,
  taskQueue: parsed.TASK_QUEUE,
};
```

- [ ] **Step 5: Создать `src/logger.ts`**

Структурный JSON-логгер с обязательными полями ТЗ.

```typescript
import { config } from './config.js';

export const loggerOptions = {
  level: config.logLevel,
  formatters: {
    level: (label: string) => ({ level: label.toUpperCase() }),
    bindings: () => ({ service: 'api' }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  // ТЗ задаёт точный набор полей, по которым централизованное хранилище
  // разбирает логи. user_id появляется здесь как null до задачи
  // аутентификации, которая подменит его на настоящего пользователя:
  // отсутствующее поле ломает разбор так же, как переименованное.
  mixin: () => ({ user_id: null as string | null }),
};
```

Имя поля с идентификатором запроса задаётся не здесь, а опцией Fastify `requestIdLogLabel` (см. шаг сборки сервера): по умолчанию Pino пишет `reqId`, а ТЗ требует `request_id`.

- [ ] **Step 6: Создать `src/db.ts`**

```typescript
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
```

- [ ] **Step 7: Создать `src/routes/health.ts`**

```typescript
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/v1/health', async () => ({ status: 'ok', service: 'api' }));
}
```

- [ ] **Step 8: Создать `src/server.ts`**

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: () => crypto.randomUUID(),
    requestIdLogLabel: 'request_id',
  });
  await app.register(healthRoutes);
  return app;
}

const isEntry = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isEntry) {
  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
```

- [ ] **Step 9: Запустить тест**

```bash
npm test -- tests/health.test.ts
```

Ожидается: PASS.

- [ ] **Step 10: Коммит**

```bash
git add services/api/src services/api/tsconfig.json services/api/tests/health.test.ts
git commit -m "feat(api): fastify skeleton with structured logging and health endpoint"
```

---

## Task 4: Выбор актуальной редакции — чистые функции

Самая ответственная логика в системе. Реализуется первой, отдельно от инфраструктуры, и покрывается табличными тестами. Все шесть правил взяты из `Задание/Перечень_исполнительной_документации_редакция1_1.docx`.

**Files:**
- Create: `services/worker/app/domain/revisions.py`
- Create: `services/worker/pyproject.toml`
- Test: `services/worker/tests/test_revisions.py`

**Interfaces:**
- Consumes: ничего
- Produces:
  - `@dataclass FileMeta(file_id: str, doc_stage: str, discipline: str | None, document_code: str | None, revision: str | None, approval_status: str, approval_date: date | None, predecessor_id: str | None, readable: bool)`
  - `@dataclass SourceSelection(file_id: str | None, status: str, reason: str)` где `status` ∈ `COMPLETE`, `MISSING_EVIDENCE`, `CLARIFICATION_REQUIRED`, `NOT_COMPARABLE`, `NOT_APPLICABLE`
  - `select_source_revision(files: list[FileMeta], stage: str, discipline: str | None) -> SourceSelection`

- [ ] **Step 1: Создать `services/worker/pyproject.toml`**

```toml
[project]
name = "inspector-worker"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = [
  "aio-pika>=9.4.0",
  "asyncpg>=0.29.0",
  "openpyxl>=3.1.5",
  "python-json-logger>=2.0.7",
]

[project.optional-dependencies]
dev = ["pytest>=8.3.0", "pytest-asyncio>=0.24.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Написать падающие тесты**

`services/worker/tests/test_revisions.py`:

```python
from datetime import date
import pytest
from app.domain.revisions import FileMeta, select_source_revision


def mk(file_id, approval_status="APPROVED", approval_date=date(2026, 1, 1),
       predecessor_id=None, readable=True, stage="PD", discipline="АР"):
    return FileMeta(
        file_id=file_id, doc_stage=stage, discipline=discipline,
        document_code="AR-01", revision="1", approval_status=approval_status,
        approval_date=approval_date, predecessor_id=predecessor_id, readable=readable,
    )


def test_single_approved_revision_is_selected():
    result = select_source_revision([mk("f1")], "PD", "АР")
    assert result.status == "COMPLETE"
    assert result.file_id == "f1"


def test_superseded_revision_is_excluded():
    # f2 явно заменяет f1
    files = [mk("f1"), mk("f2", predecessor_id="f1")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "COMPLETE"
    assert result.file_id == "f2"


def test_cancelled_revision_is_excluded():
    files = [mk("f1", approval_status="CANCELLED")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "MISSING_EVIDENCE"


def test_ambiguous_revisions_require_clarification():
    # две утверждённые редакции одной датой, связи predecessor нет
    files = [mk("f1"), mk("f2")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "CLARIFICATION_REQUIRED"
    assert result.file_id is None


def test_missing_document_is_missing_evidence():
    result = select_source_revision([], "PD", "АР")
    assert result.status == "MISSING_EVIDENCE"


def test_unreadable_file_is_not_comparable():
    files = [mk("f1", readable=False)]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "NOT_COMPARABLE"


def test_only_draft_requires_clarification():
    files = [mk("f1", approval_status="DRAFT")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "CLARIFICATION_REQUIRED"


def test_for_construction_counts_as_approved():
    files = [mk("f1", approval_status="FOR_CONSTRUCTION", stage="RD")]
    result = select_source_revision(files, "RD", "АР")
    assert result.status == "COMPLETE"
    assert result.file_id == "f1"


def test_file_of_another_stage_is_not_used():
    files = [mk("f1", stage="RD")]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "MISSING_EVIDENCE"


def test_unreadable_newer_revision_blocks_the_stale_one():
    # f2 явно заменяет f1, но нечитаем. Старая редакция НЕ может стать эталоном:
    # достоверно определить актуальный источник нельзя.
    files = [
        mk("f1", approval_date=date(2026, 1, 1)),
        mk("f2", approval_date=date(2026, 6, 1), predecessor_id="f1", readable=False),
    ]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "NOT_COMPARABLE"
    assert result.file_id is None


def test_unreadable_draft_does_not_block_an_approved_revision():
    # черновик не может быть эталоном в принципе, поэтому его нечитаемость
    # не должна мешать выбрать утверждённую редакцию
    files = [mk("f1"), mk("f2", approval_status="DRAFT", readable=False)]
    result = select_source_revision(files, "PD", "АР")
    assert result.status == "COMPLETE"
    assert result.file_id == "f1"


def test_later_approval_date_wins_when_chain_is_explicit():
    files = [
        mk("f1", approval_date=date(2026, 1, 1)),
        mk("f2", approval_date=date(2026, 5, 1), predecessor_id="f1"),
    ]
    result = select_source_revision(files, "PD", "АР")
    assert result.file_id == "f2"
```

- [ ] **Step 3: Сделать `tests` и `app.domain` пакетами**

Задача 5 импортирует хелпер `mk` из `tests.test_revisions`, поэтому каталог тестов должен быть пакетом. Создать пустые файлы:

```bash
mkdir -p services/worker/app/domain services/worker/tests/fixtures
touch services/worker/app/__init__.py services/worker/app/domain/__init__.py services/worker/tests/__init__.py
```

- [ ] **Step 4: Запустить тесты и убедиться, что они падают**

```bash
cd services/worker
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/test_revisions.py -v
```

Ожидается: FAIL с `ModuleNotFoundError: No module named 'app.domain.revisions'`.

- [ ] **Step 5: Реализовать `services/worker/app/domain/revisions.py`**

```python
"""Selecting the authoritative revision of a document for comparison.

Rules come from "Перечень исполнительной документации", section
"ПРАВИЛА ВЫБОРА ИСТОЧНИКА ДЛЯ СРАВНЕНИЯ". An outdated revision must never be
used as the reference, and any ambiguity blocks the violation verdict rather
than guessing.
"""

from dataclasses import dataclass
from datetime import date

APPROVED_STATUSES = {"APPROVED", "FOR_CONSTRUCTION"}
EXCLUDED_STATUSES = {"CANCELLED", "SUPERSEDED"}


@dataclass(frozen=True)
class FileMeta:
    file_id: str
    doc_stage: str
    discipline: str | None
    document_code: str | None
    revision: str | None
    approval_status: str
    approval_date: date | None
    predecessor_id: str | None
    readable: bool = True


@dataclass(frozen=True)
class SourceSelection:
    file_id: str | None
    status: str
    reason: str


def select_source_revision(
    files: list[FileMeta], stage: str, discipline: str | None
) -> SourceSelection:
    applicable = [
        f for f in files
        if f.doc_stage == stage and (discipline is None or f.discipline == discipline)
    ]

    if not applicable:
        return SourceSelection(None, "MISSING_EVIDENCE",
                               "no file for the requested stage and discipline")

    applicable = [f for f in applicable if f.approval_status not in EXCLUDED_STATUSES]

    if not applicable:
        return SourceSelection(None, "MISSING_EVIDENCE",
                               "all revisions are cancelled or superseded")

    # A file that some other file names as its predecessor has been replaced.
    # The chain is built over every applicable file, readable or not. Dropping
    # unreadable files first would erase the evidence that a newer revision
    # exists and let the superseded one pass as the reference — the exact
    # failure this function exists to prevent.
    superseded_ids = {f.predecessor_id for f in applicable if f.predecessor_id}
    current = [f for f in applicable if f.file_id not in superseded_ids]

    # An unreadable draft can never be the reference, so it does not block
    # anything. An unreadable approved revision does: it may well be the
    # authoritative one, and we cannot tell.
    if any(not f.readable and f.approval_status in APPROVED_STATUSES for f in current):
        return SourceSelection(None, "NOT_COMPARABLE",
                               "the current approved revision cannot be read")

    approved = [f for f in current if f.approval_status in APPROVED_STATUSES]

    if not approved:
        return SourceSelection(None, "CLARIFICATION_REQUIRED",
                               "no approved revision among the current ones")

    if len(approved) == 1:
        return SourceSelection(approved[0].file_id, "COMPLETE", "single approved revision")

    dated = [f for f in approved if f.approval_date is not None]
    if len(dated) == len(approved):
        latest = max(f.approval_date for f in dated)
        newest = [f for f in dated if f.approval_date == latest]
        if len(newest) == 1:
            return SourceSelection(newest[0].file_id, "COMPLETE",
                                   "latest approved revision by approval date")

    return SourceSelection(None, "CLARIFICATION_REQUIRED",
                           "several approved revisions without an unambiguous order")
```

- [ ] **Step 6: Запустить тесты**

```bash
pytest tests/test_revisions.py -v
```

Ожидается: 10 passed.

- [ ] **Step 7: Коммит**

```bash
git add services/worker/pyproject.toml services/worker/app services/worker/tests/test_revisions.py
git commit -m "feat(worker): authoritative revision selection with six source rules"
```

---

## Task 5: Комплектность и сценарий загрузки

**Files:**
- Create: `services/worker/app/domain/completeness.py`
- Test: `services/worker/tests/test_completeness.py`

**Interfaces:**
- Consumes: `FileMeta` из Task 4
- Produces:
  - `@dataclass StageCompleteness(stage: str, status: str, uploaded: int, expected: int | None)` где `status` ∈ `UPLOADED`, `PARTIAL`, `MISSING`
  - `compute_completeness(files: list[FileMeta], expected: dict[str, int] | None) -> list[StageCompleteness]`
  - `determine_scenario(completeness: list[StageCompleteness]) -> str` — возвращает одно из `FULL`, `PD_RD_ONLY`, `PD_ID_ONLY`, `RD_ID_ONLY`, `SINGLE_ONLY`, `PARTIALLY_LOADED`

- [ ] **Step 1: Написать падающие тесты**

`services/worker/tests/test_completeness.py`:

```python
from app.domain.completeness import compute_completeness, determine_scenario
from tests.test_revisions import mk


def test_all_three_stages_present_is_full():
    files = [mk("a", stage="PD"), mk("b", stage="RD"), mk("c", stage="ID")]
    scenario = determine_scenario(compute_completeness(files, None))
    assert scenario == "FULL"


def test_pd_and_rd_only():
    files = [mk("a", stage="PD"), mk("b", stage="RD")]
    assert determine_scenario(compute_completeness(files, None)) == "PD_RD_ONLY"


def test_pd_and_id_only():
    files = [mk("a", stage="PD"), mk("c", stage="ID")]
    assert determine_scenario(compute_completeness(files, None)) == "PD_ID_ONLY"


def test_rd_and_id_only():
    files = [mk("b", stage="RD"), mk("c", stage="ID")]
    assert determine_scenario(compute_completeness(files, None)) == "RD_ID_ONLY"


def test_single_stage_only():
    files = [mk("a", stage="PD")]
    assert determine_scenario(compute_completeness(files, None)) == "SINGLE_ONLY"


def test_partial_upload_beats_other_scenarios():
    # ожидалось 15 файлов РД, загружено 2
    files = [mk("a", stage="PD"), mk("b", stage="RD"), mk("b2", stage="RD"),
             mk("c", stage="ID")]
    expected = {"PD": 1, "RD": 15, "ID": 1}
    assert determine_scenario(compute_completeness(files, expected)) == "PARTIALLY_LOADED"


def test_stage_statuses_are_reported_per_stage():
    files = [mk("a", stage="PD"), mk("b", stage="RD")]
    expected = {"PD": 1, "RD": 15, "ID": 3}
    result = {c.stage: c.status for c in compute_completeness(files, expected)}
    assert result == {"PD": "UPLOADED", "RD": "PARTIAL", "ID": "MISSING"}


def test_stage_expected_as_zero_is_not_applicable_not_missing():
    # заказчик указал в реестре, что стадия к объекту не применима.
    # Это не то же самое, что «документа не хватает».
    files = [mk("a", stage="PD"), mk("b", stage="RD")]
    expected = {"PD": 1, "RD": 1, "ID": 0}
    result = {c.stage: c.status for c in compute_completeness(files, expected)}
    assert result["ID"] == "NOT_APPLICABLE"


def test_files_uploaded_for_a_stage_expected_as_zero_still_count():
    files = [mk("a", stage="PD"), mk("c", stage="ID")]
    expected = {"PD": 1, "RD": 0, "ID": 0}
    result = {c.stage: c.status for c in compute_completeness(files, expected)}
    assert result["ID"] == "UPLOADED"
    assert result["RD"] == "NOT_APPLICABLE"


def test_empty_package_is_rejected_instead_of_reported_as_single_stage():
    # ни одной стадии не загружено. Вернуть SINGLE_ONLY значило бы солгать,
    # что загружена ровно одна.
    import pytest

    with pytest.raises(ValueError):
        determine_scenario(compute_completeness([], None))
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

```bash
pytest tests/test_completeness.py -v
```

Ожидается: FAIL с `ModuleNotFoundError`.

- [ ] **Step 3: Реализовать `services/worker/app/domain/completeness.py`**

```python
"""Per-stage completeness and the resulting load scenario.

Both are reported separately from findings: an incomplete package is a data
quality statement, never a violation.
"""

from dataclasses import dataclass

STAGES = ("PD", "RD", "ID")


@dataclass(frozen=True)
class StageCompleteness:
    stage: str
    status: str  # UPLOADED | PARTIAL | MISSING | NOT_APPLICABLE
    uploaded: int
    expected: int | None


def compute_completeness(files, expected: dict[str, int] | None) -> list[StageCompleteness]:
    result = []
    for stage in STAGES:
        uploaded = sum(1 for f in files if f.doc_stage == stage)
        want = expected.get(stage) if expected else None

        # A registry that declares zero expected files says the stage does not
        # apply to this object. That is not the same as a document being
        # absent, and reporting it as MISSING would invent a gap.
        if want == 0 and uploaded == 0:
            status = "NOT_APPLICABLE"
        elif uploaded == 0:
            status = "MISSING"
        elif want is not None and uploaded < want:
            status = "PARTIAL"
        else:
            status = "UPLOADED"

        result.append(StageCompleteness(stage, status, uploaded, want))
    return result


def determine_scenario(completeness: list[StageCompleteness]) -> str:
    by_stage = {c.stage: c for c in completeness}

    if any(c.status == "PARTIAL" for c in completeness):
        return "PARTIALLY_LOADED"

    present = {s for s in STAGES if by_stage[s].status == "UPLOADED"}

    # Falling through to SINGLE_ONLY here would claim exactly one stage was
    # uploaded when none was. The caller must not reach scenario detection
    # with an empty package.
    if not present:
        raise ValueError("no documentation stage was uploaded")

    if present == {"PD", "RD", "ID"}:
        return "FULL"
    if present == {"PD", "RD"}:
        return "PD_RD_ONLY"
    if present == {"PD", "ID"}:
        return "PD_ID_ONLY"
    if present == {"RD", "ID"}:
        return "RD_ID_ONLY"
    return "SINGLE_ONLY"
```

- [ ] **Step 4: Запустить тесты**

```bash
pytest tests/test_completeness.py -v
```

Ожидается: 7 passed.

- [ ] **Step 5: Коммит**

```bash
git add services/worker/app/domain/completeness.py services/worker/tests/test_completeness.py
git commit -m "feat(worker): per-stage completeness and load scenario detection"
```

---

## Task 6: Разбор машиночитаемого реестра

Реестр обязателен: без него пакет принимается со статусом `CLARIFICATION_REQUIRED`. Формат в скрытом тесте неизвестен, поэтому поддерживаем CSV, XLSX и JSON с гибким сопоставлением колонок.

**Files:**
- Create: `services/worker/app/domain/manifest.py`
- Test: `services/worker/tests/test_manifest.py`
- Test fixture: `services/worker/tests/fixtures/manifest_sample.csv`

**Interfaces:**
- Consumes: ничего
- Produces:
  - `@dataclass ManifestEntry(file_name: str, object_id: str, doc_stage: str, discipline: str | None, document_code: str | None, revision: str | None, approval_status: str, approval_date: date | None, sheet_page_range: str | None, predecessor_id: str | None, signature_status: str | None, sha256: str | None)`
  - `@dataclass ManifestParseResult(entries: list[ManifestEntry], errors: list[str])`
  - `parse_manifest(raw: bytes, filename: str) -> ManifestParseResult`

- [ ] **Step 1: Создать фикстуру `services/worker/tests/fixtures/manifest_sample.csv`**

```csv
object_id,file_name,sha256,doc_stage,discipline,document_code,revision,approval_status,approval_date,sheet_page_range,predecessor_id,signature_status
OBJ-001,ar-01.pdf,aaaa,PD,АР,АНО/150321/1-П-АР,1,APPROVED,2026-01-15,1-24,,SIGNED
OBJ-001,ov1.pdf,bbbb,RD,ОВ,АНО/150321/1-РД-ОВ1,2,FOR_CONSTRUCTION,2026-03-20,1-12,,SIGNED
```

- [ ] **Step 2: Написать падающие тесты**

`services/worker/tests/test_manifest.py`:

```python
from datetime import date
from pathlib import Path
import json
from app.domain.manifest import parse_manifest

FIXTURES = Path(__file__).parent / "fixtures"


def test_parses_csv_manifest():
    raw = (FIXTURES / "manifest_sample.csv").read_bytes()
    result = parse_manifest(raw, "manifest_sample.csv")

    assert result.errors == []
    assert len(result.entries) == 2
    first = result.entries[0]
    assert first.file_name == "ar-01.pdf"
    assert first.doc_stage == "PD"
    assert first.approval_status == "APPROVED"
    assert first.approval_date == date(2026, 1, 15)


def test_parses_json_manifest():
    payload = json.dumps([{
        "object_id": "OBJ-001", "file_name": "kr.pdf", "doc_stage": "PD",
        "discipline": "КР", "document_code": "X-КР", "revision": "1",
        "approval_status": "APPROVED", "approval_date": "2026-02-01",
    }]).encode()
    result = parse_manifest(payload, "manifest.json")

    assert result.errors == []
    assert result.entries[0].discipline == "КР"


def test_accepts_russian_column_headers():
    raw = "Объект;Имя файла;Стадия\nOBJ-1;a.pdf;PD\n".encode("utf-8")
    result = parse_manifest(raw, "reestr.csv")

    assert result.errors == []
    assert result.entries[0].file_name == "a.pdf"
    assert result.entries[0].doc_stage == "PD"


def test_reports_unknown_stage_as_error():
    raw = "object_id,file_name,doc_stage\nOBJ-1,a.pdf,ПРОЕКТ\n".encode()
    result = parse_manifest(raw, "m.csv")

    assert result.entries == []
    assert any("doc_stage" in e for e in result.errors)


def test_reports_missing_required_column():
    raw = "object_id,revision\nOBJ-1,1\n".encode()
    result = parse_manifest(raw, "m.csv")

    assert any("file_name" in e for e in result.errors)


def test_json_row_without_a_required_key_does_not_kill_the_parse():
    # ключи в JSON-записях не обязаны совпадать: вторая запись без file_name
    # должна дать ошибку строки, а не уронить разбор целиком
    payload = json.dumps([
        {"object_id": "OBJ-1", "file_name": "a.pdf", "doc_stage": "PD"},
        {"object_id": "OBJ-2", "doc_stage": "PD"},
    ]).encode()
    result = parse_manifest(payload, "m.json")

    assert len(result.entries) == 1
    assert result.entries[0].file_name == "a.pdf"
    assert any("row 3" in e and "file_name" in e for e in result.errors)


def test_unrecognised_approval_date_is_reported_not_swallowed():
    # дата утверждения решает, какая из двух редакций актуальна.
    # Молча потерять её нельзя.
    raw = ("object_id,file_name,doc_stage,approval_date\n"
           "OBJ-1,a.pdf,PD,15 January 2026\n").encode()
    result = parse_manifest(raw, "m.csv")

    assert any("approval_date" in e for e in result.errors)


def test_non_breaking_space_in_header_is_normalised():
    raw = "object_id,file name,doc_stage\nOBJ-1,a.pdf,PD\n".encode("utf-8")
    result = parse_manifest(raw, "m.csv")

    assert result.errors == []
    assert result.entries[0].file_name == "a.pdf"


def test_two_columns_meaning_the_same_field_are_rejected():
    # 'revision' и 'изм' — синонимы одного поля. Молча взять одно из двух
    # значений значит потерять второе без следа.
    raw = ("object_id,file_name,doc_stage,revision,изм\n"
           "OBJ-1,a.pdf,PD,7,9\n").encode("utf-8")
    result = parse_manifest(raw, "m.csv")

    assert result.entries == []
    assert any("revision" in e for e in result.errors)
```

- [ ] **Step 3: Запустить тесты и убедиться, что они падают**

```bash
pytest tests/test_manifest.py -v
```

Ожидается: FAIL с `ModuleNotFoundError`.

- [ ] **Step 4: Реализовать `services/worker/app/domain/manifest.py`**

```python
"""Machine-readable file registry parsing.

The registry is mandatory: without it the package is accepted as
CLARIFICATION_REQUIRED. The exact column naming in the hidden test is unknown,
so headers are matched loosely and both Latin and Cyrillic captions are accepted.
"""

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import date, datetime

VALID_STAGES = {"PD", "RD", "ID"}
VALID_APPROVALS = {"DRAFT", "APPROVED", "FOR_CONSTRUCTION", "SUPERSEDED", "CANCELLED"}

COLUMN_ALIASES = {
    "object_id": {"object_id", "objectid", "объект", "объект_id", "id объекта"},
    # "file name" через пробел нужен обязательно: _canonical приводит
    # неразрывный пробел к обычному, и заголовок "file<NBSP>name" без этого
    # синонима не совпал бы ни с чем.
    "file_name": {"file_name", "file name", "filename", "имя файла", "файл",
                  "наименование файла"},
    "sha256": {"sha256", "sha-256", "хеш", "контрольная сумма"},
    "doc_stage": {"doc_stage", "stage", "стадия", "вид документации"},
    "discipline": {"discipline", "марка", "раздел", "дисциплина"},
    "document_code": {"document_code", "код", "шифр", "шифр документа"},
    "revision": {"revision", "rev", "редакция", "изм", "изменение"},
    "approval_status": {"approval_status", "статус", "статус утверждения"},
    "approval_date": {"approval_date", "дата утверждения", "дата"},
    "sheet_page_range": {"sheet_page_range", "листы", "диапазон листов", "страницы"},
    "predecessor_id": {"predecessor_id", "предшественник", "заменяет"},
    "signature_status": {"signature_status", "подпись", "статус подписи"},
}

REQUIRED = ("object_id", "file_name", "doc_stage")


@dataclass(frozen=True)
class ManifestEntry:
    file_name: str
    object_id: str
    doc_stage: str
    discipline: str | None = None
    document_code: str | None = None
    revision: str | None = None
    approval_status: str = "DRAFT"
    approval_date: date | None = None
    sheet_page_range: str | None = None
    predecessor_id: str | None = None
    signature_status: str | None = None
    sha256: str | None = None


@dataclass
class ManifestParseResult:
    entries: list[ManifestEntry] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _canonical(header: str) -> str | None:
    # Registries exported from Word or Excel routinely carry non-breaking
    # spaces in their headers; without this they match nothing.
    norm = header.strip().replace("\xa0", " ").lower()
    norm = " ".join(norm.split())
    for canonical, aliases in COLUMN_ALIASES.items():
        if norm in aliases:
            return canonical
    return None


_DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y")


def _parse_date(value: str | None) -> tuple[date | None, bool]:
    """Returns (parsed date, recognised).

    A date we cannot read must never pass as "no date": approval_date decides
    which of two revisions is the authoritative one, so losing it silently
    would let the wrong document become the reference.
    """
    if not value or not value.strip():
        return None, True
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value.strip(), fmt).date(), True
        except ValueError:
            continue
    return None, False


def _rows_from_csv(raw: bytes) -> list[dict[str, str]]:
    text = raw.decode("utf-8-sig")
    dialect = csv.Sniffer().sniff(text.splitlines()[0], delimiters=",;\t")
    return list(csv.DictReader(io.StringIO(text), dialect=dialect))


def _rows_from_xlsx(raw: bytes) -> list[dict[str, str]]:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(raw), data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    headers = ["" if h is None else str(h) for h in rows[0]]
    return [
        {headers[i]: ("" if cell is None else str(cell)) for i, cell in enumerate(row)}
        for row in rows[1:]
    ]


def _rows_from_json(raw: bytes) -> list[dict[str, str]]:
    payload = json.loads(raw.decode("utf-8"))
    if isinstance(payload, dict):
        payload = payload.get("files", [])
    return [{k: ("" if v is None else str(v)) for k, v in row.items()} for row in payload]


def parse_manifest(raw: bytes, filename: str) -> ManifestParseResult:
    result = ManifestParseResult()
    lower = filename.lower()

    try:
        if lower.endswith(".json"):
            rows = _rows_from_json(raw)
        elif lower.endswith((".xlsx", ".xlsm")):
            rows = _rows_from_xlsx(raw)
        else:
            rows = _rows_from_csv(raw)
    except Exception as exc:  # noqa: BLE001 - surfaced to the inspector, not swallowed
        result.errors.append(f"cannot read manifest: {exc}")
        return result

    if not rows:
        result.errors.append("manifest is empty")
        return result

    # JSON rows are arbitrary dicts and need not share a key set, so the
    # header map is built from every row, not just the first one.
    headers: list[str] = []
    for row in rows:
        for header in row.keys():
            if header not in headers:
                headers.append(header)

    mapping: dict[str, str] = {}
    claimed: dict[str, str] = {}
    for header in headers:
        canonical = _canonical(header)
        if not canonical:
            continue
        if canonical in claimed:
            result.errors.append(
                f"columns {claimed[canonical]!r} and {header!r} both mean "
                f"{canonical!r}; cannot tell which value is authoritative"
            )
            continue
        claimed[canonical] = header
        mapping[header] = canonical

    if result.errors:
        return result

    missing = [c for c in REQUIRED if c not in mapping.values()]
    if missing:
        result.errors.append(f"required columns are missing: {', '.join(missing)}")
        return result

    for index, row in enumerate(rows, start=2):
        values = {mapping[h]: (v or "").strip() for h, v in row.items() if h in mapping}

        absent = [c for c in REQUIRED if not values.get(c)]
        if absent:
            result.errors.append(f"row {index}: empty required columns: {', '.join(absent)}")
            continue

        stage = values.get("doc_stage", "").upper()
        if stage not in VALID_STAGES:
            result.errors.append(f"row {index}: unknown doc_stage {stage!r}")
            continue

        approval = values.get("approval_status", "DRAFT").upper() or "DRAFT"
        if approval not in VALID_APPROVALS:
            result.errors.append(f"row {index}: unknown approval_status {approval!r}")
            continue

        approval_date, date_recognised = _parse_date(values.get("approval_date"))
        if not date_recognised:
            result.errors.append(
                f"row {index}: unrecognised approval_date "
                f"{values.get('approval_date')!r}; expected one of {', '.join(_DATE_FORMATS)}"
            )

        result.entries.append(ManifestEntry(
            file_name=values["file_name"],
            object_id=values["object_id"],
            doc_stage=stage,
            discipline=values.get("discipline") or None,
            document_code=values.get("document_code") or None,
            revision=values.get("revision") or None,
            approval_status=approval,
            approval_date=approval_date,
            sheet_page_range=values.get("sheet_page_range") or None,
            predecessor_id=values.get("predecessor_id") or None,
            signature_status=values.get("signature_status") or None,
            sha256=values.get("sha256") or None,
        ))

    return result
```

- [ ] **Step 5: Запустить тесты**

```bash
pytest tests/test_manifest.py -v
```

Ожидается: 5 passed.

- [ ] **Step 6: Коммит**

```bash
git add services/worker/app/domain/manifest.py services/worker/tests/test_manifest.py services/worker/tests/fixtures
git commit -m "feat(worker): flexible manifest parsing for csv, xlsx and json"
```

---

## Task 7: Хранилище и хеширование файлов

**Files:**
- Create: `services/api/src/storage.ts`
- Test: `services/api/tests/storage.test.ts`

**Interfaces:**
- Consumes: `config.minio` из Task 3
- Produces:
  - `sha256(buffer: Buffer): string` — 64 символа в нижнем регистре
  - `storageKeyFor(hash: string): string` — `documents/ab/cd/<hash>`
  - `ensureBucket(): Promise<void>`
  - `putObject(key: string, body: Buffer, contentType: string): Promise<void>`
  - `getObject(key: string): Promise<Buffer>`

- [ ] **Step 1: Написать падающий тест**

`services/api/tests/storage.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { sha256, storageKeyFor, ensureBucket, putObject, getObject } from '../src/storage.js';

describe('storage', () => {
  beforeAll(async () => { await ensureBucket(); });

  it('computes a lowercase 64-char sha256', () => {
    const hash = sha256(Buffer.from('hello'));
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hash.toLowerCase());
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('shards the storage key by the first four hex characters', () => {
    expect(storageKeyFor('abcdef0123')).toBe('documents/ab/cd/abcdef0123');
  });

  it('round-trips an object through minio', async () => {
    const body = Buffer.from('%PDF-1.7 test');
    const key = storageKeyFor(sha256(body));
    await putObject(key, body, 'application/pdf');
    const back = await getObject(key);
    expect(back.equals(body)).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd services/api && npm test -- tests/storage.test.ts
```

Ожидается: FAIL с `Cannot find module '../src/storage.js'`.

- [ ] **Step 3: Реализовать `services/api/src/storage.ts`**

```typescript
import { createHash } from 'node:crypto';
import { Client } from 'minio';
import { config } from './config.js';

const client = new Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: false,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function storageKeyFor(hash: string): string {
  return `documents/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

export async function ensureBucket(): Promise<void> {
  const exists = await client.bucketExists(config.minio.bucket);
  if (!exists) await client.makeBucket(config.minio.bucket);
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client.putObject(config.minio.bucket, key, body, body.length, {
    'Content-Type': contentType,
  });
}

export async function getObject(key: string): Promise<Buffer> {
  const stream = await client.getObject(config.minio.bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
```

- [ ] **Step 4: Запустить тест**

```bash
npm test -- tests/storage.test.ts
```

Ожидается: 3 passed. Требует поднятого `minio` — `docker compose up -d minio`.

- [ ] **Step 5: Коммит**

```bash
git add services/api/src/storage.ts services/api/tests/storage.test.ts
git commit -m "feat(api): content-addressed file storage on minio"
```

---

## Task 8: Эндпоинт загрузки документов

**Files:**
- Create: `services/api/src/routes/documents.ts`
- Modify: `services/api/src/server.ts` — зарегистрировать `@fastify/multipart` и маршруты
- Test: `services/api/tests/upload.test.ts`

**Interfaces:**
- Consumes: `sha256`, `storageKeyFor`, `putObject` из Task 7; `prisma` из Task 3
- Produces: `POST /api/v1/documents/upload` → `201 { process_id, accepted: [...], rejected: [{ file_name, reason }] }`

Коды отклонения — ровно эти строки, они же выводятся в интерфейсе:
`UNSUPPORTED_FORMAT`, `FILE_TOO_LARGE`, `PACKAGE_TOO_LARGE`, `CORRUPTED_FILE`, `DUPLICATE`

- [ ] **Step 1: Написать падающие тесты**

`services/api/tests/upload.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { ensureBucket } from '../src/storage.js';

let objectId: string;

beforeAll(async () => {
  await ensureBucket();
  const object = await prisma.constructionObject.create({ data: { name: 'Upload test' } });
  objectId = object.id;
});

function form(files: Array<{ name: string; body: Buffer; type: string }>) {
  const boundary = '----test';
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\n` +
      `Content-Type: ${f.type}\r\n\r\n`
    ), f.body, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(parts) };
}

describe('POST /api/v1/documents/upload', () => {
  it('accepts a pdf and returns a process_id', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'ar-01.pdf', body: Buffer.from('%PDF-1.7 content'), type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.process_id).toBeTruthy();
    expect(body.accepted).toHaveLength(1);
    await app.close();
  });

  it('rejects an unsupported format', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'notes.txt', body: Buffer.from('plain'), type: 'text/plain' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('UNSUPPORTED_FORMAT');
    await app.close();
  });

  it('rejects a corrupted pdf whose magic bytes are wrong', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'broken.pdf', body: Buffer.from('not a pdf at all'), type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('CORRUPTED_FILE');
    await app.close();
  });

  it('rejects a duplicate of an already uploaded file', async () => {
    const app = await buildServer();
    const body = Buffer.from('%PDF-1.7 duplicate check');
    const first = form([{ name: 'dup.pdf', body, type: 'application/pdf' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${first.boundary}` },
      payload: first.payload,
    });

    const second = form([{ name: 'dup-again.pdf', body, type: 'application/pdf' }]);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${second.boundary}` },
      payload: second.payload,
    });

    expect(res.json().rejected[0].reason).toBe('DUPLICATE');
    await app.close();
  });

  it('rejects xml whose content is not markup at all', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'registry.xml', body: Buffer.from([0x00, 0x01, 0x02, 0x03]), type: 'application/xml' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('CORRUPTED_FILE');
    await app.close();
  });

  it('accepts xml that opens with a tag after a BOM', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'ok.xml', body: Buffer.from('﻿\n  <registry/>', 'utf8'), type: 'application/xml' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().accepted).toHaveLength(1);
    await app.close();
  });

  it('rejects a file above the per-file limit', async () => {
    const app = await buildServer();
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.7'),
      Buffer.alloc(52_428_801 - 8),
    ]);
    const { boundary, payload } = form([
      { name: 'huge.pdf', body: oversized, type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('FILE_TOO_LARGE');
    await app.close();
  });

  it('creates no process when every file is rejected', async () => {
    const app = await buildServer();
    const before = await prisma.process.count({ where: { objectId } });

    const { boundary, payload } = form([
      { name: 'notes.txt', body: Buffer.from('plain'), type: 'text/plain' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().process_id).toBeUndefined();
    expect(await prisma.process.count({ where: { objectId } })).toBe(before);
    await app.close();
  });
});
```

Проверка лимита пакета отдельным тестом не покрывается: он потребовал бы передать через `inject` более 200 МБ. Счётчик у обоих лимитов общий, и его поведение проверяется тестом на файл сверх лимита; сам отказ пакета проверяется в сквозном сценарии Task 11.

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

```bash
npm test -- tests/upload.test.ts
```

Ожидается: FAIL — маршрут не зарегистрирован, статус 404.

- [ ] **Step 3: Реализовать `services/api/src/routes/documents.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { sha256, storageKeyFor, putObject } from '../storage.js';

const ALLOWED = new Map([
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/xml', '.xml'],
  ['text/xml', '.xml'],
]);

const MAGIC: Record<string, Buffer> = {
  '.pdf': Buffer.from('%PDF'),
  '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

function looksCorrupted(extension: string, body: Buffer): boolean {
  if (extension === '.xml') {
    // XML has no magic number, but a readable document always opens with a
    // tag once the BOM and leading whitespace are gone. Without this, a file
    // of random bytes declared as XML would be stored as a valid registry.
    const text = body.toString('utf8').replace(/^﻿/, '').trimStart();
    return !text.startsWith('<');
  }
  const magic = MAGIC[extension];
  if (!magic) return false;
  return !body.subarray(0, magic.length).equals(magic);
}

const querySchema = z.object({ object_id: z.string().uuid() });

interface PendingFile {
  fileName: string;
  body: Buffer;
  mimeType: string;
}

export async function documentRoutes(app: FastifyInstance) {
  app.post('/api/v1/documents/upload', async (request, reply) => {
    const { object_id: objectId } = querySchema.parse(request.query);

    const pending: PendingFile[] = [];
    const rejected: Array<{ file_name: string; reason: string }> = [];
    let packageBytes = 0;

    // Phase 1: read and validate without storing anything. EVERY part counts
    // towards the package total, rejected ones included — otherwise the limit
    // is walked past with files of an unsupported type.
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;

      const body = await part.toBuffer();
      packageBytes += body.length;

      const extension = ALLOWED.get(part.mimetype);
      if (!extension) {
        rejected.push({ file_name: part.filename, reason: 'UNSUPPORTED_FORMAT' });
        continue;
      }
      if (body.length > config.maxFileBytes) {
        rejected.push({ file_name: part.filename, reason: 'FILE_TOO_LARGE' });
        continue;
      }
      if (looksCorrupted(extension, body)) {
        rejected.push({ file_name: part.filename, reason: 'CORRUPTED_FILE' });
        continue;
      }
      pending.push({ fileName: part.filename, body, mimeType: part.mimetype });
    }

    // The spec rejects the PACKAGE, not the offending file. Nothing has been
    // stored yet, so there is nothing to roll back.
    if (packageBytes > config.maxPackageBytes) {
      return reply.code(413).send({
        error: 'PACKAGE_TOO_LARGE',
        limit_bytes: config.maxPackageBytes,
        received_bytes: packageBytes,
      });
    }

    // Phase 2: store what survived validation.
    const process = await prisma.process.create({
      data: { objectId, status: 'PENDING' },
    });
    const accepted: Array<{ file_id: string; file_name: string; sha256: string }> = [];

    for (const file of pending) {
      const hash = sha256(file.body);
      const key = storageKeyFor(hash);
      try {
        await putObject(key, file.body, file.mimeType);
        const record = await prisma.fileRecord.create({
          data: {
            objectId,
            processId: process.id,
            fileName: file.fileName,
            fileHash: hash,
            storageKey: key,
            sizeBytes: file.body.length,
            mimeType: file.mimeType,
          },
        });
        accepted.push({ file_id: record.id, file_name: record.fileName, sha256: hash });
      } catch (error) {
        // The unique key is what forbids duplicates, not a lookup before the
        // insert: a pre-check still loses the race between two concurrent
        // uploads of the same file.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          rejected.push({ file_name: file.fileName, reason: 'DUPLICATE' });
          continue;
        }
        // One failed file must not sink the package: the others are already
        // stored, and the caller has to learn which ones.
        request.log.error({ file_name: file.fileName, err: error }, 'failed to store file');
        rejected.push({ file_name: file.fileName, reason: 'INTERNAL_ERROR' });
      }
    }

    // A process holding no documents would sit in the checks list forever,
    // indistinguishable from one still being parsed.
    if (accepted.length === 0) {
      await prisma.process.delete({ where: { id: process.id } });
      return reply.code(422).send({ accepted: [], rejected });
    }

    return reply.code(201).send({ process_id: process.id, accepted, rejected });
  });
}
```

Код отклонения `INTERNAL_ERROR` — наш, его нет в перечне ТЗ: тот описывает причины отказа при проверке файла, а не отказ самой системы. В интерфейсе он показывается как «Ошибка обработки, повторите загрузку».

Импорт `Prisma` добавляется к остальным:

```typescript
import { Prisma } from '@prisma/client';
```

- [ ] **Step 4: Зарегистрировать multipart и маршруты в `src/server.ts`**

Заменить тело `buildServer` на:

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { documentRoutes } from './routes/documents.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: () => crypto.randomUUID(),
    // Не терять при переносе: без этого Pino пишет reqId вместо request_id,
    // и формат лога перестаёт соответствовать ТЗ.
    requestIdLogLabel: 'request_id',
  });
  await app.register(multipart, { limits: { fileSize: config.maxPackageBytes } });
  await app.register(healthRoutes);
  await app.register(documentRoutes);
  return app;
}
```

- [ ] **Step 5: Запустить тесты**

```bash
npm test -- tests/upload.test.ts
```

Ожидается: 4 passed.

- [ ] **Step 6: Коммит**

```bash
git add services/api/src/routes/documents.ts services/api/src/server.ts services/api/tests/upload.test.ts
git commit -m "feat(api): document upload with format, size, corruption and duplicate checks"
```

---

## Task 9: Очередь — публикация из Node и приём в Python

**Files:**
- Create: `services/api/src/queue.ts`
- Create: `services/worker/app/config.py`, `services/worker/app/logging_setup.py`, `services/worker/app/consumer.py`, `services/worker/app/main.py`
- Test: `services/api/tests/queue.test.ts`, `services/worker/tests/test_consumer.py`

HTTP-маршруты процессов, которые вызывают `publishTask`, создаются в Task 11: до сборки всех сервисов их некому проверить сквозным путём.

**Interfaces:**
- Consumes: `config.rabbitmqUrl`
- Produces:
  - Node: `publishTask(task: { type: string; process_id: string; object_id: string }): Promise<void>` — публикует **обычный JSON** в очередь `inspector.tasks`
  - Python: `handle_task(payload: dict) -> str` — возвращает имя обработчика, которому досталась задача

Celery не используется намеренно: его формат сообщений неудобно формировать из Node. Контракт сообщения — плоский JSON.

- [ ] **Step 1: Написать падающий тест Node**

`services/api/tests/queue.test.ts`:

Тест сам открывает соединение с брокером и читает очередь — боевой модуль не содержит экспортов, существующих только ради тестов.

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import amqp from 'amqplib';
import { publishTask, closeQueue, TASK_QUEUE } from '../src/queue.js';
import { config } from '../src/config.js';

afterAll(async () => { await closeQueue(); });

// Vitest runs test files in parallel and they share one test queue, so this
// asserts that our own message is present rather than that the queue holds
// nothing else. Reading a single message would pick up another file's task.
async function drainQueue(): Promise<unknown[]> {
  const connection = await amqp.connect(config.rabbitmqUrl);
  const channel = await connection.createChannel();
  await channel.assertQueue(TASK_QUEUE, { durable: true });
  const messages: unknown[] = [];
  for (;;) {
    const message = await channel.get(TASK_QUEUE, { noAck: true });
    if (!message) break;
    messages.push(JSON.parse(message.content.toString()));
  }
  await channel.close();
  await connection.close();
  return messages;
}

describe('queue', () => {
  it('publishes a flat json task that can be read back', async () => {
    const processId = crypto.randomUUID();
    await publishTask({ type: 'process.start', process_id: processId, object_id: 'obj-1' });

    const messages = await drainQueue();

    expect(messages).toContainEqual({
      type: 'process.start',
      process_id: processId,
      object_id: 'obj-1',
    });
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npm test -- tests/queue.test.ts
```

Ожидается: FAIL с `Cannot find module '../src/queue.js'`.

- [ ] **Step 3: Реализовать `services/api/src/queue.ts`**

```typescript
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { config } from './config.js';

// The queue name is configurable so the test suite can use its own: with the
// worker container running it consumes from the real queue within
// milliseconds, and a test reading the same queue finds it already empty.
export const TASK_QUEUE = config.taskQueue;

// amqplib's connect resolves to a ChannelModel, not a Connection: the latter
// has no createChannel and typing it that way only compiles until tsc runs.
let connection: ChannelModel | null = null;
let channel: Channel | null = null;

async function getChannel(): Promise<Channel> {
  if (channel) return channel;
  const openConnection = await amqp.connect(config.rabbitmqUrl);
  const openChannel = await openConnection.createChannel();
  await openChannel.assertQueue(TASK_QUEUE, { durable: true });
  connection = openConnection;
  channel = openChannel;
  return openChannel;
}

export interface Task {
  type: string;
  process_id: string;
  object_id: string;
  [key: string]: unknown;
}

export async function publishTask(task: Task): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(TASK_QUEUE, Buffer.from(JSON.stringify(task)), {
    persistent: true,
    contentType: 'application/json',
  });
}

export async function closeQueue(): Promise<void> {
  await channel?.close();
  await connection?.close();
  channel = null;
  connection = null;
}
```

- [ ] **Step 4: Запустить тест Node**

```bash
npm test -- tests/queue.test.ts
```

Ожидается: PASS. Требует `docker compose up -d rabbitmq`.

- [ ] **Step 5: Написать падающий тест Python**

`services/worker/tests/test_consumer.py`:

```python
import pytest
from app.consumer import handle_task, UnknownTaskType


def test_routes_process_start_to_the_pipeline_handler():
    payload = {"type": "process.start", "process_id": "p1", "object_id": "o1"}
    assert handle_task(payload) == "pipeline.start"


def test_unknown_task_type_raises():
    with pytest.raises(UnknownTaskType):
        handle_task({"type": "nonsense", "process_id": "p1", "object_id": "o1"})


def test_missing_process_id_raises():
    with pytest.raises(ValueError):
        handle_task({"type": "process.start", "object_id": "o1"})
```

- [ ] **Step 6: Запустить тест Python и убедиться, что он падает**

```bash
cd services/worker && pytest tests/test_consumer.py -v
```

Ожидается: FAIL с `ModuleNotFoundError: No module named 'app.consumer'`.

- [ ] **Step 7: Реализовать `services/worker/app/config.py`**

```python
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    database_url: str
    rabbitmq_url: str
    log_level: str


def load_config() -> Config:
    return Config(
        database_url=os.environ["DATABASE_URL"],
        rabbitmq_url=os.environ["RABBITMQ_URL"],
        log_level=os.environ.get("LOG_LEVEL", "info").upper(),
    )
```

- [ ] **Step 8: Реализовать `services/worker/app/logging_setup.py`**

```python
import logging
from pythonjsonlogger import jsonlogger


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(jsonlogger.JsonFormatter(
        "%(asctime)s %(levelname)s %(message)s",
        rename_fields={"asctime": "timestamp", "levelname": "level"},
        static_fields={"service": "worker"},
    ))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
```

- [ ] **Step 9: Реализовать `services/worker/app/consumer.py`**

```python
"""Task routing for messages published by the Node API.

The API publishes plain JSON rather than Celery's own envelope, so routing is
explicit here.
"""

import json
import logging

logger = logging.getLogger(__name__)

# Must stay in step with the API's TASK_QUEUE: if the two ever name different
# queues, tasks are published into the void and nothing reports an error.
TASK_QUEUE = os.environ.get("TASK_QUEUE", "inspector.tasks")


class UnknownTaskType(Exception):
    pass


HANDLERS = {
    "process.start": "pipeline.start",
}


def handle_task(payload: dict) -> str:
    if "process_id" not in payload:
        raise ValueError("task payload has no process_id")

    task_type = payload.get("type")
    handler = HANDLERS.get(task_type)
    if handler is None:
        raise UnknownTaskType(f"no handler for task type {task_type!r}")

    logger.info("task routed", extra={"task_type": task_type,
                                      "process_id": payload["process_id"],
                                      "handler": handler})
    return handler


async def consume(connection_url: str) -> None:
    import aio_pika

    connection = await aio_pika.connect_robust(connection_url)
    channel = await connection.channel()
    queue = await channel.declare_queue(TASK_QUEUE, durable=True)

    async with queue.iterator() as messages:
        async for message in messages:
            async with message.process():
                payload = json.loads(message.body.decode())
                handle_task(payload)
```

- [ ] **Step 10: Реализовать `services/worker/app/main.py`**

```python
import asyncio

from app.config import load_config
from app.consumer import consume
from app.logging_setup import setup_logging


def main() -> None:
    config = load_config()
    setup_logging(config.log_level)
    asyncio.run(consume(config.rabbitmq_url))


if __name__ == "__main__":
    main()
```

- [ ] **Step 11: Запустить тест Python**

```bash
pytest tests/test_consumer.py -v
```

Ожидается: 3 passed.

- [ ] **Step 12: Коммит**

```bash
git add services/api/src/queue.ts services/api/tests/queue.test.ts services/worker/app services/worker/tests/test_consumer.py
git commit -m "feat: plain-json task queue between node api and python worker"
```

---

## Task 10: CRUD объектов

**Files:**
- Create: `services/api/src/routes/objects.ts`
- Modify: `services/api/src/server.ts` — зарегистрировать `objectRoutes`
- Test: `services/api/tests/objects.test.ts`

**Interfaces:**
- Consumes: `prisma` из Task 3
- Produces:
  - `POST /api/v1/objects` → `201 { id, name, address, customer, contractor, permit_number }`
  - `GET /api/v1/objects` → `200 { items: [{ id, name, address, files_count, last_process_status }] }`

- [ ] **Step 1: Написать падающие тесты**

`services/api/tests/objects.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('objects', () => {
  it('creates an object and returns it with an id', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/objects',
      payload: { name: 'Торговое здание', address: 'Алтуфьевское ш., 79Б' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Торговое здание');
    await app.close();
  });

  it('rejects an object without a name', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/objects', payload: { address: 'без имени' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists objects with a file count', async () => {
    const app = await buildServer();
    await app.inject({
      method: 'POST', url: '/api/v1/objects', payload: { name: 'Для списка' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/objects' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items[0]).toHaveProperty('files_count');
    await app.close();
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

```bash
cd services/api && npm test -- tests/objects.test.ts
```

Ожидается: FAIL — маршрут не зарегистрирован, статус 404 вместо 201.

- [ ] **Step 3: Реализовать `services/api/src/routes/objects.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const createSchema = z.object({
  // trim() before min(1): without it a name of spaces passes validation and
  // the inspector gets a supervision case with no readable title. The upper
  // bound keeps a stray paste out of an unbounded TEXT column.
  name: z.string().trim().min(1).max(500),
  address: z.string().optional(),
  customer: z.string().optional(),
  contractor: z.string().optional(),
  permit_number: z.string().optional(),
});

export async function objectRoutes(app: FastifyInstance) {
  app.post('/api/v1/objects', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED', details: parsed.error.issues });
    }

    const created = await prisma.constructionObject.create({
      data: {
        name: parsed.data.name,
        address: parsed.data.address,
        customer: parsed.data.customer,
        contractor: parsed.data.contractor,
        permitNumber: parsed.data.permit_number,
      },
    });

    return reply.code(201).send({
      id: created.id,
      name: created.name,
      address: created.address,
      customer: created.customer,
      contractor: created.contractor,
      permit_number: created.permitNumber,
    });
  });

  app.get('/api/v1/objects', async () => {
    const objects = await prisma.constructionObject.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { files: true } },
        processes: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
      },
    });

    return {
      items: objects.map((o) => ({
        id: o.id,
        name: o.name,
        address: o.address,
        files_count: o._count.files,
        last_process_status: o.processes[0]?.status ?? null,
      })),
    };
  });
}
```

- [ ] **Step 4: Зарегистрировать маршруты в `src/server.ts`**

Добавить импорт `import { objectRoutes } from './routes/objects.js';` и строку `await app.register(objectRoutes);` рядом с остальными регистрациями.

- [ ] **Step 5: Запустить тесты**

```bash
npm test -- tests/objects.test.ts
```

Ожидается: 3 passed.

- [ ] **Step 6: Коммит**

```bash
git add services/api/src/routes/objects.ts services/api/src/server.ts services/api/tests/objects.test.ts
git commit -m "feat(api): construction object crud"
```

---

## Task 11: Сборка сервисов в compose и сквозная проверка

**Files:**
- Create: `services/api/src/routes/processes.ts`
- Create: `services/api/Dockerfile`, `services/worker/Dockerfile`
- Modify: `services/api/src/server.ts` — зарегистрировать `processRoutes`
- Modify: `docker-compose.yml` — добавить `api` и `worker`
- Test: `services/api/tests/processes.test.ts`, `tests/e2e/test_upload_flow.sh`

**Почему маршруты процессов здесь.** Task 9 создала `publishTask`, но ни один HTTP-маршрут её не вызывает: в работающей системе документ загружается, а задача воркеру не уходит. Замкнуть это звено имеет смысл именно тут, где поднимаются все сервисы сразу и сквозной путь можно проверить целиком.

**Interfaces:**
- Consumes: всё из Tasks 1–10
- Produces: `docker compose up` поднимает систему; загруженный файл доходит до воркера

- [ ] **Step 1: Написать падающие тесты маршрутов процессов**

`services/api/tests/processes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { closeQueue, TASK_QUEUE } from '../src/queue.js';
import { config } from '../src/config.js';

let objectId: string;

beforeAll(async () => {
  const object = await prisma.constructionObject.create({ data: { name: 'Process routes test' } });
  objectId = object.id;
});

afterAll(async () => { await closeQueue(); });

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

async function makeProcess(fileCount: number) {
  const process = await prisma.process.create({ data: { objectId, status: 'PENDING' } });
  for (let i = 0; i < fileCount; i += 1) {
    await prisma.fileRecord.create({
      data: {
        objectId,
        processId: process.id,
        fileName: `sheet-${i}.pdf`,
        fileHash: hash64(),
        storageKey: `documents/xx/yy/${hash64()}`,
        sizeBytes: 1024,
        mimeType: 'application/pdf',
      },
    });
  }
  return process;
}

async function drainQueue(): Promise<unknown[]> {
  const connection = await amqp.connect(config.rabbitmqUrl);
  const channel = await connection.createChannel();
  await channel.assertQueue(TASK_QUEUE, { durable: true });
  const messages: unknown[] = [];
  for (;;) {
    const message = await channel.get(TASK_QUEUE, { noAck: true });
    if (!message) break;
    messages.push(JSON.parse(message.content.toString()));
  }
  await channel.close();
  await connection.close();
  return messages;
}

describe('process routes', () => {
  it('returns 404 for an unknown process', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/api/v1/processes/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reports status and file count', async () => {
    const app = await buildServer();
    const process = await makeProcess(2);

    const res = await app.inject({ method: 'GET', url: `/api/v1/processes/${process.id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'PENDING', files_count: 2 });
    await app.close();
  });

  it('refuses to start a process with no files', async () => {
    const app = await buildServer();
    const process = await makeProcess(0);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NO_FILES_UPLOADED');
    await app.close();
  });

  it('starts a process and publishes one task', async () => {
    await drainQueue();
    const app = await buildServer();
    const process = await makeProcess(1);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'PARSING' });

    const messages = await drainQueue();
    expect(messages).toContainEqual({
      type: 'process.start', process_id: process.id, object_id: objectId,
    });
    await app.close();
  });

  it('refuses to start the same process twice', async () => {
    const app = await buildServer();
    const process = await makeProcess(1);

    await app.inject({ method: 'POST', url: `/api/v1/processes/${process.id}/start` });
    const second = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('ALREADY_STARTED');
    await app.close();
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

```bash
cd services/api && npm test -- tests/processes.test.ts
```

Ожидается: FAIL — маршруты не зарегистрированы, вместо 404 и 202 приходит 404 от самого Fastify на неизвестный путь, а тест запуска падает на статусе.

- [ ] **Step 3: Реализовать `services/api/src/routes/processes.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { publishTask } from '../queue.js';

const paramsSchema = z.object({ process_id: z.string().uuid() });

export async function processRoutes(app: FastifyInstance) {
  app.get('/api/v1/processes/:process_id', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const process = await prisma.process.findUnique({
      where: { id: parsed.data.process_id },
      include: { _count: { select: { files: true } } },
    });
    if (!process) return reply.code(404).send({ error: 'PROCESS_NOT_FOUND' });

    return {
      process_id: process.id,
      object_id: process.objectId,
      status: process.status,
      scenario: process.scenario,
      files_count: process._count.files,
      updated_at: process.updatedAt,
    };
  });

  app.post('/api/v1/processes/:process_id/start', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const process = await prisma.process.findUnique({
      where: { id: parsed.data.process_id },
      include: { _count: { select: { files: true } } },
    });
    if (!process) return reply.code(404).send({ error: 'PROCESS_NOT_FOUND' });

    // Checking a package with no documents would produce a protocol about
    // files that were never uploaded.
    if (process._count.files === 0) {
      return reply.code(409).send({ error: 'NO_FILES_UPLOADED' });
    }

    // Publishing twice would run the whole pipeline twice over one package.
    if (process.status !== 'PENDING') {
      return reply.code(409).send({ error: 'ALREADY_STARTED', status: process.status });
    }

    await prisma.process.update({
      where: { id: process.id },
      data: { status: 'PARSING' },
    });

    await publishTask({
      type: 'process.start',
      process_id: process.id,
      object_id: process.objectId,
    });

    return reply.code(202).send({ process_id: process.id, status: 'PARSING' });
  });
}
```

- [ ] **Step 4: Зарегистрировать маршруты и подготовить хранилище в `src/server.ts`**

Добавить импорт `import { processRoutes } from './routes/processes.js';` и строку `await app.register(processRoutes);` рядом с остальными регистрациями. Опцию `requestIdLogLabel: 'request_id'` не трогать.

Кроме того, в блок запуска добавить создание корзины MinIO. Без этого на свежем развёртывании корзины не существует, и **каждая** загрузка документа падает с `The specified bucket does not exist`. Тесты этого не видят: они создают корзину сами в `beforeAll`.

```typescript
import { ensureBucket } from './storage.js';

// …

const isEntry = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isEntry) {
  const app = await buildServer();
  // On a fresh deployment the bucket does not exist yet, and every upload
  // fails with "The specified bucket does not exist". Tests never saw this
  // because they create the bucket themselves before they run.
  await ensureBucket();
  app.log.info({ bucket: config.minio.bucket }, 'object storage ready');
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
```

- [ ] **Step 5: Развести тестовую и боевую очереди**

С поднятым воркером тесты очереди становятся ложно-красными: контейнер вычитывает сообщение за миллисекунды, и тест, читающий ту же очередь, находит её пустой. Имя очереди берётся из конфигурации (`TASK_QUEUE`), а набор тестов работает со своей.

`services/api/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The worker service consumes the production queue as soon as anything
    // lands on it, so the suite publishes to a queue of its own.
    env: { TASK_QUEUE: 'inspector.tasks.test' },
  },
});
```

Воркер читает то же имя из окружения с тем же значением по умолчанию: расхождение настроек между двумя сервисами разорвало бы связь молча, без единой ошибки.

- [ ] **Step 6: Запустить тесты**

```bash
npm test
```

Ожидается: 22 passed — 17 существующих плюс пять новых по маршрутам процессов.

- [ ] **Step 6: Создать `services/api/Dockerfile`**

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
# node:20-slim ships without OpenSSL, and Prisma's engines refuse to run
# without it: the container starts, then dies on the first migration.
RUN apt-get update  && apt-get install -y --no-install-recommends openssl ca-certificates  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update  && apt-get install -y --no-install-recommends openssl ca-certificates  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

- [ ] **Step 7: Создать `services/worker/Dockerfile`**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
# The package has to exist before the install: an editable install resolves
# its packages at install time, and with app/ still missing setuptools finds
# nothing to install.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .
CMD ["python", "-m", "app.main"]
```

- [ ] **Step 8: Добавить сервисы в `docker-compose.yml`**

```yaml
  api:
    build: ./services/api
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    ports:
      - "3000:3000"
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
      minio: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 10s
      timeout: 5s
      retries: 10

  worker:
    build: ./services/worker
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    depends_on:
      postgres: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
```

- [ ] **Step 9: Написать сквозной тест `tests/e2e/test_upload_flow.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

API=http://localhost:3000/api/v1

echo "1. health"
curl -fsS "$API/health" | grep -q '"status":"ok"'

echo "2. create object"
# Тело пишем файлом в явном UTF-8: curl в Git Bash на Windows считает
# Content-Length в кодировке консоли и на кириллице расходится с телом.
mkdir -p .e2e-tmp
printf '%s' '{"name":"Торговое здание","address":"Алтуфьевское ш., 79Б"}' > .e2e-tmp/object.json
OBJECT_ID=$(curl -fsS -X POST "$API/objects" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @.e2e-tmp/object.json \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "3. upload a pdf"
# Путь относительный намеренно: curl в Git Bash коверкает абсолютный путь,
# когда рядом стоит ';type=' — точка с запятой трактуется как разделитель
# списка путей Windows.
printf '%%PDF-1.7 e2e' > .e2e-tmp/upload.pdf
RESPONSE=$(curl -fsS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  -F 'files=@.e2e-tmp/upload.pdf;type=application/pdf')
echo "$RESPONSE" | grep -q '"process_id"'
echo "$RESPONSE" | grep -q '"accepted":\[{'

PROCESS_ID=$(echo "$RESPONSE" | python -c 'import sys,json; print(json.load(sys.stdin)["process_id"])')

echo "4. duplicate is rejected"
# Без -f намеренно: пакет, в котором отклонены все файлы, отвечает 422,
# и это ожидаемый ответ, а не сбой запроса.
curl -sS -X POST "$API/documents/upload?object_id=$OBJECT_ID" \
  -F 'files=@.e2e-tmp/upload.pdf;type=application/pdf' | grep -q 'DUPLICATE'

echo "5. process status is readable"
curl -fsS "$API/processes/$PROCESS_ID" | grep -q '"status":"PENDING"'

echo "6. starting the process publishes a task"
curl -fsS -X POST "$API/processes/$PROCESS_ID/start" | grep -q '"status":"PARSING"'

echo "7. the worker actually received it"
# Единственная проверка, доказывающая, что две половины системы соединены:
# всё остальное проверяет только свою сторону границы.
for _ in $(seq 1 20); do
  if docker compose logs worker 2>/dev/null | grep -q "$PROCESS_ID"; then
    echo "PASS"
    exit 0
  fi
  sleep 1
done

echo "FAIL: worker never logged process $PROCESS_ID" >&2
docker compose logs --tail 50 worker >&2
exit 1
```

- [ ] **Step 10: Запустить сквозной тест**

```bash
docker compose up -d --build
sleep 20
chmod +x tests/e2e/test_upload_flow.sh
./tests/e2e/test_upload_flow.sh
```

Ожидается: вывод `PASS`. Шаг 7 скрипта — единственная проверка во всём плане, доказывающая, что Node и Python действительно соединены: он ждёт появления идентификатора процесса в логах воркера и падает с выводом последних строк лога, если тот не пришёл за двадцать секунд. Остальные тесты проверяют только свою сторону границы.

- [ ] **Step 11: Проверить холодный старт без кеша и без сети**

```bash
docker compose down -v
docker compose build --no-cache
docker compose up -d
sleep 30
curl -fsS http://localhost:3000/api/v1/health
```

Ожидается: `{"status":"ok","service":"api"}`. Это репетиция того, как решение будут запускать на стенде.

- [ ] **Step 12: Запинить все сторонние образы по digest**

Решение запускают на стенде офлайн, после дедлайна и без нас. Плавающий тег либо не подтянется, либо подтянет не тот образ, который мы тестировали. Все четыре сторонних образа должны быть зафиксированы по неизменяемому digest'у, а не по тегу.

Снять фактические digest'ы с уже поднятых контейнеров:

```bash
for image in pgvector/pgvector:pg16 redis:7-alpine rabbitmq:3.13-management-alpine minio/minio:latest; do
  docker image inspect "$image" --format '{{.RepoTags}} -> {{index .RepoDigests 0}}'
done
```

Заменить в `docker-compose.yml` каждую строку `image:` на форму `image: <repo>@sha256:<digest>`, подставив полученные значения. Для `minio/minio` это обязательно: это единственный образ, объявленный через `latest`.

- [ ] **Step 13: Проверить, что система поднимается на запиненных образах**

```bash
docker compose down -v
docker compose up -d
sleep 30
docker compose ps
curl -fsS http://localhost:3000/api/v1/health
```

Ожидается: все сервисы `running (healthy)`, health-эндпоинт отвечает. Если какой-то digest не резолвится — значит образ был подтянут из локального кеша и в реестре его нет; взять в этом случае явный версионный тег, а не возвращать `latest`.

- [ ] **Step 14: Коммит**

```bash
git add services/api/Dockerfile services/worker/Dockerfile docker-compose.yml tests/e2e
git commit -m "feat: containerise api and worker, add end-to-end upload check"
```

---

## Дальнейшие планы

План 1 даёт работающий приём документов. Следующие планы пишутся отдельно, каждый — по завершении предыдущего:

| План | Содержание | Критерий готовности |
|---|---|---|
| **2. Разбор страниц** | текстовый слой PyMuPDF, рендер, нормализация координат с учётом `CropBox`/`MediaBox`/`Rotate`, OCR для сканов | координаты доказательства верны на всех четырёх углах поворота листа |
| **3. Извлечение параметров** | конвертер Матрицы в спецификации, индексация, гибридный поиск, модальность `scalar_text` | извлекаются площади из ТЭП эталонного объекта с координатами |
| **4. Сравнение и протокол** | доказательные группы, движок сравнения, протокол с пятью таблицами, версионирование, инкрементальное обновление | протокол формируется по эталонному объекту |
| **5. Верификация** | вердикты, коды причин, разбиение составных кандидатов, финализация, экспорт PDF/DOCX/XML | инспектор проходит протокол за ≤ 3 клика на кандидата |
| **6. Чертёжные параметры** | vLLM, модальность `drawing_entity`, свободный поиск гипотез | воспроизводятся находки из эталонной разметки — вентиляция, тёплые полы |

---

## Проверка плана на соответствие архитектуре

| Требование архитектуры | Задача плана |
|---|---|
| Запуск одной командой, офлайн | Task 1, Task 11 Step 6 |
| CRUD объектов | Task 10 |
| Перезапись под тем же `file_id` запрещена | Task 2 (`@@unique`), Task 8 (`DUPLICATE`) |
| Лимиты 50 МБ / 200 МБ, форматы PDF/DOCX/XML | Task 8 |
| Пять сценариев ошибок загрузки | Task 8 — четыре из пяти; таймаут обработки относится к Плану 2 |
| Реестр обязателен, без него `CLARIFICATION_REQUIRED` | Task 6 (разбор); связывание с процессом — План 2 |
| Шесть правил выбора источника | Task 4 |
| Комплектность и сценарий загрузки | Task 5 |
| Граница Node/Python только через очередь и базу | Task 9 |
| Celery не используется, плоский JSON | Task 9 |
| Структурные JSON-логи с обязательными полями | Task 3, Task 9 Step 8 |
| Статусы пишутся как в ТЗ | Task 2 (enum'ы) |

**Не покрыто Планом 1 сознательно:** аутентификация и роли (переносятся в План 5 вместе с вердиктами, где впервые нужен `verified_by`) и антивирусная проверка (отдельная задача Плана 2).
