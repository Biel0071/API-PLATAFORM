import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as any[], prices: [] as any[], cache: null as any, writesFail: false,
  accountIds: ['account-a', 'account-b'],
}));
const db = vi.hoisted(() => ({
  modelConfig: { findMany: vi.fn(async () => structuredClone(state.prices)), upsert: vi.fn(async (input: any) => input.create) },
  providerAttempt: { create: vi.fn(async ({ data }: any) => {
    if (state.writesFail) throw new Error('storage unavailable');
    state.rows.push({ ...structuredClone(data), createdAt: data.createdAt ?? new Date() });
  }) },
  providerAccount: { findUnique: vi.fn(async ({ where }: any) => state.accountIds.includes(where.id) ? { id: where.id } : null) },
  providerConfig: { upsert: vi.fn(async () => ({ id: 'provider-id' })) },
  requestLog: { create: vi.fn() }, usage: { upsert: vi.fn() },
  $queryRaw: vi.fn(async (_sql: any, accountId: string, since: Date, until: Date) => {
    const rows = state.rows.filter((r) => r.providerAccountId === accountId && r.createdAt >= since && r.createdAt <= until);
    const complete = (field: string) => rows.every((r) => r[field] != null);
    const sum = (field: string) => rows.reduce((n, r) => n + (r[field] ?? 0), 0);
    return [{ calls: new Set(rows.map((r) => r.correlationId)).size, attempts: rows.length,
      promptTokens: complete('promptTokens') ? sum('promptTokens') : null,
      completionTokens: complete('completionTokens') ? sum('completionTokens') : null,
      totalTokens: complete('totalTokens') ? sum('totalTokens') : null,
      observedTokens: sum('totalTokens'),
      estimatedCost: complete('estimatedCost') ? sum('estimatedCost') : null,
      pricingConfigured: rows.every((r) => r.pricingConfigured),
      missingUsageAttempts: rows.filter((r) => r.totalTokens == null).length,
      missingPricingAttempts: rows.filter((r) => !r.pricingConfigured).length,
      missingCostAttempts: rows.filter((r) => r.estimatedCost == null).length }];
  }),
}));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('@prisma/client', async (original) => ({ ...await original<any>(), PrismaClient: class { constructor() { return db; } } }));
vi.mock('../src/lib/logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../src/services/cache.service', () => ({ cacheService: {
  generateKey: (input: any) => JSON.stringify(input), get: async () => ({ data: state.cache, hit: state.cache ? 'L1' : undefined }),
  set: async () => undefined, stats: async () => ({}),
} }));
vi.mock('../src/services/usage.service', () => ({ usageService: { record: vi.fn() } }));
vi.mock('../src/services/provider-config.service', () => ({ buildProviderEnv: vi.fn(), listProviderConfigs: async () => [] }));
vi.mock('../src/services/provider-account-runtime.service', () => ({ loadProviderAccountRuntime: vi.fn(), testProviderAccountHealth: vi.fn() }));
vi.mock('../src/services/execution-memory.service', () => ({ recallExecutionRoute: async () => undefined, rememberExecutionSuccess: async () => undefined }));
vi.mock('../src/services/queue.service', () => ({ enqueueAndWait: vi.fn(), queueStats: async () => [] }));
vi.mock('../src/services/comfy-provider.service', () => ({ resolveComfyProviderSelection: async () => ({
  providerAccountId: 'account-a', provider: { executeWorkflow: async () => ({ model: 'workflow-model', result: { images: [] } }) },
}) }));

import { ProviderAccountPool, ProviderRegistry, createProviderAttemptContext, ProviderAttemptTracker } from '@api-platform/shared';
import { providerAttemptTracker } from '../src/services/provider-attempt.service';
import { getProviderAccountUsage } from '../src/services/provider-account-usage.service';
import { execute, registry, providerCircuit } from '../src/services/ai.service';
import { smartRouterService } from '../src/services/smart-router.service';
import { DirectExecutor } from '../src/services/execution-gateway.service';
import { decideRoutes } from '../src/routes/v1/decide';
import { imageProcessor, textProcessor, orchestratorProcessor, multimodelProcessor } from '../../worker/src/processors';
import { observabilityRoutes } from '../src/routes/admin/observability';
import { providerAccountsRoutes } from '../src/routes/admin/provider-accounts';
import { v1Routes } from '../src/routes/v1';

