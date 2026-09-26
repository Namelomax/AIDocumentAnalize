import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit } from '../audit.js';

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
        processes: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
      },
    });

    return {
      items: objects.map((o) => ({
        id: o.id,
        name: o.name,
        address: o.address,
        files_count: o._count.files,
        last_process_status: o.processes[0]?.status ?? null,
      })),
    };
  });
}
