# План 5. Вход, роли, пользователь в логах и журнал аудита

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь входит по логину и паролю и получает токен; все эндпоинты, кроме проверки живости и входа, требуют токен; каждая строка лога API несёт настоящий `user_id`; каждое изменяющее действие записывается в журнал аудита с временем, IP-адресом, типом действия и объектом; отказ в приёме файла называет допустимые форматы и размеры.

**Architecture:** Раздел 12 ТЗ требует аутентификацию по логину и паролю, разграничение ролей (инспектор, администратор, ML-инженер; супервизор — для отмены финализации по п. 9.3) и журнал аудита каждого действия. Раздел 13 — поле `user_id` в каждой строке лога. Без этого слоя невозможен следующий — верификация: решение инспектора обязано нести его `user_id`, а подтверждённое нарушение без проверившего база должна запрещать. Токен — JWT через уже установленный `@fastify/jwt`. Пользователь запроса хранится в `AsyncLocalStorage`, откуда его читает логгер.

**Tech Stack:** Node.js 20, Fastify 4.29, `@fastify/jwt` 8, pino 9, Prisma, Zod, bcryptjs.

## Global Constraints

- Внешние сетевые вызовы запрещены. `bcryptjs` выбран потому, что он чисто на JavaScript и не требует сборки нативного модуля при офлайн-сборке образа.
- Проверяющие на стенде работают без команды, поэтому **демонстрационные учётные записи создаются автоматически при первом старте** и описываются в README. Пароли задаются переменными окружения со значениями по умолчанию.
- Ответ на неудачный вход одинаков для несуществующего логина и неверного пароля — `401 INVALID_CREDENTIALS`. Иначе API подсказывает, какие логины существуют.
- Формат лога — поля `timestamp`, `level`, `service`, `message`, `request_id`, `user_id`, **каждое ровно один раз** в строке.
- Комментарии в коде — по-английски, объясняют *почему*. Комментарии вида «добавлено», «изменено» запрещены.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `services/api/src/auth/passwords.ts` | хеширование и проверка паролей |
| `services/api/src/auth/context.ts` | пользователь текущего запроса в `AsyncLocalStorage` |
| `services/api/src/auth/plugin.ts` | регистрация JWT, проверка токена, `requireRole` |
| `services/api/src/auth/seed.ts` | демонстрационные учётные записи при первом старте |
| `services/api/src/routes/auth.ts` | `POST /api/v1/auth/login`, `GET /api/v1/auth/me` |
| `services/api/src/audit.ts` | запись в журнал аудита |
| `services/api/src/logger.ts` | `user_id` из контекста запроса |
| `services/api/src/routes/documents.ts` | сообщения об отказе с лимитами и форматами; `GET /api/v1/upload/limits` |
| `services/api/tests/helpers/auth.ts` | заголовок авторизации для тестов |

---

### Task 1: Пароли, демонстрационные учётные записи и вход

**Files:**
- Create: `services/api/src/auth/passwords.ts`, `services/api/src/auth/seed.ts`, `services/api/src/routes/auth.ts`
- Modify: `services/api/src/config.ts`, `services/api/src/server.ts`, `docker-compose.yml`, `.env.example`, `README.md`
- Test: `services/api/tests/auth.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, hash: string): Promise<boolean>`;
  - `seedDemoUsers(): Promise<number>` — создаёт учётные записи, только если таблица `users` пуста; возвращает число созданных;
  - `POST /api/v1/auth/login` `{ login, password }` → `200 { token, user: { id, login, full_name, role } }` или `401 { error: 'INVALID_CREDENTIALS' }`;
  - полезная нагрузка токена: `{ sub: userId, login, role }`.

- [ ] **Step 1: Зависимость и конфигурация**

Run: `cd services/api && npm install bcryptjs@^3`

В `services/api/src/config.ts` в схему окружения добавить:

```typescript
  // Demo accounts are created on first start so the verification stand, run
  // without the team, has someone to log in as. The defaults are documented
  // in the README; override them for anything beyond a demo.
  DEMO_ADMIN_PASSWORD: z.string().default('admin123'),
  DEMO_INSPECTOR_PASSWORD: z.string().default('inspector123'),
  DEMO_SUPERVISOR_PASSWORD: z.string().default('supervisor123'),
  DEMO_ML_PASSWORD: z.string().default('ml123'),
  JWT_TTL: z.string().default('12h'),
```

