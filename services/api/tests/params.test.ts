import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';

const PREFIX = `T${Date.now().toString(36)}`;

beforeAll(async () => {
  await prisma.param.createMany({
    data: [
      {
        code: `${PREFIX}-A`, section: 'ТЕСТ-А', parameterName: 'Ширина проёма', unit: 'м',
        reviewPriority: 'HIGH', dataType: 'number', modality: 'scalar_text',
        minValue: 0.9, compareOp: 'value_lt', compareThreshold: 0.9, matrixVersion: '1.1',
      },
      {
        code: `${PREFIX}-B`, section: 'ТЕСТ-Б', parameterName: 'Класс бетона', unit: 'Марка (B)',
        reviewPriority: 'MEDIUM', dataType: 'enum', modality: 'scalar_text',
        isActive: false, matrixVersion: '1.1',
      },
    ],
  });
});

afterAll(async () => {
  await prisma.param.deleteMany({ where: { code: { startsWith: PREFIX } } });
});

describe('GET /api/v1/params', () => {
  it('returns parameters under the field names of section 8.1', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/params?section=ТЕСТ-А' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      code: `${PREFIX}-A`,
      parameter_name: 'Ширина проёма',
      review_priority: 'HIGH',
      data_type: 'number',
      min_value: 0.9,
      is_active: true,
      implemented: false,
      matrix_version: '1.1',
    });
    await app.close();
  });

  it('filters by priority and by activity', async () => {
    const app = await buildServer();

    const inactive = await app.inject({ method: 'GET', url: '/api/v1/params?section=ТЕСТ-Б&active=false' });
    expect(inactive.json().items.map((p: { code: string }) => p.code)).toEqual([`${PREFIX}-B`]);

    const medium = await app.inject({ method: 'GET', url: '/api/v1/params?section=ТЕСТ-Б&priority=MEDIUM' });
    expect(medium.json().total).toBe(1);
    await app.close();
  });

  it('refuses an unknown priority', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/params?priority=URGENT' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
