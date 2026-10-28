import {
  buildProviderAccountEnvironments,
  createRegistryFromEnv,
  ProviderAccountBinding,
  ProviderAccountPool,
  ProviderError,
  ProviderRegistry,
  resolveOAuthCredential,
  StoredProviderOAuth,
  OAuthProviderName,
  withRedisLock,
} from '@api-platform/shared';
import type { ProviderAccount } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { isProviderProbeExcluded } from './provider-probe-policy';
import { redis } from '../lib/redis';

type RuntimeAccount = ProviderAccount & {
  provider: { name: string; enabled: boolean; baseUrl: string | null; settings: unknown };
};

const accountInstanceCache = new Map<
  string,
  { updatedAt: number; provider: ProviderAccountBinding['provider']; configured: boolean }
>();

async function loadAccounts(): Promise<RuntimeAccount[]> {
  return prisma.providerAccount.findMany({
    where: { disconnectedAt: null },
    include: { provider: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }) as Promise<RuntimeAccount[]>;
}

async function oauthToken(
  accountId: string,
  name: OAuthProviderName,
  oauth: StoredProviderOAuth,
): Promise<string | undefined> {
  return resolveOAuthCredential(
    {
      provider: name,
      secret: env.JWT_SECRET,
      clientId:
        name === 'gemini'
          ? process.env.GEMINI_OAUTH_CLIENT_ID
          : name === 'openai'
            ? (process.env.OPENAI_CODEX_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann')
            : name === 'anthropic'
              ? (process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
              : process.env.HUGGINGFACE_OAUTH_CLIENT_ID,
      clientSecret:
        name === 'gemini'
          ? process.env.GEMINI_OAUTH_CLIENT_SECRET
          : process.env.HUGGINGFACE_OAUTH_CLIENT_SECRET,
      withLock: (key, operation) => withRedisLock(redis, `${key}:${accountId}`, operation),
      load: async () => {
        const current = await prisma.providerAccount.findUnique({ where: { id: accountId } });
        return storedOAuth(current);
      },
      save: async (updated) => {
        await prisma.providerAccount.update({
          where: { id: accountId },
          data: {
            oauthProvider: updated.provider,
            oauthAccessTokenEncrypted: updated.accessTokenEncrypted,
            oauthRefreshTokenEncrypted: updated.refreshTokenEncrypted ?? null,
            oauthExpiresAt: updated.expiresAt ? new Date(updated.expiresAt) : null,
            oauthScope: updated.scope ?? null,
            oauthNeedsReauth: updated.reauthRequired ?? false,
          },
        });
      },
    },
    oauth,
  );
}

function storedOAuth(account: ProviderAccount | null): StoredProviderOAuth | undefined {
  if (!account?.oauthProvider || !account.oauthAccessTokenEncrypted) return undefined;
  return {
    provider: account.oauthProvider as StoredProviderOAuth['provider'],
    accessTokenEncrypted: account.oauthAccessTokenEncrypted,
    refreshTokenEncrypted: account.oauthRefreshTokenEncrypted ?? undefined,
    expiresAt: account.oauthExpiresAt?.getTime(),
    scope: account.oauthScope ?? undefined,
    reauthRequired: account.oauthNeedsReauth,
  };
}

export async function loadProviderAccountRuntime(
  registry: ProviderRegistry,
  nextIndex: (providerName: string, count: number) => Promise<number> = async () => 0,
): Promise<{ registry: ProviderRegistry; pool: ProviderAccountPool }> {
  const accounts = await loadAccounts();
  const rows = await buildProviderAccountEnvironments(accounts, env.JWT_SECRET, oauthToken);
  const liveIds = new Set(accounts.map((account) => account.id));
  for (const id of accountInstanceCache.keys())
    if (!liveIds.has(id)) accountInstanceCache.delete(id);

  const bindings: ProviderAccountBinding[] = [];
  for (const row of rows) {
    const account = accounts.find((item) => item.id === row.accountId)!;
    let cached = accountInstanceCache.get(account.id);
    let accountConfigured = cached?.configured ?? true;
    if (!cached || cached.updatedAt !== account.updatedAt.getTime()) {
      const accountRegistry = createRegistryFromEnv(row.env);
      accountConfigured = accountRegistry.has(row.providerName);
      const provider = accountConfigured
        ? accountRegistry.get(row.providerName)
        : registry.has(row.providerName)
          ? registry.get(row.providerName)
          : undefined;
      if (!provider) continue;
      cached = { updatedAt: account.updatedAt.getTime(), provider, configured: accountConfigured };
      accountInstanceCache.set(account.id, cached);
    }
    bindings.push({
      accountId: account.id,
      providerName: row.providerName,
      provider: cached.provider,
      configured: accountConfigured,
      enabled:
        accountConfigured && account.enabled && account.provider.enabled && !account.disconnectedAt,
      healthOk: account.healthOk,
      healthCheckedAt: account.healthCheckedAt,
      healthLatencyMs: account.healthLatencyMs,
      authMode: account.authMode,
      accountTier: typeof (account.settings as any)?.accountTier === 'string' ? (account.settings as any).accountTier : undefined,
      defaultModel: typeof (account.settings as any)?.defaultModel === 'string' ? (account.settings as any).defaultModel : undefined,
    });
  }

  // Keep provider identity/capabilities available to registry candidate resolution.
  for (const binding of bindings) {
    if (!registry.has(binding.providerName)) registry.register(binding.provider);
  }
  const healthMaxAgeMs = Number(process.env.PROVIDER_ACCOUNT_HEALTH_MAX_AGE_MS || 3600_000);
  const pool = new ProviderAccountPool(async () => bindings, nextIndex, healthMaxAgeMs);
  registry.setAccountPool(pool);
  return { registry, pool };
}

export async function testProviderAccountHealth(accountId: string) {
  const runtime = await loadProviderAccountRuntime(createRegistryFromEnv(process.env));
  const account = await runtime.pool.resolveAccount(accountId);
  if (!account)
    throw new ProviderError(
      'provider-account',
      'connection not found',
      'PROVIDER_ACCOUNT_NOT_FOUND',
      404,
      false,
    );
  if (isProviderProbeExcluded(account.providerName))
    throw new ProviderError(
      account.providerName,
      'Provider excluído das sondas nesta implantação',
      'PROVIDER_PROBE_EXCLUDED',
      409,
      false,
    );
  if (!account.configured)
    throw new ProviderError(
      account.providerName,
      'credentials are not configured for this account',
      'PROVIDER_ACCOUNT_NOT_CONFIGURED',
      409,
      false,
    );
  const startedAt = Date.now();
  let result;
  try {
    result = await account.provider.health();
  } catch (error) {
    result = {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'Health check failed',
    };
  }
  let modelCount = result.modelCount ?? null;
  if (result.ok && result.modelCount === undefined) {
    try {
      modelCount = (await account.provider.models()).length;
    } catch {
      result = { ...result, ok: false, message: 'Conexão respondeu, mas a descoberta de modelos falhou' };
    }
  }
  const checkedAt = new Date();
  const latencyMs = Math.max(result.latencyMs ?? 0, Date.now() - startedAt);
  await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      healthOk: result.ok,
      healthCheckedAt: checkedAt,
      healthLatencyMs: Number.isFinite(latencyMs)
        ? Math.max(0, Math.round(latencyMs))
        : null,
    },
  });
  return {
    ok: result.ok,
    latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null,
    modelCount,
    checkedAt: checkedAt.toISOString(),
    message: result.message,
  };
}

