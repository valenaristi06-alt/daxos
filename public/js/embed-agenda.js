// Agenda inside the embed: on/off, upcoming appointments (new / move / cancel), services
// and cancellation window. Same endpoints as the Daxos agenda screen, with the embed token.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.hidden = !on; };
  const TZ = 'America/Montevideo';
  const DAYS_AHEAD = 14;

  let ctx = null;
  let biz = null;
  let services = [];
  let appts = [];
  let pending = []; // notices the client did not get (owner has to send them)
  let formOpen = null; // null | 'new' | appointment id being moved

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function api(path, opts) {
    opts = opts || {};
    const headers = ctx.authHeaders(opts.body ? { 'Content-Type': 'application/json' } : {});
    return fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  }
  const mvdDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const mvdTime = (iso) => new Intl.DateTimeFormat('es-UY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  function dayTitle(dayStr) {
    const today = mvdDate(new Date());
    const tomorrow = mvdDate(new Date(Date.now() + 86400000));
    const label = new Intl.DateTimeFormat('es-UY', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(dayStr + 'T12:00:00Z'));
    if (dayStr === today) return 'Hoy · ' + label;
    if (dayStr === tomorrow) return 'Mañana · ' + label;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  function formatPhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('598') && d.length === 11) return `+598 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
    return raw || '';
  }
  function status(msg, err) {
    const el = $('ag-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-err', !!err);
    show(el, !!msg);
  }

  async function load() {
    const today = mvdDate(new Date());
    const to = mvdDate(new Date(Date.now() + DAYS_AHEAD * 86400000));
    const [b, s, a] = await Promise.all([
      api('/api/business'), api('/api/agenda/services'), api(`/api/agenda/appointments?from=${today}&to=${to}`),
    ]);
    biz = b.ok ? await b.json() : null;
    services = s.ok ? await s.json() : [];
    const all = a.ok ? await a.json() : [];
    appts = all.filter(x => x.status === 'confirmed' && new Date(x.ends_at) > new Date());
    pending = all.filter(x => x.wa_notify_status === 'failed' && x.client_notice_text);
  }

  function serviceOptions(selected) {
    return `<option value="">Sin servicio</option>` + services.map(s =>
      `<option value="${s.id}" ${Number(selected) === s.id ? 'selected' : ''}>${esc(s.name)} (${s.duration_min} min)</option>`).join('');
  }
  function apptForm(kind, a) {
    const minDate = mvdDate(new Date());
    return `<div class="ag-form" data-form="${kind}">
      ${kind === 'new' ? `
        <label class="set-field"><span class="set-label">Servicio</span><select class="field" id="ag-svc">${serviceOptions(services[0] ? services[0].id : '')}</select></label>
        <div class="ag-grid">
          <label class="set-field"><span class="set-label">Teléfono del cliente</span><input class="field" id="ag-phone" type="tel" placeholder="099 123 456"/></label>
          <label class="set-field"><span class="set-label">Nombre</span><input class="field" id="ag-name" maxlength="80"/></label>
        </div>` : `<p class="set-hint">Mover el turno de ${esc(a.client_name || formatPhone(a.customer_phone))}. Al cliente le avisa el asistente por WhatsApp.</p>`}
      <div class="ag-grid">
        <label class="set-field"><span class="set-label">Día</span><input class="field" id="ag-date" type="date" min="${minDate}" value="${minDate}"/></label>
        <label class="set-field"><span class="set-label">Horario</span><select class="field" id="ag-time"><option value="">Elegí el día</option></select></label>
      </div>
      ${kind === 'new' ? '<label class="set-field"><span class="set-label">Notas</span><input class="field" id="ag-notes" maxlength="300"/></label>' : ''}
      <div class="set-actions"><button type="button" class="chip-btn" data-ag="close-form">Cancelar</button>
        <button type="button" class="btn btn-accent btn-sm" data-ag="${kind === 'new' ? 'create' : 'move'}" data-id="${a ? a.id : ''}">${kind === 'new' ? 'Agendar' : 'Mover'}</button></div>
    </div>`;
  }
  async function loadSlots(serviceId) {
    const sel = $('ag-time');
    const date = $('ag-date').value;
    if (!sel || !date) return;
    sel.innerHTML = '<option value="">Cargando…</option>';
    const r = await api(`/api/agenda/slots?date=${date}${serviceId ? `&serviceId=${serviceId}` : ''}`);
    const d = r.ok ? await r.json() : { slots: [] };
    const free = (d.slots || []).filter(s => s.available);
    sel.innerHTML = free.length ? free.map(s => `<option value="${s.time}">${s.time}</option>`).join('') : '<option value="">No hay horarios libres ese día</option>';
  }

  function render() {
    const box = $('agenda-body');
    if (!biz) { box.innerHTML = '<p class="muted">No se pudo cargar la agenda.</p>'; return; }
    if (!biz.agenda_plan_ok) { box.innerHTML = '<p class="muted">La agenda no está disponible en tu plan.</p>'; return; }
    const on = !!biz.agenda_enabled;
    const byDay = new Map();
    for (const a of appts) {
      const day = mvdDate(new Date(a.starts_at));
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(a);
    }
    const apptRows = [...byDay.entries()].map(([day, list]) => `
      <div class="ag-day">${esc(dayTitle(day))}</div>
      ${list.map(a => `<div class="ag-appt">
        <span class="ag-time">${esc(mvdTime(a.starts_at))}</span>
        <span class="ag-who"><strong>${esc(a.client_name || formatPhone(a.customer_phone))}</strong>
          <span class="set-hint">${esc([a.service_name, a.client_name ? formatPhone(a.customer_phone) : '', a.notes].filter(Boolean).join(' · '))}</span>
          ${a.wa_notify_status === 'failed' && a.client_notice_text ? '<span class="ag-unnotified">Cliente sin avisar</span>' : ''}</span>
        <span class="ag-acts"><button type="button" class="link-btn" data-ag="open-move" data-id="${a.id}">Mover</button>
          <button type="button" class="link-btn link-danger" data-ag="ask-cancel" data-id="${a.id}">Cancelar</button></span>
      </div>
      ${formOpen === a.id ? apptForm('move', a) : ''}
      ${formOpen === 'cancel-' + a.id ? `<div class="ag-form"><p class="sheet-text">¿Cancelar este turno? Al cliente le avisa el asistente por WhatsApp.</p>
        <div class="set-actions"><button type="button" class="chip-btn" data-ag="close-form">No</button>
        <button type="button" class="chip-btn chip-danger" data-ag="cancel" data-id="${a.id}">Cancelar turno</button></div></div>` : ''}`).join('')}`).join('');

    const mins = Number(biz.agenda_cancel_min_before ?? 0);
    const pendingHtml = pending.length ? `<div class="ag-pending" role="alert">
      <span class="set-label">⚠ ${pending.length === 1 ? 'Un cliente no recibió el aviso' : `${pending.length} clientes no recibieron el aviso`}. Avisales vos:</span>
      ${pending.map(p => `<div class="ag-pending-item">
        <span class="ag-pending-who">${esc(p.client_name || formatPhone(p.customer_phone))}${p.client_name ? ' · ' + esc(formatPhone(p.customer_phone)) : ''}</span>
        <span class="set-hint">${esc(p.wa_notify_reason || '')}</span>
        <p class="ag-pending-text">${esc(p.client_notice_text).replace(/\n/g, '<br>')}</p>
        <span class="ag-acts"><button type="button" class="link-btn" data-ag="copy-notice" data-id="${p.id}">Copiar mensaje</button>
          <a class="link-btn" target="_blank" rel="noopener" href="https://wa.me/${String(p.customer_phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(p.client_notice_text)}">Abrir WhatsApp</a>
          <button type="button" class="link-btn" data-ag="notice-done" data-id="${p.id}">Ya le avisé</button></span>
      </div>`).join('')}</div>` : '';
    box.innerHTML = pendingHtml + `
      <div class="set-switch"><div><span class="set-label">Agenda activa</span>
        <span class="set-hint">El asistente ofrece los horarios libres y reserva solo. Los horarios salen de "Horario" en Más ajustes.</span></div>
        <label class="switch"><input type="checkbox" id="ag-enabled" ${on ? 'checked' : ''}/><span class="slider"></span></label></div>
      <span class="set-status" id="ag-status" hidden></span>
      ${on ? `
        <div class="ag-head"><span class="set-label">Próximos turnos</span>
          ${formOpen === 'new' ? '' : '<button type="button" class="chip-btn" data-ag="open-new">+ Nuevo turno</button>'}</div>
        ${formOpen === 'new' ? apptForm('new') : ''}
        <div class="ag-list">${apptRows || '<p class="muted">No hay turnos en los próximos 14 días.</p>'}</div>` : ''}
      <details class="set-sec" data-sec="ag-services"><summary><span class="set-title">Servicios</span>
        <span class="set-sub">${services.length ? services.map(s => esc(s.name)).join(', ') : 'Creá al menos uno para activar la agenda'}</span></summary>
        <div class="set-body">
          <div class="ex-list">${services.map(s => `<div class="ex-row"><span>${esc(s.name)} · ${s.duration_min} min</span>
            <button type="button" class="link-btn link-danger" data-ag="del-svc" data-id="${s.id}">Quitar</button></div>`).join('') || '<p class="muted">Ninguno.</p>'}</div>
          <div class="up-row"><input class="field" id="ag-svc-name" placeholder="Ej: Corte de pelo" maxlength="80"/>
            <select class="field ag-dur" id="ag-svc-dur">${[15, 20, 30, 45, 60, 90, 120].map(m => `<option value="${m}" ${m === 30 ? 'selected' : ''}>${m} min</option>`).join('')}</select>
            <button type="button" class="btn btn-accent btn-sm" data-ag="add-svc">Agregar</button></div>
        </div></details>
      <details class="set-sec" data-sec="ag-cancel"><summary><span class="set-title">Cancelaciones</span>
        <span class="set-sub">${mins ? `El cliente puede cancelar hasta ${mins >= 60 ? (mins / 60) + ' h' : mins + ' min'} antes` : 'El cliente puede cancelar cuando quiera'}</span></summary>
        <div class="set-body"><label class="set-field"><span class="set-label">El cliente puede cancelar por WhatsApp hasta</span>
          <select class="field" id="ag-cancel-min">${[[0, 'Cualquier momento'], [60, '1 h antes'], [120, '2 h antes'], [240, '4 h antes'], [720, '12 h antes'], [1440, '24 h antes'], [2880, '48 h antes']]
            .concat([[mins, `${mins} min antes`]]).filter((x, i, arr) => arr.findIndex(y => y[0] === x[0]) === i)
            .map(([v, l]) => `<option value="${v}" ${v === mins ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div></details>`;
    if (formOpen === 'new' || typeof formOpen === 'number') loadSlots(formOpen === 'new' ? ($('ag-svc') || {}).value : (appts.find(a => a.id === formOpen) || {}).service_id);
    if (ctx.onLayout) ctx.onLayout();
  }

  async function refresh(keepSec) {
    const open = keepSec || [...document.querySelectorAll('#agenda-body details[open]')].map(d => d.dataset.sec);
    await load(); render();
    open.forEach(k => { const d = document.querySelector(`#agenda-body details[data-sec="${k}"]`); if (d) d.open = true; });
  }

  async function onClick(e) {
    const b = e.target.closest('[data-ag]'); if (!b) return;
    const act = b.dataset.ag, id = Number(b.dataset.id);
    if (act === 'copy-notice') {
      const p = pending.find(x => x.id === id);
      try { await navigator.clipboard.writeText(p.client_notice_text); status('Mensaje copiado ✓'); } catch (_) { status('No se pudo copiar: seleccioná el texto y copialo.', true); }
      return;
    }
    if (act === 'notice-done') {
      const r = await api(`/api/agenda/appointments/${id}/notice-done`, { method: 'PATCH' });
      if (!r.ok) return status('No se pudo marcar.', true);
      await refresh(); return;
    }
    if (act === 'open-new') { formOpen = 'new'; return render(); }
    if (act === 'open-move') { formOpen = id; return render(); }
    if (act === 'ask-cancel') { formOpen = 'cancel-' + id; return render(); }
    if (act === 'close-form') { formOpen = null; return render(); }
    if (act === 'create' || act === 'move') {
      const date = $('ag-date').value, time = $('ag-time').value;
      if (!date || !time) return status('Elegí día y horario.', true);
      b.disabled = true;
      const r = act === 'create'
        ? await api('/api/agenda/appointments', { method: 'POST', body: {
            serviceId: $('ag-svc').value ? Number($('ag-svc').value) : null, customerPhone: $('ag-phone').value.trim(),
            clientName: $('ag-name').value.trim() || null, date, time, notes: $('ag-notes').value.trim() || null } })
        : await api(`/api/agenda/appointments/${id}/reschedule`, { method: 'PATCH', body: { date, time } });
      const d = await r.json().catch(() => ({}));
      b.disabled = false;
      if (!r.ok) return status(d.error || 'No se pudo guardar el turno.', true);
      formOpen = null; await refresh();
      const okMsg = act === 'create' ? 'Turno agendado' : 'Turno movido';
      if (d.client_notice && !d.client_notice.sent) status(`${okMsg}, pero el cliente no recibió el aviso: mandáselo vos (arriba).`, true);
      else status(okMsg + ' ✓ Le avisamos al cliente por WhatsApp.');
      return;
    }
    if (act === 'cancel') {
      const r = await api(`/api/agenda/appointments/${id}/cancel`, { method: 'PATCH', body: {} });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return status(d.error || 'No se pudo cancelar.', true);
      formOpen = null; await refresh();
      if (d.client_notice && !d.client_notice.sent) status('Turno cancelado, pero el cliente no recibió el aviso: mandáselo vos (arriba).', true);
      else status('Turno cancelado ✓ Le avisamos al cliente por WhatsApp.');
      return;
    }
    if (act === 'add-svc') {
      const name = $('ag-svc-name').value.trim();
      if (!name) return;
      const r = await api('/api/agenda/services', { method: 'POST', body: { name, duration_min: Number($('ag-svc-dur').value) } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return status(d.error || 'No se pudo agregar.', true);
      return refresh(['ag-services']);
    }
    if (act === 'del-svc') {
      const r = await api(`/api/agenda/services/${id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return status(d.error || 'No se pudo quitar.', true);
      return refresh(['ag-services']);
    }
  }

  async function onChange(e) {
    if (e.target.id === 'ag-enabled') {
      const enabled = e.target.checked;
      const r = await api('/api/business/agenda-enabled', { method: 'PATCH', body: { enabled } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        e.target.checked = !enabled;
        const msg = d.code === 'NO_SERVICES' ? 'Creá al menos un servicio (abajo) antes de activar la agenda.'
          : d.code === 'NO_BUSINESS_HOURS' ? 'Cargá tu horario en Más ajustes → Horario antes de activar la agenda.' : (d.error || 'No se pudo cambiar.');
        return status(msg, true);
      }
      await refresh(); status(enabled ? 'Agenda activada ✓' : 'Agenda apagada');
    }
    if (e.target.id === 'ag-date' || e.target.id === 'ag-svc') {
      const svc = $('ag-svc') ? $('ag-svc').value : (appts.find(a => a.id === formOpen) || {}).service_id;
      loadSlots(svc);
    }
    if (e.target.id === 'ag-cancel-min') {
      const r = await api('/api/business/agenda-cancel-min', { method: 'PATCH', body: { minutes: Number(e.target.value) } });
      if (!r.ok) return status('No se pudo guardar.', true);
      await refresh(['ag-cancel']); status('Guardado ✓');
    }
  }

  let wired = false;
  async function start(context) {
    ctx = context;
    show($('agenda-card'), true);
    if (!wired) {
      wired = true;
      $('agenda-body').addEventListener('click', onClick);
      $('agenda-body').addEventListener('change', onChange);
    }
    formOpen = null;
    await refresh([]);
  }

  window.EmbedAgenda = { start };
})();
