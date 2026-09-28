import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { ensureBucket, putObject, removeObject } from '../src/storage.js';
import { authHeaders } from './helpers/auth.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

// fast-xml-parser only returns an array when a tag repeats more than once -
// the fixture below deliberately keeps one row per table, so every list read
// back from the parsed document has to be normalized the same way.
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

let objectId: string;
let processId: string;
let fileId: string;
let imageKey: string;
let protocolId: string;
let candidateCheckId: string;
let confirmedCheckId: string;
let inspectorUserId: string;
let param: { code: string };
let createdParam = false;

beforeAll(async () => {
  await ensureBucket();

  const object = await prisma.constructionObject.create({ data: { name: 'Эталонный пакет: экспорт-тест' } });
  objectId = object.id;
  const process = await prisma.process.create({
    data: {
      objectId, status: 'VERIFYING', scenario: 'FULL',
      pdCompleteness: 'UPLOADED', rdCompleteness: 'UPLOADED', idCompleteness: 'PARTIAL',
    },
  });
  processId = process.id;

  const code = 'M-910';
  const existing = await prisma.param.findUnique({ where: { code } });
  if (existing) {
    param = existing;
  } else {
    createdParam = true;
    param = await prisma.param.create({
      data: {
        code, section: 'ПЗ', parameterName: 'Полезная площадь', unit: 'м²',
        reviewPriority: 'MEDIUM', dataType: 'number', modality: 'scalar_text', matrixVersion: '1.1',
        spReference: 'СП 54.13330.2016 п.5.1',
      },
    });
  }

  const file = await prisma.fileRecord.create({
    data: {
      objectId, processId, fileName: 'plan.pdf', fileHash: hash64(),
      storageKey: `documents/xx/yy/${hash64()}`, sizeBytes: 2048, mimeType: 'application/pdf',
      docStage: 'RD', approvalStatus: 'APPROVED',
    },
  });
  fileId = file.id;
  imageKey = `pages/${fileId}/1.png`;
  await putObject(imageKey, PNG_BYTES, 'image/png');
  await prisma.page.create({
    data: { fileId, pageNo: 1, widthPt: 841.9, heightPt: 595.3, rotation: 0, charCount: 120, imageKey },
  });

  const candidate = await prisma.check.create({
    data: {
      processId, objectId, paramCode: param.code, evidenceGroupId: `${processId}:candidate`,
      subject: 'room 1.101', expectedValue: '20.00', actualValue: '18.20', delta: '-1.80',
      completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
      reviewPriority: 'HIGH', rationale: 'Площадь помещения 1.101 меньше проектной', matrixVersion: '1.1',
    },
  });
  candidateCheckId = candidate.id;
  await prisma.evidenceFragment.create({
    data: {
      checkId: candidate.id, evidenceGroupId: candidate.evidenceGroupId, fileId, fileSha256: file.fileHash,
      stage: 'RD', documentCode: 'AR-01', revision: '1', approvalStatus: 'APPROVED', sheetPage: 1,
      x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4, extractedValue: '18.20', role: 'actual',
    },
  });

  // A dedicated user rather than tests/helpers/auth.ts's cached login: that
  // helper's user is only guaranteed to exist once some test file has called
  // it, and file execution order is not this file's to assume.
  const inspectorUser = await prisma.user.create({
    data: { login: `export-test-inspector-${randomUUID().slice(0, 8)}`, fullName: 'Экспорт Тестовый', role: 'INSPECTOR', passwordHash: 'not-used' },
  });
  inspectorUserId = inspectorUser.id;
  const confirmed = await prisma.check.create({
    data: {
      processId, objectId, paramCode: param.code, evidenceGroupId: `${processId}:confirmed`,
      subject: 'room 1.102', expectedValue: '15.00', actualValue: '12.00', delta: '-3.00',
      completenessStatus: 'COMPLETE', findingStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE',
      reviewPriority: 'HIGH', rationale: 'Площадь помещения 1.102 меньше проектной', matrixVersion: '1.1',
      verifiedBy: inspectorUserId, verifiedAt: new Date(), verdictReasonCode: 'OTHER', verdictComment: 'Подтверждено натурным осмотром',
    },
  });
  confirmedCheckId = confirmed.id;

  await prisma.check.create({
    data: {
      processId, objectId, paramCode: param.code, evidenceGroupId: `${processId}:negative`,
      subject: 'floor total', completenessStatus: 'COMPLETE', findingStatus: 'NEGATIVE_VERIFIED',
      engineStatus: 'NEGATIVE_VERIFIED', reviewPriority: 'LOW', matrixVersion: '1.1',
    },
  });

  await prisma.check.create({
    data: {
      processId, objectId, paramCode: param.code, evidenceGroupId: `${processId}:not-comparable`,
      completenessStatus: 'NOT_COMPARABLE', findingStatus: null,
      reviewPriority: 'LOW', rationale: 'Параметр не реализован в текущей версии матрицы', matrixVersion: '1.1',
    },
  });

  await prisma.check.create({
    data: {
      processId, objectId, paramCode: 'SEM-ROOM-FN-EXPORT', evidenceGroupId: `${processId}:suspicion`,
      subject: 'function 1.101', expectedValue: 'Техническое помещение', actualValue: 'Склад ГСМ',
      completenessStatus: 'COMPLETE', findingStatus: 'SUSPICION', detectionMethod: 'SEMANTIC',
      confidence: 0.9, reviewPriority: 'MEDIUM',
      rationale: 'Назначение помещения 1.101 изменено', matrixVersion: '1.1',
    },
  });

  const protocol = await prisma.protocol.create({
    data: {
      objectId, processId, version: 1, matrixVersion: '1.1', datasetVersion: 'none',
      modelVersion: 'rules-2026.09', inputManifestHash: hash64(), status: 'VERIFYING',
    },
  });
  protocolId = protocol.id;
});

