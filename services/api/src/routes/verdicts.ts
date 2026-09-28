import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Check } from '@prisma/client';
import { prisma } from '../db.js';
import { requireRole } from '../auth/plugin.js';
import { audit } from '../audit.js';
import { compositeSplitsTotal, finalizationsTotal, verdictsTotal } from '../metrics.js';
import { visibleCheckWhere } from '../checks/visibility.js';
import { buildFinding, type CheckWithFragments } from '../protocol/view.js';
import { paramsByCode, inspectorsById, atomsByParent, loadProtocolResponse } from './protocols.js';

const checkParamsSchema = z.object({ check_id: z.string().uuid() });
const protocolParamsSchema = z.object({ protocol_id: z.string().uuid() });

// The decisions an inspector can hand down (section 9.2/9.3). CANDIDATE is
// never one of them - only the engine ever produces a candidate.
const DECISIONS = ['CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED', 'CLARIFICATION_REQUIRED'] as const;

// Reason codes from the designer's interface (section 9.3 states the reasons
// in words; the codes are the interface's own vocabulary for them).
const REASON_CODES = [
  'WRONG_REVISION',
  'APPROVED_CHANGE',
  'OCR_ERROR',
  'BINDING_ERROR',
  'NOT_APPLICABLE',
  'OTHER',
] as const;

const verdictBodySchema = z.object({
  decision: z.enum(DECISIONS),
  reason_code: z.enum(REASON_CODES).optional(),
  comment: z.string().optional(),
  // Only meaningful when the inspector is resolving a revision conflict
  // (section 9.2); the route stores it as given, without checking here that
  // the file actually belongs to this check's evidence.
  authoritative_file_id: z.string().uuid().optional(),
});

const unfinalizeBodySchema = z.object({ reason: z.string().trim().min(1) });

// A finding is open to a verdict when the engine still calls it a candidate,
// or when an inspector already decided it and is revising that decision
// before finalization. Everything else - no finding_status at all
// (completeness only), or the engine's own NEGATIVE_VERIFIED - never was and
// never became a candidate.
function isDecidable(check: Check): boolean {
  if (check.findingStatus === 'CANDIDATE') return true;
  if (check.findingStatus === 'CLARIFICATION_REQUIRED') return true;
  return check.verifiedBy !== null;
}

// Section 9.2's "нельзя подтвердить частично": a composite candidate
// (checks with atoms of their own, none split yet) must be split into its
// atomic findings before any one of them can be decided.
const COMPOSITE_NOT_SPLIT_MESSAGE =
  'Составной кандидат нельзя подтвердить частично — сначала разделите его на атомарные находки';

async function findingResponse(check: CheckWithFragments) {
  const [params, inspectors, atoms] = await Promise.all([
    paramsByCode([check]), inspectorsById([check]), atomsByParent([check]),
  ]);
  return buildFinding(check, params.get(check.paramCode), inspectors, atoms.get(check.id));
}

