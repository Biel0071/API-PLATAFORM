import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRegistryFromEnv: vi.fn(),
  buildProviderAccountEnvironments: vi.fn(),
  providerHealth: vi.fn(),
  accountUpdate: vi.fn(),
}));

vi.mock('@api-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@api-platform/shared')>();
  return {
    ...actual,
    createRegistryFromEnv: mocks.createRegistryFromEnv,
    buildProviderAccountEnvironments: mocks.buildProviderAccountEnvironments,
  };
});

vi.mock('../src/lib/prisma', () => ({
  prisma: {
    providerAccount: {
      findMany: vi.fn(async () => [
        {
          id: 'account-1',
          providerName: 'openai',
          providerId: 'provider-openai',
          provider: { name: 'openai', enabled: true, baseUrl: null, settings: {} },
          enabled: true,
          disconnectedAt: null,
          updatedAt: new Date('2026-10-15T12:00:00.000Z'),
          credentialEncrypted: null,
          authMode: 'apiKey',
          settings: {},
          oauthProvider: null,
          oauthAccessTokenEncrypted: null,
          oauthRefreshTokenEncrypted: null,
          oauthExpiresAt: null,
          oauthScope: null,
          oauthNeedsReauth: false,
          healthOk: null,
          healthCheckedAt: null,
        },
      ]),
      update: mocks.accountUpdate,
      findUnique: vi.fn(),
    },
  },
}));
vi.mock('../src/lib/redis', () => ({ redis: {} }));

import { testProviderAccountHealth } from '../src/services/provider-account-runtime.service';

describe('provider account runtime health checks', () => {
  beforeEach(() => {
    mocks.providerHealth.mockReset();
    mocks.accountUpdate.mockReset();
    const legacyProvider = { name: 'openai', capabilities: ['chat'], health: mocks.providerHealth };
    const legacyRegistry = {
      has: vi.fn(() => true),
      get: vi.fn(() => legacyProvider),
      register: vi.fn(),
      setAccountPool: vi.fn(),
    };
    const unconfiguredRegistry = {
      has: vi.fn(() => false),
      get: vi.fn(),
      register: vi.fn(),
      setAccountPool: vi.fn(),
    };
    mocks.createRegistryFromEnv
      .mockReset()
      .mockReturnValueOnce(legacyRegistry)
      .mockReturnValueOnce(unconfiguredRegistry);
    mocks.buildProviderAccountEnvironments.mockReset().mockResolvedValue([
      { accountId: 'account-1', providerName: 'openai', env: {} },
    ]);
  });

  it('does not mark an account healthy by checking the provider-level legacy credential', async () => {
    mocks.providerHealth.mockResolvedValue({ ok: true, latencyMs: 4 });

    await expect(testProviderAccountHealth('account-1')).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT_NOT_CONFIGURED',
    });

    expect(mocks.providerHealth).not.toHaveBeenCalled();
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
  });
});
