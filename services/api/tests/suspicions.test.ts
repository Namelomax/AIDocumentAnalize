import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { ProcessStatus } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';
import { cleanupScenario } from './helpers/cleanup.js';

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

interface HypothesisOptions {
  objectName: string;
  protocolStatus?: string;
  protocolVersion?: number;
  processStatus?: ProcessStatus;
  findingStatus?: string;
  engineStatus?: string | null;
}

// One object/process/protocol with a single free-search hypothesis check —
// SEM-ROOM-FN carries no Param row (section 9.5's own rule, not a matrix
// parameter), same fixture protocols.test.ts already relies on.
async function makeHypothesisScenario(options: HypothesisOptions) {
  const object = await prisma.constructionObject.create({ data: { name: options.objectName } });
  const process = await prisma.process.create({
    data: { objectId: object.id, status: options.processStatus ?? 'VERIFYING' },
  });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: options.protocolVersion ?? 1,
      matrixVersion: '1.1', datasetVersion: 'none', modelVersion: 'rules-2026.09',
      inputManifestHash: hash64(), status: options.protocolStatus ?? 'VERIFYING',
    },
  });
  const check = await prisma.check.create({
    data: {
      processId: process.id, objectId: object.id, paramCode: 'SEM-ROOM-FN',
      evidenceGroupId: `${process.id}:function 1.109`, subject: 'function 1.109',
      expectedValue: 'Техническое помещение', actualValue: 'Склад ГСМ',
      completenessStatus: 'COMPLETE', findingStatus: options.findingStatus ?? 'SUSPICION',
      detectionMethod: 'SEMANTIC', confidence: 0.9, engineStatus: options.engineStatus,
      reviewPriority: 'MEDIUM',
      rationale: 'Назначение помещения 1.109 изменено: в ПД «Техническое помещение», в РД «Склад ГСМ».',
      matrixVersion: '1.1',
    },
  });
  return { object, process, protocol, check };
}

