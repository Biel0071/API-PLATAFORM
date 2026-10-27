import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from './ollama.provider';

describe('OllamaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checks health through model discovery without generating a token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }] })));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama:11434', defaultModel: 'qwen2.5:3b' });

    await expect(provider.health()).resolves.toMatchObject({ ok: true, modelCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://ollama:11434/api/tags');
  });

  it('uses a finite keep-alive for generation by default', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ response: 'ok', prompt_eval_count: 1, eval_count: 1 })));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama:11434' });

    await provider.generateText({ prompt: 'oi' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ keep_alive: '5m' });
  });
});
