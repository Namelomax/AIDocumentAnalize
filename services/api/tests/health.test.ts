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
