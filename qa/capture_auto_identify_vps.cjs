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

  // 1. Providers page
  await page.goto('http://209.50.241.22:8081/#/providers');
  await page.waitForSelector('[data-provider-account], [data-provider-card]', { timeout: 15000 });
  await page.waitForTimeout(1500);

  // 2. Open connection dialog to showcase Auto-Identification banner
  console.log('Opening connection dialog...');
  const connectBtn = page.locator('[data-connect-provider="openai"], [data-connect-provider]').first();
  await connectBtn.click();
  await page.waitForSelector('#provider-dialog[open]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  const dialogPic = path.join(artifactDir, 'vps_auto_identify_connection_dialog.png');
  await page.screenshot({ path: dialogPic, fullPage: false });
  console.log('Saved:', dialogPic);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // 3. Open 0.75-screen Inspector to showcase Auto-Identify button and real quotas
  console.log('Opening 0.75-screen inspector for Ollama...');
  const inspectBtn = page.locator('[data-inspect-account]').first();
  await inspectBtn.click();
  await page.waitForSelector('#provider-inspector-dialog[open]', { timeout: 5000 });
  await page.waitForTimeout(1200);
  const inspectorPic = path.join(artifactDir, 'vps_auto_identify_inspector_popup.png');
  await page.screenshot({ path: inspectorPic, fullPage: false });
  console.log('Saved:', inspectorPic);

  await browser.close();
  console.log('All auto-identify screenshots captured successfully!');
})();
