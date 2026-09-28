import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';
import { cleanupScenario } from './helpers/cleanup.js';

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

const PARAM_CODE = 'M-902';

async function ensureParam() {
  const existing = await prisma.param.findUnique({ where: { code: PARAM_CODE } });
  if (existing) return existing;
  return prisma.param.create({
    data: {
      code: PARAM_CODE, section: 'ПЗ', parameterName: 'Сводка дашборда', unit: 'м²',
      reviewPriority: 'MEDIUM', dataType: 'number', modality: 'scalar_text', matrixVersion: '1.1',
    },
  });
}

// The database is shared with everything else on the stand, so the absolute
// numbers in it are unknown; every test below reads the summary before and
// after creating its own data and checks the difference instead.
async function getSummary(app: FastifyInstance) {
  const res = await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary', headers: await authHeaders() });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('GET /api/v1/dashboard/summary', () => {
  it('counts an object with no finalized process as in work', async () => {
    const app = await buildServer();
    const before = await getSummary(app);

    const object = await prisma.constructionObject.create({
      data: { name: `Dashboard in-work test ${randomUUID()}` },
    });
    await prisma.process.create({ data: { objectId: object.id, status: 'READY' } });

    try {
      const after = await getSummary(app);
      expect(after.objects_in_work).toBe(before.objects_in_work + 1);
    } finally {
      await cleanupScenario(object.id);
      await app.close();
    }
  });

  it('does not count an object whose latest process is finalized as in work', async () => {
    const app = await buildServer();
    const before = await getSummary(app);

    const object = await prisma.constructionObject.create({
      data: { name: `Dashboard finalized test ${randomUUID()}` },
    });
    await prisma.process.create({ data: { objectId: object.id, status: 'FINALIZED' } });

    try {
      const after = await getSummary(app);
      expect(after.objects_in_work).toBe(before.objects_in_work);
    } finally {
      await cleanupScenario(object.id);
      await app.close();
    }
  });

  it('counts protocols in READY and VERIFYING as awaiting verification', async () => {
    const app = await buildServer();
    const before = await getSummary(app);

    const object = await prisma.constructionObject.create({
      data: { name: `Dashboard awaiting test ${randomUUID()}` },
    });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'READY' } });
    await prisma.protocol.create({
      data: {
        objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
        datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(), status: 'READY',
      },
    });

    try {
      const after = await getSummary(app);
      expect(after.awaiting_verification).toBe(before.awaiting_verification + 1);
    } finally {
      await cleanupScenario(object.id);
      await app.close();
    }
  });

  it('counts undecided candidates only while their process is not finalized', async () => {
    const app = await buildServer();
    const param = await ensureParam();
    const before = await getSummary(app);

    const object = await prisma.constructionObject.create({
      data: { name: `Dashboard candidates test ${randomUUID()}` },
    });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'VERIFYING' } });
    await prisma.check.create({
      data: {
        processId: process.id, objectId: object.id, paramCode: param.code,
        evidenceGroupId: `${process.id}:candidate`, completenessStatus: 'COMPLETE',
        findingStatus: 'CANDIDATE', reviewPriority: 'MEDIUM', matrixVersion: '1.1',
      },
    });

    try {
      const afterOpen = await getSummary(app);
      expect(afterOpen.candidates_to_review).toBe(before.candidates_to_review + 1);

      await prisma.process.update({ where: { id: process.id }, data: { status: 'FINALIZED' } });
      const afterFinalized = await getSummary(app);
      expect(afterFinalized.candidates_to_review).toBe(before.candidates_to_review);
    } finally {
      await cleanupScenario(object.id);
      await app.close();
    }
  });

  it('counts a protocol finalized since the start of the current month', async () => {
    const app = await buildServer();
    const before = await getSummary(app);

    const object = await prisma.constructionObject.create({
      data: { name: `Dashboard finalized-month test ${randomUUID()}` },
    });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'FINALIZED' } });
    await prisma.protocol.create({
      data: {
        objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
        datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
        status: 'PROTOCOL_FINALIZED', finalizedAt: new Date(),
      },
    });

    try {
      const after = await getSummary(app);
      expect(after.finalized_this_month).toBe(before.finalized_this_month + 1);
    } finally {
      await cleanupScenario(object.id);
      await app.close();
    }
  });
});
