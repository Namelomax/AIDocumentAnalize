import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';
import { cleanupScenario } from './helpers/cleanup.js';

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

const PARAM_CODE = 'M-901';

async function ensureParam() {
  const existing = await prisma.param.findUnique({ where: { code: PARAM_CODE } });
  if (existing) return existing;
  return prisma.param.create({
    data: {
      code: PARAM_CODE, section: 'ПЗ', parameterName: 'Тестовый параметр для GOLD', unit: 'м²',
      reviewPriority: 'MEDIUM', dataType: 'number', modality: 'scalar_text', matrixVersion: '1.1',
    },
  });
}

interface CheckSpec {
  subject: string;
  findingStatus: string | null;
  engineStatus?: string | null;
  completenessStatus?: string;
  verifiedBy?: string;
  verifiedAt?: Date;
  verdictReasonCode?: string;
  verdictComment?: string;
  parentCheckId?: string;
  splitAt?: Date;
}

// Same shape as verdicts.test.ts's own makeScenario, duplicated rather than
// imported (that file does not export it) - a protocol whose checks are
// already decided, ready to be finalized by the test itself.
async function makeScenario(checkSpecs: CheckSpec[]) {
  const param = await ensureParam();
  const object = await prisma.constructionObject.create({ data: { name: 'Quality labels test' } });
  const process = await prisma.process.create({ data: { objectId: object.id, status: 'COMPLETED' } });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: 'VERIFICATION_COMPLETED',
    },
  });
  const checks: Record<string, string> = {};
  const created = [];
  for (const spec of checkSpecs) {
    const row = await prisma.check.create({
      data: {
        processId: process.id, objectId: object.id, paramCode: param.code,
        evidenceGroupId: `${process.id}:${spec.subject}`, subject: spec.subject,
        completenessStatus: spec.completenessStatus ?? 'COMPLETE',
        findingStatus: spec.findingStatus,
        engineStatus: spec.engineStatus,
        reviewPriority: 'MEDIUM', matrixVersion: '1.1',
        verifiedBy: spec.verifiedBy,
        verifiedAt: spec.verifiedAt,
        verdictReasonCode: spec.verdictReasonCode,
        verdictComment: spec.verdictComment,
        parentCheckId: spec.parentCheckId,
        splitAt: spec.splitAt,
      },
    });
    checks[spec.subject] = row.id;
    created.push(row);
  }
  return { object, process, protocol, checks, created };
}

async function finalize(protocolId: string) {
  const app = await buildServer();
  const res = await app.inject({
    method: 'POST', url: `/api/v1/protocols/${protocolId}/finalize`,
    headers: await authHeaders('INSPECTOR'),
  });
  await app.close();
  return res;
}

// authHeaders() lazily creates the demo user the first time a given role is
// asked for (tests/helpers/auth.ts) - a lookup by login must go through it
// first, or the very first test in this file finds no such user yet.
async function testUser(role: 'INSPECTOR' | 'SUPERVISOR') {
  await authHeaders(role);
  return prisma.user.findUniqueOrThrow({ where: { login: `test-${role.toLowerCase()}` } });
}

async function unfinalize(protocolId: string) {
  const app = await buildServer();
  const res = await app.inject({
    method: 'POST', url: `/api/v1/protocols/${protocolId}/unfinalize`,
    headers: await authHeaders('SUPERVISOR'),
    payload: { reason: 'проверка отмены' },
  });
  await app.close();
  return res;
}

