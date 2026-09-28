import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { UserRole } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { authHeaders } from './helpers/auth.js';

// One real, isolated user per role rather than the shared demo accounts
// authHeaders() hands out - the notification fan-out assertions below need
// to know exactly who got notified, the same reasoning notifications.test.ts's
// own makeUser follows.
async function makeUser(role: UserRole) {
  const user = await prisma.user.create({
    data: { login: `quality-report-test-${randomUUID()}`, fullName: `Test ${role}`, role, passwordHash: 'not-used-by-tests' },
  });
  const app = await buildServer();
  const token = app.jwt.sign({ sub: user.id, login: user.login, role: user.role });
  await app.close();
  return { user, headers: { authorization: `Bearer ${token}` } };
}

async function cleanupReport(id: string) {
  await prisma.qualityReport.delete({ where: { id } });
}

describe('POST /api/v1/quality/reports', () => {
  it('is forbidden for an inspector', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/quality/reports', headers: await authHeaders('INSPECTOR'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('is forbidden for a supervisor (view-only role)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/quality/reports', headers: await authHeaders('SUPERVISOR'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('generates a report with metrics, trend and recommendations, for an ML engineer', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/quality/reports', headers: await authHeaders('ML_ENGINEER'),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    try {
      expect(body).toHaveProperty('period_start');
      expect(body).toHaveProperty('period_end');
      expect(body.payload.metrics.overall).toHaveProperty('precision');
      expect(body.payload.previous_metrics.overall).toHaveProperty('precision');
      expect(body.payload.trend).toHaveProperty('precision');
      expect(Array.isArray(body.payload.recommendations)).toBe(true);
      expect(body.payload.recommendations.length).toBeGreaterThan(0);

      const stored = await prisma.qualityReport.findUniqueOrThrow({ where: { id: body.id } });
      expect(stored.generatedBy).not.toBeNull();
    } finally {
      await cleanupReport(body.id);
      await app.close();
    }
  });

  it('notifies ADMIN and ML_ENGINEER users, but not an inspector', async () => {
    const admin = await makeUser('ADMIN');
    const mlEngineer = await makeUser('ML_ENGINEER');
    const inspector = await makeUser('INSPECTOR');
    const generatedBy = await makeUser('ADMIN');

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/quality/reports', headers: generatedBy.headers,
    });
    const body = res.json();
    try {
      expect(res.statusCode).toBe(201);

      const adminNotif = await prisma.notification.findFirst({
        where: { userId: admin.user.id, kind: 'QUALITY_REPORT_READY' },
      });
      const mlNotif = await prisma.notification.findFirst({
        where: { userId: mlEngineer.user.id, kind: 'QUALITY_REPORT_READY' },
      });
      const inspectorNotif = await prisma.notification.findFirst({
        where: { userId: inspector.user.id, kind: 'QUALITY_REPORT_READY' },
      });
      expect(adminNotif).not.toBeNull();
      expect(mlNotif).not.toBeNull();
      expect(inspectorNotif).toBeNull();
    } finally {
      await cleanupReport(body.id);
      await app.close();
    }
  });
});

describe('GET /api/v1/quality/reports and download', () => {
  it('lists generated reports and downloads them as json/pdf/docx', async () => {
    const app = await buildServer();
    const generateRes = await app.inject({
      method: 'POST', url: '/api/v1/quality/reports', headers: await authHeaders('ADMIN'),
    });
    const reportId = generateRes.json().id;
    try {
      const listRes = await app.inject({
        method: 'GET', url: '/api/v1/quality/reports', headers: await authHeaders('SUPERVISOR'),
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().reports.some((r: { id: string }) => r.id === reportId)).toBe(true);

      const jsonRes = await app.inject({
        method: 'GET', url: `/api/v1/quality/reports/${reportId}/download?format=json`,
        headers: await authHeaders('SUPERVISOR'),
      });
      expect(jsonRes.statusCode).toBe(200);
      expect(jsonRes.json()).toHaveProperty('metrics');

      const pdfRes = await app.inject({
        method: 'GET', url: `/api/v1/quality/reports/${reportId}/download?format=pdf`,
        headers: await authHeaders('SUPERVISOR'),
      });
      expect(pdfRes.statusCode).toBe(200);
      expect(pdfRes.headers['content-type']).toContain('application/pdf');
      expect(pdfRes.rawPayload.length).toBeGreaterThan(0);

      const docxRes = await app.inject({
        method: 'GET', url: `/api/v1/quality/reports/${reportId}/download?format=docx`,
        headers: await authHeaders('SUPERVISOR'),
      });
      expect(docxRes.statusCode).toBe(200);
      expect(docxRes.headers['content-type']).toContain('wordprocessingml');
      expect(docxRes.rawPayload.length).toBeGreaterThan(0);
    } finally {
      await cleanupReport(reportId);
      await app.close();
    }
  });
});
