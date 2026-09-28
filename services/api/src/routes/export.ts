import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { loadProtocolResponse } from './protocols.js';
import { buildExportDocument, exportFilename, type ExportFormat } from '../export/model.js';
import { renderProtocolPdf } from '../export/pdf.js';
import { renderProtocolDocx } from '../export/docx.js';
import { renderProtocolXml } from '../export/xml.js';

const paramsSchema = z.object({ protocol_id: z.string().uuid() });
const querySchema = z.object({ format: z.enum(['pdf', 'docx', 'xml']) });

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xml: 'application/xml; charset=utf-8',
};

export async function exportRoutes(app: FastifyInstance) {
  app.get('/api/v1/protocols/:protocol_id/export', async (request, reply) => {
    const paramsParsed = paramsSchema.safeParse(request.params);
    if (!paramsParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    // An unrecognized ?format is a 400, not a 404 - the protocol may well
    // exist, the request just did not say a format this endpoint can build.
    const queryParsed = querySchema.safeParse(request.query);
    if (!queryParsed.success) return reply.code(400).send({ error: 'UNKNOWN_FORMAT' });

    const protocol = await prisma.protocol.findUnique({ where: { id: paramsParsed.data.protocol_id } });
    if (!protocol) return reply.code(404).send({ error: 'PROTOCOL_NOT_FOUND' });

    // Section 9.2's "Статус загрузки документов" / "Тип проверки" and the
    // finalizer's name live on Process/User, not on ProtocolResponse - the
    // only queries here beyond loadProtocolResponse's own (routes/protocols.ts),
    // run in parallel with it rather than after.
    const [protocolResponse, process, object, finalizer] = await Promise.all([
      loadProtocolResponse(protocol),
      prisma.process.findUnique({
        where: { id: protocol.processId },
        select: { scenario: true, pdCompleteness: true, rdCompleteness: true, idCompleteness: true },
      }),
      prisma.constructionObject.findUnique({ where: { id: protocol.objectId }, select: { name: true } }),
      protocol.finalizedBy
        ? prisma.user.findUnique({ where: { id: protocol.finalizedBy }, select: { fullName: true } })
        : Promise.resolve(null),
    ]);

    const document = buildExportDocument(protocolResponse, {
      objectName: object?.name ?? '—',
      scenario: process?.scenario ?? null,
      pdCompleteness: process?.pdCompleteness ?? null,
      rdCompleteness: process?.rdCompleteness ?? null,
      idCompleteness: process?.idCompleteness ?? null,
      finalizedByName: finalizer?.fullName ?? null,
    });

    const format = queryParsed.data.format;
    const filename = exportFilename(document, format);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type(CONTENT_TYPES[format]);

    let body: Buffer | string;
    if (format === 'pdf') body = await renderProtocolPdf(document);
    else if (format === 'docx') body = await renderProtocolDocx(document);
    else body = renderProtocolXml(document);

    await audit(request, 'PROTOCOL_EXPORTED', protocol.objectId, { protocol_id: protocol.id, format });

    return reply.send(body);
  });
}
