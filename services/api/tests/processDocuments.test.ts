import { randomUUID, createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import amqp from 'amqplib';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { ensureBucket } from '../src/storage.js';
import { closeQueue, TASK_QUEUE } from '../src/queue.js';
import * as queue from '../src/queue.js';
import { config } from '../src/config.js';
import { authHeaders } from './helpers/auth.js';

let objectId: string;

beforeAll(async () => {
  await ensureBucket();
  const object = await prisma.constructionObject.create({ data: { name: 'Дозагрузка test' } });
  objectId = object.id;
});

afterAll(async () => { await closeQueue(); });

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

function form(files: Array<{ name: string; body: Buffer; type: string }>) {
  const boundary = '----test';
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\n` +
      `Content-Type: ${f.type}\r\n\r\n`
    ), f.body, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(parts) };
}

async function makeProcess(status: string) {
  const process = await prisma.process.create({ data: { objectId, status: status as never } });
  await prisma.fileRecord.create({
    data: {
      objectId, processId: process.id, fileName: 'original.pdf', fileHash: hash64(),
      storageKey: `documents/xx/yy/${hash64()}`, sizeBytes: 1024, mimeType: 'application/pdf',
    },
  });
  return process;
}

async function drainQueue(): Promise<unknown[]> {
  const connection = await amqp.connect(config.rabbitmqUrl);
  const channel = await connection.createChannel();
  await channel.assertQueue(TASK_QUEUE, { durable: true });
  const messages: unknown[] = [];
  for (;;) {
    const message = await channel.get(TASK_QUEUE, { noAck: true });
    if (!message) break;
    messages.push(JSON.parse(message.content.toString()));
  }
  await channel.close();
  await connection.close();
  return messages;
}

async function upload(processId: string, files: Array<{ name: string; body: Buffer; type: string }>) {
  const app = await buildServer();
  const { boundary, payload } = form(files);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/processes/${processId}/documents`,
    headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  await app.close();
  return res;
}

describe('POST /api/v1/processes/:process_id/documents (дозагрузка)', () => {
  it('404s for an unknown process', async () => {
    const res = await upload(randomUUID(), [
      { name: 'extra.pdf', body: Buffer.from('%PDF-1.7 extra'), type: 'application/pdf' },
    ]);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('PROCESS_NOT_FOUND');
  });

  it('refuses while the process is PARSING', async () => {
    const process = await makeProcess('PARSING');
    const res = await upload(process.id, [
      { name: 'extra.pdf', body: Buffer.from('%PDF-1.7 extra'), type: 'application/pdf' },
    ]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'PROCESS_PARSING' });
    expect(res.json().message).toMatch(/дозагрузка станет доступна/i);
  });

  it.each(['PENDING', 'READY', 'VERIFYING', 'COMPLETED', 'FAILED'])(
    'accepts a дозагрузка while the process is %s',
    async (status) => {
      await drainQueue();
      const process = await makeProcess(status);
      const res = await upload(process.id, [
        { name: 'extra.pdf', body: Buffer.from(`%PDF-1.7 extra content ${status} ${randomUUID()}`), type: 'application/pdf' },
      ]);
      expect(res.statusCode).toBe(202);
      expect(res.json().accepted).toHaveLength(1);

      const stored = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      if (status === 'PENDING') {
        // Nothing to react to yet - a later POST /start reads every file
        // fresh, new ones included.
        expect(stored.status).toBe('PENDING');
        expect(await drainQueue()).toEqual([]);
      } else {
        expect(stored.status).toBe('PARSING');
        const messages = await drainQueue();
        expect(messages).toContainEqual({
          type: 'process.update', process_id: process.id, object_id: objectId,
          file_ids: [res.json().accepted[0].file_id],
        });
      }
    },
  );

  it('refuses once the latest protocol is finalized', async () => {
    const object = await prisma.constructionObject.create({ data: { name: 'Дозагрузка finalized test' } });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'FINALIZED' } });
    await prisma.protocol.create({
      data: {
        objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
        modelVersion: 'rules-2026.09', datasetVersion: 'none', inputManifestHash: hash64(),
        status: 'PROTOCOL_FINALIZED',
      },
    });
    const res = await upload(process.id, [
      { name: 'extra.pdf', body: Buffer.from('%PDF-1.7 extra'), type: 'application/pdf' },
    ]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'PROTOCOL_FINALIZED' });
    expect(res.json().message).toMatch(/дозагрузка невозможна/i);
  });

  it('allows дозагрузка again once the protocol is unfinalized', async () => {
    const object = await prisma.constructionObject.create({ data: { name: 'Дозагрузка unfinalized test' } });
    const process = await prisma.process.create({ data: { objectId: object.id, status: 'COMPLETED' } });
    await prisma.protocol.create({
      data: {
        objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
        modelVersion: 'rules-2026.09', datasetVersion: 'none', inputManifestHash: hash64(),
        status: 'VERIFICATION_COMPLETED',
      },
    });
    const res = await upload(process.id, [
      { name: 'extra.pdf', body: Buffer.from('%PDF-1.7 extra'), type: 'application/pdf' },
    ]);
    expect(res.statusCode).toBe(202);
  });

  it('reuses the shared validation - an unsupported format is rejected with the same reason', async () => {
    const process = await makeProcess('READY');
    const res = await upload(process.id, [
      { name: 'notes.txt', body: Buffer.from('plain'), type: 'text/plain' },
    ]);
    expect(res.statusCode).toBe(422);
    expect(res.json().rejected[0]).toMatchObject({ reason: 'UNSUPPORTED_FORMAT' });
  });

  it('rejects a file already stored for the object as a duplicate', async () => {
    const process = await makeProcess('READY');
    const body = Buffer.from('%PDF-1.7 dup for дозагрузка');
    await prisma.fileRecord.create({
      data: {
        objectId, processId: process.id, fileName: 'dup.pdf',
        fileHash: createHash('sha256').update(body).digest('hex'),
        storageKey: `documents/xx/yy/${hash64()}`, sizeBytes: body.length, mimeType: 'application/pdf',
      },
    });
    const res = await upload(process.id, [{ name: 'dup-again.pdf', body, type: 'application/pdf' }]);
    expect(res.json().rejected[0]).toMatchObject({ reason: 'DUPLICATE' });
  });

  it('rolls the status back and returns 503 when publishing fails', async () => {
    const publishSpy = vi.spyOn(queue, 'publishTask').mockRejectedValueOnce(new Error('broker unreachable'));
    const process = await makeProcess('READY');

    const res = await upload(process.id, [
      { name: 'extra.pdf', body: Buffer.from('%PDF-1.7 extra'), type: 'application/pdf' },
    ]);

    expect(res.statusCode).toBe(503);
    const stored = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
    expect(stored.status).toBe('READY');
    publishSpy.mockRestore();
  });

  it('records an audit entry for a successful дозагрузка', async () => {
    const process = await makeProcess('READY');
    await upload(process.id, [
      { name: 'audited.pdf', body: Buffer.from('%PDF-1.7 audited'), type: 'application/pdf' },
    ]);
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'DOCUMENTS_APPENDED', objectId },
      orderBy: { timestamp: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect((entry?.details as Record<string, unknown>)?.process_id).toBe(process.id);
  });
});
