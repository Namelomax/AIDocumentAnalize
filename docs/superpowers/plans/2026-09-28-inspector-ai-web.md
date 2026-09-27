# План 7. Веб-интерфейс на живом API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Интерфейс, сделанный дизайнером (React 19, Vite, Tailwind 4; каталог `Инспектор ИИ веб-сервис_Визуал`, репозиторий `github.com/Crooak/chakaton`, ветка `Figm_Cloud_Dips`), входит в систему как сервис `web`, поднимается той же командой `docker compose up`, работает с настоящим API вместо моков: вход, дашборд с цветовой индикацией, загрузка пакета, ход обработки, протокол, верификация с изображениями страниц и подсветкой доказательств, финализация.

**Architecture:** Бэкенд дополняется эндпоинтами, которых не хватает экранам: сводка дашборда, карточка объекта, файлы объекта, ход обработки. Приложение копируется в `services/web` без собственного `.git` и собирается в образ на nginx, который отдаёт статику и проксирует `/api` в сервис `api` — браузер ходит на один адрес, и CORS не нужен. Экраны перестают импортировать моки: данные идут через `src/api/client.ts` (запросы с токеном) и `src/api/adapters.ts` (snake_case API → типы интерфейса в camelCase). Экраны переписываются минимально: меняется источник данных, не вёрстка.

**Tech Stack:** React 19, Vite 8, TypeScript, Tailwind 4, nginx; Node.js 20, Fastify, Prisma.

## Global Constraints

- **Вёрстку дизайнера не переделывать.** Задача — заменить источник данных. Визуальные правки — только там, где их требуют новые данные (изображение страницы в карточке доказательства, пустое состояние экрана гипотез).
- **Сеть на стенде отсутствует.** Образ `web` собирается с зависимостями внутри; во время работы никаких обращений наружу — ни шрифтов, ни CDN. Проверить, что приложение не грузит шрифты с Google Fonts или других внешних адресов; если грузит — перенести шрифт в образ.
- **Моки не удаляются как файл**, но ни один экран их больше не импортирует для данных. Подписи (`statusLabels`, `approvalLabels`, `reasonLabels`) — это справочники интерфейса, не данные; их можно оставить в месте, где они лежат, вынеся из `mocks/`.
- Экран «Гипотезы» до модуля свободного поиска показывает честное пустое состояние («модуль свободного поиска гипотез ещё не подключён»), а не моки. Показывать выдуманные гипотезы как настоящие нельзя.
- Токен хранится в `sessionStorage` (закрытие вкладки — выход); ответ `401` любого запроса возвращает на экран входа.
- Тексты для пользователя — по-русски. Комментарии в коде — по-английски, объясняют *почему*.

**Цветовая индикация объекта** (модуль 7 ТЗ называет её, не определяя):

| Цвет | Когда |
|---|---|
| красный | в последнем протоколе объекта есть подтверждённые инспектором нарушения |
| жёлтый | есть кандидаты без решения, требуются уточнения, или объект ещё не проверен |
| зелёный | последний протокол проверен или финализирован, нарушений нет |

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `services/api/src/routes/objects.ts` | список объектов для дашборда, карточка объекта, файлы объекта |
| `services/api/src/routes/dashboard.ts` | сводка дашборда |
| `services/api/src/routes/processes.ts` | ход обработки |
| `services/api/src/objects/indicator.ts` | цвет объекта, чистая функция |
| `services/web/` | приложение дизайнера |
| `services/web/Dockerfile` | сборка Vite → nginx |
| `services/web/nginx.conf` | статика и прокси `/api` |
| `services/web/src/api/client.ts` | запросы с токеном, `401` → вход |
| `services/web/src/api/adapters.ts` | ответы API → типы интерфейса |
| `docker-compose.yml` | сервис `web` |

---

### Task 1: Эндпоинты дашборда и объекта

**Files:**
- Create: `services/api/src/objects/indicator.ts`, `services/api/src/routes/dashboard.ts`, `services/api/tests/dashboard.test.ts`
- Modify: `services/api/src/routes/objects.ts`, `services/api/src/server.ts`, `services/api/tests/objects.test.ts`

