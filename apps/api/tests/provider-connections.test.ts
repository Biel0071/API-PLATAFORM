import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: new Map<string, any>() }));
vi.mock('../src/lib/prisma', () => {
  const database: any = {
    providerConfig: {
      findUnique: vi.fn(async ({ where }) => state.rows.get(where.name) || null),
      findMany: vi.fn(async () => [...state.rows.values()]),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = state.rows.has(where.name)
          ? { ...state.rows.get(where.name), ...update }
          : { id: `provider-${where.name}`, ...create };
        state.rows.set(where.name, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = { ...state.rows.get(where.name), ...data };
        state.rows.set(where.name, row);
        return row;
      }),
    },
    providerAccount: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }) => create),
    },
    $transaction: vi.fn(async (operation) =>
      typeof operation === 'function' ? operation(database) : Promise.all(operation),
    ),
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return { prisma: database };
});
vi.mock('../src/services/ai.service', () => ({
  execute: vi.fn(),
  registry: { list: () => [] },
  reloadRegistry: vi.fn(async () => ({ has: () => true })),
  reloadRegistryAfterMutation: vi.fn(async () => ({ has: () => true })),
}));
import {
  saveProviderConfig,
  listProviderConfigs,
  buildProviderEnv,
} from '../src/services/provider-config.service';
import { providersRoutes } from '../src/routes/admin/providers';
import { reloadRegistryAfterMutation } from '../src/services/ai.service';

beforeEach(() => {
  state.rows.clear();
  vi.mocked(reloadRegistryAfterMutation).mockClear();
});

describe('provider account configuration', () => {
  it.each(['openai', 'anthropic', 'xai'])('accepts %s from the connection dialog', async (name) => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.user = { sub: 'provider-ui-test' } as typeof request.user;
    });
    await providersRoutes(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/provider-configs',
        payload: { name, apiKey: 'test-only-secret', defaultChat: true },
      });
      expect(response.statusCode).toBe(200);
      expect(state.rows.get(name)?.settings.defaultChat).toBe(true);
      expect(reloadRegistryAfterMutation).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('encrypts a new key, retains it on blank edit and never exposes it in the listing', async () => {
    await saveProviderConfig({ name: 'openai', enabled: true, apiKey: 'test-only-secret' });
    const encrypted = state.rows.get('openai').settings.apiKeyEncrypted;
    expect(encrypted).not.toContain('test-only-secret');
    await saveProviderConfig({
      name: 'openai',
      enabled: true,
      apiKey: '',
      defaultModel: 'chosen-model',
    });
    expect(state.rows.get('openai').settings.apiKeyEncrypted).toBe(encrypted);
    const configs = await listProviderConfigs();
    expect(configs[0].hasApiKey).toBe(true);
    expect(JSON.stringify(configs)).not.toContain(encrypted);
    expect(JSON.stringify(configs)).not.toContain('test-only-secret');
  });

  it('uses one selected default and maps Anthropic and xAI credentials to their adapters', async () => {
    await saveProviderConfig({
      name: 'anthropic',
      enabled: true,
      defaultChat: true,
      apiKey: 'test-anthropic',
      defaultModel: 'chosen-claude',
    });
    await saveProviderConfig({
      name: 'xai',
      enabled: true,
      defaultChat: true,
      apiKey: 'test-xai',
      defaultModel: 'chosen-grok',
    });
    const env = await buildProviderEnv({});
    expect(state.rows.get('anthropic').settings.defaultChat).toBe(false);
    expect(env).toMatchObject({
      DEFAULT_CHAT_PROVIDER: 'xai',
      ANTHROPIC_API_KEY: 'test-anthropic',
      CLAUDE_DEFAULT_MODEL: 'chosen-claude',
      GROK_API_KEY: 'test-xai',
      GROK_DEFAULT_MODEL: 'chosen-grok',
    });
  });

  it('does not reactivate a disabled provider from environment credentials', async () => {
    await saveProviderConfig({ name: 'openai', enabled: false, defaultChat: true });
    const env = await buildProviderEnv({
      OPENAI_API_KEY: 'test-env-key',
      DEFAULT_CHAT_PROVIDER: 'openai',
      PRESERVED_SETTING: 'unchanged',
    });
    expect(env.PRESERVED_SETTING).toBe('unchanged');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEFAULT_CHAT_PROVIDER).toBeUndefined();
  });
});
