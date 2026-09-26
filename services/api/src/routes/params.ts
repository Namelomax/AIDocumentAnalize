import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Param } from '@prisma/client';
import { prisma } from '../db.js';

const querySchema = z.object({
  section: z.string().trim().min(1).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  // Query strings carry text, so "false" has to be read explicitly: a plain
  // coercion would turn it into true.
  active: z.enum(['true', 'false']).optional(),
});

// Field names from section 8.1 of the specification, which the jury checks
// the API against, rather than Prisma's camelCase.
function toResponse(param: Param) {
  return {
    id: param.id,
    code: param.code,
    section: param.section,
    parameter_name: param.parameterName,
    unit: param.unit,
    source_pd: param.sourcePd,
    source_rd: param.sourceRd,
    source_id: param.sourceId,
    trigger_logic: param.triggerLogic,
    review_priority: param.reviewPriority,
    sp_reference: param.spReference,
    gost_reference: param.gostReference,
    fz_reference: param.fzReference,
    other_normative: param.otherNormative,
    data_type: param.dataType,
    min_value: param.minValue,
    max_value: param.maxValue,
    regex_pattern: param.regexPattern,
    is_active: param.isActive,
    modality: param.modality,
    compare_op: param.compareOp,
    compare_threshold: param.compareThreshold,
    implemented: param.implemented,
    matrix_version: param.matrixVersion,
    created_at: param.createdAt,
    updated_at: param.updatedAt,
  };
}

export async function paramRoutes(app: FastifyInstance) {
  app.get('/api/v1/params', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const { section, priority, active } = parsed.data;

    const params = await prisma.param.findMany({
      where: {
        ...(section ? { section } : {}),
        ...(priority ? { reviewPriority: priority } : {}),
        ...(active ? { isActive: active === 'true' } : {}),
      },
      orderBy: { code: 'asc' },
    });

    return {
      matrix_version: params[0]?.matrixVersion ?? null,
      total: params.length,
      items: params.map(toResponse),
    };
  });
}
