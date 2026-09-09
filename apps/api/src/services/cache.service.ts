import { createHash } from 'crypto';
import { redis } from '../lib/redis';
import { ProviderResult } from '@api-platform/shared';
import { prisma } from '../lib/prisma';

class SimpleLRU<K, V> {
  private cache = new Map<K, { value: V; expiresAt: number }>();
  constructor(private max: number) {}
  clear() { this.cache.clear(); }
  get size() { return this.cache.size; }

  get(key: K): V | undefined {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key: K, value: V, ttlMs: number) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

export interface CacheKeyParams {
  model: string;
  messages?: any[];
  prompt?: string;
  temperature?: number;
  top_p?: number;
  tools?: any[];
  system?: string;
  tenant: string;
  input?: unknown;
}

export class CacheService {
  private l1Cache = new SimpleLRU<string, ProviderResult<any>>(500); // Max 500 items in L1

  /** L1 TTL em ms (30 segundos) */
  private L1_TTL = 30_000;
  
  /** L2 TTL em segundos (15 minutos) */
  private L2_TTL = 900;
  private epoch = '';

  private async syncEpoch() {
    const epoch = await redis.get('cache:epoch') || '0';
    if (epoch !== this.epoch) { this.l1Cache.clear(); this.epoch = epoch; }
    return epoch;
  }

  private async cacheKeys(): Promise<string[]> {
    let cursor = '0';
    const keys = new Set<string>();
    do {
      const result = await redis.scan(cursor, 'MATCH', 'cache:*', 'COUNT', 500);
      cursor = result[0];
      for (const key of result[1]) if (/^cache:(?:v\d+:)?[a-f0-9]{64}$/.test(key)) keys.add(key);
    } while (cursor !== '0');
    return [...keys];
  }

  async stats() {
    const [keys, entries, usage] = await Promise.all([
      this.cacheKeys(), prisma.cacheEntry.count(), prisma.usage.aggregate({ _sum: { cachedHits: true } }),
    ]);
    return { entries, redisKeys: keys.length, totalHits: usage._sum.cachedHits || 0, localEntries: this.l1Cache.size };
  }

  async clear() {
    await redis.incr('cache:epoch');
    this.l1Cache.clear();
    const keys = await this.cacheKeys();
    for (let i = 0; i < keys.length; i += 500) await redis.unlink(...keys.slice(i, i + 500));
    const persisted = await prisma.cacheEntry.deleteMany();
    return { redis: keys.length, persisted: persisted.count };
  }

  generateKey(params: CacheKeyParams): string {
    // Fingerprint semântico
    const normalizedMessages = (params.messages || []).map(m => {
      if (typeof m.content === 'string') {
        return {
          ...m,
          content: m.content
        };
      }
      return m;
    });

    const payload = JSON.stringify({
      model: params.model,
      messages: normalizedMessages,
      prompt: params.prompt,
      temperature: params.temperature,
      top_p: params.top_p,
      tools: params.tools,
      system: params.system,
      tenant: params.tenant,
      input: params.input,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  async get(key: string): Promise<{ hit: 'L1' | 'L2' | 'MISS', data?: ProviderResult<any> }> {
    try {
      const epoch = await this.syncEpoch();
      const l1 = this.l1Cache.get(key);
      if (l1) return { hit: 'L1', data: l1 };
      const l2 = await redis.get(`cache:v${epoch}:${key}`);
      if (l2) {
        const parsed = JSON.parse(l2);
        // Repopulate L1
        this.l1Cache.set(key, parsed, this.L1_TTL);
        return { hit: 'L2', data: parsed };
      }
    } catch (err) {
      console.warn('[Cache L2] Error reading from redis', err);
    }

    return { hit: 'MISS' };
  }

  async set(key: string, data: ProviderResult<any>): Promise<void> {
    // Save to L2
    try {
      const epoch = await this.syncEpoch();
      await redis.set(`cache:v${epoch}:${key}`, JSON.stringify(data), 'EX', this.L2_TTL);
      this.l1Cache.set(key, data, this.L1_TTL);
    } catch (err) {
      console.warn('[Cache L2] Error writing to redis', err);
    }
  }
}

export const cacheService = new CacheService();
