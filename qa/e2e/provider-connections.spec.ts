import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Isolated UI contract fixtures. Real provider availability is checked separately.
let server: Server;
let host: string;
const dashboard = path.resolve(__dirname, '../../apps/dashboard/public');
test.use({ channel: 'chrome' });
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('apiplatform_token', 'ui-test-only'));
  await page.route('**/admin/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/admin/providers')
      return route.fulfill({
        json: { success: true, providers: live, defaults: { chat: 'ollama', image: 'comfyui' } },
      });
    if (pathname === '/admin/provider-configs')
      return route.fulfill({
        json: {
          success: true,
          configs: [
            {
              name: 'ollama',
              enabled: true,
              settings: {
                baseUrl: 'http://ollama:11434',
                defaultModel: 'qwen2.5:3b',
                defaultChat: true,
              },
            },
            {
              name: 'groq',
              enabled: true,
              hasApiKey: true,
              settings: { defaultModel: 'existing-model' },
            },
          ],
        },
      });
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/v1/health', (route) =>
    route.fulfill({ json: { success: true, postgres: { ok: true }, redis: { ok: true } } }),
  );
  await page.goto(`${host}/#/providers`);
});

test('shows provider logos and honest health states without the inline form', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Provedores de IA', exact: true })).toBeVisible();
  await expect(page.locator('#p-name')).toBeHidden();
  await expect(page.locator('[data-provider-card="openai"] img')).toBeVisible();
  await expect(page.locator('[data-provider-card="comfyui"]')).toContainText('Indisponível');
  await expect(page.locator('[data-provider-card="comfyui"]')).not.toContainText('Online');
  expect(
    await page
      .locator('.provider-logo img')
      .evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
  ).toBe(true);
});

test('plus opens an accessible dialog, traps focus and returns focus on Escape', async ({
  page,
}) => {
  const add = page.getByRole('button', { name: 'Adicionar provedor', exact: true });
  await add.click();
  const dialog = page.getByRole('dialog', { name: 'Conectar conta' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#p-name')).toBeFocused();
  await page.locator('#p-cancel').focus();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
});

test('connect selects the provider, switches conditional fields and validates required input', async ({
  page,
}) => {
  await page.locator('[data-connect-provider="openai"]').click();
  await expect(page.locator('#p-name')).toHaveValue('openai');
  await expect(page.locator('#p-account')).toBeHidden();
  await page.locator('#p-save').click();
  await expect(page.locator('#p-key')).toBeFocused();
  await page.locator('#p-name').selectOption('cloudflare');
  await expect(page.locator('#p-account')).toBeVisible();
  await page.locator('#p-name').selectOption('ollama');
  await expect(page.locator('#p-key')).toBeHidden();
  await expect(page.locator('#p-url')).toHaveValue('http://ollama:11434');
  await expect(page.locator('#p-default-chat')).toBeChecked();
});

test('saves once through the API and adds the configured provider without asserting it is online', async ({
  page,
}) => {
  let writes = 0;
  let body: Record<string, unknown> = {};
  await page.route('**/admin/provider-configs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    writes++;
    body = route.request().postDataJSON();
    await route.fulfill({ json: { success: true, registered: true } });
  });
  await page.locator('[data-connect-provider="openai"]').click();
  await page.locator('#p-key').fill('test-only-secret');
  await page.locator('#p-model').fill('test-model');
  await page.locator('#p-save').dblclick();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes).toBe(1);
  expect(body).toMatchObject({
    name: 'openai',
    apiKey: 'test-only-secret',
    defaultModel: 'test-model',
    enabled: true,
    defaultChat: false,
  });
  await expect(page.locator('[data-provider-card="openai"]')).toContainText('Verificar conexão');
  await expect(page.locator('#content')).not.toContainText('test-only-secret');
});

test('ignores an older provider refresh that completes after a newer save', async ({ page }) => {
  const finishRefresh: Array<(payload: unknown) => Promise<void>> = [];
  await page.route('**/admin/provider-configs', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: { success: true, registered: true } });
  });
  await page.route('**/admin/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await new Promise<void>((resolve) => {
      finishRefresh.push(async (payload) => {
        await route.fulfill({ json: payload });
        resolve();
      });
    });
  });

  await page.locator('[data-connect-provider="openai"]').click();
  await page.locator('#p-key').fill('first-test-key');
  await page.locator('#p-default-chat').check();
  await page.locator('#p-save').click();
  await expect.poll(() => finishRefresh.length).toBe(1);

  await page.locator('[data-connect-provider="anthropic"]').click();
  await page.locator('#p-key').fill('second-test-key');
  await page.locator('#p-default-chat').check();
  await page.locator('#p-save').click();
  await expect.poll(() => finishRefresh.length).toBe(2);

  await finishRefresh[1]({
    success: true,
    defaults: { chat: 'anthropic' },
    providers: [...live, { name: 'anthropic', health: { ok: true }, models: [{ id: 'claude' }] }],
  });
  await expect(page.locator('#p-defaults')).toContainText('Anthropic');

  await finishRefresh[0]({
    success: true,
    defaults: { chat: 'openai' },
    providers: [...live, { name: 'openai', health: { ok: true }, models: [{ id: 'gpt' }] }],
  });
  await expect(page.locator('#p-defaults')).toContainText('Anthropic');
  await expect(page.locator('#p-defaults')).not.toContainText('OpenAI');
  await expect(page.locator('[data-provider-card="anthropic"]')).toContainText('Online');
});

