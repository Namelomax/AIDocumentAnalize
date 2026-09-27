import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { getObjectStream } from '../storage.js';

const paramsSchema = z.object({
  file_id: z.string().uuid(),
  page_no: z.coerce.number().int().positive(),
});

export async function pageRoutes(app: FastifyInstance) {
  app.get('/api/v1/files/:file_id/pages/:page_no/image', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const page = await prisma.page.findUnique({
      where: { fileId_pageNo: { fileId: parsed.data.file_id, pageNo: parsed.data.page_no } },
    });
    // The object key comes only from pages.image_key, never assembled from
    // the request: a client-built key could ask for any object in the
    // bucket, including another object's source document.
    if (!page || !page.imageKey) return reply.code(404).send({ error: 'PAGE_IMAGE_NOT_FOUND' });

    const stream = await getObjectStream(page.imageKey);
    reply.type('image/png');
    return reply.send(stream);
  });
}
