// Customer's ТЗ p.31, "Проверка целостности данных: ежедневная проверка
// контрольных сумм (хешей) файлов в хранилище для выявления повреждений
// или несанкционированных изменений". Runs on its own daily schedule
// (startIntegrityScheduler, called once from server.ts's entry-point block,
// the same rule startRinScheduler follows) and on demand via
// POST /api/v1/admin/integrity-check (routes/admin.ts). Guarded by the same
// Postgres advisory-lock pattern as integration/transfers.ts's own
// scheduler, so two api replicas never sweep at the same time.
import { createHash } from 'node:crypto';
import type { IntegrityRun } from '@prisma/client';
import { prisma } from './db.js';
import { config } from './config.js';
import { getObjectStream } from './storage.js';
import { notifyAdmins } from './notify.js';
import { integrityFailuresGauge, integrityLastRunTimestamp } from './metrics.js';

// Written by hand rather than through the Fastify logger: this runs off any
// one request's own logger, same reasoning as integration/transfers.ts's own
// logIntegrationEvent (kept separate rather than shared - each background
// job in this codebase owns its own copy of this small helper).
function logIntegrityEvent(level: 'INFO' | 'ERROR', message: string, fields: Record<string, unknown> = {}): void {
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

// Streams the stored object through sha256 rather than buffering it whole -
// a check package can hold 60 MiB files, and a sweep walks every one of
// them. Any failure reading it back (not found, a truncated read, MinIO
// itself unreachable) is reported the same way the ТЗ asks for a genuinely
// missing object to be: there is nothing here to compare against file_hash.
async function recomputeHash(storageKey: string): Promise<string | null> {
  try {
    const stream = await getObjectStream(storageKey);
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

export interface IntegrityRunView {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  files_checked: number;
  mismatches: number;
  missing: number;
  status: string;
  triggered_by: string | null;
  failures: Array<{ file_id: string; kind: string; expected_hash: string; actual_hash: string | null }>;
}

// A fixed, arbitrary key distinct from integration/transfers.ts's own
// SCHEDULER_LOCK_KEY - two unrelated jobs must never contend on the same
// advisory lock by coincidence.
const INTEGRITY_LOCK_KEY = 875_301_443;
const FILE_BATCH = 200;

// Runs the sweep, or does nothing if a concurrent run already holds the
// lock (returns null - routes/admin.ts turns that into a 409, the scheduler
// just skips this tick). triggeredBy is the admin's user id for an on-demand
// run (POST /admin/integrity-check), null for the scheduled one.
export async function runIntegrityCheck(triggeredBy: string | null = null): Promise<IntegrityRunView | null> {
  const result = await prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${INTEGRITY_LOCK_KEY}) AS locked`;
    if (!lock[0]?.locked) return null;

    const run = await tx.integrityRun.create({ data: { status: 'RUNNING', triggeredBy } });

    let filesChecked = 0;
    let mismatches = 0;
    let missing = 0;
    const failedNames: string[] = [];

    let cursor: string | undefined;
    for (;;) {
      const files = await tx.fileRecord.findMany({
        take: FILE_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true, fileName: true, fileHash: true, storageKey: true },
      });
      if (files.length === 0) break;
      cursor = files[files.length - 1].id;

      for (const file of files) {
        filesChecked += 1;
        const actualHash = await recomputeHash(file.storageKey);

        if (actualHash === null) {
          missing += 1;
          failedNames.push(`${file.fileName} (файл отсутствует в хранилище)`);
          await tx.integrityFailure.create({
            data: { runId: run.id, fileId: file.id, kind: 'missing', expectedHash: file.fileHash, actualHash: null },
          });
          continue;
        }
        if (actualHash !== file.fileHash) {
          mismatches += 1;
          failedNames.push(`${file.fileName} (хеш не совпадает)`);
          await tx.integrityFailure.create({
            data: { runId: run.id, fileId: file.id, kind: 'mismatch', expectedHash: file.fileHash, actualHash },
          });
        }
      }
    }

    const status = mismatches + missing > 0 ? 'FAILURES' : 'OK';
    await tx.integrityRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), filesChecked, mismatches, missing, status },
    });

    if (failedNames.length > 0) {
      await notifyAdmins(
        'INTEGRITY_CHECK_FAILED',
        'Нарушена целостность хранилища документов',
        `Ежедневная проверка целостности обнаружила проблемы в ${failedNames.length} `
          + `файл${failedNames.length === 1 ? 'е' : 'ах'}: ${failedNames.join(', ')}.`,
        {},
        tx,
      );
      await tx.auditLog.create({
        data: {
          userId: triggeredBy,
          action: 'INTEGRITY_CHECK_FAILED',
          objectId: null,
          details: { run_id: run.id, files_checked: filesChecked, mismatches, missing },
        },
      });
      logIntegrityEvent('ERROR', 'integrity check found failures', {
        run_id: run.id, files_checked: filesChecked, mismatches, missing,
      });
    } else {
      logIntegrityEvent('INFO', 'integrity check completed clean', { run_id: run.id, files_checked: filesChecked });
    }

    return tx.integrityRun.findUniqueOrThrow({ where: { id: run.id }, include: { failures: true } });
  }, { timeout: config.integrity.transactionTimeoutMs, maxWait: 5_000 });

  if (!result) return null;

  integrityFailuresGauge.set(result.mismatches + result.missing);
  integrityLastRunTimestamp.set(Math.floor((result.finishedAt ?? new Date()).getTime() / 1000));

  return runView(result);
}

type RunWithFailures = IntegrityRun & {
  failures: Array<{ fileId: string; kind: string; expectedHash: string; actualHash: string | null }>;
};

function runView(run: RunWithFailures): IntegrityRunView {
  return {
    id: run.id,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    files_checked: run.filesChecked,
    mismatches: run.mismatches,
    missing: run.missing,
    status: run.status,
    triggered_by: run.triggeredBy,
    failures: run.failures.map((f) => ({
      file_id: f.fileId, kind: f.kind, expected_hash: f.expectedHash, actual_hash: f.actualHash,
    })),
  };
}

export async function listIntegrityRuns(limit = 50): Promise<IntegrityRunView[]> {
  const runs = await prisma.integrityRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { failures: true },
  });
  return runs.map(runView);
}

// Whether today's run is still due: it is the configured local hour
// (INTEGRITY_CHECK_CRON_HOUR) and no run - scheduled or on-demand - has
// completed yet today. An on-demand run earlier in the day still counts:
// the ТЗ asks for the check to happen daily, not specifically by the
// scheduler.
async function dueToday(): Promise<boolean> {
  const now = new Date();
  if (now.getHours() !== config.integrity.cronHour) return false;

  const lastRun = await prisma.integrityRun.findFirst({
    where: { status: { in: ['OK', 'FAILURES'] } },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  if (!lastRun) return true;
  return lastRun.startedAt.toDateString() !== now.toDateString();
}

// Checked every few minutes rather than scheduled for one exact instant -
// simplest way to land a "once a day, at roughly this hour" job without a
// cron dependency this codebase otherwise has no use for.
const SCHEDULE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | null = null;

// Started once, from server.ts's own entry-point block - never from
// buildServer() itself, the same rule startRinScheduler follows, so a test
// that calls buildServer() many times never accumulates intervals.
export function startIntegrityScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    dueToday()
      .then((due) => (due ? runIntegrityCheck(null) : undefined))
      .catch((err) => {
        logIntegrityEvent('ERROR', 'integrity scheduler tick threw', {
          err: err instanceof Error ? { type: err.name, message: err.message } : String(err),
        });
      });
  }, SCHEDULE_CHECK_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopIntegrityScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
