import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { verifyPassword } from '../auth/passwords.js';

const loginSchema = z.object({
  login: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const user = await prisma.user.findUnique({ where: { login: parsed.data.login } });
    // Same answer for an unknown login and a wrong password: anything else
    // tells a caller which logins exist.
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const token = app.jwt.sign({ sub: user.id, login: user.login, role: user.role });
    return {
      token,
      user: { id: user.id, login: user.login, full_name: user.fullName, role: user.role },
    };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.id } });
    return { id: user.id, login: user.login, full_name: user.fullName, role: user.role };
  });
}
