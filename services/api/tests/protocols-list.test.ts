import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';

// GET /api/v1/protocols - the "Протоколы" sidebar screen's own list, across
// every object at once (task spec). Kept in its own file rather than folded
// into protocols.test.ts: every scenario here needs its own object(s), while
// protocols.test.ts already owns one shared protocol for the single-protocol
// routes.

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

const PARAM_CODE = 'M-901';

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

async function inspectorId(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { login: 'test-inspector' } });
  if (existing) return existing.id;
  await authHeaders('INSPECTOR');
  return (await prisma.user.findUniqueOrThrow({ where: { login: 'test-inspector' } })).id;
}

async function cleanupScenario(objectId: string) {
  await prisma.process.deleteMany({ where: { objectId } });
  await prisma.constructionObject.delete({ where: { id: objectId } });
}

// One object/process/protocol carrying one check of each finding_status the
// list's counters read (CANDIDATE, CONFIRMED_VIOLATION, NEGATIVE_VERIFIED,
// SUSPICION), plus a completeness-only row that must not affect any of them.
async function makeCountedProtocol(
  objectName: string,
  opts: { status?: string; finalized?: boolean } = {},
) {
  const param = await ensureParam();
  const object = await prisma.constructionObject.create({ data: { name: objectName } });
  const process = await prisma.process.create({ data: { objectId: object.id, status: 'VERIFYING' } });
  const inspector = await inspectorId();
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: opts.status ?? 'VERIFYING',
      ...(opts.finalized
        ? { finalizedAt: new Date(), finalizedBy: inspector, status: 'PROTOCOL_FINALIZED' }
        : {}),
    },
  });

  const rows: Array<{ status: string | null; completeness: string; verifiedBy?: string; reason?: string }> = [
    { status: 'CANDIDATE', completeness: 'COMPLETE' },
    { status: 'CANDIDATE', completeness: 'COMPLETE' },
    { status: 'CONFIRMED_VIOLATION', completeness: 'COMPLETE', verifiedBy: inspector },
    // The engine's own verified negative - not a rejection, must not count.
    { status: 'NEGATIVE_VERIFIED', completeness: 'COMPLETE' },
    // A candidate the inspector rejected - the one "rejected" counts.
    { status: 'NEGATIVE_VERIFIED', completeness: 'COMPLETE', verifiedBy: inspector, reason: 'OTHER' },
    { status: 'SUSPICION', completeness: 'COMPLETE' },
    { status: null, completeness: 'NOT_COMPARABLE' },
  ];
  for (const [i, row] of rows.entries()) {
    await prisma.check.create({
      data: {
        processId: process.id, objectId: object.id, paramCode: param.code,
        evidenceGroupId: `${process.id}:row-${i}`, completenessStatus: row.completeness,
        findingStatus: row.status, engineStatus: row.status, reviewPriority: 'MEDIUM',
        matrixVersion: '1.1', verifiedBy: row.verifiedBy, verdictReasonCode: row.reason, verdictComment: row.reason ? 'Отклонено инспектором' : undefined,
      },
    });
  }

  return { object, process, protocol };
}

