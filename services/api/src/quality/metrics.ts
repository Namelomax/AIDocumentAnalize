// Section 14.3's acceptance metrics: this module implements only the
// "Выявление нарушений" (Precision/Recall/F1) and "Ложные срабатывания"
// (FPR) rows of that section's table. The other three rows (OCR character
// accuracy, key-field exact match, document-linking and bbox/IoU
// localization) are measured by the organizer against a hidden test set with
// independently prepared ground-truth geometry/text that this deployed
// system has no access to - its own GOLD is built from what the engine
// found and an inspector confirmed or rejected, which is not an independent
// reference to score localization or OCR against. See this task's own final
// report for the full explanation.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { qualityFprGauge, qualityPrecisionGauge, qualityRecallGauge } from '../metrics.js';

// Accepts either the module-level client or a `tx` handed out by
// prisma.$transaction - quality/reports.ts's scheduled run computes metrics
// inside the same transaction that holds its advisory lock, the same reason
// notify.ts's own Db type exists.
type Db = PrismaClient | Prisma.TransactionClient;

// Section 14.3's own acceptance thresholds, verbatim.
export const QUALITY_THRESHOLDS = {
  precisionMin: 0.90,
  recallMin: 0.80,
  f1Min: 0.85,
  fprMax: 0.10,
} as const;

export interface QualityFilters {
  from?: Date;
  to?: Date;
  paramCode?: string;
  modality?: string;
  modelVersion?: string;
}

interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface Wilson {
  point: number | null;
  ci_95: [number, number] | null;
  n: number;
}

export interface MetricsGroup {
  key: string;
  param_code: string | null;
  modality: string | null;
  detection_method: string | null;
  counts: Counts;
  precision: Wilson;
  recall: Wilson;
  f1: number | null;
  false_positive_rate: Wilson;
  thresholds: typeof QUALITY_THRESHOLDS;
  pass: {
    precision: boolean | null;
    recall: boolean | null;
    f1: boolean | null;
    false_positive_rate: boolean | null;
    overall: boolean | null;
  };
}

export interface QualityMetricsResponse {
  filters: {
    from: string | null;
    to: string | null;
    param_code: string | null;
    modality: string | null;
    model_version: string | null;
  };
  overall: MetricsGroup;
  by_modality: MetricsGroup[];
  by_param: MetricsGroup[];
  rejection_reasons: Array<{ reason_code: string; count: number }>;
  sample_size: number;
}

// z=1.96 for a 95% Wilson score interval - section 14.3 asks for the point
// estimate to travel with a 95% CI and the sample size it was measured on,
// not just a bare number.
function wilson(successes: number, n: number): Wilson {
  if (n === 0) return { point: null, ci_95: null, n: 0 };
  const z = 1.96;
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return {
    point: phat,
    ci_95: [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)],
    n,
  };
}

function computeGroup(key: string, param_code: string | null, modality: string | null, detection_method: string | null, counts: Counts): MetricsGroup {
  const precision = wilson(counts.tp, counts.tp + counts.fp);
  const recall = wilson(counts.tp, counts.tp + counts.fn);
  const fpr = wilson(counts.fp, counts.fp + counts.tn);
  const f1 = precision.point !== null && recall.point !== null && (precision.point + recall.point) > 0
    ? (2 * precision.point * recall.point) / (precision.point + recall.point)
    : null;

  const precisionPass = precision.point === null ? null : precision.point >= QUALITY_THRESHOLDS.precisionMin;
  const recallPass = recall.point === null ? null : recall.point >= QUALITY_THRESHOLDS.recallMin;
  const f1Pass = f1 === null ? null : f1 >= QUALITY_THRESHOLDS.f1Min;
  const fprPass = fpr.point === null ? null : fpr.point <= QUALITY_THRESHOLDS.fprMax;
  // Section 14.3: "Система не считается принятой при недостижении любого
  // обязательного порога" - overall is null (no evidence yet) only when
  // every individual check is null; otherwise it fails on the first false.
  const checks = [precisionPass, recallPass, f1Pass, fprPass];
  const overallPass = checks.every((c) => c === null) ? null : checks.every((c) => c !== false);

  return {
    key, param_code, modality, detection_method,
    counts,
    precision, recall, f1, false_positive_rate: fpr,
    thresholds: QUALITY_THRESHOLDS,
    pass: { precision: precisionPass, recall: recallPass, f1: f1Pass, false_positive_rate: fprPass, overall: overallPass },
  };
}

