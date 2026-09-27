import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

// "In work" mirrors the object list's own latest-process lookup
// (routes/objects.ts) rather than reusing it: the summary only needs a
// status per object, not the completeness/indicator fields the list builds,
// so it is cheaper to ask for exactly that here.
async function objectsInWork(): Promise<number> {
  const objects = await prisma.constructionObject.findMany({
    select: {
      processes: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
    },
  });
  // No process yet is still "in work" - nothing has been finalized about an
  // object that was only just created.
  return objects.filter((o) => o.processes[0]?.status !== 'FINALIZED').length;
}

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/v1/dashboard/summary', async () => {
    const [objectsInWorkCount, awaitingVerification, candidatesToReview, finalizedThisMonth] = await Promise.all([
      objectsInWork(),
      prisma.protocol.count({ where: { status: { in: ['READY', 'VERIFYING'] } } }),
      // A candidate only belongs in this count while its process hasn't been
      // finalized yet - once finalized there is nothing left to review.
      prisma.check.count({ where: { findingStatus: 'CANDIDATE', process: { status: { not: 'FINALIZED' } } } }),
      prisma.protocol.count({
        where: { status: 'PROTOCOL_FINALIZED', finalizedAt: { gte: startOfCurrentMonth() } },
      }),
    ]);

    return {
      objects_in_work: objectsInWorkCount,
      awaiting_verification: awaitingVerification,
      candidates_to_review: candidatesToReview,
      finalized_this_month: finalizedThisMonth,
    };
  });
}
