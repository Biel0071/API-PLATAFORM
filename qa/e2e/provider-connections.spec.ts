import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Isolated UI contract fixtures. Real provider availability is checked separately.
let server: Server;
let host: string;
const dashboard = path.resolve(__dirname, '../../apps/dashboard/public');
test.use({
  channel: 'chrome',
  launchOptions: {
    args: [
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  },
});
const live = [
  {
    name: 'ollama',
    health: { ok: true, latencyMs: 8 },
    capabilities: ['chat', 'embedding'],
    models: [{ id: 'qwen2.5:3b' }],
  },
  {
    name: 'comfyui',
    health: { ok: false },
    capabilities: ['image'],
    models: [{ id: 'cached-model' }],
  },
];

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const file = path.resolve(dashboard, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(dashboard + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      const type = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      }[path.extname(file)];
      res.writeHead(200, { 'content-type': type || 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let accounts: any[];
let writes: any[];
let providerDefaults: Record<string, string>;
const makeAccount = (id: string, providerName: string, displayName: string) => ({
  id,
  providerName,
  displayName,
  authMode: providerName === 'ollama' ? 'local' : 'apiKey',
  enabled: true,
  hasCredential: providerName !== 'ollama',
  oauthNeedsReauth: false,
  baseUrl: providerName === 'ollama' ? 'http://ollama:11434' : null,
  defaultModel: 'existing-model',
  accountTier: 'free',
  health: { ok: null, checkedAt: null, latencyMs: null },
});
const usageWindow = {
  calls: 2,
  attempts: 3,
  totalTokens: 1500,
  promptTokens: 1000,
  completionTokens: 500,
  estimatedCost: 0.02,
  pricingConfigured: true,
  missingUsageAttempts: 0,
  missingPricingAttempts: 0,
  missingCostAttempts: 0,
};

test.beforeEach(async ({ page }) => {
  accounts = [
    makeAccount('groq-a', 'groq', 'Equipe A'),
    makeAccount('groq-b', 'groq', 'Equipe B'),
    makeAccount('local-a', 'ollama', 'GPU local'),
  ];
  writes = [];
  providerDefaults = { chat: 'ollama', image: 'comfyui' };
  await page.addInitScript(() => localStorage.setItem('apiplatform_token', 'ui-test-only'));
  await page.route('**/admin/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const body = route.request().postDataJSON();
    if (method !== 'GET') writes.push({ path: pathname, method, body });
    if (pathname === '/admin/providers')
      return route.fulfill({
        json: { success: true, providers: live, defaults: providerDefaults },
      });
    if (pathname === '/admin/provider-configs' && method === 'POST') {
      if (body.defaultChat) providerDefaults.chat = body.name;
      return route.fulfill({ json: { success: true, registered: true } });
    }
    if (pathname === '/admin/provider-configs')
      return route.fulfill({
        json: {
          success: true,
          registered: true,
          configs: [
            { name: 'groq', enabled: true, settings: {} },
            {
              name: 'ollama',
              enabled: true,
              settings: {
                defaultModel: 'qwen2.5:3b',
                embedModel: 'nomic-embed-text',
                defaultChat: true,
              },
            },
          ],
        },
      });
    if (pathname === '/admin/provider-oauth/options')
      return route.fulfill({
        json: {
          success: true,
          options: {
            huggingface: { oauth: { enabled: true } },
            gemini: { oauth: { enabled: true } },
          },
        },
      });
    if (pathname === '/admin/provider-accounts' && method === 'GET')
      return route.fulfill({ json: { success: true, accounts } });
    if (pathname === '/admin/provider-accounts' && method === 'POST') {
      const created = {
        ...makeAccount('created-' + accounts.length, body.providerName, body.displayName),
        ...body,
        ...body.settings,
        hasCredential: Boolean(body.apiKey),
        health: { ok: null, checkedAt: null, latencyMs: null },
      };
      delete created.apiKey;
      accounts.push(created);
      return route.fulfill({ status: 201, json: { success: true, account: created } });
    }
    const match = pathname.match(/^\/admin\/provider-accounts\/([^/]+)(.*)$/);
    if (match) {
      const selected = accounts.find((item) => item.id === match[1]);
      if (match[2] === '/usage')
        return route.fulfill({
          json: {
            success: true,
            usage: {
              accountId: match[1],
              asOf: new Date().toISOString(),
              last5h: usageWindow,
              last7d: {
                ...usageWindow,
                totalTokens: null,
                estimatedCost: null,
                pricingConfigured: false,
                missingUsageAttempts: 1,
                missingPricingAttempts: 1,
              },
            },
          },
        });
      if (method === 'PATCH') {
        Object.assign(selected, body, body.settings);
        return route.fulfill({ json: { success: true, account: selected } });
      }
      if (method === 'DELETE') {
        accounts = accounts.filter((item) => item.id !== match[1]);
        return route.fulfill({ json: { success: true } });
      }
      if (match[2] === '/test')
        return route.fulfill({ json: { success: true, health: { ok: true, latencyMs: 12 } } });
    }
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/v1/health', (route) =>
    route.fulfill({ json: { success: true, postgres: { ok: true }, redis: { ok: true } } }),
  );
  await page.goto(host + '/#/providers');
});

test('renders independent accounts and retains catalog and defaults', async ({ page }) => {
  await expect(page.locator('[data-provider-account="groq-a"]')).toContainText('Equipe A');
  await expect(page.locator('[data-provider-account="groq-b"]')).toContainText('Equipe B');
  await expect(page.locator('#p-defaults')).toContainText('Ollama');
  await expect(page.locator('[data-provider-card="openai"] img')).toBeVisible();
  await expect(page.locator('[data-connect-provider="groq"]')).toBeVisible();
  await expect(page.locator('[data-provider-account="local-a"]')).not.toContainText('Online');
});

test('colors measured connection latency and keeps stale measurements neutral', async ({ page }) => {
  const card = page.locator('[data-provider-account="local-a"]');
  accounts[2].health = { ok: true, checkedAt: new Date().toISOString(), latencyMs: 477 };
  await page.reload();
  await expect(card.locator('.provider-status')).toContainText('477');
  await expect(card.locator('.provider-status')).toHaveClass(/ok/);

  accounts[2].health = { ok: true, checkedAt: new Date().toISOString(), latencyMs: 1500 };
  await page.reload();
  await expect(card.locator('.provider-status')).toContainText('Lenta');
  await expect(card.locator('.provider-status')).toHaveClass(/warn/);

  accounts[2].health = { ok: true, checkedAt: new Date(Date.now() - 10 * 60_000).toISOString(), latencyMs: 477 };
  await page.reload();
  await expect(card.locator('.provider-status')).toContainText('desatualizada');
  await expect(card.locator('.provider-status')).toHaveClass(/muted/);
});

test('creates another account once without inheriting credentials or claiming online', async ({
  page,
}) => {
  await page.locator('[data-connect-provider="groq"]').click();
  await page.locator('#p-display-name').fill('Equipe C');
  await expect(page.locator('#p-key')).toHaveValue('');
  await page.locator('#p-save').click();
  await expect(page.locator('#p-key')).toBeFocused();
  await page.locator('#p-key').fill('test-only-secret');
  await page.locator('#p-model').fill('custom-model');
  await page.locator('#p-save').dblclick();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes.filter((item) => item.path === '/admin/provider-accounts')).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    providerName: 'groq',
    displayName: 'Equipe C',
    authMode: 'apiKey',
    apiKey: 'test-only-secret',
    settings: { defaultModel: 'custom-model' },
  });
  await expect(page.locator('[data-provider-account="created-3"]')).toContainText(
    'Verificar conexão',
  );
  await expect(page.locator('#content')).not.toContainText('test-only-secret');
});

test('edits only the selected account and omits a blank saved credential', async ({ page }) => {
  await page.locator('[data-edit-account="groq-b"]').click();
  await expect(page.locator('#p-model')).toHaveValue('existing-model');
  await expect(page.locator('#p-key')).toHaveValue('');
  await expect(page.locator('#p-name')).toBeDisabled();
  await page.locator('#p-display-name').fill('Equipe B atualizada');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const update = writes.find((item) => item.method === 'PATCH');
  expect(update.path).toBe('/admin/provider-accounts/groq-b');
  expect(update.body).not.toHaveProperty('apiKey');
  await expect(page.locator('[data-provider-account="groq-a"]')).toContainText('Equipe A');
  await expect(page.locator('[data-provider-account="groq-b"]')).toContainText(
    'Equipe B atualizada',
  );
});

test('shows online only after the account test responds and clears it after failure', async ({
  page,
}) => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/admin/provider-accounts/groq-a/test', async (route) => {
    await pending;
    await route.fulfill({ json: { success: true, health: { ok: true, latencyMs: 12 } } });
  });
  const card = page.locator('[data-provider-account="groq-a"]');
  await card.getByRole('button', { name: 'Testar conexão', exact: true }).click();
  await expect(card).toContainText('Verificando conexão');
  await expect(card).not.toContainText('Online');
  finish();
  await expect(card.locator('.provider-status')).toContainText('Online');
  await page.route('**/admin/provider-accounts/groq-a/test', (route) =>
    route.fulfill({
      status: 502,
      json: { success: false, error: { message: 'Sem resposta do servidor' } },
    }),
  );
  await card.getByRole('button', { name: 'Testar conexão', exact: true }).click();
  await expect(card).toContainText('Sem resposta do servidor');
  await expect(card.locator('.provider-status')).not.toContainText('Online');
  await expect(page.locator('[data-provider-account="groq-b"]')).not.toContainText('Online');
});

