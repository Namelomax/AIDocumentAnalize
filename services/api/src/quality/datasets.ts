// Section 9.4's dataset_version: the curator ("куратор данных" - ML_ENGINEER
// or ADMIN, section 12's own "ML-инженер (доступ к... данным дообучения)")
// freezes a snapshot of the gold_labels ledger into a named, immutable
// release. This is the review step the ТЗ requires before a rejection's
// draft entry (services/api's RejectionLog) ever counts toward training -
// releasing IS that review, there is no separate approval step here.
import { createHash } from 'node:crypto';
import { prisma } from '../db.js';

export interface DatasetVersionView {
  id: string;
  version_tag: string;
  notes: string | null;
  manifest_hash: string;
  label_count: number;
  released_by: string;
  released_at: Date;
}

function manifestHash(labelIds: string[]): string {
  const sorted = [...labelIds].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

// `gold-YYYY.MM.DD` for the first release of a day, `-N` appended for any
// further one - readable next to model_version's own "rules-2026.09" shape
// rather than a bare uuid or timestamp.
async function autoVersionTag(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const base = `gold-${today}`;
  const sameDay = await prisma.datasetVersion.count({ where: { versionTag: { startsWith: base } } });
  return sameDay === 0 ? base : `${base}-${sameDay + 1}`;
}

// Freezes every gold label that exists right now (or, when given, exactly
// the caller's own subset - still validated to actually exist) into a new
// release. A label may be frozen into more than one release over time - see
// schema.prisma's own DatasetVersionLabel comment for why that is not a bug.
export async function releaseDatasetVersion(
  releasedBy: string,
  options: { versionTag?: string; notes?: string; labelIds?: string[] },
): Promise<DatasetVersionView> {
  const labelIds = options.labelIds && options.labelIds.length > 0
    ? (await prisma.goldLabel.findMany({ where: { id: { in: options.labelIds } }, select: { id: true } })).map((l) => l.id)
    : (await prisma.goldLabel.findMany({ select: { id: true } })).map((l) => l.id);

  const versionTag = options.versionTag?.trim() || await autoVersionTag();

  const created = await prisma.$transaction(async (tx) => {
    const version = await tx.datasetVersion.create({
      data: {
        versionTag,
        notes: options.notes ?? null,
        manifestHash: manifestHash(labelIds),
        labelCount: labelIds.length,
        releasedBy,
      },
    });
    if (labelIds.length > 0) {
      await tx.datasetVersionLabel.createMany({
        data: labelIds.map((goldLabelId) => ({ datasetVersionId: version.id, goldLabelId })),
      });
    }
    return version;
  });

  return toView(created);
}

function toView(v: { id: string; versionTag: string; notes: string | null; manifestHash: string; labelCount: number; releasedBy: string; releasedAt: Date }): DatasetVersionView {
  return {
    id: v.id, version_tag: v.versionTag, notes: v.notes, manifest_hash: v.manifestHash,
    label_count: v.labelCount, released_by: v.releasedBy, released_at: v.releasedAt,
  };
}

export async function listDatasetVersions(): Promise<DatasetVersionView[]> {
  const rows = await prisma.datasetVersion.findMany({ orderBy: { releasedAt: 'desc' } });
  return rows.map(toView);
}

export async function getDatasetVersion(id: string): Promise<DatasetVersionView | null> {
  const row = await prisma.datasetVersion.findUnique({ where: { id } });
  return row ? toView(row) : null;
}

// One JSON object per line (JSONL), the shape a training pipeline reads
// directly - every gold_labels column this release froze, unjoined so a
// later change to the live checks/evidence rows can never rewrite an
// already-released dataset out from under it.
export async function* exportDatasetVersionLines(id: string): AsyncGenerator<string> {
  const links = await prisma.datasetVersionLabel.findMany({
    where: { datasetVersionId: id },
    include: { goldLabel: true },
  });
  for (const link of links) {
    const g = link.goldLabel;
    yield JSON.stringify({
      id: g.id,
      check_id: g.checkId,
      protocol_id: g.protocolId,
      object_id: g.objectId,
      evidence_group_id: g.evidenceGroupId,
      param_code: g.paramCode,
      modality: g.modality,
      detection_method: g.detectionMethod,
      gold_label: g.label,
      engine_status: g.engineStatus,
      final_status: g.finalStatus,
      reason_code: g.reasonCode,
      expert_id: g.expertId,
      decided_at: g.decidedAt,
      matrix_version: g.matrixVersion,
      model_version: g.modelVersion,
      evidence: g.evidence,
    }) + '\n';
  }
}
