import type { FastifyInstance } from 'fastify';
import { registry } from '../metrics.js';

export async function metricsRoutes(app: FastifyInstance) {
  // No auth (auth/plugin.ts's PUBLIC set), and never proxied by the web
  // container's nginx (services/web/nginx.conf only forwards /api/) - only
  // reachable on the internal Docker network or api's own published port.
  // logLevel 'silent' keeps a scrape every few seconds off the request log,
  // the same reasoning as GET /api/v1/health.
  app.get('/metrics', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
