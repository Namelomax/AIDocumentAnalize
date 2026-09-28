// In-app notifications written from the API process itself, not the worker.
// The worker has its own copy of this fan-out (services/worker/app/db.py's
// notify_admins/notify_process_owner) for the events it raises; this module
// is the same shape for the events the API raises on its own - today only
// the ИАИС «РиН» integration (section 9.6): a transfer that exhausted its
// retries needs an administrator, and an automatic дозагрузка landing on an
// already-finalized protocol needs the inspector who owns the process.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './db.js';

// Accepts either the module-level client or a `tx` handed out by
// prisma.$transaction, so a notification can be written atomically alongside
// whatever else a transfer's outcome updates (integration/transfers.ts).
type Db = PrismaClient | Prisma.TransactionClient;

interface NotifyTarget {
  processId?: string | null;
  objectId?: string | null;
}

async function insertNotifications(
  db: Db,
  userIds: string[],
  kind: string,
  title: string,
  body: string,
  target: NotifyTarget,
): Promise<void> {
  if (userIds.length === 0) return;
  await db.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      kind,
      title,
      body,
      processId: target.processId ?? null,
      objectId: target.objectId ?? null,
    })),
  });
}

// Section 9.6 / customer's ТЗ p.17 "уведомление администратора": a transfer
// to ИАИС «РиН» that failed for good, never routed through a role no one is
// watching.
export async function notifyAdmins(
  kind: string,
  title: string,
  body: string,
  target: NotifyTarget = {},
  db: Db = prisma,
): Promise<void> {
  const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await insertNotifications(db, admins.map((a) => a.id), kind, title, body, target);
}

// Section 9.6 "Блокировка автоматической дозагрузки при финализированном
// протоколе": whoever started this process (or every INSPECTOR, with no
// owner recorded) learns that ИАИС «РиН» has new documents for it - the same
// fallback rule the worker's own notify_process_owner uses.
export async function notifyProcessOwner(
  process: { id: string; objectId: string; startedBy: string | null },
  kind: string,
  title: string,
  body: string,
  db: Db = prisma,
): Promise<void> {
  const userIds = process.startedBy
    ? [process.startedBy]
    : (await db.user.findMany({ where: { role: 'INSPECTOR' }, select: { id: true } })).map((u) => u.id);
  await insertNotifications(db, userIds, kind, title, body, { processId: process.id, objectId: process.objectId });
}