и соответствующие поля в объект `config`: `demoPasswords: { admin, inspector, supervisor, ml }`, `jwtTtl`.

Те же четыре переменные добавить в `.env.example` и в блок `environment` сервиса `api` в `docker-compose.yml` в форме `${VAR:-значение}`.

- [ ] **Step 2: Написать падающий тест**

Создать `services/api/tests/auth.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

const LOGIN = `t-${Date.now().toString(36)}`;

beforeAll(async () => {
  await prisma.user.create({
    data: { login: LOGIN, passwordHash: await hashPassword('secret-1'), fullName: 'Тестов Т.Т.', role: 'INSPECTOR' },
  });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { details: { path: ['login'], equals: LOGIN } } });
  await prisma.user.deleteMany({ where: { login: LOGIN } });
});

describe('passwords', () => {
  it('verifies the password it hashed and nothing else', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('issues a token for valid credentials', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { login: LOGIN, password: 'secret-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toEqual(expect.any(String));
    expect(body.user).toMatchObject({ login: LOGIN, full_name: 'Тестов Т.Т.', role: 'INSPECTOR' });
    expect(body.user).not.toHaveProperty('password_hash');
    await app.close();
  });

  it('answers the same for a wrong password and an unknown login', async () => {
    const app = await buildServer();
    const wrongPassword = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { login: LOGIN, password: 'nope' },
    });
    const unknownLogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { login: `${LOGIN}-x`, password: 'nope' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownLogin.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownLogin.json());
    await app.close();
  });

  it('refuses a malformed body', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: '' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `cd services/api && npx vitest run tests/auth.test.ts`
Expected: FAIL — модуль `auth/passwords` не найден.

- [ ] **Step 4: Реализовать**

`services/api/src/auth/passwords.ts`:

```typescript
import bcrypt from 'bcryptjs';

// Cost 10 keeps a login around a tenth of a second: slow enough to make
// guessing expensive, fast enough not to eat into the 200 ms p95 budget of
// section 11 for the rest of the API.
const COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

`services/api/src/auth/seed.ts`:

```typescript
import type { UserRole } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from './passwords.js';

const DEMO_USERS: Array<{ login: string; fullName: string; role: UserRole; password: () => string }> = [
  { login: 'admin', fullName: 'Администратор системы', role: 'ADMIN', password: () => config.demoPasswords.admin },
  { login: 'inspector', fullName: 'Смирнов А.В.', role: 'INSPECTOR', password: () => config.demoPasswords.inspector },
  { login: 'supervisor', fullName: 'Петрова Е.И.', role: 'SUPERVISOR', password: () => config.demoPasswords.supervisor },
  { login: 'ml', fullName: 'ML-инженер', role: 'ML_ENGINEER', password: () => config.demoPasswords.ml },
];

// Only an empty table is seeded. Once anyone exists, accounts are managed by
// people, and recreating a deleted demo account on restart would undo that.
export async function seedDemoUsers(): Promise<number> {
  if ((await prisma.user.count()) > 0) return 0;
  for (const user of DEMO_USERS) {
    await prisma.user.create({
      data: {
        login: user.login,
        fullName: user.fullName,
        role: user.role,
        passwordHash: await hashPassword(user.password()),
      },
    });
  }
  return DEMO_USERS.length;
}
```

`services/api/src/routes/auth.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { verifyPassword } from '../auth/passwords.js';

const loginSchema = z.object({
  login: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const user = await prisma.user.findUnique({ where: { login: parsed.data.login } });
    // Same answer for an unknown login and a wrong password: anything else
    // tells a caller which logins exist.
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const token = app.jwt.sign({ sub: user.id, login: user.login, role: user.role });
    return {
      token,
      user: { id: user.id, login: user.login, full_name: user.fullName, role: user.role },
    };
  });
}
```

В `services/api/src/server.ts`: зарегистрировать `@fastify/jwt` до маршрутов, зарегистрировать `authRoutes`, а в блоке запуска после `ensureBucket()` вызвать `seedDemoUsers()` и залогировать число созданных:

```typescript
import fastifyJwt from '@fastify/jwt';
import { authRoutes } from './routes/auth.js';
import { seedDemoUsers } from './auth/seed.js';

  // inside buildServer, before the route registrations:
  await app.register(fastifyJwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });
  await app.register(authRoutes);

  // in the entry block, after ensureBucket():
  const seeded = await seedDemoUsers();
  app.log.info({ seeded }, 'demo accounts checked');
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`
Expected: всё проходит.

