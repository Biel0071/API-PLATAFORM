import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cacheKeys: [] as any[] }));

vi.mock('../src/services/cache.service', () => ({
  cacheService: {
    generateKey: vi.fn((input) => {
      state.cacheKeys.push(input);
      return JSON.stringify(input);
    }),
    get: vi.fn(async () => ({ data: null })),
    set: vi.fn(async () => undefined),
  },
}));
vi.mock('../src/services/usage.service', () => ({ usageService: { record: vi.fn() } }));
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));
vi.mock('../src/services/provider-config.service', () => ({ buildProviderEnv: vi.fn() }));
vi.mock('../src/services/provider-account-runtime.service', () => ({ loadProviderAccountRuntime: vi.fn() }));
vi.mock('../src/services/execution-memory.service', () => ({
  recallExecutionRoute: vi.fn(async () => undefined),
  rememberExecutionSuccess: vi.fn(async () => undefined),
}));

import {
  OpenAICompatibleProvider,
  ProviderAccountBinding,
  ProviderAccountPool,
} from '@api-platform/shared';
import { execute, providerCircuit, registry } from '../src/services/ai.service';
import { cacheService } from '../src/services/cache.service';

function binding(
  accountId: string,
  baseUrl: string,
  overrides: Partial<ProviderAccountBinding> = {},
): ProviderAccountBinding {
  return {
    accountId,
    providerName: 'openai',
    provider: new OpenAICompatibleProvider({ name: 'openai', baseUrl, capabilities: ['chat'] }),
    enabled: true,
    healthOk: true,
    healthCheckedAt: new Date(),
    ...overrides,
  };
}

describe('ai.execute provider-account routing', () => {
  beforeEach(() => {
    state.cacheKeys.length = 0;
    registry.register(
      new OpenAICompatibleProvider({ name: 'openai', baseUrl: 'https://legacy.test', capabilities: ['chat'] }),
    );
    registry.setAccountPool(new ProviderAccountPool(async () => [
      binding('account-a', 'https://account-a.test'),
      binding('account-b', 'https://account-b.test'),
    ], async () => 0));
    providerCircuit.recordSuccess('openai:chat');
    providerCircuit.recordSuccess('openai:chat:account-a');
    providerCircuit.recordSuccess('openai:chat:account-b');
    vi.mocked(cacheService.generateKey).mockClear();
  });

  it('derives provider from a pinned account, omits the selector from provider input, and isolates its cache key', async () => {
    const request: Record<string, any> = {
      providerAccountId: 'account-b',
      model: 'test-model',
      prompt: 'hello',
      cache: false,
    };
    let calledProvider: any;
    const response = await execute(
      'chat',
      request,
      async (provider, providerInput) => {
        calledProvider = provider;
        expect(providerInput).not.toHaveProperty('providerAccountId');
        expect(request).not.toHaveProperty('providerAccountId');
        return { result: { text: 'ok' }, model: 'test-model' } as any;
      },
      { scopes: ['chat'] },
    );

    expect(calledProvider.config.baseUrl).toBe('https://account-b.test');
    expect(response.provider).toBe('openai');
    expect(state.cacheKeys[0].providerAccountId).toBe('account-b');
  });

  it('advances to the next healthy account for a transient upstream failure', async () => {
    const tried: string[] = [];
    registry.getAccountPool()!.resolveAccounts = new ProviderAccountPool(async () => [
      binding('account-a', 'https://account-a.test'),
      binding('account-b', 'https://account-b.test'),
    ], async () => 0).resolveAccounts;
    await execute(
      'chat',
      { provider: 'openai', model: 'test-model', prompt: 'hello', cache: false },
      async (provider) => {
        tried.push((provider as any).config.baseUrl);
        if (tried.length === 1) throw Object.assign(new Error('temporary'), { statusCode: 503 });
        return { result: { text: 'ok' }, model: 'test-model' } as any;
      },
      { scopes: ['chat'] },
    );

    expect(tried).toEqual(['https://account-a.test', 'https://account-b.test']);
  });

  it('does not switch accounts after authentication or validation errors', async () => {
    const tried: string[] = [];
    await expect(execute(
      'chat',
      { provider: 'openai', model: 'test-model', prompt: 'hello', cache: false },
      async (provider) => {
        tried.push((provider as any).config.baseUrl);
        throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      },
      { scopes: ['chat'] },
    )).rejects.toMatchObject({ statusCode: 401 });

    expect(tried).toEqual(['https://account-a.test']);
  });

  it('accepts the text scope for account-backed chat routes', async () => {
    const response = await execute(
      'chat',
      { provider: 'openai', providerAccountId: 'account-a', prompt: 'hello', cache: false },
      async () => ({ result: { text: 'ok' }, model: 'test-model' }) as any,
      { scopes: ['text'] },
    );
    expect(response.success).toBe(true);
  });

  it('isolates automatic cache and in-flight keys by the actual selected account', async () => {
    let cursor = 0;
    registry.setAccountPool(new ProviderAccountPool(async () => [
      binding('account-a', 'https://account-a.test'),
      binding('account-b', 'https://account-b.test'),
    ], async () => cursor++));
    const call = async () => execute(
      'chat',
      { provider: 'openai', model: 'test-model', prompt: 'hello', cache: true },
      async () => ({ result: { text: 'ok' }, model: 'test-model' }) as any,
      { scopes: ['chat'] },
    );

    await call();
    await call();

    expect(state.cacheKeys.map((key) => key.providerAccountId)).toEqual(['account-a', 'account-b']);
  });
});
