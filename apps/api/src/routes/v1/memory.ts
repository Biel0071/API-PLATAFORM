import type { FastifyInstance } from 'fastify';
import { executionMemoryContext, executionMemoryHash } from '@api-platform/shared';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';

const feedbackSchema = z.object({
  jobId: z.string().min(1),
  accepted: z.boolean(),
});

function scopeKey(tenantId: string | undefined, projectId: string | undefined): string {
  return `${tenantId ?? 'global'}:${projectId ?? 'all'}`;
}

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/memory/stats', { schema: { tags: ['v1', 'memory'] } }, async (req) => {
    const scope = scopeKey(req.auth?.tenantId, req.auth?.projectId);
    const memories = await prisma.executionMemory.findMany({
      where: { scopeKey: scope },
      orderBy: [{ successCount: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
    });
    return {
      success: true,
      scope,
      memories: memories.map((memory: typeof memories[0]) => ({
        ...memory,
        durationTotalMs: Number(memory.durationTotalMs),
        averageQuality: memory.successCount ? memory.qualityTotal / memory.successCount : 0,
        averageDurationMs: memory.successCount ? Number(memory.durationTotalMs) / memory.successCount : 0,
      })),
    };
  });

  app.post('/memory/feedback', { schema: { tags: ['v1', 'memory'] } }, async (req, reply) => {
    const body = feedbackSchema.parse(req.body);
    const job = await prisma.job.findFirst({
      where: {
        id: body.jobId,
        tenantId: req.auth!.tenantId,
        ...(req.auth?.projectId ? { projectId: req.auth.projectId } : {}),
        status: 'completed',
      },
      select: { id: true, queue: true, payload: true, provider: true, model: true, projectId: true },
    });
    if (!job?.provider || !job.model) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Job concluído não encontrado' } });
    }
    const payload = job.payload as Record<string, unknown>;
    const memory = await prisma.executionMemory.updateMany({
      where: {
        scopeKey: scopeKey(req.auth?.tenantId, job.projectId ?? undefined),
        queue: job.queue,
        contextHash: executionMemoryHash(job.queue, payload),
        provider: job.provider,
        model: job.model,
      },
      data: body.accepted ? { approvedCount: { increment: 1 } } : { rejectedCount: { increment: 1 } },
    });
    if (!memory.count) {
      return reply.code(409).send({ success: false, error: { code: 'MEMORY_NOT_READY', message: 'A memória deste job ainda não foi consolidada' } });
    }
    return {
      success: true,
      jobId: job.id,
      accepted: body.accepted,
      context: executionMemoryContext(job.queue, payload),
    };
  });

  // ---------- Memoria Operacional FENIX: Decisoes e Resolucao de Erros ----------
  const { operationalMemoryService } = await import('../../services/operational-memory.service');

  app.get('/memory/decisions', { schema: { tags: ['v1', 'memory'] } }, async (req) => {
    const query = req.query as { tag?: string };
    const decisions = operationalMemoryService.listDecisions({
      projectId: req.auth?.projectId,
      tag: query.tag,
    });
    return { success: true, count: decisions.length, decisions };
  });

  app.post('/memory/decisions', { schema: { tags: ['v1', 'memory'] } }, async (req, reply) => {
    const schema = z.object({
      title: z.string().min(1).max(200),
      context: z.string().min(1),
      alternatives: z.array(z.string()).optional(),
      chosenOption: z.string().min(1),
      rationale: z.string().min(1),
      tags: z.array(z.string()).optional(),
    });
    const body = schema.parse(req.body);
    const decision = operationalMemoryService.recordDecision({
      ...body,
      author: req.auth?.apiKeyId ?? 'system',
      projectId: req.auth?.projectId,
    });
    return reply.code(201).send({ success: true, decision });
  });

  app.get('/memory/errors', { schema: { tags: ['v1', 'memory'] } }, async (req) => {
    const query = req.query as { errorType?: string };
    const errors = operationalMemoryService.listErrorResolutions({
      projectId: req.auth?.projectId,
      errorType: query.errorType,
    });
    return { success: true, count: errors.length, errors };
  });

  app.post('/memory/errors', { schema: { tags: ['v1', 'memory'] } }, async (req, reply) => {
    const schema = z.object({
      errorType: z.string().optional(),
      errorMessage: z.string().min(1),
      stackTrace: z.string().optional(),
      rootCause: z.string().min(1),
      resolutionApplied: z.string().min(1),
      filesChanged: z.array(z.string()).optional(),
      regressionTest: z.string().optional(),
      verified: z.boolean().default(true),
    });
    const body = schema.parse(req.body);
    const resolution = operationalMemoryService.recordErrorResolution({
      ...body,
      projectId: req.auth?.projectId,
    });
    return reply.code(201).send({ success: true, resolution });
  });

  app.post('/memory/search', { schema: { tags: ['v1', 'memory'] } }, async (req, reply) => {
    const schema = z.object({
      query: z.string().min(1),
    });
    const body = schema.parse(req.body);
    const results = operationalMemoryService.searchMemory(body.query);
    return { success: true, ...results };
  });
}