- [ ] **Step 6: README**

В `README.md` добавить раздел «Учётные записи» с таблицей четырёх демонстрационных логинов, ролей и паролей по умолчанию и указанием, что пароли переопределяются переменными `DEMO_*_PASSWORD`, а учётные записи создаются только при пустой таблице пользователей.

- [ ] **Step 7: Commit**

```bash
git add services/api docker-compose.yml .env.example README.md
git commit -m "feat(api): log in by login and password, with demo accounts for the stand"
```

---

### Task 2: Обязательный токен, роли и пользователь в логах

**Files:**
- Create: `services/api/src/auth/context.ts`, `services/api/src/auth/plugin.ts`, `services/api/tests/helpers/auth.ts`
- Modify: `services/api/src/logger.ts`, `services/api/src/server.ts`, `services/api/src/routes/auth.ts`, **все** существующие файлы тестов API, `tests/e2e/test_upload_flow.sh`
- Test: `services/api/tests/access.test.ts`

**Interfaces:**
- Produces:
  - `currentUser(): RequestUser | undefined`, где `RequestUser = { id: string; login: string; role: UserRole }`;
  - `requireRole(...roles: UserRole[])` — `preHandler`, отвечающий `403 FORBIDDEN`;
  - `request.user` типа `RequestUser` на всех защищённых маршрутах;
  - `GET /api/v1/auth/me` → `{ id, login, full_name, role }`;
  - в тестах: `authHeaders(role?: UserRole): Promise<Record<string, string>>`.

**Открытые маршруты** — только `GET /api/v1/health` и `POST /api/v1/auth/login`. Всё остальное без действительного токена отвечает `401 UNAUTHORIZED`.

- [ ] **Step 1: Контекст пользователя**

`services/api/src/auth/context.ts`:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '@prisma/client';

export interface RequestUser {
  id: string;
  login: string;
  role: UserRole;
}

// The logger reads the user from here rather than from a child logger. A
// child binding cannot replace a field the root logger already emits: pino
// writes both, and the line carries "user_id" twice, null first - which is
// the value a log collector keeps.
const storage = new AsyncLocalStorage<{ user?: RequestUser }>();

export function enterRequestContext(): void {
  storage.enterWith({});
}

export function setCurrentUser(user: RequestUser): void {
  const store = storage.getStore();
  if (store) store.user = user;
}

export function currentUser(): RequestUser | undefined {
  return storage.getStore()?.user;
}
```

- [ ] **Step 2: Логгер берёт пользователя из контекста**

В `services/api/src/logger.ts` заменить `mixin` и русский комментарий над ним:

```typescript
  // Section 13 of the specification fixes the log fields a central store
  // parses. user_id is always present, null before login, so a missing field
  // never breaks that parsing.
  mixin: () => ({ user_id: currentUser()?.id ?? null }),
```

с импортом `import { currentUser } from './auth/context.js';`.

- [ ] **Step 3: Плагин проверки токена**

`services/api/src/auth/plugin.ts`:

```typescript
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@prisma/client';
import { enterRequestContext, setCurrentUser, type RequestUser } from './context.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; login: string; role: UserRole };
    user: RequestUser;
  }
}

const PUBLIC = new Set(['GET /api/v1/health', 'POST /api/v1/auth/login']);

export const authPlugin = fp(async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    enterRequestContext();
    const route = `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0]}`;
    if (PUBLIC.has(route)) return;

    try {
      const payload = await request.jwtVerify<{ sub: string; login: string; role: UserRole }>();
      const user: RequestUser = { id: payload.sub, login: payload.login, role: payload.role };
      request.user = user;
      setCurrentUser(user);
    } catch {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });
});

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
  };
}
```

`fastify-plugin` поставляется вместе с Fastify как зависимость его плагинов; если импорт не находится — `npm install fastify-plugin@^4`. Зарегистрировать `authPlugin` в `buildServer` сразу после `@fastify/jwt` и до маршрутов.

Проверить опытным путём, что `enterWith` внутри хука `onRequest` виден в обработчике маршрута и в логгере этого запроса. Если контекст теряется — перенести `enterRequestContext` и `setCurrentUser` туда, где контекст сохраняется, и описать в отчёте, что именно не сработало.

В `routes/auth.ts` добавить `GET /api/v1/auth/me`, читающий пользователя из базы по `request.user.id`.

- [ ] **Step 4: Помощник для тестов и перевод существующих тестов**

`services/api/tests/helpers/auth.ts`:

```typescript
import type { UserRole } from '@prisma/client';
import { buildServer } from '../../src/server.js';
import { prisma } from '../../src/db.js';

