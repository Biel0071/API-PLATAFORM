import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { multiRepoService } from '../../services/multi-repo.service';

const connectRepoSchema = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  remoteUrl: z.string().url().optional(),
  defaultBranch: z.string().optional().default('main'),
});

const createIssueSchema = z.object({
  title: z.string().min(1).max(200),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  state: z.enum(['open', 'closed']).default('open'),
});

const recordPipelineSchema = z.object({
  branch: z.string().min(1),
  status: z.enum(['success', 'failed', 'running', 'queued']),
  durationMs: z.number().int().min(0),
  trigger: z.string().min(1),
});

export async function repositoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/repositories', { schema: { tags: ['v1', 'repositories'] } }, async () => {
    const list = multiRepoService.listRepositories();
    return { success: true, count: list.length, repositories: list };
  });

  app.post('/repositories', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const body = connectRepoSchema.parse(req.body);
    const repo = multiRepoService.connectRepository(body);
    return reply.code(201).send({ success: true, repository: repo });
  });

  app.get('/repositories/:id', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = multiRepoService.getRepository(id);
    if (!repo) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Repositório não encontrado' } });
    }
    return { success: true, repository: repo };
  });

  app.post('/repositories/:id/sync', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = multiRepoService.syncRepository(id);
    if (!repo) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Repositório não encontrado' } });
    }
    return { success: true, message: 'Repositório sincronizado com sucesso', repository: repo };
  });

  app.get('/repositories/:id/branches', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = multiRepoService.getRepository(id);
    if (!repo) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Repositório não encontrado' } });
    }
    return { success: true, count: repo.branches.length, branches: repo.branches };
  });

  app.get('/repositories/:id/issues', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = multiRepoService.getRepository(id);
    if (!repo) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Repositório não encontrado' } });
    }
    return { success: true, count: repo.issues.length, issues: repo.issues };
  });

  app.post('/repositories/:id/issues', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createIssueSchema.parse(req.body);
    const issue = multiRepoService.addIssue(id, body);
    if (!issue) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Repositório não encontrado' } });
    }
    return reply.code(201).send({ success: true, issue });
  });

  app.get('/repositories/:id/pipelines', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = multiRepoService.getRepository(id);
    if (!repo) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Repositório não encontrado' } });
    }
    return { success: true, count: repo.pipelines.length, pipelines: repo.pipelines };
  });

  app.post('/repositories/:id/pipelines', { schema: { tags: ['v1', 'repositories'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = recordPipelineSchema.parse(req.body);
    const pipeline = multiRepoService.recordPipeline(id, body);
    if (!pipeline) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Repositório não encontrado' } });
    }
    return reply.code(201).send({ success: true, pipeline });
  });
}
