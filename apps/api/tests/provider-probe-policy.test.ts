import { afterEach, describe, expect, it, vi } from 'vitest';

describe('provider probe policy', () => {
  afterEach(() => vi.resetModules());

  it('excludes configured providers case-insensitively without excluding others', async () => {
    vi.stubEnv('PROVIDER_HEALTH_EXCLUDED_PROVIDERS', 'groq, custom-cloud');
    const { isProviderProbeExcluded } = await import('../src/services/provider-probe-policy');

    expect(isProviderProbeExcluded('Groq')).toBe(true);
    expect(isProviderProbeExcluded('custom-cloud')).toBe(true);
    expect(isProviderProbeExcluded('ollama')).toBe(false);
  });

  it('does not call health for an excluded provider in the background worker', async () => {
    vi.stubEnv('PROVIDER_HEALTH_EXCLUDED_PROVIDERS', 'groq');
    const groqHealth = vi.fn(async () => ({ ok: true }));
    const ollamaHealth = vi.fn(async () => ({ ok: true }));
    vi.doMock('../src/services/ai.service', () => ({
      registry: {
        list: () => [
          { name: 'groq', health: groqHealth },
          { name: 'ollama', health: ollamaHealth },
        ],
      },
    }));
    vi.doMock('../src/services/provider-account-runtime.service', () => ({
      refreshConfiguredProviderAccountHealth: vi.fn(async () => new Set()),
    }));

    const { refreshProviderHealth, providerHealthState } = await import('../src/services/health-check.service');
    await refreshProviderHealth();

    expect(groqHealth).not.toHaveBeenCalled();
    expect(ollamaHealth).toHaveBeenCalledOnce();
    expect(providerHealthState.has('groq')).toBe(false);
  });
});