**Interfaces:**
- `indicatorFor(latest: { status: string; confirmed: number; candidates: number; clarifications: number } | null): 'green' | 'yellow' | 'red'` — по таблице выше.
- `GET /api/v1/objects` — каждый элемент дополняется полями: `address`, `customer`, `contractor`, `permit_number`, `completeness: { pd, rd, id }` (из последнего процесса, значения `UPLOADED | PARTIAL | MISSING | NOT_APPLICABLE | null`), `process_status`, `latest_process_id`, `latest_protocol_id`, `candidates`, `confirmed`, `updated_at`, `indicator`. Существующие поля не убираются.
- `GET /api/v1/objects/:object_id` — те же поля одного объекта плюс `processes: [{ process_id, status, scenario, created_at, protocol_id, protocol_version }]`, новые сверху.
- `GET /api/v1/objects/:object_id/files` — `{ items: [{ id, file_name, doc_stage, discipline, document_code, revision, approval_status, page_count, size_bytes, file_sha256, from_manifest, uploaded_at, process_id }] }`. Строка реестра в список входит с `doc_stage = null` — интерфейс показывает её отдельно.
- `GET /api/v1/dashboard/summary` — `{ objects_in_work, awaiting_verification, candidates_to_review, finalized_this_month }`: объекты, чей последний процесс не финализирован; протоколы в статусах `READY` и `VERIFYING`; кандидаты без решения во всех нефинализированных протоколах; протоколы, финализированные с начала текущего месяца.

`page_count` у файла сейчас пуст — воркер его не пишет. Считать его в ответе по таблице `pages` (`count(*)` страниц файла), а не менять воркер.

- [ ] **Step 1: Тесты**

`tests/dashboard.test.ts` и дополнения `tests/objects.test.ts` — данные через Prisma, с уборкой. Проверить:
1. `indicatorFor`: все три цвета и случай `null` (не проверен → жёлтый) — чистыми вызовами.
2. Объект с протоколом, где есть `CONFIRMED_VIOLATION`, в списке — `red`; с нерешённым кандидатом — `yellow`; с финализированным протоколом без нарушений — `green`.
3. Файлы объекта — с числом страниц из `pages` и без строк других объектов.
4. Сводка — на своих тестовых данных, сравнением «до и после» создания данных, потому что база общая и абсолютные числа в ней не известны.
5. Несуществующий объект — `404`.

