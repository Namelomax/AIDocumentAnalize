import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { closeQueue, TASK_QUEUE } from '../src/queue.js';
import * as queue from '../src/queue.js';
import { config } from '../src/config.js';
import { authHeaders } from './helpers/auth.js';

let objectId: string;

beforeAll(async () => {
  const object = await prisma.constructionObject.create({ data: { name: 'Process routes test' } });
  objectId = object.id;
});

afterAll(async () => { await closeQueue(); });

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

async function makeProcess(fileCount: number) {
  const process = await prisma.process.create({ data: { objectId, status: 'PENDING' } });
  for (let i = 0; i < fileCount; i += 1) {
    await prisma.fileRecord.create({
      data: {
        objectId,
        processId: process.id,
        fileName: `sheet-${i}.pdf`,
        fileHash: hash64(),
        storageKey: `documents/xx/yy/${hash64()}`,
        sizeBytes: 1024,
        mimeType: 'application/pdf',
      },
    });
  }
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

describe('process routes', () => {
  it('returns 404 for an unknown process', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/api/v1/processes/${randomUUID()}`, headers: await authHeaders() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reports status and file count', async () => {
    const app = await buildServer();
    const process = await makeProcess(2);

    const res = await app.inject({ method: 'GET', url: `/api/v1/processes/${process.id}`, headers: await authHeaders() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'PENDING', files_count: 2 });
    await app.close();
  });

  it('refuses to start a process with no files', async () => {
    const app = await buildServer();
    const process = await makeProcess(0);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`, headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NO_FILES_UPLOADED');
    await app.close();
  });

  it('starts a process and publishes one task', async () => {
    await drainQueue();
    const app = await buildServer();
    const process = await makeProcess(1);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`, headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'PARSING' });

    const messages = await drainQueue();
    expect(messages).toContainEqual({
      type: 'process.start', process_id: process.id, object_id: objectId,
    });
    await app.close();
  });

  it('refuses to start the same process twice', async () => {
    const app = await buildServer();
    const process = await makeProcess(1);
    const headers = await authHeaders();

    await app.inject({ method: 'POST', url: `/api/v1/processes/${process.id}/start`, headers });
    const second = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`, headers,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('ALREADY_STARTED');
    await app.close();
  });

  it('rolls a process back to PENDING and returns 503 when publishing fails', async () => {
    const publishSpy = vi
      .spyOn(queue, 'publishTask')
      .mockRejectedValueOnce(new Error('broker unreachable'));
    const app = await buildServer();
    const process = await makeProcess(1);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`, headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'QUEUE_UNAVAILABLE' });

    const stored = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
    expect(stored.status).toBe('PENDING');

    publishSpy.mockRestore();
    await app.close();
  });

  it('lets a process be started again after a failed publish once the queue is back', async () => {
    const publishSpy = vi
      .spyOn(queue, 'publishTask')
      .mockRejectedValueOnce(new Error('broker unreachable'));
    const app = await buildServer();
    const process = await makeProcess(1);
    const headers = await authHeaders();

    const failed = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`, headers,
    });
    expect(failed.statusCode).toBe(503);
    publishSpy.mockRestore();

    await drainQueue();
    const retried = await app.inject({
      method: 'POST', url: `/api/v1/processes/${process.id}/start`, headers,
    });

    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({ status: 'PARSING' });

    const messages = await drainQueue();
    expect(messages).toContainEqual({
      type: 'process.start', process_id: process.id, object_id: objectId,
    });
    await app.close();
  });
});
