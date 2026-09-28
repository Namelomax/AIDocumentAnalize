import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';
import { cleanupScenario } from './helpers/cleanup.js';

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

// One GOLD label, backed by a real Check (gold_labels.check_id's FK) - the
// dataset-release path only ever reads gold_labels rows, so building one
// directly (rather than going through a full finalize) is enough here.
async function makeGoldLabel(paramCode = 'M-DATASET') {
  const object = await prisma.constructionObject.create({ data: { name: 'Quality datasets test' } });
  const process = await prisma.process.create({ data: { objectId: object.id, status: 'FINALIZED' } });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: 'PROTOCOL_FINALIZED',
    },
  });
  const check = await prisma.check.create({
    data: {
      processId: process.id, objectId: object.id, paramCode,
      evidenceGroupId: `${process.id}:c0`, completenessStatus: 'COMPLETE',
      findingStatus: 'CONFIRMED_VIOLATION', engineStatus: 'CANDIDATE',
      reviewPriority: 'MEDIUM', matrixVersion: '1.1', verifiedBy: 'fixture',
    },
  });
  const label = await prisma.goldLabel.create({
    data: {
      checkId: check.id, protocolId: protocol.id, objectId: object.id, processId: process.id,
      evidenceGroupId: check.evidenceGroupId, paramCode, modality: 'scalar_text',
      label: 'POSITIVE', engineStatus: 'CANDIDATE', finalStatus: 'CONFIRMED_VIOLATION',
      matrixVersion: '1.1', modelVersion: 'rules-2026.09', evidence: [{ role: 'actual', file_id: 'f1' }],
    },
  });
  return { object, label };
}

async function cleanupDatasetVersion(id: string) {
  await prisma.datasetVersionLabel.deleteMany({ where: { datasetVersionId: id } });
  await prisma.datasetVersion.delete({ where: { id } });
}

describe('POST /api/v1/quality/datasets', () => {
  it('is forbidden for an inspector', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/quality/datasets',
      headers: await authHeaders('INSPECTOR'), payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('is forbidden for a supervisor (view-only role)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/quality/datasets',
      headers: await authHeaders('SUPERVISOR'), payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('freezes every current GOLD label into a named release, for an ML engineer', async () => {
    const { object, label } = await makeGoldLabel();
    let versionId: string | undefined;
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/quality/datasets',
        headers: await authHeaders('ML_ENGINEER'),
        payload: { version_tag: `gold-test-${randomUUID().slice(0, 8)}`, notes: 'тестовый релиз' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      versionId = body.id;
      expect(body.label_count).toBeGreaterThanOrEqual(1);
      expect(body.manifest_hash).toMatch(/^[0-9a-f]{64}$/);

      const link = await prisma.datasetVersionLabel.findUnique({
        where: { datasetVersionId_goldLabelId: { datasetVersionId: body.id, goldLabelId: label.id } },
      });
      expect(link).not.toBeNull();

      const listRes = await app.inject({
        method: 'GET', url: '/api/v1/quality/datasets', headers: await authHeaders('SUPERVISOR'),
      });
      expect(listRes.json().versions.some((v: { id: string }) => v.id === body.id)).toBe(true);
      await app.close();
    } finally {
      if (versionId) await cleanupDatasetVersion(versionId);
      await cleanupScenario(object.id);
    }
  });

  it('releasing only the given label ids freezes exactly that subset', async () => {
    const first = await makeGoldLabel('M-DATASET-A');
    const second = await makeGoldLabel('M-DATASET-B');
    let versionId: string | undefined;
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/quality/datasets',
        headers: await authHeaders('ML_ENGINEER'),
        payload: { version_tag: `gold-subset-${randomUUID().slice(0, 8)}`, label_ids: [first.label.id] },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      versionId = body.id;
      expect(body.label_count).toBe(1);

      const links = await prisma.datasetVersionLabel.findMany({ where: { datasetVersionId: body.id } });
      expect(links.map((l) => l.goldLabelId)).toEqual([first.label.id]);
      expect(links.map((l) => l.goldLabelId)).not.toContain(second.label.id);
      await app.close();
    } finally {
      if (versionId) await cleanupDatasetVersion(versionId);
      await cleanupScenario(first.object.id);
      await cleanupScenario(second.object.id);
    }
  });

  it('exports a released version as JSONL', async () => {
    const { object, label } = await makeGoldLabel('M-DATASET-EXPORT');
    let versionId: string | undefined;
    try {
      const app = await buildServer();
      const releaseRes = await app.inject({
        method: 'POST', url: '/api/v1/quality/datasets',
        headers: await authHeaders('ML_ENGINEER'),
        payload: { version_tag: `gold-export-${randomUUID().slice(0, 8)}`, label_ids: [label.id] },
      });
      versionId = releaseRes.json().id;

      const exportRes = await app.inject({
        method: 'GET', url: `/api/v1/quality/datasets/${versionId}/export`,
        headers: await authHeaders('ML_ENGINEER'),
      });
      expect(exportRes.statusCode).toBe(200);
      const lines = exportRes.body.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]);
      expect(row).toMatchObject({ id: label.id, param_code: 'M-DATASET-EXPORT', gold_label: 'POSITIVE' });
      await app.close();
    } finally {
      if (versionId) await cleanupDatasetVersion(versionId);
      await cleanupScenario(object.id);
    }
  });

  it('export is forbidden for a supervisor (curator-only)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/quality/datasets/${randomUUID()}/export`,
      headers: await authHeaders('SUPERVISOR'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
