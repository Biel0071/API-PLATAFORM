import Fastify from 'fastify';
import { ZodError } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  providers: new Map<string, any>(),
  accounts: new Map<string, any>(),
  nextId: 0,
}));
const runtimeMocks = vi.hoisted(() => ({
  testProviderAccountHealth: vi.fn(),
}));
const migrationMocks = vi.hoisted(() => ({ finalizeLegacyProviderSecrets: vi.fn(async () => 0) }));

vi.mock('../src/services/provider-account-runtime.service', () => ({
  testProviderAccountHealth: runtimeMocks.testProviderAccountHealth,
}));
vi.mock('../src/services/provider-account-migration.service', () => ({
  finalizeLegacyProviderSecrets: migrationMocks.finalizeLegacyProviderSecrets,
}));

vi.mock('../src/lib/prisma', () => {
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([key, value]) =>
      key === 'provider'
        ? row.providerId === state.providers.get((value as any).name)?.id
        : row[key] === value,
    );
  const withProvider = (row: any) =>
    row
      ? { ...row, provider: [...state.providers.values()].find((p) => p.id === row.providerId) }
      : null;
  const database: any = {
    providerConfig: {
      findUnique: vi.fn(
        async ({ where }) =>
          state.providers.get(where.name) ??
          [...state.providers.values()].find((p) => p.id === where.id) ??
          null,
      ),
      findMany: vi.fn(async () => [...state.providers.values()]),
      upsert: vi.fn(async ({ where, create, update }) => {
        const current = state.providers.get(where.name);
        const row = current
          ? { ...current, ...update }
          : { id: `provider-${where.name}`, models: [], ...create };
        state.providers.set(row.name, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const current =
          state.providers.get(where.name) ??
          [...state.providers.values()].find((p) => p.id === where.id);
        const row = { ...current, ...data };
        state.providers.set(row.name, row);
        return row;
      }),
    },
    providerAccount: {
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `account-${++state.nextId}`,
          credentialEncrypted: null,
          oauthProvider: null,
          oauthAccessTokenEncrypted: null,
          oauthRefreshTokenEncrypted: null,
          oauthExpiresAt: null,
          oauthScope: null,
          oauthNeedsReauth: false,
          baseUrl: null,
          settings: {},
          enabled: true,
          disconnectedAt: null,
          healthOk: null,
          healthCheckedAt: null,
          healthLatencyMs: null,
          legacyProviderConfigId: null,
          ...data,
        };
        state.accounts.set(row.id, row);
        return withProvider(row);
      }),
      findUnique: vi.fn(async ({ where }) =>
        withProvider([...state.accounts.values()].find((row) => matches(row, where))),
      ),
      findMany: vi.fn(async ({ where } = {}) =>
        [...state.accounts.values()].filter((row) => matches(row, where)).map(withProvider),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const row of state.accounts.values()) {
          if (matches(row, where)) {
            Object.assign(
              row,
              Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
            );
            count++;
          }
        }
        return { count };
      }),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = [...state.accounts.values()].find((account) => matches(account, where));
        if (!row) return database.providerAccount.create({ data: create });
        Object.assign(row, update);
        return withProvider(row);
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (operation) =>
      typeof operation === 'function' ? operation(database) : Promise.all(operation),
    ),
  };
  return { prisma: database };
});

vi.mock('../src/lib/redis', () => ({ redis: {} }));
vi.mock('../src/services/ai.service', () => ({
  execute: vi.fn(),
  registry: { list: () => [] },
  reloadRegistry: vi.fn(async () => ({ has: () => true })),
  reloadRegistryAfterMutation: vi.fn(async () => ({ has: () => true })),
}));

import {
  createProviderAccount,
  updateProviderAccount,
  listProviderAccounts,
  disconnectProviderAccount,
} from '../src/services/provider-account.service';
import { saveProviderConfig, listProviderConfigs } from '../src/services/provider-config.service';
import { providerAccountsRoutes } from '../src/routes/admin/provider-accounts';
import { providersRoutes } from '../src/routes/admin/providers';
import { reloadRegistryAfterMutation } from '../src/services/ai.service';
import { decryptCredential } from '@api-platform/shared';
import { env } from '../src/config/env';