describe('GET /api/v1/protocols', () => {
  it('requires a token', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/protocols' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lists a protocol with counts that respect the composite visibility rule', async () => {
    const { object, process, protocol } = await makeCountedProtocol(`List counts test ${randomUUID()}`);
    try {
      // An unsplit composite (parent, two atoms) must count as ONE candidate
      // awaiting a decision, same rule as dashboard.ts / objects.ts.
      const composite = await prisma.check.create({
        data: {
          processId: process.id, objectId: object.id, paramCode: PARAM_CODE,
          evidenceGroupId: `${process.id}:rooms 1..2`, subject: 'rooms 1..2',
          completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
          reviewPriority: 'MEDIUM', matrixVersion: '1.1',
        },
      });
      await prisma.check.create({
        data: {
          processId: process.id, objectId: object.id, paramCode: PARAM_CODE,
          evidenceGroupId: `${process.id}:room 1`, subject: 'room 1',
          completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
          reviewPriority: 'MEDIUM', matrixVersion: '1.1', parentCheckId: composite.id,
        },
      });
      await prisma.check.create({
        data: {
          processId: process.id, objectId: object.id, paramCode: PARAM_CODE,
          evidenceGroupId: `${process.id}:room 2`, subject: 'room 2',
          completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
          reviewPriority: 'MEDIUM', matrixVersion: '1.1', parentCheckId: composite.id,
        },
      });

      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/protocols?object_id=${object.id}`, headers: await authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.items).toHaveLength(1);
      const item = body.items[0];
      expect(item).toMatchObject({
        id: protocol.id, object_id: object.id, object_name: object.name, version: 1, status: 'VERIFYING',
      });
      // 2 plain CANDIDATE rows + the unsplit composite counted once = 3; its
      // two hidden atoms never count at all (checks/visibility.ts).
      expect(item.awaiting_decision).toBe(3);
      expect(item.confirmed).toBe(1);
      expect(item.rejected).toBe(1);
      expect(item.suspicions).toBe(1);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('reports the finalizer\'s full name', async () => {
    const { object, protocol } = await makeCountedProtocol(`Finalized list test ${randomUUID()}`, { finalized: true });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/protocols?object_id=${object.id}`, headers: await authHeaders(),
      });
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe(protocol.id);
      expect(body.items[0].status).toBe('PROTOCOL_FINALIZED');
      expect(body.items[0].finalized_by).toBe('Test INSPECTOR');
      expect(body.items[0].finalized_at).not.toBeNull();
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('filters by status', async () => {
    const a = await makeCountedProtocol(`Status filter A ${randomUUID()}`, { status: 'READY' });
    const b = await makeCountedProtocol(`Status filter B ${randomUUID()}`, { status: 'VERIFYING' });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: '/api/v1/protocols?status=READY', headers: await authHeaders(),
      });
      const body = res.json();
      const ids = body.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(a.protocol.id);
      expect(ids).not.toContain(b.protocol.id);
      await app.close();
    } finally {
      await cleanupScenario(a.object.id);
      await cleanupScenario(b.object.id);
    }
  });

  it('rejects an unknown status', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/protocols?status=BOGUS', headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('filters by a substring of the object name, case-insensitively', async () => {
    const unique = randomUUID();
    const a = await makeCountedProtocol(`Квартал Свердловский-${unique}`);
    const b = await makeCountedProtocol(`Иной объект ${unique}`);
    try {
      const app = await buildServer();
      const res = await app.inject({
        // A substring straddling the fixed and the unique part, cased
        // differently from how it was stored - both the substring match and
        // the case-insensitivity have to hold for this to find `a`.
        method: 'GET', url: `/api/v1/protocols?q=${encodeURIComponent(`сверДЛОВСКИЙ-${unique}`)}`,
        headers: await authHeaders(),
      });
      const body = res.json();
      const ids = body.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(a.protocol.id);
      expect(ids).not.toContain(b.protocol.id);
      await app.close();
    } finally {
      await cleanupScenario(a.object.id);
      await cleanupScenario(b.object.id);
    }
  });

  it('paginates with limit/offset and reports the true total', async () => {
    const unique = randomUUID();
    const first = await makeCountedProtocol(`Page test 1 ${unique}`);
    const second = await makeCountedProtocol(`Page test 2 ${unique}`);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/protocols?q=${encodeURIComponent(unique)}&limit=1&offset=0`,
        headers: await authHeaders(),
      });
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(1);
      // Newest first: `second` was created after `first`.
      expect(body.items[0].id).toBe(second.protocol.id);

      const res2 = await app.inject({
        method: 'GET', url: `/api/v1/protocols?q=${encodeURIComponent(unique)}&limit=1&offset=1`,
        headers: await authHeaders(),
      });
      const body2 = res2.json();
      expect(body2.items).toHaveLength(1);
      expect(body2.items[0].id).toBe(first.protocol.id);
      await app.close();
    } finally {
      await cleanupScenario(first.object.id);
      await cleanupScenario(second.object.id);
    }
  });

  it('rejects a limit over 100', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/protocols?limit=101', headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
