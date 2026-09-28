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
import { dashboardRoutes } from './routes/dashboard.js';
import { paramRoutes } from './routes/params.js';
import { authRoutes } from './routes/auth.js';
import { protocolRoutes } from './routes/protocols.js';
import { pageRoutes } from './routes/pages.js';
import { verdictRoutes } from './routes/verdicts.js';
import { suspicionRoutes } from './routes/suspicions.js';
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
    // Behind nginx every request arrives from the proxy, and the audit log of
    // section 12.4 would record the proxy's address for every action. Only
    // private networks are trusted to set X-Forwarded-For: the web container
    // always sits on the internal Docker network, while trusting everyone
    // would let a client calling the api port directly write any address it
    // likes into the audit log.
    trustProxy: '127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
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
  await app.register(dashboardRoutes);
  await app.register(paramRoutes);
  await app.register(authRoutes);
  await app.register(protocolRoutes);
  await app.register(pageRoutes);
  await app.register(verdictRoutes);
  await app.register(suspicionRoutes);
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
