const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'test-results/front-production-audit');
fs.mkdirSync(out, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(x => x && !x.startsWith('#') && x.includes('=')).map(x => { const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1).replace(/^['"]|['"]$/g,'')]; }));
const host = process.env.TEST_HOST || 'http://localhost:8080';
const report = { date: new Date().toISOString(), host, routes: [], checks: [], errors: [], httpErrors: [], findings: [] };
let page, browser, phase='startup';
const save = () => { for(let attempt=0;attempt<8;attempt++){try {fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2));return;}catch(e){if(attempt===7)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}} };
async function check(name, fn) {
  phase=name;
  try { await fn(); report.checks.push({name,pass:true}); console.log('PASS',name); }
  catch(e) { report.checks.push({name,pass:false,error:e.message.slice(0,700)}); console.log('FAIL',name,e.message.slice(0,220)); await page.screenshot({path:path.join(out,`failure-${report.checks.length}.png`)}).catch(()=>{}); }
  save();
}
async function nav(route) {
  const previousHash=await page.evaluate(()=>location.hash);
  const oldHandle=await page.locator('#content > *').first().elementHandle();
  const link=page.locator(`nav a[href="${route}"]`);
  const group=link.locator('xpath=ancestor::section[contains(@class,"nav-group")]');
  if(await group.count() && !(await group.getAttribute('class')).includes('open')) await group.locator('button.nav-group-toggle').click();
  if(await page.locator('#sidebar-toggle').isVisible() && !(await page.locator('#sidebar').getAttribute('class')).includes('mobile-open')) await page.locator('#sidebar-toggle').click();
  await link.click();
  await page.waitForFunction(r=>location.hash===r,route);
  if(previousHash!==route && oldHandle) await page.waitForFunction(e=>!e.isConnected,oldHandle);
  await page.waitForFunction(() => document.querySelector('#content')?.innerText.trim().length>0 && !/Carregando|CARREGANDO/.test(document.querySelector('#content').innerText),null,{timeout:25000});
  await page.locator('#content h1').waitFor();
}
(async()=>{
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  page.on('pageerror',e=>report.errors.push({phase,error:e.message}));
  page.on('response',r=>{if(r.status()>=400) report.httpErrors.push({phase,url:new URL(r.url()).pathname,status:r.status(),method:r.request().method()});});
  page.on('dialog',d=>d.dismiss());
  await page.goto(host);
  await check('login: senha visível/oculta e credencial inválida',async()=>{
    await page.fill('#login-password','qa-invalid-password');await page.click('#toggle-password');assert.equal(await page.locator('#login-password').getAttribute('type'),'text');await page.click('#toggle-password');
    await page.click('#btn-login-submit');await page.locator('#login-error:not(.hidden)').waitFor();assert(await page.locator('#btn-login-submit').isEnabled());
  });
  await check('login real e dashboard',async()=>{
    await page.fill('#login-email',env.ADMIN_EMAIL);await page.fill('#login-password',env.ADMIN_PASSWORD);await page.click('#btn-login-submit');await page.locator('#shell:not(.hidden)').waitFor();await page.locator('#home-providers-table tbody tr').first().waitFor({timeout:25000});
  });
  if(!await page.locator('#shell').isVisible()) throw new Error('Login real indisponível');
  const routes=await page.locator('nav a[href^="#/"]').evaluateAll(a=>a.map(x=>({route:x.getAttribute('href'),name:x.innerText.trim()})));
  for(const entry of routes){
    await check(`desktop ${entry.route}`,async()=>{
      await nav(entry.route);
      const content=await page.locator('#content').innerText();
      const controls=await page.locator('#content button,#content input,#content select,#content a').evaluateAll(es=>es.map(e=>({tag:e.tagName,id:e.id,text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,80),type:e.type,disabled:e.disabled})));
      const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      report.routes.push({...entry,heading:await page.locator('#content h1').innerText(),content:content.slice(0,15000),controls,desktopOverflow:overflow.scroll>overflow.width+1});
      await page.screenshot({path:path.join(out,`${entry.route.slice(2)}-desktop.png`),fullPage:true});
      assert(!/\b(undefined|NaN)\b/.test(content),'Valores inválidos na interface');
      assert(!/^Erro[: ]|\nErro[: ]/.test(content),'Tela apresenta erro da API');
    });
  }
  await page.setViewportSize({width:390,height:844});
  for(const entry of routes){
    await check(`mobile ${entry.route}`,async()=>{
      await nav(entry.route);
      const dims=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      const r=report.routes.find(r=>r.route===entry.route);if(r) r.mobileOverflow=dims.scroll>dims.width+1;
      await page.screenshot({path:path.join(out,`${entry.route.slice(2)}-mobile.png`),fullPage:true});
      assert(dims.scroll<=dims.width+1,`Overflow horizontal: ${dims.scroll}px em ${dims.width}px`);
      assert(!(await page.locator('#sidebar').getAttribute('class')).includes('mobile-open'),'Menu permanece aberto após clique');
    });
  }
  await page.setViewportSize({width:1440,height:1000});
  await check('logout e bloqueio depois de recarregar',async()=>{await page.click('#logout');await page.locator('#login:not(.hidden)').waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('apiplatform_token')),null);await page.reload();await page.locator('#login:not(.hidden)').waitFor();});
})().catch(e=>{report.fatal=e.message;console.error(e.message);process.exitCode=1}).finally(async()=>{save();if(browser) await browser.close();console.log('REPORT',out);});
