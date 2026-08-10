import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Ultimate Level 3 Journey', () => {
  const HOST = 'http://209.50.241.215';

  test('Deve logar, navegar pelo painel e validar integridade', async ({ page }) => {
    const start = Date.now();
    let errorCount = 0;

    try {
      // Navegar para o painel
      await page.goto(HOST);
      
      // Simula preenchimento no form de login
      await page.fill('#login-email', 'admin');
      await page.fill('#login-password', 'admin123');
      await page.click('button[type="submit"]');

      // Espera carregar o painel
      await page.waitForSelector('#shell', { state: 'visible', timeout: 5000 }).catch(() => {
        errorCount++;
      });

      // Navega pelas abas para checar crash visual
      await page.goto(`${HOST}/#/projects`);
      await page.goto(`${HOST}/#/providers`);
      await page.goto(`${HOST}/#/keys`);
      await page.goto(`${HOST}/#/playground`);
      await page.goto(`${HOST}/#/health`);
      await page.goto(`${HOST}/#/fenix`);
      
    } catch (e) {
      errorCount++;
    }

    const duration = Date.now() - start;

    const historyFile = path.join(__dirname, '../history', `e2e-${Date.now()}.json`);
    fs.writeFileSync(historyFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      duration,
      uiErrors: errorCount,
      success: errorCount === 0
    }, null, 2));

    expect(errorCount).toBe(0);
  });
});
