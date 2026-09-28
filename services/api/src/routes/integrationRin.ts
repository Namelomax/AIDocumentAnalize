// Section 9.6: manual controls over the outbound transfer to ИАИС «РиН»
// (GET/POST /protocols/:id/sync), and the inbound direction - ИАИС «РиН»
// telling this system new documents arrived for an object
// (POST /integration/rin/documents). Kept out of routes/protocols.ts and
// routes/processDocuments.ts: this file is the one place that imports the
// integration modules, so nothing else needs to know they exist.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRole } from '../auth/plugin.js';
import { publishTask } from '../queue.js';
import { validateFileList, type PendingFile } from '../documents/validate.js';
import { ingestFiles } from '../documents/ingest.js';
import { enqueueTransfer } from '../integration/transfers.js';
import { notifyProcessOwner } from '../notify.js';

const protocolParamsSchema = z.object({ protocol_id: z.string().uuid() });

function transferView(transfer: {
  id: string; attempt: number; status: string; nextAttemptAt: Date | null;
  lastError: string | null; responseCode: number | null; payloadHash: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: transfer.id,
    attempt: transfer.attempt,
    status: transfer.status,
    next_attempt_at: transfer.nextAttemptAt,
    last_error: transfer.lastError,
    response_code: transfer.responseCode,
    payload_hash: transfer.payloadHash,
    created_at: transfer.createdAt,
    updated_at: transfer.updatedAt,
  };
}

const inboundFileSchema = z.object({
  file_name: z.string().min(1),
  mime_type: z.string().min(1),
  // Base64 (customer's ТЗ 9.6: "files[] as base64 or URLs - base64, simpler
  // offline") rather than a URL this system would have to fetch back out
  // from ИАИС «РиН» itself, which the offline stand cannot reach anyway.
  content_base64: z.string().min(1),
});

const inboundBodySchema = z.object({
  process_id: z.string().uuid().optional(),
  object_id: z.string().uuid().optional(),
  files: z.array(inboundFileSchema).min(1),
}).refine((body) => Boolean(body.process_id || body.object_id), {
  message: 'process_id or object_id is required',
});

