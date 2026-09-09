import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectMirrorService } from '../../services/project-mirror.service';

const indexRepoSchema = z.object({
  repoPath: z.string().min(1),
  name: z.string().min(1).max(100),
});

export async function projectMirrorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/project-mirror', { schema: { tags: ['v1', 'project-mirror'] } }, async () => {
    const list = projectMirrorService.listMirrors();
    return { success: true, count: list.length, mirrors: list };
  });

  app.post('/project-mirror/index', { schema: { tags: ['v1', 'project-mirror'] } }, async (req, reply) => {
    const body = indexRepoSchema.parse(req.body);
    const report = await projectMirrorService.indexRepository(body.repoPath, body.name);
    return reply.code(201).send({ success: true, mirror: report });
  });

  app.get('/project-mirror/:id', { schema: { tags: ['v1', 'project-mirror'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const mirror = projectMirrorService.getMirror(id);
    if (!mirror) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Espelho do projeto não encontrado' } });
    }
    return { success: true, mirror };
  });

  app.get('/project-mirror/:id/endpoints', { schema: { tags: ['v1', 'project-mirror'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const mirror = projectMirrorService.getMirror(id);
    if (!mirror) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Espelho do projeto não encontrado' } });
    }
    return { success: true, count: mirror.endpoints.length, endpoints: mirror.endpoints };
  });

  app.get('/project-mirror/:id/models', { schema: { tags: ['v1', 'project-mirror'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const mirror = projectMirrorService.getMirror(id);
    if (!mirror) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Espelho do projeto não encontrado' } });
    }
    return { success: true, count: mirror.models.length, models: mirror.models };
  });

  app.get('/project-mirror/:id/debt', { schema: { tags: ['v1', 'project-mirror'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const mirror = projectMirrorService.getMirror(id);
    if (!mirror) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Espelho do projeto não encontrado' } });
    }
    return { success: true, count: mirror.technicalDebt.length, debt: mirror.technicalDebt };
  });
}
