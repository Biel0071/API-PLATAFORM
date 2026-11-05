import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayaProvider } from '@api-platform/shared';

describe('LayaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the multilingual model for typed route decisions without generating a reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: 'laya-multilingual',
        answers: { route: { choice: 'coding', answer_confidence: 0.93 } },
        usage: { input_tokens: 22, output_tokens: 1 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LayaProvider({ baseUrl: 'http://laya-engine:8000' });
    const result = await provider.decision({ prompt: 'Escreva uma função TypeScript.' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://laya-engine:8000/v1/systemone',
      expect.objectContaining({ method: 'POST' }),
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.state).toBe('Escreva uma função TypeScript.');
    expect(requestBody.questions.route.type).toBe('choice');
    expect(requestBody.model).toBe('multilingual');
    expect(result.model).toBe('laya-multilingual');
    expect(result.result).toMatchObject({
      decision: 'coding',
      selectedModel: 'qwen2.5-coder:1.5b',
      selectedProvider: 'ollama',
      confidence: 0.93,
      needsBackground: false,
      metadata: { engine: 'laya-multilingual', source: 'model' },
    });
    expect(result.result.fastResponse).toBeUndefined();
    expect(result.tokens).toEqual({ prompt: 22, completion: 1, total: 23 });
  });

  it('reports the model unavailable when no local engine is configured', async () => {
    const provider = new LayaProvider();

    await expect(provider.decision({ prompt: 'Olá' })).rejects.toMatchObject({
      code: 'LAYA_ENGINE_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it.each(['Olá, como vai?', 'Hello, how are you?'])(
    'sends %s to the multilingual classifier without requiring a reply', async (prompt) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'multilingual',
          answers: { route: { choice: 'standard', answer_confidence: 0.8 } },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await new LayaProvider({ baseUrl: 'http://laya-engine:8000' }).decision({ prompt });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
        model: 'multilingual', state: prompt,
      });
    },
  );

  it('rejects unknown model labels instead of inventing a route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers: { route: { choice: 'unknown', answer_confidence: 0.6 } } }),
    }));

    const provider = new LayaProvider({ baseUrl: 'http://laya-engine:8000' });
    await expect(provider.decision({ prompt: 'Olá' })).rejects.toMatchObject({
      code: 'LAYA_INVALID_RESPONSE',
      statusCode: 502,
    });
  });
});
