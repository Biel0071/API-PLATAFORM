import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ resolved: [] as string[], legacyAccountProviderCalls: 0, otherCalls: 0 }));
const otherProvider = {
  name: 'other', config: {},
  chat: vi.fn(async () => { state.otherCalls++; return { result: { text: 'fallback provider' }, model: 'other-model' }; }),
};
const pool = { hasConfiguredAccounts: vi.fn(async (name: string) => name === 'acct') };
vi.mock('../src/services/cache.service', () => ({ cacheService: { generateKey: () => 'cache', get: async () => ({ hit: 'MISS' }) } }));
vi.mock('../src/services/complexity.analyzer', () => ({ ComplexityAnalyzer: { analyze: () => ({ requiresVision: false }) } }));
vi.mock('../src/services/intent.classifier', () => ({ FastIntentClassifier: { classify: () => ({ mode: 'STANDARD', confidence: 1 }) } }));
vi.mock('../src/services/dispatcher.service', () => ({ ExecutionDispatcher: { dispatch: () => ({ transport: 'DIRECT' }) } }));
vi.mock('../src/services/smart-router.service', () => ({ smartRouterService: {
  route: vi.fn(async () => { throw Object.assign(new Error('transient'), { statusCode: 503 }); }),
  executeWithSmartFallback: vi.fn(),
} }));
vi.mock('../src/services/ai.service', () => ({
  registry: {
    getAccountPool: () => pool,
    resolve: async (_capability: string, name: string) => {
      state.resolved.push(name);
      if (name === 'acct') { state.legacyAccountProviderCalls++; return { name: 'acct' }; }
      return otherProvider;
    },
    has: () => false,
  },
  providerCircuit: { isOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn() },
  fallbackOrder: ['acct', 'other'],
}));
vi.mock('@api-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@api-platform/shared')>();
  return { ...actual, getModelTraits: () => ({ maxContextTokens: 8192 }), compressContext: (messages: any) => ({ compressedMessages: messages, compressedSystem: undefined }) };
});

import { DirectExecutor } from '../src/services/execution-gateway.service';

describe('ExecutionGateway account-backed fallback', () => {
  beforeEach(() => {
    state.resolved = [];
    state.legacyAccountProviderCalls = 0;
    state.otherCalls = 0;
  });

  it('skips legacy credentials for an account-backed provider and still tries another provider', async () => {
    const response = await new DirectExecutor().execute({ tenant: 'tenant', executionId: 'exec', traceId: 'trace', metadata: {} } as any, {
      model: 'acct/model', messages: [{ role: 'user', content: 'hello' }],
    });

    expect(state.resolved).not.toContain('acct');
    expect(state.legacyAccountProviderCalls).toBe(0);
    expect(state.otherCalls).toBe(1);
    expect(response.result).toMatchObject({ text: 'fallback provider' });
  });
});
