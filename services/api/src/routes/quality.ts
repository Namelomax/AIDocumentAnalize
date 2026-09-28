// Section 9.4/14 of the customer's ТЗ: dataset curation, acceptance metrics
// and the weekly quality report. Visible (GET) to ADMIN, ML_ENGINEER and
// SUPERVISOR alike - the "Качество" screen's own audience - but every
// write (releasing a dataset version, generating an on-demand report) is
// ADMIN/ML_ENGINEER only: the ТЗ's own "куратор данных" and the role
// section 12 gives access to retraining data and logs.
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireRole } from '../auth/plugin.js';
import { audit } from '../audit.js';
import { computeQualityMetrics } from '../quality/metrics.js';
import { releaseDatasetVersion, listDatasetVersions, getDatasetVersion, exportDatasetVersionLines } from '../quality/datasets.js';
import { generateWeeklyReport, listQualityReports, getQualityReport, type QualityReportView } from '../quality/reports.js';
import { renderQualityReportPdf, renderQualityReportDocx, qualityReportFilename } from '../export/qualityReport.js';

const metricsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  param: z.string().optional(),
  modality: z.string().optional(),
  model_version: z.string().optional(),
});

const releaseBodySchema = z.object({
  version_tag: z.string().trim().min(1).max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
  label_ids: z.array(z.string().uuid()).optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const downloadQuerySchema = z.object({ format: z.enum(['pdf', 'docx', 'json']) });

const reportContentTypes: Record<'pdf' | 'docx' | 'json', string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  json: 'application/json; charset=utf-8',
};

export async function qualityRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/quality/metrics',
    { preHandler: requireRole('ADMIN', 'ML_ENGINEER', 'SUPERVISOR') },
    async (request, reply) => {
      const parsed = metricsQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
      const q = parsed.data;
      return computeQualityMetrics({
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        paramCode: q.param,
        modality: q.modality,
        modelVersion: q.model_version,
      });
    },
  );

  app.post(
    '/api/v1/quality/datasets',
    { preHandler: requireRole('ADMIN', 'ML_ENGINEER') },
    async (request, reply) => {
      const parsed = releaseBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      try {
        const version = await releaseDatasetVersion(request.user.id, {
          versionTag: parsed.data.version_tag,
          notes: parsed.data.notes,
          labelIds: parsed.data.label_ids,
        });
        await audit(request, 'DATASET_VERSION_RELEASED', null, {
          dataset_version_id: version.id, version_tag: version.version_tag, label_count: version.label_count,
        });
        return reply.code(201).send(version);
      } catch (err) {
        // P2002: the version_tag unique constraint (dataset_versions) - an
        // explicit tag the caller chose already exists.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return reply.code(409).send({ error: 'VERSION_TAG_EXISTS' });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/quality/datasets',
    { preHandler: requireRole('ADMIN', 'ML_ENGINEER', 'SUPERVISOR') },
    async () => ({ versions: await listDatasetVersions() }),
  );

  app.get(
    '/api/v1/quality/datasets/:id/export',
    { preHandler: requireRole('ADMIN', 'ML_ENGINEER') },
    async (request, reply) => {
      const parsed = idParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const version = await getDatasetVersion(parsed.data.id);
      if (!version) return reply.code(404).send({ error: 'DATASET_VERSION_NOT_FOUND' });

      reply.header('Content-Disposition', `attachment; filename="${version.version_tag}.jsonl"`);
      reply.type('application/x-ndjson');

      await audit(request, 'DATASET_VERSION_EXPORTED', null, { dataset_version_id: version.id });

      let body = '';
      for await (const line of exportDatasetVersionLines(version.id)) body += line;
      return reply.send(body);
    },
  );

  app.post(
    '/api/v1/quality/reports',
    { preHandler: requireRole('ADMIN', 'ML_ENGINEER') },
    async (request, reply) => {
      const report = await generateWeeklyReport(request.user.id);
      await audit(request, 'QUALITY_REPORT_GENERATED', null, { report_id: report.id });
      return reply.code(201).send(report);
    },
  );

  app.get(
    '/api/v1/quality/reports',
    { preHandler: requireRole('ADMIN', 'ML_ENGINEER', 'SUPERVISOR') },
    async () => ({ reports: await listQualityReports() }),
  );

  app.get(
    '/api/v1/quality/reports/:id/download',
    { preHandler: requireRole('ADMIN', 'ML_ENGINEER', 'SUPERVISOR') },
    async (request, reply) => {
      const paramsParsed = idParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
      const queryParsed = downloadQuerySchema.safeParse(request.query);
      if (!queryParsed.success) return reply.code(400).send({ error: 'UNKNOWN_FORMAT' });

      const report = await getQualityReport(paramsParsed.data.id);
      if (!report) return reply.code(404).send({ error: 'REPORT_NOT_FOUND' });

      const format = queryParsed.data.format;
      const filename = qualityReportFilename(report, format);
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.type(reportContentTypes[format]);

      await audit(request, 'QUALITY_REPORT_DOWNLOADED', null, { report_id: report.id, format });

      if (format === 'json') return reply.send(reportJson(report));
      if (format === 'pdf') return reply.send(await renderQualityReportPdf(report));
      return reply.send(await renderQualityReportDocx(report));
    },
  );
}

function reportJson(report: QualityReportView) {
  return {
    id: report.id,
    period_start: report.period_start,
    period_end: report.period_end,
    generated_by: report.generated_by,
    created_at: report.created_at,
    ...report.payload,
  };
}
