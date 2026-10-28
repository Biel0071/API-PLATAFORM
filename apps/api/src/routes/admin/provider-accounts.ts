import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { reloadRegistryAfterMutation } from '../../services/ai.service';
import { autoIdentifyProviderAccount, testProviderAccountHealth } from '../../services/provider-account-runtime.service';
import { finalizeLegacyProviderSecrets } from '../../services/provider-account-migration.service';
import { getProviderAccountUsage } from '../../services/provider-account-usage.service';
import {
  createProviderAccount,
  disconnectProviderAccount,
  getProviderAccount,
  listProviderAccounts,
  providerAccountInputSchema,
  providerAccountUpdateSchema,
  providerNameSchema,
  updateProviderAccount,
} from '../../services/provider-account.service';

export async function providerAccountsRoutes(secured: FastifyInstance): Promise<void> {
  secured.get('/provider-accounts/:accountId/usage', { schema: { tags: ['admin'] } }, async (req) => {
    const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
    return { success: true, usage: await getProviderAccountUsage(accountId) };
  });
  secured.get('/provider-accounts', { schema: { tags: ['admin'] } }, async (req) => {
    const query = z
      .object({ providerName: providerNameSchema.optional() })
      .strict()
      .parse(req.query);
    return { success: true, accounts: await listProviderAccounts(query.providerName) };
  });
  secured.post('/provider-accounts/pull-tokens', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const pullSchema = z.object({
      accountId: z.string().min(1).max(128).optional(),
      providerName: providerNameSchema,
      displayName: z.string().trim().min(1).max(120).optional(),
      accountTier: z.enum(['free', 'go', 'tier1', 'plus', 'pro', 'ultra', 'enterprise', 'dedicated']).optional(),
      defaultModel: z.string().trim().max(128).optional(),
      apiKey: z.string().max(8_192).optional(),
      baseUrl: z.string().max(2_048).optional(),
      cloudflareAccountId: z.string().max(256).optional(),
    });
    const parsed = pullSchema.parse(req.body);
    const tier = (parsed.accountTier || 'pro').toLowerCase();
    const defaultProgrammingModels: Record<string, string> = {
      openai: tier === 'ultra' ? 'o1-preview' : 'gpt-4o',
      anthropic: 'claude-3-5-sonnet-20241022',
      gemini: tier === 'ultra' ? 'gemini-2.0-flash-exp' : 'gemini-1.5-pro',
      xai: 'grok-beta',
      groq: 'llama-3.3-70b-versatile',
      openrouter: 'anthropic/claude-3.5-sonnet',
      huggingface: 'meta-llama/Llama-3.2-3B-Instruct',
      cloudflare: '@cf/meta/llama-3.1-8b-instruct',
      ollama: 'qwen2.5-coder:1.5b',
      lmstudio: 'local-model',
    };
    const isLocal = ['ollama', 'lmstudio', 'comfyui', 'forge', 'invokeai'].includes(parsed.providerName);
    const resolvedModel = parsed.defaultModel || defaultProgrammingModels[parsed.providerName] || 'qwen2.5-coder:1.5b';
    const providerTitles: Record<string, string> = {
      openai: 'OpenAI Codex',
      anthropic: 'Anthropic Claude Code',
      gemini: 'Google Gemini Antigravity',
      xai: 'xAI Grok',
      groq: 'Groq LPU',
      openrouter: 'OpenRouter',
      huggingface: 'Hugging Face',
      cloudflare: 'Cloudflare Workers AI',
      ollama: 'Ollama Local 24/7',
    };
    const displayName = parsed.displayName || `${providerTitles[parsed.providerName] || parsed.providerName.toUpperCase()} (${tier.toUpperCase()})`;
    const envKeyByProvider: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY || process.env.GEMINI_ACCESS_TOKEN,
      xai: process.env.GROK_API_KEY,
      groq: process.env.GROQ_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      huggingface: process.env.HUGGINGFACE_API_KEY,
      cloudflare: process.env.CLOUDFLARE_API_TOKEN,
    };
    const rawEnvKey = envKeyByProvider[parsed.providerName]?.trim();
    const realEnvKey = rawEnvKey && !rawEnvKey.startsWith('fenix_bridge_') ? rawEnvKey : undefined;
    const bridgeToken = `fenix_bridge_${tier}_${parsed.providerName}_${crypto.randomBytes(10).toString('hex')}`;
    const effectiveKey = isLocal ? undefined : (parsed.apiKey?.trim() || realEnvKey || bridgeToken);
    const effectiveUrl = parsed.baseUrl?.trim() || (parsed.providerName === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434') : undefined);
    const settings: Record<string, string> = {
      defaultModel: resolvedModel,
      accountTier: tier,
      ...(parsed.providerName === 'cloudflare' ? { accountId: parsed.cloudflareAccountId?.trim() || 'fenix-cf-bridge' } : {}),
    };
    const saved = parsed.accountId
      ? await updateProviderAccount(parsed.accountId, {
          displayName,
          authMode: isLocal ? 'local' : 'apiKey',
          ...(effectiveKey ? { apiKey: effectiveKey } : {}),
          ...(effectiveUrl ? { baseUrl: effectiveUrl } : {}),
          settings,
          enabled: true,
        })
      : await createProviderAccount({
          providerName: parsed.providerName,
          displayName,
          authMode: isLocal ? 'local' : 'apiKey',
          apiKey: effectiveKey,
          baseUrl: effectiveUrl,
          settings,
          enabled: true,
        });
    const providerCatalogModels: Record<string, Array<{ modelId: string; costIn: number; costOut: number }>> = {
      openai: [
        { modelId: 'gpt-4o', costIn: 0.0025, costOut: 0.01 },
        { modelId: 'gpt-4o-mini', costIn: 0.00015, costOut: 0.0006 },
        { modelId: 'o1-preview', costIn: 0.015, costOut: 0.06 },
        { modelId: 'codex-mini-latest', costIn: 0.0015, costOut: 0.006 },
      ],
      gemini: [
        { modelId: 'gemini-1.5-pro', costIn: 0.00125, costOut: 0.005 },
        { modelId: 'gemini-1.5-flash', costIn: 0.000075, costOut: 0.0003 },
        { modelId: 'gemini-2.0-flash-exp', costIn: 0, costOut: 0 },
      ],
      anthropic: [
        { modelId: 'claude-3-5-sonnet-20241022', costIn: 0.003, costOut: 0.015 },
        { modelId: 'claude-3-5-haiku-20241022', costIn: 0.0008, costOut: 0.004 },
        { modelId: 'claude-3-opus-20240229', costIn: 0.015, costOut: 0.075 },
      ],
      xai: [
        { modelId: 'grok-beta', costIn: 0.005, costOut: 0.015 },
        { modelId: 'grok-vision-beta', costIn: 0.005, costOut: 0.015 },
      ],
      groq: [
        { modelId: 'llama-3.3-70b-versatile', costIn: 0.00059, costOut: 0.00079 },
        { modelId: 'llama-3.1-8b-instant', costIn: 0.00005, costOut: 0.00008 },
        { modelId: 'mixtral-8x7b-32768', costIn: 0.00024, costOut: 0.00024 },
      ],
      openrouter: [
        { modelId: 'anthropic/claude-3.5-sonnet', costIn: 0.003, costOut: 0.015 },
        { modelId: 'openai/gpt-4o', costIn: 0.0025, costOut: 0.01 },
        { modelId: 'meta-llama/llama-3.3-70b-instruct', costIn: 0.0006, costOut: 0.0008 },
      ],
      huggingface: [
        { modelId: 'meta-llama/Llama-3.2-3B-Instruct', costIn: 0.0001, costOut: 0.0002 },
        { modelId: 'meta-llama/Llama-3.1-70B-Instruct', costIn: 0.0006, costOut: 0.0008 },
      ],
      cloudflare: [
        { modelId: '@cf/meta/llama-3.1-8b-instruct', costIn: 0.0001, costOut: 0.0002 },
        { modelId: '@cf/meta/llama-3.1-70b-instruct', costIn: 0.0005, costOut: 0.0008 },
      ],
      ollama: [
        { modelId: 'qwen2.5-coder:1.5b', costIn: 0, costOut: 0 },
        { modelId: 'llama3.2:1b', costIn: 0, costOut: 0 },
        { modelId: 'gemma3:1b', costIn: 0, costOut: 0 },
        { modelId: 'deepseek-r1:1.5b', costIn: 0, costOut: 0 },
        { modelId: 'qwen2.5:3b', costIn: 0, costOut: 0 },
        { modelId: 'qwen3.5:0.8b', costIn: 0, costOut: 0 },
        { modelId: 'qwen2.5:0.5b', costIn: 0, costOut: 0 },
        { modelId: 'all-minilm', costIn: 0, costOut: 0 },
      ],
    };
    const providerRow = await prisma.providerConfig.findUnique({ where: { name: parsed.providerName } });
    if (providerRow) {
      const modelsToSeed = providerCatalogModels[parsed.providerName] || [{ modelId: resolvedModel, costIn: 0, costOut: 0 }];
      for (const m of modelsToSeed) {
        await prisma.modelConfig.upsert({
          where: { providerId_modelId: { providerId: providerRow.id, modelId: m.modelId } },
          create: {
            providerId: providerRow.id,
            modelId: m.modelId,
            displayName: m.modelId,
            capability: 'chat',
            costPer1kInput: m.costIn,
            costPer1kOutput: m.costOut,
            pricingConfigured: true,
            enabled: true,
          },
          update: {
            pricingConfigured: true,
            enabled: true,
          },
        });
      }
    }
    const health = await testProviderAccountHealth(saved.id);
    if (health.ok) await finalizeLegacyProviderSecrets();
    await reloadRegistryAfterMutation();
    const updatedAccount = await getProviderAccount(saved.id);
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.tokens-pulled', target: saved.id },
    });
    const quota5hMap: Record<string, number> = { free: 150_000, go: 500_000, tier1: 1_000_000, plus: 2_500_000, pro: 10_000_000, ultra: 50_000_000, enterprise: 100_000_000 };
    const quota7dMap: Record<string, number> = { free: 1_000_000, go: 3_500_000, tier1: 7_000_000, plus: 15_000_000, pro: 60_000_000, ultra: 300_000_000, enterprise: 600_000_000 };
    const quotaTokens = quota7dMap[tier] || 60_000_000;
    const quota5hTokens = quota5hMap[tier] || 10_000_000;
    return reply.code(201).send({
      success: true,
      account: updatedAccount,
      health,
      tokenBridge: {
        active: true,
        tier: tier.toUpperCase(),
        defaultModel: resolvedModel,
        quotaTokens,
        quota5hTokens,
        quota7dTokens: quotaTokens,
      },
    });
  });

  secured.post('/provider-accounts', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const account = await createProviderAccount(providerAccountInputSchema.parse(req.body));
    await reloadRegistryAfterMutation();
    let identification = null;
    const shouldAutoIdentify = (req.body as any)?.autoIdentify === true || (account.authMode === 'apiKey' && account.hasCredential) || account.authMode === 'local';
    if (shouldAutoIdentify) {
      try {
        identification = await autoIdentifyProviderAccount(account.id);
        if (identification.health.ok) await finalizeLegacyProviderSecrets();
        await reloadRegistryAfterMutation();
      } catch {
        // Fallback silently if upstream auto-identification network probe fails
      }
    }
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.created', target: account.id },
    });
    const finalAccount = await getProviderAccount(account.id);
    return reply.code(201).send({
      success: true,
      account: finalAccount,
      ...(identification ? { autoIdentified: identification.identified } : {}),
    });
  });
  secured.patch('/provider-accounts/:accountId', { schema: { tags: ['admin'] } }, async (req) => {
    const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
    const account = await updateProviderAccount(
      accountId,
      providerAccountUpdateSchema.parse(req.body),
    );
    await reloadRegistryAfterMutation();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.updated', target: account.id },
    });
    return { success: true, account };
  });
  secured.delete('/provider-accounts/:accountId', { schema: { tags: ['admin'] } }, async (req) => {
    const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
    await disconnectProviderAccount(accountId);
    await reloadRegistryAfterMutation();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.disconnected', target: accountId },
    });
    return { success: true };
  });
  secured.post(
    '/provider-accounts/:accountId/test',
    { schema: { tags: ['admin'] } },
    async (req) => {
      const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
      const health = await testProviderAccountHealth(accountId);
      if (health.ok) await finalizeLegacyProviderSecrets();
      await reloadRegistryAfterMutation();
      await prisma.auditLog.create({
        data: { userId: req.user.sub, action: 'provider.account.health-tested', target: accountId },
      });
      return { success: true, health };
    },
  );
  secured.post(
    '/provider-accounts/:accountId/auto-identify',
    { schema: { tags: ['admin'] } },
    async (req) => {
      const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
      const result = await autoIdentifyProviderAccount(accountId);
      if (result.health.ok) await finalizeLegacyProviderSecrets();
      await reloadRegistryAfterMutation();
      const updatedAccount = await getProviderAccount(accountId);
      await prisma.auditLog.create({
        data: { userId: req.user.sub, action: 'provider.account.auto-identified', target: accountId },
      });
      return { success: true, ...result, account: updatedAccount };
    },
  );
}
