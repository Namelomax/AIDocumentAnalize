import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';
import { cleanupScenario } from './helpers/cleanup.js';

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

interface LabelSpec {
  label: 'POSITIVE' | 'NEGATIVE';
  engineStatus: string | null;
  modality: string;
}

// Builds one finalized-looking protocol with one real Check per label (the
// FK gold_labels.check_id needs one to exist) and inserts the GoldLabel rows
// directly - metrics arithmetic only ever reads gold_labels columns, so
// going through POST .../finalize for every row here would only slow the
// test down for no extra coverage (that path is quality-labels.test.ts's own).
async function makeGoldLabels(paramCode: string, specs: LabelSpec[]) {
  const object = await prisma.constructionObject.create({ data: { name: 'Quality metrics test' } });
  const process = await prisma.process.create({ data: { objectId: object.id, status: 'FINALIZED' } });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: 'PROTOCOL_FINALIZED',
    },
  });

  for (const [i, spec] of specs.entries()) {
    const check = await prisma.check.create({
      data: {
        processId: process.id, objectId: object.id, paramCode,
        evidenceGroupId: `${process.id}:c${i}`, completenessStatus: 'COMPLETE',
        findingStatus: spec.label === 'POSITIVE' ? 'CONFIRMED_VIOLATION' : 'NEGATIVE_VERIFIED',
        engineStatus: spec.engineStatus, reviewPriority: 'MEDIUM', matrixVersion: '1.1',
        // confirmed_requires_inspector (schema.prisma migration): a
        // CONFIRMED_VIOLATION row needs verified_by set, same as a real
        // inspector decision would leave behind.
        verifiedBy: spec.label === 'POSITIVE' ? 'fixture' : null,
      },
    });
    await prisma.goldLabel.create({
      data: {
        checkId: check.id, protocolId: protocol.id, objectId: object.id, processId: process.id,
        evidenceGroupId: check.evidenceGroupId, paramCode, modality: spec.modality,
        label: spec.label, engineStatus: spec.engineStatus,
        finalStatus: spec.label === 'POSITIVE' ? 'CONFIRMED_VIOLATION' : 'NEGATIVE_VERIFIED',
        matrixVersion: '1.1', modelVersion: 'rules-2026.09', evidence: [],
      },
    });
  }
  return { object };
}

describe('GET /api/v1/quality/metrics', () => {
  it('is forbidden for an inspector', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/quality/metrics',
      headers: await authHeaders('INSPECTOR'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('is visible to a supervisor', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/quality/metrics',
      headers: await authHeaders('SUPERVISOR'),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('computes TP/FP/FN/TN and precision/recall/F1/FPR with section 14.3 pass/fail', async () => {
    const paramCode = `TST-${randomUUID().slice(0, 8)}`;
    // 3 TP, 1 FP, 1 FN, 5 TN -> precision 0.75, recall 0.75, f1 0.75, fpr 1/6.
    const specs: LabelSpec[] = [
      { label: 'POSITIVE', engineStatus: 'CANDIDATE', modality: 'scalar_text' },
      { label: 'POSITIVE', engineStatus: 'CANDIDATE', modality: 'scalar_text' },
      { label: 'POSITIVE', engineStatus: 'CANDIDATE', modality: 'scalar_text' },
      { label: 'NEGATIVE', engineStatus: 'CANDIDATE', modality: 'scalar_text' },
      { label: 'POSITIVE', engineStatus: 'SUSPICION', modality: 'scalar_text' },
      { label: 'NEGATIVE', engineStatus: 'NEGATIVE_VERIFIED', modality: 'scalar_text' },
      { label: 'NEGATIVE', engineStatus: 'NEGATIVE_VERIFIED', modality: 'scalar_text' },
      { label: 'NEGATIVE', engineStatus: 'NEGATIVE_VERIFIED', modality: 'scalar_text' },
      { label: 'NEGATIVE', engineStatus: 'NEGATIVE_VERIFIED', modality: 'scalar_text' },
      { label: 'NEGATIVE', engineStatus: 'NEGATIVE_VERIFIED', modality: 'scalar_text' },
    ];
    const { object } = await makeGoldLabels(paramCode, specs);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/quality/metrics?param=${paramCode}`,
        headers: await authHeaders('ADMIN'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.overall.counts).toEqual({ tp: 3, fp: 1, fn: 1, tn: 5 });
      expect(body.overall.precision.point).toBeCloseTo(0.75, 5);
      expect(body.overall.recall.point).toBeCloseTo(0.75, 5);
      expect(body.overall.f1).toBeCloseTo(0.75, 5);
      expect(body.overall.false_positive_rate.point).toBeCloseTo(1 / 6, 5);
      expect(body.sample_size).toBe(10);

      // Section 14.3 thresholds: precision >= 0.90, recall >= 0.80, f1 >= 0.85,
      // fpr <= 0.10 - every one of these fails on this fixture on purpose.
      expect(body.overall.pass).toEqual({
        precision: false, recall: false, f1: false, false_positive_rate: false, overall: false,
      });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('breaks results down by modality', async () => {
    const paramCode = `TST-M${randomUUID().slice(0, 6)}`;
    const specs: LabelSpec[] = [
      { label: 'POSITIVE', engineStatus: 'CANDIDATE', modality: 'scalar_text' },
      { label: 'NEGATIVE', engineStatus: 'NEGATIVE_VERIFIED', modality: 'scalar_text' },
      { label: 'POSITIVE', engineStatus: 'CANDIDATE', modality: 'drawing_measure' },
      { label: 'NEGATIVE', engineStatus: 'CANDIDATE', modality: 'drawing_measure' },
    ];
    const { object } = await makeGoldLabels(paramCode, specs);
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/quality/metrics?param=${paramCode}`,
        headers: await authHeaders('ADMIN'),
      });
      const body = res.json();
      const scalarText = body.by_modality.find((g: { modality: string }) => g.modality === 'scalar_text');
      const drawingMeasure = body.by_modality.find((g: { modality: string }) => g.modality === 'drawing_measure');
      expect(scalarText.counts).toEqual({ tp: 1, fp: 0, fn: 0, tn: 1 });
      expect(drawingMeasure.counts).toEqual({ tp: 1, fp: 1, fn: 0, tn: 0 });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('breaks rejections down by reason code', async () => {
    const paramCode = `TST-R${randomUUID().slice(0, 6)}`;
    const { object } = await makeGoldLabels(paramCode, [
      { label: 'NEGATIVE', engineStatus: 'CANDIDATE', modality: 'scalar_text' },
    ]);
    try {
      await prisma.goldLabel.updateMany({ where: { paramCode }, data: { reasonCode: 'OCR_ERROR' } });
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/quality/metrics?param=${paramCode}`,
        headers: await authHeaders('ADMIN'),
      });
      const body = res.json();
      expect(body.rejection_reasons).toEqual([{ reason_code: 'OCR_ERROR', count: 1 }]);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});
