import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@prisma/client';
import { enterRequestContext, setCurrentUser, type RequestUser } from './context.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; login: string; role: UserRole };
    user: RequestUser;
  }
}

const PUBLIC = new Set(['GET /api/v1/health', 'POST /api/v1/auth/login']);

export const authPlugin = fp(async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    enterRequestContext();
    const route = `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0]}`;
    if (PUBLIC.has(route)) return;

    try {
      const payload = await request.jwtVerify<{ sub: string; login: string; role: UserRole }>();
      const user: RequestUser = { id: payload.sub, login: payload.login, role: payload.role };
      request.user = user;
      setCurrentUser(user);
    } catch {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });
});

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
  };
}
