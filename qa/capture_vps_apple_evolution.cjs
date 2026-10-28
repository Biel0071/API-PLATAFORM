const { chromium } = require('playwright');
const path = require('path');
const artifactDir = 'C:\\Users\\Dell\\.gemini\\antigravity\\brain\\27231281-c21f-4731-9f65-f86f7bda145c';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();

  console.log('Navigating to VPS login...');
  await page.goto('http://209.50.241.22:8081/#/login');
  await page.waitForSelector('#login-email', { timeout: 10000 });
  await page.fill('#login-email', 'admin@aiplatform.local');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-form button[type="submit"]');

  await page.waitForSelector('#shell:not(.hidden)', { timeout: 15000 });
  console.log('Logged in successfully!');

  // 1. Providers page (Compact cards + active badges)
  await page.goto('http://209.50.241.22:8081/#/providers');
  await page.waitForSelector('[data-provider-account], [data-provider-card]', { timeout: 15000 });
  await page.waitForTimeout(1500);
  const providersPic = path.join(artifactDir, 'vps_providers_compact_apple_cards.png');
  await page.screenshot({ path: providersPic, fullPage: false });
  console.log('Saved:', providersPic);

  // 2. Open 0.75-screen Provider Inspector Pop-up on OpenAI (or first connected account)
  const inspectBtn = page.locator('[data-inspect-account]').first();
  if (await inspectBtn.count()) {
    console.log('Opening 0.75-screen inspector for account...');
    await inspectBtn.click();
    await page.waitForSelector('#provider-inspector-dialog[open]', { timeout: 5000 });
    await page.waitForTimeout(1200);
    const inspectorPic = path.join(artifactDir, 'vps_provider_inspector_75vh_popup.png');
    await page.screenshot({ path: inspectorPic, fullPage: false });
    console.log('Saved:', inspectorPic);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }

  // 3. Open 0.75-screen Inspector on Ollama Open Source models
  const ollamaInspectBtn = page.locator('[data-inspect-provider="ollama"], [data-inspect-account="ollama"]').first();
  if (await ollamaInspectBtn.count()) {
    console.log('Opening 0.75-screen inspector for Ollama...');
    await ollamaInspectBtn.click();
    await page.waitForSelector('#provider-inspector-dialog[open]', { timeout: 5000 });
    await page.waitForTimeout(1200);
    const ollamaPic = path.join(artifactDir, 'vps_ollama_inspector_75vh_popup.png');
    await page.screenshot({ path: ollamaPic, fullPage: false });
    console.log('Saved:', ollamaPic);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }

  // 4. Home (Visão Geral - Apple Bento KPIs & Providers table)
  console.log('Navigating to Home...');
  await page.goto('http://209.50.241.22:8081/#/');
  try {
    await page.waitForSelector('#home-providers-table tbody tr', { timeout: 8000 });
  } catch (e) {
    console.log('Home table row wait timeout, proceeding to screenshot...');
  }
  await page.waitForTimeout(1500);
  const homePic = path.join(artifactDir, 'vps_home_apple_bento_overview.png');
  await page.screenshot({ path: homePic, fullPage: false });
  console.log('Saved:', homePic);

  // 5. Playground with quick presets
  console.log('Navigating to Playground...');
  await page.goto('http://209.50.241.22:8081/#/playground');
  try {
    await page.waitForSelector('#test-provider', { timeout: 8000 });
  } catch (e) {
    console.log('Playground selector wait timeout, proceeding to screenshot...');
  }
  await page.waitForTimeout(1200);
  const playgroundPic = path.join(artifactDir, 'vps_playground_apple_presets.png');
  await page.screenshot({ path: playgroundPic, fullPage: false });
  console.log('Saved:', playgroundPic);

  await browser.close();
  console.log('All VPS visual verification screenshots captured!');
})();