export async function integrationRinRoutes(app: FastifyInstance) {
  app.get('/api/v1/protocols/:protocol_id/sync', async (request, reply) => {
    const parsed = protocolParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const protocol = await prisma.protocol.findUnique({ where: { id: parsed.data.protocol_id } });
    if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

    const transfers = await prisma.integrationTransfer.findMany({
      where: { protocolId: protocol.id },
      orderBy: { createdAt: 'desc' },
    });

    return { protocol_id: protocol.id, sync_status: protocol.syncStatus, transfers: transfers.map(transferView) };
  });

  // Section 9.6's manual control: re-queue a transfer that gave up after its
  // retry budget. Only a supervisor or an administrator may force it, the
  // same authority section 9.3 requires to unfinalize a protocol.
  app.post(
    '/api/v1/protocols/:protocol_id/sync',
    { preHandler: requireRole('SUPERVISOR', 'ADMIN') },
    async (request, reply) => {
      const parsed = protocolParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const protocol = await prisma.protocol.findUnique({ where: { id: parsed.data.protocol_id } });
      if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

      if (protocol.status !== 'PROTOCOL_FINALIZED') {
        return reply.code(409).send({
          error: 'NOT_FINALIZED',
          message: 'Повторная передача возможна только для финализированного протокола',
        });
      }

      const latestTransfer = await prisma.integrationTransfer.findFirst({
        where: { protocolId: protocol.id },
        orderBy: { createdAt: 'desc' },
      });
      if (!latestTransfer || latestTransfer.status !== 'FAILED') {
        return reply.code(409).send({
          error: 'NOT_FAILED',
          message: 'Повторная передача доступна только при ошибке передачи',
        });
      }

      const transferId = await prisma.$transaction(async (tx) => {
        const id = await enqueueTransfer(protocol.id, tx);
        await tx.protocol.update({ where: { id: protocol.id }, data: { syncStatus: 'PENDING_SYNC' } });
        return id;
      });

      await audit(request, 'RIN_TRANSFER_REQUEUED', protocol.objectId, {
        protocol_id: protocol.id, transfer_id: transferId,
      });

      return { protocol_id: protocol.id, sync_status: 'PENDING_SYNC', transfer_id: transferId };
    },
  );

  // Section 9.6's inbound direction: ИАИС «РиН» announcing new documents for
  // an object/process. Authenticated with a service token (X-RIN-Token)
  // rather than a user's JWT - this caller is another system, not an
  // inspector - so the route is listed in auth/plugin.ts's PUBLIC set and
  // does its own check here instead.
  app.post('/api/v1/integration/rin/documents', async (request, reply) => {
    const token = request.headers['x-rin-token'];
    if (!config.rin.inboundToken || token !== config.rin.inboundToken) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }

    const parsed = inboundBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const body = parsed.data;

    const process = body.process_id
      ? await prisma.process.findUnique({ where: { id: body.process_id } })
      : await prisma.process.findFirst({ where: { objectId: body.object_id }, orderBy: { createdAt: 'desc' } });
    if (!process) return reply.code(404).send({ error: 'PROCESS_NOT_FOUND' });

    const latestProtocol = await prisma.protocol.findFirst({
      where: { processId: process.id, status: { not: 'SUPERSEDED' } },
      orderBy: { version: 'desc' },
    });

    // Section 9.6 "Блокировка автоматической дозагрузки при финализированном
    // протоколе": an automatic дозагрузка never starts a check by itself -
    // only a notification, with a new check left to the inspector to start.
    if (latestProtocol?.status === 'PROTOCOL_FINALIZED' || process.status === 'FINALIZED') {
      const object = await prisma.constructionObject.findUnique({ where: { id: process.objectId } });
      await notifyProcessOwner(
        process,
        'RIN_NEW_DOCUMENTS',
        'Новые документы из ИАИС «РиН»',
        `Из ИАИС «РиН» поступили новые документы по объекту «${object?.name ?? process.objectId}»; `
          + 'протокол финализирован — создайте новую проверку.',
      );
      await prisma.auditLog.create({
        data: {
          userId: null, action: 'RIN_DOCUMENTS_NOTIFIED_ONLY', objectId: process.objectId,
          details: { process_id: process.id, files: body.files.length },
        },
      });
      return reply.code(202).send({ process_id: process.id, status: 'NOTIFIED_ONLY' });
    }

    const decoded = body.files.map((f) => ({
      fileName: f.file_name, mimeType: f.mime_type, body: Buffer.from(f.content_base64, 'base64'),
    }));
    const { pending, rejected, packageBytes } = validateFileList(decoded);

    if (packageBytes > config.maxPackageBytes) {
      return reply.code(413).send({
        error: 'PACKAGE_TOO_LARGE',
        limit_bytes: config.maxPackageBytes, received_bytes: packageBytes, max_bytes: config.maxPackageBytes,
      });
    }

    const { accepted, rejected: rejectedAll } = await ingestFiles(
      process, pending as PendingFile[], rejected, request.log,
    );

    if (accepted.length === 0) {
      await prisma.auditLog.create({
        data: {
          userId: null, action: 'RIN_DOCUMENTS_REJECTED', objectId: process.objectId,
          details: { process_id: process.id, rejected: rejectedAll.length },
        },
      });
      return reply.code(422).send({ process_id: process.id, status: 'REJECTED', accepted: [], rejected: rejectedAll });
    }

    // Same rule as a human дозагрузка (routes/processDocuments.ts): a
    // process that never started has nothing to react to yet.
    if (process.status !== 'PENDING') {
      await prisma.process.update({ where: { id: process.id }, data: { status: 'PARSING' } });
      try {
        await publishTask({
          type: 'process.update', process_id: process.id, object_id: process.objectId,
          file_ids: accepted.map((a) => a.file_id),
        });
      } catch (err) {
        request.log.error({ process_id: process.id, err }, 'failed to publish update task for ИАИС «РиН» дозагрузка');
        await prisma.process.update({ where: { id: process.id }, data: { status: process.status } });
        return reply.code(503).send({ error: 'QUEUE_UNAVAILABLE' });
      }
    }

    await prisma.auditLog.create({
      data: {
        userId: null, action: 'RIN_DOCUMENTS_INGESTED', objectId: process.objectId,
        details: { process_id: process.id, accepted: accepted.length, rejected: rejectedAll.length },
      },
    });

    return reply.code(202).send({ process_id: process.id, status: 'STORED', accepted, rejected: rejectedAll });
  });
}