test('uses account last5h and last7d metrics and labels missing data honestly', async ({
  page,
}) => {
  const card = page.locator('[data-provider-account="groq-a"]');
  await expect(card).toContainText('Últimas 5 horas');
  await expect(card).toContainText('Últimos 7 dias');
  await expect(card).toContainText('1.5k tokens');
  await expect(card).toContainText('US$ 0.02');
  await expect(card).toContainText('Uso indisponível');
  await expect(card).toContainText('Tarifa não configurada');
  await expect(card).not.toContainText('6.000 TPM');
});

test('creates a local server account without credential and keeps defaults unchanged', async ({
  page,
}) => {
  await page.locator('[data-connect-provider="ollama"]').click();
  await page.locator('#p-display-name').fill('GPU secundária');
  await expect(page.locator('#p-key')).toBeHidden();
  await page.locator('#p-url').fill('http://gpu:11434');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes[0].body).toMatchObject({
    providerName: 'ollama',
    authMode: 'local',
    baseUrl: 'http://gpu:11434',
  });
  expect(writes[0].body).not.toHaveProperty('apiKey');
  expect(writes.filter((item) => item.path === '/admin/provider-configs')).toHaveLength(0);
});

test('disconnects only one account of a provider', async ({ page }) => {
  await page.locator('[data-disconnect-account="groq-a"]').click();
  await expect(page.locator('[data-provider-account="groq-a"]')).toHaveCount(0);
  await expect(page.locator('[data-provider-account="groq-b"]')).toBeVisible();
  expect(
    writes.some(
      (item) => item.path === '/admin/provider-accounts/groq-a' && item.method === 'DELETE',
    ),
  ).toBe(true);
});

