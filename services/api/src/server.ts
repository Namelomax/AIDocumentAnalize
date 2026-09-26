import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyJwt from '@fastify/jwt';
import { config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { documentRoutes } from './routes/documents.js';
import { objectRoutes } from './routes/objects.js';
import { processRoutes } from './routes/processes.js';
import { paramRoutes } from './routes/params.js';
import { authRoutes } from './routes/auth.js';
import { ensureBucket } from './storage.js';
import { seedDemoUsers } from './auth/seed.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    genReqId: () => crypto.randomUUID(),
    requestIdLogLabel: 'request_id',
  });
  await app.register(multipart, { limits: { fileSize: config.maxPackageBytes } });
  await app.register(fastifyJwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });
  await app.register(healthRoutes);
  await app.register(documentRoutes);
  await app.register(objectRoutes);
  await app.register(processRoutes);
  await app.register(paramRoutes);
  await app.register(authRoutes);
  return app;
}

const isEntry = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isEntry) {
  const app = await buildServer();
  // On a fresh deployment the bucket does not exist yet, and every upload
  // fails with "The specified bucket does not exist". Tests never saw this
  // because they create the bucket themselves before they run.
  await ensureBucket();
  app.log.info({ bucket: config.minio.bucket }, 'object storage ready');
  const seeded = await seedDemoUsers();
  app.log.info({ seeded }, 'demo accounts checked');
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
