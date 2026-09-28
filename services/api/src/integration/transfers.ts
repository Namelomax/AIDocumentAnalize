// Section 9.6's transfer lifecycle: enqueue on finalize, send with retries on
// a schedule of its own, and the two states an operator can force
// (cancel on unfinalize, requeue on a manual resync). Kept as plain
// functions over Prisma rather than a class, matching the rest of
// services/api.
import type { IntegrationTransfer, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { buildTransferPayload } from './payload.js';
import { postInspectionResult } from './client.js';
import { notifyAdmins } from '../notify.js';

type Db = PrismaClient | Prisma.TransactionClient;

// Written by hand rather than through the Fastify logger: the scheduler runs
// on a timer, off any one request, and a failure here still has to come out
// in the one structured log shape the whole solution uses (mirrors
// queue.ts's logQueueError).
function logIntegrationEvent(level: 'INFO' | 'ERROR', message: string, fields: Record<string, unknown> = {}): void {
  const stream = level === 'ERROR' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify({
    level,
    timestamp: new Date().toISOString(),
    service: 'api',
    request_id: null,
    user_id: null,
    message,
    ...fields,
  })}\n`);
}

// Section 9.3: finalization is what starts a transfer - one PENDING row, due
// immediately. Takes a client (plain `prisma` or a $transaction's `tx`) so
// the finalize route can enqueue it atomically alongside the protocol's own
// status change.
export async function enqueueTransfer(protocolId: string, db: Db = prisma): Promise<string> {
  const created = await db.integrationTransfer.create({
    data: { protocolId, attempt: 0, status: 'PENDING', nextAttemptAt: new Date() },
  });
  return created.id;
}

// Section 9.6: "Unfinalize while PENDING cancels the pending transfer." A
// transfer already SENT or exhausted (FAILED) is left as-is - it is history,
// not something an unfinalize can undo. sync_status is cleared back to null
// only when a pending transfer actually existed to cancel: otherwise there
// was nothing in flight to report on either.
export async function cancelPendingTransfer(protocolId: string, db: Db = prisma): Promise<void> {
  const cancelled = await db.integrationTransfer.updateMany({
    where: { protocolId, status: 'PENDING' },
    data: { status: 'CANCELLED', nextAttemptAt: null },
  });
  if (cancelled.count > 0) {
    await db.protocol.update({ where: { id: protocolId }, data: { syncStatus: null } });
  }
}

async function recordFailure(
  db: Db,
  transfer: IntegrationTransfer,
  attempt: number,
  outcome: { statusCode?: number; error: string },
  objectId: string,
  permanent: boolean,
  payloadHash: string,
): Promise<void> {
  const delays = config.rin.retryDelaysS;
  const exhausted = permanent || attempt > delays.length;

  if (!exhausted) {
    const delaySec = delays[attempt - 1];
    await db.integrationTransfer.update({
      where: { id: transfer.id },
      data: {
        attempt,
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() + delaySec * 1000),
        lastError: outcome.error,
        responseCode: outcome.statusCode ?? null,
        payloadHash,
      },
    });
    logIntegrationEvent('ERROR', 'rin transfer attempt failed, retry scheduled', {
      protocol_id: transfer.protocolId, transfer_id: transfer.id, attempt, delay_s: delaySec, error: outcome.error,
    });
    return;
  }

  await db.integrationTransfer.update({
    where: { id: transfer.id },
    data: {
      attempt,
      status: 'FAILED',
      nextAttemptAt: null,
      lastError: outcome.error,
      responseCode: outcome.statusCode ?? null,
      payloadHash,
    },
  });
  await db.protocol.update({ where: { id: transfer.protocolId }, data: { syncStatus: 'FAILED' } });
  await db.auditLog.create({
    data: {
      userId: null,
      action: 'RIN_TRANSFER_FAILED',
      objectId,
      details: { protocol_id: transfer.protocolId, transfer_id: transfer.id, attempt, error: outcome.error, permanent },
    },
  });
  await notifyAdmins(
    'RIN_TRANSFER_FAILED',
    'Ошибка передачи протокола в ИАИС «РиН»',
    `Передача протокола ${transfer.protocolId} в ИАИС «РиН» не удалась после ${attempt} `
      + `попыт${attempt === 1 ? 'ки' : 'ок'}: ${outcome.error}. Требуется ручная проверка и повторная отправка.`,
    { objectId },
    db,
  );
  logIntegrationEvent('ERROR', 'rin transfer failed permanently', {
    protocol_id: transfer.protocolId, transfer_id: transfer.id, attempt, error: outcome.error, permanent,
  });
}

// One transfer, one send attempt, run inside the scheduler tick's own
// transaction (`db` is that transaction's `tx`) so the row's new state and
// the protocol's sync_status can never observe each other half-applied.
export async function processTransfer(db: Db, transfer: IntegrationTransfer): Promise<void> {
  const { payload, payloadHash, protocol } = await buildTransferPayload(transfer.protocolId, db);
  const result = await postInspectionResult(protocol.processId, payload);
  const attempt = transfer.attempt + 1;

  if (result.outcome === 'success') {
    await db.integrationTransfer.update({
      where: { id: transfer.id },
      data: { attempt, status: 'SENT', nextAttemptAt: null, lastError: null, responseCode: result.statusCode, payloadHash },
    });
    await db.protocol.update({ where: { id: transfer.protocolId }, data: { syncStatus: 'SYNCED' } });
    await db.auditLog.create({
      data: {
        userId: null,
        action: 'RIN_TRANSFER_SENT',
        objectId: protocol.objectId,
        details: { protocol_id: protocol.id, transfer_id: transfer.id, attempt, response_code: result.statusCode },
      },
    });
    logIntegrationEvent('INFO', 'rin transfer sent', {
      protocol_id: protocol.id, transfer_id: transfer.id, attempt, response_code: result.statusCode,
    });
    return;
  }

  await recordFailure(
    db, transfer, attempt,
    { statusCode: result.statusCode, error: result.error },
    protocol.objectId,
    result.outcome === 'permanent_failure',
    payloadHash,
  );
}

// A fixed, arbitrary key for a Postgres advisory lock scoped to this one
// scheduler job. pg_try_advisory_xact_lock ties the lock to the surrounding
// transaction (released automatically on commit/rollback) rather than the
// session, so it can never be left held by a pooled connection that Prisma
// hands to someone else afterwards - the risk a session-scoped
// pg_advisory_lock/unlock pair would carry here.
const SCHEDULER_LOCK_KEY = 875_301_442;
const DUE_TRANSFERS_BATCH = 20;

// One tick: try to take the lock, and if it is free, send every transfer
// whose next_attempt_at has arrived. A second api replica running the same
// tick concurrently simply finds the lock held and does nothing this round -
// exactly the "guarded by a Postgres advisory lock so two api replicas
// cannot double-send" the design calls for.
export async function runSchedulerTick(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK_KEY}) AS locked`;
    if (!lock[0]?.locked) return;

    const due = await tx.integrationTransfer.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: DUE_TRANSFERS_BATCH,
    });

    for (const transfer of due) {
      try {
        await processTransfer(tx, transfer);
      } catch (err) {
        // A bug or an unexpected DB error here must not wedge the scheduler
        // on this one row forever - log it and let the row's existing
        // next_attempt_at (unchanged) bring it back on a later tick.
        logIntegrationEvent('ERROR', 'rin scheduler tick failed on a transfer', {
          transfer_id: transfer.id, protocol_id: transfer.protocolId,
          err: err instanceof Error ? { type: err.name, message: err.message } : String(err),
        });
      }
    }
  }, { timeout: config.rin.transactionTimeoutMs, maxWait: 5_000 });
}

let intervalHandle: NodeJS.Timeout | null = null;

// Started once, from server.ts's own entry-point block - never from
// buildServer() itself, the same rule ensureBucket/seedDemoUsers follow, so
// a test that calls buildServer() many times never accumulates intervals.
export function startRinScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    runSchedulerTick().catch((err) => {
      logIntegrationEvent('ERROR', 'rin scheduler tick threw', {
        err: err instanceof Error ? { type: err.name, message: err.message } : String(err),
      });
    });
  }, config.rin.schedulerIntervalMs);
  // Does not keep the event loop alive on its own account - a graceful
  // shutdown must not wait out an idle 15s tick.
  intervalHandle.unref();
}

export function stopRinScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
