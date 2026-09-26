import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { publishTask } from '../queue.js';
import { audit } from '../audit.js';

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
      data: { status: 'PARSING' },
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
}
