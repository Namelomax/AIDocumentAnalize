// Customer's ТЗ feature table, item 10: "Еженедельный отчёт по дообучению -
// Автоматическая генерация отчёта для ML-инженеров: статистика отклонений,
// рекомендации по донастройке моделей." Generated on the weekly schedule
// (startQualityReportScheduler, Monday at config.quality.reportCronHour
// local, same advisory-lock shape as integrity.ts's own daily sweep) or on
// demand via POST /api/v1/quality/reports.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { notifyRoles } from '../notify.js';
import { reasonLabels, label as labelText } from '../export/labels.js';
import { computeQualityMetrics, type QualityMetricsResponse } from './metrics.js';

type Db = PrismaClient | Prisma.TransactionClient;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReportPayload {
  metrics: QualityMetricsResponse;
  previous_metrics: QualityMetricsResponse;
  trend: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    false_positive_rate: number | null;
  };
  recommendations: string[];
}

export interface QualityReportView {
  id: string;
  period_start: Date;
  period_end: Date;
  payload: ReportPayload;
  generated_by: string | null;
  created_at: Date;
}

function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

// Plain, rule-based recommendations from the rejection-reason breakdown and
// threshold failures - not a model of its own, just the same "here is what
// to look at first" an ML engineer would read the raw numbers for anyway.
function buildRecommendations(metrics: QualityMetricsResponse): string[] {
  const out: string[] = [];
  const { overall, rejection_reasons: reasons, by_modality: byModality } = metrics;

  if (overall.pass.precision === false) {
    out.push(
      `Точность (Precision=${overall.precision.point?.toFixed(2)}) ниже порога ${overall.thresholds.precisionMin} `
      + '- проверьте кандидатов, которые чаще всего отклоняются инспекторами (см. причины ниже).',
    );
  }
  if (overall.pass.recall === false) {
    out.push(
      `Полнота (Recall=${overall.recall.point?.toFixed(2)}) ниже порога ${overall.thresholds.recallMin} `
      + '- часть подтверждённых нарушений движок не поднимал как кандидатов; рассмотрите донастройку правил или моделей для соответствующих параметров.',
    );
  }
  if (overall.pass.false_positive_rate === false) {
    out.push(
      `Доля ложных срабатываний (FPR=${overall.false_positive_rate.point?.toFixed(2)}) превышает порог `
      + `${overall.thresholds.fprMax} - требуется дообучение или уточнение правил перед публикацией новой версии.`,
    );
  }

  const worstModality = byModality
    .filter((m) => m.pass.overall === false)
    .sort((a, b) => (a.f1 ?? 1) - (b.f1 ?? 1))[0];
  if (worstModality) {
    out.push(`Модальность с наибольшим отклонением от приёмочных порогов: ${worstModality.modality ?? '—'}.`);
  }

  const topReason = [...reasons].sort((a, b) => b.count - a.count)[0];
  if (topReason) {
    out.push(
      `Основная причина отклонений инспекторами - «${labelText(reasonLabels, topReason.reason_code, topReason.reason_code)}» `
      + `(${topReason.count} раз за период); рекомендуется приоритизировать разбор этой причины при следующей донастройке.`,
    );
  }

  if (out.length === 0) {
    out.push('Все приёмочные пороги раздела 14.3 выполнены за отчётный период; действий по донастройке не требуется.');
  }
  return out;
}

function toView(row: { id: string; periodStart: Date; periodEnd: Date; payload: unknown; generatedBy: string | null; createdAt: Date }): QualityReportView {
  return {
    id: row.id, period_start: row.periodStart, period_end: row.periodEnd,
    payload: row.payload as ReportPayload, generated_by: row.generatedBy, created_at: row.createdAt,
  };
}

