// Customer's ТЗ "Инкрементальное обновление при дозагрузке": "Предыдущая
// версия протокола сохраняется в истории". These tests drive the SUPERSEDED
// path entirely through Prisma, standing in for what services/worker's
// app.pipeline.process_update actually does on a дозагрузка - the worker's
// own merge logic is covered by its own test suite (tests/test_pipeline.py),
// this only proves the API serves what a snapshot like that produces
// correctly and keeps it read-only.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

let objectId: string;
let processId: string;
let supersededProtocolId: string;
let currentProtocolId: string;
let archivedCheckId: string;

beforeAll(async () => {
  const object = await prisma.constructionObject.create({ data: { name: 'Supersede test' } });
  objectId = object.id;
  const process = await prisma.process.create({ data: { objectId, status: 'VERIFYING' } });
  processId = process.id;

  const param = await prisma.param.findUnique({ where: { code: 'M-003' } });
  const paramCode = param?.code ?? 'M-003';

  // The check this snapshot remembers no longer exists in `checks` at all -
  // exactly what a дозагрузка's merge does to a group the engine stops
  // reporting (services/worker's app.db.Database.merge_checks: replaced or
  // removed rows are gone from the live table, the snapshot is all that is
  // left of them).
  archivedCheckId = randomUUID();
  const archivedCheck = {
    id: archivedCheckId, processId, objectId, paramId: param?.id ?? null, paramCode,
    evidenceGroupId: `${processId}:archived`, subject: 'room 1.1', expectedValue: '10.00',
    actualValue: '12.50', delta: '2.50', completenessStatus: 'COMPLETE', findingStatus: 'CONFIRMED_VIOLATION',
    reviewPriority: 'MEDIUM', rationale: 'Площадь увеличена', matrixVersion: '1.1',
    createdAt: new Date().toISOString(), engineStatus: 'CANDIDATE', verifiedBy: null, verifiedAt: null,
    verdictReasonCode: null, verdictComment: null, authoritativeFileId: null, detectionMethod: null,
    confidence: null, parentCheckId: null, splitBy: null, splitAt: null,
    fragments: [],
  };

  const superseded = await prisma.protocol.create({
    data: {
      objectId, processId, version: 1, matrixVersion: '1.1', datasetVersion: 'none',
      modelVersion: 'rules-2026.09', inputManifestHash: hash64(), status: 'SUPERSEDED',
      snapshot: { checks: [archivedCheck] },
    },
  });
  supersededProtocolId = superseded.id;

  const current = await prisma.protocol.create({
    data: {
      objectId, processId, version: 2, matrixVersion: '1.1', datasetVersion: 'none',
      modelVersion: 'rules-2026.09', inputManifestHash: hash64(), status: 'READY',
    },
  });
  currentProtocolId = current.id;
});

afterAll(async () => {
  await prisma.protocol.deleteMany({ where: { processId } });
  await prisma.check.deleteMany({ where: { processId } });
  await prisma.process.delete({ where: { id: processId } });
  await prisma.constructionObject.delete({ where: { id: objectId } });
});

describe('a superseded protocol serves its snapshot', () => {
  it('GET /protocols/:id returns the archived finding, not the live (empty) checks table', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${supersededProtocolId}`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('SUPERSEDED');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      id: archivedCheckId, finding_status: 'CONFIRMED_VIOLATION', expected_value: '10.00', actual_value: '12.50',
    });
    await app.close();
  });

  it('GET /protocols/:id/findings reads findings from the snapshot too', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${supersededProtocolId}/findings`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([archivedCheckId]);
    await app.close();
  });

  it('GET /processes/:id/protocol skips the superseded version and returns the current one', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/processes/${processId}/protocol`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(currentProtocolId);
    expect(res.json().version).toBe(2);
    await app.close();
  });

  it('finalize on a superseded protocol is refused', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/protocols/${supersededProtocolId}/finalize`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'PROTOCOL_SUPERSEDED' });
    await app.close();
  });

  it('unfinalize on a superseded protocol is refused', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/protocols/${supersededProtocolId}/unfinalize`,
      headers: await authHeaders('SUPERVISOR'),
      payload: { reason: 'test' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'PROTOCOL_SUPERSEDED' });
    await app.close();
  });

  it('the protocols list can filter by SUPERSEDED and carries the version/status through', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols?object_id=${objectId}&status=SUPERSEDED`,
      headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([supersededProtocolId]);
    expect(body.items[0].status).toBe('SUPERSEDED');
    await app.close();
  });
});
