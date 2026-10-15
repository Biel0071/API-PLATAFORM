import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: { generation: 'before-mutation' },
  readCount: 0,
  firstReadGate: undefined as Promise<void> | undefined,
}));

vi.mock('@api-platform/shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('@api-platform/shared')>(),
  createRegistryFromEnv: vi.fn((config) => ({ config })),
  ProviderCircuitBreaker: class {},
  ProviderAccountPool: class {},
}));
vi.mock('../src/lib/redis', () => ({ redis: { incr: vi.fn() } }));
vi.mock('../src/services/provider-account-runtime.service', () => ({
  loadProviderAccountRuntime: vi.fn(async (registry) => ({ registry, pool: {} })),
}));
vi.mock('../src/services/cache.service', () => ({ cacheService: {} }));
vi.mock('../src/services/usage.service', () => ({ usageService: {} }));
vi.mock('../src/metrics', () => ({ metrics: {} }));
vi.mock('../src/lib/logger', () => ({ logger: {} }));
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));
vi.mock('../src/services/provider-config.service', () => ({
  buildProviderEnv: vi.fn(async () => {
    const snapshot = { ...state.config };
    state.readCount++;
    if (state.readCount === 1 && state.firstReadGate) await state.firstReadGate;
    return snapshot;
  }),
}));
vi.mock('../src/services/execution-memory.service', () => ({
  recallExecutionRoute: vi.fn(),
  rememberExecutionSuccess: vi.fn(),
}));

import { registry, reloadRegistry, reloadRegistryAfterMutation } from '../src/services/ai.service';

describe('provider registry reload after credential mutation', () => {
  beforeEach(() => {
    state.config = { generation: 'before-mutation' };
    state.readCount = 0;
    state.firstReadGate = undefined;
  });

  it('performs a fresh read when an older reload is already in flight', async () => {
    let finishFirstRead!: () => void;
    state.firstReadGate = new Promise<void>((resolve) => {
      finishFirstRead = resolve;
    });

    const oldReload = reloadRegistry();
    expect(state.readCount).toBe(1);

    state.config = { generation: 'after-mutation' };
    const mutationReload = reloadRegistryAfterMutation();
    finishFirstRead();

    await Promise.all([oldReload, mutationReload]);

    expect(state.readCount).toBe(2);
    expect(registry).toEqual({ config: { generation: 'after-mutation' } });
  });
});