test('authorizes Hugging Face using a newly created account scope', async ({ page }) => {
  let polls = 0;
  await page.route('**/admin/provider-accounts/*/oauth/huggingface/start', (route) =>
    route.fulfill({
      json: {
        success: true,
        flowId: 'test-flow-id',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://huggingface.co/oauth/authorize/device',
        intervalSeconds: 1,
      },
    }),
  );
  await page.route('**/admin/provider-accounts/*/oauth/huggingface/poll', (route) => {
    polls++;
    return route.fulfill({ json: { success: true, status: 'connected' } });
  });
  await page.locator('[data-connect-provider="huggingface"]').click();
  await page.locator('#p-display-name').fill('HF equipe');
  await page.locator('input[name="provider-auth-mode"][value="oauth"]').check();
  await page.getByRole('button', { name: 'Entrar com Hugging Face', exact: true }).click();
  await expect(page.locator('#p-hf-code')).toHaveText('ABCD-EFGH');
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8000 });
  expect(polls).toBe(1);
  expect(accounts.find((item) => item.providerName === 'huggingface')?.authMode).toBe('oauth');
  await expect(page.locator('[data-provider-account="created-3"]')).not.toContainText('Online');
});

test('starts Gemini authorization within the selected account', async ({ page }) => {
  accounts.push({
    ...makeAccount('gemini-a', 'gemini', 'Google equipe'),
    authMode: 'oauth',
    hasCredential: false,
    oauthNeedsReauth: true,
  });
  await page.reload();
  let started = false;
  await page.route('**/admin/provider-accounts/gemini-a/oauth/gemini/start', (route) => {
    started = true;
    return route.fulfill({
      status: 503,
      json: { success: false, error: { message: 'OAuth temporariamente indisponível' } },
    });
  });
  await page.locator('[data-edit-account="gemini-a"]').click();
  await page.getByRole('button', { name: 'Entrar com Google', exact: true }).click();
  await expect(page.locator('#p-result')).toContainText('OAuth temporariamente indisponível');
  expect(started).toBe(true);
});

