process.env.DATABASE_URL = 'postgresql://aiplatform:aiplatform@localhost:5433/aiplatform?schema=public';
process.env.JWT_SECRET = 'testsecretatleast16characterslong';

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  providers: new Map<string, any>(),
  accounts: new Map<string, any>(),
  nextId: 0,
}));

const runtimeMocks = vi.hoisted(() => ({
  testProviderAccountHealth: vi.fn(async (_id: string) => ({ ok: true, latencyMs: 145, modelCount: 3 })),
}));

vi.mock('../src/services/provider-account-runtime.service', () => ({
  testProviderAccountHealth: runtimeMocks.testProviderAccountHealth,
}));

vi.mock('../src/lib/redis', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
  },
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
      update: vi.fn(async ({ where, data }) => {
        const row = state.accounts.get(where.id);
        if (row) Object.assign(row, data);
        return withProvider(row);
      }),
    },
    modelConfig: {
      findMany: vi.fn(async () => [
        { modelId: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3', capability: 'chat' },
      ]),
    },
    $queryRaw: vi.fn(async () => [
      {
        calls: 12,
        attempts: 14,
        promptTokens: 1200,
        completionTokens: 800,
        totalTokens: 2000,
        estimatedCost: 0.002,
        pricingConfigured: true,
        missingUsageAttempts: 0,
        missingPricingAttempts: 0,
        missingCostAttempts: 0,
      },
    ]),
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (operation) =>
      typeof operation === 'function' ? operation(database) : Promise.all(operation),
    ),
  };
  return { prisma: database };
});

vi.mock('../src/services/ai.service', () => ({
  execute: vi.fn(),
  registry: { list: () => [], has: () => false, get: () => null, getAccountPool: () => null },
  providerAccountPool: { listAccounts: vi.fn(async () => []) },
  reloadRegistry: vi.fn(async () => ({ has: () => true })),
  reloadRegistryAfterMutation: vi.fn(async () => ({ has: () => true })),
}));

import { accountsRoutes } from '../src/routes/v1/accounts';

async function createTestApp() {
  const app = Fastify();
  app.decorate('requireApiKey', async (req: any, reply: any) => {
    const key = req.headers['x-api-key'];
    if (!key || key !== 'valid-test-key') {
      return reply.code(401).send({ error: { code: 'INVALID_API_KEY', message: 'API key inválida' } });
    }
    req.auth = { tenantId: 'test-tenant', scopes: ['*'] };
  });
  await app.register(accountsRoutes, { prefix: '/v1' });
  return app;
}

beforeEach(() => {
  state.providers.clear();
  state.accounts.clear();
  state.nextId = 0;
});