test('preserves a saved credential on edit and keeps API errors in the dialog', async ({
  page,
}) => {
  let body: Record<string, unknown> = {};
  await page.route('**/admin/provider-configs', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    body = route.request().postDataJSON();
    return route.fulfill({
      status: 502,
      json: { success: false, error: { message: 'Provedor indisponível' } },
    });
  });
  await page.locator('[data-connect-provider="groq"]').click();
  await expect(page.locator('#p-key')).toHaveValue('');
  await expect(page.locator('#p-model')).toHaveValue('existing-model');
  await page.locator('#p-save').click();
  await expect(page.locator('#p-result')).toHaveText('Provedor indisponível');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#p-save')).toBeEnabled();
  expect(body.apiKey).toBe('');
});

test('requires a new API key when switching a saved Gemini OAuth account to API-key mode', async ({
  page,
}) => {
  let body: Record<string, unknown> = {};
  await page.route('**/admin/provider-oauth/options', (route) =>
    route.fulfill({
      json: {
        success: true,
        options: { gemini: { apiKey: { enabled: true }, oauth: { enabled: true } } },
      },
    }),
  );
  await page.route('**/admin/provider-configs', (route) => {
    if (route.request().method() === 'POST') {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, registered: true } });
    }
    return route.fulfill({
      json: {
        success: true,
        configs: [
          {
            name: 'gemini',
            enabled: true,
            hasOAuth: true,
            hasApiKey: false,
            settings: { authMode: 'oauth', defaultModel: 'gemini-2.5-flash' },
          },
        ],
      },
    });
  });
  await page.route('**/admin/providers', (route) =>
    route.fulfill({
      json: {
        success: true,
        defaults: { chat: 'gemini' },
        providers: [...live, { name: 'gemini', health: { ok: true }, models: [{ id: 'gemini-2.5-flash' }] }],
      },
    }),
  );

  await page.reload();
  await page.locator('[data-connect-provider="gemini"]').click();
  await expect(page.locator('input[name="provider-auth-mode"][value="oauth"]')).toBeChecked();
  await page.locator('input[name="provider-auth-mode"][value="apiKey"]').check();
  expect(await page.locator('#p-key').evaluate((input) => (input as HTMLInputElement).required)).toBe(true);
  await page.locator('#p-key').fill('new-gemini-key');
  await page.locator('#p-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(body).toMatchObject({ name: 'gemini', authMode: 'apiKey', apiKey: 'new-gemini-key' });
});

test('completes Hugging Face device authorization through the provider dialog', async ({ page }) => {
  let polls = 0;
  await page.route('**/admin/provider-oauth/options', (route) =>
    route.fulfill({
      json: {
        success: true,
        options: { huggingface: { apiKey: { enabled: true }, oauth: { enabled: true } } },
      },
    }),
  );
  await page.route('**/admin/provider-oauth/huggingface/start', (route) =>
    route.fulfill({
      json: {
        success: true,
        flowId: 'test-flow-id-12345678901234567890123456789012',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://huggingface.co/oauth/authorize/device',
        intervalSeconds: 1,
      },
    }),
  );
  await page.route('**/admin/provider-oauth/huggingface/poll', (route) => {
    polls++;
    return route.fulfill({ json: { success: true, status: polls === 1 ? 'pending' : 'connected' } });
  });

  await page.reload();
  await page.locator('[data-connect-provider="huggingface"]').click();
  await page.locator('input[name="provider-auth-mode"][value="oauth"]').check();
  await page.getByRole('button', { name: 'Entrar com Hugging Face' }).click();
  await expect(page.locator('#p-hf-code')).toHaveText('ABCD-EFGH');
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 8_000 });
  expect(polls).toBe(2);
  await expect(page.getByText('Conta Hugging Face conectada', { exact: false })).toBeVisible();
});

