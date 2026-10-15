import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { reloadRegistryAfterMutation } from '../../services/ai.service';
import { testProviderAccountHealth } from '../../services/provider-account-runtime.service';
import { getProviderAccountUsage } from '../../services/provider-account-usage.service';
import {
  createProviderAccount,
  disconnectProviderAccount,
  getProviderAccount,
  getProviderAccountCapabilities,
  getProviderAccountStatus,
  listProviderAccounts,
  providerAccountInputSchema,
  providerNameSchema,
} from '../../services/provider-account.service';
import {
  clearGeminiStateCookie,
  finishGeminiOAuth,
  geminiDashboardRedirect,
  geminiStateCookie,
  getProviderConnectionOptions,
  pollHuggingFaceDeviceFlow,
  ProviderOAuthError,
  startGeminiOAuth,
  startHuggingFaceDeviceFlow,
} from '../../services/provider-oauth.service';

const idParamSchema = z.object({ id: z.string().min(1).max(128) });
const providerParamSchema = z.object({ provider: providerNameSchema });

export const accountsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Autenticação para endpoints da API pública, exceto callback OAuth disparado pelo browser
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/accounts/') && req.url.includes('/callback')) {
      return;
    }
    await app.requireApiKey(req, reply);
  });

  // 1. GET /v1/accounts — Listagem higienizada de contas conectadas
  app.get('/accounts', { schema: { tags: ['v1', 'accounts'] } }, async (req) => {
    const query = z
      .object({ providerName: providerNameSchema.optional() })
      .strict()
      .parse(req.query);
    const accounts = await listProviderAccounts(query.providerName);
    return { success: true, accounts };
  });

  // 2. GET /v1/accounts/providers — Catálogo de provedores suportados e modos de autenticação
  app.get('/accounts/providers', { schema: { tags: ['v1', 'accounts'] } }, async () => {
    return {
      success: true,
      providers: getProviderConnectionOptions(),
    };
  });

  // 3. POST /v1/accounts/:provider/connect — Conectar conta (API Key, Local Server ou Iniciar OAuth)
  app.post('/accounts/:provider/connect', { schema: { tags: ['v1', 'accounts'] } }, async (req, reply) => {
    const { provider } = providerParamSchema.parse(req.params);
    const bodySchema = z.object({
      displayName: z.string().trim().min(1).max(120).optional(),
      authMode: z.enum(['apiKey', 'oauth', 'local']),
      apiKey: z.string().max(8_192).optional(),
      baseUrl: z.string().max(2_048).optional(),
      settings: z.record(z.union([z.string().max(2_048), z.number().finite(), z.boolean()])).optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = bodySchema.parse(req.body);
    const displayName = parsed.displayName || `${provider.toUpperCase()} (${parsed.authMode})`;

    if (parsed.authMode === 'oauth') {
      if (provider === 'gemini') {
        // Criar registro de conta primeiro para vincular o fluxo
        const account = await createProviderAccount({
          providerName: provider,
          displayName,
          authMode: 'oauth',
          baseUrl: parsed.baseUrl,
          settings: parsed.settings,
          enabled: parsed.enabled ?? true,
        });
        const started = await startGeminiOAuth(account.id);
        reply.header('set-cookie', geminiStateCookie(started.state));
        return reply.code(200).send({
          success: true,
          account,
          flowType: 'authorization_code',
          authorizationUrl: started.authorizationUrl,
          state: started.state,
        });
      } else if (provider === 'huggingface') {
        const account = await createProviderAccount({
          providerName: provider,
          displayName,
          authMode: 'oauth',
          baseUrl: parsed.baseUrl,
          settings: parsed.settings,
          enabled: parsed.enabled ?? true,
        });
        const started = await startHuggingFaceDeviceFlow(account.id);
        return reply.code(200).send({
          success: true,
          account,
          flowType: 'device_flow',
          flowId: started.flowId,
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          expiresAt: started.expiresAt,
          intervalSeconds: started.intervalSeconds,
        });
      } else {
        return reply.code(400).send({
          error: {
            code: 'OAUTH_NOT_SUPPORTED',
            message: `O provedor ${provider} não disponibiliza fluxo de autorização OAuth para inferência de terceiros. Utilize authMode: 'apiKey'.`,
          },
        });
      }
    }

    // authMode 'apiKey' ou 'local'
    const account = await createProviderAccount({
      providerName: provider,
      displayName,
      authMode: parsed.authMode,
      apiKey: parsed.apiKey,
      baseUrl: parsed.baseUrl,
      settings: parsed.settings,
      enabled: parsed.enabled ?? true,
    });
    await reloadRegistryAfterMutation();
    return reply.code(201).send({ success: true, account });
  });

  // 4. GET /v1/accounts/:provider/callback — Callback público de autorização OAuth
  app.get('/accounts/:provider/callback', async (req, reply) => {
    const { provider } = providerParamSchema.parse(req.params);
    const query = req.query as { code?: string; state?: string; error?: string };

    if (provider === 'gemini') {
      try {
        const status = await finishGeminiOAuth({
          code: query.code,
          state: query.state,
          error: query.error,
          cookieHeader: req.headers.cookie,
        });
        if (status === 'connected') await reloadRegistryAfterMutation();
        reply.header('set-cookie', clearGeminiStateCookie());

        const acceptsJson = req.headers.accept?.includes('application/json');
        if (acceptsJson) {
          return reply.send({ success: true, status });
        }
        return reply.redirect(geminiDashboardRedirect(status));
      } catch (error) {
        reply.header('set-cookie', clearGeminiStateCookie());
        if (error instanceof ProviderOAuthError) {
          const code =
            error.code === 'OAUTH_UPSTREAM_ERROR' || error.code === 'OAUTH_UPSTREAM_UNAVAILABLE'
              ? 'error'
              : undefined;
          if (code) return reply.redirect(geminiDashboardRedirect(code));
          return reply
            .code(error.statusCode)
            .type('text/html; charset=utf-8')
            .send(
              '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Conexão OAuth</title><body><main><h1>Não foi possível conectar a conta Google</h1><p>O estado da autorização expirou ou não corresponde a este navegador. Feche esta página e inicie a conexão novamente.</p><a href="/#/providers">Voltar aos provedores</a></main></body></html>',
            );
        }
        throw error;
      }
    }

    return reply.code(400).send({ error: { code: 'UNSUPPORTED_CALLBACK', message: `Callback não aplicável para ${provider}` } });
  });

  // 5. POST /v1/accounts/:id/disconnect — Desconectar / revogar conta
  app.post('/accounts/:id/disconnect', { schema: { tags: ['v1', 'accounts'] } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    await disconnectProviderAccount(id);
    await reloadRegistryAfterMutation();
    return reply.send({ success: true, disconnected: true });
  });

  // 6. POST /v1/accounts/:id/refresh — Renovação forçada de credencial / token
  app.post('/accounts/:id/refresh', { schema: { tags: ['v1', 'accounts'] } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const account = await getProviderAccount(id);
    await reloadRegistryAfterMutation();
    return reply.send({ success: true, refreshed: true, accountId: account.id, authMode: account.authMode });
  });

  // 7. POST /v1/accounts/:id/test — Teste live de saúde com latência real e contagem de modelos
  app.post('/accounts/:id/test', { schema: { tags: ['v1', 'accounts'] } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const health = await testProviderAccountHealth(id);
    await reloadRegistryAfterMutation();
    return reply.send({ success: true, health });
  });

  // 8. GET /v1/accounts/:id/status — Status detalhado da conexão, saúde e reautenticação
  app.get('/accounts/:id/status', { schema: { tags: ['v1', 'accounts'] } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const status = await getProviderAccountStatus(id);
    return reply.send({ success: true, status });
  });

  // 9. GET /v1/accounts/:id/usage — Consumo real de tokens e métricas (janelas 1h, 5h, 7d)
  app.get('/accounts/:id/usage', { schema: { tags: ['v1', 'accounts'] } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const usage = await getProviderAccountUsage(id);
    return reply.send({ success: true, usage });
  });

  // 10. GET /v1/accounts/:id/capabilities — Capacidades verificadas e modelos disponíveis para a conta
  app.get('/accounts/:id/capabilities', { schema: { tags: ['v1', 'accounts'] } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const capabilities = await getProviderAccountCapabilities(id);
    return reply.send({ success: true, capabilities });
  });
};