function emptyCounts(): Counts {
  return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

// TP: engine raised it (CANDIDATE) and the inspector confirmed it.
// FP: engine raised it (CANDIDATE) and the inspector rejected it.
// FN: the inspector confirmed a violation the engine never raised as a
// candidate (a promoted free-search hypothesis, engine_status SUSPICION, or
// null for anything else an inspector alone could not have confirmed).
// TN: the engine's own NEGATIVE_VERIFIED - never was a candidate.
function classify(label: { label: string; engineStatus: string | null }): keyof Counts {
  const wasCandidate = label.engineStatus === 'CANDIDATE';
  if (label.label === 'POSITIVE') return wasCandidate ? 'tp' : 'fn';
  return wasCandidate ? 'fp' : 'tn';
}

export async function computeQualityMetrics(filters: QualityFilters, db: Db = prisma): Promise<QualityMetricsResponse> {
  const where: Prisma.GoldLabelWhereInput = {
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
    ...(filters.paramCode ? { paramCode: filters.paramCode } : {}),
    ...(filters.modality ? { modality: filters.modality } : {}),
    ...(filters.modelVersion ? { modelVersion: filters.modelVersion } : {}),
  };

  const labels = await db.goldLabel.findMany({
    where,
    select: { paramCode: true, modality: true, detectionMethod: true, label: true, engineStatus: true, reasonCode: true },
  });

  const overallCounts = emptyCounts();
  const byModality = new Map<string, Counts>();
  const byParam = new Map<string, Counts>();
  const rejectionReasons = new Map<string, number>();

  for (const row of labels) {
    const bucket = classify(row);
    overallCounts[bucket] += 1;

    const modalityKey = row.modality ?? 'UNKNOWN';
    if (!byModality.has(modalityKey)) byModality.set(modalityKey, emptyCounts());
    byModality.get(modalityKey)![bucket] += 1;

    if (!byParam.has(row.paramCode)) byParam.set(row.paramCode, emptyCounts());
    byParam.get(row.paramCode)![bucket] += 1;

    if (row.label === 'NEGATIVE' && row.reasonCode) {
      rejectionReasons.set(row.reasonCode, (rejectionReasons.get(row.reasonCode) ?? 0) + 1);
    }
  }

  const overall = computeGroup('overall', filters.paramCode ?? null, filters.modality ?? null, null, overallCounts);

  // Best-effort: these gauges are the "default" (whatever filters the
  // caller asked for) view - a caller who narrows to one param/modality
  // still updates them, same as the scheduled weekly report's own
  // unfiltered call does. See metrics.ts's own comment on why only three
  // gauges (precision/recall/FPR) are exposed, not every field here.
  if (overall.precision.point !== null) qualityPrecisionGauge.set({ modality: filters.modality ?? 'all' }, overall.precision.point);
  if (overall.recall.point !== null) qualityRecallGauge.set({ modality: filters.modality ?? 'all' }, overall.recall.point);
  if (overall.false_positive_rate.point !== null) qualityFprGauge.set({ modality: filters.modality ?? 'all' }, overall.false_positive_rate.point);

  return {
    filters: {
      from: filters.from?.toISOString() ?? null,
      to: filters.to?.toISOString() ?? null,
      param_code: filters.paramCode ?? null,
      modality: filters.modality ?? null,
      model_version: filters.modelVersion ?? null,
    },
    overall,
    by_modality: [...byModality.entries()].map(([modality, counts]) => computeGroup(modality, null, modality, null, counts)),
    by_param: [...byParam.entries()].map(([paramCode, counts]) => computeGroup(paramCode, paramCode, null, null, counts)),
    rejection_reasons: [...rejectionReasons.entries()].map(([reason_code, count]) => ({ reason_code, count })),
    sample_size: labels.length,
  };
}
