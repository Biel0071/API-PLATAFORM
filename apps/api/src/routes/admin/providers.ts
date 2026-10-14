import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from '@api-platform/shared';
import { execute, registry, reloadRegistry } from '../../services/ai.service';
import { listProviderConfigs, saveProviderConfig } from '../../services/provider-config.service';
import { prisma } from '../../lib/prisma';
import { providerHealthState } from '../../services/health-check.service';

export async function providersRoutes(secured: FastifyInstance): Promise<void> {
  // Providers + health + modelos
  secured.get('/providers', { schema: { tags: ['admin'] } }, async () => {
    const providers = await Promise.all(
      registry.list().map(async (p) => {
        const measured = providerHealthState.get(p.name);
        const health = measured
          ? { ok: measured.status === 'healthy', latencyMs: measured.latency, checkedAt: measured.lastCheck }
          : { ok: false, message: 'background probe pending' };
        const models = await p.models().catch(() => []);
        return { name: p.name, capabilities: p.capabilities, health, models };
      }),
    );
    return { success: true, defaults: registry.getDefaults(), providers };
  });

  secured.get('/provider-configs', { schema: { tags: ['admin'] } }, async () => ({
    success: true,
    configs: await listProviderConfigs(),
  }));

  secured.post('/provider-configs', { schema: { tags: ['admin'] } }, async (req) => {
    const body = z.object({
      name: z.enum(['openai', 'anthropic', 'xai', 'ollama', 'groq', 'gemini', 'openrouter', 'huggingface', 'cloudflare', 'lmstudio', 'comfyui', 'forge', 'invokeai']),
      enabled: z.boolean().default(true),
      defaultChat: z.boolean().optional(),
      baseUrl: z.string().trim().max(2_048).url().optional().or(z.literal('')),
      apiKey: z.string().max(8_192).optional(),
      accountId: z.string().trim().max(256).optional(),
      defaultModel: z.string().trim().max(256).optional(),
      embedModel: z.string().trim().max(256).optional(),
    }).parse(req.body);
    await saveProviderConfig(body);
    const updated = await reloadRegistry();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.configured', target: body.name },
    });
    return { success: true, registered: updated.has(body.name) };
  });

  secured.post('/provider-configs/:name/test', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const { name } = req.params as { name: string };
    await reloadRegistry();
    if (!registry.has(name)) return reply.code(400).send(fail('PROVIDER_NOT_CONFIGURED', 'Provider nao configurado ou desabilitado'));
    const health = await registry.get(name).health();
    return reply.code(health.ok ? 200 : 502).send({ success: health.ok, health });
  });

  secured.post('/test-text', { schema: { tags: ['admin'] } }, async (req) => {
    const body = z.object({
      prompt: z.string().trim().min(1).max(500),
      provider: z.string().optional(),
      model: z.string().optional(),
      maxTokens: z.number().int().min(1).max(32).optional().default(16),
      cache: z.boolean().optional().default(false),
      strictQuality: z.boolean().optional().default(false),
    }).parse(req.body);
    return execute('chat', body, (provider) => provider.generateText(body) as any, { cache: body.cache });
  });
}


