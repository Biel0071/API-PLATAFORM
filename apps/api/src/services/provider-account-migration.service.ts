import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

const localProviders = new Set(['ollama', 'lmstudio', 'comfyui', 'forge', 'invokeai']);

function objectSettings(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function localEndpoint(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Additive import only: the legacy runtime still needs its original credentials and defaults. */
export async function backfillLegacyProviderAccounts(): Promise<number> {
  return prisma.$transaction(async (transaction) => {
    const providers = await transaction.providerConfig.findMany();
    const accounts: Prisma.ProviderAccountCreateManyInput[] = [];
    for (const provider of providers) {
      const settings = objectSettings(provider.settings);
      const oauth = objectSettings(settings.oauth);
      const baseUrl = nonemptyString(settings.baseUrl) ?? nonemptyString(provider.baseUrl);
      const credentialEncrypted = nonemptyString(settings.apiKeyEncrypted);
      const oauthAccessTokenEncrypted = nonemptyString(oauth.accessTokenEncrypted);
      const legacyLocalMode =
        localProviders.has(provider.name) &&
        !credentialEncrypted &&
        (settings.authMode === undefined || settings.authMode === 'apiKey');
      const authMode =
        (legacyLocalMode ? 'local' : settings.authMode) ??
        (oauthAccessTokenEncrypted
          ? 'oauth'
          : localProviders.has(provider.name)
            ? 'local'
            : 'apiKey');
      if (
        (authMode !== 'apiKey' && authMode !== 'oauth' && authMode !== 'local') ||
        (authMode === 'apiKey' && !credentialEncrypted) ||
        (authMode === 'oauth' && !oauthAccessTokenEncrypted) ||
        (authMode === 'local' && (!localProviders.has(provider.name) || !localEndpoint(baseUrl)))
      )
        continue;

      // Keep only known connection options; defaults/model choices stay on ProviderConfig.
      const accountSettings: Prisma.InputJsonObject =
        provider.name === 'cloudflare' && typeof settings.accountId === 'string'
          ? { accountId: settings.accountId }
          : {};
      const expiresAt = typeof oauth.expiresAt === 'number' ? new Date(oauth.expiresAt) : null;
      accounts.push({
        providerId: provider.id,
        legacyProviderConfigId: provider.id,
        displayName: provider.name,
        authMode,
        baseUrl,
        settings: accountSettings,
        credentialEncrypted,
        oauthProvider: nonemptyString(oauth.provider),
        oauthAccessTokenEncrypted,
        oauthRefreshTokenEncrypted: nonemptyString(oauth.refreshTokenEncrypted),
        oauthExpiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
        oauthScope: nonemptyString(oauth.scope),
        oauthNeedsReauth: oauth.reauthRequired === true,
        enabled: provider.enabled,
        disconnectedAt: null,
        healthOk: null,
        healthCheckedAt: null,
        healthLatencyMs: null,
      });
    }
    if (!accounts.length) return 0;
    // The unique legacy source id plus ON CONFLICT DO NOTHING handles concurrent startups.
    const imported = await transaction.providerAccount.createMany({
      data: accounts,
      skipDuplicates: true,
    });
    return imported.count;
  });
}
