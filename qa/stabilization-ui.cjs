const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
}));
const host = process.env.TEST_HOST || 'http://localhost:8080';
const output = path.join(__dirname, 'test-results/platform-stabilization');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const report = { routes: [], errors: [], externalRuntimeRequests: [], checks: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (request.url().includes(':4400')) report.externalRuntimeRequests.push(request.url()); });
  let promptId;
  let token;
  try {
    await page.goto(host);
    await page.fill('#login-email', env.ADMIN_EMAIL || 'admin');
    await page.fill('#login-password', env.ADMIN_PASSWORD);
    await page.click('#btn-login-submit');
    await page.locator('#shell:not(.hidden)').waitFor();
    await page.locator('#home-providers-table').waitFor();
    token = await page.evaluate(() => localStorage.getItem('apiplatform_token'));
    report.checks.push('login');
    const routes = await page.locator('nav a[href^="#/"]').evaluateAll(links => [...new Set(links.map(link => link.getAttribute('href')))]);
    for (const route of routes) {
      await page.evaluate(route => { location.hash = route; }, route);
      await page.waitForFunction(() => !document.querySelector('#content')?.textContent.includes('Carregando...'), { timeout: 30000 });
      await page.locator('#content h1').waitFor({ timeout: 30000 });
      const text = await page.locator('#content').innerText();
      assert(!/\b(?:undefined|NaN)\b/.test(text), `${route}: valores inválidos na tela`);
      report.routes.push(route);
      console.log('PASS', route);
    }
    // A write/read/delete round trip exercises the consolidated UI against PostgreSQL.
    await page.evaluate(() => { location.hash = '#/prompts'; });
    await page.locator('#pm-name').waitFor();
    const name = `QA consolidation ${Date.now()}`;
    await page.fill('#pm-name', name);
    await page.fill('#pm-template', 'Teste real de persistência {{produto}}');
    const created = page.waitForResponse(response => response.url().endsWith('/admin/prompts') && response.request().method() === 'POST');
    await page.click('#pm-save');
    const createdResponse = await created;
    assert.equal(createdResponse.status(), 200);
    promptId = (await createdResponse.json()).prompt.id;
    await page.reload();
    await page.getByText(name, { exact: true }).waitFor();
    report.checks.push('prompt persisted after reload');

    await page.evaluate(() => { location.hash = '#/playground'; });
    await page.locator('#test-provider').waitFor();
    await page.selectOption('#test-provider', 'ollama');
    await page.fill('#test-model', 'qwen2.5:3b');
    await page.fill('#test-prompt', 'Responda apenas OK.');
    await page.click('#test-run');
    await page.locator('#test-output:not(.hidden)').waitFor({ timeout: 90000 });
    assert.match(await page.locator('#test-output').innerText(), /OK/i);
    report.checks.push('real Ollama inference');
    await page.screenshot({ path: path.join(output, 'playground.png'), fullPage: true });

    // Rapid route changes must cancel obsolete requests and polling.
    for (const route of ['#/providers', '#/models', '#/home', '#/health', '#/cache']) {
      await page.evaluate(route => { location.hash = route; }, route);
    }
    await page.locator('#cache-clear').waitFor();
    report.checks.push('rapid navigation');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.locator('#home-providers-table').waitFor();
    await page.click('#sidebar-toggle');
    await page.locator('#sidebar.mobile-open').waitFor();
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile horizontal overflow');
    report.checks.push('mobile navigation');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(output, 'dashboard.png'), fullPage: true });
    await page.click('#logout');
    await page.locator('#login:not(.hidden)').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('apiplatform_token')), null);
    report.checks.push('logout');
    assert.deepEqual(report.externalRuntimeRequests, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    fs.appendFileSync(path.join(root, 'TODO-BUGS.md'), `\n- [ ] QA consolidação UI: ${error.message.replace(/\s+/g, ' ').slice(0, 300)}\n`);
    process.exitCode = 1;
  } finally {
    if (promptId && token) await fetch(`${host}/admin/prompts/${promptId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }
})();
