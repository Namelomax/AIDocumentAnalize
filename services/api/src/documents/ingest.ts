// Phase 2 of a дозагрузка into an EXISTING process: store what validation
// (documents/validate.ts) already accepted. Shared by POST
// /processes/:id/documents (a human дозагрузка, routes/processDocuments.ts)
// and POST /integration/rin/documents (an automatic дозагрузка from ИАИС
// «РиН», section 9.6, routes/integrationRin.ts) - customer's ТЗ 9.6 asks the
// inbound route to store "through the same path as the incremental upload",
// which this function is: neither route duplicates the storage/manifest/
// duplicate-handling rules the other one already gets right.
import type { FastifyBaseLogger } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { sha256, storageKeyFor, putObject } from '../storage.js';
import { rejection, type PendingFile, type Rejection } from './validate.js';

export interface IngestOutcome {
  accepted: Array<{ file_id: string; file_name: string; sha256: string }>;
  rejected: Rejection[];
}

export async function ingestFiles(
  process: { id: string; objectId: string },
  pending: PendingFile[],
  rejected: Rejection[],
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<IngestOutcome> {
  const accepted: IngestOutcome['accepted'] = [];

  for (const file of pending) {
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
          log.error({ file_name: file.fileName, err: error }, 'failed to flag manifest on process');
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
      log.error({ file_name: file.fileName, err: error }, 'failed to store file');
      rejected.push(rejection(file.fileName, 'INTERNAL_ERROR'));
    }
  }

  return { accepted, rejected };
}
