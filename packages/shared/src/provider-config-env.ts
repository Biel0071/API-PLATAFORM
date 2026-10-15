import { decryptCredential, StoredProviderOAuth } from './provider-oauth';

export interface ProviderConfigEnvironmentRow {
  name: string;
  enabled: boolean;
  baseUrl?: string | null;
  settings?: unknown;
}

export interface ProviderAccountEnvironmentRow {
  id: string;
  providerName?: string;
  enabled: boolean;
  authMode: 'apiKey' | 'oauth' | 'local';
  baseUrl?: string | null;
  settings?: unknown;
  credentialEncrypted?: string | null;
  oauthProvider?: string | null;
  oauthAccessTokenEncrypted?: string | null;
  oauthRefreshTokenEncrypted?: string | null;
  oauthExpiresAt?: Date | null;
  oauthScope?: string | null;
  oauthNeedsReauth?: boolean;
  provider: { name: string; enabled: boolean; baseUrl?: string | null; settings?: unknown };
}

/** Build one isolated environment per account; credentials never enter provider settings JSON. */
export async function buildProviderAccountEnvironments(
  accounts: ProviderAccountEnvironmentRow[],
  encryptionSecret: string,
  resolveOAuthToken: (
    accountId: string,
    name: 'gemini' | 'huggingface',
    oauth: StoredProviderOAuth,
  ) => Promise<string | undefined>,
): Promise<
  Array<{ accountId: string; providerName: string; env: Record<string, string | undefined> }>
> {
  const result = [];
  for (const account of accounts) {
    const providerSettings =
      account.provider.settings &&
      typeof account.provider.settings === 'object' &&
      !Array.isArray(account.provider.settings)
        ? { ...(account.provider.settings as Record<string, unknown>) }
        : {};
    delete providerSettings.apiKeyEncrypted;
    delete providerSettings.oauth;
    const accountSettings =
      account.settings && typeof account.settings === 'object' && !Array.isArray(account.settings)
        ? (account.settings as Record<string, unknown>)
        : {};
    const baseUrl =
      account.baseUrl ??
      account.provider.baseUrl ??
      (typeof accountSettings.baseUrl === 'string' ? accountSettings.baseUrl : null) ??
      (typeof providerSettings.baseUrl === 'string' ? providerSettings.baseUrl : null);
    const settings = {
      ...providerSettings,
      ...accountSettings,
      ...(baseUrl ? { baseUrl } : {}),
      authMode: account.authMode,
      ...(account.credentialEncrypted ? { apiKeyEncrypted: account.credentialEncrypted } : {}),
      ...(account.authMode === 'oauth' && account.oauthAccessTokenEncrypted
        ? {
            oauth: {
              provider: account.oauthProvider,
              accessTokenEncrypted: account.oauthAccessTokenEncrypted,
              refreshTokenEncrypted: account.oauthRefreshTokenEncrypted ?? undefined,
              expiresAt: account.oauthExpiresAt?.getTime(),
              scope: account.oauthScope ?? undefined,
              reauthRequired: account.oauthNeedsReauth,
            },
          }
        : {}),
    };
    const name = account.providerName ?? account.provider.name;
    const env = await buildProviderEnvironment(
      // Build an instance even for disabled accounts so it still suppresses
      // the legacy provider duplicate; the binding's enabled flag controls use.
      [{ name, enabled: true, baseUrl, settings }],
      {},
      encryptionSecret,
      (oauthName, oauth) => resolveOAuthToken(account.id, oauthName, oauth),
    );
    result.push({ accountId: account.id, providerName: name, env });
  }
  return result;
}

