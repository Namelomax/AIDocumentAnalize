import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const idParamsSchema = z.object({ id: z.string().uuid() });

// In-app notifications (customer's ТЗ p.17 "уведомление администратора" and
// p.19 "Инспектор получает уведомление о готовности протокола"). Written by
// the worker (services/worker/app/db.py) as one row per targeted user -
// every route here only ever reads or updates the current user's own rows.
export async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/v1/notifications', async (request) => {
    const userId = request.user.id;
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    return {
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        process_id: n.processId,
        object_id: n.objectId,
        created_at: n.createdAt,
        read_at: n.readAt,
      })),
      unread_count: unreadCount,
    };
  });

  app.post('/api/v1/notifications/:id/read', async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const notification = await prisma.notification.findUnique({ where: { id: parsed.data.id } });
    // A notification that belongs to someone else reads the same as one
    // that does not exist at all - never revealed to this caller.
    if (!notification || notification.userId !== request.user.id) {
      return reply.code(404).send({ error: 'NOTIFICATION_NOT_FOUND' });
    }

    const updated = await prisma.notification.update({
      where: { id: notification.id },
      data: { readAt: notification.readAt ?? new Date() },
    });

    return { id: updated.id, read_at: updated.readAt };
  });

  app.post('/api/v1/notifications/read-all', async (request) => {
    const result = await prisma.notification.updateMany({
      where: { userId: request.user.id, readAt: null },
      data: { readAt: new Date() },
    });

    return { updated: result.count };
  });
}
