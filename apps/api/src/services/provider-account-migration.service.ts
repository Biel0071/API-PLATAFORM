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

function validatedAccount(provider: any): boolean {
  const account = provider.legacyAccount;
  if (!account || account.legacyProviderConfigId !== provider.id || account.providerId !== provider.id) return false;
  if (!account.enabled || account.disconnectedAt || account.healthOk !== true) return false;
  if (!(account.healthCheckedAt instanceof Date) || Date.now() - account.healthCheckedAt.getTime() > 15 * 60_000) return false;
  if (account.authMode === 'apiKey') return nonemptyString(account.credentialEncrypted) !== null;
  if (account.authMode === 'oauth') {
    if (!nonemptyString(account.oauthAccessTokenEncrypted) || account.oauthNeedsReauth) return false;
    const expiresAt = account.oauthExpiresAt instanceof Date ? account.oauthExpiresAt.getTime() : null;
    return expiresAt === null || expiresAt > Date.now() || nonemptyString(account.oauthRefreshTokenEncrypted) !== null;
  }
  if (account.authMode === 'local') return localProviders.has(provider.name) && localEndpoint(nonemptyString(account.baseUrl));
  return false;
}

function clearLegacySecrets(value: Prisma.JsonValue | undefined): Prisma.InputJsonObject | null {
  const settings = objectSettings(value);
  const cleaned: Record<string, Prisma.InputJsonValue> = { ...settings } as Record<string, Prisma.InputJsonValue>;
  let changed = false;
  for (const key of ['apiKeyEncrypted', 'apiKey', 'token', 'accessToken', 'refreshToken', 'clientSecret']) {
    if (Object.prototype.hasOwnProperty.call(cleaned, key)) {
      delete cleaned[key];
      changed = true;
    }
  }
  const oauth = objectSettings(settings.oauth);
  const cleanedOauth: Record<string, Prisma.InputJsonValue> = { ...oauth } as Record<string, Prisma.InputJsonValue>;
  for (const key of ['accessTokenEncrypted', 'refreshTokenEncrypted', 'clientSecret']) {
    if (Object.prototype.hasOwnProperty.call(cleanedOauth, key)) {
      delete cleanedOauth[key];
      changed = true;
    }
  }
  if (changed) {
    if (Object.keys(cleanedOauth).length) cleaned.oauth = cleanedOauth;
    else delete cleaned.oauth;
  }
  return changed ? cleaned as Prisma.InputJsonObject : null;
}

/** Clears legacy credentials only after an account linked to this provider passed a recent real health check. */
export async function finalizeLegacyProviderSecrets(): Promise<number> {
  return prisma.$transaction(async (transaction) => {
    const providers = await transaction.providerConfig.findMany({ include: { legacyAccount: true } });
    let updated = 0;
    for (const provider of providers as any[]) {
      if (!validatedAccount(provider)) continue;
      const settings = clearLegacySecrets(provider.settings);
      if (!settings) continue;
      await transaction.providerConfig.update({ where: { id: provider.id }, data: { settings } });
      updated++;
    }
    return updated;
  });
}