beforeEach(() => {
  state.providers.clear();
  state.accounts.clear();
  state.nextId = 0;
  runtimeMocks.testProviderAccountHealth.mockReset();
  migrationMocks.finalizeLegacyProviderSecrets.mockClear();
});

const cloud = {
  providerName: 'openai',
  displayName: 'Minha conta',
  authMode: 'apiKey' as const,
  apiKey: 'synthetic-api-key',
};

async function accountApp() {
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error instanceof ZodError ? 400 : ((error as any).statusCode ?? 500))
      .send({ success: false }),
  );
  app.addHook('preHandler', async (req) => {
    req.user = { sub: 'account-test-admin' } as typeof req.user;
  });
  await providerAccountsRoutes(app);
  await providersRoutes(app);
  return app;
}

describe('provider account CRUD', () => {
  it('creates independent accounts with duplicate display names, encrypted keys and unknown health', async () => {
    const first = await createProviderAccount(cloud);
    const second = await createProviderAccount({ ...cloud, apiKey: 'synthetic-second-key' });
    expect(first.id).not.toBe(second.id);
    expect(first).toEqual({
      id: first.id,
      providerName: 'openai',
      displayName: cloud.displayName,
      authMode: 'apiKey',
      baseUrl: null,
      enabled: true,
      hasCredential: true,
      oauthNeedsReauth: false,
      health: { ok: null, checkedAt: null, latencyMs: null },
    });
    expect(
      decryptCredential(state.accounts.get(first.id).credentialEncrypted, env.JWT_SECRET),
    ).toBe(cloud.apiKey);
    const views = await listProviderAccounts('openai');
    expect(views).toHaveLength(2);
    expect(JSON.stringify(views)).not.toContain('synthetic');
    expect(JSON.stringify(views)).not.toContain(state.accounts.get(first.id).credentialEncrypted);
    expect(await listProviderAccounts('anthropic')).toEqual([]);
  });

  it('returns only the non-secret Cloudflare account ID for safe editing', async () => {
    const account = await createProviderAccount({
      ...cloud,
      providerName: 'cloudflare',
      settings: { accountId: 'public-account-id', defaultModel: '@cf/model' },
    });
    const stored = state.accounts.get(account.id);
    stored.oauthAccessTokenEncrypted = 'private-access-token';
    stored.oauthRefreshTokenEncrypted = 'private-refresh-token';
    const [view] = await listProviderAccounts('cloudflare');
    expect(view.accountId).toBe('public-account-id');
    expect(view).not.toHaveProperty('credentialEncrypted');
    expect(view).not.toHaveProperty('oauthAccessTokenEncrypted');
    expect(view).not.toHaveProperty('oauthRefreshTokenEncrypted');
    expect(JSON.stringify(view)).not.toContain(stored.credentialEncrypted);
    expect(JSON.stringify(view)).not.toContain('private-');
    await updateProviderAccount(account.id, {
      settings: { accountId: 'new-public-id', defaultModel: '@cf/model' },
    });
    expect((await listProviderAccounts('cloudflare'))[0].accountId).toBe('new-public-id');
    const other = await createProviderAccount(cloud);
    expect(other).not.toHaveProperty('accountId');
  });

  it('preserves imported account model, tier and Cloudflare ID when editing legacy defaults', async () => {
    await saveProviderConfig({
      name: 'cloudflare',
      enabled: true,
      apiKey: 'synthetic-cf-key',
      accountId: 'public-cf-id',
    });
    const [imported] = await listProviderAccounts('cloudflare');
    await updateProviderAccount(imported.id, {
      settings: {
        accountId: 'public-cf-id',
        defaultModel: '@cf/kept-model',
        accountTier: 'enterprise',
      },
    });
    await saveProviderConfig({
      name: 'cloudflare',
      enabled: true,
      defaultChat: true,
      embedModel: 'kept-embedding',
    });
    const [refreshed] = await listProviderAccounts('cloudflare');
    expect(refreshed).toMatchObject({
      accountId: 'public-cf-id',
      defaultModel: '@cf/kept-model',
      accountTier: 'enterprise',
    });
    expect(state.accounts.get(imported.id).settings).toEqual({
      accountId: 'public-cf-id',
      defaultModel: '@cf/kept-model',
      accountTier: 'enterprise',
    });
  });

  it('preserves catalog defaults and models when another account is added', async () => {
    const catalog = {
      id: 'provider-openai',
      name: 'openai',
      enabled: false,
      baseUrl: 'https://catalog.example.test',
      settings: { defaultChat: true, defaultModel: 'kept-model' },
      models: [{ modelId: 'kept-model' }],
    };
    state.providers.set('openai', structuredClone(catalog));
    await createProviderAccount(cloud);
    expect(state.providers.get('openai')).toEqual(catalog);
  });

  it('preserves blank/omitted credentials and separate OAuth material on edits and mode switches', async () => {
    const account = await createProviderAccount({ ...cloud, providerName: 'gemini' });
    const stored = state.accounts.get(account.id);
    Object.assign(stored, {
      oauthAccessTokenEncrypted: 'saved-access-ciphertext',
      oauthRefreshTokenEncrypted: 'saved-refresh-ciphertext',
      healthOk: true,
      healthCheckedAt: new Date(),
      healthLatencyMs: 12,
    });
    const ciphertext = stored.credentialEncrypted;
    await updateProviderAccount(account.id, { displayName: 'Renamed', apiKey: '   ' });
    expect(stored.credentialEncrypted).toBe(ciphertext);
    await updateProviderAccount(account.id, { authMode: 'oauth' });
    const back = await updateProviderAccount(account.id, { authMode: 'apiKey' });
    expect(back.hasCredential).toBe(true);
    expect(back.health).toEqual({ ok: null, checkedAt: null, latencyMs: null });
    expect(stored).toMatchObject({
      credentialEncrypted: ciphertext,
      oauthAccessTokenEncrypted: 'saved-access-ciphertext',
      oauthRefreshTokenEncrypted: 'saved-refresh-ciphertext',
    });
    await updateProviderAccount(account.id, { apiKey: 'replacement-key' });
    expect(decryptCredential(stored.credentialEncrypted, env.JWT_SECRET)).toBe('replacement-key');
  });

  it('permits pending OAuth only for supported providers and requires a key when switching to API mode', async () => {
    const pending = await createProviderAccount({
      providerName: 'huggingface',
      displayName: 'Pending',
      authMode: 'oauth',
    });
    expect(pending).toMatchObject({
      hasCredential: false,
      oauthNeedsReauth: true,
      health: { ok: null },
    });
    await expect(updateProviderAccount(pending.id, { authMode: 'apiKey' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(createProviderAccount({ ...cloud, authMode: 'oauth' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(createProviderAccount({ ...cloud, apiKey: '  ' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('allows local servers only on local providers with safe HTTP(S) endpoints', async () => {
    const local = await createProviderAccount({
      providerName: 'ollama',
      displayName: 'Servidor',
      authMode: 'local',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(local.hasCredential).toBe(false);
    await expect(
      createProviderAccount({ ...cloud, authMode: 'local', baseUrl: 'http://localhost:11434' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    for (const baseUrl of [
      undefined,
      'file:///tmp/data',
      'https://user:secret@host.test',
      'http://host.test?api_key=secret',
    ]) {
      await expect(
        createProviderAccount({
          providerName: 'ollama',
          displayName: 'Bad',
          authMode: 'local',
          baseUrl,
        }),
      ).rejects.toBeDefined();
    }
    await expect(updateProviderAccount(local.id, { baseUrl: '' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('accepts only provider-specific nonsecret settings and rejects unknown providers', async () => {
    const account = await createProviderAccount({
      ...cloud,
      providerName: 'cloudflare',
      settings: { accountId: 'cf-account' },
    });
    expect(state.accounts.get(account.id).settings).toEqual({ accountId: 'cf-account' });
    for (const settings of [
      { apiKey: 'leak' },
      { token: 'leak' },
      { nested: { secret: 'leak' } },
      { unknown: 'value' },
    ]) {
      await expect(
        createProviderAccount({ ...cloud, settings: settings as any }),
      ).rejects.toBeDefined();
    }
    await expect(
      createProviderAccount({ ...cloud, providerName: 'unknown' }),
    ).rejects.toBeDefined();
    await expect(
      updateProviderAccount(account.id, { settings: { accountId: 7 } }),
    ).rejects.toBeDefined();
  });

  it('soft-disconnects, erases all secrets and health, retains history identity and rejects stale edits', async () => {
    const account = await createProviderAccount({ ...cloud, providerName: 'gemini' });
    Object.assign(state.accounts.get(account.id), {
      oauthAccessTokenEncrypted: 'cipher-access',
      oauthRefreshTokenEncrypted: 'cipher-refresh',
      healthOk: true,
      healthCheckedAt: new Date(),
      healthLatencyMs: 4,
    });
    await disconnectProviderAccount(account.id);
    const stored = state.accounts.get(account.id);
    expect(stored).toMatchObject({
      id: account.id,
      enabled: false,
      credentialEncrypted: null,
      oauthAccessTokenEncrypted: null,
      oauthRefreshTokenEncrypted: null,
      oauthExpiresAt: null,
      healthOk: null,
      healthCheckedAt: null,
      healthLatencyMs: null,
    });
    expect(stored.disconnectedAt).toBeInstanceOf(Date);
    const disconnectedAt = stored.disconnectedAt;
    await disconnectProviderAccount(account.id);
    expect(stored.disconnectedAt).toEqual(disconnectedAt);
    expect(await listProviderAccounts()).toEqual([]);
    await expect(updateProviderAccount(account.id, { apiKey: 'new-secret' })).rejects.toMatchObject(
      { statusCode: 404 },
    );
  });

  it('rejects provider reassignment with the same safe response as an absent account', async () => {
    const account = await createProviderAccount(cloud);
    await expect(
      updateProviderAccount(account.id, { providerName: 'anthropic', displayName: 'Wrong' }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Conexão não encontrada.' });
    await expect(updateProviderAccount('absent', { displayName: 'Wrong' })).rejects.toMatchObject({
      statusCode: 404,
      message: 'Conexão não encontrada.',
    });
    expect(state.accounts.get(account.id).displayName).toBe(cloud.displayName);
  });

  it('redacts URL credentials, query strings and fragments from account and legacy views', async () => {
    const unsafeUrl =
      'https://user:synthetic-password@provider.example.test/v1?api_key=synthetic-query#token';
    const provider = {
      id: 'provider-openai',
      name: 'openai',
      enabled: true,
      baseUrl: unsafeUrl,
      settings: { baseUrl: unsafeUrl },
      models: [],
    };
    state.providers.set(provider.name, provider);
    state.accounts.set('account-unsafe-url', {
      id: 'account-unsafe-url',
      providerId: provider.id,
      displayName: 'Legacy',
      authMode: 'local',
      baseUrl: unsafeUrl,
      settings: {},
      enabled: true,
      disconnectedAt: null,
      credentialEncrypted: null,
      oauthAccessTokenEncrypted: null,
      oauthNeedsReauth: false,
      healthOk: null,
      healthCheckedAt: null,
      healthLatencyMs: null,
    });

    const accountViews = await listProviderAccounts();
    const configViews = await listProviderConfigs();
    const serializedViews = JSON.stringify({ accountViews, configViews });
    expect(serializedViews).not.toContain('synthetic-password');
    expect(serializedViews).not.toContain('synthetic-query');
    expect(serializedViews).not.toContain('#token');
    expect(accountViews[0].baseUrl).toBe('https://provider.example.test/v1');
    expect(configViews[0].settings.baseUrl).toBe('https://provider.example.test/v1');
  });

  it('exposes CRUD routes, safe validation and filtered listings', async () => {
    const app = await accountApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/provider-accounts',
        payload: cloud,
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().account.id;
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/provider-accounts/${id}`,
            payload: { displayName: 'Via API', apiKey: '' },
          })
        ).statusCode,
      ).toBe(200);
      const listing = await app.inject('/provider-accounts?providerName=openai');
      expect(listing.json().accounts[0]).toMatchObject({
        id,
        displayName: 'Via API',
        hasCredential: true,
      });
      expect(listing.body).not.toContain(cloud.apiKey);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/provider-accounts',
            payload: { ...cloud, credentialEncrypted: 'injected-ciphertext' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'DELETE', url: `/provider-accounts/${id}` })).statusCode,
      ).toBe(200);
      expect((await app.inject('/provider-accounts')).json().accounts).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reloads the runtime registry after account edits and disconnects', async () => {
    await saveProviderConfig({ name: 'openai', enabled: true, apiKey: 'legacy-runtime-key' });
    const account = (await listProviderAccounts())[0];
    vi.mocked(reloadRegistryAfterMutation).mockClear();
    const app = await accountApp();
    try {
      const edited = await app.inject({
        method: 'PATCH',
        url: `/provider-accounts/${account.id}`,
        payload: { apiKey: 'rotated-runtime-key' },
      });
      expect(edited.statusCode).toBe(200);
      expect(reloadRegistryAfterMutation).toHaveBeenCalledTimes(1);

      const disconnected = await app.inject({
        method: 'DELETE',
        url: `/provider-accounts/${account.id}`,
      });
      expect(disconnected.statusCode).toBe(200);
      expect(reloadRegistryAfterMutation).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('tests a real account health result and persists only the safe health summary', async () => {
    const account = await createProviderAccount(cloud);
    runtimeMocks.testProviderAccountHealth.mockResolvedValue({ ok: true, latencyMs: 12, modelCount: 3 });
    const app = await accountApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/provider-accounts/${account.id}/test`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        health: { ok: true, latencyMs: 12, modelCount: 3 },
      });
      expect(runtimeMocks.testProviderAccountHealth).toHaveBeenCalledWith(account.id);
      expect(migrationMocks.finalizeLegacyProviderSecrets).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('does not finalize legacy credentials after an unsuccessful health check', async () => {
    const account = await createProviderAccount(cloud);
    runtimeMocks.testProviderAccountHealth.mockResolvedValue({ ok: false, latencyMs: 12, modelCount: 0 });
    const app = await accountApp();
    try {
      const response = await app.inject({ method: 'POST', url: `/provider-accounts/${account.id}/test` });
      expect(response.statusCode).toBe(200);
      expect(migrationMocks.finalizeLegacyProviderSecrets).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('legacy provider configuration compatibility', () => {
  it('imports first save, synchronizes edits, keeps one legacy account and preserves the selected provider default', async () => {
    await saveProviderConfig({
      name: 'openai',
      enabled: true,
      apiKey: 'legacy-secret',
      defaultChat: true,
      defaultModel: 'chosen-model',
    });
    const account = (await listProviderAccounts())[0];
    expect(account).toMatchObject({ providerName: 'openai', hasCredential: true });
    const ciphertext = state.accounts.get(account.id).credentialEncrypted;
    await saveProviderConfig({
      name: 'openai',
      enabled: true,
      apiKey: '',
      defaultModel: 'edited-model',
    });
    expect(await listProviderAccounts()).toHaveLength(1);
    expect(state.accounts.get(account.id).credentialEncrypted).toBe(ciphertext);
    expect(state.providers.get('openai').settings.defaultChat).toBe(true);
    await saveProviderConfig({
      name: 'anthropic',
      enabled: true,
      apiKey: 'other-key',
      defaultChat: true,
    });
    expect(state.providers.get('openai').settings.defaultChat).toBe(false);
    expect(state.providers.get('anthropic').settings.defaultChat).toBe(true);
    const listing = JSON.stringify(await listProviderConfigs());
    expect(listing).not.toContain(ciphertext);
    expect(listing).not.toContain('legacy-secret');
  });

  it('mirrors imported-account edits and disconnect without restoring a stale key on a blank legacy save', async () => {
    await saveProviderConfig({
      name: 'gemini',
      enabled: true,
      apiKey: 'old-key',
      defaultChat: true,
      defaultModel: 'kept-model',
    });
    const account = (await listProviderAccounts())[0];
    await updateProviderAccount(account.id, { apiKey: 'new-key', displayName: 'Renamed' });
    expect(
      decryptCredential(state.providers.get('gemini').settings.apiKeyEncrypted, env.JWT_SECRET),
    ).toBe('new-key');
    await saveProviderConfig({ name: 'gemini', enabled: true, apiKey: '' });
    expect(
      decryptCredential(state.accounts.get(account.id).credentialEncrypted, env.JWT_SECRET),
    ).toBe('new-key');
    expect(state.accounts.get(account.id).displayName).toBe('Renamed');
    await disconnectProviderAccount(account.id);
    expect(state.providers.get('gemini').settings.apiKeyEncrypted).toBeUndefined();
    expect(state.providers.get('gemini').settings.oauth).toBeUndefined();
    expect(state.providers.get('gemini').settings.defaultChat).toBe(true);
    await saveProviderConfig({ name: 'gemini', enabled: true, apiKey: '' });
    expect(await listProviderAccounts()).toEqual([]);
  });

  it('does not create fictitious accounts for empty cloud configurations and infers legacy local endpoints', async () => {
    await saveProviderConfig({ name: 'openai', enabled: false });
    expect(await listProviderAccounts()).toEqual([]);
    await saveProviderConfig({ name: 'ollama', enabled: true, baseUrl: 'http://localhost:11434' });
    expect((await listProviderAccounts())[0]).toMatchObject({
      providerName: 'ollama',
      authMode: 'local',
      hasCredential: false,
    });
  });

  it('updates an existing imported account when the legacy connection becomes incomplete', async () => {
    await saveProviderConfig({ name: 'ollama', enabled: true, baseUrl: 'http://localhost:11434' });
    const account = state.accounts.get((await listProviderAccounts())[0].id);

    await saveProviderConfig({ name: 'ollama', enabled: false, baseUrl: '' });

    expect(account).toMatchObject({ enabled: false, authMode: 'local', baseUrl: null });
  });

  it('synchronizes a legacy switch to pending OAuth without restoring the prior API-key mode', async () => {
    await saveProviderConfig({ name: 'gemini', enabled: true, apiKey: 'old-gemini-key' });
    const account = state.accounts.get((await listProviderAccounts())[0].id);
    const encryptedKey = account.credentialEncrypted;

    await saveProviderConfig({ name: 'gemini', enabled: false, authMode: 'oauth' });

    expect(account).toMatchObject({ enabled: false, authMode: 'oauth', oauthNeedsReauth: true });
    expect(account.credentialEncrypted).toBe(encryptedKey);
  });

  it('clears a prior OAuth reauthorization marker after a successful legacy reauthorization', async () => {
    await saveProviderConfig({
      name: 'gemini',
      enabled: true,
      authMode: 'oauth',
      apiKey: 'preserved-gemini-key',
    });
    const provider = state.providers.get('gemini');
    provider.settings.oauth = {
      provider: 'gemini',
      accessTokenEncrypted: 'synthetic-oauth-ciphertext',
      reauthRequired: true,
    };
    await saveProviderConfig({ name: 'gemini', enabled: true, authMode: 'oauth' });
    const account = state.accounts.get((await listProviderAccounts())[0].id);
    expect(account.oauthNeedsReauth).toBe(true);

    state.providers.get('gemini').settings.oauth.reauthRequired = false;
    await saveProviderConfig({ name: 'gemini', enabled: true, authMode: 'oauth' });

    expect(account.oauthNeedsReauth).toBe(false);
  });
});
