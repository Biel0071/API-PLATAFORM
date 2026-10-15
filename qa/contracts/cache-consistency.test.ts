import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('../../apps/api/src/lib/redis', () => ({ redis: {
  get: vi.fn(async (key: string) => state.values.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => state.values.set(key, value)),
  incr: vi.fn(async (key: string) => { const next = Number(state.values.get(key) || 0) + 1; state.values.set(key, String(next)); return next; }),
  scan: vi.fn(async () => ['0', [...state.values.keys()]]),
  unlink: vi.fn(async (...keys: string[]) => keys.forEach(key => state.values.delete(key))),
} }));
vi.mock('../../apps/api/src/lib/prisma', () => ({ prisma: {
  cacheEntry: { count: vi.fn(async () => 0), deleteMany: vi.fn(async () => ({ count: 0 })) },
  usage: { aggregate: vi.fn(async () => ({ _sum: { cachedHits: 7 } })) },
} }));
import { CacheService } from '../../apps/api/src/services/cache.service';

describe('Standalone cache contracts', () => {
  beforeEach(() => state.values.clear());
  it('isolates tenants, case-sensitive input and generation options', () => {
    const cache = new CacheService();
    const base = { model: 'local', tenant: 'one', prompt: 'Code ABC' };
    const keys = [base, { ...base, tenant: 'two' }, { ...base, prompt: 'Code abc' }, { ...base, input: { temperature: 0.8 } }].map(input => cache.generateKey(input));
    expect(new Set(keys).size).toBe(4);
  });
  it('isolates otherwise identical calls pinned to different provider accounts', () => {
    const cache = new CacheService();
    const base = { model: 'local', tenant: 'one', prompt: 'hello' };
    expect(cache.generateKey({ ...base, providerAccountId: 'account-a' }))
      .not.toBe(cache.generateKey({ ...base, providerAccountId: 'account-b' }));
  });
  it('clears response entries and invalidates another process L1 without deleting jobs or auth', async () => {
    const first = new CacheService();
    const second = new CacheService();
    const key = first.generateKey({ model: 'local', tenant: 'one' });
    await first.set(key, { result: { text: 'real response' } } as any);
    expect((await second.get(key)).hit).toBe('L2');
    state.values.set('bull:queue:job', 'keep');
    state.values.set('apiplatform:apikey:key', 'keep');
    await first.clear();
    expect((await second.get(key)).hit).toBe('MISS');
    expect(state.values.get('bull:queue:job')).toBe('keep');
    expect(state.values.get('apiplatform:apikey:key')).toBe('keep');
    expect((await first.stats()).totalHits).toBe(7);
  });
});
