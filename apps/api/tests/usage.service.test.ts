import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  modelConfig: { findFirst: vi.fn(async () => ({ costPer1kInput: 2, costPer1kOutput: 4 })) },
  requestLog: { create: vi.fn(async () => undefined) },
  usage: { upsert: vi.fn(async () => undefined) },
}));

vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/lib/logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { UsageService } from '../src/services/usage.service';

describe('usage persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.modelConfig.findFirst.mockResolvedValue({ costPer1kInput: 2, costPer1kOutput: 4 });
  });

  it('records provider-reported tokens as observed usage', async () => {
    const service = new UsageService();
    service.record({ tenantId: 'tenant-a', capability: 'chat', provider: 'ollama', model: 'qwen', cached: false, success: true, durationMs: 477, tokens: { prompt: 100, completion: 20, total: 120 } });
    await vi.waitFor(() => expect(db.requestLog.create).toHaveBeenCalledOnce());

    expect(db.requestLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tokenUsageSource: 'observed', totalTokens: 120 }) }));
    expect(db.usage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ observedTokens: 120n, observedTokenRequests: 1, estimatedTokens: 0n, estimatedTokenRequests: 0 }),
      update: expect.objectContaining({ observedTokens: { increment: 120n }, observedTokenRequests: { increment: 1 }, estimatedTokens: { increment: 0n }, estimatedTokenRequests: { increment: 0 } }),
    }));
  });

  it('separates internal estimates and missing usage from provider-reported tokens', async () => {
    const service = new UsageService();
    service.record({ tenantId: 'tenant-a', capability: 'chat', provider: 'laya', model: 'internal', cached: false, success: true, durationMs: 2, tokens: { prompt: 100, completion: 20, total: 120 } });
    await vi.waitFor(() => expect(db.requestLog.create).toHaveBeenCalledOnce());
    expect(db.requestLog.create.mock.calls[0][0].data.tokenUsageSource).toBe('estimated');
    expect(db.usage.upsert.mock.calls[0][0].create).toMatchObject({ observedTokens: 0n, observedTokenRequests: 0, estimatedTokens: 120n, estimatedTokenRequests: 1 });

    db.requestLog.create.mockClear();
    db.usage.upsert.mockClear();
    const second = new UsageService();
    second.record({ tenantId: 'tenant-a', capability: 'chat', provider: 'openai', model: 'unknown', cached: false, success: true, durationMs: 2 });
    await vi.waitFor(() => expect(db.requestLog.create).toHaveBeenCalledOnce());
    expect(db.requestLog.create.mock.calls[0][0].data.tokenUsageSource).toBe('unknown');
    expect(db.usage.upsert.mock.calls[0][0].create).toMatchObject({ observedTokens: 0n, observedTokenRequests: 0, estimatedTokens: 0n, estimatedTokenRequests: 0 });
  });
});
