// Section 9.3: "В ИАИС «РиН» передаются только подтверждённые инспектором
// записи вместе с версиями протокола, Матрицы, модели и реестром входных
// файлов." This module builds exactly that JSON body and its SHA-256, for a
// finalized protocol - never anything an inspector has not confirmed.
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { sha256 } from '../storage.js';
import { visibleCheckWhere } from '../checks/visibility.js';

// Accepts either the module-level client or a $transaction's `tx`, so the
// scheduler (integration/transfers.ts) can build the payload from inside the
// same transaction it records the send's outcome in - the payload it sent
// and the row describing that it sent it are then never inconsistent with
// each other, whatever else committed to the database in between.
type Db = PrismaClient | Prisma.TransactionClient;

const inputFileSchema = z.object({
  file_name: z.string(),
  stage: z.string().nullable(),
  document_code: z.string().nullable(),
  revision: z.string().nullable(),
  sha256: z.string().length(64),
});

const evidenceSchema = z.object({
  file_id: z.string().uuid(),
  file_sha256: z.string().length(64),
  sheet_page: z.number().int(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

const findingSchema = z.object({
  finding_id: z.string().uuid(),
  param_code: z.string(),
  expected_value: z.string().nullable(),
  actual_value: z.string().nullable(),
  rationale: z.string().nullable(),
  inspector: z.object({ id: z.string(), full_name: z.string().nullable() }),
  reason_code: z.string().nullable(),
  decided_at: z.string(),
  evidence: z.array(evidenceSchema),
});

// Section 9.6's payload: "protocol id/version, process id, object,
// matrix/model/dataset versions, input_manifest_hash and the list of input
// files ..., and only CONFIRMED_VIOLATION findings with their evidence".
export const rinPayloadSchema = z.object({
  protocol_id: z.string().uuid(),
  protocol_version: z.number().int(),
  process_id: z.string().uuid(),
  object: z.object({
    id: z.string().uuid(),
    name: z.string(),
    address: z.string().nullable(),
    permit_number: z.string().nullable(),
  }),
  matrix_version: z.string(),
  model_version: z.string(),
  dataset_version: z.string(),
  input_manifest_hash: z.string(),
  input_files: z.array(inputFileSchema),
  findings: z.array(findingSchema),
});

export type RinPayload = z.infer<typeof rinPayloadSchema>;

export interface BuiltTransfer {
  payload: RinPayload;
  payloadHash: string;
  protocol: { id: string; objectId: string; processId: string; version: number };
}

export async function buildTransferPayload(protocolId: string, db: Db = prisma): Promise<BuiltTransfer> {
  const protocol = await db.protocol.findUniqueOrThrow({ where: { id: protocolId } });

  const [object, files, checks] = await Promise.all([
    db.constructionObject.findUniqueOrThrow({ where: { id: protocol.objectId } }),
    db.fileRecord.findMany({ where: { processId: protocol.processId } }),
    db.check.findMany({
      where: { processId: protocol.processId, findingStatus: 'CONFIRMED_VIOLATION', ...visibleCheckWhere },
      include: { fragments: true },
    }),
  ]);

  const inspectorIds = [...new Set(checks.map((c) => c.verifiedBy).filter((id): id is string => Boolean(id)))];
  const inspectors = inspectorIds.length > 0
    ? await db.user.findMany({ where: { id: { in: inspectorIds } } })
    : [];
  const inspectorsById = new Map(inspectors.map((u) => [u.id, u]));

  const payload: RinPayload = {
    protocol_id: protocol.id,
    protocol_version: protocol.version,
    process_id: protocol.processId,
    object: {
      id: object.id,
      name: object.name,
      address: object.address,
      permit_number: object.permitNumber,
    },
    matrix_version: protocol.matrixVersion,
    model_version: protocol.modelVersion,
    dataset_version: protocol.datasetVersion,
    input_manifest_hash: protocol.inputManifestHash,
    input_files: files.map((f) => ({
      file_name: f.fileName,
      stage: f.docStage,
      document_code: f.documentCode,
      revision: f.revision,
      sha256: f.fileHash,
    })),
    findings: checks.map((c) => ({
      finding_id: c.id,
      param_code: c.paramCode,
      expected_value: c.expectedValue,
      actual_value: c.actualValue,
      rationale: c.rationale,
      inspector: {
        id: c.verifiedBy ?? '',
        full_name: c.verifiedBy ? (inspectorsById.get(c.verifiedBy)?.fullName ?? null) : null,
      },
      reason_code: c.verdictReasonCode,
      decided_at: (c.verifiedAt ?? c.createdAt).toISOString(),
      evidence: c.fragments.map((fr) => ({
        file_id: fr.fileId,
        file_sha256: fr.fileSha256,
        sheet_page: fr.sheetPage,
        bbox: [fr.x0, fr.y0, fr.x1, fr.y1] as [number, number, number, number],
      })),
    })),
  };

  // Validated before it ever reaches the network - the customer's ТЗ 1.3
  // "обязательная валидация схемы" applies to what leaves this system, not
  // only to what enters it.
  const parsed = rinPayloadSchema.parse(payload);
  const payloadHash = sha256(Buffer.from(JSON.stringify(parsed)));

  return {
    payload: parsed,
    payloadHash,
    protocol: { id: protocol.id, objectId: protocol.objectId, processId: protocol.processId, version: protocol.version },
  };
}
