import { describe, expect, it } from 'vitest';
import { buildProviderCascade } from '../src/services/provider-routing.service';

describe('provider routing defaults', () => {
  const fallbackOrder = ['groq', 'openrouter', 'ollama'];
  const providers = new Set(['openai', 'anthropic', ...fallbackOrder]);
  const options = {
    fallbackOrder,
    hasProvider: (name: string) => providers.has(name),
  };

  it('uses the configured API Platform chat provider when the request selects auto', () => {
    expect(buildProviderCascade({ ...options, defaultProvider: 'openai', model: 'auto' }))
      .toEqual(['openai', 'groq', 'openrouter', 'ollama']);
  });

  it('puts an explicitly requested provider first while retaining configured fallbacks', () => {
    expect(buildProviderCascade({ ...options, defaultProvider: 'openai', requestedProvider: 'anthropic', model: 'auto' }))
      .toEqual(['anthropic', 'groq', 'openrouter', 'ollama']);
  });

  it('infers the provider family for a namespaced or recognizable model', () => {
    expect(buildProviderCascade({ ...options, defaultProvider: 'groq', model: 'openai/gpt-4.1-mini' })[0]).toBe('openai');
    expect(buildProviderCascade({ ...options, defaultProvider: 'groq', model: 'claude-sonnet-test' })[0]).toBe('anthropic');
  });
});