describe('GOLD labels on finalize (section 9.4/14.1)', () => {
  it('creates a positive label for a confirmed violation', async () => {
    const inspector = await testUser('INSPECTOR');
    const { object, protocol, checks } = await makeScenario([
      {
        subject: 'room 1', findingStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE',
        verifiedBy: inspector.id, verifiedAt: new Date(),
      },
    ]);
    try {
      const res = await finalize(protocol.id);
      expect(res.statusCode).toBe(200);

      const label = await prisma.goldLabel.findFirstOrThrow({ where: { checkId: checks['room 1'] } });
      expect(label).toMatchObject({
        label: 'POSITIVE', finalStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE',
        paramCode: PARAM_CODE, modality: 'scalar_text', protocolId: protocol.id,
      });
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('creates a negative label for an inspector-rejected candidate', async () => {
    const inspector = await testUser('INSPECTOR');
    const { object, protocol, checks } = await makeScenario([
      {
        subject: 'room 2', findingStatus: 'NEGATIVE_VERIFIED', engineStatus: 'CANDIDATE',
        verifiedBy: inspector.id, verifiedAt: new Date(),
        verdictReasonCode: 'OCR_ERROR', verdictComment: 'ошибка распознавания',
      },
    ]);
    try {
      const res = await finalize(protocol.id);
      expect(res.statusCode).toBe(200);

      const label = await prisma.goldLabel.findFirstOrThrow({ where: { checkId: checks['room 2'] } });
      expect(label).toMatchObject({
        label: 'NEGATIVE', finalStatus: 'NEGATIVE_VERIFIED', engineStatus: 'CANDIDATE',
        reasonCode: 'OCR_ERROR', expertId: inspector.id,
      });
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('creates a negative label for the engine\'s own NEGATIVE_VERIFIED, never touched by an inspector', async () => {
    // Section 9's status table: NEGATIVE_VERIFIED is "обязательный
    // отрицательный пример для оценки ложных срабатываний" regardless of
    // whether an inspector ever reviewed it - not only an inspector-decided
    // rejection.
    const { object, protocol, checks } = await makeScenario([
      { subject: 'floor total', findingStatus: 'NEGATIVE_VERIFIED', engineStatus: 'NEGATIVE_VERIFIED' },
    ]);
    try {
      const res = await finalize(protocol.id);
      expect(res.statusCode).toBe(200);

      const label = await prisma.goldLabel.findFirstOrThrow({ where: { checkId: checks['floor total'] } });
      expect(label).toMatchObject({ label: 'NEGATIVE', finalStatus: 'NEGATIVE_VERIFIED', engineStatus: 'NEGATIVE_VERIFIED', expertId: null });
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('never labels a CLARIFICATION_REQUIRED or completeness-only outcome', async () => {
    const inspector = await testUser('INSPECTOR');
    const { object, protocol, checks } = await makeScenario([
      {
        subject: 'disputed', findingStatus: 'CLARIFICATION_REQUIRED', engineStatus: 'CANDIDATE',
        verifiedBy: inspector.id, verifiedAt: new Date(),
      },
      { subject: 'no evidence', findingStatus: null, completenessStatus: 'MISSING_EVIDENCE' },
      { subject: 'n/a', findingStatus: null, completenessStatus: 'NOT_APPLICABLE' },
    ]);
    try {
      const res = await finalize(protocol.id);
      expect(res.statusCode).toBe(200);

      const count = await prisma.goldLabel.count({
        where: { checkId: { in: [checks['disputed'], checks['no evidence'], checks['n/a']] } },
      });
      expect(count).toBe(0);
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('counts composite atoms individually once split, and never the composite itself', async () => {
    const inspector = await testUser('INSPECTOR');
    const param = await ensureParam();
    const object = await prisma.constructionObject.create({ data: { name: 'Quality labels composite test' } });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'COMPLETED' } });
    const protocol = await prisma.protocol.create({
      data: {
        objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
        datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
        status: 'VERIFICATION_COMPLETED',
      },
    });
    try {
      const composite = await prisma.check.create({
        data: {
          processId: process.id, objectId: object.id, paramCode: param.code,
          evidenceGroupId: `${process.id}:composite`, completenessStatus: 'COMPLETE',
          findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
          reviewPriority: 'MEDIUM', matrixVersion: '1.1', splitAt: new Date(),
        },
      });
      const atom1 = await prisma.check.create({
        data: {
          processId: process.id, objectId: object.id, paramCode: param.code,
          evidenceGroupId: `${process.id}:atom1`, completenessStatus: 'COMPLETE',
          findingStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE',
          reviewPriority: 'MEDIUM', matrixVersion: '1.1',
          parentCheckId: composite.id, verifiedBy: inspector.id, verifiedAt: new Date(),
        },
      });
      const atom2 = await prisma.check.create({
        data: {
          processId: process.id, objectId: object.id, paramCode: param.code,
          evidenceGroupId: `${process.id}:atom2`, completenessStatus: 'COMPLETE',
          findingStatus: 'NEGATIVE_VERIFIED', engineStatus: 'CANDIDATE',
          reviewPriority: 'MEDIUM', matrixVersion: '1.1',
          parentCheckId: composite.id, verifiedBy: inspector.id, verifiedAt: new Date(),
          verdictReasonCode: 'OTHER', verdictComment: 'нет расхождения',
        },
      });

      const res = await finalize(protocol.id);
      expect(res.statusCode).toBe(200);

      const compositeLabel = await prisma.goldLabel.findFirst({ where: { checkId: composite.id } });
      expect(compositeLabel).toBeNull();

      const atomLabels = await prisma.goldLabel.findMany({ where: { checkId: { in: [atom1.id, atom2.id] } } });
      expect(atomLabels).toHaveLength(2);
      expect(atomLabels.find((l) => l.checkId === atom1.id)?.label).toBe('POSITIVE');
      expect(atomLabels.find((l) => l.checkId === atom2.id)?.label).toBe('NEGATIVE');
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('removes labels on unfinalize and re-adds them on re-finalize', async () => {
    const inspector = await testUser('INSPECTOR');
    const { object, protocol, checks } = await makeScenario([
      {
        subject: 'room 3', findingStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE',
        verifiedBy: inspector.id, verifiedAt: new Date(),
      },
    ]);
    try {
      await finalize(protocol.id);
      expect(await prisma.goldLabel.count({ where: { checkId: checks['room 3'] } })).toBe(1);

      const unfinalizeRes = await unfinalize(protocol.id);
      expect(unfinalizeRes.statusCode).toBe(200);
      expect(await prisma.goldLabel.count({ where: { checkId: checks['room 3'] } })).toBe(0);

      const refinalizeRes = await finalize(protocol.id);
      expect(refinalizeRes.statusCode).toBe(200);
      expect(await prisma.goldLabel.count({ where: { checkId: checks['room 3'] } })).toBe(1);
    } finally {
      await cleanupScenario(object.id);
    }
  });
});
