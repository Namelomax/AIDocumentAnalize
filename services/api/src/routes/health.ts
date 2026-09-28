import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  // logLevel 'silent': this is polled every few seconds by Docker's own
  // healthcheck (docker-compose.yml) and would otherwise flood the log with
  // one "request completed" line at info per poll.
  app.get('/api/v1/health', { logLevel: 'silent' }, async () => ({ status: 'ok', service: 'api' }));
}
