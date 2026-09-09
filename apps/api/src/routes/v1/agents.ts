import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentsService } from '../../services/agents.service';

const registerAgentSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(100),
  description: z.string().max(1000),
  capabilities: z.array(z.string()),
  skills: z.array(z.string()),
  model: z.string().min(1),
  systemPrompt: z.string().min(1),
});

const updateStatusSchema = z.object({
  status: z.enum(['idle', 'working', 'error', 'offline']),
});

export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/agents', { schema: { tags: ['v1', 'agents'] } }, async () => {
    const list = agentsService.listAgents();
    return { success: true, count: list.length, agents: list };
  });

  app.post('/agents', { schema: { tags: ['v1', 'agents'] } }, async (req, reply) => {
    const body = registerAgentSchema.parse(req.body);
    const agent = agentsService.registerAgent(body);
    return reply.code(201).send({ success: true, agent });
  });

  app.get('/agents/:id', { schema: { tags: ['v1', 'agents'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = agentsService.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Agente não encontrado' } });
    }
    return { success: true, agent };
  });

  app.patch('/agents/:id/status', { schema: { tags: ['v1', 'agents'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateStatusSchema.parse(req.body);
    const ok = agentsService.updateStatus(id, body.status);
    if (!ok) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Agente não encontrado' } });
    }
    return { success: true, message: `Status do agente atualizado para ${body.status}` };
  });
}
