import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';
import { indicatorFor } from '../src/objects/indicator.js';

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

const PARAM_CODE = 'M-901';

async function ensureParam() {
  const existing = await prisma.param.findUnique({ where: { code: PARAM_CODE } });
  if (existing) return existing;
  return prisma.param.create({
    data: {
      code: PARAM_CODE, section: 'ПЗ', parameterName: 'Индикатор объекта', unit: 'м²',
      reviewPriority: 'MEDIUM', dataType: 'number', modality: 'scalar_text', matrixVersion: '1.1',
    },
  });
}

// The database enforces confirmed_requires_inspector (migration
// 20260927155119): a CONFIRMED_VIOLATION check must carry the inspector who
// confirmed it. authHeaders() creates and caches this user as a side effect
// of signing its token, so it is reused here rather than seeded twice.
async function inspectorId(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { login: 'test-inspector' } });
  if (existing) return existing.id;
  await authHeaders('INSPECTOR');
  return (await prisma.user.findUniqueOrThrow({ where: { login: 'test-inspector' } })).id;
}

// Builds an object with one process and one protocol, optionally carrying a
// single check with the given finding_status, so a test can ask what colour
// the dashboard shows for it. Deleting the process cascades its protocol and
// checks (schema.prisma onDelete: Cascade).
async function makeIndicatorScenario(
  findingStatus: string | null,
  protocolStatus: string,
  processStatus: 'PENDING' | 'PARSING' | 'READY' | 'VERIFYING' | 'COMPLETED' | 'FINALIZED' = 'READY',
) {
  const param = await ensureParam();
  const object = await prisma.constructionObject.create({ data: { name: `Indicator test ${randomUUID()}` } });
  const process = await prisma.process.create({ data: { objectId: object.id, status: processStatus } });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: protocolStatus,
    },
  });
  if (findingStatus) {
    const verifiedBy = findingStatus === 'CONFIRMED_VIOLATION' ? await inspectorId() : undefined;
    await prisma.check.create({
      data: {
        processId: process.id, objectId: object.id, paramCode: param.code,
        evidenceGroupId: `${process.id}:only`, completenessStatus: 'COMPLETE',
        findingStatus, reviewPriority: 'MEDIUM', matrixVersion: '1.1',
        verifiedBy, verifiedAt: verifiedBy ? new Date() : undefined,
      },
    });
  }
  return { object, process, protocol };
}

async function cleanupScenario(objectId: string) {
  await prisma.process.deleteMany({ where: { objectId } });
  await prisma.constructionObject.delete({ where: { id: objectId } });
}

