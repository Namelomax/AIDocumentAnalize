import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyJwt from '@fastify/jwt';
import type { UserRole } from '@prisma/client';
import { config } from './config.js';
import { loggerOptions } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { documentRoutes } from './routes/documents.js';
import { objectRoutes } from './routes/objects.js';
import { processRoutes } from './routes/processes.js';
import { paramRoutes } from './routes/params.js';
import { authRoutes } from './routes/auth.js';
import { protocolRoutes } from './routes/protocols.js';
import { pageRoutes } from './routes/pages.js';
import { verdictRoutes } from './routes/verdicts.js';
import { ensureBucket } from './storage.js';
import { seedDemoUsers } from './auth/seed.js';
import { authPlugin } from './auth/plugin.js';
import { enterRequestContext, setCurrentUser } from './auth/context.js';

export interface BuildServerOptions {
  logStream?: NodeJS.WritableStream;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logStream ? { ...loggerOptions, stream: options.logStream } : loggerOptions,
    genReqId: () => crypto.randomUUID(),
    requestIdLogLabel: 'request_id',
  });
  await app.register(multipart, { limits: { fileSize: config.maxPackageBytes } });
  await app.register(fastifyJwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });

  // Fastify logs "incoming request" before any onRequest hook runs, so the
  // auth hook that verifies the token and enters the user into
  // AsyncLocalStorage (auth/plugin.ts) is always one line too late for that
  // first line of a request. setGenReqId runs earlier still - before the
  // request's child logger even exists - so a token found here is verified
  // on the spot and the user is already in context by the time anything
  // logs. The onRequest hook still owns rejecting a request outright: a
  // malformed or missing token here is silently left for it to answer.
  app.setGenReqId((req) => {
    enterRequestContext();
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = app.jwt.verify<{ sub: string; login: string; role: UserRole }>(header.slice(7));
        setCurrentUser({ id: payload.sub, login: payload.login, role: payload.role });
      } catch {
        // Left to the onRequest hook in auth/plugin.ts, which owns the 401.
      }
    }
    return crypto.randomUUID();
  });

  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(documentRoutes);
  await app.register(objectRoutes);
  await app.register(processRoutes);
  await app.register(paramRoutes);
  await app.register(authRoutes);
  await app.register(protocolRoutes);
  await app.register(pageRoutes);
  await app.register(verdictRoutes);
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