describe('V1 Accounts API Endpoints (10 Contracts)', () => {
  it('1. GET /v1/accounts requires authentication and lists accounts', async () => {
    const app = await createTestApp();

    // Without key -> 401
    const resNoAuth = await app.inject({ method: 'GET', url: '/v1/accounts' });
    expect(resNoAuth.statusCode).toBe(401);

    // With key -> 200
    const resAuth = await app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(resAuth.statusCode).toBe(200);
    const body = resAuth.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.accounts)).toBe(true);
  });

  it('2. GET /v1/accounts/providers returns providers catalog with auth modes', async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/accounts/providers',
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.providers).toBeDefined();
    expect(body.providers.openai).toBeDefined();
    expect(body.providers.openai.apiKey.enabled).toBe(true);
  });

  it('3. POST /v1/accounts/:provider/connect connects with apiKey and local server', async () => {
    const app = await createTestApp();

    // Connect groq with apiKey
    const resApiKey = await app.inject({
      method: 'POST',
      url: '/v1/accounts/groq/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        displayName: 'Groq Production',
        authMode: 'apiKey',
        apiKey: 'gsk_test_1234567890abcdef',
      },
    });
    expect(resApiKey.statusCode).toBe(201);
    const bodyApiKey = resApiKey.json();
    expect(bodyApiKey.success).toBe(true);
    expect(bodyApiKey.account.id).toBeDefined();
    expect(bodyApiKey.account.providerName).toBe('groq');
    expect(bodyApiKey.account.hasCredential).toBe(true);

    // Connect ollama with local authMode
    const resLocal = await app.inject({
      method: 'POST',
      url: '/v1/accounts/ollama/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        displayName: 'Ollama Local Server',
        authMode: 'local',
        baseUrl: 'http://127.0.0.1:11434',
      },
    });
    expect(resLocal.statusCode).toBe(201);
    const bodyLocal = resLocal.json();
    expect(bodyLocal.success).toBe(true);
    expect(bodyLocal.account.providerName).toBe('ollama');
  });

  it('4. GET /v1/accounts/:provider/callback is public (no API Key) and handles callbacks', async () => {
    const app = await createTestApp();
    // Public access (no x-api-key header)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/accounts/gemini/callback?state=invalid_or_expired_state',
    });
    // Doesn't return 401 because it's public
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(400); // Invalid state properly rejected
  });

  it('5. POST /v1/accounts/:id/test performs live health check', async () => {
    const app = await createTestApp();

    // Create an account first
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts/groq/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        authMode: 'apiKey',
        apiKey: 'gsk_test_key',
      },
    });
    const accountId = createRes.json().account.id;

    // Test health
    const testRes = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${accountId}/test`,
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(testRes.statusCode).toBe(200);
    const body = testRes.json();
    expect(body.success).toBe(true);
    expect(body.health.ok).toBe(true);
    expect(body.health.latencyMs).toBe(145);
  });

  it('6. GET /v1/accounts/:id/status returns detailed connection status', async () => {
    const app = await createTestApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts/groq/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        displayName: 'Groq Health Check',
        authMode: 'apiKey',
        apiKey: 'gsk_test_key',
      },
    });
    const accountId = createRes.json().account.id;

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/status`,
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(statusRes.statusCode).toBe(200);
    const body = statusRes.json();
    expect(body.success).toBe(true);
    expect(body.status.id).toBe(accountId);
    expect(body.status.providerName).toBe('groq');
    expect(body.status.status).toBe('connected');
  });

  it('7. GET /v1/accounts/:id/usage returns token consumption windows including 1h, 5h, 7d', async () => {
    const app = await createTestApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts/groq/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        authMode: 'apiKey',
        apiKey: 'gsk_test_key',
      },
    });
    const accountId = createRes.json().account.id;

    const usageRes = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/usage`,
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(usageRes.statusCode).toBe(200);
    const body = usageRes.json();
    expect(body.success).toBe(true);
    expect(body.usage.last1h).toBeDefined();
    expect(body.usage.last5h).toBeDefined();
    expect(body.usage.last7d).toBeDefined();
    expect(body.usage.last1h.totalTokens).toBe(2000);
  });

  it('8. GET /v1/accounts/:id/capabilities returns supported models', async () => {
    const app = await createTestApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts/groq/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        authMode: 'apiKey',
        apiKey: 'gsk_test_key',
      },
    });
    const accountId = createRes.json().account.id;

    const capRes = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/capabilities`,
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(capRes.statusCode).toBe(200);
    const body = capRes.json();
    expect(body.success).toBe(true);
    expect(body.capabilities.models).toBeDefined();
    expect(body.capabilities.models.length).toBeGreaterThan(0);
  });

  it('9. POST /v1/accounts/:id/refresh refreshes account state', async () => {
    const app = await createTestApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts/groq/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        authMode: 'apiKey',
        apiKey: 'gsk_test_key',
      },
    });
    const accountId = createRes.json().account.id;

    const refRes = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${accountId}/refresh`,
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(refRes.statusCode).toBe(200);
    const body = refRes.json();
    expect(body.success).toBe(true);
    expect(body.refreshed).toBe(true);
  });

  it('10. POST /v1/accounts/:id/disconnect disconnects and revokes account', async () => {
    const app = await createTestApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts/groq/connect',
      headers: { 'x-api-key': 'valid-test-key' },
      payload: {
        authMode: 'apiKey',
        apiKey: 'gsk_test_key',
      },
    });
    const accountId = createRes.json().account.id;

    const disRes = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${accountId}/disconnect`,
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(disRes.statusCode).toBe(200);
    expect(disRes.json().disconnected).toBe(true);

    // Subsequent status check should show disconnected
    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/status`,
      headers: { 'x-api-key': 'valid-test-key' },
    });
    expect(statusRes.json().status.status).toBe('disconnected');
  });
});