describe('GET /api/v1/suspicions', () => {
  it('requires a token', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/suspicions' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns a hypothesis in the shape of a finding, with its object and protocol', async () => {
    const { object, protocol, check } = await makeHypothesisScenario({ objectName: 'Suspicions routes test A' });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/suspicions?protocol_id=${protocol.id}`, headers: await authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        id: check.id,
        param_code: 'SEM-ROOM-FN',
        finding_status: 'SUSPICION',
        detection_method: 'SEMANTIC',
        confidence: 0.9,
        expected_value: 'Техническое помещение',
        actual_value: 'Склад ГСМ',
        object_id: object.id,
        object_name: 'Suspicions routes test A',
        protocol_id: protocol.id,
      });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('filters by protocol_id and excludes checks that are not hypotheses', async () => {
    const { object, process, protocol, check } = await makeHypothesisScenario({ objectName: 'Suspicions routes test B' });
    const candidate = await prisma.check.create({
      data: {
        processId: process.id, objectId: object.id, paramCode: 'M-900',
        evidenceGroupId: `${process.id}:room 1`, completenessStatus: 'COMPLETE',
        findingStatus: 'CANDIDATE', reviewPriority: 'MEDIUM', matrixVersion: '1.1',
      },
    });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/suspicions?protocol_id=${protocol.id}`, headers: await authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().items.map((item: { id: string }) => item.id);
      expect(ids).toEqual([check.id]);
      expect(ids).not.toContain(candidate.id);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('falls back to the latest protocol of an object when only object_id is given', async () => {
    const object = await prisma.constructionObject.create({ data: { name: 'Suspicions routes test C' } });
    const processV1 = await prisma.process.create({ data: { objectId: object.id, status: 'COMPLETED' } });
    const protocolV1 = await prisma.protocol.create({
      data: {
        objectId: object.id, processId: processV1.id, version: 1, matrixVersion: '1.1',
        datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
        status: 'VERIFICATION_COMPLETED',
      },
    });
    const checkV1 = await prisma.check.create({
      data: {
        processId: processV1.id, objectId: object.id, paramCode: 'SEM-ROOM-FN',
        evidenceGroupId: `${processV1.id}:function 1.109`, completenessStatus: 'COMPLETE',
        findingStatus: 'SUSPICION', detectionMethod: 'SEMANTIC', confidence: 0.7,
        reviewPriority: 'MEDIUM', matrixVersion: '1.1',
      },
    });

    const processV2 = await prisma.process.create({ data: { objectId: object.id, status: 'VERIFYING' } });
    const protocolV2 = await prisma.protocol.create({
      data: {
        objectId: object.id, processId: processV2.id, version: 2, matrixVersion: '1.1',
        datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
        status: 'VERIFYING',
      },
    });
    const checkV2 = await prisma.check.create({
      data: {
        processId: processV2.id, objectId: object.id, paramCode: 'SEM-ROOM-FN',
        evidenceGroupId: `${processV2.id}:function 1.109`, completenessStatus: 'COMPLETE',
        findingStatus: 'SUSPICION', detectionMethod: 'SEMANTIC', confidence: 0.7,
        reviewPriority: 'MEDIUM', matrixVersion: '1.1',
      },
    });

    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/suspicions?object_id=${object.id}`, headers: await authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().items.map((item: { id: string }) => item.id);
      expect(ids).toEqual([checkV2.id]);
      expect(ids).not.toContain(checkV1.id);
      expect(res.json().items[0].protocol_id).toBe(protocolV2.id);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('without filters, returns hypotheses from the latest protocol of every object, newest first', async () => {
    const first = await makeHypothesisScenario({ objectName: 'Suspicions routes test D1' });
    const second = await makeHypothesisScenario({ objectName: 'Suspicions routes test D2' });
    try {
      const app = await buildServer();
      const res = await app.inject({ method: 'GET', url: '/api/v1/suspicions', headers: await authHeaders() });
      expect(res.statusCode).toBe(200);
      const ids: string[] = res.json().items.map((item: { id: string }) => item.id);
      const firstIndex = ids.indexOf(first.check.id);
      const secondIndex = ids.indexOf(second.check.id);
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThanOrEqual(0);
      // second was created after first - newer hypotheses sort earlier.
      expect(secondIndex).toBeLessThan(firstIndex);
      await app.close();
    } finally {
      await cleanupScenario(first.object.id);
      await cleanupScenario(second.object.id);
    }
  });
});

describe('POST /api/v1/findings/:check_id/promote', () => {
  it('is forbidden for an ML engineer', async () => {
    const { object, check } = await makeHypothesisScenario({ objectName: 'Promote routes test A' });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${check.id}/promote`, headers: await authHeaders('ML_ENGINEER'),
      });
      expect(res.statusCode).toBe(403);
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
      expect(stored.findingStatus).toBe('SUSPICION');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('promotes a hypothesis to a candidate, keeping what the engine had called it', async () => {
    const { object, check } = await makeHypothesisScenario({ objectName: 'Promote routes test B' });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${check.id}/promote`, headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: check.id, finding_status: 'CANDIDATE', engine_status: 'SUSPICION' });

      const stored = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
      expect(stored.findingStatus).toBe('CANDIDATE');
      expect(stored.engineStatus).toBe('SUSPICION');
      // Promotion is not itself a verdict — no inspector decision is recorded.
      expect(stored.verifiedBy).toBeNull();
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses to promote a check that is not a hypothesis', async () => {
    const { object, check } = await makeHypothesisScenario({
      objectName: 'Promote routes test C', findingStatus: 'CANDIDATE',
    });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${check.id}/promote`, headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('NOT_A_SUSPICION');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses to promote once the protocol is finalized', async () => {
    const { object, check } = await makeHypothesisScenario({
      objectName: 'Promote routes test D', protocolStatus: 'PROTOCOL_FINALIZED', processStatus: 'FINALIZED',
    });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${check.id}/promote`, headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('PROTOCOL_FINALIZED');
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
      expect(stored.findingStatus).toBe('SUSPICION');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('reopens a completed protocol and process, since a promoted hypothesis is a fresh candidate', async () => {
    const { object, process, protocol, check } = await makeHypothesisScenario({
      objectName: 'Promote routes test E', protocolStatus: 'VERIFICATION_COMPLETED', processStatus: 'COMPLETED',
    });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${check.id}/promote`, headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(200);

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.status).toBe('VERIFYING');
      const storedProcess = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      expect(storedProcess.status).toBe('VERIFYING');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('404s for an unknown check', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/findings/${randomUUID()}/promote`, headers: await authHeaders('INSPECTOR'),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('writes an audit log entry for the promotion', async () => {
    const { object, check } = await makeHypothesisScenario({ objectName: 'Promote routes test F' });
    try {
      const app = await buildServer();
      await app.inject({
        method: 'POST', url: `/api/v1/findings/${check.id}/promote`, headers: await authHeaders('INSPECTOR'),
      });
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'SUSPICION_PROMOTED', objectId: object.id }, orderBy: { timestamp: 'desc' },
      });
      expect(entry.details).toMatchObject({ check_id: check.id });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});