export async function buildProviderEnvironment(
  rows: ProviderConfigEnvironmentRow[],
  baseEnv: Record<string, string | undefined>,
  encryptionSecret: string,
  resolveOAuthToken: (
    name: 'gemini' | 'huggingface',
    oauth: StoredProviderOAuth,
  ) => Promise<string | undefined>,
): Promise<Record<string, string | undefined>> {
  const result = { ...baseEnv };
  for (const row of rows) {
    const settings = (row.settings ?? {}) as Record<string, any>;
    const name = row.name;
    const targets =
      name === 'cloudflare'
        ? {
            apiKey: 'CLOUDFLARE_API_TOKEN',
            baseUrl: 'CLOUDFLARE_BASE_URL',
            defaultModel: 'CLOUDFLARE_DEFAULT_MODEL',
            embedModel: 'CLOUDFLARE_EMBED_MODEL',
          }
        : name === 'anthropic'
          ? {
              apiKey: 'ANTHROPIC_API_KEY',
              baseUrl: 'ANTHROPIC_BASE_URL',
              defaultModel: 'CLAUDE_DEFAULT_MODEL',
              embedModel: null,
            }
          : name === 'xai'
            ? {
                apiKey: 'GROK_API_KEY',
                baseUrl: 'GROK_BASE_URL',
                defaultModel: 'GROK_DEFAULT_MODEL',
                embedModel: null,
              }
            : {
                apiKey: `${name.toUpperCase()}_API_KEY`,
                baseUrl: `${name.toUpperCase()}_BASE_URL`,
                defaultModel: `${name.toUpperCase()}_DEFAULT_MODEL`,
                embedModel: `${name.toUpperCase()}_EMBED_MODEL`,
              };
    const oauthMode =
      settings.authMode === 'oauth' || (!settings.authMode && Boolean(settings.oauth));

    if (!row.enabled) {
      for (const target of Object.values(targets)) if (target) delete result[target];
      if (name === 'cloudflare') delete result.CLOUDFLARE_ACCOUNT_ID;
      if (name === 'gemini') {
        delete result.GEMINI_ACCESS_TOKEN;
        delete result.GEMINI_OAUTH_PROJECT_ID;
      }
      continue;
    }

    let secret: string | undefined;
    if (oauthMode && (name === 'gemini' || name === 'huggingface')) {
      secret = settings.oauth
        ? await resolveOAuthToken(name, settings.oauth as StoredProviderOAuth)
        : undefined;
      if (name === 'gemini') {
        delete result.GEMINI_API_KEY;
        delete result.GEMINI_ACCESS_TOKEN;
        if (secret) result.GEMINI_ACCESS_TOKEN = secret;
        if (baseEnv.GEMINI_OAUTH_PROJECT_ID)
          result.GEMINI_OAUTH_PROJECT_ID = baseEnv.GEMINI_OAUTH_PROJECT_ID;
      } else {
        delete result.HUGGINGFACE_API_KEY;
        if (secret) result.HUGGINGFACE_API_KEY = secret;
      }
    } else {
      secret = decryptCredential(settings.apiKeyEncrypted, encryptionSecret);
      if (name === 'gemini') delete result.GEMINI_ACCESS_TOKEN;
    }

    if (name === 'cloudflare') {
      if (settings.accountId) result.CLOUDFLARE_ACCOUNT_ID = settings.accountId;
      if (secret) result.CLOUDFLARE_API_TOKEN = secret;
      if (settings.baseUrl) result.CLOUDFLARE_BASE_URL = settings.baseUrl;
      if (settings.defaultModel) result.CLOUDFLARE_DEFAULT_MODEL = settings.defaultModel;
      if (settings.embedModel) result.CLOUDFLARE_EMBED_MODEL = settings.embedModel;
    } else if (['ollama', 'lmstudio', 'comfyui', 'forge', 'invokeai'].includes(name)) {
      if (settings.baseUrl) result[targets.baseUrl] = settings.baseUrl;
      if (settings.defaultModel) result[targets.defaultModel] = settings.defaultModel;
    } else {
      if (secret && !(name === 'gemini' && oauthMode)) result[targets.apiKey] = secret;
      if (settings.baseUrl) result[targets.baseUrl] = settings.baseUrl;
      if (settings.defaultModel) result[targets.defaultModel] = settings.defaultModel;
      if (settings.embedModel && targets.embedModel)
        result[targets.embedModel] = settings.embedModel;
    }
  }

  const configuredDefaults = rows.filter(
    (row) => (row.settings as Record<string, any> | null)?.defaultChat,
  );
  const selectedDefault = configuredDefaults.find((row) => row.enabled);
  if (selectedDefault) result.DEFAULT_CHAT_PROVIDER = selectedDefault.name;
  else if (configuredDefaults.length) delete result.DEFAULT_CHAT_PROVIDER;
  return result;
}
