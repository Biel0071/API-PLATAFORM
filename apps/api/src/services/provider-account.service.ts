import { encryptCredential } from '@api-platform/shared';
import type { Prisma, ProviderAccount, ProviderConfig } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';

export const providerNameSchema = z.enum([
  'openai',
  'anthropic',
  'xai',
  'ollama',
  'groq',
  'gemini',
  'openrouter',
  'huggingface',
  'cloudflare',
  'lmstudio',
  'comfyui',
  'forge',
  'invokeai',
]);
const localProviders = new Set(['ollama', 'lmstudio', 'comfyui', 'forge', 'invokeai']);
const oauthProviders = new Set(['gemini', 'huggingface']);
const authModeSchema = z.enum(['apiKey', 'oauth', 'local']);
export const providerEndpointSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Informe um endereço HTTP(S) sem credenciais, parâmetros ou fragmento.');
const accountFields = {
  providerName: providerNameSchema,
  displayName: z.string().trim().min(1).max(120),
  authMode: authModeSchema,
  baseUrl: providerEndpointSchema.optional(),
  apiKey: z.string().max(8_192).optional(),
  settings: z.record(z.union([z.string().max(2_048), z.number().finite(), z.boolean()])).optional(),
  enabled: z.boolean().optional(),
};
export const providerAccountInputSchema = z.object(accountFields).strict();
export const providerAccountUpdateSchema = providerAccountInputSchema.partial().strict();
export type ProviderAccountInput = z.infer<typeof providerAccountInputSchema>;
export type ProviderAccountUpdate = z.infer<typeof providerAccountUpdateSchema>;
export interface ProviderAccountView {
  id: string;
  providerName: string;
  displayName: string;
  authMode: 'apiKey' | 'oauth' | 'local';
  baseUrl: string | null;
  enabled: boolean;
  hasCredential: boolean;
  oauthNeedsReauth: boolean;
  health: { ok: boolean | null; checkedAt: string | null; latencyMs: number | null };
  accountId?: string;
  accountTier?: string;
  defaultModel?: string;
}

