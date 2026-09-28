// Section 9.6: transfer of a finalized protocol to ИАИС «РиН», its retry
// ladder, manual controls, and the inbound direction (a дозагрузка ИАИС
// «РиН» announces). The HTTP call itself (integration/client.ts) is mocked
// throughout - what this file tests is the scheduling/payload/status logic
// around it, not the network.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { authHeaders } from './helpers/auth.js';
import { cleanupScenario } from './helpers/cleanup.js';

vi.mock('../src/integration/client.js', () => ({ postInspectionResult: vi.fn() }));
// eslint-disable-next-line import/first
import { postInspectionResult } from '../src/integration/client.js';
// eslint-disable-next-line import/first
import { runSchedulerTick } from '../src/integration/transfers.js';
// eslint-disable-next-line import/first
import { buildTransferPayload } from '../src/integration/payload.js';

const mockedPost = vi.mocked(postInspectionResult);

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

const PARAM_CODE = 'RIN-900';

async function ensureParam() {
  const existing = await prisma.param.findUnique({ where: { code: PARAM_CODE } });
  if (existing) return existing;
  return prisma.param.create({
    data: {
      code: PARAM_CODE, section: 'ПЗ', parameterName: 'РиН тестовый параметр', unit: 'м²',
      reviewPriority: 'MEDIUM', dataType: 'number', modality: 'scalar_text', matrixVersion: '1.1',
    },
  });
}

// A finalizable protocol with one CONFIRMED_VIOLATION (with evidence), one
// NEGATIVE_VERIFIED, and its own input file - exactly the mix the payload
// test needs to prove it keeps the first and drops the second.
async function makeFinalizableScenario() {
  const param = await ensureParam();
  // Ensures the demo test users (test-inspector/test-admin/test-supervisor)
  // exist before anything below looks one up - authHeaders() creates them
  // lazily on first use per role, and this scenario is often the first thing
  // in the file to touch some of them.
  await Promise.all([authHeaders('INSPECTOR'), authHeaders('ADMIN'), authHeaders('SUPERVISOR')]);
  const inspector = await prisma.user.findUniqueOrThrow({ where: { login: 'test-inspector' } });
  const object = await prisma.constructionObject.create({
    data: { name: 'РиН тест объект', address: 'ул. Тестовая, 1', permitNumber: 'PN-RIN-1' },
  });
  const process = await prisma.process.create({ data: { objectId: object.id, status: 'COMPLETED' } });
  const file = await prisma.fileRecord.create({
    data: {
      objectId: object.id, processId: process.id, fileName: 'akt.pdf', fileHash: hash64(),
      storageKey: 'documents/xx/yy/akt', sizeBytes: 100, mimeType: 'application/pdf',
      docStage: 'ID', documentCode: 'AR-01', revision: '1', approvalStatus: 'APPROVED',
    },
  });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: 'VERIFICATION_COMPLETED',
    },
  });
  const confirmed = await prisma.check.create({
    data: {
      processId: process.id, objectId: object.id, paramCode: param.code,
      evidenceGroupId: `${process.id}:room1`, subject: 'room 1', completenessStatus: 'COMPLETE',
      findingStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE', reviewPriority: 'HIGH',
      matrixVersion: '1.1', expectedValue: '10', actualValue: '12', rationale: 'расхождение площади',
      verifiedBy: inspector.id, verifiedAt: new Date(), verdictReasonCode: null, verdictComment: 'подтверждено',
    },
  });
  await prisma.evidenceFragment.create({
    data: {
      checkId: confirmed.id, evidenceGroupId: confirmed.evidenceGroupId, fileId: file.id, fileSha256: file.fileHash,
      stage: 'ID', documentCode: 'AR-01', revision: '1', approvalStatus: 'APPROVED', sheetPage: 1,
      x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5, extractedValue: '12', role: 'actual',
    },
  });
  const negative = await prisma.check.create({
    data: {
      processId: process.id, objectId: object.id, paramCode: param.code,
      evidenceGroupId: `${process.id}:room2`, subject: 'room 2', completenessStatus: 'COMPLETE',
      findingStatus: 'NEGATIVE_VERIFIED', engineStatus: 'NEGATIVE_VERIFIED', reviewPriority: 'MEDIUM',
      matrixVersion: '1.1', verifiedBy: inspector.id, verifiedAt: new Date(),
      verdictReasonCode: 'OTHER', verdictComment: 'не подтверждено',
    },
  });
  return { object, process, protocol, file, confirmed, negative, inspector };
}