export interface AccountIdentificationResult {
  tier: 'free' | 'go' | 'tier1' | 'plus' | 'pro' | 'ultra' | 'dedicated';
  tierLabel: string;
  defaultModel: string;
  availableModels: string[];
  modelCount: number;
  quota5hTokens: number;
  quota7dTokens: number;
  latencyMs: number;
  reason: string;
}

/** Auto-identifica o tier da conta, modelos disponíveis e cotas de tokens a partir da API real do provedor. */
export async function autoIdentifyProviderAccount(accountId: string): Promise<{
  health: { ok: boolean; latencyMs: number | null; message?: string };
  identified: AccountIdentificationResult;
}> {
  const runtime = await loadProviderAccountRuntime(createRegistryFromEnv(process.env));
  const account = await runtime.pool.resolveAccount(accountId);
  if (!account) {
    throw new ProviderError(
      'provider-account',
      'connection not found',
      'PROVIDER_ACCOUNT_NOT_FOUND',
      404,
      false,
    );
  }
  if (!account.configured) {
    throw new ProviderError(
      account.providerName,
      'credentials are not configured for this account',
      'PROVIDER_ACCOUNT_NOT_CONFIGURED',
      409,
      false,
    );
  }

  const startedAt = Date.now();
  let models: Array<{ id: string; name?: string }> = [];
  let probeOk = false;
  let probeMessage: string | undefined;

  try {
    const rawModels = await account.provider.models();
    models = rawModels.map((m) => ({ id: m.id, name: m.name }));
    probeOk = true;
  } catch (err) {
    try {
      const h = await account.provider.health();
      probeOk = h.ok;
      probeMessage = h.message;
    } catch (hErr) {
      probeOk = false;
      probeMessage = hErr instanceof Error ? hErr.message : String(hErr);
    }
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);
  const checkedAt = new Date();

  await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      healthOk: probeOk,
      healthCheckedAt: checkedAt,
      healthLatencyMs: latencyMs,
    },
  });

  const modelIds = models.map((m) => m.id.toLowerCase());
  const provider = account.providerName.toLowerCase();

  let tier: 'free' | 'go' | 'tier1' | 'plus' | 'pro' | 'ultra' | 'dedicated' = 'pro';
  let defaultModel = '';
  let reason = '';

  const quota5hMap: Record<string, number> = {
    free: 150_000,
    go: 500_000,
    tier1: 1_000_000,
    plus: 2_500_000,
    pro: 10_000_000,
    ultra: 50_000_000,
    dedicated: 100_000_000,
  };
  const quota7dMap: Record<string, number> = {
    free: 1_000_000,
    go: 3_500_000,
    tier1: 7_000_000,
    plus: 15_000_000,
    pro: 60_000_000,
    ultra: 300_000_000,
    dedicated: 600_000_000,
  };

  if (['ollama', 'lmstudio', 'comfyui', 'forge', 'invokeai'].includes(provider)) {
    tier = 'dedicated';
    defaultModel =
      models.find((m) => m.id.includes('coder') || m.id.includes('llama') || m.id.includes('qwen'))?.id ||
      models[0]?.id ||
      'qwen2.5-coder:1.5b';
    reason = `Servidor local dedicado (${models.length} modelos locais disponíveis, uso ilimitado 24/7)`;
  } else if (provider === 'openai') {
    if (modelIds.some((id) => id.includes('o1-preview') || id.includes('o1-mini') || id.includes('o3'))) {
      tier = 'ultra';
      defaultModel = models.find((m) => m.id === 'o1-preview' || m.id === 'gpt-4o')?.id || 'gpt-4o';
      reason = 'Conta OpenAI de alta capacidade com acesso a modelos o1 de raciocínio avançado';
    } else if (modelIds.some((id) => id.includes('gpt-4o') || id.includes('gpt-4'))) {
      tier = 'pro';
      defaultModel = models.find((m) => m.id === 'gpt-4o')?.id || 'gpt-4o';
      reason = 'Conta OpenAI Pro com acesso a GPT-4o e inferência de código Codex';
    } else if (modelIds.some((id) => id.includes('gpt-4o-mini') || id.includes('gpt-3.5'))) {
      tier = 'plus';
      defaultModel = models.find((m) => m.id === 'gpt-4o-mini')?.id || 'gpt-4o-mini';
      reason = 'Conta OpenAI Plus com modelos otimizados para alta vazão';
    } else {
      tier = 'go';
      defaultModel = models[0]?.id || 'gpt-4o-mini';
      reason = 'Conta OpenAI padrão com acesso básico';
    }
  } else if (provider === 'anthropic') {
    if (modelIds.some((id) => id.includes('opus'))) {
      tier = 'ultra';
      defaultModel = models.find((m) => m.id.includes('sonnet') || m.id.includes('opus'))?.id || 'claude-3-5-sonnet-20241022';
      reason = 'Conta Anthropic com acesso a Claude 3 Opus e Sonnet';
    } else if (modelIds.some((id) => id.includes('sonnet'))) {
      tier = 'pro';
      defaultModel = models.find((m) => m.id.includes('sonnet'))?.id || 'claude-3-5-sonnet-20241022';
      reason = 'Conta Anthropic Pro com Claude 3.5 Sonnet para programação e análise profunda';
    } else {
      tier = 'plus';
      defaultModel = models.find((m) => m.id.includes('haiku'))?.id || 'claude-3-5-haiku-20241022';
      reason = 'Conta Anthropic com Claude 3.5 Haiku';
    }
  } else if (provider === 'gemini') {
    if (modelIds.some((id) => id.includes('2.0') || id.includes('ultra'))) {
      tier = 'ultra';
      defaultModel = models.find((m) => m.id.includes('2.0'))?.id || 'gemini-2.0-flash-exp';
      reason = 'Conta Google Gemini experimental de última geração';
    } else if (modelIds.some((id) => id.includes('1.5-pro') || id.includes('pro'))) {
      tier = 'pro';
      defaultModel = models.find((m) => m.id.includes('1.5-pro'))?.id || 'gemini-1.5-pro';
      reason = 'Conta Google Gemini Pro com raciocínio multimodal';
    } else {
      tier = 'plus';
      defaultModel = models.find((m) => m.id.includes('flash'))?.id || 'gemini-1.5-flash';
      reason = 'Conta Google Gemini com modelo rápido Flash';
    }
  } else if (provider === 'groq') {
    if (modelIds.some((id) => id.includes('70b'))) {
      tier = 'pro';
      defaultModel = models.find((m) => m.id.includes('70b'))?.id || 'llama-3.3-70b-versatile';
      reason = 'Acesso Groq LPU com modelos 70B de alta capacidade e latência ultra-baixa';
    } else {
      tier = 'plus';
      defaultModel = models.find((m) => m.id.includes('8b'))?.id || 'llama-3.1-8b-instant';
      reason = 'Acesso Groq LPU instantâneo';
    }
  } else if (provider === 'xai') {
    tier = 'plus';
    defaultModel = models.find((m) => m.id.includes('grok'))?.id || 'grok-beta';
    reason = 'Conta xAI Grok com acesso direto a grok-beta';
  } else {
    tier = models.length > 5 ? 'pro' : 'plus';
    defaultModel = models[0]?.id || 'default';
    reason = `Conta identificada com ${models.length} modelos disponíveis`;
  }

  const dbAccount = await prisma.providerAccount.findUnique({
    where: { id: accountId },
    include: { provider: true },
  });
  const currentSettings =
    dbAccount?.settings && typeof dbAccount.settings === 'object' && !Array.isArray(dbAccount.settings)
      ? { ...(dbAccount.settings as Record<string, any>) }
      : {};

  currentSettings.accountTier = tier;
  if (!currentSettings.defaultModel || !models.some((m) => m.id === currentSettings.defaultModel)) {
    currentSettings.defaultModel = defaultModel;
  } else {
    defaultModel = currentSettings.defaultModel;
  }

  await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      settings: currentSettings,
    },
  });

  const tierLabels: Record<string, string> = {
    free: 'FREE (150k/5h · 1M Semanal)',
    go: 'GO (500k/5h · 3.5M Semanal)',
    tier1: 'TIER 1 (1M/5h · 7M Semanal)',
    plus: 'PLUS (2.5M/5h · 15M Semanal)',
    pro: 'PRO (10M/5h · 60M Semanal)',
    ultra: 'ULTRA (50M/5h · 300M Semanal)',
    dedicated: 'DEDICATED (Ilimitado Local 24/7)',
  };

  const identified: AccountIdentificationResult = {
    tier,
    tierLabel: tierLabels[tier] || tier.toUpperCase(),
    defaultModel,
    availableModels: models.map((m) => m.id),
    modelCount: models.length,
    quota5hTokens: quota5hMap[tier] || 10_000_000,
    quota7dTokens: quota7dMap[tier] || 60_000_000,
    latencyMs,
    reason,
  };

  return {
    health: {
      ok: probeOk,
      latencyMs,
      message: probeMessage || (probeOk ? 'Conta auto-identificada e validada com sucesso' : 'Falha na validação da conta'),
    },
    identified,
  };
}

/** Atualiza saúde e descoberta de modelos das contas habilitadas, uma por vez. */
export async function refreshConfiguredProviderAccountHealth(): Promise<Set<string>> {
  const runtime = await loadProviderAccountRuntime(createRegistryFromEnv(process.env));
  const accounts = await runtime.pool.listAccounts();
  const checkedProviders = new Set<string>();
  for (const account of accounts) {
    if (!account.enabled || !account.configured || isProviderProbeExcluded(account.providerName)) continue;
    try {
      await testProviderAccountHealth(account.accountId);
      checkedProviders.add(account.providerName);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'PROVIDER_PROBE_EXCLUDED') continue;
      // Keep checking other accounts when one provider is offline.
    }
  }
  return checkedProviders;
}
