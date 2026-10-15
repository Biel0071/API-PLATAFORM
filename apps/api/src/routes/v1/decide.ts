import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { registry, providerAccountPool } from '../../services/ai.service';
import { FastIntentClassifier } from '../../services/intent.classifier';
import { AIProvider, DecisionResult, ProviderResult, createProviderAttemptContext, resolveProviderAccountTargets } from '@api-platform/shared';
import { providerAttemptTracker } from '../../services/provider-attempt.service';

const decideSchema = z.object({
  prompt: z.string().optional(),
  messages: z.array(z.any()).optional(),
  context: z.string().optional(),
  requirements: z.object({
    latency: z.enum(['instant', 'low', 'medium', 'high']).optional(),
    maxBudget: z.number().optional(),
    requiresCoding: z.boolean().optional(),
    requiresVision: z.boolean().optional(),
    requiresReasoning: z.boolean().optional(),
  }).optional(),
  candidateModels: z.array(z.string()).optional(),
  provider: z.string().optional(),
  providerAccountId: z.string().trim().min(1).max(128).optional(),
}).refine((data) => Boolean(data.prompt) || (Array.isArray(data.messages) && data.messages.length > 0), {
  message: 'Envie ao menos prompt ou messages não-vazio',
});

export const decideRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('onRequest', app.requireApiKey);

  app.post('/decide', {
    schema: {
      tags: ['v1', 'decision'],
      description: 'Endpoint System 1 para tomada de decisão semântica e classificação ultrarrápida (<35ms)',
    },
  }, async (req, reply) => {
    const start = performance.now();
    const body = decideSchema.parse(req.body);

    const requestedProvider = body.provider || 'laya';
    let provider: AIProvider | undefined;
    let resolvedAccountId: string | undefined = body.providerAccountId;
    const pool = registry.getAccountPool() ?? providerAccountPool;

    if (body.providerAccountId) {
      if (!req.auth?.scopes?.includes('*') && !req.auth?.scopes?.includes('chat')) {
        return reply.code(403).send({ error: { code: 'INSUFFICIENT_SCOPE', message: 'API key lacks permission for decision inference' } });
      }
      const account = await pool.resolveAccount(body.providerAccountId);
      if (!account || !account.enabled) return reply.code(404).send({ error: { code: 'PROVIDER_ACCOUNT_NOT_FOUND', message: 'Provider account not found or disabled' } });
      if (body.provider && body.provider !== account.providerName) return reply.code(400).send({ error: { code: 'PROVIDER_ACCOUNT_MISMATCH', message: 'Provider account does not match provider' } });
      if (!account.provider.capabilities.includes('decision') || typeof account.provider.decision !== 'function') return reply.code(400).send({ error: { code: 'CAPABILITY_NOT_SUPPORTED', message: 'Provider account does not support decision' } });
      provider = account.provider;
    } else if (pool) {
      try {
        const targets = await resolveProviderAccountTargets(registry, pool, 'decision', requestedProvider);
        if (targets.length > 0 && targets[0].provider) {
          provider = targets[0].provider;
          resolvedAccountId = targets[0].accountId || undefined;
        }
      } catch {
        // Fallback below
      }
    }
    try {
      if (!provider && !body.providerAccountId) provider = await registry.resolve('decision', requestedProvider);
    } catch {
      if (!body.providerAccountId && registry.has('laya')) {
        provider = registry.get('laya');
      } else if (!body.providerAccountId && registry.has('jev')) {
        provider = registry.get('jev');
      }
    }

    let decisionResult: ProviderResult<DecisionResult>;

    if (provider && typeof provider.decision === 'function') {
      try {
        const selectedProvider = provider;
        decisionResult = await providerAttemptTracker.observe(createProviderAttemptContext({ correlationId: req.id }), {
          provider: provider.name, providerAccountId: resolvedAccountId, capability: 'decision',
        }, () => selectedProvider.decision!({
          prompt: body.prompt,
          messages: body.messages,
          context: body.context,
          requirements: body.requirements,
          candidateModels: body.candidateModels,
        }));
      } catch (err: any) {
        if (body.providerAccountId) throw err;
        req.log.warn({ statusCode: err?.statusCode, errorCode: err?.code }, 'Falha no provider.decision; acionando fallback FastIntentClassifier');
        decisionResult = fallbackFastIntent(body);
      }
    } else {
      decisionResult = fallbackFastIntent(body);
    }

    const elapsed = Math.round(performance.now() - start);

    return reply.send({
      success: true,
      provider: provider?.name || 'laya',
      model: decisionResult.model,
      executionTime: elapsed,
      tokens: decisionResult.tokens || { prompt: 10, completion: 15, total: 25 },
      cached: false,
      result: {
        ...decisionResult.result,
        latencyMs: elapsed,
      },
    });
  });
};

function fallbackFastIntent(body: z.infer<typeof decideSchema>): ProviderResult<DecisionResult> {
  const intent = FastIntentClassifier.classify(body.messages || [], { prompt: body.prompt });
  const decisionType = intent.isComplexProject ? 'workflow' : intent.isCoding ? 'coding' : (intent.mode === 'FAST' ? 'fast' : 'standard');
  const selectedModel = intent.recommendedModel || (intent.isCoding ? 'deepseek-coder:6.7b' : 'qwen2.5:3b');
  const selectedProvider = intent.isComplexProject ? 'anthropic' : 'ollama';

  return {
    result: {
      decision: decisionType,
      selectedModel,
      selectedProvider,
      fastResponse: intent.isCoding
        ? 'Identifiquei uma tarefa de código/desenvolvimento. Ativando especialista DeepSeek-Coder.'
        : undefined,
      needsBackground: intent.isComplexProject === true,
      confidence: intent.confidence,
      latencyMs: 1,
      reason: intent.isComplexProject
        ? 'Complex project architecture detected'
        : intent.isCoding
          ? 'Programming task detected'
          : 'Direct standard intent',
      strategy: intent.isComplexProject ? 'ensemble_with_judge' : intent.isCoding ? 'single_with_refinement' : 'single',
    },
    model: 'laya-system1',
    tokens: { prompt: 10, completion: 15, total: 25 },
  };
}
