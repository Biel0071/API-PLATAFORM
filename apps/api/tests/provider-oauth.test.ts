import Fastify from 'fastify';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  accounts: new Map<string, any>(),
  redis: new Map<string, string>(),
}));

vi.mock('../src/lib/prisma', () => {
  const database: any = {
    providerConfig: {
      findUnique: vi.fn(async ({ where }) => state.rows.get(where.name) || null),
      findMany: vi.fn(async () => [...state.rows.values()]),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = state.rows.has(where.name)
          ? { ...state.rows.get(where.name), ...update }
          : { id: `provider-${where.name}`, ...create };
        state.rows.set(where.name, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = { ...state.rows.get(where.name), ...data };
        state.rows.set(where.name, row);
        return row;
      }),
    },
    providerAccount: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        const account = where.id
          ? state.accounts.get(where.id)
          : [...state.accounts.values()].find(
              (row) => row.legacyProviderConfigId === where.legacyProviderConfigId,
            );
        if (!account) return null;
        const provider = [...state.rows.values()].find((row) => row.id === account.providerId);
        return include?.provider ? { ...account, provider } : account;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const account = state.accounts.get(where.id);
        const matches = (condition: any) =>
          Object.entries(condition ?? {}).every(([key, value]) => {
            if (key === 'OR') return (value as any[]).some(matches);
            return account?.[key] === value;
          });
        if (!account || !matches(where)) return { count: 0 };
        state.accounts.set(where.id, { ...account, ...data });
        return { count: 1 };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const account = [...state.accounts.values()].find(
          (row) => row.legacyProviderConfigId === where.legacyProviderConfigId,
        );
        const result = account
          ? { ...account, ...update }
          : { id: `account-${where.legacyProviderConfigId}`, ...create };
        state.accounts.set(result.id, result);
        return result;
      }),
    },
    $transaction: vi.fn(async (operation) =>
      typeof operation === 'function' ? operation(database) : Promise.all(operation),
    ),
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return { prisma: database };
});

vi.mock('../src/lib/redis', () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => {
      state.redis.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => state.redis.get(key) ?? null),
    del: vi.fn(async (key: string) => Number(state.redis.delete(key))),
    eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
      const value = state.redis.get(key) ?? null;
      state.redis.delete(key);
      return value;
    }),
  },
}));

vi.mock('../src/services/ai.service', () => ({
  execute: vi.fn(),
  registry: { list: () => [] },
  reloadRegistry: vi.fn(async () => ({ has: () => true })),
  reloadRegistryAfterMutation: vi.fn(async () => ({ has: () => true })),
}));

import { providersRoutes } from '../src/routes/admin/providers';
import { registerGoogleOAuthCallback } from '../src/routes/provider-oauth-callback';
import { reloadRegistryAfterMutation } from '../src/services/ai.service';
import { serializeRequestForLog } from '../src/lib/logger';
import {
  buildProviderEnvironment,
  encryptCredential,
  resolveOAuthCredential,
} from '@api-platform/shared';
import { GeminiProvider } from '@api-platform/shared';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function createAdminApp() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'VALIDATION_ERROR' });
    const statusCode = Number((error as Error & { statusCode?: number }).statusCode ?? 500);
    return reply.code(statusCode).send({ error: 'REQUEST_ERROR' });
  });
  app.addHook('preHandler', async (request) => {
    request.user = { sub: 'oauth-admin', role: 'admin' } as typeof request.user;
  });
  await providersRoutes(app);
  return app;
}