test('cancels the dialog on navigation and allows recovery from a loading error', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${host}/#/settings`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await page.goto(`${host}/#/providers`);
  await page.getByRole('button', { name: 'Adicionar provedor', exact: true }).click();
  await page.goto(`${host}/#/settings`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.route('**/admin/providers', (route) =>
    route.fulfill({ status: 503, json: { success: false, error: { message: 'API offline' } } }),
  );
  await page.goto(`${host}/#/providers`);
  await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
  await page.unroute('**/admin/providers');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.locator('[data-provider-card="ollama"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('fits the provider list and dialog at 390 by 844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Adicionar provedor', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.locator('#p-cancel').click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('shows a verified health result only after the test endpoint responds', async ({ page }) => {
  await page.route('**/admin/provider-configs/comfyui/test', (route) =>
    route.fulfill({ json: { success: true, health: { ok: true, latencyMs: 12 } } }),
  );
  await page.getByRole('button', { name: 'Testar conexão ComfyUI', exact: true }).click();
  await expect(page.locator('[data-provider-result="comfyui"]')).toContainText(
    'Conexão verificada',
  );
  await expect(page.locator('[data-provider-card="comfyui"] .provider-status')).toHaveText(
    '● Online',
  );
  await page.route('**/admin/provider-configs/comfyui/test', (route) =>
    route.fulfill({
      status: 502,
      json: { success: false, error: { message: 'Sem resposta do servidor' } },
    }),
  );
  await page.getByRole('button', { name: 'Testar conexão ComfyUI', exact: true }).click();
  await expect(page.locator('[data-provider-result="comfyui"]')).toContainText(
    'Sem resposta do servidor',
  );
  await expect(
    page.getByRole('button', { name: 'Testar conexão ComfyUI', exact: true }),
  ).toBeEnabled();
});

test('keeps an incomplete registration editable and blocks dismissal while saving', async ({
  page,
}) => {
  let finish: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/admin/provider-configs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await pending;
    return route.fulfill({ json: { success: true, registered: false } });
  });
  await page.locator('[data-connect-provider="openai"]').click();
  await page.locator('#p-key').fill('test-only-secret');
  await page.locator('#p-save').click();
  await expect(page.locator('#p-save')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  finish!();
  await expect(page.locator('#p-result')).toContainText('não foi registrado');
  await expect(page.locator('#p-save')).toBeEnabled();
  await page.locator('#p-cancel').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.locator('[data-connect-provider="openai"]').click();
  await expect(page.locator('#p-key')).toHaveValue('');
});

test('displays model tags, portal links and populates model field from suggestion chips', async ({
  page,
}) => {
  const openaiCard = page.locator('[data-provider-card="openai"]');
  await expect(openaiCard.locator('.provider-portal-link')).toHaveAttribute(
    'href',
    'https://platform.openai.com/api-keys',
  );
  await expect(openaiCard.locator('.model-tag').first()).toBeVisible();

  await page.getByRole('button', { name: 'Adicionar provedor', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Conectar conta' });
  await expect(dialog).toBeVisible();

  await expect(dialog.locator('.provider-open-browser-btn')).toHaveAttribute(
    'href',
    'https://platform.openai.com/api-keys',
  );

  const chip = dialog.locator('.provider-model-chip').first();
  await expect(chip).toBeVisible();
  const modelName = await chip.textContent();
  await chip.click();
  await expect(page.locator('#p-model')).toHaveValue(modelName || '');
});

test('displays hourly and weekly token usage and account quotas on provider cards', async ({ page }) => {
  await page.route('**/admin/usage?days=7', (route) =>
    route.fulfill({
      json: {
        success: true,
        usage: [
          { provider: 'ollama', requests: 42, totalTokens: 125000, cost: 0 },
        ],
      },
    }),
  );
  await page.route('**/admin/logs?limit=250', (route) =>
    route.fulfill({
      json: {
        success: true,
        logs: [
          { provider: 'ollama', totalTokens: 1500, cost: 0, createdAt: new Date().toISOString() },
        ],
      },
    }),
  );
  await page.reload();

  const ollamaCard = page.locator('[data-provider-card="ollama"]');
  await expect(ollamaCard.locator('.provider-usage-panel')).toBeVisible();
  await expect(ollamaCard.locator('.provider-usage-panel')).toContainText('Uso por hora (5h)');
  await expect(ollamaCard.locator('.provider-usage-panel')).toContainText('1.5k tokens');
  await expect(ollamaCard.locator('.provider-usage-panel')).toContainText('Uso semanal (7d)');
  await expect(ollamaCard.locator('.provider-usage-panel')).toContainText('125.0k tokens');
  await expect(ollamaCard.locator('.provider-quota-badge')).toContainText('Local ilimitado');

  const groqCard = page.locator('[data-provider-card="groq"]');
  await expect(groqCard.locator('.provider-quota-badge')).toContainText('6.000 TPM');
});

