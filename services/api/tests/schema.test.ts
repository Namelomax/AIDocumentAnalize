import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { cleanupScenario } from './helpers/cleanup.js';

const prisma = new PrismaClient();

describe('schema', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejects duplicate file hash within the same object', async () => {
    const object = await prisma.constructionObject.create({
      data: { name: 'Test object' },
    });
    const hash = 'a'.repeat(64);

    try {
      await prisma.fileRecord.create({
        data: {
          objectId: object.id, fileName: 'a.pdf', fileHash: hash,
          storageKey: 'k1', sizeBytes: 10, mimeType: 'application/pdf',
        },
      });

      await expect(
        prisma.fileRecord.create({
          data: {
            objectId: object.id, fileName: 'b.pdf', fileHash: hash,
            storageKey: 'k2', sizeBytes: 10, mimeType: 'application/pdf',
          },
        })
      ).rejects.toThrow();
    } finally {
      // cleanupScenario uses its own prisma singleton (src/db.ts), a
      // different client instance from this file's own PrismaClient - fine,
      // both point at the same database and this call is the last thing
      // this file's own client is used for anyway.
      await cleanupScenario(object.id);
    }
  });
});
