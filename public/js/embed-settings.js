// "Más ajustes" inside the embed: every setting of the Daxos panel (dashboard.html) that
// applies to a partner account, folded into sections so the screen stays simple.
// Same endpoints as the panel, authenticated with the embed token.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.hidden = !on; };
  const DAYS = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];

  let ctx = null;
  let biz = null;
  let me = null;
  let loadedOnce = false;

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function api(path, opts) {
    opts = opts || {};
    const isForm = opts.form instanceof FormData;
    const headers = ctx.authHeaders(opts.body ? { 'Content-Type': 'application/json' } : {});
    return fetch(path, {
      method: opts.method || 'GET', headers,
      body: isForm ? opts.form : opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }
  const parseJson = (v, fallback) => { if (v == null) return fallback; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fallback; } };

  // PUT /api/business replaces the whole profile: always start from the saved values.
  function fullPayload(b) {
    const sa = parseJson(b.survey_answers, {}) || {};
    return {
      name: b.name || 'Mi negocio',
      whatsapp_number: b.whatsapp_number || null,
      business_context: b.business_context || null,
      website_url: b.website_url || null,
      pricing_info: b.pricing_info || null,
      owner_rules: b.owner_rules || null,
      owner_pause_hours: b.owner_pause_hours ?? null,
      sales_examples: Array.isArray(parseJson(b.sales_examples, [])) ? parseJson(b.sales_examples, []) : [],
      survey_answers: sa,
      pause_keywords: b.pause_keywords || null,
      pause_reply_text: b.pause_reply_text || null,
      urgent_keywords: b.urgent_keywords || null,
      urgent_alert_enabled: b.urgent_alert_enabled ? 1 : 0,
      business_hours: b.business_hours || null,
      after_hours_instructions: b.after_hours_instructions || null,
      urgent_phone: b.urgent_phone || null,
      response_delay: b.response_delay ?? 5,
      response_mode: b.response_mode || 'texto',
    };
  }
  async function loadBiz() {
    const r = await api('/api/business');
    biz = r.ok ? await r.json() : null;
    return biz;
  }
  async function saveBiz(changes, statusEl) {
    status(statusEl, 'Guardando…');
    await loadBiz();
    if (!biz) return status(statusEl, 'No se pudo guardar.', true);
    const payload = Object.assign(fullPayload(biz), changes);
    const r = await api('/api/business', { method: 'PUT', body: payload });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return status(statusEl, d.error || 'No se pudo guardar.', true);
    }
    await loadBiz();
    status(statusEl, 'Guardado ✓');
    return true;
  }
  function status(el, msg, err) {
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('is-err', !!err);
    show(el, !!msg);
    if (!err && msg.endsWith('✓')) setTimeout(() => { if (el.textContent === msg) show(el, false); }, 2500);
  }
  async function toggle(path, enabled, statusEl) {
    const r = await api(path, { method: 'PATCH', body: { enabled } });
    status(statusEl, r.ok ? 'Guardado ✓' : 'No se pudo guardar.', !r.ok);
    return r.ok;
  }

  // ── Section builders ──
  const field = (id, label, value, { area, rows = 3, placeholder = '', hint = '', type = 'text', max } = {}) => `
    <label class="set-field"><span class="set-label">${esc(label)}</span>
      ${area ? `<textarea class="field" id="${id}" rows="${rows}" placeholder="${esc(placeholder)}"${max ? ` maxlength="${max}"` : ''}>${esc(value || '')}</textarea>`
             : `<input class="field" id="${id}" type="${type}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}"${max ? ` maxlength="${max}"` : ''} />`}
      ${hint ? `<span class="set-hint">${esc(hint)}</span>` : ''}</label>`;
  const switchRow = (id, label, on, hint = '') => `
    <div class="set-switch"><div><span class="set-label">${esc(label)}</span>${hint ? `<span class="set-hint">${esc(hint)}</span>` : ''}</div>
      <label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}/><span class="slider"></span></label></div>`;
  const radios = (name, label, value, opts) => `
    <div class="set-field"><span class="set-label">${esc(label)}</span><div class="seg">${opts.map(([v, l]) =>
      `<label class="seg-opt"><input type="radio" name="${name}" value="${v}" ${value === v ? 'checked' : ''}/><span>${esc(l)}</span></label>`).join('')}</div></div>`;
  const saveRow = (id) => `<div class="set-actions"><span class="set-status" id="${id}-status" hidden></span><button type="button" class="btn btn-accent btn-sm" id="${id}">Guardar</button></div>`;
  const section = (key, title, sub, body) => `
    <details class="set-sec" data-sec="${key}"><summary><span class="set-title">${esc(title)}</span><span class="set-sub">${esc(sub)}</span></summary>
      <div class="set-body">${body}</div></details>`;

  function hoursEditor(raw) {
    const parsed = parseJson(raw, {}) || {};
    return `<div class="hours" id="hours">${DAYS.map(([d, name]) => {
      const slots = Array.isArray(parsed[d]) ? parsed[d] : [];
      return `<div class="hours-day" data-day="${d}">
        <label class="hours-on"><input type="checkbox" ${slots.length ? 'checked' : ''}/><span>${name}</span></label>
        <div class="hours-slots">${(slots.length ? slots : [['09:00', '18:00']]).map(s => slotHtml(s)).join('')}
          <button type="button" class="link-btn hours-add">+ tramo</button></div>
        <span class="hours-closed">Cerrado</span></div>`;
    }).join('')}</div>`;
  }
  const slotHtml = (s) => `<span class="hours-slot"><input type="time" value="${esc(s[0])}"/><span>a</span><input type="time" value="${esc(s[1])}"/><button type="button" class="hours-del" aria-label="Quitar tramo">✕</button></span>`;
  function collectHours() {
    const out = {};
    document.querySelectorAll('#hours .hours-day').forEach((row) => {
      if (!row.querySelector('.hours-on input').checked) return;
      const slots = [...row.querySelectorAll('.hours-slot')].map(s => [...s.querySelectorAll('input')].map(i => i.value)).filter(([a, b]) => a && b && a !== b);
      if (slots.length) out[row.dataset.day] = slots.slice(0, 3);
    });
    return Object.keys(out).length ? JSON.stringify(out) : null;
  }
  function syncHoursUi() {
    document.querySelectorAll('#hours .hours-day').forEach((row) => {
      const on = row.querySelector('.hours-on input').checked;
      row.classList.toggle('is-closed', !on);
      row.querySelector('.hours-add').hidden = row.querySelectorAll('.hours-slot').length >= 3;
    });
  }

  async function render() {
    const [b, meR, exR, docsR, imgsR, todayR] = await Promise.all([
      loadBiz(), api('/auth/me'), api('/api/excluded-contacts'), api('/api/business/documents'), api('/api/business/images'), api('/api/stats/today'),
    ]);
    if (!b) return;
    me = meR.ok ? await meR.json() : {};
    const excluded = exR.ok ? await exR.json() : [];
    const docs = docsR.ok ? ((await docsR.json()).docs || []) : [];
    const imgs = imgsR.ok ? await imgsR.json() : [];
    const today = todayR.ok ? await todayR.json() : {};
    const sa = parseJson(b.survey_answers, {}) || {};
    const style = parseJson(b.style_profile, {}) || {};
    const examples = (parseJson(b.sales_examples, []) || []).join('\n\n');
    const openSecs = new Set([...document.querySelectorAll('#more-list details[open]')].map(d => d.dataset.sec));

    $('more-list').innerHTML = [
      section('today', 'Actividad de hoy', 'Mensajes y clientes del día',
        `<div class="stats">
          <div class="stat"><span class="stat-n">${Number(today.messages24h) || 0}</span><span class="stat-l">mensajes (24 h)</span></div>
          <div class="stat"><span class="stat-n">${Number(today.uniqueClientsToday) || 0}</span><span class="stat-l">clientes hoy</span></div>
          <div class="stat"><span class="stat-n">${Number(today.pausedToday) || 0}</span><span class="stat-l">pasados a vos hoy</span></div>
        </div>`),
      section('biz', 'Tu negocio', 'Nombre, qué vendés, precios y web',
        field('s-name', 'Nombre del negocio', b.name, { max: 120 }) +
        field('s-context', '¿Qué hacés o vendés?', b.business_context, { area: true, rows: 4 }) +
        field('s-pricing', 'Precios', b.pricing_info, { area: true, rows: 4, placeholder: 'Ej: Torta 15 personas $1.450' }) +
        field('s-web', 'Tu web o Instagram', b.website_url, { type: 'url', placeholder: 'https://' }) +
        saveRow('save-biz')),
      section('hours', 'Horario', 'Cuándo atienden y qué hacer cuando están cerrados',
        hoursEditor(b.business_hours) +
        field('s-after', 'Qué hacer cuando estamos cerrados', b.after_hours_instructions, { area: true, rows: 2 }) +
        field('s-urgphone', 'Teléfono de urgencias fuera de horario', b.urgent_phone, { type: 'tel' }) +
        saveRow('save-hours')),
      section('style', 'Cómo responde', 'Largo, tono, velocidad y reglas',
        radios('s-largo', '¿Qué tan largos son los mensajes?', sa.largo_mensajes || '', [['corto', 'Corto'], ['medio', 'Medio'], ['largo', 'Largo']]) +
        radios('s-prio', 'Cuando alguien escribe, ¿qué hace primero?', sa.prioridad || '', [['cerrar_rapido', 'Cerrar rápido'], ['generar_confianza', 'Generar confianza'], ['equilibrado', 'Equilibrado']]) +
        field('s-caro', '¿Qué decís cuando te dicen que es caro?', sa.objeciones_precio, { area: true, rows: 2 }) +
        `<label class="set-field"><span class="set-label">¿Qué hace si alguien no te responde?</span><select class="field" id="s-sinresp">
          ${[['', 'Elegí una opción'], ['no_hacer_nada', 'No hacer nada, esperar'], ['recordatorio_24h', 'Un recordatorio a las 24 h'], ['dos_recordatorios', 'Dos recordatorios y cerrar'], ['seguir_insistiendo', 'Seguir insistiendo']].map(([v, l]) => `<option value="${v}" ${(sa.sin_respuesta || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>` +
        `<label class="set-field"><span class="set-label">¿Qué tan rápido responde?</span><select class="field" id="s-delay">
          ${[...new Set([0, 2, 5, 10, 15, 20, Number(b.response_delay ?? 5)])].sort((x, y) => x - y).map((v) => `<option value="${v}" ${Number(b.response_delay ?? 5) === v ? 'selected' : ''}>${v === 0 ? 'Al instante' : `Espera ${v} segundos`}</option>`).join('')}
        </select></label>` +
        field('s-examples', 'Mensajes tuyos reales (separá cada uno con una línea en blanco)', examples, { area: true, rows: 5 }) +
        field('s-rules', 'Reglas para tu asistente', b.owner_rules, { area: true, rows: 4, max: 6000, placeholder: 'Ej: Nunca prometas envíos en el día.' }) +
        (b.owner_rules_warning ? `<p class="set-warn">${esc(b.owner_rules_warning)}</p>` : '') +
        saveRow('save-style') +
        switchRow('s-split', 'Mandar en mensajes separados', !!style.mensajes_separados, 'Como una persona: varios mensajes cortos en vez de uno largo.') +
        `<span class="set-status" id="s-split-status" hidden></span>`),
      section('handoff', 'Pasar la conversación a vos', 'Palabras que te pasan el chat y qué se le dice al cliente',
        field('s-pausekw', 'Palabras que pausan al asistente', b.pause_keywords, { placeholder: 'Ej: humano, persona, reclamo', hint: 'Separadas por coma.' }) +
        field('s-pausemsg', 'Mensaje al cliente cuando se pausa', b.pause_reply_text, { area: true, rows: 2, max: 300 }) +
        field('s-pausehrs', 'Si respondés vos desde WhatsApp, el asistente vuelve después de (horas)', b.owner_pause_hours ?? '', { type: 'number', placeholder: '24' }) +
        saveRow('save-handoff')),
      section('alerts', 'Avisos para vos', 'Urgencias, tu número y resumen semanal',
        field('s-ownerphone', 'Tu número de WhatsApp (para recibir avisos)', me.phone, { type: 'tel', placeholder: '099 123 456' }) +
        switchRow('s-urgent', 'Avisarme si un cliente escribe algo urgente', !!b.urgent_alert_enabled) +
        field('s-urgkw', 'Palabras de urgencia', b.urgent_keywords, { placeholder: 'Ej: urgente, emergencia' }) +
        saveRow('save-alerts') +
        switchRow('s-weekly', 'Resumen semanal por WhatsApp', !!b.weekly_summary_enabled) +
        switchRow('s-booking', 'Recibir pedidos de turno por WhatsApp', !!b.booking_enabled, 'El asistente toma el pedido y vos lo confirmás.') +
        `<span class="set-status" id="s-toggles-status" hidden></span>`),
      section('excluded', 'Números que atendés siempre vos', `El asistente no les responde${excluded.length ? ` · ${excluded.length}` : ''}`,
        `<div class="ex-list">${excluded.length ? excluded.map(x => `<div class="ex-row"><span>${esc(x.phone)}</span><button type="button" class="link-btn link-danger" data-unexclude="${esc(x.phone)}">Quitar</button></div>`).join('') : '<p class="muted">Ninguno.</p>'}</div>` +
        field('s-exadd', 'Agregar números (uno por línea)', '', { area: true, rows: 2, placeholder: '099 123 456' }) +
        `<div class="set-actions"><span class="set-status" id="ex-status" hidden></span><button type="button" class="btn btn-accent btn-sm" id="ex-add">Agregar</button></div>`),
      section('files', 'Archivos para el asistente', 'Listas de precios, catálogos y fotos de productos',
        `<div class="set-label">Documentos (PDF, Word o texto)</div>
        <div class="ex-list">${docs.length ? docs.map(d => `<div class="ex-row"><span>${esc(d.name)}</span><button type="button" class="link-btn link-danger" data-deldoc="${Number(d.id)}">Quitar</button></div>`).join('') : '<p class="muted">Ninguno.</p>'}</div>
        <div class="up-row"><input class="field" id="doc-name" placeholder="Nombre (ej: Lista de precios)" maxlength="80"/><label class="chip-btn up-btn">Elegir archivo<input type="file" id="doc-file" accept=".pdf,.docx,.txt,.md,.csv" hidden/></label></div>
        <div class="set-label" style="margin-top:14px">Fotos de productos (JPG o PNG)</div>
        <div class="ex-list">${imgs.length ? imgs.map(i => `<div class="ex-row"><span>${esc(i.label)}</span><button type="button" class="link-btn link-danger" data-delimg="${Number(i.id)}">Quitar</button></div>`).join('') : '<p class="muted">Ninguna.</p>'}</div>
        <div class="up-row"><input class="field" id="img-label" placeholder="Qué es (ej: Torta de chocolate)" maxlength="80"/><label class="chip-btn up-btn">Elegir foto<input type="file" id="img-file" accept="image/jpeg,image/png" hidden/></label></div>
        <span class="set-status" id="files-status" hidden></span>`),
    ].join('');
    document.querySelectorAll('#more-list details').forEach(d => { if (openSecs.has(d.dataset.sec)) d.open = true; });
    wireSections();
    syncHoursUi();
    if (ctx.onLayout) ctx.onLayout();
  }

  function val(id) { const el = $(id); return el ? el.value.trim() : ''; }
  function radioVal(name) { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : ''; }

  function wireSections() {
    document.querySelectorAll('#more-list details').forEach(d => d.addEventListener('toggle', () => ctx.onLayout && ctx.onLayout()));
    $('save-biz').addEventListener('click', () => {
      if (!val('s-name')) return status($('save-biz-status'), 'Poné el nombre del negocio.', true);
      saveBiz({ name: val('s-name'), business_context: val('s-context') || null, pricing_info: val('s-pricing') || null, website_url: val('s-web') || null }, $('save-biz-status'));
    });
    // Hours
    const hours = $('hours');
    hours.addEventListener('change', (e) => { if (e.target.closest('.hours-on')) syncHoursUi(); });
    hours.addEventListener('click', (e) => {
      if (e.target.closest('.hours-add')) {
        const btn = e.target.closest('.hours-add');
        btn.insertAdjacentHTML('beforebegin', slotHtml(['16:00', '20:00']));
        syncHoursUi();
      }
      if (e.target.closest('.hours-del')) {
        const day = e.target.closest('.hours-day');
        if (day.querySelectorAll('.hours-slot').length > 1) e.target.closest('.hours-slot').remove();
        else day.querySelector('.hours-on input').checked = false;
        syncHoursUi();
      }
    });
    $('save-hours').addEventListener('click', () => saveBiz({
      business_hours: collectHours(), after_hours_instructions: val('s-after') || null, urgent_phone: val('s-urgphone') || null,
    }, $('save-hours-status')));
    // Style
    $('save-style').addEventListener('click', () => {
      const sa = parseJson(biz && biz.survey_answers, {}) || {};
      saveBiz({
        survey_answers: Object.assign({}, sa, { largo_mensajes: radioVal('s-largo'), prioridad: radioVal('s-prio'), objeciones_precio: val('s-caro'), sin_respuesta: val('s-sinresp') }),
        response_delay: Number(val('s-delay')),
        sales_examples: val('s-examples') ? val('s-examples').split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean) : [],
        owner_rules: val('s-rules') || null,
      }, $('save-style-status')).then(() => render());
    });
    $('s-split').addEventListener('change', (e) => toggle('/api/business/split-messages', e.target.checked, $('s-split-status')));
    // Handoff
    $('save-handoff').addEventListener('click', () => saveBiz({
      pause_keywords: val('s-pausekw') || null, pause_reply_text: val('s-pausemsg') || null, owner_pause_hours: val('s-pausehrs') || null,
    }, $('save-handoff-status')));
    // Alerts
    $('save-alerts').addEventListener('click', async () => {
      const st = $('save-alerts-status');
      const phone = val('s-ownerphone');
      const r = await api('/auth/me', { method: 'PUT', body: { phone: phone || null } });
      if (!r.ok) return status(st, 'No se pudo guardar tu número.', true);
      saveBiz({ urgent_alert_enabled: $('s-urgent').checked ? 1 : 0, urgent_keywords: val('s-urgkw') || null }, st);
    });
    $('s-weekly').addEventListener('change', (e) => toggle('/api/business/weekly-summary-enabled', e.target.checked, $('s-toggles-status')));
    $('s-booking').addEventListener('change', (e) => toggle('/api/business/booking-enabled', e.target.checked, $('s-toggles-status')));
    // Excluded numbers
    $('ex-add').addEventListener('click', async () => {
      const phones = $('s-exadd').value.trim();
      if (!phones) return;
      const r = await api('/api/excluded-contacts', { method: 'POST', body: { phones } });
      if (!r.ok) return status($('ex-status'), 'No se pudieron agregar.', true);
      await render(); openSection('excluded');
    });
    document.querySelectorAll('[data-unexclude]').forEach(b => b.addEventListener('click', async () => {
      const r = await api(`/api/excluded-contacts/${encodeURIComponent(b.dataset.unexclude)}`, { method: 'DELETE' });
      if (r.ok) { await render(); openSection('excluded'); }
    }));
    // Files
    $('doc-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('doc', f); fd.append('name', val('doc-name') || f.name.replace(/\.[^.]+$/, ''));
      status($('files-status'), 'Subiendo…');
      const r = await api('/api/business/documents', { method: 'POST', form: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return status($('files-status'), d.error || 'No se pudo subir.', true);
      await render(); openSection('files');
    });
    $('img-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const label = val('img-label');
      if (!label) { e.target.value = ''; return status($('files-status'), 'Escribí qué es la foto antes de elegirla.', true); }
      const fd = new FormData(); fd.append('image', f); fd.append('label', label);
      status($('files-status'), 'Subiendo…');
      const r = await api('/api/business/images', { method: 'POST', form: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return status($('files-status'), d.error || 'No se pudo subir.', true);
      await render(); openSection('files');
    });
    document.querySelectorAll('[data-deldoc]').forEach(b => b.addEventListener('click', async () => {
      const r = await api(`/api/business/documents/${b.dataset.deldoc}`, { method: 'DELETE' });
      if (r.ok) { await render(); openSection('files'); }
    }));
    document.querySelectorAll('[data-delimg]').forEach(b => b.addEventListener('click', async () => {
      const r = await api(`/api/business/images/${b.dataset.delimg}`, { method: 'DELETE' });
      if (r.ok) { await render(); openSection('files'); }
    }));
  }
  function openSection(key) {
    const d = document.querySelector(`#more-list details[data-sec="${key}"]`);
    if (d) d.open = true;
  }

  async function start(context) {
    ctx = context;
    show($('more-settings'), true);
    if (!loadedOnce) { loadedOnce = true; await render(); }
    else render();
  }

  window.EmbedSettings = { start };
})();
