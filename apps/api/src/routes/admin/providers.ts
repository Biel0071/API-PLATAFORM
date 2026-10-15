import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from '@api-platform/shared';
import {
  execute,
  registry,
  reloadRegistry,
  reloadRegistryAfterMutation,
} from '../../services/ai.service';
import { listProviderConfigs, saveProviderConfig } from '../../services/provider-config.service';
import {
  providerEndpointSchema,
  providerNameSchema,
} from '../../services/provider-account.service';
import {
  disconnectProviderOAuthAccount,
  getProviderConnectionOptions,
  geminiStateCookie,
  pollHuggingFaceDeviceFlow,
  startGeminiOAuth,
  startHuggingFaceDeviceFlow,
} from '../../services/provider-oauth.service';
import { prisma } from '../../lib/prisma';

export async function providersRoutes(secured: FastifyInstance): Promise<void> {
  secured.get('/provider-oauth/options', { schema: { tags: ['admin'] } }, async () => ({
    success: true,
    options: getProviderConnectionOptions(),
  }));

  secured.post(
    '/provider-oauth/huggingface/start',
    {
      schema: { tags: ['admin'] },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async () => ({ success: true, ...(await startHuggingFaceDeviceFlow()) }),
  );

  secured.post(
    '/provider-accounts/:accountId/oauth/huggingface/start',
    { schema: { tags: ['admin'] }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { accountId } = req.params as { accountId: string };
      return { success: true, ...(await startHuggingFaceDeviceFlow(accountId)) };
    },
  );

  secured.post(
    '/provider-oauth/huggingface/poll',
    {
      schema: { tags: ['admin'] },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const result = await pollHuggingFaceDeviceFlow(req.body);
      if (result.status === 'connected') await reloadRegistryAfterMutation();
      return { success: true, ...result };
    },
  );

  secured.post(
    '/provider-accounts/:accountId/oauth/huggingface/poll',
    { schema: { tags: ['admin'] }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const { accountId } = req.params as { accountId: string };
      const result = await pollHuggingFaceDeviceFlow(req.body, accountId);
      if (result.status === 'connected') await reloadRegistryAfterMutation();
      return { success: true, ...result };
    },
  );

  secured.post(
    '/provider-oauth/gemini/start',
    {
      schema: { tags: ['admin'] },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (_req, reply) => {
      const started = await startGeminiOAuth();
      reply.header('set-cookie', geminiStateCookie(started.state));
      return { success: true, authorizationUrl: started.authorizationUrl };
    },
  );

  secured.post(
    '/provider-accounts/:accountId/oauth/gemini/start',
    { schema: { tags: ['admin'] }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { accountId } = req.params as { accountId: string };
      const started = await startGeminiOAuth(accountId);
      reply.header('set-cookie', geminiStateCookie(started.state));
      return { success: true, authorizationUrl: started.authorizationUrl };
    },
  );

  secured.delete('/provider-oauth/:provider', { schema: { tags: ['admin'] } }, async (req) => {
    const { provider } = req.params as { provider: string };
    await disconnectProviderOAuthAccount(provider);
    await reloadRegistryAfterMutation();
    return { success: true };
  });

  secured.delete(
    '/provider-accounts/:accountId/oauth/:provider',
    { schema: { tags: ['admin'] } },
    async (req) => {
      const { accountId, provider } = req.params as { accountId: string; provider: string };
      await disconnectProviderOAuthAccount(provider, accountId);
      await reloadRegistryAfterMutation();
      return { success: true };
    },
  );

  // Providers + health + modelos
  secured.get('/providers', { schema: { tags: ['admin'] } }, async () => {
    await reloadRegistry();
    const providers = await Promise.all(
      registry.list().map(async (p) => {
        const health = await Promise.race([
          p.health(),
          new Promise<{ ok: boolean; message: string }>((resolve) =>
            setTimeout(() => resolve({ ok: false, message: 'probe em andamento' }), 5_000),
          ),
        ]).catch(() => ({ ok: false, message: 'probe indisponivel' }));
        let models: unknown[] = [];
        try {
          models = await p.models();
        } catch {
          /* provider offline */
        }
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
    const body = z
      .object({
        name: providerNameSchema,
        enabled: z.boolean().default(true),
        defaultChat: z.boolean().optional(),
        baseUrl: providerEndpointSchema.optional(),
        apiKey: z.string().max(8_192).optional(),
        accountId: z.string().trim().max(256).optional(),
        defaultModel: z.string().trim().max(256).optional(),
        embedModel: z.string().trim().max(256).optional(),
        authMode: z.enum(['apiKey', 'oauth', 'local']).optional(),
      })
      .superRefine((body, context) => {
        const localProviders = ['ollama', 'lmstudio', 'comfyui', 'forge', 'invokeai'];
        if (body.authMode === 'oauth' && !['gemini', 'huggingface'].includes(body.name)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'OAuth não está disponível para este provedor.',
          });
        }
        if (body.authMode === 'local' && !localProviders.includes(body.name)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A conexão local exige um provedor com servidor próprio.',
          });
        }
      })
      .parse(req.body);
    await saveProviderConfig(body);
    const updated = await reloadRegistryAfterMutation();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.configured', target: body.name },
    });
    return { success: true, registered: updated.has(body.name) };
  });

  secured.post(
    '/provider-configs/:name/test',
    { schema: { tags: ['admin'] } },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      await reloadRegistry();
      if (!registry.has(name))
        return reply
          .code(400)
          .send(fail('PROVIDER_NOT_CONFIGURED', 'Provider nao configurado ou desabilitado'));
      const health = await registry.get(name).health();
      return reply.code(health.ok ? 200 : 502).send({ success: health.ok, health });
    },
  );

  secured.post('/test-text', { schema: { tags: ['admin'] } }, async (req) => {
    const body = z
      .object({
        prompt: z.string().min(1).max(20000),
        provider: z.string().optional(),
        model: z.string().optional(),
      })
      .parse(req.body);
    return execute('chat', body, (provider) => provider.generateText(body) as any, {
      cache: false,
    });
  });
}
