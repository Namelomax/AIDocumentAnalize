import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';

// One real user per test rather than the shared demo accounts authHeaders()
// hands out (Plan: isolation between users matters here more than in most
// other suites), so notifications created for one never leak into another
// test's assertions.
async function makeUser(role: 'INSPECTOR' | 'ADMIN' = 'INSPECTOR') {
  const user = await prisma.user.create({
    data: {
      login: `notif-test-${randomUUID()}`,
      fullName: `Notification test ${role}`,
      role,
      passwordHash: 'not-used-by-tests',
    },
  });
  const app = await buildServer();
  const token = app.jwt.sign({ sub: user.id, login: user.login, role: user.role });
  await app.close();
  return { user, headers: { authorization: `Bearer ${token}` } };
}

async function makeNotification(userId: string, overrides: Partial<{
  kind: string; title: string; body: string; processId: string | null; objectId: string | null; readAt: Date | null;
}> = {}) {
  return prisma.notification.create({
    data: {
      userId,
      kind: overrides.kind ?? 'PROCESS_READY',
      title: overrides.title ?? 'Протокол готов к проверке',
      body: overrides.body ?? 'Протокол по процессу p1 готов к проверке.',
      processId: overrides.processId ?? null,
      objectId: overrides.objectId ?? null,
      readAt: overrides.readAt ?? null,
    },
  });
}

describe('GET /api/v1/notifications', () => {
  it("returns only the current user's notifications, newest first, with an unread count", async () => {
    const app = await buildServer();
    const { user, headers } = await makeUser();
    const { headers: otherHeaders } = await makeUser();

    const first = await makeNotification(user.id, { title: 'Первое' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await makeNotification(user.id, { title: 'Второе' });
    await makeNotification((await makeUser()).user.id, { title: 'Чужое' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.items.map((i: { id: string }) => i.id)).toEqual([second.id, first.id]);
    expect(body.unread_count).toBe(2);
    expect(body.items[0]).toMatchObject({
      title: 'Второе',
      process_id: null,
      object_id: null,
      read_at: null,
    });

    // A second, unrelated user sees none of the first user's notifications.
    const otherRes = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: otherHeaders });
    expect(otherRes.json().items).toEqual([]);
    expect(otherRes.json().unread_count).toBe(0);

    await app.close();
  });

  it('caps the list at 50 and only counts unread ones', async () => {
    const app = await buildServer();
    const { user, headers } = await makeUser();

    for (let i = 0; i < 51; i += 1) {
      await makeNotification(user.id, { readAt: i < 10 ? new Date() : null });
    }

    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(50);
    expect(body.unread_count).toBe(41);

    await app.close();
  });
});

describe('POST /api/v1/notifications/:id/read', () => {
  it('marks the notification read and returns 404 for someone else\'s notification', async () => {
    const app = await buildServer();
    const { user, headers } = await makeUser();
    const { headers: otherHeaders } = await makeUser();
    const notification = await makeNotification(user.id);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/notifications/${notification.id}/read`, headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().read_at).not.toBeNull();

    const stored = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(stored.readAt).not.toBeNull();

    // Someone else's notification is 404, not 403 - its existence is not
    // revealed to a caller who does not own it.
    const otherNotification = await makeNotification((await makeUser()).user.id);
    const forbidden = await app.inject({
      method: 'POST', url: `/api/v1/notifications/${otherNotification.id}/read`, headers: otherHeaders,
    });
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.json().error).toBe('NOTIFICATION_NOT_FOUND');

    await app.close();
  });

  it('returns 404 for an unknown notification id', async () => {
    const app = await buildServer();
    const { headers } = await makeUser();

    const res = await app.inject({
      method: 'POST', url: `/api/v1/notifications/${randomUUID()}/read`, headers,
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('POST /api/v1/notifications/read-all', () => {
  it("marks every one of the current user's unread notifications read, and no one else's", async () => {
    const app = await buildServer();
    const { user, headers } = await makeUser();
    const { user: other, headers: otherHeaders } = await makeUser();

    await makeNotification(user.id);
    await makeNotification(user.id);
    const otherNotification = await makeNotification(other.id);

    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);

    const summary = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers });
    expect(summary.json().unread_count).toBe(0);

    // The other user's notification is untouched.
    const otherSummary = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: otherHeaders });
    expect(otherSummary.json().unread_count).toBe(1);
    const stored = await prisma.notification.findUniqueOrThrow({ where: { id: otherNotification.id } });
    expect(stored.readAt).toBeNull();

    await app.close();
  });
});