const cache = new Map<UserRole, Record<string, string>>();

// One real user per role, signed by the same server code the API uses, so a
// test exercises the actual verification path rather than a bypass.
export async function authHeaders(role: UserRole = 'INSPECTOR'): Promise<Record<string, string>> {
  const cached = cache.get(role);
  if (cached) return cached;

  const login = `test-${role.toLowerCase()}`;
  const user = await prisma.user.upsert({
    where: { login },
    update: {},
    create: { login, fullName: `Test ${role}`, role, passwordHash: 'not-used-by-tests' },
  });
  const app = await buildServer();
  const token = app.jwt.sign({ sub: user.id, login: user.login, role: user.role });
  await app.close();

  const headers = { authorization: `Bearer ${token}` };
  cache.set(role, headers);
  return headers;
}
```

Во **всех** существующих тестах API, кроме проверки живости, добавить `headers: await authHeaders()` к каждому `app.inject` (для multipart — объединить с существующим `content-type`). Ни одного теста при этом не удалять и не ослаблять.

В `tests/e2e/test_upload_flow.sh` в самом начале получить токен входом под `inspector` и передавать `-H "Authorization: Bearer $TOKEN"` во все запросы, кроме проверки живости.

- [ ] **Step 5: Тесты доступа**

`services/api/tests/access.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { buildServer } from '../src/server.js';
import { authHeaders } from './helpers/auth.js';

describe('access', () => {
  it('keeps health and login open', async () => {
    const app = await buildServer();
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })).statusCode).toBe(400);
    await app.close();
  });

  it.each([
    ['GET', '/api/v1/objects'],
    ['GET', '/api/v1/params'],
    ['POST', '/api/v1/objects'],
    ['GET', '/api/v1/auth/me'],
  ])('refuses %s %s without a token', async (method, url) => {
    const app = await buildServer();
    const res = await app.inject({ method: method as 'GET' | 'POST', url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' });
    await app.close();
  });

  it('refuses a forged token', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/objects',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('tells the caller who they are', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: await authHeaders('SUPERVISOR') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ login: 'test-supervisor', role: 'SUPERVISOR' });
    await app.close();
  });
});

