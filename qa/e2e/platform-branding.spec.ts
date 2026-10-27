import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const dashboard = path.resolve(__dirname, '../../apps/dashboard/public');
let server: Server;
let host: string;

test.use({
  channel: 'chrome',
  launchOptions: { args: ['--disable-gpu', '--disable-background-timer-throttling'] },
});

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const target = path.resolve(dashboard, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(dashboard + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(target);
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream' }).end(data);
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

test('loads a local accessible brand mark in login and application shell', async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (
      ['image', 'font'].includes(request.resourceType()) &&
      new URL(request.url()).origin !== new URL(host).origin
    ) remoteRequests.push(request.url());
  });
  await page.goto(host);

  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/assets/brand/api-platform.svg');
  await expect(page.locator('#login h1')).toHaveText('API Platform');
  await expect(page.locator('#sidebar h2')).toContainText('API Platform');
  const logo = page.locator('#login .login-mark img, #sidebar .brand-glow img');
  await expect(logo).toHaveCount(2);
  for (const image of await logo.all()) {
    await expect(image).toHaveAttribute('alt', '');
    await expect(image).toHaveAttribute('src', '/assets/brand/api-platform.svg');
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.locator('#login .brand-orbit[aria-hidden="true"]')).toHaveCount(1);
  await expect(page.locator('#sidebar .brand-orbit[aria-hidden="true"]')).toHaveCount(1);
  expect(remoteRequests).toEqual([]);
});

test('animates the orbital ring and disables motion when requested', async ({ page }) => {
  await page.goto(host);
  const orbit = page.locator('.brand-orbit').first();
  await expect(orbit).toHaveCSS('animation-name', 'brand-orbit');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(orbit).toHaveCSS('animation-name', 'none');
});

test('does not load typography from an external service', async () => {
  const html = await readFile(path.join(dashboard, 'index.html'), 'utf8');
  const css = await readFile(path.join(dashboard, 'app.css'), 'utf8');
  expect(html).not.toMatch(/<(?:img|script|source|link)\b[^>]*(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i);
  expect(css).not.toMatch(/@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//i);
  expect(css).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
});

const appRoutes = [
  'home', 'projects', 'project/fixture-project', 'providers', 'models', 'playground',
  'image-generate', 'image-edit', 'video-ai', 'image-providers', 'image-queue',
  'image-history', 'image-models', 'image-analytics', 'workers', 'queues', 'usage',
  'cache', 'logs', 'users', 'keys', 'comfy-wizard', 'workflow-manager', 'prompts',
  'lovable', 'integrations', 'ollama', 'base-url', 'sdk', 'security', 'backup',
  'settings', 'tenants', 'fenix', 'mission', 'health', 'metrics', 'runtime', 'icp',
  // Router aliases are explicitly exercised alongside the navigation destinations.
  'imageGenerate', 'imageEdit', 'videoAI', 'imageProviders', 'imageQueue',
  'imageHistory', 'imageModels', 'imageAnalytics', 'comfyWizard', 'workflowManager',
  'baseUrl',
];
const routeAliases: Record<string, string> = {
  imageGenerate: 'image-generate', imageEdit: 'image-edit', videoAI: 'video-ai',
  imageProviders: 'image-providers', imageQueue: 'image-queue', imageHistory: 'image-history',
  imageModels: 'image-models', imageAnalytics: 'image-analytics', comfyWizard: 'comfy-wizard',
  workflowManager: 'workflow-manager', baseUrl: 'base-url',
};
const routeHeadings: Record<string, string> = {
  home: 'Visao Geral do Sistema', projects: 'Projetos', project: 'Projeto de teste',
  providers: 'Provedores de IA', models: 'Modelos', playground: 'Playground de IA',
  'image-generate': 'Gerar Imagem', 'image-edit': 'Imagem → Imagem', 'video-ai': 'Video → Imagem',
  'image-providers': 'Image Providers', 'image-queue': 'Image Queue',
  'image-history': 'Image History', 'image-models': 'Image Models',
  'image-analytics': 'Image Analytics', workers: 'Workers', queues: 'Filas',
  usage: 'Tokens & Custos (30 dias)', cache: 'Cache', logs: 'Logs de requisicoes', users: 'Usuarios',
  keys: 'API Keys', 'comfy-wizard': 'Assistente ComfyUI', 'workflow-manager': 'Workflows ComfyUI',
  prompts: 'Biblioteca de Prompts', lovable: 'Conectar ao Lovable', integrations: 'Integrações',
  ollama: 'Ollama', 'base-url': 'Base URL', sdk: 'SDK', security: 'Segurança', backup: 'Backup',
  settings: 'Configuracoes', tenants: 'Configuracoes', fenix: 'FÊNIX Connect',
  mission: 'Mission Viewer', health: 'Health Check (Real-time)', metrics: 'Prometheus Metrics',
  runtime: 'Runtime da API Platform', icp: 'Cluster local',
};
const routeActions: Record<string, string> = {
  projects: '#btn-new-project', project: 'a[href="#/projects"]', providers: '#p-add',
  models: '#mc-save', playground: '#test-run', 'image-generate': '#ig-run',
  'image-edit': '#ie-run', 'video-ai': '#vi-run', cache: '#cache-clear',
  users: '#u-create', keys: '#k-create', 'comfy-wizard': '#cw-test',
  'workflow-manager': '#wf-import', prompts: '#pm-save', settings: '#t-create',
  tenants: '#t-create', security: 'a[href="#/keys"]', lovable: '#lv-test',
  ollama: 'a[href="#/providers"]', health: '#btn-copy-health', fenix: 'a[href="#/keys"]',
};

async function installDashboardFixtures(page: import('@playwright/test').Page) {
  await page.addInitScript(() => localStorage.setItem('apiplatform_token', 'branding-test'));
  await page.route('**/v1/health', (route) => route.fulfill({ json: { success: true, status: 'ok', uptime: 1, postgres: true, redis: true, checks: { database: true, redis: true }, providers: {} } }));
  await page.route('**/v1/runtime', (route) => route.fulfill({ json: { success: true, runtime: {} } }));
  await page.route('**/v1/sync/cluster', (route) => route.fulfill({ json: { success: true, nodes: [] } }));
  await page.route('**/v1/missions', (route) => route.fulfill({ json: { success: true, missions: [] } }));
  await page.route('**/admin/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      success: true,
      projects: [{ id: 'fixture-project', name: 'Projeto de teste', active: true, tenant: { name: 'Local' }, _count: { apiKeys: 0 } }],
      tenants: [{ id: 'fixture-tenant', name: 'Tenant de teste', slug: 'teste', active: true }],
      providers: [], configs: [], options: {}, accounts: [], models: [], workers: [],
      queues: [], jobs: [], logs: [], users: [], keys: [], images: [], workflows: [], prompts: [],
      usage: { requests: 0, totalTokens: 0, cost: 0 }, stats: {},
      overview: { last24h: { requests: 0, totalTokens: 0, cost: 0, avgDurationMs: 0 }, tenants: 0 },
    };
    if (pathname === '/admin/metrics') return route.fulfill({ status: 200, contentType: 'text/plain', body: '# HELP dashboard_test metric\n' });
    if (pathname === '/admin/comfyui/setup') data.health = { ok: true };
    if (pathname === '/admin/image/queue') data.queue = [];
    if (pathname === '/admin/image/analytics') Object.assign(data, { total: 0, byProvider: [], byKind: [] });
    if (pathname === '/admin/usage') data.usage = [];
    if (pathname === '/admin/cache') data.stats = { hits: 0, misses: 0, keys: 0 };
    return route.fulfill({ json: data });
  });
}

