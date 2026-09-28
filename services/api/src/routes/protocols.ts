import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Check, Protocol } from '@prisma/client';
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
