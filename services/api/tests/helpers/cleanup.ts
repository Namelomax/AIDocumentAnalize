import { prisma } from '../../src/db.js';
import { removeObject } from '../../src/storage.js';

// Shared teardown for the "one construction object, everything hanging off
// it" scenario nearly every route-level test builds - having one copy here
// instead of a dozen near-identical local ones is what keeps the deletion
// order right in exactly one place, and what stops a file row a test forgot
// to clean up from surviving into integrity.ts's daily sweep (customer's ТЗ
// p.31) as a false MISSING/mismatch on a shared dev stand.
export async function cleanupScenario(objectId: string): Promise<void> {
  // Deleting the process cascades its checks, protocols, evidence fragments
  // and rejection_log rows (schema.prisma onDelete: Cascade). It does not
  // cascade files - files.process_id is ON DELETE SET NULL, so a file
  // outlives its process and is cleared explicitly below.
  await prisma.process.deleteMany({ where: { objectId } });

  const files = await prisma.fileRecord.findMany({
    where: { objectId },
    select: { storageKey: true },
  });
  await prisma.fileRecord.deleteMany({ where: { objectId } });

  // storageKey is content-addressed (storage.ts's own storageKeyFor(sha256))
  // for anything that went through the real upload path, so two FileRecord
  // rows in different objects can share the same MinIO object when their
  // bytes are identical - the schema's @@unique([objectId, fileHash]) only
  // rules out a duplicate within the SAME object. Removing a shared key here
  // would silently turn some other, still-living row into a false MISSING
  // for integrity.ts's own daily sweep - only remove a key nothing else
  // still points to. (A key nothing ever put real bytes under has nothing
  // here to remove either way - MinIO's DELETE is idempotent on a missing
  // key, same as S3's.)
  const keys = [...new Set(files.map((f) => f.storageKey))];
  await Promise.all(keys.map(async (key) => {
    const stillReferenced = await prisma.fileRecord.findFirst({ where: { storageKey: key } });
    if (!stillReferenced) await removeObject(key);
  }));

  await prisma.constructionObject.delete({ where: { id: objectId } });
}
