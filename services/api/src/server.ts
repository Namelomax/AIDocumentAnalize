import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { documentRoutes } from './routes/documents.js';
import { objectRoutes } from './routes/objects.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: () => crypto.randomUUID(),
    requestIdLogLabel: 'request_id',
  });
  await app.register(multipart, { limits: { fileSize: config.maxPackageBytes } });
  await app.register(healthRoutes);
  await app.register(documentRoutes);
  await app.register(objectRoutes);
  return app;
}

const isEntry = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isEntry) {
  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
