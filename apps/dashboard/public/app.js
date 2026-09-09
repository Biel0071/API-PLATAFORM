/* API Platform — Dashboard administrativo (SPA sem build) */
(() => {
  'use strict';

  const API = ''; // mesmo host da API (servido em /dashboard) ou proxy nginx
  const $ = (sel) => document.querySelector(sel);
  const content = () => $('#content');
  let viewController = new AbortController();
  let viewTimer;
  const scheduleView = (callback, delay) => { clearTimeout(viewTimer); viewTimer = setTimeout(callback, delay); };
  const isViewStale = (controller = viewController) => controller.signal.aborted;
  const showFieldError = (selector, message) => { const el = $(selector); if (el) { el.textContent = message; el.className = 'error'; } };

  // ---------- Auth ----------
  const token = () => localStorage.getItem('apiplatform_token');
  const setToken = (t) => localStorage.setItem('apiplatform_token', t);
  const clearToken = () => localStorage.removeItem('apiplatform_token');

  async function api(path, options = {}) {
    let res;
    const requestController = viewController;
    try {
      res = await fetch(API + path, {
      signal: requestController.signal,
      ...options,
      headers: {
        // content-type: application/json SO quando ha body. Fastify rejeita
        // POST sem body se o content-type for json ("Body cannot be empty").
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(token() ? { authorization: `Bearer ${token()}` } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || requestController.signal.aborted) {
        // A request from a previous view may finish after navigation. Keep that
        // stale promise pending so its catch handler cannot overwrite the new
        // screen with a misleading error message.
        return new Promise(() => {});
      }
      throw error;
    }
    if (res.status === 401) {
      clearToken();
      showLogin();
      throw new Error('sessao expirada');
    }
    const data = await res.json().catch(() => {
      if (requestController.signal.aborted) {
        return new Promise(() => {});
      }
      throw new Error(`Resposta inválida da API (HTTP ${res.status})`);
    });
    if (!res.ok || (data.success === false && path !== '/v1/health')) throw new Error(data?.error?.message || (typeof data?.error === 'string' ? data.error : `Erro HTTP ${res.status}`));
    return data;
  }

  function showLogin() {
    viewController.abort();
    clearTimeout(viewTimer);
    $('#login').classList.remove('hidden');
    $('#shell').classList.add('hidden');
  }
  function showShell() {
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    route();
  }

  $('#toggle-password').addEventListener('click', () => {
    const field = $('#login-password');
    const button = $('#toggle-password');
    const visible = field.type === 'text';
    field.type = visible ? 'password' : 'text';
    button.textContent = visible ? 'Mostrar' : 'Ocultar';
    button.setAttribute('aria-label', visible ? 'Mostrar senha' : 'Ocultar senha');
    button.setAttribute('aria-pressed', String(!visible));
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    const btn = $('#login-form button[type="submit"]');
    errEl.classList.add('hidden');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      const data = await fetch(API + '/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          login: $('#login-email').value.trim(),
          password: $('#login-password').value,
        }),
      }).then((r) => r.json());
      if (!data.token) throw new Error(data?.error?.message || 'credenciais invalidas');
      setToken(data.token);
      toast('Login efetuado com sucesso!', 'success');
      showShell();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      toast(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  });

  $('#logout').addEventListener('click', () => {
    clearToken();
    showLogin();
  });

  let navState;
  try { navState = JSON.parse(localStorage.getItem('apiplatform_nav') || '{}') || {}; } catch { navState = {}; }
  document.querySelectorAll('.nav-group').forEach((group) => {
    const name = group.dataset.group;
    group.classList.toggle('open', Boolean(navState[name]));
    group.querySelector('.nav-group-toggle').addEventListener('click', () => {
      navState[name] = !group.classList.contains('open');
      group.classList.toggle('open', navState[name]);
      localStorage.setItem('apiplatform_nav', JSON.stringify(navState));
    });
  });

  // ---------- Sound System & Tactile Clicks (Web Audio API) ----------
  let soundEnabled = localStorage.getItem('apiplatform_sound') !== 'false';
  let audioCtx = null;
  function playClickSound(type = 'click') {
    if (!soundEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      if (type === 'success') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === 'error') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.15);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.15);
      } else {
        // High-tech tactile switch click (10ms)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, now);
        osc.frequency.exponentialRampToValueAtTime(450, now + 0.02);
        gain.gain.setValueAtTime(0.035, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.02);
      }
    } catch (e) {}

    if (navigator.vibrate) {
      try { navigator.vibrate(8); } catch(e) {}
    }
  }

  function updateSoundButton() {
    const icon = $('#sound-icon');
    if (icon) icon.textContent = soundEnabled ? '🔊' : '🔇';
    const btn = $('#toggle-sound');
    if (btn) btn.title = soundEnabled ? 'Som dos cliques ativado (Clique para silenciar)' : 'Som dos cliques silenciado (Clique para ativar)';
  }

  // ---------- Toast Notification System ----------
  function toast(message, type = 'success', duration = 3200) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
    el.innerHTML = '<span style="font-size:1.15rem; font-weight:800; line-height:1; color:' + (type === 'success' ? '#34d399' : type === 'error' ? '#f87171' : '#60a5fa') + ';">' + icon + '</span><span>' + esc(message) + '</span>';
    container.appendChild(el);
    playClickSound(type === 'error' ? 'error' : 'success');
    setTimeout(() => {
      el.style.animation = 'toastSlideOut 0.25s forwards';
      setTimeout(() => el.remove(), 250);
    }, duration);
  }

  // ---------- Copy To Clipboard Helper ----------
  async function copyToClipboard(text, btnElement, successText = 'Copiado!') {
    try {
      await navigator.clipboard.writeText(text);
      if (btnElement) {
        const original = btnElement.textContent;
        btnElement.textContent = '✓ ' + successText;
        btnElement.classList.add('ok');
        setTimeout(() => {
          btnElement.textContent = original;
          btnElement.classList.remove('ok');
        }, 2000);
      }
      toast('Copiado para a área de transferência!', 'success');
    } catch (err) {
      toast('Erro ao copiar', 'error');
    }
  }

  // ---------- Global Tactile Click Ripple Effect ----------
  document.addEventListener('click', (e) => {
    // Only target interactive clickable items (NO .card or text inputs)
    const target = e.target.closest('button, .btn, .nav-primary, .nav-submenu a, .btn-icon, .badge.clickable, [role="button"]');
    if (!target) return;
    if (target.disabled || target.hasAttribute('disabled') || target.classList.contains('disabled')) return;

    playClickSound('click');

    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'click-ripple';
    const size = Math.max(rect.width, rect.height) * 2;
    ripple.style.width = ripple.style.height = size + 'px';

    let x = e.clientX;
    let y = e.clientY;
    if (!x || !y || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }

    ripple.style.left = (x - rect.left - size / 2) + 'px';
    ripple.style.top = (y - rect.top - size / 2) + 'px';
    target.appendChild(ripple);
    setTimeout(() => ripple.remove(), 550);
  });

  // ---------- Helpers de UI ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const card = (label, value, cls = '') =>
    `<div class="card"><div class="label">${esc(label)}</div><div class="value ${cls}">${esc(value)}</div></div>`;

  const badge = (ok, textOk = 'online', textErr = 'offline') =>
    ok ? `<span class="badge ok">${textOk}</span>` : `<span class="badge err">${textErr}</span>`;

  const table = (headers, rows) => {
    const emptyRow = `<tr><td colspan="${headers.length}" class="table-empty-cell"><span class="table-empty-icon">📂</span>Nenhum registro encontrado</td></tr>`;
    return `<div class="table-container"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
           `<tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') : emptyRow}</tbody></table></div>`;
  };
  const fmtDate = (d) => (d ? new Date(d).toLocaleString('pt-BR') : '—');
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  const fileDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
  });
  const imageActions = [
    ['custom','Personalizado'],['new-angle','Novo angulo'],['new-position','Nova posicao'],['new-lighting','Nova iluminacao'],
    ['new-color','Nova cor'],['new-background','Novo fundo'],['new-clothing','Nova roupa'],['model-wearing','Modelo vestindo'],
    ['catalog','Catalogo'],['mockup','Mockup'],['lifestyle','Lifestyle'],['marketplace','Marketplace'],
  ];
  const renderGenerated = (data) => data.jobId
    ? `<pre class="code">Job criado: ${esc(data.jobId)}\nAcompanhe em Image Queue.</pre>`
    : `<div class="image-grid">${(data.result?.images||[]).map((img)=>`<article class="card"><img src="data:${img.mimeType||'image/png'};base64,${img.base64}" /><a href="${img.url||'#'}" class="muted">${esc(data.provider)} / ${esc(data.model)}</a></article>`).join('')}</div>`;

  // ---------- Paginas ----------
  const pages = {
    async home() {
      const homeView = viewController;
      content().innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h1>Visao Geral do Sistema</h1>
          <div id="live-status" class="badge">CONSULTANDO</div>
        </div>
        <div class="cards">
          <div class="card"><div class="label">Latencia Global</div><div class="value" id="home-latency">—</div></div>
          <div class="card"><div class="label">Requests (24h)</div><div class="value" id="home-reqs">0</div></div>
          <div class="card"><div class="label">Tokens (24h)</div><div class="value" id="home-tokens">0</div></div>
          <div class="card"><div class="label">Custo (24h)</div><div class="value" id="home-cost">$0.00</div></div>
          <div class="card"><div class="label">Tenants Ativos</div><div class="value" id="home-tenants">0</div></div>
          <div class="card"><div class="label">Uptime</div><div class="value" id="home-uptime">0s</div></div>
          <div class="card"><div class="label">Memoria</div><div class="value" id="home-mem">0MB</div></div>
          <div class="card"><div class="label">Workers</div><div class="value ok" id="home-workers">0</div></div>
        </div>
        <div class="section" style="margin-top:2rem;">
          <h2>Modulos da Plataforma</h2>
          <div class="cards" id="home-modules"></div>
        </div>
        <div class="section">
          <h2>Providers em Tempo Real</h2>
          <div class="table-container">
            <table id="home-providers-table">
              <thead><tr><th>Provider</th><th>Status</th><th>Latencia</th><th>Requests</th><th>Tokens</th><th>Custo (USD)</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>`;


      const updateHome = async () => {
        if (location.hash.replace('#/', '') !== 'home' && location.hash !== '') return;
        try {
          const [ { overview }, health ] = await Promise.all([
            api('/admin/overview'),
            api('/v1/health')
          ]);

          if ($('#home-latency')) {
            const latency = health.latency || overview.last24h.avgDurationMs;
            $('#home-latency').textContent = latency + 'ms';
            $('#home-reqs').textContent = overview.last24h.requests;
            $('#home-tokens').textContent = overview.last24h.totalTokens;
            $('#home-cost').textContent = '$' + Number(overview.last24h.cost).toFixed(4);
            $('#home-tenants').textContent = overview.tenants;
            $('#home-uptime').textContent = (health.uptime || 0) + 's';
            $('#home-mem').textContent = health.memory ? health.memory.free + 'MB livres' : 'OK';
            $('#home-workers').textContent = health.workers ?? '—';
            $('#live-status').textContent = health.status;
            $('#live-status').className = health.success ? 'badge ok' : 'badge err';

            const mods = ['API','Dashboard','Postgres','Redis','Mission','Streaming','Docker','SSL'];
            $('#home-modules').innerHTML = mods.map(m => card(m, health[m.toLowerCase()] ? 'ONLINE' : (health.checks?.[m.toLowerCase()] ? 'ONLINE' : 'N/A'), health[m.toLowerCase()] ? 'ok' : '')).join('');

            const tbody = $('#home-providers-table tbody');
            if (tbody && health.providers) {
              tbody.innerHTML = Object.entries(health.providers).map(([name, p]) =>
                `<tr>
                  <td><strong>${esc(name)}</strong></td>
                  <td><span class="badge ${p.status === 'ONLINE' ? 'ok' : ''}">${esc(p.status || 'UNKNOWN')}</span></td>
                  <td>${p.latency == null ? '—' : fmtMs(p.latency)}</td>
                  <td>${p.requests ?? '—'}</td>
                  <td>${p.tokens ?? '—'}</td>
                  <td>${p.cost == null ? '—' : '$' + Number(p.cost).toFixed(4)}</td>
                </tr>`
              ).join('');
            }
          }
        } catch (e) {
          if (homeView.signal.aborted) return;
          if ($('#live-status')) { $('#live-status').textContent = 'DADOS INDISPONÍVEIS'; $('#live-status').className = 'badge err'; }
        }
        if (!homeView.signal.aborted) scheduleView(updateHome, 5000);
      };
      await updateHome();
    },

    async projects() {
      content().innerHTML = '<h1>Projetos</h1><p class="muted">Carregando...</p>';
      try {
        const [{ projects }, { tenants }, { providers }] = await Promise.all([
          api('/admin/projects'), api('/admin/tenants'), api('/admin/providers')
        ]);
        const renderList = () => {
          content().innerHTML = `
            <div class="toolbar" style="justify-content: space-between; align-items: center; margin-bottom: 2rem;">
              <h1 style="margin:0;">Projetos</h1>
              <button id="btn-new-project" class="ok" style="padding: 10px 20px; font-weight:bold;">Novo Projeto</button>
            </div>
            <div class="cards" id="projects-list">
              ${projects.length === 0 ? '<p class="muted">Nenhum projeto cadastrado.</p>' : ''}
              ${projects.map(p => `
                <div class="card project-card" data-project-id="${esc(p.id)}" style="cursor:pointer; position:relative; overflow:hidden;" role="link" tabindex="0">
                  <div style="position:absolute; top:0; left:0; width:4px; height:100%; background:var(--accent);"></div>
                  <h3>${esc(p.name)}</h3>
                  <p class="muted">${esc(p.tenant?.name || 'Sem tenant')}</p>
                  <div style="margin-top:1rem;">${badge(p.active)} <span class="muted" style="margin-left:8px; font-size:0.8rem;">${p._count?.apiKeys || 0} chaves</span></div>
                </div>
              `).join('')}
            </div>
          `;
          $('#btn-new-project').addEventListener('click', renderWizard);
          document.querySelectorAll('.project-card').forEach((cardEl) => {
            const open = () => { location.hash = '#/project/' + encodeURIComponent(cardEl.dataset.projectId); };
            cardEl.addEventListener('click', open);
            cardEl.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
          });
        };

        const renderWizard = () => {
          content().innerHTML = `
            <h1>Novo Projeto (Wizard)</h1>
            <div class="card section" id="wizard-container" style="max-width:800px; margin: 2rem auto;">

              <!-- 4-Step Progress Stepper -->
              <div class="wizard-steps">
                <div id="ws-step-1" class="wizard-step-item active"><span class="step-num">1</span> Definição</div>
                <span class="step-arrow">→</span>
                <div id="ws-step-2" class="wizard-step-item"><span class="step-num">2</span> Provisionamento</div>
                <span class="step-arrow">→</span>
                <div id="ws-step-3" class="wizard-step-item"><span class="step-num">3</span> Provedores</div>
                <span class="step-arrow">→</span>
                <div id="ws-step-4" class="wizard-step-item"><span class="step-num">4</span> Concluído</div>
              </div>

              <div id="step-1" class="wizard-step">
                <h2>Passo 1: Definir Projeto</h2>
                <div class="form-grid">
                  <label>Nome do Projeto <input id="w-name" placeholder="Ex: SaaS Marketing API" /></label>
                  <label>Tenant (Loja)
                    <select id="w-tenant">
                      ${tenants.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
                    </select>
                  </label>
                  <label>Ambiente <select id="w-env"><option value="live">Produção (Live)</option><option value="test">Teste (Dev / QA)</option><option value="dev">Desenvolvimento</option></select></label>
                  <label>Domínio Customizado <input id="w-domain" placeholder="api.empresa.com" /></label>
                </div>
                <div class="toolbar" style="margin-top: 2rem; justify-content: flex-end;"><button id="btn-step-1">Gerar Infraestrutura →</button></div>
              </div>

              <div id="step-2" class="wizard-step hidden">
                <h2>Passo 2: Projeto e chave</h2>
                <p class="muted">Projeto e credencial foram criados pela API. Recursos compartilhados aparecem no estado real do sistema.</p>
                <pre class="code" id="w-infra-log">Aguardando...</pre>
                <div id="w-keys-box" class="hidden">
                  <p><strong>Chave principal gerada para este ambiente (Copie agora):</strong></p>
                  <pre class="code" id="w-api-key" style="color:var(--accent); font-weight:bold;"></pre>
                  <p><strong>URLs oficiais de acesso:</strong></p>
                  <pre class="code" id="w-urls"></pre>
                </div>
                <div class="toolbar" style="margin-top: 2rem; justify-content: flex-end;"><button id="btn-step-2" disabled>Avançar para Providers →</button></div>
              </div>

              <div id="step-3" class="wizard-step hidden">
                <h2>Passo 3: Providers & Teste</h2>
                <p>Estes provedores globais estão disponíveis para este tenant. O sistema executará fallbacks automáticos em caso de falha.</p>
                <div class="table-container">
                  <table>
                    <thead><tr><th>Provider</th><th>Status</th><th>Modelos Disponíveis</th></tr></thead>
                    <tbody>
                      ${providers.map(p => `<tr><td><strong>${esc(p.name)}</strong></td><td>${badge(p.health?.ok)}</td><td>${p.models?.length || 0} modelos</td></tr>`).join('')}
                    </tbody>
                  </table>
                </div>
                <div class="toolbar" style="margin-top: 2rem; justify-content: flex-end;"><button id="btn-step-3">Finalizar Projeto →</button></div>
              </div>

              <div id="step-4" class="wizard-step hidden">
                <h2 style="color:var(--success);">Concluído! Projeto criado</h2>
                <p class="muted">O registro e a chave foram criados. Verifique Health e Workers para o estado operacional atual.</p>
                <div class="cards" style="margin-top:2rem;">
                  ${card('Projeto', 'Criado', 'ok')}
                  ${card('Chave', 'Gerada', 'ok')}
                  ${card('Infraestrutura', 'Verificar em Health')}
                </div>
                <div class="toolbar" style="margin-top: 2rem; justify-content: center;"><button id="wizard-project-link" class="ghost" style="border: 1px solid var(--accent); color:var(--accent);">Ir para Dashboard do Projeto</button></div>
              </div>
            </div>
          `;

          let newProject = null;
          let newKey = null;

          const setStep = (num) => {
            for (let i = 1; i <= 4; i++) {
              const el = $('#step-' + i);
              const ws = $('#ws-step-' + i);
              if (el) el.classList.toggle('hidden', i !== num);
              if (ws) {
                ws.classList.toggle('active', i === num);
                ws.classList.toggle('completed', i < num);
              }
            }
          };

          $('#btn-step-1').addEventListener('click', async () => {
            const btn = $('#btn-step-1'); btn.disabled = true; btn.classList.add('loading'); btn.textContent = 'Criando infraestrutura...';
            try {
              const res = await api('/admin/projects', {
                method: 'POST',
                body: { name: $('#w-name').value, tenantId: $('#w-tenant').value, domain: $('#w-domain').value }
              });
              newProject = res.project;

              const keyRes = await api('/admin/api-keys', {
                method: 'POST',
                body: { name: 'key-' + $('#w-env').value, tenantId: $('#w-tenant').value, projectId: newProject.id, environment: $('#w-env').value, scopes: ['text','chat','image','vision','embed','ocr','workflow'] }
              });
              newKey = keyRes.key;

              setStep(2);
              toast('Projeto criado com sucesso!', 'success');
              $('#w-infra-log').textContent = `[OK] Project ID: ${newProject.id}\n[OK] Tenant ID: ${newProject.tenantId}\n[OK] API key registrada`;
              $('#w-keys-box').classList.remove('hidden');
              $('#w-api-key').textContent = newKey;
              $('#w-urls').textContent = `API Gateway: ${location.origin}/v1\nSwagger: ${location.origin}/docs/`;
              $('#btn-step-2').disabled = false;
              $('#wizard-project-link').onclick = () => { location.hash = '#/project/' + newProject.id; };
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false; btn.classList.remove('loading'); btn.textContent = 'Gerar Infraestrutura →';
            }
          });

          $('#btn-step-2').addEventListener('click', () => {
            setStep(3);
          });

          $('#btn-step-3').addEventListener('click', () => {
            setStep(4);
          });
        };
        renderList();
      } catch (err) {
        content().innerHTML = `<p class="error">Erro ao carregar projetos: ${esc(err.message)}</p>`;
      }
    },

    async projectDetails(projectId) {
      content().innerHTML = '<h1>Projeto</h1><p class="muted">Carregando...</p>';
      try {
        const { projects } = await api('/admin/projects');
        const project = projects.find((item) => item.id === projectId);
        if (!project) { content().innerHTML = '<h1>Projeto não encontrado</h1><a class="button-link" href="#/projects">Voltar aos projetos</a>'; return; }
        content().innerHTML = `<div id="project-details"><div class="toolbar" style="justify-content:space-between"><h1>${esc(project.name)}</h1><a class="button-link" href="#/projects">Voltar</a></div><div class="cards">${card('Status', project.active ? 'Ativo' : 'Inativo', project.active ? 'ok' : 'error')}${card('Tenant', project.tenant?.name || '—')}${card('API Keys', project._count?.apiKeys || 0)}</div><div class="card section"><h2>Configuração</h2><p>Domínio: <code>${esc(project.domain || 'não configurado')}</code></p><p>Criado em: ${fmtDate(project.createdAt)}</p></div></div>`;
      } catch (err) {
        if (isViewStale()) return;
        content().innerHTML = `<h1>Projeto</h1><p class="error">Erro ao carregar: ${esc(err.message)}</p>`;
      }
    },

    async providers() {
      content().innerHTML = '<h1>Providers</h1><p class="muted">Carregando conexoes...</p>';
      let providers, defaults, configs;
      try {
        const [res1, res2] = await Promise.all([
          api('/admin/providers'), api('/admin/provider-configs'),
        ]);
        providers = res1.providers; defaults = res1.defaults; configs = res2.configs;
      } catch (err) {
        toast(err.message, 'error');
        content().innerHTML = `<h1>Providers</h1><p class="error">Erro ao carregar providers: ${esc(err.message)}</p>`;
        return;
      }
      const configByName = Object.fromEntries(configs.map((c) => [c.name, c]));
      const choices = ['ollama', 'groq', 'gemini', 'openrouter', 'huggingface', 'cloudflare', 'lmstudio', 'comfyui', 'forge', 'invokeai'];
      content().innerHTML = `
        <h1>Providers</h1>
        <p class="muted">Cadastre as credenciais aqui. Segredos sao criptografados e nunca retornam pela API.</p>
        <div class="card section">
          <h2>Conectar provider</h2>
          <div class="form-grid">
            <label>Provider <select id="p-name">${choices.map((name) => `<option value="${name}">${name}</option>`).join('')}</select></label>
            <label>Endpoint / Base URL <input id="p-url" placeholder="https://..." /></label>
            <label>API key / Token <input id="p-key" type="password" autocomplete="new-password" placeholder="deixe vazio para manter a atual" /></label>
            <label>Account ID (Cloudflare) <input id="p-account" /></label>
            <label>Modelo padrao <input id="p-model" placeholder="llama-3.1-8b-instant" /></label>
            <label>Modelo embeddings <input id="p-embed" /></label>
            <label class="inline-check"><input id="p-enabled" type="checkbox" checked /> Ativo</label>
          </div>
          <div class="toolbar"><button id="p-save">Salvar e ativar</button><span id="p-result" class="muted"></span></div>
        </div>
        <p class="muted">Defaults: ${esc(JSON.stringify(defaults))}</p>
        ${table(
          ['Provider', 'Configurado', 'Status', 'Latencia', 'Capacidades', 'Modelos', 'Acoes'],
          choices.map((name) => {
            const live = providers.find((p) => p.name === name);
            const cfg = configByName[name];
            return [
              `<strong>${esc(name)}</strong>`, cfg ? badge(cfg.enabled, 'ativo', 'desativado') : '<span class="muted">.env/nao salvo</span>',
              live ? badge(live.health.ok) : badge(false, 'online', 'nao registrado'),
              live?.health?.latencyMs != null ? fmtMs(live.health.latencyMs) : '—',
              esc(live?.capabilities?.join(', ') || '—'), live?.models?.length ?? 0,
              `<button class="ghost" data-edit-provider="${name}">Editar</button> <button class="ghost" data-test-provider="${name}" ${live ? '' : 'disabled'}>Testar</button>`,
            ];
          }),
        )}`;

      const fillProvider = (name) => {
        const cfg = configByName[name];
        $('#p-name').value = name;
        $('#p-url').value = cfg?.settings?.baseUrl || cfg?.baseUrl || '';
        $('#p-key').value = '';
        $('#p-key').placeholder = cfg?.hasApiKey ? 'credencial salva (deixe vazio para manter)' : 'cole a API key/token';
        $('#p-account').value = cfg?.settings?.accountId || '';
        $('#p-model').value = cfg?.settings?.defaultModel || '';
        $('#p-embed').value = cfg?.settings?.embedModel || '';
        $('#p-enabled').checked = cfg?.enabled ?? true;
      };
      $('#p-name').addEventListener('change', (e) => fillProvider(e.target.value));
      fillProvider($('#p-name').value);
      $('#p-save').addEventListener('click', async () => {
        const result = $('#p-result'); result.textContent = 'Salvando...'; result.className = 'muted';
        try {
          const data = await api('/admin/provider-configs', { method: 'POST', body: {
            name: $('#p-name').value, enabled: $('#p-enabled').checked,
            baseUrl: $('#p-url').value.trim(), apiKey: $('#p-key').value.trim(),
            accountId: $('#p-account').value.trim(), defaultModel: $('#p-model').value.trim(),
            embedModel: $('#p-embed').value.trim(),
          }});
          result.textContent = data.registered ? 'Salvo e registrado.' : 'Salvo, mas faltam campos obrigatorios.';
          result.className = data.registered ? 'ok' : 'warn';
          scheduleView(() => pages.providers().catch(error => toast(error.message, 'error')), 700);
        } catch (err) { result.textContent = err.message; result.className = 'error'; }
      });
      content().querySelectorAll('[data-edit-provider]').forEach((btn) => btn.addEventListener('click', () => fillProvider(btn.dataset.editProvider)));
      content().querySelectorAll('[data-test-provider]').forEach((btn) => btn.addEventListener('click', async () => {
        const result = $('#p-result'); result.textContent = `Testando ${btn.dataset.testProvider}...`; result.className = 'muted';
        try { const data = await api(`/admin/provider-configs/${btn.dataset.testProvider}/test`, { method: 'POST' }); result.textContent = `Online (${fmtMs(data.health.latencyMs)})`; result.className = 'ok'; }
        catch (err) { result.textContent = `Falha: ${err.message}`; result.className = 'error'; }
      }));
    },
    async models() {
      content().innerHTML = '<h1>Modelos</h1><p class="muted">Carregando modelos...</p>';
      let live, configured;
      try {
        const [res1, res2] = await Promise.all([
          api('/admin/providers'),
          api('/admin/models'),
        ]);
        live = res1.providers; configured = res2.providers;
      } catch (err) {
        toast(err.message, 'error');
        content().innerHTML = `<h1>Modelos</h1><p class="error">Erro ao carregar modelos: ${esc(err.message)}</p>`;
        return;
      }
      const liveRows = live.flatMap((p) =>
        p.models.map((m) => [esc(p.name), esc(m.id), esc(m.name || ''), m.sizeBytes ? (m.sizeBytes / 1e9).toFixed(1) + ' GB' : '—']),
      );
      const costRows = configured.flatMap((p) =>
        p.models.map((m) => [esc(p.name), esc(m.modelId), esc(m.capability), '$' + m.costPer1kInput, '$' + m.costPer1kOutput]),
      );
      content().innerHTML = `
        <h1>Modelos</h1>
        <div class="section"><h2>Detectados nos providers</h2>${table(['Provider', 'Modelo', 'Nome', 'Tamanho'], liveRows)}</div>
        <div class="section">
          <h2>Custos configurados (por 1k tokens)</h2>
          ${table(['Provider', 'Modelo', 'Capacidade', 'Input', 'Output'], costRows)}
          <div class="toolbar" style="margin-top:1rem">
            <label>Provider <input id="mc-provider" placeholder="openai" /></label>
            <label>Modelo <input id="mc-model" placeholder="gpt-4o-mini" /></label>
            <label>Custo input/1k <input id="mc-in" type="number" step="0.0001" value="0" /></label>
            <label>Custo output/1k <input id="mc-out" type="number" step="0.0001" value="0" /></label>
            <button id="mc-save">Salvar</button>
          </div>
        </div>`;
      $('#mc-save').addEventListener('click', async () => {
        const button = $('#mc-save');
        let status = $('#mc-status');
        if (!status) { status = document.createElement('span'); status.id = 'mc-status'; button.after(status); }
        if (!$('#mc-provider').value.trim() || !$('#mc-model').value.trim()) { status.textContent = 'Informe provider e modelo.'; status.className = 'error'; return; }
        button.disabled = true;
        try { await api('/admin/models', {
          method: 'POST',
          body: {
            provider: $('#mc-provider').value,
            modelId: $('#mc-model').value,
            costPer1kInput: Number($('#mc-in').value),
            costPer1kOutput: Number($('#mc-out').value),
          },
        }); status.textContent = 'Modelo salvo.'; status.className = 'ok'; pages.models();
        } catch (err) { status.textContent = err.message; status.className = 'error'; } finally { button.disabled = false; }
      });
    },

    async playground() {
      content().innerHTML = '<h1>Playground de IA</h1><p class="muted">Carregando providers...</p>';
      let providers;
      try {
        ({ providers } = await api('/admin/providers'));
      } catch (err) {
        toast(err.message, 'error');
        content().innerHTML = `<h1>Playground de IA</h1><p class="error">Erro ao carregar: ${esc(err.message)}</p>`;
        return;
      }
      const online = providers.filter((p) => p.health.ok && p.capabilities.includes('chat'));
      content().innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
          <div>
            <h1>Playground de IA</h1>
            <p class="muted">Execute uma chamada real de inferência antes de conectar seus projetos.</p>
          </div>
          <div class="badge ${online.length ? 'ok' : 'err'}">${online.length ? `${online.length} Providers Online` : 'Nenhum Provider Online'}</div>
        </div>
        <div class="card section" style="margin-top:1.5rem;">
          <h2>Executar Chamada Real</h2>
          <div class="form-grid">
            <label>Provider
              <select id="test-provider">
                <option value="">Automático (fallback em cascata)</option>
                ${providers.filter(p => p.capabilities.includes('chat')).map((p) => `<option value="${esc(p.name)}">${esc(p.name)} ${p.health.ok ? '✓ online' : '(offline)'}</option>`).join('')}
              </select>
            </label>
            <label>Modelo opcional <input id="test-model" placeholder="padrão do provider" /></label>
          </div>
          <label>Prompt <textarea id="test-prompt" rows="3">Responda apenas: sistema funcionando</textarea></label>
          <div class="toolbar" style="margin-top:1.25rem;">
            <button id="test-run" class="ok" ${online.length ? '' : 'disabled'}>⚡ Executar Teste</button>
            <span id="test-status" class="muted">${online.length ? `${online.length} provider(s) online` : 'Nenhum provider online'}</span>
          </div>
          <div id="test-output-box" style="margin-top:1.5rem;" class="hidden">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
              <span style="font-size:0.75rem; font-weight:700; text-transform:uppercase; color:var(--text-muted);">Resposta do Modelo</span>
              <button id="test-copy-btn" class="ghost sm">Copiar Resposta</button>
            </div>
            <pre id="test-output" class="code hidden"></pre>
          </div>
        </div>`;
      $('#test-run').addEventListener('click', async () => {
        const button = $('#test-run'); const status = $('#test-status'); const output = $('#test-output'); const box = $('#test-output-box');
        button.disabled = true; button.classList.add('loading'); status.textContent = 'Executando inferência real...'; status.className = 'muted';
        output.classList.add('hidden'); if (box) box.classList.add('hidden');
        try {
          const data = await api('/admin/test-text', { method: 'POST', body: {
            prompt: $('#test-prompt').value,
            provider: $('#test-provider').value || undefined,
            model: $('#test-model').value.trim() || undefined,
          }});
          status.textContent = `${data.provider} / ${data.model} / ${fmtMs(data.executionTime)}`; status.className = 'ok';
          output.textContent = data.result.text; output.classList.remove('hidden'); if (box) box.classList.remove('hidden');
          toast('Inferência executada em ' + fmtMs(data.executionTime), 'success');
          const copyBtn = $('#test-copy-btn');
          if (copyBtn) copyBtn.onclick = () => copyToClipboard(data.result.text, copyBtn);
        } catch (err) { status.textContent = err.message; status.className = 'error'; toast(err.message, 'error'); }
        finally { button.disabled = false; button.classList.remove('loading'); }
      });
    },

    async imageGenerate() {
      content().innerHTML = `<h1>Gerar Imagem</h1><div class="card"><div class="form-grid"><label>Acao <select id="ig-action">${imageActions.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><label>Provider <input id="ig-provider" placeholder="auto" /></label><label>Modelo <input id="ig-model" placeholder="auto" /></label><label>Largura <input id="ig-width" type="number" value="1024" /></label><label>Altura <input id="ig-height" type="number" value="1024" /></label></div><label>Prompt <textarea id="ig-prompt" placeholder="Descreva o produto e o resultado desejado"></textarea></label><button id="ig-run">Gerar imagem</button><span id="ig-status" class="muted"></span><div id="ig-output"></div></div>`;
      $('#ig-run').addEventListener('click',async()=>{const b=$('#ig-run'),s=$('#ig-status');if(!$('#ig-prompt').value.trim()){s.textContent='Informe um prompt para gerar a imagem.';s.className='error';return;}b.disabled=true;s.textContent='Gerando...';try{const d=await api('/admin/image/generate',{method:'POST',body:{operation:'text-to-image',action:$('#ig-action').value,prompt:$('#ig-prompt').value,provider:$('#ig-provider').value||'auto',model:$('#ig-model').value||undefined,width:Number($('#ig-width').value),height:Number($('#ig-height').value)}});$('#ig-output').innerHTML=renderGenerated(d);s.textContent='Concluido';s.className='ok';}catch(e){s.textContent=e.message;s.className='error';}finally{b.disabled=false;}});
    },

    async imageEdit() {
      content().innerHTML = `<h1>Imagem → Imagem</h1><div class="card"><div class="form-grid"><label>Imagem (jpg/png/jpeg/webp) <input id="ie-file" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" /></label><label>Acao <select id="ie-action">${imageActions.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><label>Forca <input id="ie-strength" type="number" min="0" max="1" step="0.05" value="0.6" /></label><label>Provider <input id="ie-provider" placeholder="auto" /></label><label>Modelo <input id="ie-model" placeholder="auto" /></label></div><label>Instrucao <textarea id="ie-prompt" placeholder="Ex.: trocar por fundo branco mantendo o produto identico"></textarea></label><button id="ie-run">Transformar imagem</button> <button id="ie-bg" class="ghost">Remover fundo</button> <button id="ie-up" class="ghost">Upscale 4x</button><span id="ie-status" class="muted"></span><div id="ie-output"></div></div>`;
      const run=async(operation)=>{const file=$('#ie-file').files[0],s=$('#ie-status');if(!file){s.textContent='Selecione uma imagem.';s.className='error';return;}const b=$('#ie-run');b.disabled=true;s.textContent='Processando...';try{const d=await api('/admin/image/generate',{method:'POST',body:{operation,action:$('#ie-action').value,prompt:$('#ie-prompt').value,image:await fileDataUrl(file),strength:Number($('#ie-strength').value),provider:$('#ie-provider').value||'auto',model:$('#ie-model').value||undefined}});$('#ie-output').innerHTML=renderGenerated(d);s.textContent='Concluido';s.className='ok';}catch(e){s.textContent=e.message;s.className='error';}finally{b.disabled=false;}};
      $('#ie-run').addEventListener('click',()=>void run('image-to-image'));$('#ie-bg').addEventListener('click',()=>void run('remove-background'));$('#ie-up').addEventListener('click',()=>void run('upscale'));
    },

    async videoAI() {
      content().innerHTML = `<h1>Video → Imagem</h1><div class="card"><div class="form-grid"><label>Video (mp4/mov/avi/mkv) <input id="vi-file" type="file" accept=".mp4,.mov,.avi,.mkv,video/mp4,video/quicktime" /></label><label>Frames <input id="vi-frames" type="number" min="1" max="20" value="4" /></label><label>Acao <select id="vi-action">${imageActions.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><label>Provider <input id="vi-provider" placeholder="auto" /></label><label>Modelo <input id="vi-model" placeholder="auto" /></label></div><label>Instrucao <textarea id="vi-prompt"></textarea></label><button id="vi-run">Enviar para fila</button><span id="vi-status" class="muted"></span><div id="vi-output"></div></div>`;
      $('#vi-run').addEventListener('click',async()=>{const file=$('#vi-file').files[0],b=$('#vi-run'),s=$('#vi-status');if(!file){s.textContent='Selecione um video';s.className='error';return;}b.disabled=true;s.textContent='Enviando...';try{const d=await api('/admin/image/generate',{method:'POST',body:{operation:'video-to-image',video:await fileDataUrl(file),prompt:$('#vi-prompt').value,action:$('#vi-action').value,frameCount:Number($('#vi-frames').value),provider:$('#vi-provider').value||'auto',model:$('#vi-model').value||undefined}});$('#vi-output').innerHTML=renderGenerated(d);s.textContent='Job criado';s.className='ok';}catch(e){s.textContent=e.message;s.className='error';}finally{b.disabled=false;}});
    },

    async imageProviders() {
      content().innerHTML = '<h1>Image Providers</h1><p class="muted">Carregando...</p>';
      try {
        const { providers } = await api('/admin/image/providers');
        content().innerHTML = `<h1>Image Providers</h1>${table(['Provider','Status','Latencia','Modelos','Fila'], providers.map((p) => [
          `<strong>${esc(p.name)}</strong>`, badge(p.health.ok), p.health.latencyMs != null ? fmtMs(p.health.latencyMs) : '—', p.models.length,
          p.queue ? `${p.queue.running} executando / ${p.queue.pending} aguardando` : '—',
        ]))}<p class="muted">Conexoes e credenciais sao configuradas na pagina Providers.</p>`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Image Providers</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async imageQueue() {
      content().innerHTML = '<h1>Image Queue</h1><p class="muted">Carregando...</p>';
      try {
        const { queue, jobs } = await api('/admin/image/queue');
        content().innerHTML = `<h1>Image Queue</h1><div class="cards">${card('Aguardando',queue?.waiting||0)}${card('Ativos',queue?.active||0)}${card('Concluidos',queue?.completed||0,'ok')}${card('Falhas',queue?.failed||0,queue?.failed?'error':'')}</div>${table(['Job','Status','Provider','Modelo','Duracao','Criado'],jobs.map((j)=>[esc(j.id.slice(0,10)),esc(j.status),esc(j.provider||'—'),esc(j.model||'—'),j.durationMs?fmtMs(j.durationMs):'—',fmtDate(j.createdAt)]))}`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Image Queue</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async imageHistory() {
      content().innerHTML = '<h1>Image History</h1><p class="muted">Carregando...</p>';
      try {
        const { images } = await api('/admin/image/history?limit=100');
        content().innerHTML = `<h1>Image History</h1><div class="image-grid">${images.map((img)=>`<article class="card">${img.url?`<img data-image-id="${esc(img.id)}" alt="${esc(img.prompt||img.kind)}" loading="lazy" />`:''}` +
          `<strong>${esc(img.kind)}</strong><span class="muted">${esc(img.provider)} / ${esc(img.model)}</span><small>${esc((img.prompt||'').slice(0,100))}</small><small>${fmtDate(img.createdAt)}</small></article>`).join('')||'<p class="muted">Nenhuma imagem gerada.</p>'}</div>`;
        await Promise.all(Array.from(content().querySelectorAll('[data-image-id]')).map(async (img) => {
          const res = await fetch(API + `/admin/image/${img.dataset.imageId}/file`, { headers: { authorization: `Bearer ${token()}` } });
          if (res.ok) img.src = URL.createObjectURL(await res.blob());
        }));
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Image History</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async imageModels() {
      content().innerHTML = '<h1>Image Models</h1><p class="muted">Carregando...</p>';
      try {
        const { providers } = await api('/admin/image/providers');
        const rows=providers.flatMap((p)=>p.models.map((m)=>[esc(p.name),esc(m.id),esc(m.name||m.id),esc((m.capabilities||['image']).join(', '))]));
        content().innerHTML=`<h1>Image Models</h1>${table(['Provider','Modelo','Nome','Capacidades'],rows)}`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Image Models</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async imageAnalytics() {
      content().innerHTML = '<h1>Image Analytics</h1><p class="muted">Carregando...</p>';
      try {
        const data=await api('/admin/image/analytics');
        content().innerHTML=`<h1>Image Analytics</h1><div class="cards">${card('Imagens geradas',data.total)}</div><div class="section"><h2>Por provider</h2>${table(['Provider','Total'],data.byProvider.map((x)=>[esc(x.provider),x._count._all]))}</div><div class="section"><h2>Por operacao</h2>${table(['Operacao','Total'],data.byKind.map((x)=>[esc(x.kind),x._count._all]))}</div>`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Image Analytics</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async workers() {
      content().innerHTML = '<h1>Workers</h1><p class="muted">Carregando...</p>';
      try {
        const { workers } = await api('/admin/workers');
        content().innerHTML = `
          <h1>Workers</h1>
          ${table(
            ['Host', 'Filas', 'Concorrencia', 'Status', 'Ultimo heartbeat'],
            workers.map((w) => [esc(w.hostname), esc(w.queues), w.concurrency, badge(w.online), fmtDate(w.lastHeartbeat)]),
          )}`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Workers</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async queues() {
      content().innerHTML = '<h1>Filas</h1><p class="muted">Carregando...</p>';
      try {
        const [{ queues }, { jobs }] = await Promise.all([api('/admin/queues'), api('/admin/jobs?limit=50')]);
        content().innerHTML = `
          <h1>Filas</h1>
          <div class="section">${table(
            ['Fila', 'Aguardando', 'Ativos', 'Concluidos', 'Falhas', 'Agendados'],
            queues.map((q) => [esc(q.name), q.waiting, q.active, q.completed, q.failed, q.delayed]),
          )}</div>
          <div class="section"><h2>Jobs recentes</h2>${table(
            ['Job', 'Fila', 'Status', 'Provider', 'Duracao', 'Criado', 'Erro'],
            jobs.map((j) => [
              esc(j.id.slice(0, 10)), esc(j.queue),
              `<span class="badge ${j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'err' : ''}">${esc(j.status)}</span>`,
              esc(j.provider || '—'), j.durationMs ? fmtMs(j.durationMs) : '—', fmtDate(j.createdAt),
              `<span class="error">${esc((j.error || '').slice(0, 80))}</span>`,
            ]),
          )}</div>`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Filas</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async usage() {
      content().innerHTML = '<h1>Tokens & Custos</h1><p class="muted">Carregando...</p>';
      try {
        const { usage } = await api('/admin/usage?days=30');
        const totalCost = usage.reduce((s, u) => s + u.cost, 0);
        const totalTokens = usage.reduce((s, u) => s + Number(u.totalTokens), 0);
        const totalReq = usage.reduce((s, u) => s + u.requests, 0);
        content().innerHTML = `
          <h1>Tokens &amp; Custos (30 dias)</h1>
          <div class="cards">
            ${card('Requisicoes', totalReq)}
            ${card('Tokens', totalTokens)}
            ${card('Custo (USD)', '$' + totalCost.toFixed(4))}
          </div>
          ${table(
            ['Dia', 'Tenant', 'Capacidade', 'Provider', 'Requisicoes', 'Cache', 'Tokens', 'Custo'],
            usage.map((u) => [
              new Date(u.day).toLocaleDateString('pt-BR'), esc(u.tenant?.name || u.tenantId),
              esc(u.capability), esc(u.provider), u.requests, u.cachedHits, esc(u.totalTokens),
              '$' + u.cost.toFixed(4),
            ]),
          )}`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Tokens & Custos</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async cache() {
      const { stats } = await api('/admin/cache');
      content().innerHTML = `
        <h1>Cache</h1>
        <div class="cards">
          ${card('Entradas persistidas', stats.entries)}
          ${card('Hits acumulados', stats.totalHits, 'ok')}
          ${card('Chaves no Redis', stats.redisKeys)}
        </div>
        <button id="cache-clear" class="danger">Limpar cache</button>`;
      $('#cache-clear').addEventListener('click', async () => {
        if (!confirm('Limpar o cache de respostas de IA (Redis + Postgres)?')) return;
        try {
          await api('/admin/cache', { method: 'DELETE' });
          toast('Cache de respostas limpo.');
          await pages.cache();
        } catch (error) { toast(error.message, 'error'); }
      });
    },

    async logs() {
      content().innerHTML = '<h1>Logs de requisicoes</h1><p class="muted">Carregando...</p>';
      try {
        const { logs } = await api('/admin/logs?limit=100');
        content().innerHTML = `
          <h1>Logs de requisicoes</h1>
          ${table(
            ['Quando', 'Capacidade', 'Provider', 'Modelo', 'Cache', 'Status', 'Tokens', 'Duracao', 'Custo'],
            logs.map((l) => [
              fmtDate(l.createdAt), esc(l.capability), esc(l.provider), esc(l.model),
              l.cached ? '<span class="ok">hit</span>' : '—',
              badge(l.success, 'ok', l.errorCode || 'erro'),
              l.totalTokens, fmtMs(l.durationMs), '$' + l.cost.toFixed(5),
            ]),
          )}`;
      } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Logs</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
    },

    async users() {
      content().innerHTML = '<h1>Usuarios</h1><p class="muted">Carregando...</p>';
      let users;
      try {
        ({ users } = await api('/admin/users'));
      } catch (err) {
        toast(err.message, 'error');
        content().innerHTML = `<h1>Usuarios</h1><p class="error">Erro: ${esc(err.message)}</p>`;
        return;
      }
      content().innerHTML = `
        <h1>Usuarios</h1>
        <div class="toolbar">
          <label>Email <input id="u-email" type="email" /></label>
          <label>Senha <input id="u-pass" type="password" /></label>
          <label>Perfil <select id="u-role"><option value="user">user</option><option value="admin">admin</option></select></label>
          <button id="u-create">Criar usuario</button>
        </div>
        ${table(
          ['Email', 'Nome', 'Perfil', 'Ativo', 'Criado'],
          users.map((u) => [esc(u.email), esc(u.name || '—'), esc(u.role), badge(u.active, 'sim', 'nao'), fmtDate(u.createdAt)]),
        )}`;
      $('#u-create').addEventListener('click', async () => {
        try {
          await api('/admin/users', {
            method: 'POST',
            body: { email: $('#u-email').value, password: $('#u-pass').value, role: $('#u-role').value },
          });
          toast('Usuário criado!', 'success');
          pages.users();
        } catch (e) { toast(e.message, 'error'); }
      });
    },

    async keys() {
      content().innerHTML = '<h1>API Keys</h1><p class="muted">Carregando...</p>';
      let keys, tenants, projects;
      try {
        const [r1, r2, r3] = await Promise.all([api('/admin/api-keys'), api('/admin/tenants'), api('/admin/projects')]);
        keys = r1.keys; tenants = r2.tenants; projects = r3.projects;
      } catch (err) {
        toast(err.message, 'error');
        content().innerHTML = `<h1>API Keys</h1><p class="error">Erro ao carregar: ${esc(err.message)}</p>`;
        return;
      }
      const scopes = ['text', 'chat', 'image', 'video', 'vision', 'embed', 'ocr', 'workflow', 'admin'];

      content().innerHTML = `<h1>API Keys</h1><p class="muted">Crie credenciais independentes por projeto, ambiente e capacidade.</p>
        <div class="card section"><h2>Nova chave</h2><div class="form-grid">
          <label>Nome <input id="k-name" placeholder="lovable-producao" /></label>
          <label>Tenant <select id="k-tenant">${tenants.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
          <label>Projeto <select id="k-project"><option value="">Sem projeto</option>${projects.map(p=>`<option value="${esc(p.id)}" data-tenant="${esc(p.tenantId)}">${esc(p.name)}</option>`).join('')}</select></label>
          <label>Ambiente <select id="k-env"><option value="live">Produção</option><option value="test">Teste</option><option value="dev">Desenvolvimento</option></select></label>
          <label>Expira em <input id="k-expiry" type="datetime-local" /></label>
        </div><div class="scope-list">${scopes.map(x=>`<label><input type="checkbox" value="${x}" ${['text','chat','image'].includes(x)?'checked':''}/> ${x}</label>`).join('')}</div>
        <button id="k-create">Gerar chave</button><span id="k-status" class="muted"></span></div><div id="k-new"></div>

        <div id="bulk-bar" class="bulk-bar hidden">
          <span id="bulk-count">0 chaves selecionadas</span>
          <button id="bulk-delete" class="danger">Revogar Selecionadas</button>
        </div>

        ${table(
          ['<input type="checkbox" id="k-select-all" />', 'Nome', 'Prefixo', 'Projeto', 'Ambiente', 'Escopos', 'Validade', 'Status', 'Ações'],
          keys.map(k=>[
            `<input type="checkbox" class="k-select" value="${esc(k.id)}" />`,
            `<a href="#" data-details="${esc(k.id)}" style="font-weight:600; text-decoration:none;">${esc(k.name)}</a>`,
            `<code>${esc(k.prefix)}...</code>`,
            esc(k.project?.name||'—'),
            esc(k.environment),
            esc(k.scopes),
            k.expiresAt?fmtDate(k.expiresAt):'Sem expiração',
            badge(k.active,'ativa','revogada'),
            (k.active?`<button class="ghost" data-edit="${esc(k.id)}" data-name="${esc(k.name)}" data-env="${esc(k.environment)}" data-scopes="${esc(k.scopes)}">Editar</button> <button class="ghost" data-revoke="${esc(k.id)}">Revogar</button>`:'')
          ])
        )}`;

      const filterProjects=()=>{const tenant=$('#k-tenant').value;Array.from($('#k-project').options).forEach((o,i)=>{if(i)o.hidden=o.dataset.tenant!==tenant});if($('#k-project').selectedOptions[0]?.hidden)$('#k-project').value='';};
      $('#k-tenant').addEventListener('change',filterProjects);filterProjects();

      $('#k-create').addEventListener('click', async () => {
        const btn = $('#k-create');
        const status = $('#k-status');
        btn.disabled = true;
        btn.classList.add('loading');
        try {
          const selected = Array.from(content().querySelectorAll('.scope-list input:checked')).map(x => x.value);
          const exp = $('#k-expiry').value;
          const data = await api('/admin/api-keys', {
            method: 'POST',
            body: {
              name: $('#k-name').value || 'sem-nome',
              tenantId: $('#k-tenant').value,
              projectId: $('#k-project').value || undefined,
              environment: $('#k-env').value,
              scopes: selected,
              expiresAt: exp ? new Date(exp).toISOString() : undefined
            }
          });
          $('#k-new').innerHTML = `<div class="card key-created"><strong>Chave criada — copie agora (ela não será exibida novamente!)</strong><pre class="code" id="new-key">${esc(data.key)}</pre><button id="copy-key">Copiar chave</button></div>`;
          $('#copy-key').onclick = () => { copyToClipboard(data.key, $('#copy-key'), 'Chave copiada!'); };
          status.textContent = '';
          toast('Chave de API gerada com sucesso!', 'success');
        } catch (e) {
          status.textContent = e.message;
          status.className = 'error';
          toast(e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.classList.remove('loading');
        }
      });

      content().querySelectorAll('[data-revoke]').forEach(btn=>btn.addEventListener('click',async()=>{await api(`/admin/api-keys/${btn.dataset.revoke}`,{method:'DELETE'});pages.keys();}));

      // Bulk Delete
      const updateBulkBar = () => {
        const selected = content().querySelectorAll('.k-select:checked');
        const bar = $('#bulk-bar');
        if (selected.length > 0) {
          bar.classList.remove('hidden');
          $('#bulk-count').textContent = `${selected.length} chaves selecionadas`;
        } else {
          bar.classList.add('hidden');
        }
      };

      $('#k-select-all').addEventListener('change', (e) => {
        content().querySelectorAll('.k-select').forEach(cb => cb.checked = e.target.checked);
        updateBulkBar();
      });
      content().querySelectorAll('.k-select').forEach(cb => cb.addEventListener('change', updateBulkBar));

      $('#bulk-delete').addEventListener('click', async () => {
        const ids = Array.from(content().querySelectorAll('.k-select:checked')).map(cb => cb.value);
        if (!ids.length) return;
        if (!confirm(`Tem certeza que deseja revogar ${ids.length} chaves?`)) return;
        await api('/admin/api-keys/bulk-delete', { method: 'POST', body: { ids } });
        pages.keys();
      });

      // Modal UI
      const showModal = (html) => {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return; // fail-safe if index.html update isn't loaded
        document.getElementById('modal-body').innerHTML = html;
        overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
        overlay.classList.remove('hidden');
        overlay.querySelector('input,select,textarea,button:not(#modal-close)')?.focus();
        document.getElementById('modal-close').onclick = () => overlay.classList.add('hidden');
        overlay.onkeydown = (event) => { if (event.key === 'Escape') { overlay.classList.add('hidden'); overlay.onkeydown = null; } };
      };

      // Edit
      content().querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
        const id = btn.dataset.edit;
        const currentScopes = btn.dataset.scopes.split(',');
        showModal(`
          <h2>Editar Chave</h2>
          <div class="form-grid">
            <label>Nome <input id="edit-name" value="${esc(btn.dataset.name)}" /></label>
            <label>Ambiente <select id="edit-env"><option value="live" ${btn.dataset.env==='live'?'selected':''}>Produção</option><option value="test" ${btn.dataset.env==='test'?'selected':''}>Teste</option><option value="dev" ${btn.dataset.env==='dev'?'selected':''}>Desenvolvimento</option></select></label>
          </div>
          <div class="scope-list">
            ${scopes.map(x=>`<label><input type="checkbox" value="${x}" class="edit-scope" ${currentScopes.includes(x)?'checked':''}/> ${x}</label>`).join('')}
          </div>
          <div style="margin-top: 16px; display: flex; gap: 8px;">
            <button id="save-edit">Salvar</button>
            <button class="ghost" id="rotate-key" style="color:var(--text-danger);">Rotacionar Chave</button>
          </div>
          <span id="edit-status" class="muted"></span>
          <div id="edit-new-key"></div>
        `);

        document.getElementById('save-edit').onclick = async () => {
          const status = document.getElementById('edit-status');
          try {
            const selectedScopes = Array.from(document.querySelectorAll('.edit-scope:checked')).map(x=>x.value);
            await api(`/admin/api-keys/${id}`, {
              method: 'PUT',
              body: { name: $('#edit-name').value, environment: $('#edit-env').value, scopes: selectedScopes }
            });
            document.getElementById('modal-overlay').classList.add('hidden');
            pages.keys();
          } catch(e) { status.textContent = e.message; status.className = 'error'; }
        };

        document.getElementById('rotate-key').onclick = async () => {
          if(!confirm('Rotacionar invalidará a chave atual instantaneamente. Continuar?')) return;
          try {
            const data = await api(`/admin/api-keys/${id}/rotate`, { method: 'POST' });
            document.getElementById('edit-new-key').innerHTML = `<div class="card key-created" style="margin-top:16px;"><strong>Nova chave gerada! (copie agora)</strong><pre class="code">${esc(data.key)}</pre></div>`;
            pages.keys();
          } catch(e) { document.getElementById('edit-status').textContent = e.message; }
        };
      }));

      // Details & Logs
      content().querySelectorAll('[data-details]').forEach(btn => btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = btn.dataset.details;
        const keyData = keys.find(k => k.id === id);
        showModal(`<h2>Detalhes da Chave: ${esc(keyData.name)}</h2>
          <p><strong>Status:</strong> ${keyData.active?'Ativa':'Revogada'}</p>
          <p><strong>Criada em:</strong> ${fmtDate(keyData.createdAt)}</p>
          <p><strong>Último uso:</strong> ${keyData.lastUsedAt?fmtDate(keyData.lastUsedAt):'Nunca'}</p>
          <p><strong>Escopos:</strong> ${esc(keyData.scopes)}</p>
          <hr style="margin:24px 0; border:none; border-top:1px solid var(--border);" />
          <h3>Logs de Requisição desta Chave</h3>
          <div id="key-logs-container"><p class="muted">Carregando logs...</p></div>
        `);

        try {
          const { logs } = await api(`/admin/logs?limit=50&apiKeyId=${id}`);
          const html = logs.length === 0 ? '<p class="muted">Nenhuma requisição encontrada para esta chave.</p>' : table(
            ['Quando', 'Cap', 'Provider', 'Modelo', 'Status', 'Tokens', 'Tempo'],
            logs.map(l => [
              fmtDate(l.createdAt), esc(l.capability), esc(l.provider), esc(l.model),
              badge(l.success, 'ok', l.errorCode || 'erro'),
              l.totalTokens, fmtMs(l.durationMs)
            ])
          );
          document.getElementById('key-logs-container').innerHTML = html;
        } catch(err) {
          document.getElementById('key-logs-container').innerHTML = '<p class="error">Falha ao carregar logs.</p>';
        }
      }));
    },

    async comfyWizard() {
      content().innerHTML='<h1>Assistente ComfyUI</h1><p class="muted">Carregando...</p>';
      let data;
      try { data=await api('/admin/comfyui/setup'); }
      catch(err){ toast(err.message,'error'); content().innerHTML=`<h1>Assistente ComfyUI</h1><p class="error">Erro ao carregar configuração: ${esc(err.message)}</p>`; return; }
      content().innerHTML=`<h1>Assistente ComfyUI</h1><p class="muted">Conecte uma instância local ou remota em quatro passos.</p>
        <div class="wizard-steps"><span class="active">1 URL</span><span>2 Teste</span><span>3 Modelos</span><span>4 Workflows</span></div>
        <div class="card section"><h2>1. Endereço do servidor</h2><div class="toolbar"><label>URL <input id="cw-url" value="http://host.docker.internal:8188" size="38" /></label><button id="cw-test">Salvar e testar</button></div><p id="cw-status" class="${data.health.ok?'ok':'muted'}">${data.health.ok?'Conectado':'Ainda não conectado'}${data.health.latencyMs?` · ${data.health.latencyMs}ms`:''}</p></div>
        <div class="card section"><h2>2. Modelos detectados</h2>${data.models.length?table(['Modelo','Nome','Capacidades'],data.models.map(m=>[esc(m.id),esc(m.name||m.id),esc((m.capabilities||[]).join(', '))])):'<p class="empty-state">Conecte o ComfyUI para detectar checkpoints automaticamente.</p>'}</div>
        <div class="card section"><h2>3. Workflows</h2><p>${data.workflows.length} workflow(s) configurado(s).</p><a class="button-link" href="#/workflow-manager">Abrir gerenciador de workflows</a></div>`;
      $('#cw-test').onclick=async()=>{const el=$('#cw-status');el.textContent='Testando conexão...';el.className='muted';try{const r=await api('/admin/comfyui/setup',{method:'POST',body:{baseUrl:$('#cw-url').value}});el.textContent=r.health.ok?'ComfyUI conectado com sucesso.':'Servidor respondeu, mas não está saudável.';el.className=r.health.ok?'ok':'error';if(r.health.ok)scheduleView(()=>pages.comfyWizard().catch(error => toast(error.message, 'error')),700);}catch(e){el.textContent=e.message;el.className='error';}};
    },

    async workflowManager() {
      content().innerHTML='<h1>Workflows ComfyUI</h1><p class="muted">Carregando...</p>';
      let workflows;
      try { ({workflows}=await api('/admin/workflows')); }
      catch(err){ toast(err.message,'error'); content().innerHTML=`<h1>Workflows ComfyUI</h1><p class="error">Erro ao carregar workflows: ${esc(err.message)}</p>`; return; }
      content().innerHTML=`<h1>Workflows ComfyUI</h1><div class="card section"><h2>Importar workflow API JSON</h2><div class="toolbar"><label>Nome <input id="wf-name" placeholder="Produto realista SDXL" /></label><label>Arquivo JSON <input id="wf-file" type="file" accept="application/json,.json" /></label><button id="wf-import">Importar</button></div><p id="wf-status" class="muted">Exporte no ComfyUI usando “Save (API Format)”.</p></div>
        ${table(['Nome','Status','Padrão','Atualizado','Ações'],workflows.map(w=>[esc(w.name),badge(w.enabled,'ativo','desativado'),w.isDefault?'★ padrão':'—',fmtDate(w.updatedAt),`<button class="ghost" data-default="${w.id}">Padrão</button> <button class="ghost" data-toggle="${w.id}" data-enabled="${w.enabled}">${w.enabled?'Desativar':'Ativar'}</button> <button class="ghost" data-copy="${w.id}">Duplicar</button> <button class="ghost" data-export="${w.id}">Exportar</button>`]))}`;
      $('#wf-import').onclick=async()=>{const f=$('#wf-file').files[0],st=$('#wf-status');if(!f){st.textContent='Selecione um JSON.';st.className='error';return}try{await api('/admin/workflows/import',{method:'POST',body:{name:$('#wf-name').value||f.name.replace(/\.json$/i,''),graph:JSON.parse(await f.text())}});pages.workflowManager();}catch(e){st.textContent=e.message;st.className='error';}};
      content().querySelectorAll('[data-default]').forEach(b=>b.onclick=async()=>{await api(`/admin/workflows/${b.dataset.default}`,{method:'PATCH',body:{isDefault:true}});pages.workflowManager()});
      content().querySelectorAll('[data-toggle]').forEach(b=>b.onclick=async()=>{await api(`/admin/workflows/${b.dataset.toggle}`,{method:'PATCH',body:{enabled:b.dataset.enabled!=='true'}});pages.workflowManager()});
      content().querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{await api(`/admin/workflows/${b.dataset.copy}/duplicate`,{method:'POST',body:{}});pages.workflowManager()});
      content().querySelectorAll('[data-export]').forEach(b=>b.onclick=async()=>{const r=await fetch(API+`/admin/workflows/${b.dataset.export}/export`,{headers:{authorization:`Bearer ${token()}`}});const blob=await r.blob(),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='workflow.json';a.click();URL.revokeObjectURL(a.href)});
    },


    async prompts() {
      content().innerHTML='<h1>Biblioteca de Prompts</h1><p class="muted">Carregando...</p>';
      let prompts;
      try { ({prompts}=await api('/admin/prompts')); }
      catch(err){ toast(err.message,'error'); content().innerHTML=`<h1>Biblioteca de Prompts</h1><p class="error">Erro ao carregar prompts: ${esc(err.message)}</p>`; return; }
      const categories=['produtos','marketing','imagem','video','seo','lojas','crm','whatsapp','catalogo','ocr'];
      content().innerHTML=`<h1>Biblioteca de Prompts</h1><p class="muted">Prompts reutilizáveis, categorizados e versionados.</p><div class="card section"><h2>Novo prompt</h2><div class="form-grid"><label>Nome <input id="pm-name" /></label><label>Categoria <select id="pm-category">${categories.map(c=>`<option value="${c}">${c}</option>`).join('')}</select></label><label class="inline-check"><input id="pm-favorite" type="checkbox"/> Favorito</label><label class="inline-check"><input id="pm-shared" type="checkbox"/> Compartilhado</label></div><label>Template <textarea id="pm-template" placeholder="Use {{variavel}} para campos dinâmicos"></textarea></label><button id="pm-save">Salvar prompt</button><span id="pm-status" class="muted"></span></div><div class="image-grid">${prompts.map(p=>`<article class="card"><strong>${p.favorite?'★ ':''}${esc(p.name)}</strong><span class="badge">${esc(p.category||'geral')}</span><small>v${p.version} · ${p.shared?'compartilhado':'privado'}</small><pre class="code">${esc(p.template.slice(0,500))}</pre><div><button class="ghost" data-fav="${p.id}" data-value="${p.favorite}">${p.favorite?'Desfavoritar':'Favoritar'}</button> <button class="ghost" data-del-prompt="${p.id}">Excluir</button></div></article>`).join('')||'<p class="empty-state">Nenhum prompt salvo.</p>'}</div>`;
      $('#pm-save').onclick=async()=>{const st=$('#pm-status');try{await api('/admin/prompts',{method:'POST',body:{name:$('#pm-name').value,category:$('#pm-category').value,template:$('#pm-template').value,favorite:$('#pm-favorite').checked,shared:$('#pm-shared').checked}});pages.prompts();}catch(e){st.textContent=e.message;st.className='error';}};
      content().querySelectorAll('[data-fav]').forEach(b=>b.onclick=async()=>{await api(`/admin/prompts/${b.dataset.fav}`,{method:'PATCH',body:{favorite:b.dataset.value!=='true'}});pages.prompts()});
      content().querySelectorAll('[data-del-prompt]').forEach(b=>b.onclick=async()=>{await api(`/admin/prompts/${b.dataset.delPrompt}`,{method:'DELETE'});pages.prompts()});
    },

    async lovable() {
      content().innerHTML='<h1>Conectar ao Lovable</h1><p class="muted">Carregando...</p>';
      let projects;
      try { ({projects}=await api('/admin/projects')); }
      catch(err){ toast(err.message,'error'); content().innerHTML=`<h1>Conectar ao Lovable</h1><p class="error">Erro ao carregar projetos: ${esc(err.message)}</p>`; return; }
      const base=location.origin;
      content().innerHTML=`<h1>Conectar ao Lovable</h1><p class="muted">Configuração guiada: projeto, chave, código e teste.</p>
        <div class="wizard-steps"><span class="active">1 Projeto</span><span>2 API Key</span><span>3 Código</span><span>4 Testar</span></div>
        <div class="card section"><h2>1. Escolha o projeto</h2>${projects.length?`<label>Projeto <select id="lv-project">${projects.map(p=>`<option>${esc(p.name)}</option>`).join('')}</select></label>`:`<p class="empty-state">Você ainda não possui projeto. <a href="#/projects">Criar primeiro projeto</a></p>`}</div>
        <div class="card section"><h2>2. Informe a API Key</h2><p class="muted">A chave fica apenas nesta sessão do navegador e será enviada somente para sua API Platform local.</p><label>API Key <input id="lv-key" type="password" placeholder="ap_live_..." autocomplete="off" /></label><a class="button-link" href="#/keys">Criar nova chave</a></div>
        <div class="card section"><h2>3. Cole no Lovable</h2><pre class="code">api_platform_URL=${esc(base)}\napi_platform_API_KEY=ap_live_xxxxx\n\nfetch(api_platform_URL + '/v1/text', {\n  method: 'POST',\n  headers: { 'content-type': 'application/json', 'x-api-key': api_platform_API_KEY },\n  body: JSON.stringify({ prompt: 'Olá!' })\n});</pre></div>
        <div class="card section"><h2>4. Teste a conexão</h2><button id="lv-test">Testar chave</button><span id="lv-status" class="muted"></span></div>`;
      $('#lv-test').onclick=async()=>{const st=$('#lv-status'),key=$('#lv-key').value;if(!key){st.textContent=' Informe a chave.';st.className='error';return}st.textContent=' Testando...';try{const r=await fetch(API+'/v1/models',{headers:{'x-api-key':key}}),d=await r.json();if(!r.ok)throw new Error(d?.error?.message||'Chave recusada');st.textContent=' Conexão validada — Lovable já pode usar a plataforma.';st.className='ok';}catch(e){st.textContent=' '+e.message;st.className='error';}};
    },
    async integrations() {
      const examples={Lovable:`const api = new apiplatform({\n  url: "${location.origin}",\n  apiKey: "ap_live_xxxxx"\n});`,React:`fetch(api_platform_URL + '/v1/text', {\n method:'POST', headers:{'content-type':'application/json','x-api-key':api_platform_API_KEY},\n body:JSON.stringify({prompt:'Olá'})\n});`,Node:`const response = await fetch(process.env.api_platform_URL + '/v1/chat', { headers: {'x-api-key': process.env.api_platform_API_KEY} });`,Python:`client = apiplatform(url=api_platform_URL, api_key=api_platform_API_KEY)\nresult = client.text("Olá")`,PHP:`$headers = ['x-api-key: '.getenv('api_platform_API_KEY')];`,Flutter:`headers: {'x-api-key': apiplatformApiKey}`};
      content().innerHTML=`<h1>Integrações</h1><p class="muted">Escolha sua tecnologia. O projeto cliente precisa conhecer apenas URL e API Key.</p>${Object.entries(examples).map(([name,code])=>`<div class="card section"><h2>${name}</h2><pre class="code">${esc(code)}</pre></div>`).join('')}`;
    },

    async ollama() {
      content().innerHTML='<h1>Ollama</h1><p class="muted">Carregando...</p>';
      let data;
      try { data=await api('/admin/providers'); }
      catch(err){ toast(err.message,'error'); content().innerHTML=`<h1>Ollama</h1><p class="error">Erro ao carregar dados do provider: ${esc(err.message)}</p>`; return; }
      const p=data.providers.find(x=>x.name==='ollama');
      content().innerHTML=`<h1>Ollama</h1>${p?`<div class="cards">${card('Status',p.health?.ok?'online':'offline',p.health?.ok?'ok':'error')}${card('Latência',p.health?.latencyMs!=null?fmtMs(p.health.latencyMs):'—')}${card('Modelos',p.models?.length||0)}${card('Capacidades',(p.capabilities||[]).join(', '))}</div><div class="section"><h2>Modelos instalados</h2>${table(['Modelo','Nome'],(p.models||[]).map(m=>[esc(m.id),esc(m.name||m.id)]))}</div>`:'<p class="empty-state">Ollama não está configurado.</p>'}<a class="button-link" href="#/providers">Configurar providers</a>`;
    },
    async baseUrl() {
      const base=location.origin;
      content().innerHTML=`<h1>Base URL</h1><p class="muted">Um único endereço para todos os projetos.</p><div class="card section"><h2>Endpoint da plataforma</h2><pre class="code">${esc(base)}</pre><p>Header obrigatório: <code>x-api-key: ap_live_...</code></p></div><div class="section"><h2>Rotas principais</h2>${table(['Capacidade','Endpoint'],[['Chat','POST /v1/chat'],['Imagem','POST /v1/image'],['Vídeo','POST /v1/video'],['Vision','POST /v1/vision'],['Embedding','POST /v1/embedding'],['Workflow','POST /v1/workflow']])}</div>`;
    },
    async sdk() {
      const base=location.origin; const snippets={JavaScript:`const client = new apiplatform({ baseUrl: '${base}', apiKey: process.env.api_platform_API_KEY });`,TypeScript:`const result = await client.chat({ messages: [{ role: 'user', content: 'Olá' }] });`,Python:`client = apiplatform(base_url='${base}', api_key=os.environ['api_platform_API_KEY'])`,cURL:`curl -X POST ${base}/v1/chat -H "x-api-key: $api_platform_API_KEY"`};
      content().innerHTML=`<h1>SDK</h1><p class="muted">Clientes e exemplos mínimos para integrar qualquer aplicação.</p>${Object.entries(snippets).map(([name,code])=>`<div class="card section"><h2>${name}</h2><pre class="code">${esc(code)}</pre></div>`).join('')}`;
    },
    async security() {
      content().innerHTML='<h1>Segurança</h1><p class="muted">Carregando...</p>';
      let keys, users;
      try { ([{keys},{users}]=await Promise.all([api('/admin/api-keys'),api('/admin/users')])); }
      catch(err){ toast(err.message,'error'); content().innerHTML=`<h1>Segurança</h1><p class="error">Erro ao carregar dados de segurança: ${esc(err.message)}</p>`; return; }
      const active=keys.filter(k=>k.active).length,expired=keys.filter(k=>k.expiresAt&&new Date(k.expiresAt)<new Date()).length,admins=users.filter(u=>u.role==='admin'&&u.active).length;
      content().innerHTML=`<h1>Segurança</h1><div class="cards">${card('Chaves ativas',active,'ok')}${card('Chaves expiradas',expired,expired?'error':'')}${card('Administradores',admins)}${card('Autenticação','JWT + API Key','ok')}</div><div class="section"><h2>Proteções ativas</h2>${table(['Controle','Status'],[['Tokens apenas como hash',badge(true)],['Escopos por chave',badge(true)],['Isolamento por projeto',badge(true)],['Rate limit por chave',badge(true)],['CORS com allowlist',badge(true)]])}</div><a class="button-link" href="#/keys">Gerenciar API Keys</a>`;
    },
    async backup() {
      content().innerHTML='<h1>Backup</h1><p class="muted">Carregando...</p>';
      let health;
      try { health=await fetch(API+'/v1/health').then(r=>r.json()); }
      catch(err){ toast(err.message,'error'); content().innerHTML=`<h1>Backup</h1><p class="error">Erro ao verificar saúde do sistema: ${esc(err.message)}</p>`; return; }
      const database = health.postgres === true || health.checks?.database === true;
      const redisOk = health.redis === true || health.checks?.redis === true;
      content().innerHTML=`<h1>Backup</h1><p class="muted">Estado das dependências e procedimentos operacionais.</p><div class="cards">${card('Banco',database?'pronto':'indisponível',database?'ok':'error')}${card('Redis',redisOk?'pronto':'indisponível',redisOk?'ok':'error')}${card('Storage','volume persistente','ok')}</div><div class="card section"><h2>Procedimentos</h2><p class="muted">Backup e restauração são executados pelo operador no ambiente de infraestrutura. Esta tela não executa comandos automaticamente.</p><pre class="code">docker compose exec postgres pg_dump -U apiplatform apiplatform &gt; backup.sql</pre></div>`;
    },
    async settings() {
      content().innerHTML = '<h1>Configuracoes</h1><p class="muted">Carregando...</p>';
      let tenants;
      try {
        ({ tenants } = await api('/admin/tenants'));
      } catch (err) {
        toast(err.message, 'error');
        content().innerHTML = `<h1>Configuracoes</h1><p class="error">Erro: ${esc(err.message)}</p>`;
        return;
      }
      content().innerHTML = `
        <h1>Configuracoes</h1>
        <div class="section">
          <h2>Tenants (lojas)</h2>
          <div class="toolbar">
            <label>Nome <input id="t-name" /></label>
            <label>Slug <input id="t-slug" placeholder="minha-loja" /></label>
            <button id="t-create">Criar tenant</button>
          </div>
          ${table(
            ['Nome', 'Slug', 'Ativo', 'Provider texto', 'Provider imagem', 'Criado'],
            tenants.map((t) => [
              esc(t.name), esc(t.slug), badge(t.active, 'sim', 'nao'),
              esc(t.defaultTextProvider || 'global'), esc(t.defaultImageProvider || 'global'), fmtDate(t.createdAt),
            ]),
          )}
        </div>
        <div class="section">
          <h2>Documentacao</h2>
          <p class="muted">Swagger/OpenAPI disponível em <a href="/docs/" target="_blank" style="color:var(--accent)">/docs/</a> — métricas Prometheus em <code>/metrics</code>.</p>
        </div>`;
      $('#t-create').addEventListener('click', async () => {
        try {
          await api('/admin/tenants', {
            method: 'POST',
            body: { name: $('#t-name').value, slug: $('#t-slug').value },
          });
          toast('Tenant criado!', 'success');
          pages.settings();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  };

  // ---------- Router ----------
  const routeTitles = {
    home: 'Visao Geral do Sistema',
    projects: 'Projetos & Wizard',
    providers: 'Provedores de IA',
    keys: 'API Keys & Segurança',
    playground: 'Playground de Inferência',
    mission: 'Mission Viewer',
    logs: 'Logs de Requisições',
    health: 'Health Check Telemetria',
    metrics: 'Prometheus Metrics',
    icp: 'ICP Integration',
    runtime: 'Runtime Config',
    tenants: 'Tenants & Lojas',
    users: 'Usuários & Permissões',
    settings: 'Configurações Globais',
    fenix: 'FÊNIX Connect'
  };

  async function route() {
    if (!token()) { showLogin(); return; }
    viewController.abort();
    viewController = new AbortController();
    const thisView = viewController;
    clearTimeout(viewTimer);
    const rawHash = location.hash.replace('#/', '') || 'home';
    const projectMatch = rawHash.match(/^project\/(.+)$/);
    const hash = projectMatch ? 'project' : rawHash;
    document.querySelectorAll('.sidebar nav a').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('href') === `#/${hash}`);
      if (a.classList.contains('active')) a.closest('.nav-group')?.classList.add('open');
    });

    // Fechar drawer mobile ao navegar
    const sidebar = $('#sidebar');
    const backdrop = $('#sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.add('hidden');

    // Atualizar breadcrumb no cabeçalho
    const bcTitle = $('#bc-page-title');
    if (bcTitle) bcTitle.textContent = routeTitles[hash] || hash;

    const aliases = {
      'image-generate': 'imageGenerate',
      'image-edit': 'imageEdit',
      'video-ai': 'videoAI',
      'image-providers': 'imageProviders',
      'image-queue': 'imageQueue',
      'image-history': 'imageHistory',
      'image-models': 'imageModels',
      'image-analytics': 'imageAnalytics',
      'comfy-wizard': 'comfyWizard',
      'workflow-manager': 'workflowManager',
      'base-url': 'baseUrl'
    };
    const page = hash === 'project' ? () => pages.projectDetails(projectMatch[1]) : pages[aliases[hash] || hash];
    content().innerHTML = '<p class="muted">Carregando...</p>';
    try {
      if (page) await page();
      else content().innerHTML = `<h1>404</h1><p>Página ${esc(hash)} não encontrada.</p>`;
    } catch (err) {
      if (thisView.signal.aborted) return;
      content().innerHTML = `<p class="error">Erro: ${esc(err.message)}</p>`;
    }
  }

  // Enterprise Premium Routes Addition (must be before route() call)
  pages.health = async () => {
    const healthView = viewController;
    content().innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; flex-wrap:wrap; gap:1rem;">
        <div>
          <h1>Health Check (Real-time)</h1>
          <p class="muted">Telemetria ao vivo da saúde de APIs, bancos, filas e provedores.</p>
        </div>
        <div id="health-badge" class="badge">CONSULTANDO</div>
      </div>
      <div class="cards" id="health-cards"></div>
      <div class="card section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <h2>Payload JSON da API (/v1/health)</h2>
          <button id="btn-copy-health" class="ghost sm">Copiar JSON</button>
        </div>
        <pre id="health-json" class="code" style="max-height:60vh; overflow:auto;"></pre>
      </div>`;

    const update = async () => {
      if (location.hash.replace('#/', '') !== 'health') return;
      try {
        const res = await api('/v1/health');
        if (healthView.signal.aborted) return;
        $('#health-badge').textContent = res.status;
        $('#health-badge').className = res.success ? 'badge ok' : 'badge err';
        const jsonEl = $('#health-json');
        if (jsonEl) {
          jsonEl.textContent = JSON.stringify(res, null, 2);
          const copyBtn = $('#btn-copy-health');
          if (copyBtn) copyBtn.onclick = () => copyToClipboard(JSON.stringify(res, null, 2), copyBtn);
        }
        const cardsEl = $('#health-cards');
        if (cardsEl) {
          cardsEl.innerHTML = [
            card('Status Global', res.status || 'OK', res.status === 'ONLINE' || res.status === 'ok' ? 'ok' : 'error'),
            card('Postgres DB', res.checks?.database ? 'ONLINE' : (res.postgres ? 'ONLINE' : 'DOWN'), res.checks?.database || res.postgres ? 'ok' : 'error'),
            card('Redis Cache', res.checks?.redis ? 'ONLINE' : (res.redis ? 'ONLINE' : 'DOWN'), res.checks?.redis || res.redis ? 'ok' : 'error'),
            card('Uptime', Math.round((res.uptime || 0) / 60) + ' min'),
            card('Latência Probes', (res.latency || 0) + 'ms')
          ].join('');
        }
      } catch(e) {
        if (healthView.signal.aborted) return;
        $('#health-badge').textContent = 'INDISPONÍVEL';
        $('#health-badge').className = 'badge err';
        $('#health-json').textContent = e.message;
      }
      if (!healthView.signal.aborted) scheduleView(update, 5000);
    };
    await update();
  };

  pages.fenix = async () => {
    content().innerHTML = '<h1>FÊNIX Connect</h1><p class="muted">Integração opcional. A API Platform executa autenticação, IA, filas, cache e administração de forma independente.</p><div class="card section"><h2>Conectar um cliente FÊNIX</h2><p>Configure no FÊNIX a URL desta plataforma e uma chave de API do projeto. Nenhuma conexão com o FÊNIX é necessária para usar este painel.</p><pre class="code" id="fenix-example"></pre><a class="button-link" href="#/keys">Gerenciar chaves</a> <a class="button-link" href="#/runtime">Ver runtime local</a></div>';
    $('#fenix-example').textContent = 'API_PLATFORM_URL=' + location.origin + '\nAPI_PLATFORM_API_KEY=<chave do projeto>';
  };

  pages.runtime = async () => {
    content().innerHTML = '<h1>Runtime da API Platform</h1><p class="muted">Carregando...</p>';
    try {
      const { runtime } = await api('/v1/runtime');
      content().innerHTML = '<h1>Runtime da API Platform</h1><p class="muted">Processo local do gateway. Integrações externas são opcionais.</p><pre class="code" id="runtime-json"></pre>';
      $('#runtime-json').textContent = JSON.stringify(runtime, null, 2);
    } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Runtime</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
  };

  pages.icp = async () => {
    content().innerHTML = '<h1>Cluster local</h1><p class="muted">Carregando...</p>';
    try {
      const data = await api('/v1/sync/cluster');
      content().innerHTML = '<h1>Cluster local</h1><p class="muted">Registro de nós deste processo. Métricas não medidas aparecem como —; heartbeats vencem após 60 segundos.</p>' +
        table(['Nó', 'Host', 'Status', 'RAM', 'CPU', 'Último heartbeat'], data.nodes.map(node => [esc(node.nodeId), esc(node.host), esc(node.status), node.ramUsagePercent == null ? '—' : Number(node.ramUsagePercent).toFixed(1) + '%', node.cpuUsagePercent == null ? '—' : Number(node.cpuUsagePercent).toFixed(1) + '%', esc(fmtDate(node.lastHeartbeat))]));
    } catch (err) { toast(err.message, 'error'); content().innerHTML = `<h1>Cluster local</h1><p class="error">Erro: ${esc(err.message)}</p>`; }
  };

  pages.mission = async () => {
    content().innerHTML = `
      <h1>Mission Viewer</h1>
      <p class="muted">Registros de missões recebidos pela API. Armazenamento em memória do processo; não representa execução autônoma.</p>
      <div class="cards" id="mission-cards">
        ${card('Missões Ativas', '...')}
        ${card('Total de Missões', '...')}
        ${card('Falhas', '...')}
      </div>
      <div class="section">
        <h2>Radar de Missões</h2>
        <div style="width:100%; height:260px; background:var(--bg-surface); border:1px solid var(--border); border-radius:12px; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden;">
          <div style="position:absolute; width:100%; height:100%; background: radial-gradient(circle, transparent 20%, var(--bg-surface) 100%), repeating-radial-gradient(transparent 0, transparent 40px, rgba(59,130,246,0.1) 40px, rgba(59,130,246,0.1) 41px);"></div>
          <div style="position:absolute; width:50%; height:2px; background:linear-gradient(90deg, transparent, var(--accent)); top:50%; left:50%; transform-origin:left; animation: radar 4s linear infinite;"></div>
          <span id="mission-radar-text" style="z-index:2; font-family:var(--font-display); font-size:1.3rem; color:var(--accent);">CARREGANDO MISSÕES...</span>
        </div>
      </div>
      <div class="section" style="margin-top:1.5rem;">
        <h2>Missões Registradas</h2>
        <div id="missions-list">Carregando lista...</div>
      </div>
      <style>@keyframes radar { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>
    `;

    try {
      const data = await api('/v1/missions');
      const missions = data.missions || [];
      const active = missions.filter(m => m.status === 'in_progress').length;
      const failed = missions.filter(m => m.status === 'failed').length;
      const total = missions.length;

      $('#mission-cards').innerHTML = `
        ${card('Missões Ativas', String(active), active > 0 ? 'ok' : '')}
        ${card('Total de Missões', String(total))}
        ${card('Falhas', String(failed), failed > 0 ? 'error' : 'ok')}
      `;

      $('#mission-radar-text').textContent = active > 0 ? `${active} MISSÃO(ÕES) EM EXECUÇÃO` : 'NENHUMA MISSÃO ATIVA NO MOMENTO';

      if (missions.length === 0) {
        $('#missions-list').innerHTML = '<p class="muted">Nenhuma missão em execução no momento. Missões orquestradas pelo FÊNIX OS ou via POST /v1/missions serão listadas aqui.</p>';
      } else {
        const missionBadge = (st) => {
          if (st === 'completed') return '<span class="badge ok">concluída</span>';
          if (st === 'in_progress') return '<span class="badge" style="background:rgba(59,130,246,0.15); color:var(--accent); border:1px solid rgba(59,130,246,0.3);">em execução</span>';
          if (st === 'failed') return '<span class="badge err">falha</span>';
          if (st === 'cancelled') return '<span class="badge muted">cancelada</span>';
          return `<span class="badge muted">${esc(st || 'pendente')}</span>`;
        };
        const rows = missions.map(m => [
          esc(m.id),
          esc(m.title),
          esc(m.agentId || 'auto'),
          missionBadge(m.status),
          esc(fmtDate(m.createdAt)),
        ]);
        $('#missions-list').innerHTML = table(['ID', 'Título', 'Agente', 'Status', 'Criado em'], rows);
      }
    } catch (e) {
      $('#mission-radar-text').textContent = 'CONSULTA INDISPONÍVEL';
      $('#missions-list').innerHTML = `<p class="muted">Não foi possível carregar missões: ${esc(e.message)}</p>`;
    }
  };


  pages.metrics = async () => {
    try {
      const res = await fetch(API + '/metrics', { headers: { authorization: `Bearer ${token()}` } });
      if (!res.ok) throw new Error('Métricas indisponíveis (HTTP ' + res.status + ')');
      const text = await res.text();
      if (!text.includes('# HELP')) throw new Error('O proxy não retornou métricas Prometheus');
      content().innerHTML = `<h1>Prometheus Metrics</h1><pre class="code" style="font-size:0.75rem; max-height:80vh; overflow:auto;">${esc(text)}</pre>`;
    } catch(e) {
      content().innerHTML = `<h1>Prometheus Metrics</h1><p class="error">Erro ao carregar: ${esc(e.message)}</p>`;
    }
  };
  pages.tenants = pages.settings;

  // Controles de interface mobile & Áudio
  const sidebarToggle = $('#sidebar-toggle');
  const sidebarBackdrop = $('#sidebar-backdrop');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      const sb = $('#sidebar');
      const bd = $('#sidebar-backdrop');
      if (sb) sb.classList.toggle('mobile-open');
      if (bd) bd.classList.toggle('hidden');
    });
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => {
      const sb = $('#sidebar');
      if (sb) sb.classList.remove('mobile-open');
      sidebarBackdrop.classList.add('hidden');
    });
  }

  const soundBtn = $('#toggle-sound');
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem('apiplatform_sound', String(soundEnabled));
      updateSoundButton();
      if (soundEnabled) playClickSound('success');
      toast(soundEnabled ? 'Som tátil ativado' : 'Som tátil desativado', 'info');
    });
    updateSoundButton();
  }

  window.addEventListener('hashchange', route);

  if (token()) showShell();
  else showLogin();
})();
