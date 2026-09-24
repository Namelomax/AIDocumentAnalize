import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { sha256, storageKeyFor, putObject } from '../storage.js';

const ALLOWED = new Map([
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/xml', '.xml'],
  ['text/xml', '.xml'],
]);

// A registry is not a package document: it describes the package rather than
// being part of it, so its formats live in a set of their own instead of
// being folded into ALLOWED.
const MANIFEST_TYPES = new Map([
  ['text/csv', '.csv'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/json', '.json'],
]);

const MAGIC: Record<string, Buffer> = {
  '.pdf': Buffer.from('%PDF'),
  // Both are zip containers underneath, so they carry the same signature. A
  // registry of random bytes is caught here with a reason the inspector can
  // read, rather than surfacing much later as a parse warning in worker logs.
  '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  '.xlsx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

function looksCorrupted(extension: string, body: Buffer): boolean {
  if (extension === '.xml') {
    // XML has no magic number, but a readable document always opens with a
    // tag once the BOM and leading whitespace are gone. Without this, a file
    // of random bytes declared as XML would be stored as a valid registry.
    const text = body.toString('utf8').replace(/^﻿/, '').trimStart();
    return !text.startsWith('<');
  }
  const magic = MAGIC[extension];
  if (!magic) return false;
  return !body.subarray(0, magic.length).equals(magic);
}

const querySchema = z.object({ object_id: z.string().uuid() });

interface PendingFile {
  fileName: string;
  body: Buffer;
  mimeType: string;
  isManifest: boolean;
}

export async function documentRoutes(app: FastifyInstance) {
  app.post('/api/v1/documents/upload', async (request, reply) => {
    const { object_id: objectId } = querySchema.parse(request.query);

    const pending: PendingFile[] = [];
    const rejected: Array<{ file_name: string; reason: string }> = [];
    let packageBytes = 0;
    let manifestSeen = false;

    // Phase 1: read and validate without storing anything. EVERY part counts
    // towards the package total, rejected ones included — otherwise the limit
    // is walked past with files of an unsupported type.
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;

      const body = await part.toBuffer();
      packageBytes += body.length;

      const isManifest = MANIFEST_TYPES.has(part.mimetype);
      const extension = isManifest ? MANIFEST_TYPES.get(part.mimetype) : ALLOWED.get(part.mimetype);
      if (!extension) {
        rejected.push({ file_name: part.filename, reason: 'UNSUPPORTED_FORMAT' });
        continue;
      }
      // Two registries contradict each other and nothing here can pick the
      // right one, so only the first in order is even considered — later
      // ones are rejected outright, without spending a validity check on them.
      if (isManifest) {
        if (manifestSeen) {
          rejected.push({ file_name: part.filename, reason: 'MULTIPLE_MANIFESTS' });
          continue;
        }
        manifestSeen = true;
      }
      if (body.length > config.maxFileBytes) {
        rejected.push({ file_name: part.filename, reason: 'FILE_TOO_LARGE' });
        continue;
      }
      if (looksCorrupted(extension, body)) {
        rejected.push({ file_name: part.filename, reason: 'CORRUPTED_FILE' });
        continue;
      }
      pending.push({ fileName: part.filename, body, mimeType: part.mimetype, isManifest });
    }

    // The spec rejects the PACKAGE, not the offending file. Nothing has been
    // stored yet, so there is nothing to roll back.
    if (packageBytes > config.maxPackageBytes) {
      return reply.code(413).send({
        error: 'PACKAGE_TOO_LARGE',
        limit_bytes: config.maxPackageBytes,
        received_bytes: packageBytes,
      });
    }

    // Phase 2: store what survived validation.
    const process = await prisma.process.create({
      data: { objectId, status: 'PENDING' },
    });
    const accepted: Array<{ file_id: string; file_name: string; sha256: string }> = [];

    for (const file of pending) {
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
          rejected.push({ file_name: file.fileName, reason: 'DUPLICATE' });
          continue;
        }
        // One failed file must not sink the package: the others are already
        // stored, and the caller has to learn which ones.
        request.log.error({ file_name: file.fileName, err: error }, 'failed to store file');
        rejected.push({ file_name: file.fileName, reason: 'INTERNAL_ERROR' });
      }
    }

    // A process holding no documents would sit in the checks list forever,
    // indistinguishable from one still being parsed.
    if (accepted.length === 0) {
      await prisma.process.delete({ where: { id: process.id } });
      return reply.code(422).send({ accepted: [], rejected });
    }

    return reply.code(201).send({ process_id: process.id, accepted, rejected });
  });
}
