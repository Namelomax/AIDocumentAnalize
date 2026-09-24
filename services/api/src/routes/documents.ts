import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { sha256, storageKeyFor, putObject } from '../storage.js';

const ALLOWED = new Map([
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/xml', '.xml'],
  ['text/xml', '.xml'],
]);

const MAGIC: Record<string, Buffer> = {
  '.pdf': Buffer.from('%PDF'),
  '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

function looksCorrupted(extension: string, body: Buffer): boolean {
  const magic = MAGIC[extension];
  if (!magic) return false;
  return !body.subarray(0, magic.length).equals(magic);
}

const querySchema = z.object({ object_id: z.string().uuid() });

export async function documentRoutes(app: FastifyInstance) {
  app.post('/api/v1/documents/upload', async (request, reply) => {
    const { object_id: objectId } = querySchema.parse(request.query);

    const process = await prisma.process.create({
      data: { objectId, status: 'PENDING' },
    });

    const accepted: Array<{ file_id: string; file_name: string; sha256: string }> = [];
    const rejected: Array<{ file_name: string; reason: string }> = [];
    let packageBytes = 0;

    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;

      const body = await part.toBuffer();
      const extension = ALLOWED.get(part.mimetype);

      if (!extension) {
        rejected.push({ file_name: part.filename, reason: 'UNSUPPORTED_FORMAT' });
        continue;
      }
      if (body.length > config.maxFileBytes) {
        rejected.push({ file_name: part.filename, reason: 'FILE_TOO_LARGE' });
        continue;
      }
      packageBytes += body.length;
      if (packageBytes > config.maxPackageBytes) {
        rejected.push({ file_name: part.filename, reason: 'PACKAGE_TOO_LARGE' });
        continue;
      }
      if (looksCorrupted(extension, body)) {
        rejected.push({ file_name: part.filename, reason: 'CORRUPTED_FILE' });
        continue;
      }

      const hash = sha256(body);
      const existing = await prisma.fileRecord.findUnique({
        where: { objectId_fileHash: { objectId, fileHash: hash } },
      });
      if (existing) {
        rejected.push({ file_name: part.filename, reason: 'DUPLICATE' });
        continue;
      }

      const key = storageKeyFor(hash);
      await putObject(key, body, part.mimetype);

      const record = await prisma.fileRecord.create({
        data: {
          objectId,
          processId: process.id,
          fileName: part.filename,
          fileHash: hash,
          storageKey: key,
          sizeBytes: body.length,
          mimeType: part.mimetype,
        },
      });

      accepted.push({ file_id: record.id, file_name: record.fileName, sha256: hash });
    }

    return reply.code(201).send({ process_id: process.id, accepted, rejected });
  });
}
