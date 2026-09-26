import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';

// Section 12.4: every user action with its time, IP address, type and object.
// A failure to write the audit entry is logged, not raised: the action itself
// has already happened, and failing the request would misreport its outcome.
export async function audit(
  request: FastifyRequest,
  action: string,
  objectId: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: request.user?.id ?? null,
        action,
        objectId,
        details: (details ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });
  } catch (err) {
    request.log.error({ err, action }, 'audit entry could not be written');
  }
}
