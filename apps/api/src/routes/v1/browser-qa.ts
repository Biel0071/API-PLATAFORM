import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { browserQAService } from '../../services/browser-qa.service';

const recordRunSchema = z.object({
  scenario: z.string().min(1).max(200),
  targetUrl: z.string().url(),
  status: z.enum(['passed', 'failed', 'running']),
  durationMs: z.number().int().min(0),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  stepsExecuted: z.number().int().min(0),
  uiErrors: z.array(z.string()).default([]),
  screenshots: z.array(z.string()).default([]),
});

export async function browserQARoutes(app: FastifyInstance): Promise<void> {
  app.get('/browser-qa/runs', { schema: { tags: ['v1', 'browser-qa'] } }, async () => {
    const runs = browserQAService.listRuns();
    return { success: true, count: runs.length, runs };
  });

  app.post('/browser-qa/run', { schema: { tags: ['v1', 'browser-qa'] } }, async (req, reply) => {
    const body = recordRunSchema.parse(req.body);
    const run = browserQAService.recordRun(body);
    return reply.code(201).send({ success: true, run });
  });

  app.get('/browser-qa/runs/:id', { schema: { tags: ['v1', 'browser-qa'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = browserQAService.getRun(id);
    if (!run) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Execução de QA não encontrada' } });
    }
    return { success: true, run };
  });
}
