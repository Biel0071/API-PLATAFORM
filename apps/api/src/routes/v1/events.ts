import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eventBus } from '../../services/event-bus.service';

const emitEventSchema = z.object({
  type: z.string().min(1).max(100),
  source: z.string().min(1).max(100),
  data: z.record(z.unknown()).default({}),
  severity: z.enum(['info', 'warn', 'error', 'critical']).optional().default('info'),
});

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', { schema: { tags: ['v1', 'events'] } }, async (req) => {
    const query = req.query as { type?: string; source?: string; severity?: string; limit?: string };
    const history = eventBus.getHistory({
      type: query.type,
      source: query.source,
      severity: query.severity,
      limit: query.limit ? Number(query.limit) : 50,
      projectId: req.auth?.projectId,
    });
    return { success: true, count: history.length, events: history };
  });

  app.post('/events', { schema: { tags: ['v1', 'events'] } }, async (req, reply) => {
    const body = emitEventSchema.parse(req.body);
    const event = eventBus.emitEvent(body.type, body.source, body.data, {
      severity: body.severity,
      projectId: req.auth?.projectId,
      tenantId: req.auth?.tenantId,
    });
    return reply.code(201).send({ success: true, event });
  });

  app.get('/events/stream', { schema: { tags: ['v1', 'events'] } }, async (req, reply) => {
    eventBus.handleSseStream(req, reply);
  });
}
