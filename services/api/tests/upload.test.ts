import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { ensureBucket } from '../src/storage.js';
import { config } from '../src/config.js';
import { megabytes } from '../src/routes/documents.js';
import { authHeaders } from './helpers/auth.js';

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
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
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
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0]).toMatchObject({
      reason: 'UNSUPPORTED_FORMAT',
      supported_formats: ['PDF', 'DOCX', 'XML'],
      registry_formats: ['CSV', 'XLSX', 'JSON'],
      message: expect.stringContaining('PDF, DOCX, XML'),
    });
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
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0].reason).toBe('CORRUPTED_FILE');
    expect(res.json().rejected[0].message).toMatch(/загрузите файл повторно/i);
    await app.close();
  });

  it('rejects a duplicate of an already uploaded file', async () => {
    const app = await buildServer();
    const body = Buffer.from('%PDF-1.7 duplicate check');
    const first = form([{ name: 'dup.pdf', body, type: 'application/pdf' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${first.boundary}` },
      payload: first.payload,
    });

    const second = form([{ name: 'dup-again.pdf', body, type: 'application/pdf' }]);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${second.boundary}` },
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
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
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
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().accepted).toHaveLength(1);
    await app.close();
  });

  it('rejects a file above the per-file limit', async () => {
    const app = await buildServer();
    // One byte past config.maxFileBytes rather than a literal figure: the
    // limit differs between the test environment and the shipped default
    // (see .env), and a hardcoded size would silently stop testing the limit
    // it once matched.
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.7'),
      Buffer.alloc(config.maxFileBytes + 1 - 8),
    ]);
    const { boundary, payload } = form([
      { name: 'huge.pdf', body: oversized, type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.json().rejected[0]).toMatchObject({
      reason: 'FILE_TOO_LARGE',
      max_bytes: config.maxFileBytes,
      message: expect.stringContaining(megabytes(config.maxFileBytes)),
    });
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
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().process_id).toBeUndefined();
    expect(await prisma.process.count({ where: { objectId } })).toBe(before);
    // The refused attempt is still recorded: every user action is (12.4).
    const refused = await prisma.auditLog.findFirst({
      where: { action: 'DOCUMENTS_REJECTED', objectId },
      orderBy: { timestamp: 'desc' },
    });
    expect(refused).not.toBeNull();
    await app.close();
  });

  it('accepts a csv registry alongside a pdf and flags the process', async () => {
    const app = await buildServer();
    const manifestBody = Buffer.from('file_name,doc_stage\nar-01.pdf,PD\n');
    const { boundary, payload } = form([
      { name: 'plan.pdf', body: Buffer.from('%PDF-1.7 plan for the registry test'), type: 'application/pdf' },
      { name: 'registry.csv', body: manifestBody, type: 'text/csv' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accepted).toHaveLength(2);

    const process = await prisma.process.findUniqueOrThrow({ where: { id: body.process_id } });
    expect(process.manifestUploaded).toBe(true);
    const expectedHash = createHash('sha256').update(manifestBody).digest('hex');
    expect(process.inputManifestHash).toBe(expectedHash);

    const manifestRecord = await prisma.fileRecord.findFirstOrThrow({
      where: { processId: process.id, fileName: 'registry.csv' },
    });
    expect(manifestRecord.docStage).toBeNull();
    await app.close();
  });

  it('accepts an xlsx registry and flags the process', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      {
        name: 'registry.xlsx',
        // A real xlsx is a zip container, so the signature has to be there
        // or the package is rightly treated as corrupted.
        body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xlsx registry bytes')]),
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().accepted).toHaveLength(1);

    const process = await prisma.process.findUniqueOrThrow({ where: { id: res.json().process_id } });
    expect(process.manifestUploaded).toBe(true);
    expect(process.inputManifestHash).toBeTruthy();
    await app.close();
  });

  it('rejects an xlsx registry whose content is not a zip container', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'document.pdf', body: Buffer.from('%PDF-1.7 doc'), type: 'application/pdf' },
      {
        name: 'registry.xlsx',
        body: Buffer.from('this is not a spreadsheet'),
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().rejected).toContainEqual(
      expect.objectContaining({ file_name: 'registry.xlsx', reason: 'CORRUPTED_FILE' }),
    );

    // The package still stands on its documents, and the registry simply
    // never got flagged on the process.
    const process = await prisma.process.findUniqueOrThrow({ where: { id: res.json().process_id } });
    expect(process.manifestUploaded).toBe(false);
    await app.close();
  });

  it('accepts a json registry and flags the process', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'registry.json', body: Buffer.from('{"files":[]}'), type: 'application/json' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().accepted).toHaveLength(1);

    const process = await prisma.process.findUniqueOrThrow({ where: { id: res.json().process_id } });
    expect(process.manifestUploaded).toBe(true);
    expect(process.inputManifestHash).toBeTruthy();
    await app.close();
  });

  it('rejects a second registry in the same package as MULTIPLE_MANIFESTS', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'registry-a.csv', body: Buffer.from('a,b\n1,2\n'), type: 'text/csv' },
      { name: 'registry-b.json', body: Buffer.from('{"files":[]}'), type: 'application/json' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accepted.map((f: { file_name: string }) => f.file_name)).toEqual(['registry-a.csv']);
    expect(body.rejected).toEqual([
      expect.objectContaining({ file_name: 'registry-b.json', reason: 'MULTIPLE_MANIFESTS' }),
    ]);
    await app.close();
  });

  it('leaves manifestUploaded false when no registry is in the package', async () => {
    const app = await buildServer();
    const { boundary, payload } = form([
      { name: 'plain-doc.pdf', body: Buffer.from('%PDF-1.7 no registry here'), type: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${objectId}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const process = await prisma.process.findUniqueOrThrow({ where: { id: res.json().process_id } });
    expect(process.manifestUploaded).toBe(false);
    expect(process.inputManifestHash).toBeNull();
    await app.close();
  });

  it('publishes the limits the interface shows', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/upload/limits', headers: await authHeaders() });
    expect(res.json()).toEqual({
      max_file_bytes: config.maxFileBytes,
      max_package_bytes: config.maxPackageBytes,
      supported_formats: ['PDF', 'DOCX', 'XML'],
      registry_formats: ['CSV', 'XLSX', 'JSON'],
    });
    await app.close();
  });
});
