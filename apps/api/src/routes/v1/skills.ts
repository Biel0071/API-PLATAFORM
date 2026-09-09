import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { skillsService } from '../../services/skills.service';

const executeSkillSchema = z.object({
  parameters: z.record(z.unknown()).default({}),
  context: z.object({
    agentId: z.string().optional(),
    missionId: z.string().optional(),
  }).optional(),
});

export async function skillsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/skills', { schema: { tags: ['v1', 'skills'] } }, async (req) => {
    const query = req.query as { category?: string };
    const list = skillsService.listSkills(query.category);
    return { success: true, count: list.length, skills: list };
  });

  app.get('/skills/:name', { schema: { tags: ['v1', 'skills'] } }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const skill = skillsService.getSkill(name);
    if (!skill) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Skill não encontrada' } });
    }
    return { success: true, skill };
  });

  app.post('/skills/:name/execute', { schema: { tags: ['v1', 'skills'] } }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = executeSkillSchema.parse(req.body);
    const result = await skillsService.executeSkill(name, body.parameters, body.context);
    if (!result.success) {
      return reply.code(400).send({ success: false, error: { code: 'SKILL_EXECUTION_FAILED', message: result.error } });
    }
    return { success: true, result };
  });
}
