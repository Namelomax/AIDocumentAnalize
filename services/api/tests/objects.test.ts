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
