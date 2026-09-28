// Section 9.4/14.1's GOLD ledger: turns a finalized protocol's decided
// checks into gold_labels rows, and undoes that when the protocol is
// unfinalized (see schema.prisma's own GoldLabel comment for exactly which
// checks qualify and why). Called from routes/verdicts.ts's finalize and
// unfinalize handlers, inside the same transaction that flips the
// protocol's own status - a label must never exist for a protocol that is
// not (or no longer) the finalized truth.
import type { Prisma } from '@prisma/client';
import { visibleCheckWhere } from '../checks/visibility.js';

type Db = Prisma.TransactionClient;

// Section 14.1: positive only for CONFIRMED_VIOLATION, negative only for
// NEGATIVE_VERIFIED - see schema.prisma's GoldLabel comment for why the
// engine's own NEGATIVE_VERIFIED counts too, not only an inspector-reviewed
// rejection.
function labelFor(finalStatus: string): 'POSITIVE' | 'NEGATIVE' | null {
  if (finalStatus === 'CONFIRMED_VIOLATION') return 'POSITIVE';
  if (finalStatus === 'NEGATIVE_VERIFIED') return 'NEGATIVE';
  return null;
}

interface EvidenceSnapshot {
  role: string;
  file_id: string;
  file_sha256: string;
  stage: string;
  sheet_page: number;
  bbox: [number, number, number, number];
}

// Builds and inserts every GOLD label a just-finalized protocol earns.
// Idempotent against a protocol that already has labels (finalize only ever
// runs once without an unfinalize in between removing them first - see
// gold_labels' own unique([protocolId, checkId])), so a caller does not have
// to check first.
export async function createGoldLabelsForProtocol(
  tx: Db,
  protocol: { id: string; objectId: string; processId: string; matrixVersion: string; modelVersion: string },
): Promise<number> {
  const checks = await tx.check.findMany({
    where: {
      processId: protocol.processId,
      findingStatus: { in: ['CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED'] },
      ...visibleCheckWhere,
    },
    include: { fragments: true },
  });
  if (checks.length === 0) return 0;

  const paramCodes = [...new Set(checks.map((c) => c.paramCode))];
  const params = await tx.param.findMany({
    where: { code: { in: paramCodes } },
    select: { code: true, modality: true },
  });
  const modalityByCode = new Map(params.map((p) => [p.code, p.modality]));

  const rows: Prisma.GoldLabelCreateManyInput[] = [];
  for (const check of checks) {
    const label = labelFor(check.findingStatus!);
    if (!label) continue;
    const evidence: EvidenceSnapshot[] = check.fragments.map((f) => ({
      role: f.role,
      file_id: f.fileId,
      file_sha256: f.fileSha256,
      stage: f.stage,
      sheet_page: f.sheetPage,
      bbox: [f.x0, f.y0, f.x1, f.y1],
    }));
    rows.push({
      checkId: check.id,
      protocolId: protocol.id,
      objectId: protocol.objectId,
      processId: protocol.processId,
      evidenceGroupId: check.evidenceGroupId,
      paramCode: check.paramCode,
      modality: modalityByCode.get(check.paramCode) ?? null,
      detectionMethod: check.detectionMethod,
      label,
      engineStatus: check.engineStatus,
      finalStatus: check.findingStatus!,
      reasonCode: check.verdictReasonCode,
      expertId: check.verifiedBy,
      decidedAt: check.verifiedAt,
      matrixVersion: check.matrixVersion,
      modelVersion: protocol.modelVersion,
      evidence: evidence as unknown as Prisma.InputJsonValue,
    });
  }

  if (rows.length === 0) return 0;
  const result = await tx.goldLabel.createMany({ data: rows });
  return result.count;
}

// Section 9.3's own unfinalize semantics: a label made by a protocol that is
// no longer the finalized truth was never a final decision - removed in
// full, not marked stale, so every read of gold_labels stays a plain "what
// is final right now" without a status column to filter on.
export async function removeGoldLabelsForProtocol(tx: Db, protocolId: string): Promise<number> {
  const result = await tx.goldLabel.deleteMany({ where: { protocolId } });
  return result.count;
}