afterAll(async () => {
  await prisma.protocol.delete({ where: { id: protocolId } });
  await prisma.check.deleteMany({ where: { processId } });
  await prisma.page.deleteMany({ where: { fileId } });
  await prisma.fileRecord.delete({ where: { id: fileId } });
  await prisma.process.delete({ where: { id: processId } });
  await prisma.constructionObject.delete({ where: { id: objectId } });
  await prisma.user.delete({ where: { id: inspectorUserId } });
  if (createdParam) await prisma.param.delete({ where: { code: param.code } });
  await removeObject(imageKey);
});

describe('GET /api/v1/protocols/:protocol_id/export', () => {
  it('requires a token', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/api/v1/protocols/${protocolId}/export?format=pdf` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('404s for an unknown protocol', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${randomUUID()}/export?format=pdf`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400s on an unknown format', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}/export?format=csv`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('serves the pdf format with the right content-type, filename and audit entry', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}/export?format=pdf`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="protocol-${protocolId.slice(0, 8)}-v1.pdf"`);
    // A valid PDF, not merely a file that was created (task spec's own warning).
    expect(Buffer.from(res.rawPayload).subarray(0, 4).toString('ascii')).toBe('%PDF');

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'PROTOCOL_EXPORTED', objectId }, orderBy: { timestamp: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect(entry?.details).toMatchObject({ protocol_id: protocolId, format: 'pdf' });
    await app.close();
  });

  it('serves the docx format as a zip whose word/document.xml carries the Russian title', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}/export?format=docx`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="protocol-${protocolId.slice(0, 8)}-v1.docx"`);

    const zip = await JSZip.loadAsync(Buffer.from(res.rawPayload));
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toBeTruthy();
    expect(documentXml).toContain(`Протокол проверки № ${protocolId.slice(0, 8)}`);
    await app.close();
  });

  it('serves a parseable xml with all five sections, the manifest hash and a candidate\'s source sha256', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}/export?format=xml`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="protocol-${protocolId.slice(0, 8)}-v1.xml"`);
    expect(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(res.body);
    const protocol = parsed.protocol;
    expect(protocol['@_matrix_version']).toBe('1.1');
    expect(protocol['@_model_version']).toBe('rules-2026.09');
    expect(protocol['@_dataset_version']).toBe('none');
    expect(protocol['@_input_manifest_hash']).toHaveLength(64);

    // All five of section 9.2's named tables.
    expect(protocol.completeness_and_comparability).toBeTruthy();
    expect(protocol.candidates).toBeTruthy();
    expect(protocol.confirmed_violations).toBeTruthy();
    expect(protocol.negative_verified).toBeTruthy();
    expect(protocol.free_search_hypotheses).toBeTruthy();

    const candidates = asArray(protocol.candidates.finding);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate['@_id']).toBe(candidateCheckId);
    const fragments = asArray(candidate.evidence.fragment);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]['@_file_sha256']).toHaveLength(64);
    expect(fragments[0]['@_file_id']).toBe(fileId);

    const confirmed = asArray(protocol.confirmed_violations.finding);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]['@_id']).toBe(confirmedCheckId);
    expect(confirmed[0].decision['@_status']).toBe('CONFIRMED_VIOLATION');

    // Document upload status / check type (section 9.2).
    expect(protocol.document_upload_status.pd_completeness).toBe('UPLOADED');
    expect(protocol.check_type.scenario).toBe('FULL');
    await app.close();
  });
});
