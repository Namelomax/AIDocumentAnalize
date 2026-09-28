import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { publishTask } from '../queue.js';
import { audit } from '../audit.js';
import { visibleCheckWhere } from '../checks/visibility.js';

const paramsSchema = z.object({ process_id: z.string().uuid() });

export async function processRoutes(app: FastifyInstance) {
  app.get('/api/v1/processes/:process_id', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const process = await prisma.process.findUnique({
      where: { id: parsed.data.process_id },
      include: { _count: { select: { files: true } } },
    });
    if (!process) return reply.code(404).send({ error: 'PROCESS_NOT_FOUND' });

    return {
      process_id: process.id,
      object_id: process.objectId,
      status: process.status,
      scenario: process.scenario,
      files_count: process._count.files,
      updated_at: process.updatedAt,
      // Set only when status is FAILED (customer's ТЗ p.17) - the short
      // reason the worker recorded once its own retries were exhausted.
      error_message: process.errorMessage,
    };
  });

  app.post('/api/v1/processes/:process_id/start', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const process = await prisma.process.findUnique({
      where: { id: parsed.data.process_id },
      include: { _count: { select: { files: true } } },
    });
    if (!process) return reply.code(404).send({ error: 'PROCESS_NOT_FOUND' });

    // Checking a package with no documents would produce a protocol about
    // files that were never uploaded.
    if (process._count.files === 0) {
      return reply.code(409).send({ error: 'NO_FILES_UPLOADED' });
    }

    // Publishing twice would run the whole pipeline twice over one package.
    if (process.status !== 'PENDING') {
      return reply.code(409).send({ error: 'ALREADY_STARTED', status: process.status });
    }

    await prisma.process.update({
      where: { id: process.id },
      // Recorded so the worker knows who to notify once the protocol
      // reaches READY (customer's ТЗ p.19) - request.user is always set
      // here, since every route but health/login requires a token.
      data: { status: 'PARSING', startedBy: request.user.id },
    });

    // The status flip above and the publish below aren't one transaction:
    // if the broker is unreachable, undo the flip so the process stays
    // resumable from PENDING instead of stuck in PARSING with no task
    // ever queued for it.
    try {
      await publishTask({
        type: 'process.start',
        process_id: process.id,
        object_id: process.objectId,
      });
    } catch (err) {
      request.log.error({ process_id: process.id, err }, 'failed to publish start task');
      await prisma.process.update({
        where: { id: process.id },
        data: { status: 'PENDING' },
      });
      return reply.code(503).send({ error: 'QUEUE_UNAVAILABLE' });
    }

    await audit(request, 'PROCESS_STARTED', process.objectId, { process_id: process.id });

    return reply.code(202).send({ process_id: process.id, status: 'PARSING' });
  });

  // The processing screen's four stages (Plan 7): "recognition" reads
  // against pages extracted vs. PDFs uploaded, "value extraction" against
  // the checks produced, "matching" against the process's own status. The
  // fourth stage, drawing analysis, has no GPU stand behind it yet, so this
  // endpoint reports only the honest numbers above - which stage each one
  // feeds is the interface's job, not this route's.
  app.get('/api/v1/processes/:process_id/progress', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const process = await prisma.process.findUnique({ where: { id: parsed.data.process_id } });
    if (!process) return reply.code(404).send({ error: 'PROCESS_NOT_FOUND' });

    const [
      filesTotal, filesPdf, pagesExtracted, pagesNeedsOcr, pagesLowQuality,
      checksTotal, checksCandidates, protocol,
    ] = await Promise.all([
      prisma.fileRecord.count({ where: { processId: process.id } }),
      prisma.fileRecord.count({ where: { processId: process.id, mimeType: 'application/pdf' } }),
      prisma.page.count({ where: { file: { processId: process.id } } }),
      prisma.page.count({ where: { file: { processId: process.id }, needsOcr: true } }),
      // Customer's ТЗ p.16 п.1: a page OCR could not read at all (model
      // unavailable, or nothing legible came back - services/worker's
      // app.ocr.tiling) counted on its own, not folded into needs_ocr -
      // most needs_ocr pages do get read, this is the ones that did not.
      prisma.page.count({ where: { file: { processId: process.id }, qualityStatus: 'LOW_QUALITY' } }),
      prisma.check.count({ where: { processId: process.id, ...visibleCheckWhere } }),
      prisma.check.count({ where: { processId: process.id, findingStatus: 'CANDIDATE', ...visibleCheckWhere } }),
      prisma.protocol.findFirst({
        where: { processId: process.id },
        orderBy: { version: 'desc' },
        select: { id: true },
      }),
    ]);

    return {
      status: process.status,
      files: { total: filesTotal, pdf: filesPdf },
      pages: { extracted: pagesExtracted, needs_ocr: pagesNeedsOcr, low_quality: pagesLowQuality },
      checks: { total: checksTotal, candidates: checksCandidates },
      protocol_id: protocol?.id ?? null,
    };
  });
}