// generatedBy is the ADMIN/ML_ENGINEER who asked for an on-demand report
// (routes/quality.ts), null for the scheduled Monday run - nobody to name,
// same convention as integrity.ts's own triggeredBy. `db` lets the scheduled
// run pass its own transaction through (see startQualityReportScheduler
// below) so the whole computation happens under its advisory lock, on one
// connection, the same shape integrity.ts's runIntegrityCheck uses.
export async function generateWeeklyReport(generatedBy: string | null, db: Db = prisma): Promise<QualityReportView> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - WEEK_MS);
  const previousPeriodEnd = periodStart;
  const previousPeriodStart = new Date(previousPeriodEnd.getTime() - WEEK_MS);

  // Unfiltered on purpose: the weekly report is the system-wide view, and
  // its own metrics computation is what also refreshes the Prometheus
  // gauges (quality/metrics.ts) that deploy/monitoring/alert-rules.yml's
  // QualityHighFalsePositiveRate reads - a filtered call here would corrupt
  // that "all" reading with a narrower one.
  const [metrics, previousMetrics] = await Promise.all([
    computeQualityMetrics({ from: periodStart, to: periodEnd }, db),
    computeQualityMetrics({ from: previousPeriodStart, to: previousPeriodEnd }, db),
  ]);

  const payload: ReportPayload = {
    metrics,
    previous_metrics: previousMetrics,
    trend: {
      precision: delta(metrics.overall.precision.point, previousMetrics.overall.precision.point),
      recall: delta(metrics.overall.recall.point, previousMetrics.overall.recall.point),
      f1: delta(metrics.overall.f1, previousMetrics.overall.f1),
      false_positive_rate: delta(metrics.overall.false_positive_rate.point, previousMetrics.overall.false_positive_rate.point),
    },
    recommendations: buildRecommendations(metrics),
  };

  const row = await db.qualityReport.create({
    data: { periodStart, periodEnd, payload: payload as object, generatedBy },
  });

  // Customer's ТЗ: "Автоматическая генерация отчёта для ML-инженеров" -
  // ADMIN too, the same authority this codebase gives every other
  // operational/ML resource in the quality loop (routes/quality.ts's own
  // requireRole list).
  await notifyRoles(
    ['ADMIN', 'ML_ENGINEER'],
    'QUALITY_REPORT_READY',
    'Еженедельный отчёт по качеству готов',
    `Отчёт за период ${periodStart.toISOString().slice(0, 10)} - ${periodEnd.toISOString().slice(0, 10)}: `
    + `Precision=${metrics.overall.precision.point?.toFixed(2) ?? '—'}, Recall=${metrics.overall.recall.point?.toFixed(2) ?? '—'}, `
    + `FPR=${metrics.overall.false_positive_rate.point?.toFixed(2) ?? '—'}.`,
    {},
    db,
  );

  return toView(row);
}

export async function listQualityReports(limit = 50): Promise<QualityReportView[]> {
  const rows = await prisma.qualityReport.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map(toView);
}

export async function getQualityReport(id: string): Promise<QualityReportView | null> {
  const row = await prisma.qualityReport.findUnique({ where: { id } });
  return row ? toView(row) : null;
}

// Distinct from integration/transfers.ts's SCHEDULER_LOCK_KEY (875_301_442)
// and integrity.ts's INTEGRITY_LOCK_KEY (875_301_443) - two unrelated jobs
// must never contend on the same advisory lock by coincidence.
const QUALITY_REPORT_LOCK_KEY = 875_301_444;
// Generous but bounded: metrics computation reads gold_labels twice
// (current + previous week) plus one insert and a notification fan-out -
// nowhere near integrity.ts's own file-hashing timeout, but still a
// transaction, not a single fast query.
const QUALITY_REPORT_TRANSACTION_TIMEOUT_MS = 60_000;

// Whether this week's report is still due: Monday, the configured local
// hour, and no report (scheduled or on-demand) has completed in the last 6
// days - the same "an earlier on-demand run still counts" reasoning as
// integrity.ts's own dueToday, loosened from "today" to "this week" since
// this job runs weekly rather than daily.
async function dueThisWeek(db: Db): Promise<boolean> {
  const now = new Date();
  if (now.getDay() !== 1) return false; // Monday
  if (now.getHours() !== config.quality.reportCronHour) return false;

  const lastReport = await db.qualityReport.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!lastReport) return true;
  return now.getTime() - lastReport.createdAt.getTime() >= 6 * 24 * 60 * 60 * 1000;
}

const SCHEDULE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let intervalHandle: NodeJS.Timeout | null = null;

// The whole check-and-generate runs inside one transaction holding the
// advisory lock for its entire duration - same shape as integrity.ts's own
// runIntegrityCheck, so two api replicas ticking at once can never both
// decide the report is due and both generate one.
async function tick(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${QUALITY_REPORT_LOCK_KEY}) AS locked`;
    if (!lock[0]?.locked) return;
    if (!(await dueThisWeek(tx))) return;
    await generateWeeklyReport(null, tx);
  }, { timeout: QUALITY_REPORT_TRANSACTION_TIMEOUT_MS, maxWait: 5_000 });
}

// Started once from server.ts's entry-point block, never from buildServer()
// itself - the same rule startIntegrityScheduler and startRinScheduler
// follow, so a test suite that calls buildServer() many times never
// accumulates intervals.
export function startQualityReportScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tick().catch(() => {
      // Best-effort, same as integrity.ts's own scheduler - a failed tick is
      // simply retried on the next one.
    });
  }, SCHEDULE_CHECK_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopQualityReportScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
