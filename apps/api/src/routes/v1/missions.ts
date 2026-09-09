import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { missionsService } from '../../services/missions.service';

const createMissionSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(50_000),
  context: z.string().max(100_000).optional(),
  agentId: z.string().optional(),
  priority: z.number().int().min(1).max(10).optional().default(5),
  targetRepository: z.string().optional(),
  autoStart: z.boolean().optional().default(false),
});

const addStepSchema = z.object({
  title: z.string().min(1).max(200),
  tool: z.string().optional(),
});

const updateStepSchema = z.object({
  status: z.enum(['pending', 'active', 'completed', 'failed']),
  result: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});

const completeMissionSchema = z.object({
  result: z.record(z.unknown()),
  tokens: z.object({ prompt: z.number(), completion: z.number() }).optional(),
});

export async function missionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/missions', { schema: { tags: ['v1', 'missions'] } }, async (req) => {
    const query = req.query as { status?: string; agentId?: string };
    const list = missionsService.listMissions(query);
    return { success: true, storage: 'process-memory', count: list.length, missions: list };
  });

  app.post('/missions', { schema: { tags: ['v1', 'missions'] } }, async (req, reply) => {
    const body = createMissionSchema.parse(req.body);
    const mission = missionsService.createMission(body);
    return reply.code(201).send({ success: true, mission });
  });

  app.get('/missions/:id', { schema: { tags: ['v1', 'missions'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const mission = missionsService.getMission(id);
    if (!mission) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Missão não encontrada' } });
    }
    return { success: true, mission };
  });

  app.post('/missions/:id/steps', { schema: { tags: ['v1', 'missions'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = addStepSchema.parse(req.body);
    const step = missionsService.addStep(id, body.title, body.tool);
    if (!step) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Missão não encontrada' } });
    }
    return reply.code(201).send({ success: true, step });
  });

  app.patch('/missions/:id/steps/:stepId', { schema: { tags: ['v1', 'missions'] } }, async (req, reply) => {
    const { id, stepId } = req.params as { id: string; stepId: string };
    const body = updateStepSchema.parse(req.body);
    const ok = missionsService.updateStep(id, stepId, body);
    if (!ok) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Passo ou missão não encontrada' } });
    }
    return { success: true, message: 'Passo atualizado' };
  });

  app.post('/missions/:id/complete', { schema: { tags: ['v1', 'missions'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = completeMissionSchema.parse(req.body);
    const ok = missionsService.completeMission(id, body.result, body.tokens);
    if (!ok) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Missão não encontrada' } });
    }
    return { success: true, message: 'Missão concluída com sucesso' };
  });

  app.post('/missions/:id/cancel', { schema: { tags: ['v1', 'missions'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = missionsService.cancelMission(id);
    if (!ok) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Missão não encontrada' } });
    }
    return { success: true, message: 'Missão cancelada' };
  });
}
