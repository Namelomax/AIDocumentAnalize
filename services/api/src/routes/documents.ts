import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { sha256, storageKeyFor, putObject } from '../storage.js';
import { audit } from '../audit.js';
import { megabytes, rejection, validatePackage, type PendingFile } from '../documents/validate.js';

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

    // Phase 2: store what survived validation.
    const process = await prisma.process.create({
      data: { objectId, status: 'PENDING' },
    });
    const accepted: Array<{ file_id: string; file_name: string; sha256: string }> = [];

    for (const file of pending as PendingFile[]) {
      const hash = sha256(file.body);
      const key = storageKeyFor(hash);
      try {
        await putObject(key, file.body, file.mimeType);
        const record = await prisma.fileRecord.create({
          data: {
            objectId,
            processId: process.id,
            fileName: file.fileName,
            fileHash: hash,
            storageKey: key,
            sizeBytes: file.body.length,
            mimeType: file.mimeType,
            // doc_stage stays null: a registry describes the package, it
            // does not belong to a documentation stage itself, which is
            // exactly what keeps it out of stage completeness counts.
          },
        });
        if (file.isManifest) {
          // The worker locates the registry's bytes for parsing by this
          // hash, via storage_key on the matching files row.
          try {
            await prisma.process.update({
              where: { id: process.id },
              data: { manifestUploaded: true, inputManifestHash: hash },
            });
          } catch (error) {
            // The file itself is already stored and accepted; failing to
            // flag the process must not undo that.
            request.log.error({ file_name: file.fileName, err: error }, 'failed to flag manifest on process');
          }
        }
        accepted.push({ file_id: record.id, file_name: record.fileName, sha256: hash });
      } catch (error) {
        // The unique key is what forbids duplicates, not a lookup before the
        // insert: a pre-check still loses the race between two concurrent
        // uploads of the same file.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          rejected.push(rejection(file.fileName, 'DUPLICATE'));
          continue;
        }
        // One failed file must not sink the package: the others are already
        // stored, and the caller has to learn which ones.
        request.log.error({ file_name: file.fileName, err: error }, 'failed to store file');
        rejected.push(rejection(file.fileName, 'INTERNAL_ERROR'));
      }
    }

    // A process holding no documents would sit in the checks list forever,
    // indistinguishable from one still being parsed.
    if (accepted.length === 0) {
      await prisma.process.delete({ where: { id: process.id } });
      // A refused package is still an action the user took (section 12.4
      // records every one), just as a failed login is.
      await audit(request, 'DOCUMENTS_REJECTED', objectId, {
        rejected: rejected.length,
        reasons: [...new Set(rejected.map((r) => r.reason))],
      });
      return reply.code(422).send({ accepted: [], rejected });
    }

    // objectId is the construction object the package belongs to; process_id
    // travels in details since a single object accumulates many processes.
    await audit(request, 'DOCUMENTS_UPLOADED', objectId, {
      process_id: process.id,
      accepted: accepted.length,
      rejected: rejected.length,
    });

    return reply.code(201).send({ process_id: process.id, accepted, rejected });
  });
}
