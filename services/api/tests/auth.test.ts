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