test('keeps errors editable, blocks dismissal while saving, and traps focus', async ({ page }) => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/admin/provider-accounts/groq-a', async (route) => {
    await pending;
    await route.fulfill({
      status: 502,
      json: { success: false, error: { message: 'API offline' } },
    });
  });
  await page.locator('[data-edit-account="groq-a"]').click();
  await page.locator('#p-cancel').focus();
  await page.keyboard.press('Tab');
  expect(await page.getByRole('dialog').evaluate((el) => el.contains(document.activeElement))).toBe(
    true,
  );
  await page.locator('#p-save').click();
  await expect(page.locator('#p-save')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  finish();
  await expect(page.locator('#p-result')).toContainText('API offline');
  await expect(page.locator('#p-save')).toBeEnabled();
  await expect(page.locator('#p-name')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('[data-edit-account="groq-a"]')).toBeFocused();
});

test('recovers from account loading errors and cancels dialogs on navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/admin/provider-accounts', (route) =>
    route.fulfill({ status: 503, json: { success: false, error: { message: 'API offline' } } }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
  await page.unroute('**/admin/provider-accounts');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await page.locator('[data-edit-account="groq-a"]').click();
  await page.goto(host + '/#/settings');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('fits accounts, metrics and dialog at 390 by 844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-provider-account="groq-a"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const add = page.getByRole('button', { name: 'Adicionar provedor', exact: true });
  await add.click();
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
});

test('preserves and edits the public Cloudflare ID without resending a secret', async ({
  page,
}) => {
  accounts.push({
    ...makeAccount('cf-a', 'cloudflare', 'Workers equipe'),
    accountId: 'public-cf-id',
  });
  await page.reload();
  await page.locator('[data-edit-account="cf-a"]').click();
  await expect(page.locator('#p-account')).toHaveValue('public-cf-id');
  await page.locator('#p-model').fill('@cf/new-model');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes[0].body.settings).toMatchObject({
    accountId: 'public-cf-id',
    defaultModel: '@cf/new-model',
  });
  expect(writes[0].body).not.toHaveProperty('apiKey');
  await page.locator('[data-edit-account="cf-a"]').click();
  await page.locator('#p-account').fill('new-public-cf-id');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes[1].body.settings.accountId).toBe('new-public-cf-id');
});

test('updates defaults and embeddings only through the legacy provider settings contract', async ({
  page,
}) => {
  await page.locator('[data-edit-account="groq-a"]').click();
  await page.locator('#p-default-chat').check();
  await page.locator('#p-embed').fill('embedding-model');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes.filter((item) => item.path === '/admin/provider-configs')).toEqual([
    {
      path: '/admin/provider-configs',
      method: 'POST',
      body: { name: 'groq', enabled: true, defaultChat: true, embedModel: 'embedding-model' },
    },
  ]);
  await expect(page.locator('#p-defaults')).toContainText('Groq');
  await expect(page.locator('[data-provider-account="groq-b"]')).toContainText('existing-model');
});

test('requires a new API key when switching an OAuth account to key mode', async ({ page }) => {
  accounts.push({ ...makeAccount('gemini-a', 'gemini', 'Google equipe'), authMode: 'oauth' });
  await page.reload();
  await page.locator('[data-edit-account="gemini-a"]').click();
  await page.locator('input[name="provider-auth-mode"][value="apiKey"]').check();
  await page.locator('#p-save').click();
  await expect(page.locator('#p-key')).toBeFocused();
  expect(writes).toHaveLength(0);
  await page.locator('#p-key').fill('replacement-test-key');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes[0]).toMatchObject({
    path: '/admin/provider-accounts/gemini-a',
    method: 'PATCH',
    body: { authMode: 'apiKey', apiKey: 'replacement-test-key' },
  });
});

