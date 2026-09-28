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
import { config } from '../config.js';
import { sha256, storageKeyFor, putObject } from '../storage.js';
import { scanBuffer } from '../antivirus.js';
import { notifyAdmins } from '../notify.js';
import { rejection, type PendingFile, type Rejection } from './validate.js';

export interface IngestOutcome {
  accepted: Array<{ file_id: string; file_name: string; sha256: string }>;
  rejected: Rejection[];
}

export async function ingestFiles(
  process: { id: string; objectId: string },
  pending: PendingFile[],
  rejected: Rejection[],
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>,
  // Whoever's action this ingest belongs to, for the AuditLog row an infected
  // file writes (section 12.4: every action, by whom). Null for a call with
  // no human behind it, e.g. the inbound ИАИС «РиН» route.
  userId: string | null = null,
): Promise<IngestOutcome> {
  const accepted: IngestOutcome['accepted'] = [];

  for (const file of pending) {
    // Customer's ТЗ p.29, "Антивирусная защита": scanned before it ever
    // reaches storage, not after - an infected file must never be the one
    // putObject actually writes.
    const scan = await scanBuffer(file.body);
    if (scan.outcome === 'infected') {
      rejected.push(rejection(file.fileName, 'INFECTED', scan.signature));
      log.error({ file_name: file.fileName, signature: scan.signature }, 'infected file rejected by antivirus scan');
      await prisma.auditLog.create({
        data: {
          userId,
          action: 'FILE_INFECTED',
          objectId: process.objectId,
          details: { process_id: process.id, file_name: file.fileName, signature: scan.signature },
        },
      });
      await notifyAdmins(
        'FILE_INFECTED',
        'Файл отклонён антивирусной проверкой',
        `Файл «${file.fileName}» отклонён антивирусной проверкой (сигнатура: ${scan.signature}) при загрузке по процессу ${process.id}.`,
        { processId: process.id, objectId: process.objectId },
      );
      continue;
    }
    if (scan.outcome === 'unavailable') {
      if (config.antivirus.required) {
        rejected.push(rejection(file.fileName, 'ANTIVIRUS_UNAVAILABLE'));
        log.error({ file_name: file.fileName, err: scan.error }, 'antivirus scan unavailable, file rejected');
        continue;
      }
      // An explicit operator choice (ANTIVIRUS_REQUIRED=false): accept the
      // file unscanned rather than block every upload while clamd is down.
      log.warn({ file_name: file.fileName, err: scan.error }, 'antivirus scan unavailable, accepting file unscanned');
    }

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
