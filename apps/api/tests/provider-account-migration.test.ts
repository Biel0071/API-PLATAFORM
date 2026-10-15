import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  providers: [] as any[],
  accounts: [] as any[],
}));
vi.mock('../src/lib/prisma', () => {
  const transaction = {
    providerConfig: { findMany: async () => structuredClone(state.providers) },
    providerAccount: {
      createMany: async ({ data, skipDuplicates }: { data: any[]; skipDuplicates: boolean }) => {
        let count = 0;
        for (const account of data) {
          if (
            state.accounts.some(
              (row) => row.legacyProviderConfigId === account.legacyProviderConfigId,
            )
          ) {
            if (skipDuplicates) continue;
            throw new Error('duplicate legacy provider');
          }
          state.accounts.push(structuredClone(account));
          count++;
        }
        return { count };
      },
    },
  };
  return { prisma: { $transaction: async (operation: any) => operation(transaction) } };
});

import { backfillLegacyProviderAccounts } from '../src/services/provider-account-migration.service';

function provider(name: string, settings: object = {}, extra: object = {}) {
  return { id: `provider-${name}`, name, enabled: true, baseUrl: null, settings, ...extra };
}

beforeEach(() => {
  state.providers = [];
  state.accounts = [];
});

describe('legacy provider account backfill', () => {
  it('copies encrypted API keys and provider-specific settings without inferring health', async () => {
    state.providers.push(
      provider(
        'cloudflare',
        {
          authMode: 'apiKey',
          apiKeyEncrypted: 'already-encrypted-api-key',
          accountId: 'cloudflare-account',
          baseUrl: 'https://api.cloudflare.com/client/v4',
          defaultChat: true,
          defaultModel: 'existing-model',
          apiKey: 'must-not-copy',
          token: 'must-not-copy',
          nested: { secret: 'must-not-copy' },
        },
        { enabled: false },
      ),
    );

    expect(await backfillLegacyProviderAccounts()).toBe(1);
    expect(state.accounts[0]).toMatchObject({
      providerId: 'provider-cloudflare',
      legacyProviderConfigId: 'provider-cloudflare',
      displayName: 'cloudflare',
      authMode: 'apiKey',
      enabled: false,
      credentialEncrypted: 'already-encrypted-api-key',
      baseUrl: 'https://api.cloudflare.com/client/v4',
      settings: { accountId: 'cloudflare-account' },
      disconnectedAt: null,
      healthOk: null,
      healthCheckedAt: null,
      healthLatencyMs: null,
    });
    expect(state.accounts[0].settings).toEqual({ accountId: 'cloudflare-account' });
  });

  it('copies OAuth ciphertext, expiry and reauthorization metadata verbatim', async () => {
    const expiresAt = Date.now() + 3600_000;
    state.providers.push(
      provider('huggingface', {
        authMode: 'oauth',
        oauth: {
          provider: 'huggingface',
          accessTokenEncrypted: 'encrypted-access',
          refreshTokenEncrypted: 'encrypted-refresh',
          expiresAt,
          scope: 'inference-api',
          reauthRequired: true,
        },
      }),
    );
    expect(await backfillLegacyProviderAccounts()).toBe(1);
    expect(state.accounts[0]).toMatchObject({
      authMode: 'oauth',
      oauthProvider: 'huggingface',
      oauthAccessTokenEncrypted: 'encrypted-access',
      oauthRefreshTokenEncrypted: 'encrypted-refresh',
      oauthExpiresAt: new Date(expiresAt),
      oauthScope: 'inference-api',
      oauthNeedsReauth: true,
      settings: {},
    });
  });

  it('recognizes legacy OAuth without an explicit mode and local server endpoints', async () => {
    state.providers.push(
      provider('gemini', {
        oauth: { provider: 'google', accessTokenEncrypted: 'encrypted-google' },
      }),
      provider('ollama', {}, { baseUrl: 'http://ollama:11434' }),
      provider('lmstudio', { authMode: 'local', baseUrl: 'http://localhost:1234/v1' }),
    );
    expect(await backfillLegacyProviderAccounts()).toBe(3);
    expect(state.accounts.map(({ authMode, baseUrl }) => ({ authMode, baseUrl }))).toEqual([
      { authMode: 'oauth', baseUrl: null },
      { authMode: 'local', baseUrl: 'http://ollama:11434' },
      { authMode: 'local', baseUrl: 'http://localhost:1234/v1' },
    ]);
  });

  it('does not invent connected accounts from cloud endpoints or missing active credentials', async () => {
    state.providers.push(
      provider('groq', {}, { baseUrl: 'https://api.groq.com/openai/v1' }),
      provider('openai', { authMode: 'apiKey', apiKeyEncrypted: '  ' }),
      provider('gemini', { authMode: 'oauth', apiKeyEncrypted: 'inactive-key', oauth: {} }),
      provider('ollama', { authMode: 'local', baseUrl: '' }),
      provider('forge', { authMode: 'local', baseUrl: 'not-a-server' }),
    );
    expect(await backfillLegacyProviderAccounts()).toBe(0);
    expect(state.accounts).toEqual([]);
  });

  it('keeps the endpoint currently used by the legacy runtime when catalog metadata differs', async () => {
    state.providers.push(
      provider(
        'ollama',
        { baseUrl: 'http://active-server:11434' },
        {
          baseUrl: 'http://outdated-server:11434',
        },
      ),
    );
    await backfillLegacyProviderAccounts();
    expect(state.accounts[0].baseUrl).toBe('http://active-server:11434');
  });

  it('imports working local servers saved with the old default API-key mode', async () => {
    state.providers.push(
      provider('ollama', { authMode: 'apiKey', baseUrl: 'http://ollama:11434' }),
      provider('lmstudio', {
        authMode: 'apiKey',
        baseUrl: 'http://localhost:1234/v1',
        apiKeyEncrypted: 'saved-key',
      }),
    );
    expect(await backfillLegacyProviderAccounts()).toBe(2);
    expect(state.accounts[0]).toMatchObject({ authMode: 'local', credentialEncrypted: null });
    expect(state.accounts[1]).toMatchObject({
      authMode: 'apiKey',
      credentialEncrypted: 'saved-key',
    });
  });

  it('leaves legacy credentials, model catalog and provider defaults untouched', async () => {
    state.providers.push(
      provider(
        'openai',
        {
          authMode: 'apiKey',
          apiKeyEncrypted: 'encrypted-key',
          defaultChat: true,
          defaultModel: 'chosen-model',
          embedModel: 'chosen-embedding',
          oauth: { provider: 'google', accessTokenEncrypted: 'saved-inactive-oauth' },
        },
        { models: [{ id: 'model', modelId: 'chosen-model', costPer1kInput: 0.01 }] },
      ),
    );
    const original = structuredClone(state.providers);
    await backfillLegacyProviderAccounts();
    expect(state.providers).toEqual(original);
    expect(state.accounts[0].oauthAccessTokenEncrypted).toBe('saved-inactive-oauth');
    expect(state.accounts[0].settings).toEqual({});
  });

  it('imports once across repeated or concurrent backfills without overwriting edited accounts', async () => {
    state.providers.push(provider('openai', { apiKeyEncrypted: 'original-ciphertext' }));
    const counts = await Promise.all([
      backfillLegacyProviderAccounts(),
      backfillLegacyProviderAccounts(),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    state.accounts[0].displayName = 'Edited name';
    state.accounts[0].credentialEncrypted = 'new-ciphertext';
    expect(await backfillLegacyProviderAccounts()).toBe(0);
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({
      displayName: 'Edited name',
      credentialEncrypted: 'new-ciphertext',
    });
  });

  it('ignores malformed settings and never copies arbitrary credential-shaped properties', async () => {
    state.providers.push(
      provider('openai', []),
      provider('cloudflare', {
        apiKeyEncrypted: 'ciphertext',
        accountId: { token: 'must-not-copy' },
      }),
    );
    expect(await backfillLegacyProviderAccounts()).toBe(1);
    expect(state.accounts[0].settings).toEqual({});
  });
});