test('retries an unavailable account metric without substituting another account usage', async ({
  page,
}) => {
  let unavailable = true;
  await page.route('**/admin/provider-accounts/groq-a/usage', (route) =>
    unavailable
      ? route.fulfill({
          status: 503,
          json: { success: false, error: { message: 'Métricas offline' } },
        })
      : route.fallback(),
  );
  await page.reload();
  const first = page.locator('[data-provider-account="groq-a"]');
  const second = page.locator('[data-provider-account="groq-b"]');
  await expect(first.locator('.provider-usage-panel')).toContainText('Uso indisponível');
  await expect(first.locator('.provider-usage-panel')).not.toContainText('US$ 0.00');
  await expect(second).toContainText('1.5k tokens');
  unavailable = false;
  await first.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(first).toContainText('1.5k tokens');
});

test('keeps a long account name and local endpoint inside the mobile viewport', async ({
  page,
}) => {
  accounts[2].displayName = 'A'.repeat(120);
  accounts[2].baseUrl = 'http://' + 'a'.repeat(100) + ':11434';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('[data-provider-account="local-a"]')).toContainText('A'.repeat(120));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('blocks conflicting operations on an account while its real test is pending', async ({
  page,
}) => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/admin/provider-accounts/groq-a/test', async (route) => {
    await pending;
    await route.fulfill({ json: { success: true, health: { ok: true } } });
  });
  const first = page.locator('[data-provider-account="groq-a"]');
  await first.getByRole('button', { name: 'Testar conexão', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Editar conta' })).toBeDisabled();
  await expect(first.getByRole('button', { name: 'Desconectar conta' })).toBeDisabled();
  await page.locator('[data-edit-account="groq-b"]').click();
  await page.locator('#p-display-name').fill('Outra equipe');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(first.getByRole('button', { name: 'Editar conta' })).toBeDisabled();
  finish();
  await expect(first.getByRole('button', { name: 'Editar conta' })).toBeEnabled();
});

test('ignores old account usage that arrives after a newer connection test refresh', async ({
  page,
}) => {
  let finish!: () => Promise<void>;
  let calls = 0;
  await page.route('**/admin/provider-accounts/groq-a/usage', async (route) => {
    calls++;
    const data = (totalTokens: number) => ({
      success: true,
      usage: { accountId: 'groq-a', last5h: { ...usageWindow, totalTokens }, last7d: usageWindow },
    });
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        finish = async () => {
          await route.fulfill({ json: data(100) });
          resolve();
        };
      });
    } else await route.fulfill({ json: data(9000) });
  });
  await page.reload();
  await expect.poll(() => calls).toBe(1);
  const card = page.locator('[data-provider-account="groq-a"]');
  await card.getByRole('button', { name: 'Testar conexão', exact: true }).click();
  await expect(card).toContainText('9.0k tokens');
  await finish();
  await expect(card).toContainText('9.0k tokens');
  await expect(card).not.toContainText('100 tokens');
});

test('keeps a disabled account disabled when changing legacy embeddings', async ({ page }) => {
  await page.route('**/admin/provider-configs', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          success: true,
          configs: [
            {
              name: 'ollama',
              enabled: accounts.find((item) => item.id === 'local-a').enabled,
              settings: { embedModel: 'nomic-embed-text' },
            },
          ],
        },
      });
    const body = route.request().postDataJSON();
    writes.push({ path: '/admin/provider-configs', method: 'POST', body });
    accounts.find((item) => item.id === 'local-a').enabled = body.enabled ?? true;
    await route.fulfill({ json: { success: true, registered: true } });
  });
  await page.locator('[data-edit-account="local-a"]').click();
  await page.locator('#p-enabled').uncheck();
  await page.locator('#p-embed').fill('updated-embedding');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const legacy = writes.find((item) => item.path === '/admin/provider-configs');
  expect(legacy.body.enabled).toBe(false);
  await expect(page.locator('[data-provider-account="local-a"] .provider-status')).toContainText(
    'Desativada',
  );
});

