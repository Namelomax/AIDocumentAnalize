// Customer's ТЗ p.31, "Проверка целостности данных": operator-facing side of
// integrity.ts's daily sweep - trigger one on demand, and list what earlier
// ones found. ADMIN-only, the same authority section 12 gives every other
// operational control (e.g. routes/integrationRin.ts's protocol resync).
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireRole } from '../auth/plugin.js';
import { runIntegrityCheck, listIntegrityRuns } from '../integrity.js';

export async function adminRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/admin/integrity-check',
    { preHandler: requireRole('ADMIN') },
    async (request, reply) => {
      const run = await runIntegrityCheck(request.user.id);
      if (!run) {
        return reply.code(409).send({
          error: 'INTEGRITY_CHECK_ALREADY_RUNNING',
          message: 'Проверка целостности уже выполняется',
        });
      }

      await audit(request, 'INTEGRITY_CHECK_TRIGGERED', null, {
        run_id: run.id, status: run.status, mismatches: run.mismatches, missing: run.missing,
      });

      return reply.code(202).send(run);
    },
  );

  app.get(
    '/api/v1/admin/integrity-runs',
    { preHandler: requireRole('ADMIN') },
    async () => ({ runs: await listIntegrityRuns() }),
  );
}
