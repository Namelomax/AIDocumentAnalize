import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { visibleCheckWhere } from '../checks/visibility.js';
import { indicatorFor, type LatestProtocolForIndicator } from '../objects/indicator.js';

const createSchema = z.object({
  // trim() before min(1): without it a name of spaces passes validation and
  // the inspector gets a supervision case with no readable title. The upper
  // bound keeps a stray paste out of an unbounded TEXT column.
  name: z.string().trim().min(1).max(500),
  address: z.string().optional(),
  customer: z.string().optional(),
  contractor: z.string().optional(),
  permit_number: z.string().optional(),
});

const objectParamsSchema = z.object({ object_id: z.string().uuid() });

// The stage completeness the dashboard shows for an object, taken from its
// most recent process. null across the board means the object has no
// process yet - nothing was ever uploaded for it.
interface Completeness {
  pd: string | null;
  rd: string | null;
  id: string | null;
}

function completenessOf(
  process: { pdCompleteness: string | null; rdCompleteness: string | null; idCompleteness: string | null } | null,
): Completeness {
  return {
    pd: process?.pdCompleteness ?? null,
    rd: process?.rdCompleteness ?? null,
    id: process?.idCompleteness ?? null,
  };
}

interface LatestProtocolCounts {
  protocolId: string | null;
  protocolVersion: number | null;
  protocolStatus: string | null;
  confirmed: number;
  candidates: number;
  clarifications: number;
}

// For a set of process ids, the highest-version protocol of each plus the
// finding counts indicatorFor needs - two queries total, whatever the number
// of processes asked for. GET /objects lists every object on the stand at
// once, and section 9.5 leaves no budget in the 200ms p95 for a query per row.
async function latestProtocolCountsByProcess(processIds: string[]): Promise<Map<string, LatestProtocolCounts>> {
  const result = new Map<string, LatestProtocolCounts>();
  if (processIds.length === 0) return result;

  const protocols = await prisma.protocol.findMany({
    where: { processId: { in: processIds } },
    orderBy: { version: 'desc' },
    select: { id: true, processId: true, version: true, status: true },
  });
  // Protocols come back version-descending, so the first row seen per
  // process is already its highest version.
  const latestByProcess = new Map<string, (typeof protocols)[number]>();
  for (const protocol of protocols) {
    if (!latestByProcess.has(protocol.processId)) latestByProcess.set(protocol.processId, protocol);
  }

  const grouped = await prisma.check.groupBy({
    by: ['processId', 'findingStatus'],
    // An unsplit composite counts once, under its own CANDIDATE row; its
    // hidden atoms never count at all (checks/visibility.ts).
    where: { processId: { in: processIds }, ...visibleCheckWhere },
    _count: { _all: true },
  });
  const countsByProcess = new Map<string, { confirmed: number; candidates: number; clarifications: number }>();
  for (const row of grouped) {
    const entry = countsByProcess.get(row.processId) ?? { confirmed: 0, candidates: 0, clarifications: 0 };
    if (row.findingStatus === 'CONFIRMED_VIOLATION') entry.confirmed += row._count._all;
    if (row.findingStatus === 'CANDIDATE') entry.candidates += row._count._all;
    if (row.findingStatus === 'CLARIFICATION_REQUIRED') entry.clarifications += row._count._all;
    countsByProcess.set(row.processId, entry);
  }

  for (const processId of processIds) {
    const protocol = latestByProcess.get(processId) ?? null;
    const counts = countsByProcess.get(processId) ?? { confirmed: 0, candidates: 0, clarifications: 0 };
    result.set(processId, {
      protocolId: protocol?.id ?? null,
      protocolVersion: protocol?.version ?? null,
      protocolStatus: protocol?.status ?? null,
      ...counts,
    });
  }
  return result;
}

function indicatorInput(counts: LatestProtocolCounts | undefined): LatestProtocolForIndicator | null {
  if (!counts?.protocolId) return null;
  return {
    status: counts.protocolStatus!,
    confirmed: counts.confirmed,
    candidates: counts.candidates,
    clarifications: counts.clarifications,
  };
}

