// Embedded mode: runs inside the partner CRM iframe. No cookies — auth is a bearer
// token (X-Embed-Token) obtained by exchanging the one-time 60s link token.
(function () {
  'use strict';

  let EMBED_TOKEN = null;
  let PARENT_ORIGINS = [];
  let metaEsConfigId = null;
  let currentBusiness = { connected: false, bot_paused: false, plan: null, id: null };

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.hidden = !on; };

  function authHeaders(extra) {
    const h = { ...(extra || {}) };
    if (EMBED_TOKEN) h['X-Embed-Token'] = EMBED_TOKEN;
    return h;
  }

  // ── postMessage a Pupi (solo a orígenes permitidos) ──
  function notifyParent(event, extra) {
    if (window.parent === window) return;
    const msg = Object.assign({ source: 'assistant-embed', event }, extra || {});
    for (const origin of PARENT_ORIGINS) {
      try { window.parent.postMessage(msg, origin); } catch (_) {}
    }
  }
  function reportHeight() {
    const h = Math.ceil(document.getElementById('embed-root').getBoundingClientRect().height) + 32;
    notifyParent('resize', { height: h });
  }

  function applyTheme(theme) {
    if (!theme) return;
    const map = {
      background: '--bg', surface: '--surface', border: '--border', accent: '--accent',
      text: '--text', textMuted: '--text-muted', radius: '--radius', font: '--font',
    };
    const root = document.documentElement.style;
    for (const k in map) if (theme[k]) root.setProperty(map[k], theme[k]);
  }

  function fatal(msg) {
    show($('embed-loading'), false);
    show($('embed-steps'), false);
    const e = $('embed-error'); e.textContent = msg; show(e, true);
    reportHeight();
  }

  // ── Paso 1: WhatsApp (mismo flujo Meta que el panel) ──
  function renderStep1() {
    show($('wa-connected'), currentBusiness.connected);
    show($('wa-connect'), !currentBusiness.connected);
  }

  let esSubmitted = false;
  async function submitConnection(data) {
    if (esSubmitted) return; esSubmitted = true;
    const errEl = $('wa-connect-error');
    try {
      const r = await fetch('/auth/whatsapp/callback', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ code: data.code || null, waba_id: data.waba_id, phone_number_id: data.phone_number_id, business_id: currentBusiness.id }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'Error');
      currentBusiness.connected = true;
      renderStep1();
      show(errEl, false);
      notifyParent('whatsapp_connected');
      refreshState();
    } catch (err) {
      errEl.textContent = 'No pudimos guardar la conexión. Intentá de nuevo.';
      show(errEl, true);
    } finally {
      esSubmitted = false;
      $('btn-wa-connect').disabled = false;
      reportHeight();
    }
  }

  // Meta postea WA_EMBEDDED_SIGNUP a esta ventana (la del embed). Su propia ventanita
  // de login se abre con FB.login y, al terminar, vuelve sola con el evento FINISH.
  window.addEventListener('message', function (event) {
    if (!/\.facebook\.com$|\.meta\.com$/.test(event.origin)) return;
    let data;
    try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
    if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return;
    const errEl = $('wa-connect-error');
    if (data.event === 'FINISH') {
      const { phone_number_id, waba_id } = data.data || {};
      if (!waba_id || !phone_number_id) {
        errEl.textContent = 'No pudimos completar la conexión. Cerrá la ventana e intentá de nuevo.';
        show(errEl, true); $('btn-wa-connect').disabled = false; return;
      }
      window.__pendingWa = { waba_id, phone_number_id };
      submitConnection(Object.assign({ code: window.__pendingWaCode || null }, window.__pendingWa));
    } else if (data.event === 'CANCEL' || data.event === 'ERROR') {
      errEl.textContent = 'La conexión no se completó. Volvé a intentarlo.';
      show(errEl, true); $('btn-wa-connect').disabled = false;
    }
  });

  function wireWaButton() {
    $('btn-wa-connect').addEventListener('click', function () {
      const errEl = $('wa-connect-error');
      if (!metaEsConfigId || !window.FB) {
        errEl.textContent = 'No se pudo abrir la conexión de WhatsApp. Recargá e intentá de nuevo.';
        show(errEl, true); return;
      }
      show(errEl, false);
      this.disabled = true;
      window.__pendingWa = null; window.__pendingWaCode = null;
      fetch('/api/es-pending', { method: 'POST', headers: authHeaders() }).catch(() => {});
      // FB.login abre la ventanita de Meta (funciona dentro del iframe en Safari/iPhone
      // porque se dispara con el click del usuario) y vuelve sola al terminar.
      FB.login(function (response) {
        if (response.authResponse && response.authResponse.code) {
          window.__pendingWaCode = response.authResponse.code;
          if (window.__pendingWa) submitConnection(Object.assign({ code: window.__pendingWaCode }, window.__pendingWa));
        } else {
          $('btn-wa-connect').disabled = false;
        }
      }, {
        config_id: metaEsConfigId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
      });
    });
  }

  // ── Paso 3: estado + pausa + uso ──
  function renderStep3(state) {
    const paused = !!state.bot_paused;
    const toggle = $('pause-toggle');
    toggle.checked = !paused;           // marcado = activo
    $('status-label').textContent = paused ? 'Pausado' : 'Activo';

    // Sin dólares: una sola barra con el % del plan usado y la cuenta de conversaciones.
    const u = state.usage || {};
    const pct = Math.max(0, u.percent_used || 0);
    $('plan-pct-label').textContent = `Usaste ${Math.min(pct, 100)}% de tu plan este mes`;
    const bar = $('plan-bar');
    bar.style.width = Math.min(100, pct) + '%';
    bar.classList.toggle('over', pct >= 100);
    $('conv-line').textContent = `${u.conversations || 0} de ${u.conv_cap || 0} conversaciones`;
  }

  function wirePauseToggle() {
    $('pause-toggle').addEventListener('change', async function () {
      const paused = !this.checked; // desmarcado = pausado
      this.disabled = true;
      try {
        const r = await fetch('/api/business/bot-paused', {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ paused }),
        });
        if (!r.ok) throw new Error();
        currentBusiness.bot_paused = paused;
        $('status-label').textContent = paused ? 'Pausado' : 'Activo';
        notifyParent(paused ? 'paused' : 'resumed');
      } catch (_) {
        this.checked = !this.checked; // revertir
      } finally {
        this.disabled = false;
        reportHeight();
      }
    });
  }

  // ── Estado ──
  async function refreshState() {
    const r = await fetch('/api/embed/state', { headers: authHeaders() });
    if (!r.ok) return;
    const state = await r.json();
    if (!state || state.business === null) return;
    currentBusiness.connected = state.connected;
    currentBusiness.bot_paused = state.bot_paused;
    currentBusiness.plan = state.plan;
    renderStep1();
    renderStep3(state);
    reportHeight();
  }

  // Paso 2: cuando el configurador aplica cambios, avisamos a Pupi.
  window.addEventListener('config-chat:applied', function () {
    notifyParent('configured');
    refreshState();
  });

  async function init() {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    if (!token) return fatal('Enlace inválido o vencido.');

    // 1) Canjear el token de un solo uso por un token de sesión del embed.
    let session;
    try {
      const r = await fetch('/api/embed/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      session = await r.json();
      if (!r.ok) throw new Error(session.error || 'Error');
    } catch (_) {
      return fatal('Enlace inválido o vencido.');
    }
    EMBED_TOKEN = session.embed_token;
    window.__EMBED_TOKEN__ = EMBED_TOKEN;
    PARENT_ORIGINS = session.origins || [];
    applyTheme(session.theme);
    // Sacar el token de la URL (ya fue consumido).
    history.replaceState(null, '', '/embed');

    // 2) Config pública de Meta para FB.init + config_id.
    try {
      const cfg = await (await fetch('/api/config')).json();
      metaEsConfigId = cfg.metaEsConfigId || null;
      window.__FB_APP_ID__ = cfg.metaAppId || '1025010310140011';
      if (window.FB && !window.__FB_READY__) { FB.init({ appId: window.__FB_APP_ID__, cookie: true, version: 'v21.0', xfbml: false }); window.__FB_READY__ = true; }
    } catch (_) {}

    // 3) Estado inicial.
    const r2 = await fetch('/api/embed/state', { headers: authHeaders() });
    if (!r2.ok) return fatal('No pudimos cargar tu asistente.');
    const state = await r2.json();

    show($('embed-loading'), false);
    show($('embed-steps'), true);

    currentBusiness = { connected: state.connected, bot_paused: state.bot_paused, plan: state.plan, id: null };
    // business id para /auth/whatsapp/callback (lo tomamos de /api/business).
    try { const biz = await (await fetch('/api/business', { headers: authHeaders() })).json(); currentBusiness.id = biz && biz.id; } catch (_) {}

    renderStep1();
    renderStep3(state);
    wireWaButton();
    wirePauseToggle();

    // 4) Paso 2: inyectar el configurador (usa window.__EMBED_TOKEN__).
    const s = document.createElement('script');
    s.src = '/js/config-chat.js';
    document.body.appendChild(s);

    // 5) Reportar altura a Pupi (inicial + ante cambios).
    reportHeight();
    if (window.ResizeObserver) new ResizeObserver(reportHeight).observe($('embed-root'));
  }

  init();
})();