class ProviderAccountError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
function notFound(): never {
  throw new ProviderAccountError('Conexão não encontrada.', 404);
}
function objectSettings(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function sanitizeProviderEndpoint(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

const validAccountTiers = new Set([
  'free',
  'tier1',
  'plus',
  'pro',
  'ultra',
  'enterprise',
  'dedicated',
]);

function accountSettings(
  providerName: string,
  value: ProviderAccountInput['settings'],
): Prisma.InputJsonObject {
  const settings = value ?? {};
  for (const [key, entry] of Object.entries(settings)) {
    // An explicit allowlist keeps credential-shaped values out of arbitrary JSON.
    if (providerName === 'cloudflare' && key === 'accountId') {
      if (typeof entry !== 'string' || entry.length > 256) {
        throw new ProviderAccountError('Configurações não permitidas para este provedor.');
      }
      continue;
    }
    if (key === 'accountTier') {
      if (typeof entry !== 'string' || !validAccountTiers.has(entry.toLowerCase())) {
        throw new ProviderAccountError('Tier de conta inválido.');
      }
      continue;
    }
    if (key === 'defaultModel') {
      if (typeof entry !== 'string' || entry.length > 128) {
        throw new ProviderAccountError('Configurações não permitidas para este provedor.');
      }
      continue;
    }
    throw new ProviderAccountError('Configurações não permitidas para este provedor.');
  }
  return settings;
}
function validateConnection(
  providerName: string,
  authMode: ProviderAccount['authMode'],
  baseUrl: string | null,
  credential: string | null,
) {
  if (authMode === 'oauth' && !oauthProviders.has(providerName)) {
    throw new ProviderAccountError('OAuth não está disponível para este provedor.');
  }
  if (authMode === 'local' && !localProviders.has(providerName)) {
    throw new ProviderAccountError('A conexão local exige um provedor com servidor próprio.');
  }
  if ((authMode === 'local' || localProviders.has(providerName)) && !baseUrl) {
    throw new ProviderAccountError('Informe o endereço do servidor.');
  }
  if (authMode === 'apiKey' && !credential) {
    throw new ProviderAccountError('Informe uma chave de API para esta conexão.');
  }
}
type AccountWithProvider = ProviderAccount & { provider: ProviderConfig };
function view(account: AccountWithProvider): ProviderAccountView {
  const settings = objectSettings(account.settings);
  return {
    id: account.id,
    providerName: account.provider.name,
    displayName: account.displayName,
    authMode: account.authMode,
    baseUrl: sanitizeProviderEndpoint(account.baseUrl),
    enabled: account.enabled,
    hasCredential: Boolean(
      account.authMode === 'oauth'
        ? account.oauthAccessTokenEncrypted
        : account.authMode === 'apiKey'
          ? account.credentialEncrypted
          : false,
    ),
    oauthNeedsReauth:
      account.authMode === 'oauth' &&
      (account.oauthNeedsReauth || !account.oauthAccessTokenEncrypted),
    health: {
      ok: account.healthOk,
      checkedAt: account.healthCheckedAt?.toISOString() ?? null,
      latencyMs: account.healthLatencyMs,
    },
    ...(account.provider.name === 'cloudflare' && typeof settings.accountId === 'string'
      ? { accountId: settings.accountId }
      : {}),
    accountTier: typeof settings.accountTier === 'string' ? settings.accountTier : undefined,
    defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined,
  };
}
const unknownHealth = { healthOk: null, healthCheckedAt: null, healthLatencyMs: null };

/** Mirror only the imported connection while the pre-account runtime still reads the legacy row. */
async function mirrorLegacyAccount(
  transaction: Prisma.TransactionClient,
  account: AccountWithProvider,
): Promise<void> {
  if (!account.legacyProviderConfigId) return;
  const settings = { ...objectSettings(account.provider.settings) };
  delete settings.apiKeyEncrypted;
  delete settings.oauth;
  const safeSettings = objectSettings(account.settings);
  settings.authMode = account.authMode;
  settings.baseUrl = account.baseUrl;
  if (account.provider.name === 'cloudflare') settings.accountId = safeSettings.accountId ?? null;
  if (account.credentialEncrypted) settings.apiKeyEncrypted = account.credentialEncrypted;
  if (account.oauthAccessTokenEncrypted) {
    settings.oauth = {
      provider: account.oauthProvider,
      accessTokenEncrypted: account.oauthAccessTokenEncrypted,
      refreshTokenEncrypted: account.oauthRefreshTokenEncrypted,
      expiresAt: account.oauthExpiresAt?.getTime() ?? null,
      scope: account.oauthScope,
      reauthRequired: account.oauthNeedsReauth,
    };
  }
  await transaction.providerConfig.update({
    where: { id: account.legacyProviderConfigId },
    data: {
      baseUrl: account.baseUrl,
      enabled: account.enabled,
      settings: settings as Prisma.InputJsonObject,
    },
  });
}

export async function createProviderAccount(
  input: ProviderAccountInput,
): Promise<ProviderAccountView> {
  const parsed = providerAccountInputSchema.parse(input);
  const credentialEncrypted = parsed.apiKey?.trim()
    ? encryptCredential(parsed.apiKey.trim(), env.JWT_SECRET)
    : null;
  const baseUrl = parsed.baseUrl || null;
  validateConnection(parsed.providerName, parsed.authMode, baseUrl, credentialEncrypted);
  const settings = accountSettings(parsed.providerName, parsed.settings);
  return prisma.$transaction(async (transaction) => {
    const provider = await transaction.providerConfig.upsert({
      where: { name: parsed.providerName },
      create: { name: parsed.providerName, enabled: true },
      update: {},
    });
    const account = await transaction.providerAccount.create({
      data: {
        providerId: provider.id,
        displayName: parsed.displayName,
        authMode: parsed.authMode,
        baseUrl,
        settings,
        credentialEncrypted,
        enabled: parsed.enabled ?? true,
        oauthNeedsReauth: parsed.authMode === 'oauth',
      },
      include: { provider: true },
    });
    return view(account);
  });
}

export async function updateProviderAccount(
  id: string,
  input: ProviderAccountUpdate,
): Promise<ProviderAccountView> {
  const parsed = providerAccountUpdateSchema.parse(input);
  return prisma.$transaction(async (transaction) => {
    const current = await transaction.providerAccount.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (
      !current ||
      current.disconnectedAt ||
      (parsed.providerName && parsed.providerName !== current.provider.name)
    )
      notFound();
    const authMode = parsed.authMode ?? current.authMode;
    const baseUrl = parsed.baseUrl === undefined ? current.baseUrl : parsed.baseUrl || null;
    const credentialEncrypted = parsed.apiKey?.trim()
      ? encryptCredential(parsed.apiKey.trim(), env.JWT_SECRET)
      : current.credentialEncrypted;
    validateConnection(current.provider.name, authMode, baseUrl, credentialEncrypted);
    const settings =
      parsed.settings === undefined
        ? undefined
        : accountSettings(current.provider.name, parsed.settings);
    const connectionChanged =
      authMode !== current.authMode ||
      baseUrl !== current.baseUrl ||
      credentialEncrypted !== current.credentialEncrypted ||
      settings !== undefined ||
      (parsed.enabled !== undefined && parsed.enabled !== current.enabled);
    const updated = await transaction.providerAccount.updateMany({
      where: { id, disconnectedAt: null },
      data: {
        displayName: parsed.displayName,
        authMode,
        baseUrl,
        credentialEncrypted,
        settings,
        enabled: parsed.enabled,
        ...(connectionChanged ? unknownHealth : {}),
      },
    });
    if (!updated.count) notFound();
    const account = await transaction.providerAccount.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!account || account.disconnectedAt) notFound();
    await mirrorLegacyAccount(transaction, account);
    return view(account);
  });
}

export async function listProviderAccounts(providerName?: string): Promise<ProviderAccountView[]> {
  const name = providerName === undefined ? undefined : providerNameSchema.parse(providerName);
  const accounts = await prisma.providerAccount.findMany({
    where: { disconnectedAt: null, ...(name ? { provider: { name } } : {}) },
    include: { provider: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return accounts.map(view);
}

export async function getProviderAccount(id: string): Promise<ProviderAccountView> {
  const account = await prisma.providerAccount.findUnique({
    where: { id },
    include: { provider: true },
  });
  if (!account || account.disconnectedAt) notFound();
  return view(account);
}

export async function getProviderAccountStatus(id: string) {
  const account = await prisma.providerAccount.findUnique({
    where: { id },
    include: { provider: true },
  });
  if (!account) notFound();

  let state:
    | 'disconnected'
    | 'pending_authorization'
    | 'connected'
    | 'refreshing'
    | 'expired'
    | 'revoked'
    | 'error'
    | 'quota_exhausted' = 'connected';
  if (account.disconnectedAt) {
    state = 'disconnected';
  } else if (account.authMode === 'oauth' && account.oauthNeedsReauth) {
    state = account.oauthAccessTokenEncrypted ? 'expired' : 'pending_authorization';
  } else if (account.healthOk === false) {
    state = 'error';
  } else if (!account.enabled) {
    state = 'disconnected';
  } else {
    state = 'connected';
  }

  return {
    id: account.id,
    providerName: account.provider.name,
    displayName: account.displayName,
    authMode: account.authMode,
    enabled: account.enabled,
    status: state,
    health: {
      ok: account.healthOk,
      checkedAt: account.healthCheckedAt?.toISOString() ?? null,
      latencyMs: account.healthLatencyMs,
    },
    oauthNeedsReauth:
      account.authMode === 'oauth' &&
      (account.oauthNeedsReauth || !account.oauthAccessTokenEncrypted),
  };
}

export async function getProviderAccountCapabilities(id: string) {
  const account = await prisma.providerAccount.findUnique({
    where: { id },
    include: { provider: true },
  });
  if (!account || account.disconnectedAt) notFound();

  const models = await prisma.modelConfig.findMany({
    where: { providerId: account.providerId, enabled: true },
    select: { modelId: true, displayName: true, capability: true },
  });

  return {
    id: account.id,
    providerName: account.provider.name,
    displayName: account.displayName,
    authMode: account.authMode,
    enabled: account.enabled,
    models,
  };
}

export async function disconnectProviderAccount(id: string): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.providerAccount.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!current) notFound();
    if (current.disconnectedAt) return;
    await transaction.providerAccount.updateMany({
      where: { id, disconnectedAt: null },
      data: {
        enabled: false,
        disconnectedAt: new Date(),
        credentialEncrypted: null,
        oauthProvider: null,
        oauthAccessTokenEncrypted: null,
        oauthRefreshTokenEncrypted: null,
        oauthExpiresAt: null,
        oauthScope: null,
        oauthNeedsReauth: false,
        ...unknownHealth,
      },
    });
    const account = await transaction.providerAccount.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (account) await mirrorLegacyAccount(transaction, account);
  });
}

