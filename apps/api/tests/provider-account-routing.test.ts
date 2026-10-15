import { describe, expect, it, vi } from 'vitest';
import {
  OpenAICompatibleProvider,
  ProviderAccountPool,
  ProviderRegistry,
  buildProviderAccountEnvironments,
  encryptCredential,
  resolveProviderAccountTargets,
} from '@api-platform/shared';

const account = (
  accountId: string,
  providerName = 'openai',
  capabilities: Array<'chat' | 'embedding'> = ['chat'],
  overrides: Partial<{
    enabled: boolean;
    healthOk: boolean | null;
    healthCheckedAt: Date | null;
  }> = {},
) => ({
  accountId,
  providerName,
  provider: new OpenAICompatibleProvider({
    name: providerName,
    baseUrl: 'https://example.test',
    capabilities,
  }),
  enabled: overrides.enabled ?? true,
  healthOk: Object.prototype.hasOwnProperty.call(overrides, 'healthOk')
    ? overrides.healthOk!
    : true,
  healthCheckedAt: Object.prototype.hasOwnProperty.call(overrides, 'healthCheckedAt')
    ? overrides.healthCheckedAt!
    : new Date(),
});

describe('ProviderAccountPool', () => {
  it('rotates account start position using the shared index callback', async () => {
    const nextIndex = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const pool = new ProviderAccountPool(async () => [account('a'), account('b')], nextIndex);

    expect((await pool.resolveAccounts('openai', 'chat')).map((item) => item.accountId)).toEqual([
      'b',
      'a',
    ]);
    expect((await pool.resolveAccounts('openai', 'chat')).map((item) => item.accountId)).toEqual([
      'a',
      'b',
    ]);
    expect(nextIndex).toHaveBeenNthCalledWith(1, 'openai', 2);
  });

  it('filters by capability and excludes disabled, unknown, unhealthy and stale accounts', async () => {
    const stale = new Date(Date.now() - 120_000);
    const pool = new ProviderAccountPool(
      async () => [
        account('healthy'),
        account('wrong-capability', 'openai', ['embedding']),
        account('unknown', 'openai', ['chat'], { healthOk: null }),
        account('unhealthy', 'openai', ['chat'], { healthOk: false }),
        account('stale', 'openai', ['chat'], { healthCheckedAt: stale }),
        account('disabled', 'openai', ['chat'], { enabled: false }),
      ],
      async () => 0,
    );

    expect((await pool.resolveAccounts('openai', 'chat')).map((item) => item.accountId)).toEqual([
      'healthy',
    ]);
  });

  it('honors explicit selection without health filtering and rejects provider mismatch', async () => {
    const pool = new ProviderAccountPool(
      async () => [
        account('selected', 'openai', ['chat'], { healthOk: false }),
        account('other', 'anthropic'),
      ],
      async () => 0,
    );

    expect(
      (await pool.resolveAccounts('openai', 'chat', 'selected')).map((item) => item.accountId),
    ).toEqual(['selected']);
    await expect(pool.resolveAccounts('openai', 'chat', 'other')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('returns no accounts when none are configured rather than synthesizing a target', async () => {
    const pool = new ProviderAccountPool(
      async () => [],
      async () => 0,
    );
    expect(await pool.resolveAccounts('openai', 'chat')).toEqual([]);
  });

  it('places account instances before provider fallbacks and never duplicates the legacy provider', async () => {
    const registry = new ProviderRegistry()
      .register(
        new OpenAICompatibleProvider({
          name: 'openai',
          baseUrl: 'https://legacy.test',
          capabilities: ['chat'],
        }),
      )
      .register(
        new OpenAICompatibleProvider({
          name: 'anthropic',
          baseUrl: 'https://anthropic.test',
          capabilities: ['chat'],
        }),
      );
    const pool = new ProviderAccountPool(
      async () => [account('a'), account('b')],
      async () => 0,
    );

    const targets = await resolveProviderAccountTargets(registry, pool, 'chat', 'openai');
    expect(targets.map((target) => target.accountId || target.providerName)).toEqual([
      'a',
      'b',
      'anthropic',
    ]);
    expect(targets.some((target) => target.provider === registry.get('openai'))).toBe(false);
  });

  it('builds isolated environments with each account credential and shared provider settings', async () => {
    const provider = {
      name: 'openai',
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      settings: {
        defaultModel: 'gpt-4.1-mini',
        apiKeyEncrypted: encryptCredential('legacy', 'secret'),
      },
    };
    const base = {
      authMode: 'apiKey' as const,
      enabled: true,
      provider,
      settings: {},
      providerName: 'openai',
      oauthProvider: null,
      oauthAccessTokenEncrypted: null,
      oauthRefreshTokenEncrypted: null,
      oauthExpiresAt: null,
      oauthScope: null,
      oauthNeedsReauth: false,
    };
    const [first, second] = await buildProviderAccountEnvironments(
      [
        { ...base, id: 'a', credentialEncrypted: encryptCredential('key-a', 'secret') },
        { ...base, id: 'b', credentialEncrypted: encryptCredential('key-b', 'secret') },
      ],
      'secret',
      async () => undefined,
    );

    expect(first.env.OPENAI_API_KEY).toBe('key-a');
    expect(second.env.OPENAI_API_KEY).toBe('key-b');
    expect(first.env.OPENAI_DEFAULT_MODEL).toBe('gpt-4.1-mini');
    expect(first.env).not.toHaveProperty('apiKeyEncrypted');
  });

  it('loads a local account endpoint from the account row', async () => {
    const [account] = await buildProviderAccountEnvironments(
      [{
        id: 'ollama-local',
        providerName: 'ollama',
        authMode: 'local',
        enabled: true,
        baseUrl: 'http://ollama-account:11434',
        settings: {},
        provider: { name: 'ollama', enabled: true, baseUrl: null, settings: {} },
      }],
      'secret',
      async () => undefined,
    );

    expect(account.env.OLLAMA_BASE_URL).toBe('http://ollama-account:11434');
  });
});