export async function verdictRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/findings/:check_id/verdict',
    { preHandler: requireRole('INSPECTOR', 'SUPERVISOR', 'ADMIN') },
    async (request, reply) => {
      const paramsParsed = checkParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const bodyParsed = verdictBodySchema.safeParse(request.body);
      if (!bodyParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
      const body = bodyParsed.data;

      // Section 9.3: a rejection carries a coded reason and a comment. The
      // database backs this with a CHECK constraint (rejection_requires_reason);
      // this is the readable 400 a caller gets before ever reaching it.
      if (body.decision === 'NEGATIVE_VERIFIED' && (!body.reason_code || !body.comment?.trim())) {
        return reply.code(400).send({ error: 'REJECTION_REQUIRES_REASON' });
      }

      const check = await prisma.check.findUnique({
        where: { id: paramsParsed.data.check_id },
        include: { parent: true, atoms: { select: { id: true } } },
      });
      if (!check) return reply.code(404).send({ error: 'FINDING_NOT_FOUND' });

      const protocol = await prisma.protocol.findFirst({
        where: { processId: check.processId },
        orderBy: { version: 'desc' },
      });
      if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

      // Section 9.3: once finalized, no further decision on that process.
      if (protocol.status === 'PROTOCOL_FINALIZED') {
        return reply.code(409).send({ error: 'PROTOCOL_FINALIZED' });
      }

      // A composite candidate cannot be decided as a whole - it must be
      // split first (POST /api/v1/findings/:id/split).
      if (check.atoms.length > 0 && check.splitAt === null) {
        return reply.code(409).send({ error: 'COMPOSITE_NOT_SPLIT', message: COMPOSITE_NOT_SPLIT_MESSAGE });
      }
      // An atom of a composite that has not been split yet is not a finding
      // of its own - same visibility rule as everywhere else it is checked
      // (checks/visibility.ts), enforced here too against a direct call.
      if (check.parentCheckId !== null && check.parent?.splitAt == null) {
        return reply.code(409).send({ error: 'NOT_A_CANDIDATE' });
      }

      if (!isDecidable(check)) {
        return reply.code(409).send({ error: 'NOT_A_CANDIDATE' });
      }

      // Section 9.2: the pair "what the engine said / what the inspector
      // decided" is set once, on the first decision, and never overwritten by
      // a later change of mind.
      const engineStatus = check.engineStatus ?? check.findingStatus;

      const updated = await prisma.$transaction(async (tx) => {
        const updatedCheck = await tx.check.update({
          where: { id: check.id },
          data: {
            findingStatus: body.decision,
            engineStatus,
            verifiedBy: request.user.id,
            verifiedAt: new Date(),
            verdictReasonCode: body.reason_code ?? null,
            verdictComment: body.comment ?? null,
            authoritativeFileId: body.authoritative_file_id ?? check.authoritativeFileId,
          },
          include: { fragments: true },
        });

        // Section 9.4: every rejection is a negative example for retraining,
        // paired with what the system had said.
        if (body.decision === 'NEGATIVE_VERIFIED') {
          await tx.rejectionLog.create({
            data: {
              checkId: check.id,
              rejectionReason: body.reason_code!,
              aiVerdict: engineStatus!,
              comment: body.comment!,
            },
          });
        }

        // Section 9.3, algorithm step 4: the process and its protocol track
        // verification as it happens - VERIFYING while candidates remain,
        // VERIFICATION_COMPLETED once none do.
        const remainingCandidates = await tx.check.count({
          where: { processId: check.processId, findingStatus: 'CANDIDATE', ...visibleCheckWhere },
        });
        const done = remainingCandidates === 0;
        await tx.protocol.update({
          where: { id: protocol.id },
          data: { status: done ? 'VERIFICATION_COMPLETED' : 'VERIFYING' },
        });
        await tx.process.update({
          where: { id: check.processId },
          data: { status: done ? 'COMPLETED' : 'VERIFYING' },
        });

        return updatedCheck;
      });

      verdictsTotal.labels(body.decision).inc();

      await audit(request, 'VERDICT', check.objectId, {
        check_id: check.id,
        decision: body.decision,
        reason_code: body.reason_code ?? null,
      });

      return findingResponse(updated as CheckWithFragments);
    },
  );

  app.post(
    '/api/v1/findings/:check_id/split',
    { preHandler: requireRole('INSPECTOR', 'SUPERVISOR', 'ADMIN') },
    async (request, reply) => {
      const paramsParsed = checkParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const check = await prisma.check.findUnique({
        where: { id: paramsParsed.data.check_id },
        include: { atoms: true },
      });
      if (!check) return reply.code(404).send({ error: 'FINDING_NOT_FOUND' });

      // Only a composite - a check with atoms of its own - can be split.
      if (check.atoms.length === 0) return reply.code(409).send({ error: 'NOT_A_COMPOSITE' });
      if (check.splitAt !== null) return reply.code(409).send({ error: 'ALREADY_SPLIT' });

      const protocol = await prisma.protocol.findFirst({
        where: { processId: check.processId },
        orderBy: { version: 'desc' },
      });
      if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

      if (protocol.status === 'PROTOCOL_FINALIZED') {
        return reply.code(409).send({ error: 'PROTOCOL_FINALIZED' });
      }

      // The atoms already exist (the worker inserted them alongside the
      // composite - app.db.save_checks); splitting only ever reveals them by
      // setting split_at, it never creates or copies a row.
      const updated = await prisma.check.update({
        where: { id: check.id },
        data: { splitBy: request.user.id, splitAt: new Date() },
        include: { atoms: { include: { fragments: true } } },
      });

      compositeSplitsTotal.inc();

      await audit(request, 'COMPOSITE_SPLIT', check.objectId, {
        check_id: check.id,
        atom_ids: updated.atoms.map((atom) => atom.id),
      });

      const atoms = updated.atoms as CheckWithFragments[];
      const [params, inspectors] = await Promise.all([paramsByCode(atoms), inspectorsById(atoms)]);
      return { atoms: atoms.map((atom) => buildFinding(atom, params.get(atom.paramCode), inspectors)) };
    },
  );

  app.post(
    '/api/v1/findings/:check_id/promote',
    { preHandler: requireRole('INSPECTOR', 'SUPERVISOR', 'ADMIN') },
    async (request, reply) => {
      const paramsParsed = checkParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const check = await prisma.check.findUnique({ where: { id: paramsParsed.data.check_id } });
      if (!check) return reply.code(404).send({ error: 'FINDING_NOT_FOUND' });

      // Section 9.5: the only action left once a hypothesis's evidence is
      // already attached is turning it into a candidate - anything that
      // already went further (a candidate, a decided finding, completeness
      // only) was never a hypothesis to begin with.
      if (check.findingStatus !== 'SUSPICION') {
        return reply.code(409).send({ error: 'NOT_A_SUSPICION' });
      }

      const protocol = await prisma.protocol.findFirst({
        where: { processId: check.processId },
        orderBy: { version: 'desc' },
      });
      if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

      if (protocol.status === 'PROTOCOL_FINALIZED') {
        return reply.code(409).send({ error: 'PROTOCOL_FINALIZED' });
      }

      // Section 9.2: the pair "what the engine said / what the inspector
      // decided" is set once. A promoted hypothesis was the engine's own
      // SUSPICION - that is what it stays for engine_status, exactly as an
      // ordinary candidate keeps whatever the engine originally called it.
      const engineStatus = check.engineStatus ?? 'SUSPICION';

      const updated = await prisma.$transaction(async (tx) => {
        const updatedCheck = await tx.check.update({
          where: { id: check.id },
          data: { findingStatus: 'CANDIDATE', engineStatus },
          include: { fragments: true },
        });

        // A promoted hypothesis is a fresh, undecided candidate - if the
        // protocol/process had already moved past verification, it reopens,
        // same as any other candidate that newly needed a decision would
        // (section 9.3).
        if (protocol.status === 'VERIFICATION_COMPLETED') {
          await tx.protocol.update({ where: { id: protocol.id }, data: { status: 'VERIFYING' } });
        }
        const process = await tx.process.findUniqueOrThrow({ where: { id: check.processId } });
        if (process.status === 'COMPLETED') {
          await tx.process.update({ where: { id: check.processId }, data: { status: 'VERIFYING' } });
        }

        return updatedCheck;
      });

      await audit(request, 'SUSPICION_PROMOTED', check.objectId, { check_id: check.id });

      return findingResponse(updated as CheckWithFragments);
    },
  );

  app.post(
    '/api/v1/protocols/:protocol_id/finalize',
    { preHandler: requireRole('INSPECTOR', 'SUPERVISOR', 'ADMIN') },
    async (request, reply) => {
      const parsed = protocolParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const protocol = await prisma.protocol.findUnique({ where: { id: parsed.data.protocol_id } });
      if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

      if (protocol.status === 'PROTOCOL_FINALIZED') {
        return reply.code(409).send({ error: 'ALREADY_FINALIZED' });
      }

      // Section 9.3, algorithm step 4: finalization is refused while any
      // candidate is still undecided, and the inspector is told which ones.
      const pending = await prisma.check.findMany({
        where: { processId: protocol.processId, findingStatus: 'CANDIDATE', ...visibleCheckWhere },
        select: { id: true },
      });
      if (pending.length > 0) {
        return reply.code(409).send({ error: 'CANDIDATES_PENDING', check_ids: pending.map((c) => c.id) });
      }

      await prisma.$transaction(async (tx) => {
        await tx.protocol.update({
          where: { id: protocol.id },
          data: { status: 'PROTOCOL_FINALIZED', finalizedAt: new Date(), finalizedBy: request.user.id },
        });
        await tx.process.update({ where: { id: protocol.processId }, data: { status: 'FINALIZED' } });
      });

      finalizationsTotal.inc();

      await audit(request, 'PROTOCOL_FINALIZED', protocol.objectId, { protocol_id: protocol.id });

      const refreshed = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      return loadProtocolResponse(refreshed);
    },
  );

  app.post(
    '/api/v1/protocols/:protocol_id/unfinalize',
    // Section 9.3: only an administrator or a supervisor may undo a
    // finalization - an inspector who finalized it cannot take it back alone.
    { preHandler: requireRole('SUPERVISOR', 'ADMIN') },
    async (request, reply) => {
      const parsed = protocolParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

      const bodyParsed = unfinalizeBodySchema.safeParse(request.body);
      if (!bodyParsed.success) return reply.code(400).send({ error: 'REASON_REQUIRED' });

      const protocol = await prisma.protocol.findUnique({ where: { id: parsed.data.protocol_id } });
      if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

      if (protocol.status !== 'PROTOCOL_FINALIZED') {
        return reply.code(409).send({ error: 'NOT_FINALIZED' });
      }

      await prisma.$transaction(async (tx) => {
        await tx.protocol.update({
          where: { id: protocol.id },
          data: { status: 'VERIFICATION_COMPLETED', finalizedAt: null, finalizedBy: null },
        });
        await tx.process.update({ where: { id: protocol.processId }, data: { status: 'COMPLETED' } });
      });

      await audit(request, 'PROTOCOL_UNFINALIZED', protocol.objectId, {
        protocol_id: protocol.id,
        reason: bodyParsed.data.reason,
      });

      const refreshed = await prisma.protocol.findUniqueOrThrow({ where: { id: protocol.id } });
      return loadProtocolResponse(refreshed);
    },
  );
}
