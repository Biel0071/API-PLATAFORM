import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountPool, ProviderRegistry } from '@api-platform/shared';

const state = vi.hoisted(() => ({ bullData: undefined as any, providerConfig: undefined as any, createdId: 'job-1' }));
vi.mock('bullmq', () => ({
  Queue: class {
    async add(_name: string, data: any) { state.bullData = structuredClone(data); return { id: 'job-1' }; }
    async getJob() { return undefined; }
    async close() {}
    async getJobCounts() { return {}; }
  },
  QueueEvents: class { async close() {} },
}));
vi.mock('../src/config/env', () => ({ env: { QUEUE_PREFIX: 'test', JOB_WAIT_TIMEOUT_MS: 100, WORKER_CONCURRENCY: 1 } }));
vi.mock('../src/lib/redis', () => ({ createBullConnection: () => ({}) }));
vi.mock('../src/lib/prisma', () => ({ prisma: {
  job: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: state.createdId })),
    update: vi.fn(async () => undefined),
  },
  $transaction: async (operation: any) => operation({
    $executeRaw: async () => undefined,
    job: { findFirst: async () => null, create: async () => ({ id: state.createdId }) },
  }),
} }));

const providerCalls = vi.hoisted(() => ({ accountA: 0, accountB: 0, upstreamSelector: undefined as unknown }));
const providerB = {
  name: 'local-image', capabilities: ['image'],
  generateImage: async (input: any) => {
    providerCalls.accountB++;
    providerCalls.upstreamSelector = input.providerAccountId;
    return { result: { images: [{ url: 'https://result.invalid/image.png' }] }, model: 'test-image' };
  },
};
const registry = new ProviderRegistry();
registry.register({ name: 'local-image', capabilities: ['image'], generateImage: async () => ({ result: { images: [] }, model: 'legacy' }) } as any);
const pool = new ProviderAccountPool(async () => [
  { accountId: 'account-a', providerName: 'local-image', provider: { ...providerB, generateImage: async () => { providerCalls.accountA++; return { result: { images: [] }, model: 'a' }; } } as any, enabled: true, healthOk: true, healthCheckedAt: new Date() },
  { accountId: 'account-b', providerName: 'local-image', provider: providerB as any, enabled: true, healthOk: true, healthCheckedAt: new Date() },
], async () => 0);
registry.setAccountPool(pool);
vi.mock('../src/services/ai.service', () => ({ registry, providerAccountPool: pool }));

import { enqueue } from '../src/services/queue.service';
import { imageProcessor } from '../../worker/src/processors';

describe('provider account enqueue-to-worker handoff', () => {
  beforeEach(() => {
    state.bullData = undefined;
    providerCalls.accountA = 0;
    providerCalls.accountB = 0;
    providerCalls.upstreamSelector = undefined;
  });

  it('preserves account/correlation in the job and invokes only that worker account', async () => {
    await enqueue('image', { prompt: 'render', providerAccountId: 'account-b', cache: false }, {
      tenantId: 'tenant-a', scopes: ['image'], correlationId: 'correlation-1',
    });

    expect(state.bullData).toMatchObject({ provider: 'local-image', providerAccountId: 'account-b', __correlationId: 'correlation-1' });
    const result = await imageProcessor({ id: 'job-1', data: state.bullData } as any, registry);

    expect(providerCalls.accountA).toBe(0);
    expect(providerCalls.accountB).toBe(1);
    expect(providerCalls.upstreamSelector).toBeUndefined();
    expect(result.provider).toBe('local-image');
  });
});
