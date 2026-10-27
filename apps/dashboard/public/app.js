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
    const toggle = group.querySelector('.nav-group-toggle');
    const submenu = group.querySelector('.nav-submenu');
    if (submenu) {
      submenu.id = `nav-${name}-submenu`;
      toggle.setAttribute('aria-controls', submenu.id);
    }
    const setExpanded = (expanded) => {
      group.classList.toggle('open', expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
    };
    setExpanded(Boolean(navState[name]));
    toggle.addEventListener('click', () => {
      navState[name] = !group.classList.contains('open');
      setExpanded(navState[name]);
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
    if (icon) icon.innerHTML = soundEnabled
      ? '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>'
      : '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m17 9 5 6m0-6-5 6"/></svg>';
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
    const icon = type === 'success'
      ? '<path d="m5 12 4 4L19 6"/>'
      : type === 'error'
        ? '<path d="m18 6-12 12M6 6l12 12"/>'
        : '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>';
    el.innerHTML = '<svg class="ui-icon toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon + '</svg><span>' + esc(message) + '</span>';
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
  const favoriteIcon = '<svg class="ui-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2.8 2.83 5.74 6.33.92-4.58 4.47 1.08 6.31L12 17.26l-5.66 2.98 1.08-6.31-4.58-4.47 6.33-.92L12 2.8Z"/></svg>';

  const providerIdentity = (name) => {
    const id = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const supported = new Set(['anthropic', 'cloudflare', 'comfyui', 'forge', 'gemini', 'groq', 'huggingface', 'invokeai', 'lmstudio', 'ollama', 'openai', 'openrouter', 'xai']);
    const mark = supported.has(id)
      ? `<span class="provider-logo" aria-hidden="true"><img src="assets/providers/${id}.svg" width="24" height="24" alt="" loading="lazy" /></span>`
      : '';
    return `<span class="provider-identity">${mark}<strong>${esc(name)}</strong></span>`;
  };

  const table = (headers, rows) => {
    const emptyRow = `<tr><td colspan="${headers.length}" class="table-empty-cell"><svg class="table-empty-icon ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H10l2 2h7.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M3 10h18"/></svg>Nenhum registro encontrado</td></tr>`;
    return `<div class="table-container"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
           `<tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') : emptyRow}</tbody></table></div>`;
  };
  const fmtDate = (d) => (d ? new Date(d).toLocaleString('pt-BR') : '—');
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  const fmtUptime = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${s}s`;
  };
  const renderTelemetryCharts = (dailySeries = [], providerRows = [], summary = {}) => {
    const series = (dailySeries || []).slice(-12);
    const maxTokens = Math.max(10, ...series.map((d) => Number(d.observedTokens || 0) + Number(d.estimatedTokens || 0)));
    const maxReqs = Math.max(5, ...series.map((d) => Number(d.requests || 0)));
    const w = 560, h = 195, padL = 36, padR = 18, padT = 22, padB = 34;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const stepX = series.length > 1 ? plotW / (series.length - 1) : plotW / 2;
    const barW = Math.min(26, Math.max(10, Math.floor(plotW / Math.max(series.length * 2.2, 4))));

    const pts = series.map((d, i) => {
      const x = series.length === 1 ? padL + plotW / 2 : padL + i * stepX;
      const totTok = Number(d.observedTokens || 0) + Number(d.estimatedTokens || 0);
      const yTok = padT + plotH - (totTok / maxTokens) * plotH;
      const reqH = (Number(d.requests || 0) / maxReqs) * (plotH * 0.78);
      const yReq = padT + plotH - reqH;
      const label = String(d.day || '').slice(5).split('-').reverse().join('/');
      return { x, yTok, yReq, reqH, totTok, reqs: Number(d.requests || 0), label };
    });

    const linePath = pts.length
      ? pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.yTok.toFixed(1)}`).join(' ')
      : `M${padL},${padT + plotH} L${w - padR},${padT + plotH}`;
    const areaPath = pts.length
      ? `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${padT + plotH} L${pts[0].x.toFixed(1)},${padT + plotH} Z`
      : '';

    const activeProviders = [...(providerRows || [])]
      .sort((a, b) => (Number(b.requests || 0) + Number(b.observedTokens || 0)) - (Number(a.requests || 0) + Number(a.observedTokens || 0)))
      .slice(0, 6);
    const maxProvMetric = Math.max(1, ...activeProviders.map((p) => Number(p.observedTokens || 0) + Number(p.estimatedTokens || 0) + Number(p.requests || 0) * 15));

    return `
      <div class="telemetry-panel-grid">
        <article class="card telemetry-chart-card">
          <div class="telemetry-card-head">
            <div>
              <h3>Curva de Consumo: Tokens &amp; Requisições</h3>
              <p class="muted">Histórico real consolidado (${series.length ? `${series.length} dia(s) ativo(s)` : 'janela de 30 dias'})</p>
            </div>
            <div class="telemetry-legend">
              <span class="legend-item"><i class="legend-dot token-dot"></i>Tokens (${Number(summary.observedTokens || 0).toLocaleString('pt-BR')})</span>
              <span class="legend-item"><i class="legend-dot req-dot"></i>Reqs (${Number(summary.requests || 0).toLocaleString('pt-BR')})</span>
            </div>
          </div>
          <div class="telemetry-svg-wrap">
            <svg viewBox="0 0 ${w} ${h}" class="telemetry-svg" role="img" aria-label="Gráfico de evolução de tokens e requisições">
              <defs>
                <linearGradient id="teleGradTokens" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#4f8df7" stop-opacity="0.38"/>
                  <stop offset="100%" stop-color="#4f8df7" stop-opacity="0.0"/>
                </linearGradient>
              </defs>
              <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="#1f2b3d" stroke-dasharray="3 3" />
              <line x1="${padL}" y1="${padT + plotH / 2}" x2="${w - padR}" y2="${padT + plotH / 2}" stroke="#1f2b3d" stroke-dasharray="3 3" />
              <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="#2b394d" />
              <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" fill="#8fa0b8" font-size="9">${maxTokens}</text>
              <text x="${padL - 6}" y="${padT + plotH / 2 + 3}" text-anchor="end" fill="#8fa0b8" font-size="9">${Math.round(maxTokens / 2)}</text>
              <text x="${padL - 6}" y="${padT + plotH + 3}" text-anchor="end" fill="#8fa0b8" font-size="9">0</text>
              ${areaPath ? `<path d="${areaPath}" fill="url(#teleGradTokens)" />` : ''}
              ${pts.map((p) => `
                <rect x="${(p.x - barW / 2).toFixed(1)}" y="${p.yReq.toFixed(1)}" width="${barW}" height="${Math.max(2, p.reqH).toFixed(1)}" rx="3" fill="#10b981" fill-opacity="0.72" />
              `).join('')}
              <path d="${linePath}" fill="none" stroke="#4f8df7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
              ${pts.map((p) => `
                <circle cx="${p.x.toFixed(1)}" cy="${p.yTok.toFixed(1)}" r="3.6" fill="#0b111b" stroke="#60a5fa" stroke-width="2" />
                <text x="${p.x.toFixed(1)}" y="${(Math.min(p.yTok, p.yReq) - 6).toFixed(1)}" text-anchor="middle" fill="#dbe7ff" font-size="9" font-weight="600">${p.totTok > 0 ? p.totTok : p.reqs}</text>
                <text x="${p.x.toFixed(1)}" y="${h - 10}" text-anchor="middle" fill="#95a2b6" font-size="9.5">${esc(p.label)}</text>
              `).join('')}
            </svg>
          </div>
          <div class="telemetry-summary-strip">
            <span><strong>24h:</strong> ${Number(summary.requests24h || 0).toLocaleString('pt-BR')} reqs · ${Number(summary.tokens24h || 0).toLocaleString('pt-BR')} tok</span>
            <span><strong>30d:</strong> ${Number(summary.requests || 0).toLocaleString('pt-BR')} reqs · ${Number(summary.observedTokens || 0).toLocaleString('pt-BR')} tok reportados · $${Number(summary.cost || 0).toFixed(4)}</span>
          </div>
        </article>
        <article class="card telemetry-chart-card">
          <div class="telemetry-card-head">
            <div>
              <h3>Distribuição por Provider (Tokens &amp; Custos)</h3>
              <p class="muted">Volume medido por engine em execução</p>
            </div>
            <span class="badge ok">$${Number(summary.cost || 0).toFixed(4)} USD</span>
          </div>
          <div class="telemetry-provider-bars">
            ${activeProviders.length ? activeProviders.map((p) => {
              const totalProvTokens = Number(p.observedTokens || 0) + Number(p.estimatedTokens || 0);
              const tokKind = Number(p.observedTokens || 0) > 0 ? 'rep.' : Number(p.estimatedTokens || 0) > 0 ? 'est.' : '';
              const metric = totalProvTokens + Number(p.requests || 0) * 15;
              const pct = p.requests > 0 || totalProvTokens > 0 ? Math.max(8, Math.min(100, Math.round((metric / maxProvMetric) * 100))) : 2;
              return `
                <div class="telemetry-prov-row">
                  <div class="telemetry-prov-meta">
                    ${providerIdentity(p.name)}
                    <span class="telemetry-prov-stats">
                      <strong>${Number(p.requests || 0).toLocaleString('pt-BR')} reqs</strong> ·
                      ${totalProvTokens.toLocaleString('pt-BR')} tok${tokKind ? ` (${tokKind})` : ''} ·
                      $${Number(p.estimatedCost || 0).toFixed(4)}
                    </span>
                  </div>
                  <div class="telemetry-bar-track">
                    <div class="telemetry-bar-fill" style="width:${pct}%"></div>
                  </div>
                </div>`;
            }).join('') : '<p class="muted">Nenhum consumo registrado no período.</p>'}
          </div>
        </article>
      </div>`;
  };
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
          <div class="card"><div class="label">Latencia Global</div><div class="value" id="home-latency">—</div><small id="home-latency-sub" class="muted">Média do gateway</small></div>
          <div class="card"><div class="label">Requests (24h)</div><div class="value" id="home-reqs">0</div><small id="home-reqs-30d" class="muted">Acumulado 30d: 0</small></div>
          <div class="card"><div class="label">Tokens reportados (24h)</div><div class="value" id="home-tokens">0</div><small id="home-token-quality" class="muted"></small></div>
          <div class="card"><div class="label">Custo estimado (24h)</div><div class="value" id="home-cost">$0.00</div><small id="home-cost-30d" class="muted">Acumulado 30d: $0.0000</small></div>
          <div class="card"><div class="label">Tenants Ativos</div><div class="value" id="home-tenants">0</div><small id="home-keys-sub" class="muted">Projetos isolados</small></div>
          <div class="card"><div class="label">Uptime</div><div class="value" id="home-uptime">0s</div><small class="muted">Disponibilidade contínua</small></div>
          <div class="card"><div class="label">Memoria</div><div class="value" id="home-mem">0MB</div><small class="muted">Host container</small></div>
          <div class="card"><div class="label">Workers</div><div class="value ok" id="home-workers">0</div><small class="muted">BullMQ ativos</small></div>
        </div>
        <div class="section" style="margin-top:1.5rem;" id="home-telemetry-chart"></div>
        <div class="section" style="margin-top:1.5rem;">
          <h2>Modulos da Plataforma</h2>
          <div class="cards" id="home-modules"></div>
        </div>
        <div class="section">
          <h2>Providers em Tempo Real</h2>
          <div class="table-container">
            <table id="home-providers-table">
              <thead><tr><th>Provider</th><th>Status</th><th>Latência</th><th>Chamadas (24h / 30d)</th><th>Tokens reportados</th><th>Tokens estimados</th><th>Custo estimado (USD)</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>`;


      const updateHome = async () => {
        if (location.hash.replace('#/', '') !== 'home' && location.hash !== '') return;
        try {
          const [ { overview }, health, usageRes ] = await Promise.all([
            api('/admin/overview'),
            api('/v1/health'),
            api('/admin/usage?days=30').catch(() => ({ usage: [] })),
          ]);

          if ($('#home-latency')) {
            const usageList = Array.isArray(usageRes?.usage) ? usageRes.usage : [];
            const fallback30dReqs = usageList.reduce((s, u) => s + Number(u.requests || 0), 0);
            const fallback30dObs = usageList.reduce((s, u) => s + Number(u.observedTokens || u.totalTokens || 0), 0);
            const fallback30dEst = usageList.reduce((s, u) => s + Number(u.estimatedTokens || 0), 0);
            const fallback30dCost = usageList.reduce((s, u) => s + Number(u.cost || 0), 0);

            const totals30d = overview.totals30d || {
              requests: Math.max(fallback30dReqs, Number(overview.last24h.requests || 0)),
              observedTokens: Math.max(fallback30dObs, Number(overview.last24h.observedTokens || 0)),
              estimatedTokens: Math.max(fallback30dEst, Number(overview.last24h.estimatedTokens || 0)),
              cost: Math.max(fallback30dCost, Number(overview.last24h.cost || 0)),
            };

            const latency = health.latency || overview.last24h.avgDurationMs;
            $('#home-latency').textContent = latency + 'ms';
            if ($('#home-latency-sub')) $('#home-latency-sub').textContent = `Média 24h: ${overview.last24h.avgDurationMs || 0}ms`;
            $('#home-reqs').textContent = Number(overview.last24h.requests || 0).toLocaleString('pt-BR');
            if ($('#home-reqs-30d')) $('#home-reqs-30d').textContent = `Acumulado 30d: ${Number(totals30d.requests || 0).toLocaleString('pt-BR')} reqs`;
            $('#home-tokens').textContent = Number(overview.last24h.observedTokens || 0).toLocaleString('pt-BR');
            $('#home-token-quality').textContent = `30d: ${Number(totals30d.observedTokens || 0).toLocaleString('pt-BR')} rep. · ${Number(overview.last24h.estimatedTokens || 0).toLocaleString('pt-BR')} est.`;
            $('#home-cost').textContent = '$' + Number(overview.last24h.cost || 0).toFixed(4);
            if ($('#home-cost-30d')) $('#home-cost-30d').textContent = `Acumulado 30d: $${Number(totals30d.cost || 0).toFixed(4)}`;
            $('#home-tenants').textContent = overview.tenants;
            if ($('#home-keys-sub')) $('#home-keys-sub').textContent = `${overview.apiKeys ?? '—'} chaves ativas`;
            $('#home-uptime').textContent = fmtUptime(health.uptime || 0);
            $('#home-mem').textContent = health.memory ? health.memory.free + 'MB livres' : 'OK';
            $('#home-workers').textContent = health.workers ?? '—';
            $('#live-status').textContent = health.status;
            $('#live-status').className = health.success ? 'badge ok' : 'badge err';

            let dailySeries = overview.dailySeries || [];
            if (!dailySeries.length && usageList.length) {
              const byDay = new Map();
              for (const u of usageList) {
                const dayKey = new Date(u.day).toISOString().slice(0, 10);
                const cur = byDay.get(dayKey) || { day: dayKey, requests: 0, observedTokens: 0, estimatedTokens: 0, cost: 0 };
                cur.requests += Number(u.requests || 0);
                cur.observedTokens += Number(u.observedTokens || u.totalTokens || 0);
                cur.estimatedTokens += Number(u.estimatedTokens || 0);
                cur.cost += Number(u.cost || 0);
                byDay.set(dayKey, cur);
              }
              dailySeries = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
            }

            const prov30dMap = new Map();
            for (const u of usageList) {
              const cur = prov30dMap.get(u.provider) || { name: u.provider, requests: 0, observedTokens: 0, estimatedTokens: 0, estimatedCost: 0 };
              cur.requests += Number(u.requests || 0);
              cur.observedTokens += Number(u.observedTokens || u.totalTokens || 0);
              cur.estimatedTokens += Number(u.estimatedTokens || 0);
              cur.estimatedCost += Number(u.cost || 0);
              prov30dMap.set(u.provider, cur);
            }
            for (const p of (overview.providers || [])) {
              const u30 = p.usage30d || prov30dMap.get(p.name) || { requests: 0, observedTokens: 0, estimatedTokens: 0, estimatedCost: 0 };
              const u24 = p.usage || { requests: 0, observedTokens: 0, estimatedTokens: 0, estimatedCost: 0 };
              prov30dMap.set(p.name, {
                name: p.name,
                requests: Math.max(Number(u30.requests || 0), Number(u24.requests || 0)),
                observedTokens: Math.max(Number(u30.observedTokens || 0), Number(u24.observedTokens || 0)),
                estimatedTokens: Math.max(Number(u30.estimatedTokens || 0), Number(u24.estimatedTokens || 0)),
                estimatedCost: Math.max(Number(u30.estimatedCost || 0), Number(u24.estimatedCost || 0)),
              });
            }

            if ($('#home-telemetry-chart')) {
              $('#home-telemetry-chart').innerHTML = renderTelemetryCharts(dailySeries, Array.from(prov30dMap.values()), {
                requests24h: overview.last24h.requests,
                tokens24h: overview.last24h.observedTokens,
                requests: totals30d.requests,
                observedTokens: totals30d.observedTokens,
                estimatedTokens: totals30d.estimatedTokens,
                cost: totals30d.cost,
              });
            }

            const mods = ['API','Dashboard','Postgres','Redis','Mission','Streaming','Docker','SSL'];
            $('#home-modules').innerHTML = mods.map(m => card(m, health[m.toLowerCase()] ? 'ONLINE' : (health.checks?.[m.toLowerCase()] ? 'ONLINE' : 'N/A'), health[m.toLowerCase()] ? 'ok' : '')).join('');

            const tbody = $('#home-providers-table tbody');
            if (tbody && health.providers) {
              const usageByProvider = new Map((overview.providers || []).map(provider => [provider.name, provider.usage]));
              tbody.innerHTML = Object.entries(health.providers).map(([name, p]) =>
                { const usage = usageByProvider.get(name) || { requests: 0, observedTokens: 0, estimatedTokens: 0, estimatedCost: 0 };
                  const u30 = prov30dMap.get(name) || usage;
                  const reqText = u30.requests > usage.requests ? `${Number(usage.requests).toLocaleString('pt-BR')} <small class="muted">(${Number(u30.requests).toLocaleString('pt-BR')} 30d)</small>` : Number(usage.requests).toLocaleString('pt-BR');
                  const tokText = u30.observedTokens > usage.observedTokens ? `${Number(usage.observedTokens).toLocaleString('pt-BR')} <small class="muted">(${Number(u30.observedTokens).toLocaleString('pt-BR')} 30d)</small>` : Number(usage.observedTokens).toLocaleString('pt-BR');
                  return `<tr>
                  <td>${providerIdentity(name)}</td>
                  <td><span class="badge ${p.status === 'ONLINE' ? 'ok' : ''}">${esc(p.status || 'UNKNOWN')}</span></td>
                  <td>${p.latency == null ? '—' : fmtMs(p.latency)}</td>
                  <td>${reqText}</td>
                  <td>${tokText}</td>
                  <td>${Number(u30.estimatedTokens || usage.estimatedTokens || 0).toLocaleString('pt-BR')}</td>
                  <td>$${Number(Math.max(u30.estimatedCost || 0, usage.estimatedCost || 0)).toFixed(4)}</td>
                </tr>`; }
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
      const providerView = viewController;
      content().innerHTML = '<h1>Provedores de IA</h1><p class="muted" role="status">Carregando conexões...</p>';
      let providers, defaults, configs, connectionOptions, accounts;
      try {
        const [res1, res2, res3, resAccounts] = await Promise.all([
          api('/admin/providers'),
          api('/admin/provider-configs'),
          api('/admin/provider-oauth/options').catch(() => ({ options: {} })),
          api('/admin/provider-accounts'),
        ]);
        providers = res1.providers; defaults = res1.defaults; configs = res2.configs; connectionOptions = res3.options || {};
        if (!Array.isArray(resAccounts.accounts)) throw new Error('Resposta de contas inválida.');
        accounts = resAccounts.accounts;
      } catch (err) {
        if (isViewStale(providerView)) return;
        content().innerHTML = `<h1>Provedores de IA</h1><p class="error" role="alert">Erro ao carregar conexões: ${esc(err.message)}</p><button id="p-retry" class="ghost">Tentar novamente</button>`;
        $('#p-retry').onclick = () => pages.providers();
        return;
      }
      if (isViewStale(providerView)) return;
      const configByName = Object.fromEntries(configs.map((c) => [c.name, c]));
      const catalog = [
        ['openai', 'OpenAI', 'GPT · texto, visão e imagens', 'cloud'],
        ['anthropic', 'Anthropic', 'Claude · texto e visão', 'cloud'],
        ['xai', 'xAI', 'Grok · texto e visão', 'cloud'],
        ['gemini', 'Google Gemini', 'Gemini · modelos multimodais', 'cloud'],
        ['groq', 'Groq', 'Inferência de modelos abertos', 'cloud'],
        ['openrouter', 'OpenRouter', 'Vários modelos em uma API', 'cloud'],
        ['ollama', 'Ollama', 'Modelos no seu servidor', 'local'],
        ['huggingface', 'Hugging Face', 'Modelos e inferência na nuvem', 'cloud'],
        ['cloudflare', 'Cloudflare', 'Workers AI · inferência na nuvem', 'cloud'],
        ['lmstudio', 'LM Studio', 'Servidor local de modelos', 'local'],
        ['comfyui', 'ComfyUI', 'Workflows de geração de imagens', 'image'],
        ['forge', 'Stable Diffusion Forge', 'Geração de imagens no seu servidor', 'image'],
        ['invokeai', 'InvokeAI', 'Criação de imagens no seu servidor', 'image'],
      ];
      const choices = catalog.map(([name]) => name);
      const details = Object.fromEntries(catalog.map(([name, title, description, kind]) => [name, { title, description, kind }]));
      const defaultPortals = {
        openai: {
          portalUrl: 'https://platform.openai.com/api-keys',
          models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview', 'o1-mini'],
        },
        anthropic: {
          portalUrl: 'https://console.anthropic.com/settings/keys',
          models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
        },
        gemini: {
          portalUrl: 'https://aistudio.google.com/app/apikey',
          models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'],
        },
        xai: {
          portalUrl: 'https://console.x.ai/',
          models: ['grok-beta', 'grok-vision-beta'],
        },
        groq: {
          portalUrl: 'https://console.groq.com/keys',
          models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
        },
        openrouter: {
          portalUrl: 'https://openrouter.ai/keys',
          models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct'],
        },
        huggingface: {
          portalUrl: 'https://huggingface.co/settings/tokens',
          models: ['meta-llama/Llama-3.2-3B-Instruct', 'meta-llama/Llama-3.1-70B-Instruct'],
        },
        cloudflare: {
          portalUrl: 'https://dash.cloudflare.com/?to=/:account/workers/ai',
          models: ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.1-70b-instruct'],
        },
        ollama: {
          portalUrl: 'http://localhost:11434',
          models: ['llama3.2', 'qwen2.5-coder', 'mistral', 'nomic-embed-text'],
        },
        lmstudio: {
          portalUrl: 'http://localhost:1234',
          models: ['local-model'],
        },
        comfyui: {
          portalUrl: 'http://localhost:8188',
          models: ['sd_xl_base_1.0.safetensors', 'flux1-schnell'],
        },
        forge: {
          portalUrl: 'http://localhost:7860',
          models: ['sd_xl_base_1.0.safetensors'],
        },
        invokeai: {
          portalUrl: 'http://localhost:9090',
          models: ['sdxl'],
        },
      };
      const providerTitle = (name) => details[name]?.title || name;
      const programmingBridgeProfiles = {
        openai: { label: 'OpenAI Codex · Tokens de Programação', defaultTier: 'pro', defaultModel: 'gpt-4o', quotaLabel: 'Plus (5M) · Pro (25M) · Ultra (100M)' },
        anthropic: { label: 'Anthropic Claude Code · Tokens de Programação', defaultTier: 'pro', defaultModel: 'claude-3-5-sonnet-20241022', quotaLabel: 'Plus (5M) · Pro (25M) · Ultra (100M)' },
        gemini: { label: 'Google Gemini Antigravity · Tokens de Programação', defaultTier: 'ultra', defaultModel: 'gemini-1.5-pro', quotaLabel: 'Pro (25M) · Ultra (100M)' },
        xai: { label: 'xAI Grok · Tokens de Programação', defaultTier: 'pro', defaultModel: 'grok-beta', quotaLabel: 'Plus (5M) · Pro (25M) · Ultra (100M)' },
        groq: { label: 'Groq LPU · Tokens de Programação', defaultTier: 'pro', defaultModel: 'llama-3.3-70b-versatile', quotaLabel: 'Plus (5M) · Pro (25M)' },
        openrouter: { label: 'OpenRouter Multi-System · Tokens de Programação', defaultTier: 'pro', defaultModel: 'anthropic/claude-3.5-sonnet', quotaLabel: 'Plus (5M) · Pro (25M) · Ultra (100M)' },
        huggingface: { label: 'Hugging Face Inference · Tokens de Programação', defaultTier: 'pro', defaultModel: 'meta-llama/Llama-3.2-3B-Instruct', quotaLabel: 'Pro (25M)' },
        cloudflare: { label: 'Cloudflare Workers AI · Tokens de Programação', defaultTier: 'pro', defaultModel: '@cf/meta/llama-3.1-8b-instruct', quotaLabel: 'Pro (25M)' },
        ollama: { label: 'Ollama Dedicated GPU · Motor Local 24/7', defaultTier: 'dedicated', defaultModel: 'qwen2.5-coder:1.5b', quotaLabel: 'Ilimitado 24/7' },
      };
      const logo = (name) => `<span class="provider-logo" aria-hidden="true"><img src="assets/providers/${name}.svg" width="28" height="28" alt="" /></span>`;
      const svgExternal = `<svg class="icon-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

      const fmtTokens = (n) => {
        if (!n || n <= 0) return '0 tokens';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M tokens';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k tokens';
        return n + ' tokens';
      };
      const fmtCost = (c) => {
        if (c == null) return 'Tarifa não configurada';
        if (c === 0) return 'US$ 0.00';
        if (c < 0.01) return '< US$ 0.01';
        return 'US$ ' + Number(c).toFixed(2);
      };
      content().innerHTML = `
        <section class="providers-page">
          <div class="providers-header">
            <div><h1>Provedores de IA</h1><p class="muted">Conecte suas contas e escolha os modelos para suas aplicações.</p></div>
            <button id="p-add" aria-label="Adicionar provedor"><span class="provider-plus" aria-hidden="true">+</span> Adicionar provedor</button>
          </div>
          <div id="p-defaults" class="provider-defaults" aria-label="Provedores padrão"></div>
          <section class="provider-section" aria-labelledby="p-connected-title"><div class="provider-section-heading"><h2 id="p-connected-title">Suas conexões</h2><span id="p-count" class="muted"></span></div><div id="p-connected" class="provider-grid"></div></section>
          <section class="provider-section" aria-labelledby="p-catalog-title"><div class="provider-section-heading"><div><h2 id="p-catalog-title">Conectar uma conta</h2><p class="muted">Adicione uma API key ou conecte um servidor próprio.</p></div></div><div id="p-catalog" class="provider-grid"></div></section>
          <p class="provider-security muted">Suas credenciais são criptografadas e nunca são exibidas após o cadastro.</p>
        </section>
        <dialog id="provider-dialog" class="provider-dialog" aria-labelledby="p-dialog-title" aria-describedby="p-dialog-description"></dialog>`;

      const dialog = $('#provider-dialog');
      let returnFocus;
      let saving = false;
      let selectedAccount = null;
      let initialProviderSettings;
      const usageByAccount = new Map();
      const testResults = new Map();
      const accountOperations = new Set();
      const usageGenerations = new Map();
      const healthVersions = new Map();
      let accountRefreshGeneration = 0;
      const applyAccountHealth = (id, health) => {
        const account = accounts.find(item => item.id === id);
        if (!account) return;
        account.health = health;
        healthVersions.set(id, (healthVersions.get(id) || 0) + 1);
      };
      const refreshAccounts = async () => {
        const generation = ++accountRefreshGeneration;
        const versions = new Map(healthVersions);
        const refreshed = await api('/admin/provider-accounts');
        if (isViewStale(providerView) || generation !== accountRefreshGeneration) return;
        const current = new Map(accounts.map(account => [account.id, account]));
        accounts = refreshed.accounts.map(account => {
          const latest = current.get(account.id);
          return latest && healthVersions.get(account.id) !== versions.get(account.id)
            ? { ...account, health: latest.health }
            : account;
        });
      };
      const accountPath = id => '/admin/provider-accounts/' + encodeURIComponent(id);
      const renderUsage = (account) => {
        const state = usageByAccount.get(account.id);
        if (!state) return '<p class="muted" role="status">Carregando uso da conta...</p>';
        if (state.error) return '<p class="muted">Uso indisponível. <button class="ghost" data-refresh-usage="' + esc(account.id) + '">Tentar novamente</button></p>';
        const windowHtml = (key, label) => {
          const window = state[key];
          const knownTokens = Number.isFinite(window?.observedTokens) ? window.observedTokens : window?.totalTokens;
          const tokens = Number.isFinite(knownTokens) ? fmtTokens(knownTokens) + ' reportados' : 'Uso indisponível';
          const cost = window?.pricingConfigured === false || window?.missingPricingAttempts > 0 ? 'Tarifa não configurada' : Number.isFinite(window?.estimatedCost) ? fmtCost(window.estimatedCost) + ' estimado' : 'Gasto estimado indisponível';
          const missingUsage = Number(window?.missingUsageAttempts || 0);
          return '<div class="provider-usage-item"><span class="usage-label">' + label + '</span><span class="usage-tokens">' + tokens + '</span><small class="muted">' + (Number.isFinite(window?.calls) ? window.calls + ' chamadas · ' : '') + (missingUsage ? missingUsage + ' tentativas sem tokens reportados · ' : '') + cost + '</small></div>';
        };
        return '<div class="provider-usage-row">' + windowHtml('last5h', 'Últimas 5 horas') + windowHtml('last7d', 'Últimos 7 dias') + '</div><small class="muted">Tokens reportados pelo modelo; custo é estimado pelo gateway e não representa o saldo ou a quota do provedor.</small>';
      };
      const loadUsage = async account => {
        const generation = (usageGenerations.get(account.id) || 0) + 1;
        usageGenerations.set(account.id, generation);
        usageByAccount.delete(account.id);
        try {
          const response = await api(accountPath(account.id) + '/usage');
          if (!response.usage || response.usage.accountId !== account.id) throw new Error('Uso indisponível');
          if (generation !== usageGenerations.get(account.id)) return;
          usageByAccount.set(account.id, response.usage);
        } catch {
          if (generation !== usageGenerations.get(account.id)) return;
          usageByAccount.set(account.id, { error: true });
        }
        if (isViewStale(providerView)) return;
        const panel = [...content().querySelectorAll('[data-account-usage]')].find(el => el.dataset.accountUsage === account.id);
        if (panel) panel.innerHTML = renderUsage(account);
      };
      const renderCards = () => {
        $('#p-defaults').innerHTML = Object.entries(defaults || {}).map(([capability, name]) => '<span>' + esc({ chat: 'Chat', image: 'Imagens', embedding: 'Embeddings', vision: 'Visão', audio: 'Áudio' }[capability] || capability) + ' <strong>' + esc(providerTitle(name)) + '</strong></span>').join('');
        $('#p-count').textContent = accounts.length + (accounts.length === 1 ? ' conta configurada' : ' contas configuradas');
        const renderCard = (name, account) => {
          const live = providers.find(p => p.name === name);
          const health = account?.health;
          const checkedAt = health?.checkedAt ? Date.parse(health.checkedAt) : NaN;
          const ageMs = Number.isFinite(checkedAt) ? Math.max(0, Date.now() - checkedAt) : Infinity;
          const freshness = ageMs < 60_000 ? 'agora' : 'há ' + Math.floor(ageMs / 60_000) + ' min';
          const latency = Number.isFinite(health?.latencyMs) ? fmtMs(health.latencyMs) : null;
          const status = !account ? ['muted', 'Adicionar conta']
            : !account.enabled ? ['muted', 'Desativada']
              : account.oauthNeedsReauth ? ['warn', 'Nova autorização necessária']
                : ageMs > 5 * 60_000 ? ['muted', checkedAt ? 'Verificação desatualizada' : 'Verificar conexão']
                  : health?.ok === false ? ['error', 'Indisponível' + (latency ? ' · ' + latency : '')]
                    : health?.ok === true && latency === null ? ['muted', 'Online · latência não medida']
                      : health?.ok === true ? [health.latencyMs <= 1000 ? 'ok' : health.latencyMs <= 3000 ? 'warn' : 'error', (health.latencyMs <= 1000 ? 'Online' : 'Lenta') + ' · ' + latency + ' · ' + freshness]
                        : ['muted', 'Verificar conexão'];
          const modelNames = [...new Set([account?.defaultModel, ...(live?.models || []).map(model => typeof model === 'string' ? model : model.id || model.name)].filter(Boolean))];
          const displayModels = modelNames.length ? modelNames : defaultPortals[name]?.models || [];
          const portalUrl = connectionOptions[name]?.apiKey?.portalUrl || defaultPortals[name]?.portalUrl;
          const result = account && testResults.get(account.id);
          const disabled = account && accountOperations.has(account.id) ? ' disabled' : '';
          return '<article class="provider-card" ' + (account ? 'data-provider-account="' + esc(account.id) : 'data-provider-card="' + esc(name)) + '">' +
            '<div class="provider-card-heading">' + logo(name) + '<div><h3>' + esc(account?.displayName || providerTitle(name)) + '</h3><p>' + esc(account ? providerTitle(name) : details[name].description) + '</p></div></div>' +
            '<div class="provider-card-status"><span class="provider-status ' + status[0] + '"><span aria-hidden="true">●</span> ' + status[1] + '</span>' + (account?.accountTier ? '<span class="tier-badge">' + esc(account.accountTier.toUpperCase()) + '</span>' : '') + (defaults?.chat === name ? '<span class="provider-default-label">Provedor padrão de chat</span>' : '') + '</div>' +
            (account ? '<p class="provider-models">' + esc(account.authMode === 'local' ? account.baseUrl || 'Servidor local' : account.authMode === 'oauth' ? 'Conta OAuth' : 'API key / token') + '</p>' : '') +
            '<div class="provider-card-model-tags" aria-label="Modelos disponíveis ou sugeridos">' + displayModels.slice(0, 3).map(model => '<span class="model-tag" title="' + esc(model) + '">' + esc(model) + '</span>').join('') + '</div>' +
            (account ? '<div class="provider-usage-panel" data-account-usage="' + esc(account.id) + '" aria-label="Uso estimado da conta">' + renderUsage(account) + '</div>' : '') +
            '<div class="provider-card-actions">' + (account ? '<button class="ghost"' + disabled + ' data-edit-account="' + esc(account.id) + '">Editar conta</button><button class="ghost"' + disabled + ' data-test-account="' + esc(account.id) + '">Testar conexão</button><button class="ghost"' + disabled + ' data-disconnect-account="' + esc(account.id) + '">Desconectar conta</button>' : '<button data-connect-provider="' + esc(name) + '">Conectar conta<span class="sr-only"> ' + esc(providerTitle(name)) + '</span></button><button type="button" class="ghost provider-pull-card-btn" data-pull-provider="' + esc(name) + '" title="Puxar tokens de programação Pro / Plus de acordo com o sistema e conectar">⚡ Tokens Pro / Plus</button>') +
            (portalUrl ? '<a href="' + esc(portalUrl) + '" target="_blank" rel="noopener noreferrer" class="provider-portal-link" title="Abrir portal oficial no navegador">' + svgExternal + ' Acessar Portal</a>' : '') + '</div>' +
            (account ? '<p class="provider-test-result ' + esc(result?.kind || '') + '" data-account-result="' + esc(account.id) + '" role="status">' + esc(result?.message || '') + '</p>' : '') + '</article>';
        };
        $('#p-connected').innerHTML = accounts.length ? accounts.map(account => renderCard(account.providerName, account)).join('') : '<div class="provider-empty"><h3>Sua primeira conexão começa aqui</h3><p class="muted">Escolha um provedor abaixo ou clique em + para adicionar.</p></div>';
        $('#p-catalog').innerHTML = choices.map(name => renderCard(name)).join('');
      };
      const dialogConfig = () => selectedAccount ? {
        enabled: selectedAccount.enabled, baseUrl: selectedAccount.baseUrl,
        hasApiKey: selectedAccount.authMode === 'apiKey' && selectedAccount.hasCredential,
        hasOAuth: selectedAccount.authMode === 'oauth' && selectedAccount.hasCredential,
        oauthNeedsReauth: selectedAccount.oauthNeedsReauth,
        settings: { authMode: selectedAccount.authMode, defaultModel: selectedAccount.defaultModel, accountTier: selectedAccount.accountTier, accountId: selectedAccount.accountId },
      } : null;
      let flowPollTimer;
      let flowGeneration = 0;
      const stopOAuthPolling = () => { clearTimeout(flowPollTimer); flowGeneration++; };
      const updateAuthFields = () => {
        const name = $('#p-name').value;
        const cloud = details[name].kind === 'cloud';
        const selected = dialog.querySelector('input[name="provider-auth-mode"]:checked')?.value;
        const mode = cloud ? (selected || $('#p-auth-mode').value || 'apiKey') : 'local';
        const cfg = dialogConfig();
        const hasApiKey = Boolean(cfg?.hasApiKey);
        $('#p-auth-mode').value = mode;
        $('#p-key-field').hidden = !cloud || mode !== 'apiKey';
        const autoPullTier = !selectedAccount && ['plus', 'pro', 'ultra', 'enterprise'].includes($('#p-tier')?.value || 'free');
        $('#p-key').required = cloud && mode === 'apiKey' && !hasApiKey && !autoPullTier;
        if (cloud && mode === 'apiKey' && !hasApiKey) {
          $('#p-key').placeholder = autoPullTier ? 'Opcional: deixe vazio para puxar tokens ' + ($('#p-tier')?.value || 'pro').toUpperCase() + ' automaticamente' : 'Cole sua API key ou token';
        }
        $('#p-account-field').hidden = name !== 'cloudflare';
        $('#p-account').required = name === 'cloudflare' && mode === 'apiKey' && !selectedAccount;
        $('#p-hf-oauth-actions').hidden = name !== 'huggingface' || mode !== 'oauth' || !connectionOptions[name]?.oauth?.enabled;
        $('#p-google-oauth-actions').hidden = name !== 'gemini' || mode !== 'oauth' || !connectionOptions[name]?.oauth?.enabled;
        $('#p-save').disabled = false;
        $('#p-save').textContent = mode === 'oauth' ? 'Salvar ajustes' : 'Salvar conexão';
      };
      const fillProvider = (name) => {
        stopOAuthPolling();
        $('#p-hf-start').disabled = false;
        $('#p-hf-flow').hidden = true;
        $('#p-hf-start-status').textContent = '';
        const cfg = dialogConfig();
        const live = providers.find(p => p.name === name);
        const cloud = details[name].kind === 'cloud';
        const connection = connectionOptions[name] || {};
        const oauthEnabled = Boolean(connection.oauth?.enabled);
        const authMode = cloud ? (cfg?.settings?.authMode || (cfg?.hasOAuth && !cfg?.hasApiKey ? 'oauth' : 'apiKey')) : 'local';
        const hasApiKey = Boolean(cfg?.hasApiKey);
        $('#p-name').value = name;
        $('#p-name').disabled = Boolean(selectedAccount);
        $('#p-display-name').value = selectedAccount?.displayName || providerTitle(name);
        $('#p-auth-mode').value = authMode;
        $('#p-url').value = cfg?.baseUrl || (cloud ? '' : defaultPortals[name]?.portalUrl || '');
        $('#p-key').value = '';
        $('#p-key').placeholder = cfg?.hasApiKey ? 'Credencial salva. Deixe vazio para manter.' : 'Cole sua API key ou token';
        $('#p-key-field').hidden = !cloud || authMode !== 'apiKey';
        $('#p-key').required = cloud && authMode === 'apiKey' && !hasApiKey;
        $('#p-url').required = !cloud;
        $('#p-url').placeholder = cloud ? 'Opcional: endpoint personalizado' : 'http://servidor:porta';
        $('#p-auth-method-field').hidden = !cloud;
        const portalUrl = connection.apiKey?.portalUrl || defaultPortals[name]?.portalUrl;
        $('#p-auth-methods').innerHTML = cloud ? `
          <label class="provider-auth-choice"><input type="radio" name="provider-auth-mode" value="apiKey" ${authMode === 'apiKey' ? 'checked' : ''} /><span><strong>API Key ou Token</strong><small>Use uma credencial da API gerada no portal oficial.${portalUrl ? ` <a href="${esc(portalUrl)}" target="_blank" rel="noopener noreferrer" class="provider-open-browser-btn" style="margin-top:0.35rem;">${svgExternal} Abrir portal no navegador para obter chave</a>` : ''}</small></span></label>
          ${oauthEnabled ? `<label class="provider-auth-choice"><input type="radio" name="provider-auth-mode" value="oauth" ${authMode === 'oauth' ? 'checked' : ''} /><span><strong>${name === 'gemini' ? 'Entrar com Google' : 'Entrar com Hugging Face'}</strong><small>Conecte sua conta diretamente pelo navegador.</small></span></label>` : name === 'gemini' ? `<div class="provider-auth-choice disabled"><input type="radio" disabled aria-label="OAuth indisponível" /><span><strong>Entrar com Google</strong><small>${esc(connection.oauth?.reason || 'OAuth ficará disponível após configurar o callback HTTPS e o cliente Google no servidor.')}${portalUrl ? `<br/><a href="${esc(portalUrl)}" target="_blank" rel="noopener noreferrer" class="provider-open-browser-btn" style="margin-top:0.35rem;">${svgExternal} Abrir Google AI Studio no navegador</a>` : ''}</small></span></div>` : ''}
          ${cfg?.oauthNeedsReauth ? '<p class="provider-auth-warning" role="status">A autorização expirou ou foi revogada. Entre novamente para reativar esta conta.</p>' : ''}` : '';

        $('#p-tier').value = cfg?.settings?.accountTier || 'free';
        const bridgeProfile = programmingBridgeProfiles[name] || { label: providerTitle(name) + ' · Tokens de Programação', defaultTier: 'pro', defaultModel: defaultPortals[name]?.models?.[0] || '', quotaLabel: 'Plus · Pro · Ultra' };
        if ($('#p-bridge-desc')) {
          $('#p-bridge-desc').textContent = bridgeProfile.label + ' (' + bridgeProfile.quotaLabel + ')';
        }
        const suggestedModels = (live?.models || []).map(m => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
        const fallbackModels = defaultPortals[name]?.models || [];
        const modelList = suggestedModels.length > 0 ? suggestedModels : fallbackModels;
        const chipsContainer = $('#p-model-chips');
        if (chipsContainer) {
          chipsContainer.innerHTML = modelList.length > 0 ? `
            <span class="muted" style="font-size:0.75rem;display:block;margin-bottom:0.25rem;width:100%;">Modelos sugeridos (clique para preencher):</span>
            ${modelList.map(m => `<button type="button" class="provider-model-chip" data-model-id="${esc(m)}">${esc(m)}</button>`).join('')}
          ` : '';
          chipsContainer.querySelectorAll('.provider-model-chip').forEach(chip => {
            chip.onclick = () => {
              $('#p-model').value = chip.dataset.modelId;
              $('#p-model').focus();
            };
          });
        }
        $('#p-account-field').hidden = name !== 'cloudflare';
        $('#p-account').required = name === 'cloudflare' && authMode === 'apiKey' && !selectedAccount;
        $('#p-account').value = cfg?.settings?.accountId || '';
        $('#p-model').value = cfg?.settings?.defaultModel || '';
        $('#p-embed').value = configByName[name]?.settings?.embedModel || '';
        $('#p-default-chat').checked = defaults?.chat === name;
        initialProviderSettings = { defaultChat: $('#p-default-chat').checked, embedModel: $('#p-embed').value };
        $('#p-account').placeholder = selectedAccount ? 'Deixe vazio para preservar o ID salvo' : 'ID da conta Cloudflare';
        $('#p-default-field').hidden = details[name].kind === 'image';
        $('#p-enabled').checked = cfg?.enabled ?? true;
        $('#p-dialog-logo').innerHTML = logo(name);
        $('#p-dialog-description').textContent = cloud ? `Escolha como conectar ${providerTitle(name)}. A conexão só aparecerá como online depois de um teste real.` : `Informe o endereço do servidor ${providerTitle(name)} acessível pela API Platform.`;
        updateAuthFields();
        $('#p-result').textContent = '';
      };

      const closeDialog = () => { if (!saving) { stopOAuthPolling(); dialog.close(); } };
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button, input, select')].filter(el => !el.disabled && el.getClientRects().length);
        const target = event.shiftKey ? controls[controls.length - 1] : controls[0];
        if (target && (event.shiftKey ? document.activeElement === controls[0] : document.activeElement === controls[controls.length - 1])) { event.preventDefault(); target.focus(); }
      });
      dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
      dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
      dialog.addEventListener('close', () => { stopOAuthPolling(); dialog.replaceChildren(); if (returnFocus?.isConnected) returnFocus.focus(); });
      providerView.signal.addEventListener('abort', () => { stopOAuthPolling(); if (dialog.open) dialog.close(); dialog.remove(); }, { once: true });
      const openProvider = (name, trigger, account = null) => {
        selectedAccount = account;
        returnFocus = trigger;
        dialog.innerHTML = `<div class="provider-dialog-content">
          <button type="button" id="p-close" class="ghost provider-dialog-close" aria-label="Fechar conexão">×</button>
          <div id="p-dialog-logo"></div><h2 id="p-dialog-title">Conectar conta</h2><p id="p-dialog-description" class="muted"></p>
          <form id="p-form"><div class="form-grid">
            <label class="provider-field-wide" for="p-name">Provedor<select id="p-name">${choices.map(id => `<option value="${id}">${esc(providerTitle(id))}</option>`).join('')}</select></label>
            <label class="provider-field-wide" for="p-display-name">Nome da conta<input id="p-display-name" required maxlength="120" /></label>
            <input type="hidden" id="p-auth-mode" value="apiKey" />
            <fieldset class="provider-field-wide provider-auth-method-field" id="p-auth-method-field"><legend>Forma de conexão</legend><div id="p-auth-methods"></div></fieldset>
            <label class="provider-field-wide" for="p-tier">Plano / Tier de Conta
              <select id="p-tier">
                <option value="tier1">API Tier 1</option>
                <option value="plus">Plus</option>
                <option value="pro">Pro</option>
                <option value="ultra">Ultra</option>
                <option value="enterprise">Enterprise (Organização Corporativa)</option>
                <option value="dedicated">Dedicated Host (Ollama / Local GPU 24/7)</option>
                <option value="free">Free / Gratuito</option>
              </select>
            </label>
            <div class="provider-field-wide provider-token-bridge" id="p-token-bridge">
              <div class="provider-token-bridge-head">
                <strong>⚡ Puxar Tokens de Programação (Conta Pro / Plus / Ultra)</strong>
                <small id="p-bridge-desc" class="muted">Sincroniza tokens de programação de acordo com o sistema e ativa na orquestração</small>
              </div>
              <div class="provider-token-bridge-actions">
                <button type="button" class="ghost provider-tier-chip" data-tier-preset="plus">Plus · 5M</button>
                <button type="button" class="ghost provider-tier-chip" data-tier-preset="pro">Pro · 25M</button>
                <button type="button" class="ghost provider-tier-chip" data-tier-preset="ultra">Ultra · 100M</button>
                <button type="button" id="p-pull-tokens-btn" class="provider-pull-main-btn">⚡ Puxar Tokens Pro / Plus & Conectar</button>
              </div>
            </div>
            <label class="provider-field-wide" for="p-key" id="p-key-field">API Key / Token<input id="p-key" type="password" autocomplete="new-password" /></label>
            <label class="provider-field-wide" for="p-url">Endpoint / Base URL<input id="p-url" type="url" /></label>
            <label class="provider-field-wide" for="p-account" id="p-account-field">Account ID (Cloudflare)<input id="p-account" /></label>
            <label class="provider-field-wide" for="p-model">Modelo padrão
              <input id="p-model" maxlength="128" placeholder="Opcional: ID do modelo" />
              <div id="p-model-chips" class="provider-model-chips" aria-label="Sugestões de modelos"></div>
            </label>
            <label for="p-embed">Modelo de embeddings do provedor<input id="p-embed" placeholder="Opcional: ID do modelo" /></label>
          </div><div class="provider-form-options"><label class="inline-check" id="p-default-field"><input id="p-default-chat" type="checkbox" /> Usar como padrão de chat e tarefas do Fênix</label><label class="inline-check"><input id="p-enabled" type="checkbox" checked /> Provedor ativo</label></div>
          <section id="p-hf-oauth-actions" class="provider-oauth-actions" hidden><p>Autorize o acesso à inferência no Hugging Face com o código temporário abaixo.</p><button id="p-hf-start" type="button">Entrar com Hugging Face</button><p id="p-hf-start-status" role="status" aria-live="polite"></p><div id="p-hf-flow" hidden><p>Código de autorização: <strong id="p-hf-code"></strong></p><a id="p-hf-link" href="https://huggingface.co/oauth/authorize/device" target="_blank" rel="noopener noreferrer">Abrir Hugging Face para autorizar</a><button id="p-hf-copy" class="ghost" type="button">Copiar código</button><p id="p-oauth-status" role="status" aria-live="polite"></p></div></section>
          <section id="p-google-oauth-actions" class="provider-oauth-actions" hidden><p>Continue para o Google autorizar o acesso à API Gemini.</p><button id="p-google-start" type="button">Entrar com Google</button></section>
          <p id="p-result" role="status" aria-live="polite"></p><div class="provider-dialog-actions"><button id="p-save" type="submit">Salvar conexão</button><button id="p-cancel" type="button" class="ghost">Cancelar</button></div></form>
        </div>`;
        fillProvider(name);
        $('#p-dialog-title').textContent = selectedAccount ? 'Editar conta' : 'Conectar conta';
        $('#p-name').onchange = event => fillProvider(event.target.value);
        $('#p-tier').onchange = () => {
          const currentName = $('#p-name').value;
          const profile = programmingBridgeProfiles[currentName];
          if (['plus', 'pro', 'ultra', 'enterprise'].includes($('#p-tier').value) && !$('#p-model').value.trim() && profile?.defaultModel) {
            $('#p-model').value = profile.defaultModel;
          }
          updateAuthFields();
        };
        dialog.querySelectorAll('[data-tier-preset]').forEach(btn => {
          btn.onclick = () => {
            const currentName = $('#p-name').value;
            const profile = programmingBridgeProfiles[currentName];
            $('#p-tier').value = btn.dataset.tierPreset;
            if (!$('#p-model').value.trim() && profile?.defaultModel) {
              $('#p-model').value = profile.defaultModel;
            }
            updateAuthFields();
          };
        });
        $('#p-auth-methods').onchange = event => {
          if (!event.target.matches('input[name="provider-auth-mode"]')) return;
          if (event.target.value !== 'oauth') stopOAuthPolling();
          updateAuthFields();
        };
        $('#p-close').onclick = closeDialog;
        $('#p-cancel').onclick = closeDialog;
        let disabledBeforeSave = new Set();
        const setBusy = busy => {
          if (busy) disabledBeforeSave = new Set([...dialog.querySelectorAll('button, input, select')].filter(el => el.disabled));
          saving = busy;
          $('#p-form').setAttribute('aria-busy', String(busy));
          dialog.querySelectorAll('button, input, select').forEach(el => { el.disabled = busy || disabledBeforeSave.has(el); });
          if (!busy) { $('#p-name').disabled = Boolean(selectedAccount); updateAuthFields(); }
        };
        const saveAccount = async () => {
          const providerName = $('#p-name').value;
          const authMode = $('#p-auth-mode').value;
          const settings = { defaultModel: $('#p-model').value.trim(), accountTier: $('#p-tier').value };
          const accountId = $('#p-account').value.trim();
          const settingsChanged = !selectedAccount || settings.defaultModel !== (selectedAccount.defaultModel || '') || settings.accountTier !== (selectedAccount.accountTier || 'free') || (providerName === 'cloudflare' && accountId !== (selectedAccount?.accountId || ''));
          // Omit unchanged settings and blank credentials to preserve the saved account.
          if (providerName === 'cloudflare' && selectedAccount && settingsChanged && !accountId) {
            throw new Error('Informe o Account ID para alterar o modelo ou plano desta conta Cloudflare. Deixe esses ajustes como estão para preservar o ID salvo.');
          }
          if (providerName === 'cloudflare' && accountId) settings.accountId = accountId;
          const body = { providerName, displayName: $('#p-display-name').value.trim(), authMode, enabled: $('#p-enabled').checked, baseUrl: $('#p-url').value.trim() };
          if (settingsChanged) body.settings = settings;
          if (authMode === 'apiKey' && $('#p-key').value.trim()) body.apiKey = $('#p-key').value.trim();
          const shouldPullTokens = !selectedAccount && ['plus', 'pro', 'ultra', 'enterprise'].includes(settings.accountTier) && !$('#p-key').value.trim();
          const response = shouldPullTokens
            ? await api('/admin/provider-accounts/pull-tokens', {
                method: 'POST',
                body: {
                  providerName,
                  displayName: $('#p-display-name').value.trim() || `${providerTitle(providerName)} (${settings.accountTier.toUpperCase()})`,
                  accountTier: settings.accountTier,
                  defaultModel: settings.defaultModel || undefined,
                  baseUrl: $('#p-url').value.trim() || undefined,
                  cloudflareAccountId: accountId || undefined,
                },
              })
            : await api(selectedAccount ? accountPath(selectedAccount.id) : '/admin/provider-accounts', { method: selectedAccount ? 'PATCH' : 'POST', body });
          if (isViewStale(providerView)) return null;
          if (!response.account?.id) throw new Error('A API não confirmou a conta salva.');
          accountRefreshGeneration++;
          selectedAccount = response.account;
          const index = accounts.findIndex(item => item.id === selectedAccount.id);
          if (index < 0) accounts.push(selectedAccount); else accounts[index] = selectedAccount;
          if (response.tokenBridge && response.health?.ok) {
            testResults.set(selectedAccount.id, { kind: 'ok', message: 'Tokens de programação ' + (response.tokenBridge.tier || 'pro').toUpperCase() + ' conectados e ativos · ' + (response.tokenBridge.defaultModel || '') });
          } else {
            testResults.delete(selectedAccount.id);
          }
          $('#p-key').value = '';
          $('#p-name').disabled = true;
          renderCards();
          loadUsage(selectedAccount);
          return selectedAccount;
        };
        const saveProviderSettings = async () => {
          const providerName = $('#p-name').value;
          const defaultChat = !$('#p-default-field').hidden && $('#p-default-chat').checked;
          const embedModel = $('#p-embed').value.trim();
          const defaultChanged = defaultChat !== initialProviderSettings.defaultChat;
          const embedChanged = embedModel !== initialProviderSettings.embedModel;
          if (!defaultChanged && !embedChanged) return;
          // The account PATCH may update the imported provider, while a secondary account has its own enabled state.
          const { configs: latestConfigs } = await api('/admin/provider-configs');
          if (!Array.isArray(latestConfigs)) throw new Error('A API não confirmou a configuração do provedor.');
          latestConfigs.forEach(config => { configByName[config.name] = config; });
          const legacy = configByName[providerName];
          if (!latestConfigs.some(config => config.name === providerName) || typeof legacy?.enabled !== 'boolean') throw new Error('A API não confirmou o estado do provedor.');
          const body = { name: providerName, enabled: legacy.enabled };
          if (defaultChanged) body.defaultChat = defaultChat;
          if (embedChanged) body.embedModel = embedModel;
          await api('/admin/provider-configs', { method: 'POST', body });
          initialProviderSettings = { defaultChat, embedModel };
          configByName[providerName] = { ...legacy, settings: { ...legacy?.settings, ...(defaultChanged ? { defaultChat } : {}), ...(embedChanged ? { embedModel } : {}) } };
          const [refreshed] = await Promise.all([api('/admin/providers'), refreshAccounts()]);
          if (!isViewStale(providerView)) {
            providers = refreshed.providers; defaults = refreshed.defaults; renderCards();
            accounts.filter(account => !usageByAccount.has(account.id)).forEach(loadUsage);
          }
        };
        $('#p-hf-start').onclick = async () => {
          if (saving || !$('#p-form').reportValidity()) return;
          stopOAuthPolling();
          const status = $('#p-hf-start-status');
          status.textContent = 'Solicitando código ao Hugging Face...'; status.className = 'muted';
          setBusy(true);
          try {
            const account = await saveAccount();
            if (!account) return;
            await saveProviderSettings();
            const scope = accountPath(account.id) + '/oauth/huggingface';
            const generation = ++flowGeneration;
            const flow = await api(scope + '/start', { method: 'POST' });
            if (isViewStale(providerView) || generation !== flowGeneration || !dialog.open) return;
            $('#p-hf-code').textContent = flow.userCode;
            $('#p-hf-link').href = flow.verificationUri;
            $('#p-hf-start-status').textContent = '';
            $('#p-hf-flow').hidden = false;
            const flowStatus = $('#p-oauth-status');
            flowStatus.textContent = 'Aguardando autorização. Esta janela verificará a conexão automaticamente.';
            const poll = intervalSeconds => {
              flowPollTimer = setTimeout(async () => {
                if (generation !== flowGeneration || isViewStale(providerView) || !dialog.open) return;
                try {
                  const result = await api(scope + '/poll', { method: 'POST', body: { flowId: flow.flowId } });
                  if (generation !== flowGeneration || isViewStale(providerView) || !dialog.open) return;
                  if (result.status === 'pending') { poll(result.intervalSeconds || flow.intervalSeconds); return; }
                  if (result.status !== 'connected') {
                    status.textContent = result.status === 'denied' ? 'A autorização foi negada no Hugging Face.' : 'O código expirou. Inicie uma nova conexão.';
                    status.className = 'error'; $('#p-hf-start').disabled = false; return;
                  }
                  await refreshAccounts();
                  if (generation !== flowGeneration || isViewStale(providerView) || !dialog.open) return;
                  renderCards();
                  stopOAuthPolling(); dialog.close();
                  content().querySelector('[data-connect-provider="huggingface"]')?.focus();
                  toast('Conta Hugging Face conectada. Teste a conexão para confirmar que está online.', 'success');
                } catch (err) {
                  if (generation === flowGeneration && !isViewStale(providerView) && dialog.open) { status.textContent = err.message; status.className = 'error'; $('#p-hf-start').disabled = false; }
                }
              }, Math.max(1, Math.min(Number(intervalSeconds) || 5, 60)) * 1000);
            };
            poll(flow.intervalSeconds);
          } catch (err) {
            if (!isViewStale(providerView) && dialog.open) { status.textContent = err.message; status.className = 'error'; }
          } finally {
            if (!isViewStale(providerView) && dialog.open) setBusy(false);
          }
        };
        $('#p-hf-copy').onclick = async () => {
          const status = $('#p-oauth-status');
          try { await navigator.clipboard.writeText($('#p-hf-code').textContent); status.textContent = 'Código copiado.'; }
          catch { status.textContent = 'Selecione e copie o código manualmente.'; }
        };
        $('#p-google-start').onclick = async () => {
          if (saving || !$('#p-form').reportValidity()) return;
          const status = $('#p-result');
          status.textContent = 'Abrindo a autorização segura do Google...'; status.className = 'muted';
          setBusy(true);
          try {
            const account = await saveAccount();
            if (!account) return;
            await saveProviderSettings();
            const started = await api(accountPath(account.id) + '/oauth/gemini/start', { method: 'POST' });
            if (!isViewStale(providerView)) window.location.assign(started.authorizationUrl);
          } catch (err) {
            if (!isViewStale(providerView) && dialog.open) { status.textContent = err.message; status.className = 'error'; }
          } finally {
            if (!isViewStale(providerView) && dialog.open) setBusy(false);
          }
        };
        $('#p-pull-tokens-btn').onclick = async () => {
          if (saving) return;
          stopOAuthPolling();
          const providerName = $('#p-name').value;
          const profile = programmingBridgeProfiles[providerName] || { defaultTier: 'pro', defaultModel: '' };
          if (!['plus', 'pro', 'ultra', 'enterprise'].includes($('#p-tier').value)) {
            $('#p-tier').value = profile.defaultTier || 'pro';
          }
          if (!$('#p-model').value.trim() && profile.defaultModel) {
            $('#p-model').value = profile.defaultModel;
          }
          updateAuthFields();
          const result = $('#p-result');
          result.textContent = 'Puxando tokens de programação ' + $('#p-tier').value.toUpperCase() + ' e conectando ao sistema...';
          result.className = 'muted';
          setBusy(true);
          try {
            const response = await api('/admin/provider-accounts/pull-tokens', {
              method: 'POST',
              body: {
                accountId: selectedAccount?.id,
                providerName,
                displayName: $('#p-display-name').value.trim() || `${providerTitle(providerName)} (${$('#p-tier').value.toUpperCase()})`,
                accountTier: $('#p-tier').value,
                defaultModel: $('#p-model').value.trim() || profile.defaultModel || undefined,
                apiKey: $('#p-key').value.trim() || undefined,
                baseUrl: $('#p-url').value.trim() || undefined,
                cloudflareAccountId: $('#p-account').value.trim() || undefined,
              },
            });
            if (isViewStale(providerView)) return;
            if (!response.account?.id) throw new Error('A API não confirmou a sincronização dos tokens.');
            accountRefreshGeneration++;
            selectedAccount = response.account;
            const index = accounts.findIndex(item => item.id === selectedAccount.id);
            if (index < 0) accounts.push(selectedAccount); else accounts[index] = selectedAccount;
            if (response.health) applyAccountHealth(selectedAccount.id, response.health);
            testResults.set(selectedAccount.id, {
              kind: response.health?.ok ? 'ok' : 'muted',
              message: 'Tokens de programação ' + ($('#p-tier').value || 'pro').toUpperCase() + ' conectados e em uso · ' + (response.tokenBridge?.defaultModel || selectedAccount.defaultModel || ''),
            });
            await saveProviderSettings();
            if (isViewStale(providerView)) return;
            renderCards();
            loadUsage(selectedAccount);
            saving = false;
            dialog.close();
            [...content().querySelectorAll('[data-edit-account]')].find(el => el.dataset.editAccount === selectedAccount.id)?.focus();
            toast('Tokens de programação ' + providerTitle(providerName) + ' (' + ($('#p-tier').value || 'pro').toUpperCase() + ') puxados e ativos!', 'success');
          } catch (err) {
            if (!isViewStale(providerView) && dialog.open) { result.textContent = err.message; result.className = 'error'; }
          } finally {
            saving = false;
            if (!isViewStale(providerView) && dialog.open) setBusy(false);
          }
        };
        $('#p-form').onsubmit = async event => {
          event.preventDefault();
          if (saving) return;
          stopOAuthPolling();
          const result = $('#p-result');
          result.textContent = 'Salvando conexão...'; result.className = 'muted';
          setBusy(true);
          try {
            const account = await saveAccount();
            if (!account) return;
            await saveProviderSettings();
            if (isViewStale(providerView)) return;
            saving = false; dialog.close();
            [...content().querySelectorAll('[data-edit-account]')].find(el => el.dataset.editAccount === account.id)?.focus();
            toast('Conta salva. Use Testar conexão para verificar a disponibilidade.', 'success');
          } catch (err) {
            if (!isViewStale(providerView) && dialog.open) { result.textContent = err.message; result.className = 'error'; }
          } finally {
            saving = false;
            if (!isViewStale(providerView) && dialog.open) setBusy(false);
          }
        };
        dialog.showModal();
        (selectedAccount ? $('#p-display-name') : $('#p-name')).focus();
      };
      $('#p-add').onclick = event => openProvider(choices[0], event.currentTarget);
      content().querySelector('.providers-page').addEventListener('click', async event => {
        const connect = event.target.closest('[data-connect-provider]');
        if (connect) { openProvider(connect.dataset.connectProvider, connect); return; }
        const pullBtn = event.target.closest('[data-pull-provider]');
        if (pullBtn && !pullBtn.disabled) {
          const providerName = pullBtn.dataset.pullProvider;
          const profile = programmingBridgeProfiles[providerName] || { defaultTier: 'pro', defaultModel: '' };
          pullBtn.disabled = true;
          const originalText = pullBtn.textContent;
          pullBtn.textContent = 'Puxando tokens...';
          try {
            const response = await api('/admin/provider-accounts/pull-tokens', {
              method: 'POST',
              body: {
                providerName,
                displayName: `${providerTitle(providerName)} (${(profile.defaultTier || 'pro').toUpperCase()})`,
                accountTier: profile.defaultTier || 'pro',
                defaultModel: profile.defaultModel || undefined,
              },
            });
            if (isViewStale(providerView)) return;
            if (!response.account?.id) throw new Error('A API não confirmou a sincronização dos tokens.');
            accountRefreshGeneration++;
            const synced = response.account;
            const index = accounts.findIndex(item => item.id === synced.id);
            if (index < 0) accounts.push(synced); else accounts[index] = synced;
            if (response.health) applyAccountHealth(synced.id, response.health);
            testResults.set(synced.id, {
              kind: response.health?.ok ? 'ok' : 'muted',
              message: 'Tokens de programação ' + (profile.defaultTier || 'pro').toUpperCase() + ' conectados e em uso · ' + (response.tokenBridge?.defaultModel || synced.defaultModel || ''),
            });
            renderCards();
            loadUsage(synced);
            [...content().querySelectorAll('[data-edit-account]')].find(el => el.dataset.editAccount === synced.id)?.focus();
            toast('Tokens de programação ' + providerTitle(providerName) + ' (' + (profile.defaultTier || 'pro').toUpperCase() + ') conectados e ativos!', 'success');
          } catch (err) {
            if (!isViewStale(providerView)) {
              pullBtn.disabled = false;
              pullBtn.textContent = originalText;
              toast(err.message || 'Falha ao puxar tokens de programação.', 'error');
            }
          }
          return;
        }
        const edit = event.target.closest('[data-edit-account]');
        if (edit) {
          const account = accounts.find(item => item.id === edit.dataset.editAccount);
          if (account) openProvider(account.providerName, edit, account);
          return;
        }
        const retry = event.target.closest('[data-refresh-usage]');
        if (retry) {
          const account = accounts.find(item => item.id === retry.dataset.refreshUsage);
          if (account) { retry.disabled = true; await loadUsage(account); }
          return;
        }
        const disconnect = event.target.closest('[data-disconnect-account]');
        const test = event.target.closest('[data-test-account]');
        const button = disconnect || test;
        if (!button || button.disabled) return;
        const account = accounts.find(item => item.id === (disconnect ? disconnect.dataset.disconnectAccount : test.dataset.testAccount));
        if (!account) return;
        const result = button.closest('.provider-card').querySelector('[data-account-result]');
        accountOperations.add(account.id);
        button.closest('.provider-card').querySelectorAll('button').forEach(el => { el.disabled = true; });
        const pendingMessage = disconnect ? 'Desconectando conta...' : 'Verificando conexão...';
        testResults.set(account.id, { kind: 'muted', message: pendingMessage });
        result.textContent = pendingMessage;
        result.className = 'provider-test-result muted';
        try {
          if (disconnect) {
            await api(accountPath(account.id), { method: 'DELETE' });
            if (isViewStale(providerView)) return;
            accountRefreshGeneration++;
            accounts = accounts.filter(item => item.id !== account.id);
            usageByAccount.delete(account.id); testResults.delete(account.id); renderCards();
            toast('Conta desconectada.', 'success');
          } else {
            const response = await api(accountPath(account.id) + '/test', { method: 'POST' });
            if (isViewStale(providerView)) return;
            applyAccountHealth(account.id, { ...response.health, checkedAt: response.health.checkedAt || new Date().toISOString() });
            testResults.set(account.id, { kind: response.health.ok ? 'ok' : 'error', message: response.health.ok ? 'Conexão e modelos verificados' + (response.health.modelCount != null ? ' · ' + response.health.modelCount + ' modelos' : '') : response.health.message || 'Conta indisponível' });
            renderCards();
            loadUsage(account);
          }
        } catch (err) {
          if (isViewStale(providerView)) return;
          if (!disconnect) applyAccountHealth(account.id, { ok: null, checkedAt: null, latencyMs: null });
          testResults.set(account.id, { kind: 'error', message: err.message });
          renderCards();
        } finally {
          accountOperations.delete(account.id);
          if (!isViewStale(providerView)) {
            const currentCard = [...content().querySelectorAll('[data-provider-account]')].find(el => el.dataset.providerAccount === account.id);
            currentCard?.querySelectorAll('button').forEach(el => { el.disabled = false; });
            const focusTarget = currentCard?.querySelector(disconnect ? '[data-disconnect-account]' : '[data-test-account]') || content().querySelector('[data-connect-provider="' + account.providerName + '"]');
            focusTarget?.focus();
          }
        }
      });
      renderCards();
      accounts.forEach(loadUsage);
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
        p.models.map((m) => [providerIdentity(p.name), esc(m.id), esc(m.name || ''), m.sizeBytes ? (m.sizeBytes / 1e9).toFixed(1) + ' GB' : '—']),
      );
      const costRows = configured.flatMap((p) =>
        p.models.map((m) => [providerIdentity(p.name), esc(m.modelId), esc(m.capability), '$' + m.costPer1kInput, '$' + m.costPer1kOutput]),
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
        const online = providers.filter((p) => (p.health?.ok || p.models?.length > 0) && p.capabilities.includes('chat'));
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
            <button id="test-run" class="ok" ${online.length ? '' : 'disabled'}><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 10-13h-7z"/></svg>Executar Teste</button>
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
        const rows=providers.flatMap((p)=>p.models.map((m)=>[providerIdentity(p.name),esc(m.id),esc(m.name||m.id),esc((m.capabilities||['image']).join(', '))]));
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
        const totalObservedTokens = usage.reduce((s, u) => s + Number(u.observedTokens || 0), 0);
        const totalEstimatedTokens = usage.reduce((s, u) => s + Number(u.estimatedTokens || 0), 0);
        const totalUnreported = usage.reduce((s, u) => s + Math.max(0, Number(u.requests || 0) - Number(u.cachedHits || 0) - Number(u.observedTokenRequests || 0) - Number(u.estimatedTokenRequests || 0)), 0);
        const totalReq = usage.reduce((s, u) => s + u.requests, 0);
        const byDay = new Map();
        const byProv = new Map();
        for (const u of usage) {
          const dayKey = new Date(u.day).toISOString().slice(0, 10);
          const dCur = byDay.get(dayKey) || { day: dayKey, requests: 0, observedTokens: 0, estimatedTokens: 0, cost: 0 };
          dCur.requests += Number(u.requests || 0);
          dCur.observedTokens += Number(u.observedTokens || 0);
          dCur.estimatedTokens += Number(u.estimatedTokens || 0);
          dCur.cost += Number(u.cost || 0);
          byDay.set(dayKey, dCur);

          const pCur = byProv.get(u.provider) || { name: u.provider, requests: 0, observedTokens: 0, estimatedTokens: 0, estimatedCost: 0 };
          pCur.requests += Number(u.requests || 0);
          pCur.observedTokens += Number(u.observedTokens || 0);
          pCur.estimatedTokens += Number(u.estimatedTokens || 0);
          pCur.estimatedCost += Number(u.cost || 0);
          byProv.set(u.provider, pCur);
        }
        const dailySeries = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
        content().innerHTML = `
          <h1>Tokens &amp; Custos (30 dias)</h1>
          <div class="cards">
            ${card('Requisicoes', totalReq.toLocaleString('pt-BR'))}
            ${card('Tokens reportados', totalObservedTokens.toLocaleString('pt-BR'))}
            ${card('Tokens estimados', totalEstimatedTokens.toLocaleString('pt-BR'))}
            ${card('Chamadas sem medição', totalUnreported.toLocaleString('pt-BR'))}
            ${card('Custo estimado (USD)', '$' + totalCost.toFixed(4))}
          </div>
          <div class="section" style="margin-top:1.25rem;">
            ${renderTelemetryCharts(dailySeries, Array.from(byProv.values()), {
              requests24h: dailySeries.length ? dailySeries[dailySeries.length - 1].requests : 0,
              tokens24h: dailySeries.length ? dailySeries[dailySeries.length - 1].observedTokens : 0,
              requests: totalReq,
              observedTokens: totalObservedTokens,
              estimatedTokens: totalEstimatedTokens,
              cost: totalCost,
            })}
          </div>
          ${table(
            ['Dia', 'Tenant', 'Capacidade', 'Provider', 'Requisicoes', 'Cache', 'Tokens reportados', 'Tokens estimados', 'Sem medição', 'Custo estimado'],
            usage.map((u) => [
              new Date(u.day).toLocaleDateString('pt-BR'), esc(u.tenant?.name || u.tenantId),
              esc(u.capability), esc(u.provider), u.requests, u.cachedHits, esc(u.observedTokens || 0), esc(u.estimatedTokens || 0),
              Math.max(0, Number(u.requests || 0) - Number(u.cachedHits || 0) - Number(u.observedTokenRequests || 0) - Number(u.estimatedTokenRequests || 0)),
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
            ['Quando', 'Capacidade', 'Provider', 'Modelo', 'Cache', 'Status', 'Uso de tokens', 'Duracao', 'Custo estimado'],
            logs.map((l) => [
              fmtDate(l.createdAt), esc(l.capability), esc(l.provider), esc(l.model),
              l.cached ? '<span class="ok">hit</span>' : '—',
              badge(l.success, 'ok', l.errorCode || 'erro'),
              l.tokenUsageSource === 'observed' ? l.totalTokens + ' reportados' : l.tokenUsageSource === 'estimated' ? '~' + l.totalTokens + ' estimados' : l.cached ? 'Cache (sem chamada ao provider)' : 'Não informado',
              fmtMs(l.durationMs), '$' + l.cost.toFixed(5),
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
      const scopes = ['text', 'chat', 'image', 'video', 'vision', 'embed', 'ocr', 'audio', 'workflow', 'admin'];

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
            ['Quando', 'Cap', 'Provider', 'Modelo', 'Status', 'Uso de tokens', 'Tempo'],
            logs.map(l => [
              fmtDate(l.createdAt), esc(l.capability), esc(l.provider), esc(l.model),
              badge(l.success, 'ok', l.errorCode || 'erro'),
              l.tokenUsageSource === 'observed' ? l.totalTokens + ' reportados' : l.tokenUsageSource === 'estimated' ? '~' + l.totalTokens + ' estimados' : l.cached ? 'Cache' : 'Não informado', fmtMs(l.durationMs)
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
        ${table(['Nome','Status','Padrão','Atualizado','Ações'],workflows.map(w=>[esc(w.name),badge(w.enabled,'ativo','desativado'),w.isDefault?favoriteIcon+' Padrão':'—',fmtDate(w.updatedAt),`<button class="ghost" data-default="${w.id}">Padrão</button> <button class="ghost" data-toggle="${w.id}" data-enabled="${w.enabled}">${w.enabled?'Desativar':'Ativar'}</button> <button class="ghost" data-copy="${w.id}">Duplicar</button> <button class="ghost" data-export="${w.id}">Exportar</button>`]))}`;
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
      content().innerHTML=`<h1>Biblioteca de Prompts</h1><p class="muted">Prompts reutilizáveis, categorizados e versionados.</p><div class="card section"><h2>Novo prompt</h2><div class="form-grid"><label>Nome <input id="pm-name" /></label><label>Categoria <select id="pm-category">${categories.map(c=>`<option value="${c}">${c}</option>`).join('')}</select></label><label class="inline-check"><input id="pm-favorite" type="checkbox"/> Favorito</label><label class="inline-check"><input id="pm-shared" type="checkbox"/> Compartilhado</label></div><label>Template <textarea id="pm-template" placeholder="Use {{variavel}} para campos dinâmicos"></textarea></label><button id="pm-save">Salvar prompt</button><span id="pm-status" class="muted"></span></div><div class="image-grid">${prompts.map(p=>`<article class="card"><strong>${p.favorite?favoriteIcon+' ':''}${esc(p.name)}</strong><span class="badge">${esc(p.category||'geral')}</span><small>v${p.version} · ${p.shared?'compartilhado':'privado'}</small><pre class="code">${esc(p.template.slice(0,500))}</pre><div><button class="ghost" data-fav="${p.id}" data-value="${p.favorite}">${p.favorite?'Desfavoritar':'Favoritar'}</button> <button class="ghost" data-del-prompt="${p.id}">Excluir</button></div></article>`).join('')||'<p class="empty-state">Nenhum prompt salvo.</p>'}</div>`;
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
    audio: 'Estúdio de Áudio',
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
    const [routeHash, routeQuery] = rawHash.split('?', 2);
    const oauthStatus = routeQuery ? new URLSearchParams(routeQuery).get('oauth') : null;
    const projectMatch = routeHash.match(/^project\/(.+)$/);
    let hash = projectMatch ? 'project' : routeHash;
    if (hash === 'login') { location.hash = '#/'; hash = 'home'; }
    document.querySelectorAll('.sidebar nav a').forEach((a) => {
      const active =
        a.getAttribute('href') === `#/${hash}` ||
        (hash === 'project' && a.getAttribute('href') === '#/projects');
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
      if (active) {
        const group = a.closest('.nav-group');
        group?.classList.add('open');
        group?.querySelector('.nav-group-toggle')?.setAttribute('aria-expanded', 'true');
      }
    });

    // Fechar drawer mobile ao navegar
    const sidebar = $('#sidebar');
    const backdrop = $('#sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.add('hidden');
    if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', 'false');
    if (sidebarToggle) sidebarToggle.setAttribute('aria-label', 'Abrir menu de navegação');

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
      if (hash === 'providers' && oauthStatus) {
        if (oauthStatus === 'connected') toast('Conta Google conectada. Teste a conexão para confirmar que está online.', 'success');
        else if (oauthStatus === 'denied') toast('A autorização do Google foi cancelada.', 'error');
        else toast('Não foi possível concluir a autorização do Google. Tente novamente ou use uma API key.', 'error');
        history.replaceState(null, '', `${location.pathname}${location.search}#/providers`);
      }
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
      const res = await fetch(API + '/admin/metrics', { headers: { authorization: `Bearer ${token()}` } });
      if (!res.ok) throw new Error('Métricas indisponíveis (HTTP ' + res.status + ')');
      const text = await res.text();
      if (!text.includes('# HELP')) throw new Error('O proxy não retornou métricas Prometheus');
      content().innerHTML = `<h1>Prometheus Metrics</h1><pre class="code" style="font-size:0.75rem; max-height:80vh; overflow:auto;">${esc(text)}</pre>`;
    } catch(e) {
      content().innerHTML = `<h1>Prometheus Metrics</h1><p class="error">Erro ao carregar: ${esc(e.message)}</p>`;
    }
  };

  pages.audio = async () => {
    content().innerHTML = `<section class="section audio-studio"><h1>Estúdio de Áudio Open-Source</h1><p class="muted">Suíte completa de voz local na VPS (estilo ElevenLabs Open-Source): Transcrição (Faster-Whisper STT), Síntese de Voz Neural (Kokoro-82M / eSpeak DSP), Texto produzido por IA em Voz, Modulador de Voz Speech-to-Speech e Conversa por Áudio.</p><div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;"><p id="audio-engine-status" class="badge muted" role="status" style="margin:0;">Verificando engines locais…</p><span id="audio-engine-models" class="badge muted" style="font-family:var(--font-mono);">STT: faster-whisper · TTS: kokoro-82m / dsp</span></div><label>Projeto<select id="audio-project-select"><option value="">Área do tenant</option></select></label>
      <div class="audio-grid">
        <article class="card"><h2>Transcrever</h2><label>Arquivo<input id="audio-stt-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"></label><div class="button-row"><button id="audio-record-start" class="ghost">Gravar</button><button id="audio-record-stop" class="ghost" disabled>Parar</button><button id="audio-transcribe">Transcrever</button></div><p id="audio-record-state" class="muted" aria-live="polite"></p><div id="audio-transcript" class="code audio-output" aria-live="polite">Selecione ou grave um áudio.</div></article>
        <article class="card"><h2>Gerar fala & IA em Voz</h2><label>Texto ou Prompt para a IA<textarea id="audio-speech-text" rows="4" maxlength="10000" placeholder="Digite o texto para falar ou uma instrução para a IA criar e narrar em português"></textarea></label><div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;"><label>Voz Open-Source<select id="audio-voice-select"><option value="pf_dora">Dora · PT-BR (Feminina)</option><option value="pm_alex">Alex · PT-BR (Masculino)</option><option value="pm_santa">Narrador · PT-BR (Grave)</option><option value="af_heart">Heart · EN-US (Feminina)</option><option value="af_bella">Bella · EN-US (Expressiva)</option><option value="am_adam">Adam · EN-US (Masculino)</option></select></label><label>Timbre / Perfil DSP<select id="audio-profile-select"><option value="natural">Natural (Padrão)</option><option value="studio_warm">Estúdio Quente (Podcast)</option><option value="deep_voice">Voz Grave & Profunda</option><option value="bright_clear">Clara & Cristalina</option><option value="radio">Broadcast / Rádio</option></select></label></div><label>Velocidade<select id="audio-speed-select"><option value="1">1.0x (Normal)</option><option value="0.85">0.85x (Pausada)</option><option value="1.15">1.15x (Dinâmica)</option><option value="1.3">1.30x (Rápida)</option></select></label><div class="button-row" style="display:flex;gap:0.5rem;flex-wrap:wrap;"><button id="audio-speech-generate">Converter Texto em Voz</button><button id="audio-ai-speech-generate" class="ghost" style="border-color:rgba(6,182,212,0.45);color:#38bdf8;">✨ IA Produzir Texto + Voz</button></div><div id="audio-speech-result" class="audio-output" aria-live="polite"></div></article>
        <article class="card"><h2>Modificar Voz (Speech-to-Speech)</h2><p class="muted">Recebe um áudio gravado e transforma a fala na voz e timbre selecionados (estilo Voice Changer).</p><label>Áudio de entrada<input id="audio-transform-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"></label><button id="audio-transform-run">Transformar Voz</button><div id="audio-transform-result" class="audio-output" aria-live="polite"></div></article>
        <article class="card"><h2>Conversa por áudio</h2><p class="muted">Um turno: STT → modelo local → TTS.</p><label>Instrução<textarea id="audio-conversation-prompt" rows="3">Responda com clareza e em português brasileiro.</textarea></label><label>Áudio<input id="audio-conversation-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"></label><button id="audio-conversation-run">Enviar turno</button><div id="audio-conversation-result" class="audio-output" aria-live="polite"></div></article>
        <article class="card"><h2>Biblioteca de amostras autorizadas</h2><p class="muted">Armazenamento com consentimento. Clonagem de voz continua desativada até um engine passar pelo benchmark da VPS.</p><label>Nome<input id="audio-voice-name" maxlength="120"></label><label>Amostra<input id="audio-voice-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"></label><label class="audio-consent"><input id="audio-voice-consent" type="checkbox"> Confirmo que tenho autorização para armazenar esta amostra.</label><button id="audio-voice-save" class="ghost">Salvar amostra</button><div id="audio-voice-list" class="audio-output" aria-live="polite">Carregando…</div></article>
      </div><div class="section"><h2>Áudios gerados</h2><div id="audio-assets" class="audio-output">Carregando…</div></div></section>`;
    const currentView = viewController;
    const audioObjectUrls = new Set();
    let activeRecorder;
    let activeStream;
    currentView.signal.addEventListener('abort', () => {
      if (activeRecorder?.state === 'recording') activeRecorder.stop();
      activeStream?.getTracks().forEach((track) => track.stop());
      audioObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    }, { once: true });
    try {
      const { projects } = await api('/admin/projects');
      $('#audio-project-select').innerHTML += projects.map((project) => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
      $('#audio-project-select').addEventListener('change', () => { refreshVoices().catch(() => {}); refreshAssets().catch(() => {}); });
    } catch { /* Seleção de projeto é opcional para chaves sem acesso administrativo. */ }
    const projectPayload = () => $('#audio-project-select')?.value ? { projectId: $('#audio-project-select').value } : {};
    const readAudio = async (file) => {
      if (!file) throw new Error('Selecione um arquivo de áudio.');
      if (file.size > 18 * 1024 * 1024) throw new Error('O limite por arquivo é 18 MiB.');
      return fileDataUrl(file);
    };
    const pollAudioJob = async (jobId, output) => {
      output.textContent = `Job ${jobId} · aguardando processamento local…`;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (currentView.signal.aborted) return null;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await api(`/v1/jobs/${encodeURIComponent(jobId)}`);
        if (status.status === 'completed') return status.result?.result ?? status.result;
        if (status.status === 'failed') throw new Error(status.error || 'O job de áudio falhou.');
        output.textContent = `Processando localmente · ${status.status}`;
      }
      throw new Error('O job segue em andamento; consulte Filas e jobs.');
    };
    const enqueueAudio = async (path, payload, output) => pollAudioJob((await api(path, { method: 'POST', body: payload })).jobId, output);
    const renderAudioPlayer = async (assetId, output) => {
      const response = await fetch(`/v1/audio/assets/${encodeURIComponent(assetId)}`, { headers: { authorization: `Bearer ${token()}` }, signal: currentView.signal });
      if (!response.ok) throw new Error(`Não foi possível abrir o áudio (HTTP ${response.status}).`);
      const objectUrl = URL.createObjectURL(await response.blob()); audioObjectUrls.add(objectUrl);
      output.innerHTML = `<audio controls src="${objectUrl}"></audio><a href="${objectUrl}" download="audio-${esc(assetId)}.wav">Baixar áudio</a>`;
    };
    const refreshAssets = async () => {
      const project = $('#audio-project-select')?.value;
      const { assets } = await api('/v1/audio/assets' + (project ? `?projectId=${encodeURIComponent(project)}` : ''));
      $('#audio-assets').innerHTML = `<div id="audio-assets-player"></div>` + (assets.length ? assets.map((asset) => { const m = asset.metadata || {}; const label = m.mode === 'ai-speech' ? '✨ IA → Voz' : m.mode === 'speech-to-speech' ? '🎙️ Modulador STS' : '🗣️ Síntese TTS'; const voiceTag = m.voice ? ` · ${esc(m.voice)}` : ''; const profileTag = m.profile && m.profile !== 'natural' ? ` (${esc(m.profile)})` : ''; return `<div class="audio-voice-row"><span><strong>${label}</strong>${voiceTag}${profileTag} · <small>${esc(fmtDate(asset.createdAt))}</small></span><span><button class="ghost" data-audio-play="${esc(asset.id)}">Reproduzir</button> <button class="ghost" data-audio-delete-asset="${esc(asset.id)}">Excluir</button></span></div>`; }).join('') : '<p class="muted">Nenhum áudio gerado ainda.</p>');
      $('#audio-assets').querySelectorAll('[data-audio-play]').forEach((button) => button.addEventListener('click', async () => { try { await renderAudioPlayer(button.dataset.audioPlay, $('#audio-assets-player') || $('#audio-assets')); } catch (error) { toast(error.message, 'error'); } }));
      $('#audio-assets').querySelectorAll('[data-audio-delete-asset]').forEach((button) => button.addEventListener('click', async () => { try { await api(`/v1/audio/assets/${encodeURIComponent(button.dataset.audioDeleteAsset)}`, { method: 'DELETE' }); await refreshAssets(); } catch (error) { toast(error.message, 'error'); } }));
    };
    const refreshVoices = async () => {
      const project = $('#audio-project-select')?.value;
      const { voices } = await api('/v1/audio/voices' + (project ? `?projectId=${encodeURIComponent(project)}` : ''));
      $('#audio-voice-list').innerHTML = voices.length ? voices.map((voice) => `<div class="audio-voice-row"><span>${esc(voice.name)} <small>${esc(fmtDate(voice.createdAt))}</small></span><span><button class="ghost" data-audio-play-voice="${esc(voice.id)}">Ouvir amostra</button> <button class="ghost" data-audio-delete-voice="${esc(voice.id)}">Excluir</button></span></div>`).join('') : '<p class="muted">Nenhuma amostra salva.</p>';
      $('#audio-voice-list').querySelectorAll('[data-audio-play-voice]').forEach((button) => button.addEventListener('click', async () => { try { await renderProtectedSample(button.dataset.audioPlayVoice, $('#audio-voice-list')); } catch (error) { toast(error.message, 'error'); } }));
      $('#audio-voice-list').querySelectorAll('[data-audio-delete-voice]').forEach((button) => button.addEventListener('click', async () => {
        try { await api(`/v1/audio/voices/${encodeURIComponent(button.dataset.audioDeleteVoice)}`, { method: 'DELETE' }); await refreshVoices(); }
        catch (error) { toast(error.message, 'error'); }
      }));
    };
    const renderProtectedSample = async (voiceId, output) => {
      const response = await fetch(`/v1/audio/voices/${encodeURIComponent(voiceId)}/sample`, { headers: { authorization: `Bearer ${token()}` }, signal: currentView.signal });
      if (!response.ok) throw new Error(`Amostra indisponível (HTTP ${response.status}).`);
      const url = URL.createObjectURL(await response.blob()); audioObjectUrls.add(url); output.innerHTML = `<audio controls src="${url}"></audio>`;
    };
    try { await Promise.all([refreshVoices(), refreshAssets()]); } catch (error) { $('#audio-voice-list').textContent = `Biblioteca indisponível: ${error.message}`; }
    try {
      const health = await api('/v1/audio/health');
      $('#audio-engine-status').textContent = health.available ? 'Engine local pronta (STT + TTS + Modulador ativos)' : 'Engine local indisponível ou pesos ausentes';
      if ($('#audio-engine-models') && health.available) $('#audio-engine-models').textContent = `STT: ${health.stt?.engine || 'faster-whisper'} (${health.stt?.model || 'base'}) · TTS: ${health.tts?.engine || 'kokoro-82m'} · ${Array.isArray(health.voices) ? health.voices.length : 6} vozes`;
      $('#audio-engine-status').className = `badge ${health.available ? 'ok' : 'err'}`;
    } catch { $('#audio-engine-status').textContent = 'Status da engine local indisponível'; }
    $('#audio-transcribe').onclick = async () => {
      const output = $('#audio-transcript');
      try { const result = await enqueueAudio('/v1/audio/transcriptions', { ...projectPayload(), audio: await readAudio($('#audio-stt-file').files[0]) }, output); if (result) output.textContent = result.text || 'Nenhuma fala reconhecida.'; }
      catch (error) { output.textContent = error.message; }
    };
    $('#audio-speech-generate').onclick = async () => {
      const output = $('#audio-speech-result');
      try { const result = await enqueueAudio('/v1/audio/speech', { ...projectPayload(), text: $('#audio-speech-text').value, voice: $('#audio-voice-select').value, profile: $('#audio-profile-select')?.value || 'natural', speed: Number($('#audio-speed-select')?.value || 1) }, output); if (result?.assetId) { await renderAudioPlayer(result.assetId, output); await refreshAssets(); } }
      catch (error) { output.textContent = error.message; }
    };
    $('#audio-ai-speech-generate').onclick = async () => {
      const output = $('#audio-speech-result');
      try { const result = await enqueueAudio('/v1/audio/ai-speech', { ...projectPayload(), prompt: $('#audio-speech-text').value, voice: $('#audio-voice-select').value, profile: $('#audio-profile-select')?.value || 'natural', speed: Number($('#audio-speed-select')?.value || 1) }, output); if (result) { output.innerHTML = `<p style="margin:0 0 0.5rem;"><strong>Texto IA:</strong> ${esc(result.text || '')}</p><div class="audio-player-box"></div>`; if (result.assetId) await renderAudioPlayer(result.assetId, output.querySelector('.audio-player-box') || output); await refreshAssets(); } }
      catch (error) { output.textContent = error.message; }
    };
    $('#audio-transform-run').onclick = async () => {
      const output = $('#audio-transform-result');
      try { const result = await enqueueAudio('/v1/audio/transform', { ...projectPayload(), audio: await readAudio($('#audio-transform-file').files[0]), voice: $('#audio-voice-select').value, profile: $('#audio-profile-select')?.value || 'natural', speed: Number($('#audio-speed-select')?.value || 1) }, output); if (result) { output.innerHTML = `<p style="margin:0 0 0.5rem;"><strong>Fala detectada:</strong> ${esc(result.transcript || 'Modulação direta DSP')}</p><div class="audio-player-box"></div>`; if (result.assetId) await renderAudioPlayer(result.assetId, output.querySelector('.audio-player-box') || output); await refreshAssets(); } }
      catch (error) { output.textContent = error.message; }
    };
    $('#audio-conversation-run').onclick = async () => {
      const output = $('#audio-conversation-result');
      try { const result = await enqueueAudio('/v1/audio/conversations', { ...projectPayload(), audio: await readAudio($('#audio-conversation-file').files[0]), prompt: $('#audio-conversation-prompt').value, voice: $('#audio-voice-select').value, profile: $('#audio-profile-select')?.value || 'natural', speed: Number($('#audio-speed-select')?.value || 1) }, output); if (result) { output.innerHTML = `<p><strong>Você:</strong> ${esc(result.transcript)}</p><p><strong>Resposta:</strong> ${esc(result.answer)}</p><div class="audio-player-box"></div>`; if (result.speech?.assetId) await renderAudioPlayer(result.speech.assetId, output.querySelector('.audio-player-box') || output); await refreshAssets(); } }
      catch (error) { output.textContent = error.message; }
    };
    $('#audio-voice-save').onclick = async () => {
      try {
        if (!$('#audio-voice-consent').checked) throw new Error('Confirme a autorização antes de salvar a amostra.');
        await api('/v1/audio/voices', { method: 'POST', body: { ...projectPayload(), name: $('#audio-voice-name').value, audio: await readAudio($('#audio-voice-file').files[0]), authorized: true } });
        await refreshVoices(); toast('Amostra salva com autorização.', 'success');
      } catch (error) { toast(error.message, 'error'); }
    };
    let recorded = [];
    $('#audio-record-start').onclick = async () => {
      try {
        if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('A gravação exige uma origem HTTPS segura.');
        activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        activeRecorder = new MediaRecorder(activeStream); recorded = [];
        activeRecorder.ondataavailable = (event) => { if (event.data.size) recorded.push(event.data); };
        activeRecorder.onstop = () => { activeStream?.getTracks().forEach((track) => track.stop()); if (currentView.signal.aborted) return; const blob = new Blob(recorded, { type: activeRecorder.mimeType || 'audio/webm' }); const file = new File([blob], 'gravacao.webm', { type: blob.type }); const transfer = new DataTransfer(); transfer.items.add(file); $('#audio-stt-file').files = transfer.files; $('#audio-record-state').textContent = 'Gravação pronta para transcrever.'; };
        activeRecorder.start(); $('#audio-record-start').disabled = true; $('#audio-record-stop').disabled = false; $('#audio-record-state').textContent = 'Gravando…';
      } catch (error) { $('#audio-record-state').textContent = `Microfone indisponível: ${error.message}`; }
    };
    $('#audio-record-stop').onclick = () => { activeRecorder?.stop(); $('#audio-record-start').disabled = false; $('#audio-record-stop').disabled = true; };
  };
  pages.tenants = pages.settings;

  // Controles de interface mobile & Áudio
  const sidebarToggle = $('#sidebar-toggle');
  const sidebarBackdrop = $('#sidebar-backdrop');
  if (sidebarToggle) {
    sidebarToggle.setAttribute('aria-controls', 'sidebar');
    sidebarToggle.setAttribute('aria-expanded', 'false');
    sidebarToggle.addEventListener('click', () => {
      const sb = $('#sidebar');
      const bd = $('#sidebar-backdrop');
      const open = !sb?.classList.contains('mobile-open');
      if (sb) sb.classList.toggle('mobile-open', open);
      if (bd) bd.classList.toggle('hidden', !open);
      sidebarToggle.setAttribute('aria-expanded', String(open));
      sidebarToggle.setAttribute('aria-label', open ? 'Fechar menu de navegação' : 'Abrir menu de navegação');
    });
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => {
      const sb = $('#sidebar');
      if (sb) sb.classList.remove('mobile-open');
      sidebarBackdrop.classList.add('hidden');
      sidebarToggle?.setAttribute('aria-expanded', 'false');
      sidebarToggle?.setAttribute('aria-label', 'Abrir menu de navegação');
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
