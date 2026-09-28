import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { ensureBucket, putObject, removeObject } from '../src/storage.js';
import { authHeaders } from './helpers/auth.js';

// A minimal, real 1x1 PNG - the page image route streams whatever bytes sit
// at pages.image_key, so the test has to hand it an actual image, not a
// buffer that merely claims to be one.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

let objectId: string;
let processId: string;
let fileId: string;
let imageKey: string;
let candidateCheckId: string;
let negativeCheckId: string;
let notComparableCheckId: string;
let suspicionCheckId: string;
let protocolId: string;
let param: { code: string; parameterName: string; spReference: string | null; gostReference: string | null };
let createdParam = false;

beforeAll(async () => {
  await ensureBucket();

  const object = await prisma.constructionObject.create({ data: { name: 'Protocol routes test' } });
  objectId = object.id;
  const process = await prisma.process.create({ data: { objectId, status: 'VERIFYING' } });
  processId = process.id;

  // M-003 is expected to already carry the real matrix row; only fill it in
  // if this database genuinely has no params loaded yet.
  const existing = await prisma.param.findUnique({ where: { code: 'M-003' } });
  if (existing) {
    param = existing;
  } else {
    createdParam = true;
    param = await prisma.param.create({
      data: {
        code: 'M-003', section: 'ПЗ', parameterName: 'Полезная / Расчетная площадь', unit: 'м²',
        reviewPriority: 'MEDIUM', dataType: 'number', modality: 'scalar_text', matrixVersion: '1.1',
        spReference: 'СП 54.13330.2016 п.5.1', gostReference: 'ГОСТ Р 21.501-2018',
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
      subject: 'room 1.109', expectedValue: null, actualValue: '18.20',
      completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
      reviewPriority: 'MEDIUM', rationale: 'В РД добавлено помещение 1.109', matrixVersion: '1.1',
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

  const negative = await prisma.check.create({
    data: {
      processId, objectId, paramCode: param.code, evidenceGroupId: `${processId}:negative`,
      subject: 'floor total', completenessStatus: 'COMPLETE', findingStatus: 'NEGATIVE_VERIFIED',
      engineStatus: 'NEGATIVE_VERIFIED', reviewPriority: 'LOW', matrixVersion: '1.1',
    },
  });
  negativeCheckId = negative.id;

  const notComparable = await prisma.check.create({
    data: {
      processId, objectId, paramCode: param.code, evidenceGroupId: `${processId}:not-comparable`,
      completenessStatus: 'NOT_COMPARABLE', findingStatus: null,
      reviewPriority: 'LOW', rationale: 'Параметр не реализован в текущей версии матрицы', matrixVersion: '1.1',
    },
  });
  notComparableCheckId = notComparable.id;

  // A free-search hypothesis (section 9.5): its own param code, no Param row
  // needed - buildFinding/buildSuspicion fall back to the check's own
  // paramCode when the matrix has no row for it, exactly as SEM-ROOM-FN
  // itself has none (plan 8, Task 4, rule 6).
  const suspicion = await prisma.check.create({
    data: {
      processId, objectId, paramCode: 'SEM-ROOM-FN', evidenceGroupId: `${processId}:suspicion`,
      subject: 'function 1.109', expectedValue: 'Техническое помещение', actualValue: 'Склад ГСМ',
      completenessStatus: 'COMPLETE', findingStatus: 'SUSPICION', detectionMethod: 'SEMANTIC',
      confidence: 0.9, reviewPriority: 'MEDIUM',
      rationale: 'Назначение помещения 1.109 изменено: в ПД «Техническое помещение», в РД «Склад ГСМ».',
      matrixVersion: '1.1',
    },
  });
  suspicionCheckId = suspicion.id;

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
  // Deleting the checks cascades their evidence fragments and rejection log rows.
  await prisma.check.deleteMany({ where: { processId } });
  await prisma.page.deleteMany({ where: { fileId } });
  await prisma.fileRecord.delete({ where: { id: fileId } });
  await prisma.process.delete({ where: { id: processId } });
  await prisma.constructionObject.delete({ where: { id: objectId } });
  if (createdParam) await prisma.param.delete({ where: { code: param.code } });
  await removeObject(imageKey);
});

describe('GET /api/v1/processes/:process_id/protocol', () => {
  it('returns the latest protocol version with its input manifest hash', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/processes/${processId}/protocol`, headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: protocolId, object_id: objectId, process_id: processId, version: 1,
      matrix_version: '1.1', dataset_version: 'none', model_version: 'rules-2026.09',
    });
    expect(body.input_manifest_hash).toHaveLength(64);
    await app.close();
  });
});

describe('GET /api/v1/protocols/:protocol_id', () => {
  it('requires a token', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/api/v1/protocols/${protocolId}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('404s for an unknown protocol', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${randomUUID()}`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('counts the summary from finding_status and completeness_status', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}`, headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toMatchObject({
      checked: 4, candidates: 1, negative: 1, not_comparable: 1, suspicions: 1,
    });
    await app.close();
  });

  it('keeps findings, completeness and suspicions as three disjoint sections', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}`, headers: await authHeaders(),
    });
    const body = res.json();

    expect(body.findings).toHaveLength(2);
    expect(body.completeness).toHaveLength(1);
    expect(body.suspicions).toHaveLength(1);
    const findingIds = body.findings.map((f: { id: string }) => f.id);
    expect(findingIds.sort()).toEqual([candidateCheckId, negativeCheckId].sort());
    expect(body.completeness[0]).toMatchObject({
      param_code: param.code, completeness_status: 'NOT_COMPARABLE',
      rationale: 'Параметр не реализован в текущей версии матрицы',
    });
    // A hypothesis is never a finding (Global Constraint) - it must not
    // appear in `findings`, and no CANDIDATE/CONFIRMED_VIOLATION count
    // above was inflated by it either.
    expect(findingIds).not.toContain(suspicionCheckId);
    expect(body.suspicions.map((s: { id: string }) => s.id)).toEqual([suspicionCheckId]);
    // No check appears in more than one section.
    const otherIds = new Set([notComparableCheckId, suspicionCheckId]);
    for (const id of findingIds) expect(otherIds.has(id)).toBe(false);
    expect(findingIds.includes(notComparableCheckId)).toBe(false);
    await app.close();
  });

  it('carries detection_method and confidence on a suspicion, in the shape of a finding', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}`, headers: await authHeaders(),
    });
    const body = res.json();

    const suspicion = body.suspicions.find((s: { id: string }) => s.id === suspicionCheckId);
    expect(suspicion).toBeTruthy();
    expect(suspicion).toMatchObject({
      param_code: 'SEM-ROOM-FN',
      finding_status: 'SUSPICION',
      detection_method: 'SEMANTIC',
      confidence: 0.9,
      expected_value: 'Техническое помещение',
      actual_value: 'Склад ГСМ',
    });
    // The shape of a finding: title, evidence and a (null, undecided) decision.
    expect(suspicion.title).toBe('SEM-ROOM-FN — назначение помещения 1.109');
    expect(suspicion.decision).toBeNull();
    await app.close();
  });

  it('builds the candidate evidence card from the fragment and the parameter', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}`, headers: await authHeaders(),
    });
    const body = res.json();

    const candidate = body.findings.find((f: { id: string }) => f.id === candidateCheckId);
    expect(candidate).toBeTruthy();
    expect(candidate.title).toBe(`${param.parameterName} — помещение 1.109`);
    expect(candidate.evidence).toHaveLength(1);
    expect(candidate.evidence[0].bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(candidate.evidence[0].image_url).toBe(`/api/v1/files/${fileId}/pages/1/image`);
    const expectedNormReference = [param.spReference, param.gostReference]
      .filter((value) => Boolean(value))
      .join('; ') || null;
    expect(candidate.norm_reference).toBe(expectedNormReference);
    expect(candidate.decision).toBeNull();
    await app.close();
  });

  it('translates the worker-authored subject into a Russian finding title', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}`, headers: await authHeaders(),
    });
    const body = res.json();

    // The subject stored on the check ('floor total') must stay untouched -
    // it is baked into evidence_group_id - only the displayed title translates it.
    const negative = body.findings.find((f: { id: string }) => f.id === negativeCheckId);
    expect(negative).toBeTruthy();
    expect(negative.title).toBe(`${param.parameterName} — итог по этажу`);
    await app.close();
  });
});

describe('GET /api/v1/protocols/:protocol_id/findings', () => {
  it('filters by finding_status', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}/findings?status=CANDIDATE`,
      headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(candidateCheckId);
    await app.close();
  });

  it('rejects an unknown status', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/protocols/${protocolId}/findings?status=BOGUS`,
      headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/v1/findings/:check_id', () => {
  it('returns one finding with its evidence', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/findings/${candidateCheckId}`, headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: candidateCheckId, finding_status: 'CANDIDATE' });
    await app.close();
  });

  it('404s for an unknown check', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/findings/${randomUUID()}`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/v1/files/:file_id/pages/:page_no/image', () => {
  it('streams the page image byte for byte', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/files/${fileId}/pages/1/image`, headers: await authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.rawPayload).equals(PNG_BYTES)).toBe(true);
    await app.close();
  });

  it('404s for a page that was never rendered', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/files/${fileId}/pages/999/image`, headers: await authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