- [ ] **Step 2: Реализовать, прогнать, commit**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`

```bash
git add services/api
git commit -m "feat(api): serve the dashboard, the object card and its files"
```

---

### Task 2: Ход обработки

**Files:**
- Modify: `services/api/src/routes/processes.ts`
- Test: `services/api/tests/processes.test.ts`

**Interfaces:**
- `GET /api/v1/processes/:process_id/progress` → `{ status, files: { total, pdf }, pages: { extracted, needs_ocr }, checks: { total, candidates }, protocol_id }`.

Экран обработки дизайнера показывает этапы (распознавание, извлечение, анализ чертежей, сопоставление) и журнал. Честное соответствие данным: «распознавание» — извлечённые страницы из `pages` против числа PDF; «извлечение значений» — число проверок; «анализ чертежей» — этап ещё не реализован и показывается как недоступный; «сопоставление» — готово, когда статус процесса `READY` и дальше. Этот эндпоинт даёт числа; соответствие этапам — в адаптере интерфейса.

- [ ] **Step 1: Тест, реализация, commit**

Тест: процесс с двумя PDF, одной страницей в `pages` и тремя проверками — числа совпадают; чужой процесс — `404`.

```bash
git add services/api
git commit -m "feat(api): report processing progress for the processing screen"
```

---

### Task 3: Приложение в системе

**Files:**
- Create: `services/web/` (копия приложения), `services/web/Dockerfile`, `services/web/nginx.conf`, `services/web/.dockerignore`
- Modify: `docker-compose.yml`, `README.md`, `scripts/build-offline-bundle.sh`

- [ ] **Step 1: Скопировать приложение**

Скопировать содержимое `Инспектор ИИ веб-сервис_Визуал/` в `services/web/`, **исключив** `.git`, `node_modules`, `dist`, `pnpm-lock.yaml` (сборка идёт через npm и `package-lock.json`), файлы `.figma*`, `AGENTS.md` и `CLAUDE.md` дизайнера. Файл `src/imports/*.pdf` (образец) оставить, если он используется экранами; иначе — не копировать и описать в отчёте.

- [ ] **Step 2: Dockerfile и nginx**

`services/web/Dockerfile`:

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# nginx serves the built files and forwards /api to the api service, so the
# browser talks to one origin: no CORS, and the API port need not be exposed.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

Образ `nginx:1.27-alpine` запинить по digest, как остальные сторонние образы в `docker-compose.yml`: найти digest через `docker pull nginx:1.27-alpine` и `docker inspect`.

`services/web/nginx.conf`:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    # Uploads are up to 200 MiB per package (section 9.1); nginx refuses
    # anything above 1 MiB by default.
    client_max_body_size 210m;

    location /api/ {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }

    # The app routes on the client; any unknown path is the app itself.
    location / {
        try_files $uri /index.html;
    }
}
```

Проверить, что API берёт IP клиента из `X-Forwarded-For` для журнала аудита (Fastify `trustProxy`). Если нет — включить `trustProxy: true` в `buildServer` и закрепить тестом, что `request.ip` берётся из заголовка; иначе в журнале у всех действий будет адрес nginx.

- [ ] **Step 3: Сервис в compose**

```yaml
  web:
    image: inspector-web:1.0.0
    build: ./services/web
    ports:
      - "8080:80"
    depends_on:
      api: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

В `scripts/build-offline-bundle.sh` добавить `inspector-web:1.0.0` и digest nginx в список сохраняемых образов. В README: интерфейс открывается на `http://localhost:8080`.

- [ ] **Step 4: Проверить и commit**

```bash
docker compose up -d --build web
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/
curl -s http://localhost:8080/api/v1/health
```

Expected: `200` и ответ проверки живости API через прокси.

```bash
git add services/web docker-compose.yml README.md scripts
git commit -m "feat(web): bring the designer's interface into the system behind nginx"
```

---

### Task 4: Клиент API, адаптеры, вход, дашборд, загрузка

**Files:**
- Create: `services/web/src/api/client.ts`, `services/web/src/api/adapters.ts`, `services/web/src/labels.ts`
- Modify: `services/web/src/App.tsx`, `src/screens/LoginScreen.tsx`, `src/screens/DashboardScreen.tsx`, `src/screens/UploadScreen.tsx`, `src/screens/ObjectScreen.tsx`, `src/types/index.ts`, `src/components/StatusBadge.tsx`, `src/components/EvidencePanel.tsx`

**Interfaces:**
- `client.ts`: `login(login, password)`, `api<T>(path, init?)` — добавляет `Authorization: Bearer`, при `401` очищает токен и вызывает зарегистрированный обработчик выхода; `apiBlob(path)` — для изображений; `uploadPackage(objectId, files, onProgress?)` — multipart.
- `adapters.ts`: функции `toProjectObject`, `toUploadedFile`, `toProtocol`, `toFinding`, `toEvidenceFragment` — единственное место, знающее обе схемы.
- В `types/index.ts`: у `EvidenceFragment` — поле `fileId: string` (ТЗ требует `file_id` в карточке доказательства) и `imageUrl: string`; у комплектности — значение `'not_applicable'`.

- [ ] **Step 1: Клиент и адаптеры с тестами**

Добавить в `services/web` `vitest` как dev-зависимость и тесты адаптеров на примерах ответов API из Плана 6 (форма находки в разделе Task 3 плана `2026-09-27-inspector-ai-protocol.md`): snake_case → camelCase, `bbox` из четырёх чисел, `decision` из `verified_by`/`reason_code`, статус находки — из `finding_status`, при его отсутствии — из `completeness_status`.

- [ ] **Step 2: Экраны**

- **Вход** — настоящий `POST /api/v1/auth/login`; неверные данные — сообщение «Неверный логин или пароль»; имя и роль пользователя в боковой панели — из ответа входа вместо мока `inspector`.
- **Дашборд** — `GET /api/v1/objects` и `GET /api/v1/dashboard/summary`; создание объекта, если экран это предусматривает, — `POST /api/v1/objects`.
- **Загрузка** — файлы объекта `GET /api/v1/objects/:id/files`; загрузка пакета `POST /api/v1/documents/upload`; отказы показываются текстом `message` из ответа сервера, а не зашитыми строками `uploadErrors`; лимиты — из `GET /api/v1/upload/limits`; «Запустить проверку» — `POST /api/v1/processes/:id/start` и переход на экран обработки с `processId`.
- **Карточка объекта** — `GET /api/v1/objects/:id`.

Навигационное состояние (`NavState`) дополнить `processId`. Зашитые идентификаторы вроде `'obj-altuf'` и `'p-2025-0147'` убрать.

- [ ] **Step 3: Проверить сборку и commit**

```bash
cd services/web && npx tsc --noEmit && npx vitest run && npm run build
```

```bash
git add services/web
git commit -m "feat(web): log in, list objects and upload packages against the real api"
```

---

### Task 5: Обработка, протокол, верификация, финализация

**Files:**
- Modify: `src/screens/ProcessingScreen.tsx`, `src/screens/ProtocolScreen.tsx`, `src/screens/VerificationScreen.tsx`, `src/screens/FinalizationScreen.tsx`, `src/screens/HypothesesScreen.tsx`, `src/components/EvidencePanel.tsx`, `src/App.tsx`

- [ ] **Step 1: Экраны**

- **Обработка** — опрос `GET /api/v1/processes/:id/progress` раз в две секунды до статуса `READY`; этапы — по соответствию из Task 2; «Анализ чертежей» — недоступен, с подписью «требует GPU-стенда». По готовности — переход к протоколу с настоящим `protocol_id`.
- **Протокол** — `GET /api/v1/protocols/:id`; раздел комплектности — из `completeness`, находки — из `findings`, раздельно.
- **Верификация** — находки протокола; решения — `POST /api/v1/findings/:id/verdict` с кодами причин интерфейса; ответ сервера заменяет находку в состоянии экрана. Горячие клавиши и «не более трёх кликов на нарушение» (п. 9.3 ТЗ) сохраняются — не добавлять шагов.
- **Карточка доказательства** — изображение страницы: `apiBlob(image_url)` → `URL.createObjectURL`, рамка `bbox` поверх изображения в процентах, как уже умеет компонент. Объектный адрес освобождать при смене находки (`URL.revokeObjectURL`), иначе память растёт с каждой открытой карточкой.
- **Финализация** — `POST /api/v1/protocols/:id/finalize`; при `409 CANDIDATES_PENDING` — показать, сколько кандидатов осталось. Отмена финализации — кнопка видна только ролям `SUPERVISOR` и `ADMIN`, с обязательной причиной.
- **Гипотезы** — пустое состояние с объяснением.

- [ ] **Step 2: Проверить в браузере**

Собрать и поднять систему, пройти в headless-браузере полный путь на пакете из сквозного сценария (эталонные листы школы): вход под `inspector` → дашборд → объект → протокол → верификация → решение по обоим кандидатам → финализация. Снять снимки экрана протокола и карточки доказательства с изображением страницы и рамкой, проверить отсутствие ошибок в консоли браузера и неудачных сетевых запросов.

- [ ] **Step 3: Commit**

```bash
git add services/web
git commit -m "feat(web): verify findings and finalize protocols against the real api"
```

---

## Что этот план сознательно не делает

- **Экспорт протокола** в PDF, DOCX и XML — отдельный план; кнопки экспорта на экранах временно недоступны с подсказкой.
- **Модуль свободного поиска гипотез** — экран остаётся пустым с объяснением.
- **Разбиение составного кандидата** — интерфейс его рисует, но движок составных кандидатов пока не порождает.
- **Юзабилити-тестирование на пяти инспекторах** (п. 9.3) — организационная задача, не код.
