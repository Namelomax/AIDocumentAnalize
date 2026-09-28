import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { megabytes, validatePackage, type PendingFile } from '../documents/validate.js';
import { ingestFiles } from '../documents/ingest.js';

export { megabytes } from '../documents/validate.js';

const querySchema = z.object({ object_id: z.string().uuid() });

export async function documentRoutes(app: FastifyInstance) {
  // The interface's upload dialog used to hardcode these numbers, and drifted
  // from the real limit once MAX_FILE_BYTES was raised past the 50 MB the
  // specification states (see config.ts). The server is the one place both
  // figures are exact, so it is the one place they are now read from.
  app.get('/api/v1/upload/limits', async () => ({
    max_file_bytes: config.maxFileBytes,
    max_package_bytes: config.maxPackageBytes,
    supported_formats: ['PDF', 'DOCX', 'XML'],
    registry_formats: ['CSV', 'XLSX', 'JSON'],
  }));

  app.post('/api/v1/documents/upload', async (request, reply) => {
    const { object_id: objectId } = querySchema.parse(request.query);

    const { pending, rejected, packageBytes } = await validatePackage(request);

    // The spec rejects the PACKAGE, not the offending file. Nothing has been
    // stored yet, so there is nothing to roll back.
    if (packageBytes > config.maxPackageBytes) {
      return reply.code(413).send({
        error: 'PACKAGE_TOO_LARGE',
        limit_bytes: config.maxPackageBytes,
        received_bytes: packageBytes,
        max_bytes: config.maxPackageBytes,
        message: `Пакет больше допустимого объёма ${megabytes(config.maxPackageBytes)}`,
      });
    }

    // Phase 2: store what survived validation - same storage/manifest/
    // duplicate/antivirus rules as a дозагрузка (documents/ingest.ts), just
    // against a process created fresh for this upload instead of an
    // existing one.
    const process = await prisma.process.create({
      data: { objectId, status: 'PENDING' },
    });
    const { accepted, rejected: rejectedAll } = await ingestFiles(
      { id: process.id, objectId }, pending as PendingFile[], rejected, request.log, request.user?.id ?? null,
    );

    // A process holding no documents would sit in the checks list forever,
    // indistinguishable from one still being parsed.
    if (accepted.length === 0) {
      await prisma.process.delete({ where: { id: process.id } });
      // A refused package is still an action the user took (section 12.4
      // records every one), just as a failed login is.
      await audit(request, 'DOCUMENTS_REJECTED', objectId, {
        rejected: rejectedAll.length,
        reasons: [...new Set(rejectedAll.map((r) => r.reason))],
      });
      return reply.code(422).send({ accepted: [], rejected: rejectedAll });
    }

    // objectId is the construction object the package belongs to; process_id
    // travels in details since a single object accumulates many processes.
    await audit(request, 'DOCUMENTS_UPLOADED', objectId, {
      process_id: process.id,
      accepted: accepted.length,
      rejected: rejectedAll.length,
    });

    return reply.code(201).send({ process_id: process.id, accepted, rejected: rejectedAll });
  });
}
