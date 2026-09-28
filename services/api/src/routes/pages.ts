import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { getObjectStream } from '../storage.js';

const paramsSchema = z.object({
  file_id: z.string().uuid(),
  page_no: z.coerce.number().int().positive(),
});

export async function pageRoutes(app: FastifyInstance) {
  // The page's own metadata - separate from /image below, which only ever
  // streams bytes. Lets the evidence UI show why a highlight on this sheet
  // might be missing or approximate (customer's ТЗ p.16 п.1: needs_ocr /
  // quality_status) without parsing anything out of the image response.
  app.get('/api/v1/files/:file_id/pages/:page_no', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const page = await prisma.page.findUnique({
      where: { fileId_pageNo: { fileId: parsed.data.file_id, pageNo: parsed.data.page_no } },
    });
    if (!page) return reply.code(404).send({ error: 'PAGE_NOT_FOUND' });

    return {
      file_id: page.fileId,
      page_no: page.pageNo,
      width_pt: page.widthPt,
      height_pt: page.heightPt,
      rotation: page.rotation,
      needs_ocr: page.needsOcr,
      quality_status: page.qualityStatus,
    };
  });

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
