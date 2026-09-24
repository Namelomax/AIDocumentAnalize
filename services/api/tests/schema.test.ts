import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('schema', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejects duplicate file hash within the same object', async () => {
    const object = await prisma.constructionObject.create({
      data: { name: 'Test object' },
    });
    const hash = 'a'.repeat(64);

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
  });
});