describe('objects', () => {
  it('creates an object and returns it with an id', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/objects',
      headers: await authHeaders(),
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
      method: 'POST', url: '/api/v1/objects', headers: await authHeaders(), payload: { address: 'без имени' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('lists objects with a file count', async () => {
    const app = await buildServer();
    await app.inject({
      method: 'POST', url: '/api/v1/objects', headers: await authHeaders(), payload: { name: 'Для списка' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/objects', headers: await authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items[0]).toHaveProperty('files_count');
    await app.close();
  });
});

describe('indicatorFor', () => {
  it('is yellow when the object was never checked', () => {
    expect(indicatorFor(null)).toBe('yellow');
  });

  it('is red when the latest protocol has a confirmed violation', () => {
    expect(indicatorFor({ status: 'VERIFICATION_COMPLETED', confirmed: 1, candidates: 0, clarifications: 0 })).toBe('red');
  });

  it('is yellow when a candidate is still undecided', () => {
    expect(indicatorFor({ status: 'READY', confirmed: 0, candidates: 1, clarifications: 0 })).toBe('yellow');
  });

  it('is yellow when a clarification is still open', () => {
    expect(indicatorFor({ status: 'VERIFYING', confirmed: 0, candidates: 0, clarifications: 1 })).toBe('yellow');
  });

  it('is green when the protocol is verified with no violations', () => {
    expect(indicatorFor({ status: 'VERIFICATION_COMPLETED', confirmed: 0, candidates: 0, clarifications: 0 })).toBe('green');
  });

  it('is green when the protocol is finalized with no violations', () => {
    expect(indicatorFor({ status: 'PROTOCOL_FINALIZED', confirmed: 0, candidates: 0, clarifications: 0 })).toBe('green');
  });

  it('is yellow when a protocol exists but was not yet verified, even with nothing pending', () => {
    // READY: the engine produced the protocol, but no inspector has looked
    // at it yet - "checked" means verified, not merely processed.
    expect(indicatorFor({ status: 'READY', confirmed: 0, candidates: 0, clarifications: 0 })).toBe('yellow');
  });
});

describe('GET /api/v1/objects - colour indicator', () => {
  it('marks red an object whose latest protocol has a confirmed violation', async () => {
    const { object } = await makeIndicatorScenario('CONFIRMED_VIOLATION', 'VERIFICATION_COMPLETED', 'COMPLETED');
    try {
      const app = await buildServer();
      const res = await app.inject({ method: 'GET', url: '/api/v1/objects', headers: await authHeaders() });
      const item = res.json().items.find((i: { id: string }) => i.id === object.id);
      expect(item).toMatchObject({ indicator: 'red', confirmed: 1, candidates: 0 });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('marks yellow an object with an undecided candidate', async () => {
    const { object } = await makeIndicatorScenario('CANDIDATE', 'READY', 'READY');
    try {
      const app = await buildServer();
      const res = await app.inject({ method: 'GET', url: '/api/v1/objects', headers: await authHeaders() });
      const item = res.json().items.find((i: { id: string }) => i.id === object.id);
      expect(item).toMatchObject({ indicator: 'yellow', candidates: 1, confirmed: 0 });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('marks green a finalized object with no violations', async () => {
    const { object } = await makeIndicatorScenario(null, 'PROTOCOL_FINALIZED', 'FINALIZED');
    try {
      const app = await buildServer();
      const res = await app.inject({ method: 'GET', url: '/api/v1/objects', headers: await authHeaders() });
      const item = res.json().items.find((i: { id: string }) => i.id === object.id);
      expect(item).toMatchObject({ indicator: 'green', confirmed: 0, candidates: 0 });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('GET /api/v1/objects/:object_id', () => {
  it('404s for an unknown object', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/objects/${randomUUID()}`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the object card with its processes, newest first', async () => {
    const { object, process, protocol } = await makeIndicatorScenario(
      'CONFIRMED_VIOLATION', 'VERIFICATION_COMPLETED', 'COMPLETED',
    );
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/objects/${object.id}`, headers: await authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.indicator).toBe('red');
      expect(body.latest_process_id).toBe(process.id);
      expect(body.latest_protocol_id).toBe(protocol.id);
      expect(body.processes).toHaveLength(1);
      expect(body.processes[0]).toMatchObject({
        process_id: process.id, status: 'COMPLETED', protocol_id: protocol.id, protocol_version: 1,
      });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('GET /api/v1/objects/:object_id/files', () => {
  it('404s for an unknown object', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/objects/${randomUUID()}/files`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('lists a file with its page count, and none from another object', async () => {
    const object = await prisma.constructionObject.create({ data: { name: 'Files listing test' } });
    const otherObject = await prisma.constructionObject.create({ data: { name: 'Other object' } });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'PENDING' } });
    const file = await prisma.fileRecord.create({
      data: {
        objectId: object.id, processId: process.id, fileName: 'sosh-pd.pdf', fileHash: hash64(),
        storageKey: `documents/xx/yy/${hash64()}`, sizeBytes: 4096, mimeType: 'application/pdf',
        docStage: 'PD', documentCode: 'AR-01', revision: '1', approvalStatus: 'APPROVED',
      },
    });
    await prisma.page.createMany({
      data: [
        { fileId: file.id, pageNo: 1, widthPt: 841.9, heightPt: 595.3, rotation: 0, charCount: 100 },
        { fileId: file.id, pageNo: 2, widthPt: 841.9, heightPt: 595.3, rotation: 0, charCount: 80 },
      ],
    });
    const otherFile = await prisma.fileRecord.create({
      data: {
        objectId: otherObject.id, fileName: 'foreign.pdf', fileHash: hash64(),
        storageKey: `documents/xx/yy/${hash64()}`, sizeBytes: 1024, mimeType: 'application/pdf',
      },
    });

    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/objects/${object.id}/files`, headers: await authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        id: file.id, file_name: 'sosh-pd.pdf', doc_stage: 'PD', document_code: 'AR-01',
        revision: '1', approval_status: 'APPROVED', page_count: 2, size_bytes: 4096,
        file_sha256: file.fileHash, process_id: process.id,
      });
      expect(body.items.some((i: { id: string }) => i.id === otherFile.id)).toBe(false);
      await app.close();
    } finally {
      await prisma.fileRecord.delete({ where: { id: otherFile.id } });
      await prisma.constructionObject.delete({ where: { id: otherObject.id } });
      await prisma.page.deleteMany({ where: { fileId: file.id } });
      await prisma.fileRecord.delete({ where: { id: file.id } });
      await prisma.process.delete({ where: { id: process.id } });
      await prisma.constructionObject.delete({ where: { id: object.id } });
    }
  });
});
