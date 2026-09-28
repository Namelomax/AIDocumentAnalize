import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Check, Prisma, Protocol } from '@prisma/client';
import { prisma } from '../db.js';
import { visibleCheckWhere } from '../checks/visibility.js';
import {
  buildFinding,
  buildProtocolResponse,
  type CheckWithFragments,
  type InspectorForView,
  type ParamForView,
} from '../protocol/view.js';

const processParamsSchema = z.object({ process_id: z.string().uuid() });
const protocolParamsSchema = z.object({ protocol_id: z.string().uuid() });
const checkParamsSchema = z.object({ check_id: z.string().uuid() });

// Protocol.status is a plain varchar (schema.prisma), like finding_status
// above - the lifecycle from the same comment: READY -> VERIFYING ->
// VERIFICATION_COMPLETED -> PROTOCOL_FINALIZED.
const PROTOCOL_STATUSES = ['READY', 'VERIFYING', 'VERIFICATION_COMPLETED', 'PROTOCOL_FINALIZED'] as const;

const protocolsQuerySchema = z.object({
  status: z.enum(PROTOCOL_STATUSES).optional(),
  object_id: z.string().uuid().optional(),
  // Substring of the object's own name, matched case-insensitively - not a
  // full-text search, the "Протоколы" screen's own search box (task spec).
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// finding_status is a plain varchar column (see schema.prisma), not a Prisma
// enum, so the set of valid values the query can filter on is kept here.
const FINDING_STATUSES = [
  'CANDIDATE',
  'CONFIRMED_VIOLATION',
  'NEGATIVE_VERIFIED',
  'MISSING_EVIDENCE',
  'NOT_APPLICABLE',
  'NOT_COMPARABLE',
  'CLARIFICATION_REQUIRED',
  'SUSPICION',
] as const;

const findingsQuerySchema = z.object({ status: z.enum(FINDING_STATUSES).optional() });

// Both the parameter lookup and the inspector lookup are shared across every
// check of a protocol, so they are built once here instead of per row.
// Exported so routes/verdicts.ts assembles its responses through the same
// functions instead of re-querying params and inspectors on its own.
export async function paramsByCode(checks: Check[]): Promise<Map<string, ParamForView>> {
  const codes = [...new Set(checks.map((check) => check.paramCode))];
  const params = await prisma.param.findMany({ where: { code: { in: codes } } });
  return new Map(params.map((param) => [param.code, param]));
}

export async function inspectorsById(checks: Check[]): Promise<Map<string, InspectorForView>> {
  const ids = [...new Set(checks.map((check) => check.verifiedBy).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } } });
  return new Map(users.map((user) => [user.id, user]));
}

// An unsplit composite's own members, keyed by the composite's own check id.
// Deliberately not filtered through visibleCheckWhere: an atom is invisible
// as a *finding of its own* until its parent is split, but its data is
// exactly what the composite's own card (FindingView.composite) is for -
// showing the inspector what a split would produce.
export async function atomsByParent(checks: Check[]): Promise<Map<string, Check[]>> {
  const parentIds = checks.map((check) => check.id);
  if (parentIds.length === 0) return new Map();
  const atoms = await prisma.check.findMany({ where: { parentCheckId: { in: parentIds } } });
  const byParent = new Map<string, Check[]>();
  for (const atom of atoms) {
    const list = byParent.get(atom.parentCheckId!) ?? [];
    list.push(atom);
    byParent.set(atom.parentCheckId!, list);
  }
  return byParent;
}

const DEFAULT_LIST_LIMIT = 50;

interface ProtocolListCounts {
  awaitingDecision: number;
  confirmed: number;
  rejected: number;
  suspicions: number;
}

const EMPTY_LIST_COUNTS: ProtocolListCounts = { awaitingDecision: 0, confirmed: 0, rejected: 0, suspicions: 0 };

// The four counters GET /api/v1/protocols shows per row, for a page of
// protocols at once - one groupBy rather than one count query per protocol
// per counter, the same shape latestProtocolCountsByProcess (routes/objects.ts)
// uses for the object list. An unsplit composite counts once, under its own
// CANDIDATE row; its hidden atoms never count at all (checks/visibility.ts).
async function listCountsByProcess(processIds: string[]): Promise<Map<string, ProtocolListCounts>> {
  const result = new Map<string, ProtocolListCounts>();
  if (processIds.length === 0) return result;

  const grouped = await prisma.check.groupBy({
    by: ['processId', 'findingStatus'],
    where: { processId: { in: processIds }, ...visibleCheckWhere },
    _count: { _all: true },
  });
  for (const row of grouped) {
    const entry = result.get(row.processId) ?? { ...EMPTY_LIST_COUNTS };
    if (row.findingStatus === 'CANDIDATE') entry.awaitingDecision += row._count._all;
    if (row.findingStatus === 'CONFIRMED_VIOLATION') entry.confirmed += row._count._all;
    if (row.findingStatus === 'SUSPICION') entry.suspicions += row._count._all;
    result.set(row.processId, entry);
  }

  // "Отклонено" is what the inspector rejected, not every NEGATIVE_VERIFIED
  // row: the engine writes ~150 verified negatives per package itself, and
  // counting those would bury the handful of inspector rejections the column
  // is there to show. Only a verdict sets verified_by (routes/verdicts.ts).
  const rejected = await prisma.check.groupBy({
    by: ['processId'],
    where: {
      processId: { in: processIds },
      findingStatus: 'NEGATIVE_VERIFIED',
      verifiedBy: { not: null },
      ...visibleCheckWhere,
    },
    _count: { _all: true },
  });
  for (const row of rejected) {
    const entry = result.get(row.processId) ?? { ...EMPTY_LIST_COUNTS };
    entry.rejected = row._count._all;
    result.set(row.processId, entry);
  }
  return result;
}