test('keeps the imported provider enabled when a secondary account is disabled with defaults and embeddings changes', async ({
  page,
}) => {
  await page.route('**/admin/provider-configs', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          success: true,
          configs: [
            {
              name: 'groq',
              enabled: accounts.find((item) => item.id === 'groq-a').enabled,
              settings: {},
            },
          ],
        },
      });
    const body = route.request().postDataJSON();
    writes.push({ path: '/admin/provider-configs', method: 'POST', body });
    accounts.find((item) => item.id === 'groq-a').enabled = body.enabled ?? true;
    if (body.defaultChat) providerDefaults.chat = body.name;
    await route.fulfill({ json: { success: true, registered: true } });
  });
  await page.locator('[data-edit-account="groq-b"]').click();
  await page.locator('#p-enabled').uncheck();
  await page.locator('#p-embed').fill('secondary-embedding');
  await page.locator('#p-default-chat').check();
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const legacy = writes.find((item) => item.path === '/admin/provider-configs');
  expect(legacy.body).toMatchObject({
    enabled: true,
    defaultChat: true,
    embedModel: 'secondary-embedding',
  });
  await expect(page.locator('[data-provider-account="groq-a"] .provider-status')).not.toContainText(
    'Desativada',
  );
  await expect(page.locator('[data-provider-account="groq-b"] .provider-status')).toContainText(
    'Desativada',
  );
});

for (const failed of [false, true]) {
  test(
    'applies ' +
      (failed ? 'failed' : 'successful') +
      ' health by ID after a global account refresh',
    async ({ page }) => {
      accounts[0].health = {
        ok: failed,
        checkedAt: failed ? new Date().toISOString() : null,
        latencyMs: null,
      };
      await page.reload();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await page.route('**/admin/provider-accounts/groq-a/test', async (route) => {
        await pending;
        await route.fulfill(
          failed
            ? { status: 502, json: { success: false, error: { message: 'Teste real falhou' } } }
            : { json: { success: true, health: { ok: true } } },
        );
      });
      const card = page.locator('[data-provider-account="groq-a"]');
      await card.getByRole('button', { name: 'Testar conexão', exact: true }).click();
      await page.locator('[data-edit-account="groq-b"]').click();
      await page.locator('#p-embed').fill('refresh-global');
      await page.locator('#p-save').click();
      await expect(page.getByRole('dialog')).toBeHidden();
      finish();
      if (failed) {
        await expect(card).toContainText('Teste real falhou');
        await expect(card.locator('.provider-status')).not.toContainText('Online');
      } else {
        await expect(card).toContainText('Conexão e modelos verificados');
        await expect(card.locator('.provider-status')).toContainText('Online');
      }
    },
  );

  test(
    'restores keyboard focus after a ' + (failed ? 'failed' : 'successful') + ' account test',
    async ({ page }) => {
      if (failed)
        await page.route('**/admin/provider-accounts/groq-a/test', (route) =>
          route.fulfill({
            status: 502,
            json: { success: false, error: { message: 'Teste real falhou' } },
          }),
        );
      const button = page.locator('[data-test-account="groq-a"]');
      await button.click();
      await expect(page.locator('[data-account-result="groq-a"]')).toContainText(
        failed ? 'Teste real falhou' : 'Conexão e modelos verificados',
      );
      await expect(button).toBeEnabled();
      await expect(button).toBeFocused();
    },
  );
}

test('keeps a newer health failure when an older global refresh arrives afterward', async ({
  page,
}) => {
  accounts[0].health = { ok: true, checkedAt: new Date().toISOString(), latencyMs: 12 };
  await page.reload();
  let finishTest!: () => void;
  const pendingTest = new Promise<void>((resolve) => {
    finishTest = resolve;
  });
  await page.route('**/admin/provider-accounts/groq-a/test', async (route) => {
    await pendingTest;
    await route.fulfill({
      status: 502,
      json: { success: false, error: { message: 'Teste real falhou' } },
    });
  });
  await page.locator('[data-test-account="groq-a"]').click();
  let finishRefresh!: () => Promise<void>;
  let refreshStarted = false;
  await page.route('**/admin/provider-accounts', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const snapshot = structuredClone(accounts);
    refreshStarted = true;
    await new Promise<void>((resolve) => {
      finishRefresh = async () => {
        await route.fulfill({ json: { success: true, accounts: snapshot } });
        resolve();
      };
    });
  });
  await page.locator('[data-edit-account="groq-b"]').click();
  await page.locator('#p-embed').fill('refresh-global');
  await page.locator('#p-save').click();
  await expect.poll(() => refreshStarted).toBe(true);
  finishTest();
  const card = page.locator('[data-provider-account="groq-a"]');
  await expect(card).toContainText('Teste real falhou');
  await finishRefresh();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(card.locator('.provider-status')).not.toContainText('Online');
});