describe('log lines', () => {
  it('carry the logged-in user exactly once', async () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
    const app = await buildServer({ logStream: sink });
    const headers = await authHeaders();

    await app.inject({ method: 'GET', url: '/api/v1/objects', headers });
    await app.close();

    const requestLines = lines.filter((line) => line.includes('"request_id"') && line.includes('/api/v1/objects'));
    expect(requestLines.length).toBeGreaterThan(0);
    for (const line of requestLines) {
      // Counted in the raw text: JSON.parse would silently keep the last of
      // two duplicate keys and hide exactly the defect this test is about.
      expect(line.match(/"user_id"/g)).toHaveLength(1);
      expect(JSON.parse(line).user_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
```

Для последнего теста `buildServer` принимает необязательный параметр `{ logStream?: Writable }`, передаваемый в логгер Fastify как `stream`. Добавить этот параметр в `buildServer` и в `loggerOptions` не меняя поведения по умолчанию.

- [ ] **Step 6: Доказать, что тест на `user_id` не фиктивный**

Временно заменить `mixin` в логгере на прежний `() => ({ user_id: null })` и добавить в хук привязку дочернего логгера `request.log = request.log.child({ user_id: user.id })`. Показать, что `carry the logged-in user exactly once` падает. Вернуть код.

- [ ] **Step 7: Прогнать всё и commit**

```bash
cd services/api && npx tsc -p tsconfig.json --noEmit && npm test
docker compose up -d --build api
bash tests/e2e/test_upload_flow.sh
```

Expected: всё проходит, сквозной сценарий печатает `PASS`.

```bash
git add services/api tests/e2e
git commit -m "feat(api): require a token everywhere but health and login, and log the real user"
```

---

### Task 3: Журнал аудита

**Files:**
- Create: `services/api/src/audit.ts`
- Modify: `services/api/src/routes/auth.ts`, `routes/objects.ts`, `routes/documents.ts`, `routes/processes.ts`
- Test: `services/api/tests/audit.test.ts`

**Interfaces:**
- Produces: `audit(request: FastifyRequest, action: string, objectId: string | null, details?: Record<string, unknown>): Promise<void>`. Действия этого плана: `LOGIN`, `LOGIN_FAILED`, `OBJECT_CREATED`, `DOCUMENTS_UPLOADED`, `PROCESS_STARTED`.

П. 12.4 ТЗ: «каждое действие пользователя фиксируется с указанием времени, IP-адреса, типа действия и идентификатора объекта». Таблица `audit_log` уже существует с полями `user_id, action, object_id, details, ip_address, user_agent, timestamp`.

- [ ] **Step 1: Написать падающий тест**

`services/api/tests/audit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';

describe('audit log', () => {
  it('records who created an object, from where and with what client', async () => {
    const app = await buildServer();
    const headers = { ...(await authHeaders()), 'user-agent': 'audit-test/1.0' };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/objects', headers,
      payload: { name: 'Объект для аудита' },
      remoteAddress: '10.20.30.40',
    });
    const objectId = res.json().id;

    const entry = await prisma.auditLog.findFirst({ where: { action: 'OBJECT_CREATED', objectId } });
    expect(entry).toMatchObject({ ipAddress: '10.20.30.40', userAgent: 'audit-test/1.0' });
    expect(entry?.userId).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('records a failed login without a user but with the attempted login', async () => {
    const app = await buildServer();
    const login = `nobody-${Date.now()}`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: 'x' } });

    const entry = await prisma.auditLog.findFirst({ where: { action: 'LOGIN_FAILED', details: { path: ['login'], equals: login } } });
    expect(entry).not.toBeNull();
    expect(entry?.userId).toBeNull();
    await app.close();
  });

  it('never stores a password', async () => {
    const app = await buildServer();
    const login = `nobody-${Date.now()}-p`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: 'super-secret-value' } });

    const entries = await prisma.auditLog.findMany({ where: { details: { path: ['login'], equals: login } } });
    expect(JSON.stringify(entries)).not.toContain('super-secret-value');
    await app.close();
  });
});
```

- [ ] **Step 2: Реализовать**

`services/api/src/audit.ts`:

```typescript
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';

// Section 12.4: every user action with its time, IP address, type and object.
// A failure to write the audit entry is logged, not raised: the action itself
// has already happened, and failing the request would misreport its outcome.
export async function audit(
  request: FastifyRequest,
  action: string,
  objectId: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: request.user?.id ?? null,
        action,
        objectId,
        details: (details ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });
  } catch (err) {
    request.log.error({ err, action }, 'audit entry could not be written');
  }
}
```

Вызовы: вход — `LOGIN` (успех, `objectId = null`, details `{ login }`) и `LOGIN_FAILED` (details `{ login }`, **без пароля**); создание объекта — `OBJECT_CREATED`; загрузка — `DOCUMENTS_UPLOADED` с details `{ process_id, accepted, rejected }` (числа); старт процесса — `PROCESS_STARTED` с details `{ process_id }`.

- [ ] **Step 3: Прогнать и commit**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`

```bash
git add services/api
git commit -m "feat(api): record every user action in the audit log with ip and client"
```

---

### Task 4: Отказ в приёме называет допустимые форматы и размеры

**Files:**
- Modify: `services/api/src/routes/documents.ts`
- Test: `services/api/tests/upload.test.ts`

**Interfaces:**
- Produces:
  - каждый элемент `rejected` получает поле `message` — фраза по-русски для пользователя; для `FILE_TOO_LARGE` — ещё `max_bytes`; для `UNSUPPORTED_FORMAT` — ещё `supported_formats` и `registry_formats`;
  - ответ `413 PACKAGE_TOO_LARGE` получает `max_bytes` и `message`;
  - `GET /api/v1/upload/limits` → `{ max_file_bytes, max_package_bytes, supported_formats: ['PDF','DOCX','XML'], registry_formats: ['CSV','XLSX','JSON'] }`.

Таблица «Обработка ошибок при загрузке» п. 9.1 ТЗ: неподдерживаемый формат — «отклонение файла с указанием поддерживаемых форматов»; превышен размер файла — «указание максимального допустимого размера»; превышен общий лимит — «указание превышенного лимита»; повреждённый файл — «уведомление пользователя о необходимости повторной загрузки». Интерфейс сейчас хранит эти тексты у себя с устаревшим лимитом «50 МБ»; сервер — единственное место, где лимит известен точно.

