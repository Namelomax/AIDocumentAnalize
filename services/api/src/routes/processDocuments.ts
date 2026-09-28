// Customer's ТЗ "Дозагрузка файлов": incremental upload into an existing
// process, without re-running the whole check. Phase-1 validation is the
// exact same rules POST /documents/upload enforces (documents/validate.ts);
// this route only differs in phase 2 - it stores into an existing process
// instead of creating a new one, and drives the worker's incremental
// process.update task instead of process.start.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { sha256, storageKeyFor, putObject } from '../storage.js';
import { audit } from '../audit.js';
import { publishTask } from '../queue.js';
import { requireRole } from '../auth/plugin.js';
import { megabytes, rejection, validatePackage, type PendingFile } from '../documents/validate.js';

const paramsSchema = z.object({ process_id: z.string().uuid() });

// Table in section "Дозагрузка файлов": allowed while PENDING/READY/
// VERIFYING/COMPLETED, and while FAILED (the upload may be exactly what
// fixes a failed run) - refused only while PARSING (something is already
// running) or once the protocol has been finalized.
const PARSING_MESSAGE = 'Идёт обработка пакета — дозагрузка станет доступна после её завершения';
const FINALIZED_MESSAGE = 'Протокол финализирован — дозагрузка невозможна. Создайте новую проверку';

export async function processDocumentRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/processes/:process_id/documents',
    { preHandler: requireRole('INSPECTOR', 'SUPERVISOR', 'ADMIN') },
    async (request, reply) => {
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const process = await prisma.process.findUnique({ where: { id: parsed.data.process_id } });
      if (!process) return reply.code(404).send({ error: 'PROCESS_NOT_FOUND' });

      if (process.status === 'PARSING') {
        return reply.code(409).send({ error: 'PROCESS_PARSING', message: PARSING_MESSAGE });
      }

      // The process's own status tracks its protocol's (routes/verdicts.ts),
      // but the protocol is the authoritative record of finalization - it is
      // what a дозагрузка after an unfinalize needs to see has changed back.
      const latestProtocol = await prisma.protocol.findFirst({
        where: { processId: process.id },
        orderBy: { version: 'desc' },
      });
      if (latestProtocol?.status === 'PROTOCOL_FINALIZED' || process.status === 'FINALIZED') {
        return reply.code(409).send({ error: 'PROTOCOL_FINALIZED', message: FINALIZED_MESSAGE });
      }

      const { pending, rejected, packageBytes } = await validatePackage(request);

      if (packageBytes > config.maxPackageBytes) {
        return reply.code(413).send({
          error: 'PACKAGE_TOO_LARGE',
          limit_bytes: config.maxPackageBytes,
          received_bytes: packageBytes,
          max_bytes: config.maxPackageBytes,
          message: `Пакет больше допустимого объёма ${megabytes(config.maxPackageBytes)}`,
        });
      }

      const accepted: Array<{ file_id: string; file_name: string; sha256: string }> = [];

      for (const file of pending as PendingFile[]) {
        const hash = sha256(file.body);
        const key = storageKeyFor(hash);
        try {
          await putObject(key, file.body, file.mimeType);
          const record = await prisma.fileRecord.create({
            data: {
              objectId: process.objectId,
              processId: process.id,
              fileName: file.fileName,
              fileHash: hash,
              storageKey: key,
              sizeBytes: file.body.length,
              mimeType: file.mimeType,
            },
          });
          if (file.isManifest) {
            try {
              await prisma.process.update({
                where: { id: process.id },
                data: { manifestUploaded: true, inputManifestHash: hash },
              });
            } catch (error) {
              request.log.error({ file_name: file.fileName, err: error }, 'failed to flag manifest on process');
            }
          }
          accepted.push({ file_id: record.id, file_name: record.fileName, sha256: hash });
        } catch (error) {
          // Same unique key as a fresh upload (objectId, fileHash): a file
          // already stored anywhere for this object - in this process or an
          // earlier one - is a duplicate, not new evidence to add.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            rejected.push(rejection(file.fileName, 'DUPLICATE'));
            continue;
          }
          request.log.error({ file_name: file.fileName, err: error }, 'failed to store file');
          rejected.push(rejection(file.fileName, 'INTERNAL_ERROR'));
        }
      }

      if (accepted.length === 0) {
        await audit(request, 'DOCUMENTS_APPEND_REJECTED', process.objectId, {
          process_id: process.id,
          rejected: rejected.length,
          reasons: [...new Set(rejected.map((r) => r.reason))],
        });
        return reply.code(422).send({ accepted: [], rejected });
      }

      // A process that never started still has nothing to react to a
      // дозагрузка with - POST /processes/:id/start reads its files fresh
      // once the inspector does start it, new ones included.
      if (process.status !== 'PENDING') {
        await prisma.process.update({ where: { id: process.id }, data: { status: 'PARSING' } });
        try {
          await publishTask({
            type: 'process.update',
            process_id: process.id,
            object_id: process.objectId,
            file_ids: accepted.map((a) => a.file_id),
          });
        } catch (err) {
          request.log.error({ process_id: process.id, err }, 'failed to publish update task');
          await prisma.process.update({ where: { id: process.id }, data: { status: process.status } });
          return reply.code(503).send({ error: 'QUEUE_UNAVAILABLE' });
        }
      }

      await audit(request, 'DOCUMENTS_APPENDED', process.objectId, {
        process_id: process.id,
        accepted: accepted.length,
        rejected: rejected.length,
      });

      return reply.code(202).send({ process_id: process.id, accepted, rejected });
    },
  );
}
