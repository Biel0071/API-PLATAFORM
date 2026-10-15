import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderAccountPool, ProviderAccountBinding } from '@api-platform/shared';
import { registry, providerCircuit } from '../src/services/ai.service';
import { SmartRouterService } from '../src/services/smart-router.service';

function provider(name: string, call: () => Promise<any>) {
  return { name: 'openai', capabilities: ['chat'], chat: call } as any;
}

function decision(accountId?: string): any {
  const primary = {
    provider: 'openai', model: 'gpt-test', score: 1, latencyMs: 1,
    reason: 'test', capabilities: ['chat'], pool: 'GENERAL', providerAccountId: accountId,
  };
  return { primary, fallbackChain: [], pool: 'GENERAL', requiredCapabilities: ['chat'], taskType: 'chat', complexityScore: 1 };
}

describe('smart router account circuit isolation', () => {
  beforeEach(() => {
    providerCircuit.recordSuccess('openai:chat');
    providerCircuit.recordSuccess('openai:chat:account-a');
    providerCircuit.recordSuccess('openai:chat:account-b');
  });

  it('continues to account B after a transient failure on account A', async () => {
    const calls: string[] = [];
    const accounts: ProviderAccountBinding[] = [
      { accountId: 'account-a', providerName: 'openai', provider: provider('openai', async () => { calls.push('a'); throw Object.assign(new Error('upstream secret response'), { statusCode: 503 }); }), enabled: true, healthOk: true, healthCheckedAt: new Date() },
      { accountId: 'account-b', providerName: 'openai', provider: provider('openai', async () => { calls.push('b'); return { result: { text: 'ok' }, model: 'gpt-test' }; }), enabled: true, healthOk: true, healthCheckedAt: new Date() },
    ];
    registry.register(provider('openai', async () => ({ result: {}, model: 'legacy' })));
    registry.setAccountPool(new ProviderAccountPool(async () => accounts, async () => 0));

    const result = await new SmartRouterService().executeWithSmartFallback({ prompt: 'hello' }, decision());

    expect(calls).toEqual(['a', 'b']);
    expect(result.selectedCandidate.providerAccountId).toBe('account-b');
    expect(result.attempts[0].error).toMatch(/503/);
    expect(result.attempts[0].error).not.toContain('upstream secret');
  });

  it('does not bypass a pinned account whose circuit is open', async () => {
    let called = false;
    const accounts: ProviderAccountBinding[] = [
      { accountId: 'account-a', providerName: 'openai', provider: provider('openai', async () => { called = true; return { result: {}, model: 'gpt-test' }; }), enabled: true, healthOk: true, healthCheckedAt: new Date() },
      { accountId: 'account-b', providerName: 'openai', provider: provider('openai', async () => { called = true; return { result: {}, model: 'gpt-test' }; }), enabled: true, healthOk: true, healthCheckedAt: new Date() },
    ];
    registry.register(provider('openai', async () => ({ result: {}, model: 'legacy' })));
    registry.setAccountPool(new ProviderAccountPool(async () => accounts, async () => 0));
    providerCircuit.recordFailure('openai:chat:account-a');
    providerCircuit.recordFailure('openai:chat:account-a');

    await expect(new SmartRouterService().executeWithSmartFallback({ prompt: 'hello' }, decision('account-a'))).rejects.toThrow();
    expect(called).toBe(false);
  });
});