/** Old configuration writes keep the uniquely imported account current without renaming it. */
export async function syncLegacyProviderAccount(
  transaction: Prisma.TransactionClient,
  provider: ProviderConfig,
): Promise<void> {
  const existing = await transaction.providerAccount.findUnique({
    where: { legacyProviderConfigId: provider.id },
  });
  const settings = objectSettings(provider.settings);
  const oauth = objectSettings(settings.oauth);
  const credentialEncrypted =
    text(settings.apiKeyEncrypted) ?? existing?.credentialEncrypted ?? null;
  const oauthAccessTokenEncrypted =
    text(oauth.accessTokenEncrypted) ?? existing?.oauthAccessTokenEncrypted ?? null;
  const baseUrl = text(settings.baseUrl) ?? provider.baseUrl;
  const mode = settings.authMode;
  const authMode =
    localProviders.has(provider.name) &&
    !credentialEncrypted &&
    (mode === undefined || mode === 'apiKey')
      ? 'local'
      : (mode ?? (oauthAccessTokenEncrypted ? 'oauth' : 'apiKey'));
  if (!['apiKey', 'oauth', 'local'].includes(String(authMode))) return;
  const hasUsableConnection =
    (authMode === 'apiKey' && Boolean(credentialEncrypted)) ||
    (authMode === 'oauth' && Boolean(oauthAccessTokenEncrypted)) ||
    (authMode === 'local' &&
      localProviders.has(provider.name) &&
      Boolean(baseUrl) &&
      providerEndpointSchema.safeParse(baseUrl).success);
  if ((!existing || existing.disconnectedAt) && !hasUsableConnection) return;
  const configuredExpiry = typeof oauth.expiresAt === 'number' ? new Date(oauth.expiresAt) : null;
  const expiresAt =
    configuredExpiry && Number.isFinite(configuredExpiry.getTime())
      ? configuredExpiry
      : (existing?.oauthExpiresAt ?? null);
  const existingSettings = objectSettings(existing?.settings);
  const oauthNeedsReauth =
    authMode === 'oauth' && !oauthAccessTokenEncrypted
      ? true
      : typeof oauth.reauthRequired === 'boolean'
        ? oauth.reauthRequired
        : (existing?.oauthNeedsReauth ?? false);
  const data = {
    authMode: authMode as ProviderAccount['authMode'],
    baseUrl,
    settings: {
      ...(typeof existingSettings.defaultModel === 'string'
        ? { defaultModel: existingSettings.defaultModel }
        : {}),
      ...(typeof existingSettings.accountTier === 'string'
        ? { accountTier: existingSettings.accountTier }
        : {}),
      ...(provider.name === 'cloudflare' && typeof settings.accountId === 'string'
        ? { accountId: settings.accountId }
        : provider.name === 'cloudflare' && typeof existingSettings.accountId === 'string'
          ? { accountId: existingSettings.accountId }
          : {}),
    },
    credentialEncrypted,
    oauthProvider: text(oauth.provider) ?? existing?.oauthProvider ?? null,
    oauthAccessTokenEncrypted,
    oauthRefreshTokenEncrypted:
      text(oauth.refreshTokenEncrypted) ?? existing?.oauthRefreshTokenEncrypted ?? null,
    oauthExpiresAt: expiresAt,
    oauthScope: text(oauth.scope) ?? existing?.oauthScope ?? null,
    oauthNeedsReauth,
    enabled: provider.enabled,
    disconnectedAt: null,
    ...unknownHealth,
  };
  await transaction.providerAccount.upsert({
    where: { legacyProviderConfigId: provider.id },
    create: {
      ...data,
      providerId: provider.id,
      legacyProviderConfigId: provider.id,
      displayName: provider.name,
    },
    update: data,
  });
}
