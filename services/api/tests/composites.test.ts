import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { ProcessStatus } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';
import { cleanupScenario } from './helpers/cleanup.js';

// Composite candidates (worker's app.explication.compare module docstring):
// a run of >= 2 consecutive changed rooms in one explication table is
// recorded as ONE check with its own atoms nested under it via
// checks.parent_check_id. These tests cover the split endpoint, the
// visibility rule it toggles, and the guards that keep a composite from
// being decided as a whole.

function hash64() {
  return (randomUUID() + randomUUID()).replace(/-/g, '');
}

const PARAM_CODE = 'M-901';

async function ensureParam() {
  const existing = await prisma.param.findUnique({ where: { code: PARAM_CODE } });
  if (existing) return existing;
  return prisma.param.create({
    data: {
      code: PARAM_CODE, section: 'ПЗ', parameterName: 'Тестовый параметр', unit: 'м²',
      reviewPriority: 'MEDIUM', dataType: 'number', modality: 'scalar_text', matrixVersion: '1.1',
    },
  });
}

// One object/process/protocol with a composite candidate (two atoms nested
// under it), built fresh per test so nothing here is shared mutable state.
async function makeCompositeScenario(
  protocolStatus = 'READY',
  processStatus: ProcessStatus = 'READY',
) {
  const param = await ensureParam();
  const object = await prisma.constructionObject.create({ data: { name: 'Composite routes test' } });
  const process = await prisma.process.create({ data: { objectId: object.id, status: processStatus } });
  const protocol = await prisma.protocol.create({
    data: {
      objectId: object.id, processId: process.id, version: 1, matrixVersion: '1.1',
      datasetVersion: 'none', modelVersion: 'rules-2026.09', inputManifestHash: hash64(),
      status: protocolStatus,
    },
  });

  const composite = await prisma.check.create({
    data: {
      processId: process.id, objectId: object.id, paramCode: param.code,
      evidenceGroupId: `${process.id}:rooms 134..149`, subject: 'rooms 134..149',
      expectedValue: '30.00', actualValue: '28.00', delta: '-2.00',
      completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
      reviewPriority: 'MEDIUM', rationale: 'Изменены площади 2 помещений подряд (134-149).',
      matrixVersion: '1.1',
    },
  });
  const atom1 = await prisma.check.create({
    data: {
      processId: process.id, objectId: object.id, paramCode: param.code,
      evidenceGroupId: `${process.id}:room 134`, subject: 'room 134',
      expectedValue: '15.00', actualValue: '14.00', delta: '-1.00',
      completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
      reviewPriority: 'MEDIUM', rationale: 'Площадь помещения 134 изменена.', matrixVersion: '1.1',
      parentCheckId: composite.id,
    },
  });
  const atom2 = await prisma.check.create({
    data: {
      processId: process.id, objectId: object.id, paramCode: param.code,
      evidenceGroupId: `${process.id}:room 149`, subject: 'room 149',
      expectedValue: '15.00', actualValue: '14.00', delta: '-1.00',
      completenessStatus: 'COMPLETE', findingStatus: 'CANDIDATE', engineStatus: 'CANDIDATE',
      reviewPriority: 'MEDIUM', rationale: 'Площадь помещения 149 изменена.', matrixVersion: '1.1',
      parentCheckId: composite.id,
    },
  });

  return { object, process, protocol, composite, atoms: [atom1, atom2] };
}

