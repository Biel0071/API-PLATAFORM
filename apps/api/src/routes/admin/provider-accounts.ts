import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { reloadRegistryAfterMutation } from '../../services/ai.service';
import { testProviderAccountHealth } from '../../services/provider-account-runtime.service';
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
      accountTier: z.enum(['free', 'tier1', 'plus', 'pro', 'ultra', 'enterprise', 'dedicated']).optional(),
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
    const bridgeToken = `fenix_bridge_${tier}_${parsed.providerName}_${crypto.randomBytes(10).toString('hex')}`;
    const effectiveKey = isLocal ? undefined : (parsed.apiKey?.trim() || bridgeToken);
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
    const health = await testProviderAccountHealth(saved.id);
    if (health.ok) await finalizeLegacyProviderSecrets();
    await reloadRegistryAfterMutation();
    const updatedAccount = await getProviderAccount(saved.id);
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.tokens-pulled', target: saved.id },
    });
    const quotaTokens = tier === 'ultra' || tier === 'enterprise' ? 100_000_000 : tier === 'pro' ? 25_000_000 : 5_000_000;
    return reply.code(201).send({
      success: true,
      account: updatedAccount,
      health,
      tokenBridge: {
        active: true,
        tier: tier.toUpperCase(),
        defaultModel: resolvedModel,
        quotaTokens,
      },
    });
  });

  secured.post('/provider-accounts', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const account = await createProviderAccount(providerAccountInputSchema.parse(req.body));
    await reloadRegistryAfterMutation();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.created', target: account.id },
    });
    return reply.code(201).send({ success: true, account });
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
}
