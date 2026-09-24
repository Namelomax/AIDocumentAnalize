import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { ensureBucket } from '../src/storage.js';

let objectId: string;

beforeAll(async () => {
  await ensureBucket();
  const object = await prisma.constructionObject.create({ data: { name: 'Upload test' } });
  objectId = object.id;
});

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

describe('POST /api/v1/documents/upload', () => {
  it('accepts a pdf and returns a process_id', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'ar-01.pdf', body: Buffer.from('%PDF-1.7 content'), type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.process_id).toBeTruthy();
    expect(body.accepted).toHaveLength(1);
    await app.close();
  });

  it('rejects an unsupported format', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'notes.txt', body: Buffer.from('plain'), type: 'text/plain' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('UNSUPPORTED_FORMAT');
    await app.close();
  });

  it('rejects a corrupted pdf whose magic bytes are wrong', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'broken.pdf', body: Buffer.from('not a pdf at all'), type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('CORRUPTED_FILE');
    await app.close();
  });

  it('rejects a duplicate of an already uploaded file', async () => {
    const app = await buildServer();
    const body = Buffer.from('%PDF-1.7 duplicate check');
    const first = form([{ name: 'dup.pdf', body, type: 'application/pdf' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${first.boundary}` },
      payload: first.payload,
    });

    const second = form([{ name: 'dup-again.pdf', body, type: 'application/pdf' }]);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${second.boundary}` },
      payload: second.payload,
    });

    expect(res.json().rejected[0].reason).toBe('DUPLICATE');
    await app.close();
  });

  it('rejects xml whose content is not markup at all', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'registry.xml', body: Buffer.from([0x00, 0x01, 0x02, 0x03]), type: 'application/xml' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('CORRUPTED_FILE');
    await app.close();
  });

  it('accepts xml that opens with a tag after a BOM', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'ok.xml', body: Buffer.from('﻿\n  <registry/>', 'utf8'), type: 'application/xml' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().accepted).toHaveLength(1);
    await app.close();
  });

  it('rejects a file above the per-file limit', async () => {
    const app = await buildServer();
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.7'),
      Buffer.alloc(52_428_801 - 8),
    ]);
    const { boundary, payload } = form([
      { name: 'huge.pdf', body: oversized, type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('FILE_TOO_LARGE');
    await app.close();
  });

  it('creates no process when every file is rejected', async () => {
    const app = await buildServer();
    const before = await prisma.process.count({ where: { objectId } });

    const { boundary, payload } = form([
      { name: 'notes.txt', body: Buffer.from('plain'), type: 'text/plain' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().process_id).toBeUndefined();
    expect(await prisma.process.count({ where: { objectId } })).toBe(before);
    await app.close();
  });
});