const result = () => ({ result: { text: 'A real test response.' }, model: 'test-model', tokens: { prompt: 100, completion: 50, total: 150 } });
const provider = (name = 'openai', invoke: any = async () => result()) => ({ name, capabilities: ['chat', 'image', 'decision'], chat: invoke, generateText: invoke, generateImage: invoke, decision: invoke });
function setAccounts(invokeA: any = async () => result(), invokeB: any = async () => result()) {
  registry.register(provider() as any);
  registry.setAccountPool(new ProviderAccountPool(async () => [invokeA, invokeB].map((invoke, i) => ({
    accountId: i ? 'account-b' : 'account-a', providerName: 'openai', provider: provider('openai', invoke) as any,
    enabled: true, healthOk: true, healthCheckedAt: new Date(),
  })), async () => 0));
  for (const id of ['account-a', 'account-b']) providerCircuit.recordSuccess(`openai:chat:${id}`);
}
beforeEach(() => {
  state.rows = []; state.prices = [{ modelId: 'test-model', pricingConfigured: true, costPer1kInput: 2, costPer1kOutput: 4 }];
  state.cache = null; state.writesFail = false; vi.clearAllMocks(); setAccounts();
});

describe('provider attempts and account usage', () => {
  it('does not report internal token estimates as observed provider usage', async () => {
    await providerAttemptTracker.observe(createProviderAttemptContext(), { provider: 'laya', providerAccountId: 'account-a', capability: 'chat' }, async () => result());
    expect(state.rows[0]).toMatchObject({ provider: 'laya', promptTokens: null, completionTokens: null, totalTokens: null, estimatedCost: null });
  });

  it('snapshots prices before invocation and preserves observed zero versus unavailable usage/pricing', async () => {
    const context = createProviderAttemptContext({ correlationId: 'call', executionId: 'execution' });
    await providerAttemptTracker.observe(context, { provider: 'openai', providerAccountId: 'account-a', model: 'test-model', capability: 'chat' }, async () => {
      state.prices[0].costPer1kInput = 200;
      return result();
    });
    expect(state.rows[0]).toMatchObject({ estimatedCost: 0.4, inputRatePer1k: 2, outputRatePer1k: 4, promptTokens: 100, totalTokens: 150, attemptNumber: 1 });
    state.prices[0] = { modelId: 'test-model', pricingConfigured: true, costPer1kInput: 0, costPer1kOutput: 0 };
    await providerAttemptTracker.observe(context, { provider: 'openai', model: 'test-model', capability: 'chat' }, async () => result());
    expect(state.rows[1]).toMatchObject({ providerAccountId: null, estimatedCost: 0, pricingConfigured: true, attemptNumber: 2 });
    state.prices[0].pricingConfigured = false;
    await providerAttemptTracker.observe(context, { provider: 'openai', model: 'test-model', capability: 'chat' }, async () => ({ result: {}, model: 'test-model' }));
    expect(state.rows[2]).toMatchObject({ estimatedCost: null, pricingConfigured: false, promptTokens: null, totalTokens: null });
  });

  it('records failed calls with null usage and safe error codes without affecting inference on persistence failure', async () => {
    const context = createProviderAttemptContext();
    await expect(providerAttemptTracker.observe(context, { provider: 'openai', capability: 'chat', model: 'test-model' }, async () => { throw Object.assign(new Error('secret token'), { code: 'AUTH_FAILURE' }); })).rejects.toThrow('secret token');
    expect(state.rows[0]).toMatchObject({ success: false, errorCode: 'AUTH_FAILURE', totalTokens: null, estimatedCost: null });
    expect(JSON.stringify(state.rows)).not.toContain('secret token');
    state.writesFail = true;
    await expect(providerAttemptTracker.observe(context, { provider: 'openai', capability: 'chat' }, async () => result())).resolves.toMatchObject({ model: 'test-model' });
    expect(db.requestLog.create).not.toHaveBeenCalled(); expect(db.usage.upsert).not.toHaveBeenCalled();
  });

  it('retains partial usage attached to a provider error without inventing missing components', async () => {
    await expect(providerAttemptTracker.observe(createProviderAttemptContext(), { provider: 'openai', model: 'test-model', capability: 'chat' }, async () => {
      throw Object.assign(new Error('partial failure'), { tokens: { prompt: 100, completion: 5, total: 105 }, code: 'UPSTREAM_FAILURE' });
    })).rejects.toThrow('partial failure');
    expect(state.rows[0]).toMatchObject({ success: false, promptTokens: 100, completionTokens: 5, totalTokens: 105, estimatedCost: 0.22 });
  });

  it('observes streaming usage at completion and marks interrupted streams as failures', async () => {
    const context = createProviderAttemptContext();
    const response = await providerAttemptTracker.observe(context, { provider: 'openai', model: 'test-model', capability: 'chat' }, async () => ({ stream: true, model: 'test-model', chunks: (async function* () {
      yield { type: 'usage', promptTokens: 100, completionTokens: 50, totalTokens: 150 };
      yield { type: 'done' };
    })() }));
    expect(state.rows).toHaveLength(0);
    for await (const chunk of response.chunks) { expect(chunk.type).toBeDefined(); }
    expect(state.rows[0]).toMatchObject({ success: true, totalTokens: 150, estimatedCost: 0.4 });
    const interrupted = await providerAttemptTracker.observe(context, { provider: 'openai', model: 'test-model', capability: 'chat' }, async () => ({ stream: true, model: 'test-model', chunks: (async function* () { yield { type: 'delta', text: 'partial' }; yield { type: 'done' }; })() }));
    for await (const chunk of interrupted.chunks) { expect(chunk.type).toBe('delta'); break; }
    expect(state.rows[1]).toMatchObject({ success: false, errorCode: 'STREAM_INTERRUPTED', totalTokens: null });
  });

  it('retains known positive legacy tariffs and does not record health or model discovery', async () => {
    state.prices[0].pricingConfigured = false;
    const context = createProviderAttemptContext();
    const observed = providerAttemptTracker.provider(context, { ...provider(), health: async () => ({ ok: true }), models: async () => [] } as any);
    await observed.health(); await observed.models();
    expect(state.rows).toHaveLength(0);
    await observed.chat({ messages: [] });
    expect(state.rows[0]).toMatchObject({ pricingConfigured: true, estimatedCost: 0.4 });
  });

  it('bounds telemetry latency and in-flight work when storage never responds', async () => {
    const loadPrices = vi.fn(() => new Promise<any[]>(() => {}));
    const record = vi.fn(() => new Promise<void>(() => {}));
    const tracker = new ProviderAttemptTracker({ loadPrices, record });
    const start = Date.now();
    const responses = await Promise.all(Array.from({ length: 30 }, () => tracker.observe(createProviderAttemptContext(), { provider: 'openai', capability: 'chat' }, async () => result())));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(responses).toHaveLength(30);
    expect(loadPrices.mock.calls.length + record.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it('records each synchronous fallback once with a stable call/execution id and excludes cache hits', async () => {
    let calls = 0;
    await execute('chat', { provider: 'openai', model: 'test-model', cache: false }, async () => {
      if (++calls === 1) throw Object.assign(new Error('temporary'), { statusCode: 503 });
      return result();
    }, { correlationId: 'sync-call' });
    expect(state.rows.map((r) => [r.providerAccountId, r.attemptNumber, r.success])).toEqual([['account-a', 1, false], ['account-b', 2, true]]);
    expect(new Set(state.rows.map((r) => r.executionId)).size).toBe(1);
    expect(state.rows.every((r) => r.correlationId === 'sync-call')).toBe(true);
    state.cache = { provider: 'openai', model: 'test-model', result: { text: 'Cached answer.' }, tokens: { total: 20 } };
    await execute('chat', { provider: 'openai', model: 'test-model' }, async () => { throw new Error('cache should skip call'); });
    expect(state.rows).toHaveLength(2);
  });

  it('shares a gateway/smart-router sequence without double counting delegated calls', async () => {
    const context: any = { executionId: 'gateway-exec', traceId: 'gateway-call', correlationId: 'gateway-call', tenant: '', metadata: {} };
    const direct = new DirectExecutor();
    // Explicit accounts go directly; smart-router calls are checked independently with the same context.
    context.providerAccountId = 'account-a';
    await direct.execute(context, { provider: 'openai', model: 'test-model', messages: [] });
    delete context.providerAccountId;
    const route = vi.spyOn(smartRouterService, 'route').mockResolvedValue({
      primary: { provider: 'openai', model: 'test-model' }, fallbackChain: [], requiredCapabilities: ['text'],
    } as any);
    try { await direct.execute(context, { model: 'test-model', messages: [] }); }
    finally { route.mockRestore(); }
    expect(state.rows).toHaveLength(2);
    expect(state.rows.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(state.rows.every((r) => r.executionId === 'gateway-exec')).toBe(true);
  });

  it('records a real decision provider but never records the local classifier fallback as a call', async () => {
    const app = Fastify();
    app.decorate('requireApiKey', async (request: any) => { request.auth = { scopes: ['chat'] }; });
    await app.register(decideRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: '/decide', payload: { prompt: 'hello', providerAccountId: 'account-a' } });
      expect(response.statusCode).toBe(200); expect(state.rows).toHaveLength(1);
      expect(state.rows[0]).toMatchObject({ capability: 'decision', providerAccountId: 'account-a' });
      registry.register(provider('decision-fails', async () => { throw new Error('offline'); }) as any);
      await app.inject({ method: 'POST', url: '/decide', payload: { prompt: 'hello', provider: 'decision-fails' } });
      expect(state.rows).toHaveLength(2); expect(state.rows[1].success).toBe(false);
    } finally { await app.close(); }
  });

  it('attributes automatic decision selection to its account rather than the legacy catalog instance', async () => {
    const app = Fastify();
    app.decorate('requireApiKey', async (request: any) => { request.auth = { scopes: ['chat'] }; });
    await app.register(decideRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: '/decide', payload: { prompt: 'hello', provider: 'openai' } });
      expect(response.statusCode).toBe(200);
      expect(state.rows[0]).toMatchObject({ providerAccountId: 'account-a' });
    } finally { await app.close(); }
  });

  it('records worker fallback and every image in a batch with the queued correlation id', async () => {
    const workerRegistry = new ProviderRegistry().register(provider() as any);
    let calls = 0;
    workerRegistry.setAccountPool(new ProviderAccountPool(async () => [0, 1].map((i) => ({
      accountId: i ? 'account-b' : 'account-a', providerName: 'openai', provider: provider('openai', async () => {
        if (++calls === 1) throw Object.assign(new Error('offline'), { statusCode: 503 });
        return { ...result(), result: { images: [{ url: 'https://image.invalid/test.png' }] } };
      }) as any, enabled: true, healthOk: true, healthCheckedAt: new Date(),
    })), async () => 0));
    await textProcessor({ id: 'job-1', data: { prompt: 'hello', provider: 'openai', __correlationId: 'queued-call', __jobId: 'job-1' } } as any, workerRegistry);
    expect(state.rows.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(state.rows.every((r) => r.correlationId === 'queued-call')).toBe(true);
    state.rows = [];
    await imageProcessor({ id: 'job-2', data: { __kind: 'gallery', count: 3, provider: 'openai', __correlationId: 'gallery' } } as any, workerRegistry);
    expect(state.rows).toHaveLength(3); expect(state.rows.map((r) => r.attemptNumber)).toEqual([1, 2, 3]);
  });

  it('observes DAG node invocations and parallel model calls with one sequence per execution', async () => {
    const workerRegistry = new ProviderRegistry().register(provider() as any);
    await orchestratorProcessor({ id: 'dag-job', data: { prompt: 'hello', __correlationId: 'dag-call' } } as any, workerRegistry);
    expect(state.rows).toHaveLength(1); expect(state.rows[0]).toMatchObject({ providerAccountId: null, correlationId: 'dag-call' });
    state.rows = [];
    await multimodelProcessor({ id: 'multi-job', data: { messages: [], models: ['first', 'second'], __correlationId: 'multi-call' } } as any, workerRegistry);
    expect(state.rows).toHaveLength(2);
    expect(state.rows.map((r) => r.attemptNumber).sort()).toEqual([1, 2]);
    expect(new Set(state.rows.map((r) => r.executionId)).size).toBe(1);
  });

  it('aggregates only account attempts with inclusive rolling boundaries and distinct fallback calls', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    const row = (age: number, overrides = {}) => ({ providerAccountId: 'account-a', correlationId: 'same-call', createdAt: new Date(now.getTime() - age), promptTokens: 1, completionTokens: 2, totalTokens: 3, estimatedCost: 0, pricingConfigured: true, ...overrides });
    state.rows = [row(0), row(5 * 3600_000), row(7 * 24 * 3600_000), row(7 * 24 * 3600_000 + 1), row(-1), row(0, { providerAccountId: 'account-b' })];
    const usage = await getProviderAccountUsage('account-a', now);
    expect(usage.last5h).toMatchObject({ calls: 1, attempts: 2, totalTokens: 6, estimatedCost: 0, pricingConfigured: true });
    expect(usage.last7d).toMatchObject({ calls: 1, attempts: 3, totalTokens: 9 });
    expect(db.requestLog.create).not.toHaveBeenCalled();
    await expect(getProviderAccountUsage('missing', now)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('marks window totals unavailable when any real attempt lacks tokens or pricing', async () => {
    const now = new Date();
    state.rows = [
      { providerAccountId: 'account-a', correlationId: 'failure', createdAt: now, promptTokens: null, completionTokens: null, totalTokens: null, estimatedCost: null, pricingConfigured: false },
      { providerAccountId: 'account-a', correlationId: 'observed', createdAt: now, promptTokens: 8, completionTokens: 4, totalTokens: 12, estimatedCost: null, pricingConfigured: false },
    ];
    expect((await getProviderAccountUsage('account-a', now)).last5h).toMatchObject({ attempts: 2, totalTokens: null, observedTokens: 12, estimatedCost: null, missingUsageAttempts: 1, missingPricingAttempts: 2, missingCostAttempts: 2 });
  });

  it('does not label missing token components as missing pricing and exposes the protected usage route', async () => {
    await providerAttemptTracker.observe(createProviderAttemptContext(), { provider: 'openai', providerAccountId: 'account-a', model: 'test-model', capability: 'chat' }, async () => ({ result: {}, model: 'test-model', tokens: { total: 200 } }));
    const app = Fastify(); await providerAccountsRoutes(app);
    try {
      const response = await app.inject('/provider-accounts/account-a/usage');
      expect(response.statusCode).toBe(200);
      expect(response.json().usage.last5h).toMatchObject({ totalTokens: 200, estimatedCost: null, pricingConfigured: true, missingPricingAttempts: 0, missingCostAttempts: 1 });
      const invalid = await app.inject(`/provider-accounts/${'x'.repeat(129)}/usage`);
      expect(invalid.statusCode).not.toBe(200);
    } finally { await app.close(); }
  });

  it('records the real synchronous workflow invocation against the selected account', async () => {
    const app = Fastify();
    app.decorate('requireApiKey', async (request: any) => { request.auth = { scopes: ['workflow'] }; });
    await app.register(v1Routes, { prefix: '/v1' });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/workflow', payload: { graph: { node: { class_type: 'test' } }, providerAccountId: 'account-a' } });
      expect(response.statusCode).toBe(200);
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]).toMatchObject({ provider: 'comfyui', providerAccountId: 'account-a', model: 'workflow-model', capability: 'image', success: true, totalTokens: null });
    } finally { await app.close(); }
  });

  it('distinguishes omitted prices from explicitly configured zero in admin writes', async () => {
    const app = Fastify(); await observabilityRoutes(app);
    try {
      await app.inject({ method: 'POST', url: '/models', payload: { provider: 'openai', modelId: 'zero', costPer1kInput: 0, costPer1kOutput: 0 } });
      expect(db.modelConfig.upsert.mock.calls[0][0].create.pricingConfigured).toBe(true);
      await app.inject({ method: 'POST', url: '/models', payload: { provider: 'openai', modelId: 'unset' } });
      expect(db.modelConfig.upsert.mock.calls[1][0].create.pricingConfigured).toBe(false);
      expect(db.modelConfig.upsert.mock.calls[1][0].update).not.toHaveProperty('pricingConfigured');
    } finally { await app.close(); }
  });
});
