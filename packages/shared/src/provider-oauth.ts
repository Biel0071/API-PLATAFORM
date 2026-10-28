import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export type OAuthProviderName = 'gemini' | 'huggingface' | 'openai' | 'anthropic';
export interface StoredProviderOAuth {
  provider: 'google' | 'huggingface' | 'openai' | 'anthropic';
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  expiresAt?: number;
  scope?: string;
  reauthRequired?: boolean;
}

export interface RedisLockClient {
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<string | null>;
  eval(script: string, keyCount: number, key: string, value: string): Promise<unknown>;
}

export function encryptCredential(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptCredential(value: string | undefined, secret: string): string | undefined {
  if (!value) return undefined;
  const [iv, tag, data] = value.split('.');
  if (!iv || !tag || !data) throw new Error('Invalid encrypted provider credential');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(secret).digest(),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

export async function withRedisLock<T>(
  redis: RedisLockClient,
  key: string,
  operation: () => Promise<T>,
  options: { waitMs?: number; ttlMs?: number } = {},
): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  const ttlMs = options.ttlMs ?? 30_000;
  let acquired = false;
  while (!acquired && Date.now() <= deadline) {
    acquired = (await redis.set(key, owner, 'PX', ttlMs, 'NX')) === 'OK';
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!acquired) throw new Error('Provider credential refresh lock timed out');
  try {
    return await operation();
  } finally {
    await redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        owner,
      )
      .catch(() => undefined);
  }
}

export interface ResolveOAuthCredentialOptions {
  provider: OAuthProviderName;
  secret: string;
  clientId?: string;
  clientSecret?: string;
  now?: () => number;
  fetcher?: typeof fetch;
  withLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  load: () => Promise<StoredProviderOAuth | undefined>;
  save: (oauth: StoredProviderOAuth) => Promise<void>;
}

/** Resolve the current OAuth token and refresh Google credentials when needed. */
export async function resolveOAuthCredential(
  options: ResolveOAuthCredentialOptions,
  initial?: StoredProviderOAuth,
): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const providerKind: StoredProviderOAuth['provider'] =
    options.provider === 'gemini'
      ? 'google'
      : options.provider === 'openai'
        ? 'openai'
        : options.provider === 'anthropic'
          ? 'anthropic'
          : 'huggingface';
  if (!initial || initial.provider !== providerKind || initial.reauthRequired) return undefined;

  const expiresSoon = (oauth: StoredProviderOAuth) =>
    typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now() + 90_000;
  const decryptAccess = (oauth: StoredProviderOAuth) => {
    try {
      return decryptCredential(oauth.accessTokenEncrypted, options.secret);
    } catch {
      return undefined;
    }
  };

  const accessToken = decryptAccess(initial);
  if (!accessToken) {
    await options.save({ ...initial, reauthRequired: true });
    return undefined;
  }
  if (!expiresSoon(initial)) return accessToken;
  if (options.provider === 'huggingface') {
    await options.save({ ...initial, reauthRequired: true });
    return undefined;
  }
  if (options.provider === 'gemini' && (!initial.refreshTokenEncrypted || !options.clientId || !options.clientSecret)) {
    await options.save({ ...initial, reauthRequired: true });
    return undefined;
  }
  if ((options.provider === 'openai' || options.provider === 'anthropic') && !initial.refreshTokenEncrypted) {
    await options.save({ ...initial, reauthRequired: true });
    return undefined;
  }

  return options.withLock(`provider:oauth-refresh:${options.provider}`, async () => {
    const current = (await options.load()) ?? initial;
    if (current.provider !== providerKind || current.reauthRequired) return undefined;
    const currentAccess = decryptAccess(current);
    if (!currentAccess) {
      await options.save({ ...current, reauthRequired: true });
      return undefined;
    }
    if (!expiresSoon(current)) return currentAccess;
    if (!current.refreshTokenEncrypted) {
      await options.save({ ...current, reauthRequired: true });
      return undefined;
    }

    const refreshToken = decryptCredential(current.refreshTokenEncrypted, options.secret);
    if (!refreshToken) {
      await options.save({ ...current, reauthRequired: true });
      return undefined;
    }
    let refreshUrl = 'https://oauth2.googleapis.com/token';
    let body: URLSearchParams;
    if (options.provider === 'openai') {
      refreshUrl = 'https://auth.openai.com/oauth/token';
      body = new URLSearchParams({
        client_id: options.clientId ?? 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    } else if (options.provider === 'anthropic') {
      refreshUrl = 'https://console.anthropic.com/v1/oauth/token';
      body = new URLSearchParams({
        client_id: options.clientId ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    } else {
      body = new URLSearchParams({
        client_id: options.clientId!,
        client_secret: options.clientSecret!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
    }
    const response = await fetcher(refreshUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    if (!response)
      return current.expiresAt && current.expiresAt > now() ? currentAccess : undefined;
    const token = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
    };
    if (!response.ok || !token.access_token) {
      if (token.error === 'invalid_grant') {
        await options.save({ ...current, reauthRequired: true });
        return undefined;
      }
      if (current.expiresAt && current.expiresAt > now()) return currentAccess;
      return undefined;
    }
    const refreshed: StoredProviderOAuth = {
      provider: providerKind,
      accessTokenEncrypted: encryptCredential(token.access_token, options.secret),
      refreshTokenEncrypted: token.refresh_token
        ? encryptCredential(token.refresh_token, options.secret)
        : current.refreshTokenEncrypted,
      expiresAt:
        typeof token.expires_in === 'number' ? now() + token.expires_in * 1_000 : undefined,
      scope: token.scope ?? current.scope,
      reauthRequired: false,
    };
    await options.save(refreshed);
    return token.access_token;
  });
}
