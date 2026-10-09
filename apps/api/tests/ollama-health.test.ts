import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../../packages/shared/src/providers/ollama.provider';

afterEach(() => vi.unstubAllGlobals());

describe('Ollama provider health', () => {
  it('checks reachability and configured model without starting inference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'qwen2.5:0.5b', size: 500_000_000 }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider({ baseUrl: 'http://ollama:11434', defaultModel: 'qwen2.5:0.5b' });
    await expect(provider.health()).resolves.toMatchObject({ ok: true, modelCount: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://ollama:11434/api/tags');
  });

  it('reports unavailable when the configured model is not installed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 })));

    const provider = new OllamaProvider({ baseUrl: 'http://ollama:11434', defaultModel: 'missing-model' });
    await expect(provider.health()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('not found') });
  });
});