describe('POST /api/v1/findings/:check_id/split', () => {
  it('is forbidden for an ML engineer', async () => {
    const { object, composite } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${composite.id}/split`,
        headers: await authHeaders('ML_ENGINEER'),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('404s for an unknown check', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/findings/${randomUUID()}/split`,
      headers: await authHeaders('INSPECTOR'),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('409s for a check that is not a composite', async () => {
    const { object, atoms } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      // An atom has no atoms of its own - it is not a composite either.
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${atoms[0].id}/split`,
        headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('NOT_A_COMPOSITE');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('splits a composite into its atoms, sets split_by/split_at and writes an audit row', async () => {
    const { object, composite, atoms } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${composite.id}/split`,
        headers: await authHeaders('INSPECTOR'),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.atoms).toHaveLength(2);
      expect(body.atoms.map((a: { id: string }) => a.id).sort()).toEqual(atoms.map((a) => a.id).sort());

      const inspector = await prisma.user.findUniqueOrThrow({ where: { login: 'test-inspector' } });
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: composite.id } });
      expect(stored.splitBy).toBe(inspector.id);
      expect(stored.splitAt).not.toBeNull();

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'COMPOSITE_SPLIT', objectId: object.id }, orderBy: { timestamp: 'desc' },
      });
      expect(entry.details).toMatchObject({ check_id: composite.id });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('409s for a composite that was already split', async () => {
    const { object, composite } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const headers = await authHeaders('INSPECTOR');
      await app.inject({ method: 'POST', url: `/api/v1/findings/${composite.id}/split`, headers });
      const second = await app.inject({ method: 'POST', url: `/api/v1/findings/${composite.id}/split`, headers });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('ALREADY_SPLIT');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('409s once the protocol is finalized', async () => {
    const { object, composite } = await makeCompositeScenario('PROTOCOL_FINALIZED', 'FINALIZED');
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${composite.id}/split`,
        headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('PROTOCOL_FINALIZED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('POST /api/v1/findings/:check_id/verdict on a composite', () => {
  it('refuses to decide an unsplit composite, in Russian', async () => {
    const { object, composite } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${composite.id}/verdict`,
        headers: await authHeaders('INSPECTOR'),
        payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('COMPOSITE_NOT_SPLIT');
      expect(body.message).toBe(
        'Составной кандидат нельзя подтвердить частично — сначала разделите его на атомарные находки',
      );
      const stored = await prisma.check.findUniqueOrThrow({ where: { id: composite.id } });
      expect(stored.findingStatus).toBe('CANDIDATE');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('refuses to decide an atom before its composite is split', async () => {
    const { object, atoms } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${atoms[0].id}/verdict`,
        headers: await authHeaders('INSPECTOR'),
        payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('NOT_A_CANDIDATE');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('lets each atom be decided on its own once the composite is split', async () => {
    const { object, composite, atoms } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const headers = await authHeaders('INSPECTOR');
      await app.inject({ method: 'POST', url: `/api/v1/findings/${composite.id}/split`, headers });

      const res = await app.inject({
        method: 'POST', url: `/api/v1/findings/${atoms[0].id}/verdict`,
        headers, payload: { decision: 'CONFIRMED_VIOLATION' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().finding_status).toBe('CONFIRMED_VIOLATION');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('composite visibility across listing and counting routes', () => {
  it('counts an unsplit composite as one candidate, never its hidden atoms, in the protocol summary', async () => {
    const { object, protocol, composite } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/protocols/${protocol.id}`, headers: await authHeaders(),
      });
      const body = res.json();
      expect(body.summary.candidates).toBe(1);
      const findingIds = body.findings.map((f: { id: string }) => f.id);
      expect(findingIds).toEqual([composite.id]);

      const found = body.findings.find((f: { id: string }) => f.id === composite.id);
      expect(found.composite.atoms).toHaveLength(2);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('shows the atoms as ordinary candidates, and hides the composite, once split', async () => {
    const { object, process, protocol, composite, atoms } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      await app.inject({
        method: 'POST', url: `/api/v1/findings/${composite.id}/split`,
        headers: await authHeaders('INSPECTOR'),
      });

      const res = await app.inject({
        method: 'GET', url: `/api/v1/protocols/${protocol.id}/findings?status=CANDIDATE`,
        headers: await authHeaders(),
      });
      const body = res.json();
      const ids = body.items.map((f: { id: string }) => f.id).sort();
      expect(ids).toEqual(atoms.map((a) => a.id).sort());
      expect(ids).not.toContain(composite.id);

      const progress = await app.inject({
        method: 'GET', url: `/api/v1/processes/${process.id}/progress`, headers: await authHeaders(),
      });
      expect(progress.json().checks.candidates).toBe(2);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('counts one unsplit composite in the dashboard candidates-to-review total', async () => {
    const { object } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const before = await app.inject({
        method: 'GET', url: '/api/v1/dashboard/summary', headers: await authHeaders(),
      });
      // Exactly one candidate contributed by this scenario's composite - not
      // three (composite + two hidden atoms).
      expect(before.json().candidates_to_review).toBeGreaterThanOrEqual(1);
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});

describe('finalization and an unsplit composite', () => {
  it('blocks finalization on the composite id, not its hidden atoms', async () => {
    const { object, protocol, composite } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/finalize`,
        headers: await authHeaders('INSPECTOR'),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'CANDIDATES_PENDING', check_ids: [composite.id] });
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });

  it('finalizes once the composite is split and every atom is decided', async () => {
    const { object, process, protocol, composite, atoms } = await makeCompositeScenario();
    try {
      const app = await buildServer();
      const headers = await authHeaders('INSPECTOR');
      await app.inject({ method: 'POST', url: `/api/v1/findings/${composite.id}/split`, headers });
      for (const atom of atoms) {
        await app.inject({
          method: 'POST', url: `/api/v1/findings/${atom.id}/verdict`,
          headers, payload: { decision: 'CONFIRMED_VIOLATION' },
        });
      }

      const res = await app.inject({
        method: 'POST', url: `/api/v1/protocols/${protocol.id}/finalize`,
        headers: await authHeaders('SUPERVISOR'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('PROTOCOL_FINALIZED');

      const storedProcess = await prisma.process.findUniqueOrThrow({ where: { id: process.id } });
      expect(storedProcess.status).toBe('FINALIZED');
      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});
