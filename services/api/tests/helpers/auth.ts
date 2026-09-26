import { Prisma, type UserRole } from '@prisma/client';
import { buildServer } from '../../src/server.js';
import { prisma } from '../../src/db.js';

const cache = new Map<UserRole, Record<string, string>>();

// One real user per role, signed by the same server code the API uses, so a
// test exercises the actual verification path rather than a bypass. Vitest
// runs test files in separate workers, each with its own copy of `cache`, so
// two files can race to create the same login; the loser of that race reads
// back the row the winner just created instead of failing.
export async function authHeaders(role: UserRole = 'INSPECTOR'): Promise<Record<string, string>> {
  const cached = cache.get(role);
  if (cached) return cached;

  const login = `test-${role.toLowerCase()}`;
  let user;
  try {
    user = await prisma.user.create({
      data: { login, fullName: `Test ${role}`, role, passwordHash: 'not-used-by-tests' },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    user = await prisma.user.findUniqueOrThrow({ where: { login } });
  }
  const app = await buildServer();
  const token = app.jwt.sign({ sub: user.id, login: user.login, role: user.role });
  await app.close();

  const headers = { authorization: `Bearer ${token}` };
  cache.set(role, headers);
  return headers;
}