- [ ] **Step 1: Тесты**

В `services/api/tests/upload.test.ts` дополнить существующие тесты отказов проверками новых полей:

```typescript
    // in "rejects an unsupported format":
    expect(res.json().rejected[0]).toMatchObject({
      reason: 'UNSUPPORTED_FORMAT',
      supported_formats: ['PDF', 'DOCX', 'XML'],
      registry_formats: ['CSV', 'XLSX', 'JSON'],
      message: expect.stringContaining('PDF, DOCX, XML'),
    });

    // in "rejects a file above the per-file limit":
    expect(res.json().rejected[0]).toMatchObject({
      reason: 'FILE_TOO_LARGE',
      max_bytes: config.maxFileBytes,
      message: expect.stringContaining('60 МБ'),
    });

    // in "rejects a corrupted pdf":
    expect(res.json().rejected[0].message).toMatch(/загрузите файл повторно/i);
```

и новый тест:

```typescript
  it('publishes the limits the interface shows', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/upload/limits', headers: await authHeaders() });
    expect(res.json()).toEqual({
      max_file_bytes: config.maxFileBytes,
      max_package_bytes: config.maxPackageBytes,
      supported_formats: ['PDF', 'DOCX', 'XML'],
      registry_formats: ['CSV', 'XLSX', 'JSON'],
    });
    await app.close();
  });
```

Если в файле тестов нет импорта `config` — добавить `import { config } from '../src/config.js';`.

- [ ] **Step 2: Реализовать**

В `services/api/src/routes/documents.ts`:

```typescript
const SUPPORTED_FORMATS = ['PDF', 'DOCX', 'XML'];
const REGISTRY_FORMATS = ['CSV', 'XLSX', 'JSON'];

// Megabytes as the interface shows them; the limits themselves stay in bytes.
function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

function rejection(fileName: string, reason: string) {
  switch (reason) {
    case 'UNSUPPORTED_FORMAT':
      return {
        file_name: fileName, reason,
        supported_formats: SUPPORTED_FORMATS, registry_formats: REGISTRY_FORMATS,
        message: `Неподдерживаемый формат. Документы: ${SUPPORTED_FORMATS.join(', ')}; реестр: ${REGISTRY_FORMATS.join(', ')}`,
      };
    case 'FILE_TOO_LARGE':
      return {
        file_name: fileName, reason, max_bytes: config.maxFileBytes,
        message: `Файл больше допустимого размера ${megabytes(config.maxFileBytes)}`,
      };
    case 'CORRUPTED_FILE':
      return { file_name: fileName, reason, message: 'Файл повреждён или не читается. Загрузите файл повторно' };
    case 'DUPLICATE':
      return { file_name: fileName, reason, message: 'Такой файл уже загружен по этому объекту' };
    case 'MULTIPLE_MANIFESTS':
      return { file_name: fileName, reason, message: 'В пакете может быть только один реестр' };
    default:
      return { file_name: fileName, reason, message: 'Файл не сохранён из-за внутренней ошибки. Повторите загрузку' };
  }
}
```

Все места, где сейчас пишется `rejected.push({ file_name: ..., reason: ... })`, заменить на `rejected.push(rejection(..., ...))`. Ответ `413` дополнить `max_bytes: config.maxPackageBytes` и `message: \`Пакет больше допустимого объёма ${megabytes(config.maxPackageBytes)}\``. Добавить маршрут `GET /api/v1/upload/limits`.

- [ ] **Step 3: Прогнать и commit**

Run: `cd services/api && npx tsc -p tsconfig.json --noEmit && npm test`

```bash
git add services/api
git commit -m "feat(api): name the allowed formats and sizes when a file is refused"
```

---

## Что этот план сознательно не делает

- **TLS.** Раздел 12.3 ТЗ требует шифрование при передаче. На стенде это задача обратного прокси перед всей системой, а не API; добавится вместе с веб-сервером интерфейса.
- **Шифрование данных в покое.** Требует настройки Postgres и MinIO, отдельный шаг развёртывания.
- **Управление пользователями** через интерфейс администратора. Пока — демонстрационные учётные записи.
- **Аудит решений инспектора.** Появится вместе с самими решениями в плане верификации; механизм `audit()` для этого уже готов.
