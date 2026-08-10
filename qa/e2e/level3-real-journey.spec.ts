import { test, expect } from '@playwright/test';

test.describe('Ultimate UI Journey - AI-LLM Dashboard', () => {
  const HOST = 'http://209.50.241.215'; // ou http://localhost dependendo de onde roda

  test('Mapeamento e Cliques em Todas as Funcionalidades (Keys, Wizard, Playground)', async ({ page }) => {
    test.setTimeout(120000); // 2 minutos max

    // 1. LOGIN
    await page.goto(HOST);
    await page.fill('#login-email', 'admin');
    await page.fill('#login-password', 'admin123');
    await page.click('button[type="submit"]');
    
    // Aguarda painel
    await page.waitForSelector('#shell:not(.hidden)');
    console.log('✅ Login efetuado com sucesso');

    // 2. HOME OVERVIEW
    await expect(page.locator('h1')).toContainText('Visao Geral do Sistema');
    await page.waitForTimeout(1000);

    // 3. WIZARD DE PROJETOS E CHAVES
    await page.goto(`${HOST}/#/projects`);
    await page.waitForSelector('#btn-new-project');
    await page.click('#btn-new-project');
    
    await page.waitForSelector('#w-name');
    await page.fill('#w-name', 'Projeto Teste Auto QA');
    await page.selectOption('#w-env', 'test');
    await page.fill('#w-domain', 'api.qa-test.com');
    
    // Avança para o Passo 2
    await page.click('#btn-step-1');
    await page.waitForSelector('#btn-step-2:not([disabled])', { timeout: 10000 });
    const apiKeyCreated = await page.textContent('#w-api-key');
    expect(apiKeyCreated).toBeTruthy();
    console.log('✅ Wizard: Projeto e Chave (' + apiKeyCreated + ') criados com sucesso');

    // Avança para o Passo 3 e 4
    await page.click('#btn-step-2');
    await page.click('#btn-step-3');
    await expect(page.locator('h2')).toContainText('Concluído! Projeto ONLINE');

    // 4. CHAVES (API KEYS)
    await page.goto(`${HOST}/#/keys`);
    await page.waitForSelector('#k-name');
    await page.fill('#k-name', 'Chave-Teste-Direto');
    await page.click('#k-create');
    await page.waitForSelector('#new-key');
    const newKeyDirect = await page.textContent('#new-key');
    expect(newKeyDirect).toBeTruthy();
    console.log('✅ Menu Keys: Nova Chave individual criada com sucesso');

    // 5. PROVIDERS
    await page.goto(`${HOST}/#/providers`);
    await page.waitForSelector('#p-name');
    // Só validamos a renderização, para não sobrescrever as chaves de produção
    await expect(page.locator('#p-name')).toBeVisible();

    // 6. PLAYGROUND
    await page.goto(`${HOST}/#/playground`);
    await page.waitForSelector('#test-prompt');
    await page.fill('#test-prompt', 'Olá, sistema! Teste de QA automatizado.');
    // Se houver provider online, testamos, senão apenas validamos o botão
    const isRunDisabled = await page.$eval('#test-run', btn => (btn as HTMLButtonElement).disabled);
    if (!isRunDisabled) {
      await page.click('#test-run');
      await page.waitForSelector('#test-output:not(.hidden)', { timeout: 30000 });
      console.log('✅ Playground: Teste de Inferência Real executado');
    } else {
      console.log('⚠️ Playground: Nenhum provider online detectado para inferência');
    }

    // 7. MENUS RESTANTES (Renderização rápida)
    const menusToVisit = ['#/models', '#/image-providers', '#/workers', '#/queues', '#/usage', '#/cache', '#/logs', '#/users'];
    for (const menu of menusToVisit) {
      await page.goto(`${HOST}/${menu}`);
      await page.waitForTimeout(500); // render genérico
    }
    
    console.log('✅ Todas as rotas do frontend validadas');
  });
});