async function finalize(protocolId: string) {
  const app = await buildServer();
  const res = await app.inject({
    method: 'POST', url: `/api/v1/protocols/${protocolId}/finalize`, headers: await authHeaders('INSPECTOR'),
  });
  await app.close();
  return res;
}

beforeEach(() => {
  mockedPost.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('finalize enqueues a transfer', () => {
  it('creates a PENDING transfer and sets sync_status to PENDING_SYNC', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      const res = await finalize(protocol.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().sync_status).toBe('PENDING_SYNC');

      const stored = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(stored.syncStatus).toBe('PENDING_SYNC');

      const transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('PENDING');
      expect(transfer.attempt).toBe(0);
      expect(transfer.nextAttemptAt).not.toBeNull();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('buildTransferPayload', () => {
  it('carries only confirmed findings, protocol/matrix/model/dataset versions and the input file registry', async () => {
    const { object, protocol, file, confirmed, negative } = await makeFinalizableScenario();
    try {
      const { payload, payloadHash } = await buildTransferPayload(protocol.id);

      expect(payload.protocol_id).toBe(protocol.id);
      expect(payload.protocol_version).toBe(protocol.version);
      expect(payload.matrix_version).toBe(protocol.matrixVersion);
      expect(payload.model_version).toBe(protocol.modelVersion);
      expect(payload.dataset_version).toBe(protocol.datasetVersion);
      expect(payload.input_manifest_hash).toBe(protocol.inputManifestHash);

      expect(payload.input_files).toHaveLength(1);
      expect(payload.input_files[0]).toMatchObject({ file_name: file.fileName, sha256: file.fileHash });

      // Only the CONFIRMED_VIOLATION finding travels - the NEGATIVE_VERIFIED
      // one never does (section 9.3: "передаются только подтверждённые
      // инспектором записи").
      expect(payload.findings).toHaveLength(1);
      expect(payload.findings[0].finding_id).toBe(confirmed.id);
      expect(payload.findings.some((f) => f.finding_id === negative.id)).toBe(false);
      expect(payload.findings[0].evidence).toHaveLength(1);
      expect(payload.findings[0].evidence[0]).toMatchObject({ file_id: file.id, sheet_page: 1 });

      expect(payloadHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('scheduler: success', () => {
  it('marks the transfer SENT and the protocol SYNCED', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      await finalize(protocol.id);
      mockedPost.mockResolvedValueOnce({ outcome: 'success', statusCode: 200 });

      await runSchedulerTick();

      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(mockedPost.mock.calls[0][0]).toBe(protocol.processId);
      const sentPayload = mockedPost.mock.calls[0][1] as { findings: unknown[] };
      expect(sentPayload.findings).toHaveLength(1);

      const transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('SENT');
      expect(transfer.attempt).toBe(1);
      expect(transfer.responseCode).toBe(200);
      expect(transfer.payloadHash).toMatch(/^[0-9a-f]{64}$/);

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.syncStatus).toBe('SYNCED');

      const sentAudit = await prisma.auditLog.findFirst({
        where: { action: 'RIN_TRANSFER_SENT', objectId: object.id },
      });
      expect(sentAudit).not.toBeNull();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('scheduler: 4xx is a permanent failure', () => {
  it('marks FAILED after a single attempt, without scheduling a retry', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      await finalize(protocol.id);
      mockedPost.mockResolvedValueOnce({ outcome: 'permanent_failure', statusCode: 422, error: 'HTTP 422' });

      await runSchedulerTick();

      expect(mockedPost).toHaveBeenCalledTimes(1);
      const transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('FAILED');
      expect(transfer.attempt).toBe(1);
      expect(transfer.responseCode).toBe(422);
      expect(transfer.nextAttemptAt).toBeNull();

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.syncStatus).toBe('FAILED');

      const admin = await prisma.user.findUniqueOrThrow({ where: { login: 'test-admin' } });
      const notified = await prisma.notification.findFirst({
        where: { userId: admin.id, kind: 'RIN_TRANSFER_FAILED' }, orderBy: { createdAt: 'desc' },
      });
      expect(notified).not.toBeNull();

      const failedAudit = await prisma.auditLog.findFirst({
        where: { action: 'RIN_TRANSFER_FAILED', objectId: object.id }, orderBy: { timestamp: 'desc' },
      });
      expect(failedAudit?.details).toMatchObject({ protocol_id: protocol.id, permanent: true });
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('scheduler: retry ladder', () => {
  it('retries a 5xx and a timeout with exponential delay, then gives up after the 3rd retry', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      // Frozen BEFORE finalize: enqueueTransfer's own next_attempt_at (set to
      // the real "now" otherwise) must be measured against the same clock
      // every assertion below advances, or it would already look overdue -
      // or not yet due - against an unrelated real wall-clock time.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      await finalize(protocol.id);

      // Attempt 1: a 5xx - retryable.
      mockedPost.mockResolvedValueOnce({ outcome: 'retryable_failure', statusCode: 503, error: 'HTTP 503' });
      await runSchedulerTick();
      let transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('PENDING');
      expect(transfer.attempt).toBe(1);
      const delay1 = config.rin.retryDelaysS[0];
      expect(transfer.nextAttemptAt!.getTime()).toBe(Date.now() + delay1 * 1000);

      // Not due yet - the scheduler must leave it alone.
      vi.setSystemTime(new Date(Date.now() + (delay1 - 5) * 1000));
      await runSchedulerTick();
      expect(mockedPost).toHaveBeenCalledTimes(1);

      // Now due. Attempt 2: a timeout - also retryable, no statusCode at all.
      vi.setSystemTime(new Date(Date.now() + 10 * 1000));
      mockedPost.mockResolvedValueOnce({ outcome: 'retryable_failure', error: 'timeout after 10000ms' });
      await runSchedulerTick();
      transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('PENDING');
      expect(transfer.attempt).toBe(2);
      expect(transfer.lastError).toBe('timeout after 10000ms');
      const delay2 = config.rin.retryDelaysS[1];
      expect(transfer.nextAttemptAt!.getTime()).toBe(Date.now() + delay2 * 1000);

      // Attempt 3: another 5xx.
      vi.setSystemTime(new Date(Date.now() + (delay2 + 5) * 1000));
      mockedPost.mockResolvedValueOnce({ outcome: 'retryable_failure', statusCode: 502, error: 'HTTP 502' });
      await runSchedulerTick();
      transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('PENDING');
      expect(transfer.attempt).toBe(3);
      const delay3 = config.rin.retryDelaysS[2];
      expect(transfer.nextAttemptAt!.getTime()).toBe(Date.now() + delay3 * 1000);

      // Attempt 4 (the 3rd retry) fails too - retry budget exhausted, FAILED.
      vi.setSystemTime(new Date(Date.now() + (delay3 + 5) * 1000));
      mockedPost.mockResolvedValueOnce({ outcome: 'retryable_failure', statusCode: 503, error: 'HTTP 503' });
      await runSchedulerTick();
      transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('FAILED');
      expect(transfer.attempt).toBe(4);
      expect(transfer.nextAttemptAt).toBeNull();

      expect(mockedPost).toHaveBeenCalledTimes(4);

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.syncStatus).toBe('FAILED');

      const admin = await prisma.user.findUniqueOrThrow({ where: { login: 'test-admin' } });
      const notified = await prisma.notification.findFirst({
        where: { userId: admin.id, kind: 'RIN_TRANSFER_FAILED', processId: null },
        orderBy: { createdAt: 'desc' },
      });
      // processId is not carried on this notification (only objectId is
      // meaningful for a transfer failure) - matched loosely by kind/user
      // above; presence is what matters here.
      expect(notified).not.toBeNull();
    } finally {
      // Restored before cleanup, not after (the file's own afterEach would
      // be too late): cleanupScenario's removeObject call signs a real
      // request to MinIO, and a clock still frozen at 2026-01-01 skews that
      // signature far enough past the server's own clock for it to refuse
      // the request as a possible replay.
      vi.useRealTimers();
      await cleanupScenario(object.id);
    }
  });
});

describe('unfinalize cancels a pending transfer', () => {
  it('sets the transfer CANCELLED and clears sync_status', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      await finalize(protocol.id);

      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/unfinalize`,
        headers: await authHeaders('SUPERVISOR'),
        payload: { reason: 'проверка отмены передачи' },
      });
      await app.close();
      expect(res.statusCode).toBe(200);

      const transfer = await prisma.integrationTransfer.findFirstOrThrow({ where: { protocolId: protocol.id } });
      expect(transfer.status).toBe('CANCELLED');

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.syncStatus).toBeNull();

      expect(mockedPost).not.toHaveBeenCalled();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('manual resync: POST /api/v1/protocols/:id/sync', () => {
  it('is forbidden for an inspector', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/sync`, headers: await authHeaders('INSPECTOR'),
      });
      await app.close();
      expect(res.statusCode).toBe(403);
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses a protocol that is not finalized', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/sync`, headers: await authHeaders('SUPERVISOR'),
      });
      await app.close();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('NOT_FINALIZED');
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses a finalized protocol whose transfer has not failed', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      await finalize(protocol.id); // leaves a PENDING transfer, not FAILED
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/sync`, headers: await authHeaders('ADMIN'),
      });
      await app.close();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('NOT_FAILED');
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('requeues a FAILED transfer for a supervisor/admin and GET reports it', async () => {
    const { object, protocol } = await makeFinalizableScenario();
    try {
      await finalize(protocol.id);
      mockedPost.mockResolvedValueOnce({ outcome: 'permanent_failure', statusCode: 400, error: 'HTTP 400' });
      await runSchedulerTick();

      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/sync`, headers: await authHeaders('ADMIN'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sync_status).toBe('PENDING_SYNC');

      const storedProtocol = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      expect(storedProtocol.syncStatus).toBe('PENDING_SYNC');

      const getRes = await app.inject({
        method: 'GET', url: `/api/v1/protocols/${protocol.id}/sync`, headers: await authHeaders('ADMIN'),
      });
      await app.close();
      expect(getRes.statusCode).toBe(200);
      const body = getRes.json();
      expect(body.sync_status).toBe('PENDING_SYNC');
      expect(body.transfers.length).toBeGreaterThanOrEqual(2);
      expect(body.transfers.some((t: { status: string }) => t.status === 'FAILED')).toBe(true);
      expect(body.transfers.some((t: { status: string }) => t.status === 'PENDING')).toBe(true);
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('POST /api/v1/integration/rin/documents (inbound)', () => {
  it('rejects a request without a valid service token', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integration/rin/documents',
      headers: { 'x-rin-token': 'wrong-token', 'content-type': 'application/json' },
      payload: { object_id: randomUUID(), files: [{ file_name: 'a.pdf', mime_type: 'application/pdf', content_base64: 'JVBERi0=' }] },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it('when the latest protocol is finalized, only notifies the inspector and stores nothing', async () => {
    const { object, protocol, process: proc } = await makeFinalizableScenario();
    try {
      await finalize(protocol.id);

      const filesBefore = await prisma.fileRecord.count({ where: { processId: proc.id } });

      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/integration/rin/documents',
        headers: { 'x-rin-token': config.rin.inboundToken, 'content-type': 'application/json' },
        payload: {
          process_id: proc.id,
          files: [{ file_name: 'new-doc.pdf', mime_type: 'application/pdf', content_base64: Buffer.from('%PDF-1.7').toString('base64') }],
        },
      });
      await app.close();

      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe('NOTIFIED_ONLY');

      const filesAfter = await prisma.fileRecord.count({ where: { processId: proc.id } });
      expect(filesAfter).toBe(filesBefore);

      const inspector = await prisma.user.findUniqueOrThrow({ where: { login: 'test-inspector' } });
      const notified = await prisma.notification.findFirst({
        where: { userId: inspector.id, kind: 'RIN_NEW_DOCUMENTS', processId: proc.id },
      });
      expect(notified).not.toBeNull();
      expect(notified?.body).toMatch(/протокол финализирован/i);
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('stores the files through the incremental-upload path when the protocol is not finalized', async () => {
    const object = await prisma.constructionObject.create({ data: { name: 'РиН inbound store test' } });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'READY' } });
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/integration/rin/documents',
        headers: { 'x-rin-token': config.rin.inboundToken, 'content-type': 'application/json' },
        payload: {
          process_id: process.id,
          files: [{ file_name: 'akt-2.pdf', mime_type: 'application/pdf', content_base64: Buffer.from('%PDF-1.7 rin').toString('base64') }],
        },
      });
      await app.close();

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.status).toBe('STORED');
      expect(body.accepted).toHaveLength(1);

      const stored = await prisma.fileRecord.findFirst({ where: { processId: process.id, fileName: 'akt-2.pdf' } });
      expect(stored).not.toBeNull();

      const storedProcess = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      expect(storedProcess.status).toBe('PARSING');
    } finally {
      await cleanupScenario(object.id);
    }
  });
});