export async function loadProtocolResponse(protocol: Protocol) {
  const checks = (await prisma.check.findMany({
    where: { processId: protocol.processId, ...visibleCheckWhere },
    include: { fragments: true },
    orderBy: { createdAt: 'asc' },
  })) as CheckWithFragments[];

  const [params, inspectors, atoms] = await Promise.all([
    paramsByCode(checks), inspectorsById(checks), atomsByParent(checks),
  ]);
  return buildProtocolResponse(protocol, checks, params, inspectors, atoms);
}

export async function protocolRoutes(app: FastifyInstance) {
  // The "Протоколы" screen's own list, across every object at once (task
  // spec) - unlike /processes/:id/protocol and /protocols/:id above, this
  // never loads a protocol's findings, only what a table row needs, so a
  // page of results stays a handful of queries regardless of how many
  // findings any one protocol carries.
  app.get('/api/v1/protocols', async (request, reply) => {
    const parsed = protocolsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const { status, object_id: objectId, q, limit, offset } = parsed.data;

    const where: Prisma.ProtocolWhereInput = {
      ...(status ? { status } : {}),
      ...(objectId ? { objectId } : {}),
      // Protocol carries no direct relation to ConstructionObject (only the
      // scalar object_id) - the name search goes through the process it
      // belongs to, which does declare that relation.
      ...(q ? { process: { object: { name: { contains: q, mode: 'insensitive' } } } } : {}),
    };

    const [total, protocols] = await Promise.all([
      prisma.protocol.count({ where }),
      prisma.protocol.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit ?? DEFAULT_LIST_LIMIT,
        skip: offset ?? 0,
      }),
    ]);

    if (protocols.length === 0) return { total, items: [] };

    const objectIds = [...new Set(protocols.map((protocol) => protocol.objectId))];
    const finalizerIds = [...new Set(
      protocols.map((protocol) => protocol.finalizedBy).filter((id): id is string => Boolean(id)),
    )];
    const processIds = protocols.map((protocol) => protocol.processId);

    const [objects, finalizers, counts] = await Promise.all([
      prisma.constructionObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true } }),
      finalizerIds.length > 0
        ? prisma.user.findMany({ where: { id: { in: finalizerIds } }, select: { id: true, fullName: true } })
        : Promise.resolve([]),
      listCountsByProcess(processIds),
    ]);
    const objectNamesById = new Map(objects.map((object) => [object.id, object.name]));
    const finalizerNamesById = new Map(finalizers.map((user) => [user.id, user.fullName]));

    return {
      total,
      items: protocols.map((protocol) => {
        const c = counts.get(protocol.processId) ?? EMPTY_LIST_COUNTS;
        return {
          id: protocol.id,
          object_id: protocol.objectId,
          object_name: objectNamesById.get(protocol.objectId) ?? '',
          version: protocol.version,
          status: protocol.status,
          created_at: protocol.createdAt,
          finalized_at: protocol.finalizedAt,
          finalized_by: protocol.finalizedBy ? (finalizerNamesById.get(protocol.finalizedBy) ?? null) : null,
          awaiting_decision: c.awaitingDecision,
          confirmed: c.confirmed,
          rejected: c.rejected,
          suspicions: c.suspicions,
        };
      }),
    };
  });

  app.get('/api/v1/processes/:process_id/protocol', async (request, reply) => {
    const parsed = processParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    // A process gets one protocol row per run (worker's create_protocol);
    // the highest version stands in for "the process's protocol" if more
    // than one was ever written for it.
    const protocol = await prisma.protocol.findFirst({
      where: { processId: parsed.data.process_id },
      orderBy: { version: 'desc' },
    });
    if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

    return loadProtocolResponse(protocol);
  });

  app.get('/api/v1/protocols/:protocol_id', async (request, reply) => {
    const parsed = protocolParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const protocol = await prisma.protocol.findUnique({ where: { id: parsed.data.protocol_id } });
    if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

    return loadProtocolResponse(protocol);
  });

  app.get('/api/v1/protocols/:protocol_id/findings', async (request, reply) => {
    const paramsParsed = protocolParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const queryParsed = findingsQuerySchema.safeParse(request.query);
    if (!queryParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const protocol = await prisma.protocol.findUnique({ where: { id: paramsParsed.data.protocol_id } });
    if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

    const checks = (await prisma.check.findMany({
      where: {
        processId: protocol.processId,
        // Completeness rows (finding_status null) never belong to this
        // listing - it answers only for findings, the other half of the
        // protocol stays under /protocols/:id.
        findingStatus: queryParsed.data.status ?? { not: null },
        ...visibleCheckWhere,
      },
      include: { fragments: true },
      orderBy: { createdAt: 'asc' },
    })) as CheckWithFragments[];

    const [params, inspectors, atoms] = await Promise.all([
      paramsByCode(checks), inspectorsById(checks), atomsByParent(checks),
    ]);
    return {
      items: checks.map((check) => buildFinding(
        check, params.get(check.paramCode), inspectors, atoms.get(check.id),
      )),
    };
  });

  app.get('/api/v1/findings/:check_id', async (request, reply) => {
    const parsed = checkParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const check = (await prisma.check.findFirst({
      where: { id: parsed.data.check_id, ...visibleCheckWhere },
      include: { fragments: true },
    })) as CheckWithFragments | null;
    if (!check) return reply.code(404).send({ error: 'FINDING_NOT_FOUND' });

    const [params, inspectors, atoms] = await Promise.all([
      paramsByCode([check]), inspectorsById([check]), atomsByParent([check]),
    ]);
    return buildFinding(check, params.get(check.paramCode), inspectors, atoms.get(check.id));
  });
}