beforeEach(() => {
  state.rows.clear();
  state.accounts.clear();
  state.redis.clear();
  vi.stubEnv('HUGGINGFACE_OAUTH_CLIENT_ID', 'hf-client');
  vi.stubEnv('HUGGINGFACE_OAUTH_CLIENT_SECRET', '');
  vi.stubEnv('GEMINI_OAUTH_CLIENT_ID', 'google-client.apps.googleusercontent.com');
  vi.stubEnv('GEMINI_OAUTH_CLIENT_SECRET', 'google-client-secret');
  vi.stubEnv('GEMINI_OAUTH_PROJECT_ID', 'gemini-project');
  vi.stubEnv('OAUTH_PUBLIC_BASE_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('provider OAuth connection flows', () => {
  function addAccount(id: string, provider: 'gemini' | 'huggingface') {
    const config = { id: `provider-${provider}`, name: provider, enabled: true, settings: {} };
    state.rows.set(provider, config);
    state.accounts.set(id, {
      id,
      providerId: config.id,
      provider: config,
      displayName: id,
      authMode: 'oauth',
      settings: {},
      enabled: true,
      disconnectedAt: null,
      credentialEncrypted: null,
      oauthAccessTokenEncrypted: null,
      oauthRefreshTokenEncrypted: null,
      oauthExpiresAt: null,
      oauthScope: null,
      oauthNeedsReauth: true,
    });
  }

  it('scopes Hugging Face device flows and token writes to the selected account', async () => {
    addAccount('hf-account-a', 'huggingface');
    addAccount('hf-account-b', 'huggingface');
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ device_code: 'device-a', user_code: 'CODE-A', expires_in: 600 }),
      )
      .mockResolvedValueOnce(response({ access_token: 'token-a', scope: 'inference-api' }));
    const app = await createAdminApp();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/provider-accounts/hf-account-a/oauth/huggingface/start',
      });
      expect(started.statusCode).toBe(200);
      const polled = await app.inject({
        method: 'POST',
        url: '/provider-accounts/hf-account-a/oauth/huggingface/poll',
        payload: { flowId: started.json().flowId },
      });
      expect(polled.json()).toMatchObject({ status: 'connected' });
      expect(state.accounts.get('hf-account-a').oauthAccessTokenEncrypted).toBeTruthy();
      expect(state.accounts.get('hf-account-b').oauthAccessTokenEncrypted).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('binds Gemini callback state and token storage to the initiating account', async () => {
    addAccount('gemini-account-a', 'gemini');
    addAccount('gemini-account-b', 'gemini');
    state.accounts.get('gemini-account-a').oauthProvider = 'google';
    state.accounts.get('gemini-account-a').oauthRefreshTokenEncrypted = 'preserved-refresh-token';
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ access_token: 'google-account-a', expires_in: 3600 }),
    );
    const app = await createAdminApp();
    await registerGoogleOAuthCallback(app);
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/provider-accounts/gemini-account-a/oauth/gemini/start',
      });
      expect(started.statusCode).toBe(200);
      const stateToken = new URL(started.json().authorizationUrl).searchParams.get('state');
      const callback = await app.inject({
        method: 'GET',
        url: `/oauth/google/gemini/callback?code=grant-a&state=${stateToken}`,
        headers: { cookie: `gemini_oauth_state=${stateToken}` },
      });
      expect(callback.statusCode).toBe(302);
      expect(state.accounts.get('gemini-account-a').oauthAccessTokenEncrypted).toBeTruthy();
      expect(state.accounts.get('gemini-account-a').oauthRefreshTokenEncrypted).toBe(
        'preserved-refresh-token',
      );
      expect(state.accounts.get('gemini-account-b').oauthAccessTokenEncrypted).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects a Hugging Face flow polled through another account', async () => {
    addAccount('hf-account-a', 'huggingface');
    addAccount('hf-account-b', 'huggingface');
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ device_code: 'device-a', user_code: 'CODE-A', expires_in: 600 }),
    );
    const app = await createAdminApp();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/provider-accounts/hf-account-a/oauth/huggingface/start',
      });
      const polled = await app.inject({
        method: 'POST',
        url: '/provider-accounts/hf-account-b/oauth/huggingface/poll',
        payload: { flowId: started.json().flowId },
      });
      expect(polled.statusCode).toBe(400);
      expect(polled.json()).toMatchObject({ error: 'REQUEST_ERROR' });
      expect(state.accounts.get('hf-account-a').oauthAccessTokenEncrypted).toBeNull();
      expect(state.accounts.get('hf-account-b').oauthAccessTokenEncrypted).toBeNull();
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('disconnects only the selected OAuth account', async () => {
    addAccount('hf-account-a', 'huggingface');
    addAccount('hf-account-b', 'huggingface');
    Object.assign(state.accounts.get('hf-account-a'), {
      oauthAccessTokenEncrypted: 'encrypted-a',
      oauthProvider: 'huggingface',
    });
    Object.assign(state.accounts.get('hf-account-b'), {
      oauthAccessTokenEncrypted: 'encrypted-b',
      oauthProvider: 'huggingface',
    });
    const app = await createAdminApp();
    try {
      const result = await app.inject({
        method: 'DELETE',
        url: '/provider-accounts/hf-account-a/oauth/huggingface',
      });
      expect(result.statusCode).toBe(200);
      expect(state.accounts.get('hf-account-a')).toMatchObject({
        enabled: false,
        oauthAccessTokenEncrypted: null,
        oauthNeedsReauth: true,
      });
      expect(state.accounts.get('hf-account-b').oauthAccessTokenEncrypted).toBe('encrypted-b');
    } finally {
      await app.close();
    }
  });

  it('reauthorizes an OAuth-only account after disconnect without reactivating it early', async () => {
    addAccount('hf-account-reauth', 'huggingface');
    Object.assign(state.accounts.get('hf-account-reauth'), {
      oauthAccessTokenEncrypted: 'encrypted-old-token',
      oauthProvider: 'huggingface',
      oauthNeedsReauth: false,
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ device_code: 'device-reauth', user_code: 'CODE-REAUTH', expires_in: 600 }),
      )
      .mockResolvedValueOnce(response({ access_token: 'token-reauth', scope: 'inference-api' }));
    const app = await createAdminApp();
    try {
      const disconnected = await app.inject({
        method: 'DELETE',
        url: '/provider-accounts/hf-account-reauth/oauth/huggingface',
      });
      expect(disconnected.statusCode).toBe(200);
      expect(state.accounts.get('hf-account-reauth').enabled).toBe(false);

      const started = await app.inject({
        method: 'POST',
        url: '/provider-accounts/hf-account-reauth/oauth/huggingface/start',
      });
      expect(started.statusCode).toBe(200);
      expect(state.accounts.get('hf-account-reauth').enabled).toBe(false);

      const completed = await app.inject({
        method: 'POST',
        url: '/provider-accounts/hf-account-reauth/oauth/huggingface/poll',
        payload: { flowId: started.json().flowId },
      });
      expect(completed.json()).toMatchObject({ status: 'connected' });
      expect(state.accounts.get('hf-account-reauth')).toMatchObject({
        enabled: true,
        oauthNeedsReauth: false,
      });
      expect(state.accounts.get('hf-account-reauth').oauthAccessTokenEncrypted).not.toContain(
        'token-reauth',
      );
    } finally {
      await app.close();
    }
  });

  it('does not start OAuth for a manually disabled account without reauthorization needed', async () => {
    addAccount('hf-account-disabled', 'huggingface');
    Object.assign(state.accounts.get('hf-account-disabled'), {
      enabled: false,
      oauthNeedsReauth: false,
    });
    const app = await createAdminApp();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/provider-accounts/hf-account-disabled/oauth/huggingface/start',
      });
      expect(started.statusCode).toBe(404);
      expect(state.accounts.get('hf-account-disabled').enabled).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('removes OAuth query parameters from request logs', () => {
    const serialized = serializeRequestForLog({
      method: 'GET',
      url: '/oauth/google/gemini/callback?code=private-auth-code&state=private-state',
      headers: {},
      host: 'api.example.test',
      ip: '127.0.0.1',
    });
    expect(serialized.url).toBe('/oauth/google/gemini/callback');
    expect(JSON.stringify(serialized)).not.toContain('private-auth-code');
    expect(JSON.stringify(serialized)).not.toContain('private-state');
  });

  it('advertises OAuth availability without exposing configured client credentials', async () => {
    const app = await createAdminApp();
    try {
      const result = await app.inject({ method: 'GET', url: '/provider-oauth/options' });
      expect(result.statusCode).toBe(200);
      expect(result.json().options).toMatchObject({
        huggingface: { oauth: { enabled: true } },
        gemini: { oauth: { enabled: true } },
      });
      expect(result.body).not.toContain('google-client-secret');
      expect(result.body).not.toContain('google-client.apps.googleusercontent.com');
    } finally {
      await app.close();
    }
  });

  it('disables Gemini OAuth unless a public HTTPS callback and server client are configured', async () => {
    vi.stubEnv('OAUTH_PUBLIC_BASE_URL', 'http://api.example.test');
    const app = await createAdminApp();
    try {
      const result = await app.inject({ method: 'GET', url: '/provider-oauth/options' });
      expect(result.statusCode).toBe(200);
      expect(result.json().options.gemini.oauth).toMatchObject({ enabled: false });
      expect(result.json().options.huggingface.oauth).toMatchObject({ enabled: true });
      expect(result.body).not.toContain('google-client-secret');
    } finally {
      await app.close();
    }
  });

  it('completes HF device authorization, stores only encrypted credentials, and consumes the flow once', async () => {
    vi.mocked(reloadRegistryAfterMutation).mockClear();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        response({
          device_code: 'server-side-device-secret',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://huggingface.co/oauth/authorize/device',
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(response({ error: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(
        response({
          access_token: 'hf_oauth_private_token',
          expires_in: 3600,
          scope: 'inference-api',
        }),
      );
    const app = await createAdminApp();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/start',
      });
      expect(started.statusCode).toBe(200);
      const { flowId, userCode, verificationUri } = started.json();
      expect(userCode).toBe('ABCD-EFGH');
      expect(verificationUri).toBe('https://huggingface.co/oauth/authorize/device');
      expect(started.body).not.toContain('server-side-device-secret');
      expect(fetchMock.mock.calls[0][1]?.body?.toString()).toContain('scope=inference-api');

      const pending = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/poll',
        payload: { flowId },
      });
      expect(pending.json()).toMatchObject({ status: 'pending' });

      const completed = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/poll',
        payload: { flowId },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ status: 'connected' });
      expect(completed.body).not.toContain('hf_oauth_private_token');
      const stored = state.rows.get('huggingface');
      expect(stored.settings.authMode).toBe('oauth');
      expect(stored.settings.oauth.accessTokenEncrypted).not.toContain('hf_oauth_private_token');
      expect(stored.settings.oauth.scope).toBe('inference-api');
      expect(reloadRegistryAfterMutation).toHaveBeenCalledTimes(1);

      const replay = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/poll',
        payload: { flowId },
      });
      expect(replay.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('handles denied and expired Hugging Face device flows without exposing tokens', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        response({
          device_code: 'private-device-code',
          user_code: 'ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(response({ error: 'access_denied' }, 400))
      .mockResolvedValueOnce(
        response({
          device_code: 'private-device-code-2',
          user_code: 'IJKL-MNOP',
          expires_in: 600,
          interval: 5,
        }),
      );
    const app = await createAdminApp();
    try {
      const deniedFlow = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/start',
      });
      const denied = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/poll',
        payload: { flowId: deniedFlow.json().flowId },
      });
      expect(denied.json()).toMatchObject({ status: 'denied' });

      let now = Date.now();
      const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const expiredFlow = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/start',
      });
      now += 60 * 60 * 1_000;
      const expired = await app.inject({
        method: 'POST',
        url: '/provider-oauth/huggingface/poll',
        payload: { flowId: expiredFlow.json().flowId },
      });
      dateNow.mockRestore();
      expect(expired.statusCode).toBe(410);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('requires the browser-bound one-time state for the Gemini callback', async () => {
    const app = Fastify();
    await registerGoogleOAuthCallback(app);
    try {
      const result = await app.inject({
        method: 'GET',
        url: '/oauth/google/gemini/callback?code=auth-code&state=wrong-state',
        headers: { cookie: 'gemini_oauth_state=another-state' },
      });
      expect(result.statusCode).toBe(400);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('exchanges a valid Gemini code and saves encrypted refresh credentials', async () => {
    vi.mocked(reloadRegistryAfterMutation).mockClear();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      response({
        access_token: 'google_access_private',
        refresh_token: 'google_refresh_private',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/generative-language.retriever',
      }),
    );
    const app = await createAdminApp();
    await registerGoogleOAuthCallback(app);
    try {
      const started = await app.inject({ method: 'POST', url: '/provider-oauth/gemini/start' });
      expect(started.statusCode).toBe(200);
      const { authorizationUrl } = started.json();
      const oauthState = new URL(authorizationUrl).searchParams.get('state');
      expect(oauthState).toBeTruthy();
      expect(authorizationUrl).toContain('accounts.google.com');
      expect(authorizationUrl).toContain('generative-language.retriever');
      const cookie = started.headers['set-cookie'];
      expect(cookie).toContain(`gemini_oauth_state=${oauthState}`);

      const callback = await app.inject({
        method: 'GET',
        url: `/oauth/google/gemini/callback?code=authorization-code&state=${oauthState}`,
        headers: { cookie: `gemini_oauth_state=${oauthState}` },
      });
      expect(callback.statusCode).toBe(302);
      expect(state.rows.get('gemini').settings.authMode).toBe('oauth');
      expect(state.rows.get('gemini').settings.oauth.accessTokenEncrypted).not.toContain(
        'google_access_private',
      );
      expect(state.rows.get('gemini').settings.oauth.refreshTokenEncrypted).not.toContain(
        'google_refresh_private',
      );
      expect(callback.headers.location).toContain('#/providers?oauth=connected');
      expect(reloadRegistryAfterMutation).toHaveBeenCalledTimes(1);

      const replay = await app.inject({
        method: 'GET',
        url: `/oauth/google/gemini/callback?code=authorization-code&state=${oauthState}`,
        headers: { cookie: `gemini_oauth_state=${oauthState}` },
      });
      expect(replay.statusCode).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns to the providers page when Google access is denied and consumes state once', async () => {
    const app = await createAdminApp();
    await registerGoogleOAuthCallback(app);
    try {
      const started = await app.inject({ method: 'POST', url: '/provider-oauth/gemini/start' });
      const oauthState = new URL(started.json().authorizationUrl).searchParams.get('state');
      const callback = await app.inject({
        method: 'GET',
        url: `/oauth/google/gemini/callback?error=access_denied&state=${oauthState}`,
        headers: { cookie: `gemini_oauth_state=${oauthState}` },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toContain('#/providers?oauth=denied');
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      const replay = await app.inject({
        method: 'GET',
        url: `/oauth/google/gemini/callback?error=access_denied&state=${oauthState}`,
        headers: { cookie: `gemini_oauth_state=${oauthState}` },
      });
      expect(replay.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('refreshes expiring Gemini tokens once and keeps a rotated refresh token encrypted', async () => {
    const original = {
      provider: 'google' as const,
      accessTokenEncrypted: encryptCredential('old-access', 'encryption-secret'),
      refreshTokenEncrypted: encryptCredential('old-refresh', 'encryption-secret'),
      expiresAt: Date.now() + 1_000,
      scope: 'https://www.googleapis.com/auth/generative-language.retriever',
    };
    let stored = original;
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValue(response({ access_token: 'new-access', expires_in: 3600 }));
    const resolved = await resolveOAuthCredential(
      {
        provider: 'gemini',
        secret: 'encryption-secret',
        clientId: 'client',
        clientSecret: 'secret',
        withLock: (_key, operation) => operation(),
        load: async () => stored,
        save: async (oauth) => {
          stored = oauth;
        },
      },
      original,
    );
    expect(resolved).toBe('new-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored.refreshTokenEncrypted).toBe(original.refreshTokenEncrypted);
    expect(stored.accessTokenEncrypted).not.toContain('new-access');
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    expect(stored.reauthRequired).toBe(false);
  });

  it('does not fall back to a saved API key when OAuth is selected and requires reauthorization after expiry', async () => {
    const expired = {
      provider: 'huggingface' as const,
      accessTokenEncrypted: encryptCredential('expired-oauth-token', 'encryption-secret'),
      expiresAt: Date.now() - 1,
      scope: 'inference-api',
    };
    let stored = expired;
    const env = await buildProviderEnvironment(
      [
        {
          name: 'huggingface',
          enabled: true,
          settings: {
            authMode: 'oauth',
            apiKeyEncrypted: encryptCredential('saved-api-key', 'encryption-secret'),
            oauth: expired,
          },
        },
      ],
      { HUGGINGFACE_API_KEY: 'environment-api-key' },
      'encryption-secret',
      (_name, oauth) =>
        resolveOAuthCredential(
          {
            provider: 'huggingface',
            secret: 'encryption-secret',
            load: async () => stored,
            save: async (updated) => {
              stored = updated;
            },
            withLock: (_key, operation) => operation(),
          },
          oauth,
        ),
    );
    expect(env.HUGGINGFACE_API_KEY).toBeUndefined();
    expect(stored.reauthRequired).toBe(true);
  });

  it('sends Gemini OAuth requests with Bearer and project headers instead of an API-key query', async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValue(response({ models: [{ name: 'models/gemini-2.5-flash' }] }));
    const provider = new GeminiProvider({
      accessToken: 'access-token',
      oauthProjectId: 'project-id',
    });
    await provider.models();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('?key=');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer access-token',
      'x-goog-user-project': 'project-id',
    });
  });

  it('accepts xAI configuration and rejects OAuth mode for providers without OAuth support', async () => {
    const app = await createAdminApp();
    try {
      const xai = await app.inject({
        method: 'POST',
        url: '/provider-configs',
        payload: { name: 'xai', enabled: true, apiKey: 'xai-secret', authMode: 'apiKey' },
      });
      expect(xai.statusCode).toBe(200);
      expect(state.rows.get('xai').settings.apiKeyEncrypted).not.toContain('xai-secret');

      const invalidOAuth = await app.inject({
        method: 'POST',
        url: '/provider-configs',
        payload: { name: 'openai', enabled: true, authMode: 'oauth' },
      });
      expect(invalidOAuth.statusCode).toBe(400);
      expect(state.rows.has('openai')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
