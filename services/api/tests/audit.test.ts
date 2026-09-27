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

  it('records the client address the proxy forwarded, not the proxy', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/objects', headers: {
        ...(await authHeaders()), 'x-forwarded-for': '203.0.113.7',
      },
      payload: { name: 'Объект через прокси' },
      remoteAddress: '172.18.0.8',
    });

    const entry = await prisma.auditLog.findFirst({ where: { action: 'OBJECT_CREATED', objectId: res.json().id } });
    expect(entry?.ipAddress).toBe('203.0.113.7');
    await app.close();
  });

  it('ignores a forwarded address from a caller outside the private networks', async () => {
    // A client reaching the api port directly must not be able to put any
    // address it likes into the audit log.
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/objects', headers: {
        ...(await authHeaders()), 'x-forwarded-for': '203.0.113.7',
      },
      payload: { name: 'Объект с подменой адреса' },
      remoteAddress: '198.51.100.20',
    });

    const entry = await prisma.auditLog.findFirst({ where: { action: 'OBJECT_CREATED', objectId: res.json().id } });
    expect(entry?.ipAddress).toBe('198.51.100.20');
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