export async function objectRoutes(app: FastifyInstance) {
  app.post('/api/v1/objects', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED', details: parsed.error.issues });
    }

    const created = await prisma.constructionObject.create({
      data: {
        name: parsed.data.name,
        address: parsed.data.address,
        customer: parsed.data.customer,
        contractor: parsed.data.contractor,
        permitNumber: parsed.data.permit_number,
      },
    });

    await audit(request, 'OBJECT_CREATED', created.id);

    return reply.code(201).send({
      id: created.id,
      name: created.name,
      address: created.address,
      customer: created.customer,
      contractor: created.contractor,
      permit_number: created.permitNumber,
    });
  });

  app.get('/api/v1/objects', async () => {
    const objects = await prisma.constructionObject.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { files: true } },
        processes: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true, status: true, updatedAt: true,
            pdCompleteness: true, rdCompleteness: true, idCompleteness: true,
          },
        },
      },
    });

    const latestProcessIds = objects
      .map((o) => o.processes[0]?.id)
      .filter((id): id is string => Boolean(id));
    const protocolCounts = await latestProtocolCountsByProcess(latestProcessIds);

    return {
      items: objects.map((o) => {
        const latestProcess = o.processes[0] ?? null;
        const counts = latestProcess ? protocolCounts.get(latestProcess.id) : undefined;
        return {
          id: o.id,
          name: o.name,
          address: o.address,
          files_count: o._count.files,
          last_process_status: latestProcess?.status ?? null,
          customer: o.customer,
          contractor: o.contractor,
          permit_number: o.permitNumber,
          completeness: completenessOf(latestProcess),
          process_status: latestProcess?.status ?? null,
          latest_process_id: latestProcess?.id ?? null,
          latest_protocol_id: counts?.protocolId ?? null,
          candidates: counts?.candidates ?? 0,
          confirmed: counts?.confirmed ?? 0,
          updated_at: latestProcess?.updatedAt ?? null,
          indicator: indicatorFor(indicatorInput(counts)),
        };
      }),
    };
  });

  app.get('/api/v1/objects/:object_id', async (request, reply) => {
    const parsed = objectParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const object = await prisma.constructionObject.findUnique({
      where: { id: parsed.data.object_id },
      include: {
        _count: { select: { files: true } },
        processes: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, status: true, scenario: true, createdAt: true, updatedAt: true,
            pdCompleteness: true, rdCompleteness: true, idCompleteness: true,
          },
        },
      },
    });
    if (!object) return reply.code(404).send({ error: 'OBJECT_NOT_FOUND' });

    const processIds = object.processes.map((p) => p.id);
    const protocolCounts = await latestProtocolCountsByProcess(processIds);

    const latestProcess = object.processes[0] ?? null;
    const latestCounts = latestProcess ? protocolCounts.get(latestProcess.id) : undefined;

    return {
      id: object.id,
      name: object.name,
      address: object.address,
      files_count: object._count.files,
      last_process_status: latestProcess?.status ?? null,
      customer: object.customer,
      contractor: object.contractor,
      permit_number: object.permitNumber,
      completeness: completenessOf(latestProcess),
      process_status: latestProcess?.status ?? null,
      latest_process_id: latestProcess?.id ?? null,
      latest_protocol_id: latestCounts?.protocolId ?? null,
      candidates: latestCounts?.candidates ?? 0,
      confirmed: latestCounts?.confirmed ?? 0,
      updated_at: latestProcess?.updatedAt ?? null,
      indicator: indicatorFor(indicatorInput(latestCounts)),
      // Newest first, same order as processes were fetched in.
      processes: object.processes.map((p) => {
        const counts = protocolCounts.get(p.id);
        return {
          process_id: p.id,
          status: p.status,
          scenario: p.scenario,
          created_at: p.createdAt,
          protocol_id: counts?.protocolId ?? null,
          protocol_version: counts?.protocolVersion ?? null,
        };
      }),
    };
  });

  app.get('/api/v1/objects/:object_id/files', async (request, reply) => {
    const parsed = objectParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const object = await prisma.constructionObject.findUnique({ where: { id: parsed.data.object_id } });
    if (!object) return reply.code(404).send({ error: 'OBJECT_NOT_FOUND' });

    // page_count comes from pages, not files.page_count: the worker never
    // writes that column (see routes/objects.ts callers / Plan 7), so it is
    // counted here instead of trusting a column that is always empty.
    const files = await prisma.fileRecord.findMany({
      where: { objectId: parsed.data.object_id },
      orderBy: { uploadedAt: 'asc' },
      include: { _count: { select: { pages: true } } },
    });

    return {
      items: files.map((file) => ({
        id: file.id,
        file_name: file.fileName,
        doc_stage: file.docStage,
        discipline: file.discipline,
        document_code: file.documentCode,
        revision: file.revision,
        approval_status: file.approvalStatus,
        page_count: file._count.pages,
        size_bytes: file.sizeBytes,
        file_sha256: file.fileHash,
        from_manifest: file.fromManifest,
        uploaded_at: file.uploadedAt,
        process_id: file.processId,
      })),
    };
  });
}
