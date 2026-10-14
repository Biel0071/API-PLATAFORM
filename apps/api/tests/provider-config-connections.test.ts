import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ rows: [] as any[] }));

vi.mock('../src/lib/prisma', () => ({
  prisma: {
    providerConfig: {
      findUnique: vi.fn(async ({ where }: any) => database.rows.find((row) => row.name === where.name) ?? null),
      findMany: vi.fn(async ({ where }: any = {}) => database.rows.filter((row) => !where?.enabled || row.enabled)),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const index = database.rows.findIndex((row) => row.name === where.name);
        if (index < 0) database.rows.push(create);
        else database.rows[index] = { ...database.rows[index], ...update };
        return database.rows[index < 0 ? database.rows.length - 1 : index];
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = database.rows.findIndex((row) => row.name === where.name);
        database.rows[index] = { ...database.rows[index], ...data };
        return database.rows[index];
      }),
    },
    $transaction: vi.fn(async (operations: any[]) => Promise.all(operations)),
    auditLog: { create: vi.fn(async () => undefined) },
  },
}));

vi.mock('../src/config/env', () => ({ env: { JWT_SECRET: 'provider-config-test-secret', LOG_LEVEL: 'silent', NODE_ENV: 'test' } }));
vi.mock('../src/lib/logger', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));
vi.mock('../src/services/ai.service', () => ({
  execute: vi.fn(),
  registry: { list: () => [], getDefaults: () => ({}), has: () => true, get: () => ({ health: async () => ({ ok: true }) }) },
  reloadRegistry: vi.fn(async () => ({ has: () => true })),
}));

import { providersRoutes } from '../src/routes/admin/providers';
import { buildProviderEnv, listProviderConfigs, saveProviderConfig } from '../src/services/provider-config.service';
import { execute } from '../src/services/ai.service';

afterEach(() => {
  database.rows.length = 0;
  vi.clearAllMocks();
});

describe('API Platform provider connections', () => {
  it('accepts OpenAI, Anthropic and xAI connection records through the admin API', async () => {
    const handlers = new Map<string, (request: any) => Promise<unknown>>();
    const secured = {
      get: () => undefined,
      post: (path: string, _options: unknown, handler: (request: any) => Promise<unknown>) => handlers.set(path, handler),
    };
    await providersRoutes(secured as any);
    const save = handlers.get('/provider-configs');
    expect(save).toBeTypeOf('function');

    for (const name of ['openai', 'anthropic', 'xai']) {
      await expect(save!({
        body: { name, enabled: true, apiKey: `${name}-credential`, defaultModel: `${name}-model` },
        user: { sub: 'admin-user' },
      })).resolves.toMatchObject({ success: true, registered: true });
    }
  });

  it('caps the live provider inference test at a short response size', async () => {
    const handlers = new Map<string, (request: any) => Promise<unknown>>();
    const secured = {
      get: () => undefined,
      post: (path: string, _options: unknown, handler: (request: any) => Promise<unknown>) => handlers.set(path, handler),
    };
    await providersRoutes(secured as any);
    const testText = handlers.get('/test-text');
    expect(testText).toBeTypeOf('function');
    vi.mocked(execute).mockResolvedValue({ success: true } as any);

    await testText!({ body: { prompt: 'Responda apenas: conexão ativa.' }, user: { sub: 'admin-user' } });

    expect(execute).toHaveBeenCalledWith('chat', expect.objectContaining({
      prompt: 'Responda apenas: conexão ativa.',
      maxTokens: 16,
    }), expect.any(Function), { cache: false });
  });

  it('loads encrypted provider keys into the runtime with the provider-specific model names', async () => {
    await saveProviderConfig({ name: 'openai', enabled: true, apiKey: 'openai-secret-for-test', defaultModel: 'gpt-4.1-mini' });
    await saveProviderConfig({ name: 'anthropic', enabled: true, apiKey: 'anthropic-secret-for-test', defaultModel: 'claude-sonnet-test' });
    await saveProviderConfig({ name: 'xai', enabled: true, apiKey: 'xai-secret-for-test', defaultModel: 'grok-test' });

    const runtimeEnv = await buildProviderEnv();
    expect(runtimeEnv.OPENAI_API_KEY).toBe('openai-secret-for-test');
    expect(runtimeEnv.OPENAI_DEFAULT_MODEL).toBe('gpt-4.1-mini');
    expect(runtimeEnv.ANTHROPIC_API_KEY).toBe('anthropic-secret-for-test');
    expect(runtimeEnv.CLAUDE_DEFAULT_MODEL).toBe('claude-sonnet-test');
    expect(runtimeEnv.GROK_API_KEY).toBe('xai-secret-for-test');
    expect(runtimeEnv.GROK_DEFAULT_MODEL).toBe('grok-test');

    const publicConfigs = await listProviderConfigs();
    const serialized = JSON.stringify(publicConfigs);
    expect(serialized).not.toContain('openai-secret-for-test');
    expect(serialized).not.toContain('anthropic-secret-for-test');
    expect(serialized).not.toContain('xai-secret-for-test');
    expect(publicConfigs.every((config: any) => config.hasApiKey)).toBe(true);
  });

  it('removes an explicitly disabled provider from environment defaults', async () => {
    await saveProviderConfig({ name: 'openai', enabled: false });
    const runtimeEnv = await buildProviderEnv({ OPENAI_API_KEY: 'environment-key', OPENAI_DEFAULT_MODEL: 'gpt-env' });
    expect(runtimeEnv.OPENAI_API_KEY).toBeUndefined();
    expect(runtimeEnv.OPENAI_DEFAULT_MODEL).toBeUndefined();
  });

  it('keeps exactly one selected provider as the API Platform chat default', async () => {
    await saveProviderConfig({ name: 'groq', enabled: true, defaultChat: true });
    await saveProviderConfig({ name: 'openai', enabled: true, defaultChat: true });

    const runtimeEnv = await buildProviderEnv({ DEFAULT_CHAT_PROVIDER: 'ollama' });
    expect(runtimeEnv.DEFAULT_CHAT_PROVIDER).toBe('openai');
    expect((database.rows.find((row) => row.name === 'groq')!.settings as any).defaultChat).toBe(false);
  });
});
