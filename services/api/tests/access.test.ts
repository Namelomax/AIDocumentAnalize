import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
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
  it("never carry the previous request's user into an anonymous one", async () => {
    // AsyncLocalStorage keeps its store until something replaces it. If a
    // request did not start from a fresh context, an anonymous request logged
    // right after an authenticated one would be attributed to that user - a
    // wrong name in the log inspectors' actions are reconstructed from.
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
    const app = await buildServer({ logStream: sink });

    await app.inject({ method: 'GET', url: '/api/v1/objects', headers: await authHeaders() });
    await app.inject({ method: 'GET', url: '/api/v1/params?probe=anonymous' });
    await app.close();

    const anonymous = lines.filter((line) => line.includes('probe=anonymous'));
    expect(anonymous.length).toBeGreaterThan(0);
    for (const line of anonymous) {
      expect(JSON.parse(line).user_id).toBeNull();
    }
  });


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
