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

const PARAM_CODE = 'M-900';

async function ensureParam() {
  const existing = await prisma.param.findUnique({ where: { code: PARAM_CODE } });
  if (existing) return existing;
  return prisma.param.create({
    data: {
      code: PARAM_CODE, section: 'ПЗ', parameterName: 'Тестовый параметр', unit: 'м²',
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
}

// Builds a fresh object/process/protocol with the checks a test asks for, so
// every test starts from a known, isolated state instead of sharing mutable
// fixtures that earlier tests may have already decided or finalized.
async function makeScenario(
  checkSpecs: CheckSpec[],
  protocolStatus = 'READY',
  processStatus: ProcessStatus = 'READY',
) {
  const param = await ensureParam();
  const object = await prisma.constructionObject.create({ data: { name: 'Verdict routes test' } });
  const process = await prisma.process.create({ data: { objectId: object.id, status: processStatus } });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: protocolStatus,
    },
  });
  const checks = [];
  for (const spec of checkSpecs) {
    checks.push(
      await prisma.check.create({
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
        },
      }),
    );
  }
  return { object, process, protocol, checks };
}

describe('POST /api/v1/findings/:check_id/verdict', () => {
  it('is forbidden for an ML engineer', async () => {
    const { object, checks } = await makeScenario([{ subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }]);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers: await authHeaders('ML_ENGINEER'),
        payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      expect(res.statusCode).toBe(403);
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: checks[0].id } });
      expect(stored.findingStatus).toBe('CANDIDATE');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('confirms a violation and records who decided it', async () => {
    const { object, checks } = await makeScenario([{ subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }]);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers: await authHeaders('INSPECTOR'),
        payload: { decision: 'CONFIRMED_VIOLATION', comment: 'подтверждено на месте' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ finding_status: 'CONFIRMED_VIOLATION', engine_status: 'CANDIDATE' });

      const inspector = await prisma.user.findUniqueOrThrow({ where: { login: 'test-inspector' } });
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: checks[0].id } });
      expect(stored.verifiedBy).toBe(inspector.id);
      expect(stored.verifiedAt).not.toBeNull();
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('rejects a candidate only with a coded reason and a comment', async () => {
    const { object, checks } = await makeScenario([{ subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }]);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers: await authHeaders('INSPECTOR'),
        payload: { decision: 'NEGATIVE_VERIFIED' },
      });

      expect(res.statusCode).toBe(400);
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: checks[0].id } });
      expect(stored.findingStatus).toBe('CANDIDATE');
      expect(stored.verifiedBy).toBeNull();
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('logs a rejection with the ai_verdict the engine had given', async () => {
    const { object, checks } = await makeScenario([{ subject: 'room 1.109', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }]);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers: await authHeaders('INSPECTOR'),
        payload: { decision: 'NEGATIVE_VERIFIED', reason_code: 'APPROVED_CHANGE', comment: 'согласованное изменение' },
      });

      expect(res.statusCode).toBe(200);
      const rejection = await prisma.rejectionLog.findFirstOrThrow({ where: { checkId: checks[0].id } });
      expect(rejection).toMatchObject({
        rejectionReason: 'APPROVED_CHANGE', aiVerdict: 'CANDIDATE', comment: 'согласованное изменение',
      });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses a verdict on a finding that never was a candidate', async () => {
    const { object, checks } = await makeScenario([
      { subject: 'floor total', findingStatus: 'NEGATIVE_VERIFIED', engineStatus: 'NEGATIVE_VERIFIED' },
      { subject: 'n/a', findingStatus: null, completenessStatus: 'NOT_COMPARABLE' },
    ]);
    try {
      const app = await buildServer();
      const headers = await authHeaders('INSPECTOR');

      const engineNegative = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers, payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      expect(engineNegative.statusCode).toBe(409);
      expect(engineNegative.json().error).toBe('NOT_A_CANDIDATE');

      const completenessOnly = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[1].id}/verdict`,
        headers, payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      expect(completenessOnly.statusCode).toBe(409);
      expect(completenessOnly.json().error).toBe('NOT_A_CANDIDATE');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('sets engine_status only on the first decision', async () => {
    const { object, checks } = await makeScenario([{ subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }]);
    try {
      const app = await buildServer();
      const headers = await authHeaders('INSPECTOR');

      await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers, payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      const second = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers, payload: { decision: 'NEGATIVE_VERIFIED', reason_code: 'OTHER', comment: 'передумал' },
      });

      expect(second.statusCode).toBe(200);
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: checks[0].id } });
      // Still the engine's original CANDIDATE, not CONFIRMED_VIOLATION from
      // the first decision that was since revised.
      expect(stored.engineStatus).toBe('CANDIDATE');
      expect(stored.findingStatus).toBe('NEGATIVE_VERIFIED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('moves the process and protocol through VERIFYING to VERIFICATION_COMPLETED', async () => {
    const { object, process, protocol, checks } = await makeScenario(
      [
        { subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' },
        { subject: 'room 2', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' },
      ],
      'READY', 'READY',
    );
    try {
      const app = await buildServer();
      const headers = await authHeaders('INSPECTOR');

      await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers, payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      const afterFirst = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      const protocolAfterFirst = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(afterFirst.status).toBe('VERIFYING');
      expect(protocolAfterFirst.status).toBe('VERIFYING');

      await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[1].id}/verdict`,
        headers, payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      const afterSecond = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      const protocolAfterSecond = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(afterSecond.status).toBe('COMPLETED');
      expect(protocolAfterSecond.status).toBe('VERIFICATION_COMPLETED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses a verdict once the protocol is finalized', async () => {
    const { object, checks } = await makeScenario(
      [{ subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }],
      'PROTOCOL_FINALIZED', 'FINALIZED',
    );
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers: await authHeaders('INSPECTOR'),
        payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('PROTOCOL_FINALIZED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('writes an audit log entry for the verdict', async () => {
    const { object, checks } = await makeScenario([{ subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }]);
    try {
      const app = await buildServer();
      await app.inject({
        method: 'POST', url: `/api/v1/findings/${checks[0].id}/verdict`,
        headers: await authHeaders('INSPECTOR'),
        payload: { decision: 'CONFIRMED_VIOLATION' },
      });

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'VERDICT', objectId: object.id }, orderBy: { timestamp: 'desc' },
      });
      expect(entry.details).toMatchObject({ check_id: checks[0].id, decision: 'CONFIRMED_VIOLATION', reason_code: null });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('rejects a direct write of CONFIRMED_VIOLATION without an inspector - database constraint', async () => {
    const { object, checks } = await makeScenario([{ subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' }]);
    try {
      // Bypasses the route entirely: this proves confirmed_requires_inspector
      // lives in the migration, not only in the route's own validation.
      await expect(
        prisma.check.update({ where: { id: checks[0].id }, data: { findingStatus: 'CONFIRMED_VIOLATION' } }),
      ).rejects.toThrow(/confirmed_requires_inspector/);
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('POST /api/v1/protocols/:protocol_id/finalize', () => {
  it('is forbidden for an ML engineer', async () => {
    const { object, protocol } = await makeScenario([]);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/finalize`,
        headers: await authHeaders('ML_ENGINEER'),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses to finalize while candidates remain', async () => {
    const { object, protocol, checks } = await makeScenario([
      { subject: 'room 1', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE' },
    ]);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/finalize`,
        headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'CANDIDATES_PENDING', check_ids: [checks[0].id] });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('finalizes with a pending hypothesis and no candidates', async () => {
    // Global Constraint: a hypothesis is not a violation - SUSPICION must
    // never be counted as a pending candidate, so finalization is not
    // blocked by one, unlike an undecided CANDIDATE above.
    const { object, protocol } = await makeScenario([
      { subject: 'function 1.109', findingStatus: 'SUSPICION', completenessStatus: 'COMPLETE' },
    ]);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/finalize`,
        headers: await authHeaders('INSPECTOR'),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('PROTOCOL_FINALIZED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('finalizes once every candidate is decided', async () => {
    const inspector = await prisma.user.findUniqueOrThrow({ where: { login: 'test-inspector' } });
    const { object, process, protocol } = await makeScenario(
      [
        {
          subject: 'room 1', findingStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE',
          verifiedBy: inspector.id, verifiedAt: new Date(),
        },
      ],
      'VERIFICATION_COMPLETED', 'COMPLETED',
    );
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/finalize`,
        headers: await authHeaders('SUPERVISOR'),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('PROTOCOL_FINALIZED');

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.status).toBe('PROTOCOL_FINALIZED');
      expect(storedProtocol.finalizedAt).not.toBeNull();
      const supervisor = await prisma.user.findUniqueOrThrow({ where: { login: 'test-supervisor' } });
      expect(storedProtocol.finalizedBy).toBe(supervisor.id);

      const storedProcess = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      expect(storedProcess.status).toBe('FINALIZED');

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'PROTOCOL_FINALIZED', objectId: object.id }, orderBy: { timestamp: 'desc' },
      });
      expect(entry.details).toMatchObject({ protocol_id: protocol.id });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses to finalize an already finalized protocol', async () => {
    const { object, protocol } = await makeScenario([], 'PROTOCOL_FINALIZED', 'FINALIZED');
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/finalize`,
        headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('ALREADY_FINALIZED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('POST /api/v1/protocols/:protocol_id/unfinalize', () => {
  it('is forbidden for an inspector', async () => {
    const { object, protocol } = await makeScenario([], 'PROTOCOL_FINALIZED', 'FINALIZED');
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/unfinalize`,
        headers: await authHeaders('INSPECTOR'),
        payload: { reason: 'ошибочно закрыт' },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('requires a reason', async () => {
    const { object, protocol } = await makeScenario([], 'PROTOCOL_FINALIZED', 'FINALIZED');
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/unfinalize`,
        headers: await authHeaders('SUPERVISOR'),
        payload: {},
      });
      expect(res.statusCode).toBe(400);

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.status).toBe('PROTOCOL_FINALIZED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('un-finalizes for a supervisor with a reason and logs it', async () => {
    const { object, process, protocol } = await makeScenario([], 'PROTOCOL_FINALIZED', 'FINALIZED');
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/unfinalize`,
        headers: await authHeaders('SUPERVISOR'),
        payload: { reason: 'обнаружена ошибка привязки после закрытия' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('VERIFICATION_COMPLETED');

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.status).toBe('VERIFICATION_COMPLETED');
      expect(storedProtocol.finalizedAt).toBeNull();
      expect(storedProtocol.finalizedBy).toBeNull();

      const storedProcess = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      expect(storedProcess.status).toBe('COMPLETED');

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'PROTOCOL_UNFINALIZED', objectId: object.id }, orderBy: { timestamp: 'desc' },
      });
      expect(entry.details).toMatchObject({
        protocol_id: protocol.id, reason: 'обнаружена ошибка привязки после закрытия',
      });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses to unfinalize a protocol that was never finalized', async () => {
    const { object, protocol } = await makeScenario([], 'VERIFICATION_COMPLETED', 'COMPLETED');
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/unfinalize`,
        headers: await authHeaders('ADMIN'),
        payload: { reason: 'проверка' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('NOT_FINALIZED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});
