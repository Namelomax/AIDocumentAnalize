import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Protocol } from '@prisma/client';
import { prisma } from '../db.js';
import { visibleCheckWhere } from '../checks/visibility.js';
import { buildSuspicion, type CheckWithFragments, type SuspicionView } from '../protocol/view.js';
import { paramsByCode, inspectorsById, pageQualityByFragment } from './protocols.js';

const suspicionsQuerySchema = z.object({
  object_id: z.string().uuid().optional(),
  protocol_id: z.string().uuid().optional(),
});

// A hypothesis in the shape of a finding (buildSuspicion), plus where it came
// from: the "Hypotheses" screen lists across every object at once, so each
// row has to name its own object and protocol rather than assuming the one
// the caller already has open (Plan 8, Task 4).
export interface SuspicionListItem extends SuspicionView {
  object_id: string;
  object_name: string;
  protocol_id: string;
}

// The list is a triage queue, not an export: capped regardless of how many
// hypotheses the stand has accumulated, so the query stays bounded even with
// no filters at all.
const MAX_ITEMS = 200;

// A protocol row is unique per (object, version) - schema.prisma - and every
// check under its process belongs to whichever version is currently the
// object's latest, the same rule routes/protocols.ts's loadProtocolResponse
// applies to one process at a time. This resolves it for a batch of objects:
// the highest-version protocol row per object.
async function latestProtocolsByObject(objectIds?: string[]): Promise<Protocol[]> {
  const protocols = await prisma.protocol.findMany({
    where: objectIds ? { objectId: { in: objectIds } } : undefined,
    orderBy: { version: 'desc' },
  });
  const latestByObject = new Map<string, Protocol>();
  for (const protocol of protocols) {
    if (!latestByObject.has(protocol.objectId)) latestByObject.set(protocol.objectId, protocol);
  }
  return [...latestByObject.values()];
}

export async function suspicionRoutes(app: FastifyInstance) {
  app.get('/api/v1/suspicions', async (request, reply) => {
    const parsed = suspicionsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const { object_id: objectId, protocol_id: protocolId } = parsed.data;

    // Three shapes of the same question ("which protocols' hypotheses"): one
    // exact protocol, the latest protocol of one object, or the latest
    // protocol of every object - resolved up front so the check query below
    // always runs once, never once per hypothesis.
    let protocols: Protocol[];
    if (protocolId) {
      const protocol = await prisma.protocol.findUnique({ where: { id: protocolId } });
      protocols = protocol ? [protocol] : [];
    } else if (objectId) {
      const protocol = await prisma.protocol.findFirst({
        where: { objectId },
        orderBy: { version: 'desc' },
      });
      protocols = protocol ? [protocol] : [];
    } else {
      protocols = await latestProtocolsByObject();
    }

    if (protocols.length === 0) return { items: [] };

    const protocolByProcess = new Map(protocols.map((protocol) => [protocol.processId, protocol]));
    const checks = (await prisma.check.findMany({
      where: {
        processId: { in: [...protocolByProcess.keys()] },
        findingStatus: 'SUSPICION',
        ...visibleCheckWhere,
      },
      include: { fragments: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_ITEMS,
    })) as CheckWithFragments[];

    if (checks.length === 0) return { items: [] };

    const objectIds = [...new Set(checks.map((check) => check.objectId))];
    const [params, inspectors, pageQuality, objects] = await Promise.all([
      paramsByCode(checks),
      inspectorsById(checks),
      pageQualityByFragment(checks),
      prisma.constructionObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true } }),
    ]);
    const objectNamesById = new Map(objects.map((object) => [object.id, object.name]));

    const items: SuspicionListItem[] = checks.map((check) => ({
      ...buildSuspicion(check, params.get(check.paramCode), inspectors, pageQuality),
      object_id: check.objectId,
      object_name: objectNamesById.get(check.objectId) ?? '',
      protocol_id: protocolByProcess.get(check.processId)!.id,
    }));

    return { items };
  });
}