test('every dashboard route and alias renders real page content on desktop and mobile', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installDashboardFixtures(page);

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const route of appRoutes) {
      await page.goto(host + '/#/' + route);
      const content = page.locator('#content');
      const canonicalRoute = routeAliases[route] || (route.startsWith('project/') ? 'project' : route);
      await expect(content.locator('h1').first(), `${route} should render its page title`).toHaveText(routeHeadings[canonicalRoute]);
      await expect(content, `${route} should render primary content`).not.toBeEmpty();
      await expect(content.locator('.error, [role="alert"]'), `${route} should not hide a render/API failure`).toHaveCount(0);
      expect((await content.innerText()).trim().length, `${route} should contain readable content`).toBeGreaterThan(20);
      const primaryAction = routeActions[canonicalRoute];
      if (primaryAction) await expect(content.locator(primaryAction), `${route} should retain its primary action`).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} should not overflow the viewport`).toBe(true);
    }
  }
  expect(pageErrors).toEqual([]);
});

test('mobile navigation and page controls remain keyboard reachable with visible focus', async ({ page }) => {
  await installDashboardFixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(host + '/#/home');

  const menu = page.locator('#sidebar-toggle');
  await menu.focus();
  await expect(menu).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sidebar')).toHaveClass(/mobile-open/);
  const providerLink = page.locator('#sidebar a[href="#/providers"]');
  await providerLink.focus();
  await expect(providerLink).toBeFocused();
  await expect(providerLink).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/providers$/);
  await expect(page.locator('#content h1')).toHaveText('Provedores de IA');
  await expect(page.locator('#p-add')).toBeVisible();
  const providerLogos = page.locator('#p-catalog .provider-logo img');
  await expect(providerLogos).toHaveCount(13);
  for (const logo of await providerLogos.all()) {
    await expect(logo).toHaveAttribute('src', /^assets\/providers\/[a-z]+\.svg$/);
    await expect.poll(() => logo.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  }
  await page.locator('#p-add').focus();
  await expect(page.locator('#p-add')).toBeFocused();
});

test('brand name stays on one line on desktop and mobile', async ({ page }) => {
  await installDashboardFixtures(page);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(host + '/#/home');
    const brandName = page.locator('#sidebar h2 > span').nth(1);
    await expect(brandName).toHaveCSS('white-space', 'nowrap');
  }
});

test('empty table state fits the mobile viewport without horizontal scroll', async ({ page }) => {
  await installDashboardFixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(host + '/#/logs');
  const emptyCell = page.locator('#content .table-empty-cell').first();
  await expect(emptyCell).toBeVisible();
  const emptyStateLayout = await emptyCell.evaluate((cell) => {
    const container = cell.closest('.table-container')!;
    const bounds = cell.getBoundingClientRect();
    return {
      visibleWithinViewport: bounds.left >= 0 && bounds.right <= window.innerWidth,
      hasHorizontalScroll: container.scrollWidth > container.clientWidth,
    };
  });
  expect(emptyStateLayout.visibleWithinViewport).toBe(true);
  expect(emptyStateLayout.hasHorizontalScroll).toBe(false);
});
