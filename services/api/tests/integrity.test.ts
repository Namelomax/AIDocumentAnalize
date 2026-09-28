// Customer's ТЗ p.31, "Проверка целостности данных: ежедневная проверка
// контрольных сумм (хешей) файлов в хранилище для выявления повреждений или
// несанкционированных изменений". Runs runIntegrityCheck directly (the DB
// here is shared with every other test file, so this only ever asserts
// about the one fixture file it created and tampered with itself, never
// about the sweep's totals).
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { ensureBucket, putObject, removeObject, storageKeyFor, sha256 } from '../src/storage.js';
import { runIntegrityCheck } from '../src/integrity.js';
import { authHeaders } from './helpers/auth.js';

let objectId: string;
let fileId: string;
let fileName: string;
let storageKey: string;
let originalBody: Buffer;
let originalHash: string;

beforeAll(async () => {
  await ensureBucket();
  const object = await prisma.constructionObject.create({ data: { name: 'Integrity test' } });
  objectId = object.id;

  originalBody = Buffer.from('%PDF-1.7 integrity check fixture\n');
  originalHash = sha256(originalBody);
  storageKey = storageKeyFor(originalHash);
  await putObject(storageKey, originalBody, 'application/pdf');

  const process = await prisma.process.create({ data: { objectId, status: 'PENDING' } });
  fileName = 'integrity-fixture.pdf';
  const file = await prisma.fileRecord.create({
    data: {
      objectId, processId: process.id, fileName,
      fileHash: originalHash, storageKey, sizeBytes: originalBody.length, mimeType: 'application/pdf',
    },
  });
  fileId = file.id;
});

describe('integrity check (customer ТЗ p.31)', () => {
  it('POST /admin/integrity-check refuses a non-admin', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/integrity-check', headers: await authHeaders('INSPECTOR'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('reports no failure for an untouched file', async () => {
    const run = await runIntegrityCheck(null);
    expect(run).not.toBeNull();
    expect(run!.failures.find((f) => f.file_id === fileId)).toBeUndefined();
    // The sweep walks every stored file, not just this test's own fixture -
    // the shared dev database this suite runs against accumulates files
    // across many runs, so a generous timeout beats vitest's 5s default.
  }, 60_000);

  it('reports exactly the tampered file as a mismatch and notifies admins', async () => {
    const tampered = Buffer.from('%PDF-1.7 TAMPERED CONTENT, not what file_hash expects\n');
    await putObject(storageKey, tampered, 'application/pdf');
    try {
      const run = await runIntegrityCheck(null);
      expect(run).not.toBeNull();
      expect(run!.status).toBe('FAILURES');

      const failure = run!.failures.find((f) => f.file_id === fileId);
      expect(failure).toMatchObject({ kind: 'mismatch', expected_hash: originalHash });
      expect(failure!.actual_hash).not.toBeNull();
      expect(failure!.actual_hash).not.toBe(originalHash);

      const notification = await prisma.notification.findFirst({
        where: { kind: 'INTEGRITY_CHECK_FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(notification).not.toBeNull();
      expect(notification!.body).toContain(fileName);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'INTEGRITY_CHECK_FAILED' },
        orderBy: { timestamp: 'desc' },
      });
      expect(audit).not.toBeNull();
    } finally {
      // Restore, so the "missing" case below (and any later run) starts from
      // a known-good object again.
      await putObject(storageKey, originalBody, 'application/pdf');
    }
  }, 60_000);

  it('reports a missing file when the object disappears from storage', async () => {
    await removeObject(storageKey);
    try {
      const run = await runIntegrityCheck(null);
      expect(run).not.toBeNull();
      const failure = run!.failures.find((f) => f.file_id === fileId);
      expect(failure).toMatchObject({ kind: 'missing', expected_hash: originalHash, actual_hash: null });
    } finally {
      await putObject(storageKey, originalBody, 'application/pdf');
    }
  }, 60_000);

  it('POST /admin/integrity-check runs on demand and GET /admin/integrity-runs lists it', async () => {
    const app = await buildServer();
    const triggered = await app.inject({
      method: 'POST', url: '/api/v1/admin/integrity-check', headers: await authHeaders('ADMIN'),
    });
    expect(triggered.statusCode).toBe(202);
    expect(triggered.json().status).toMatch(/^(OK|FAILURES)$/);

    const listed = await app.inject({
      method: 'GET', url: '/api/v1/admin/integrity-runs', headers: await authHeaders('ADMIN'),
    });
    expect(listed.statusCode).toBe(200);
    const runs = listed.json().runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toHaveProperty('files_checked');
    expect(runs.map((r: { id: string }) => r.id)).toContain(triggered.json().id);
    await app.close();
  }, 60_000);
});
