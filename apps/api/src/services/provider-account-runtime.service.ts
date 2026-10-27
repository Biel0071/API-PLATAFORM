import {
  buildProviderAccountEnvironments,
  createRegistryFromEnv,
  ProviderAccountBinding,
  ProviderAccountPool,
  ProviderError,
  ProviderRegistry,
  resolveOAuthCredential,
  StoredProviderOAuth,
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
  name: 'gemini' | 'huggingface',
  oauth: StoredProviderOAuth,
): Promise<string | undefined> {
  return resolveOAuthCredential(
    {
      provider: name,
      secret: env.JWT_SECRET,
      clientId:
        name === 'gemini'
          ? process.env.GEMINI_OAUTH_CLIENT_ID
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
