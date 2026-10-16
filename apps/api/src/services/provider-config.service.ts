import {
  buildProviderEnvironment,
  encryptCredential,
  resolveOAuthCredential,
  StoredProviderOAuth,
  withRedisLock,
} from '@api-platform/shared';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { env } from '../config/env';
import { sanitizeProviderEndpoint, syncLegacyProviderAccount } from './provider-account.service';

export interface ProviderForm {
  name: string;
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  accountId?: string;
  defaultModel?: string;
  embedModel?: string;
  defaultChat?: boolean;
  authMode?: 'apiKey' | 'oauth' | 'local';
  accountTier?: string;
}

type StoredSettings = Omit<ProviderForm, 'name' | 'enabled' | 'apiKey'> & {
  apiKeyEncrypted?: string;
  oauth?: StoredProviderOAuth;
};

export async function saveProviderConfig(form: ProviderForm): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.providerConfig.findUnique({ where: { name: form.name } });
    const old = (current?.settings ?? {}) as StoredSettings;
    const baseUrl = form.baseUrl === undefined ? old.baseUrl ?? current?.baseUrl ?? undefined : form.baseUrl || undefined;
    const settings: StoredSettings = {
      baseUrl,
      accountId: form.accountId === undefined ? old.accountId : form.accountId || undefined,
      defaultModel: form.defaultModel === undefined ? old.defaultModel : form.defaultModel || undefined,
      embedModel: form.embedModel === undefined ? old.embedModel : form.embedModel || undefined,
      defaultChat: form.defaultChat ?? old.defaultChat,
      authMode: form.authMode ?? old.authMode ?? 'apiKey',
      accountTier: form.accountTier === undefined ? old.accountTier : form.accountTier || undefined,
      apiKeyEncrypted: form.apiKey?.trim() ? encryptCredential(form.apiKey.trim(), env.JWT_SECRET) : old.apiKeyEncrypted,
      oauth: old.oauth,
    };
    const provider = await transaction.providerConfig.upsert({
      where: { name: form.name },
      create: { name: form.name, enabled: form.enabled, baseUrl, settings: settings as object },
      update: { enabled: form.enabled, baseUrl: baseUrl ?? null, settings: settings as object },
    });
    await syncLegacyProviderAccount(transaction, provider);
    if (form.defaultChat === true) {
      const rows = await transaction.providerConfig.findMany();
      for (const row of rows) {
        if (row.name !== form.name && (row.settings as StoredSettings | null)?.defaultChat) {
          await transaction.providerConfig.update({
            where: { name: row.name },
            data: { settings: { ...(row.settings as StoredSettings), defaultChat: false } as object },
          });
        }
      }
    }
  });
}

export async function listProviderConfigs() {
  const rows = await prisma.providerConfig.findMany({ orderBy: { name: 'asc' }, include: { models: true } });
  return rows.map((row: typeof rows[0]) => {
    const settings = (row.settings ?? {}) as StoredSettings;
    const oauth = settings.oauth;
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      baseUrl: sanitizeProviderEndpoint(row.baseUrl),
      settings: {
        baseUrl: sanitizeProviderEndpoint(settings.baseUrl),
        accountId: settings.accountId,
        defaultModel: settings.defaultModel,
        embedModel: settings.embedModel,
        defaultChat: settings.defaultChat,
        authMode: settings.authMode,
        accountTier: settings.accountTier,
      },
      hasApiKey: Boolean(settings.apiKeyEncrypted),
      hasOAuth: Boolean(oauth?.accessTokenEncrypted),
      oauthNeedsReauth: Boolean(oauth?.reauthRequired),
      oauthExpiresAt: oauth?.expiresAt,
      oauthProvider: oauth?.provider,
      models: row.models ?? [],
    };
  });
}

export async function readProviderSettings(name: string): Promise<StoredSettings> {
  const row = await prisma.providerConfig.findUnique({ where: { name } });
  return (row?.settings ?? {}) as StoredSettings;
}

export async function saveProviderOAuth(
  name: 'gemini' | 'huggingface',
  oauth: StoredProviderOAuth,
): Promise<void> {
  const current = await prisma.providerConfig.findUnique({ where: { name } });
  const settings = { ...((current?.settings ?? {}) as StoredSettings), authMode: 'oauth', oauth };
  await prisma.providerConfig.upsert({
    where: { name },
    create: { name, enabled: true, settings: settings as object },
    update: { enabled: true, settings: settings as object },
  });
}

export async function updateProviderOAuth(
  name: 'gemini' | 'huggingface',
  oauth: StoredProviderOAuth,
): Promise<void> {
  const current = await prisma.providerConfig.findUnique({ where: { name } });
  if (!current) return;
  const settings = { ...((current.settings ?? {}) as StoredSettings), oauth };
  await prisma.providerConfig.update({ where: { name }, data: { settings: settings as object } });
}

export async function disconnectProviderOAuth(name: 'gemini' | 'huggingface'): Promise<void> {
  const current = await prisma.providerConfig.findUnique({ where: { name } });
  if (!current) return;
  const settings = { ...((current.settings ?? {}) as StoredSettings) };
  delete settings.oauth;
  const hasApiKey = Boolean(settings.apiKeyEncrypted);
  settings.authMode = 'apiKey';
  await prisma.providerConfig.update({
    where: { name },
    data: { settings: settings as object, ...(hasApiKey ? {} : { enabled: false }) },
  });
}

export async function buildProviderEnv(baseEnv: Record<string, string | undefined> = process.env): Promise<Record<string, string | undefined>> {
  const rows = await prisma.providerConfig.findMany();
  return buildProviderEnvironment(rows, baseEnv, env.JWT_SECRET, (name, oauth) => resolveOAuthCredential({
    provider: name,
    secret: env.JWT_SECRET,
    clientId: name === 'gemini' ? process.env.GEMINI_OAUTH_CLIENT_ID : process.env.HUGGINGFACE_OAUTH_CLIENT_ID,
    clientSecret: name === 'gemini' ? process.env.GEMINI_OAUTH_CLIENT_SECRET : process.env.HUGGINGFACE_OAUTH_CLIENT_SECRET,
    withLock: (key, operation) => withRedisLock(redis, key, operation),
    load: async () => (await readProviderSettings(name)).oauth,
    save: (updated) => updateProviderOAuth(name, updated),
  }, oauth));
}
