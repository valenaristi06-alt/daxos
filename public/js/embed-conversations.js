// Conversations inside the embed (partner CRM iframe). Same data and actions as the
// Daxos conversations screen (/api/conversations…, /api/tags…), authenticated with the
// embed token (X-Embed-Token) instead of cookies. Refreshes itself by polling.
// Design rule: simple on screen, complete inside — daily actions visible, the rest in "⋯".
(function () {
  'use strict';

  const POLL_MS = 4000;
  const WINDOW_24H_MS = 23.5 * 3600 * 1000;
  const TAG_COLORS = ['#3b82f6', '#eab308', '#22c55e', '#6b7280', '#f97316', '#ef4444', '#a855f7', '#06b6d4'];
  const LABELS = [['', 'Sin tipo'], ['cliente', 'Cliente'], ['prospecto', 'Prospecto'], ['no_interesado', 'No interesado']];

  let ctx = null;            // { authHeaders, onLayout }
  let running = false;
  let pollTimer = null;
  let convs = [];
  let tags = [];
  let listSig = '';
  let openId = null;
  let openSig = '';
  let openConv = null;       // conversation row from /messages (+ is_excluded)
  let openMsgs = [];
  let openMsgsSig = '';
  let ownerPhone = null;
  let canReply = false;
  let filter = { kind: 'all', tagId: null };
  let search = '';
  const blobUrls = new Map(); // media url → Promise<object URL>

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.hidden = !on; };

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const safeColor = (c) => (TAG_COLORS.includes(c) ? c : '#6b7280');

  function api(path, opts) {
    opts = opts || {};
    const headers = ctx.authHeaders(opts.body ? { 'Content-Type': 'application/json' } : {});
    return fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  }

  let toastT = null;
  function toast(msg) {
    const t = $('convs-toast');
    t.textContent = msg; show(t, true);
    clearTimeout(toastT); toastT = setTimeout(() => show(t, false), 3200);
  }

  // ── Formatting (same rules as the Daxos conversations screen) ──
  function formatPhone(raw) {
    if (!raw) return 'Desconocido';
    const d = String(raw).replace(/\D/g, '');
    if (d.startsWith('598') && d.length === 11) return `+598 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
    if (d.length === 9 && d.startsWith('0')) return `+598 ${d.slice(1, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
    if (/^\d{8,15}$/.test(d)) return '+' + d;
    return String(raw);
  }
  const displayName = (c) => (c.contact_name && c.contact_name.trim()) || formatPhone(c.customer_id);
  function toUtcDate(dt) {
    if (!dt) return null;
    const s = String(dt);
    return new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
  }
  const uyDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(d);
  function formatListDate(dt) {
    const d = toUtcDate(dt);
    if (!d || isNaN(d)) return '';
    const diff = Math.round((new Date(uyDay(new Date())) - new Date(uyDay(d))) / 86400000);
    if (diff === 0) return new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    if (diff === 1) return 'Ayer';
    return new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo', day: 'numeric', month: 'short' }).format(d);
  }
  function formatTime(dt) {
    const d = toUtcDate(dt);
    if (!d || isNaN(d)) return '';
    return new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }
  function dayLabel(dayStr) {
    if (dayStr === uyDay(new Date())) return 'Hoy';
    if (dayStr === uyDay(new Date(Date.now() - 86400000))) return 'Ayer';
    return new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo', day: 'numeric', month: 'long' }).format(new Date(dayStr + 'T12:00:00Z'));
  }
  function friendlyPreview(text) {
    const t = String(text || '');
    const m = t.match(/^\[(imagen|audio|documento|video|sticker|ubicación|contacto)(?::[^\]]*)?\]\s*(.*)$/s);
    if (!m) return t;
    const label = { imagen: '📷 Foto', audio: '🎤 Audio', documento: '📄 Documento', video: '🎬 Video', sticker: 'Sticker', 'ubicación': '📍 Ubicación', contacto: '👤 Contacto' }[m[1]];
    return m[2] ? `${label} · ${m[2]}` : label;
  }

  // ── Conversation state ──
  function ownerHandling(c) {
    return !!c.needs_attention && (c.paused_reason === 'owner_reply' || c.paused_reason === 'owner' || (!c.paused_reason && !!c.human_paused_at));
  }
  const waiting = (c) => !!c.needs_human || (!!c.needs_attention && !ownerHandling(c));
  const mine = (c) => ownerHandling(c) || !!c.is_excluded;
  function sortConvs(list) {
    return list.slice().sort((a, b) => {
      const wa = waiting(a) ? 1 : 0, wb = waiting(b) ? 1 : 0;
      if (wa !== wb) return wb - wa;
      return (toUtcDate(b.last_msg_at || b.created_at) || 0) - (toUtcDate(a.last_msg_at || a.created_at) || 0);
    });
  }
  const convSig = (c) => [c.id, c.last_msg_at, c.last_message, c.needs_attention, c.needs_human, c.paused_reason, c.human_paused_at, c.is_excluded, c.label, c.contact_name, (c.tags || []).map(t => t.id).join(',')].join('|');

  // ── List ──
  function visibleConvs() {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return convs.filter((c) => {
      if (filter.kind === 'waiting' && !waiting(c)) return false;
      if (filter.kind === 'mine' && !mine(c)) return false;
      if (filter.tagId != null && !(c.tags || []).some(t => t.id === filter.tagId)) return false;
      if (!q) return true;
      return (c.contact_name || '').toLowerCase().includes(q)
        || (qDigits.length >= 3 && String(c.customer_id || '').includes(qDigits))
        || (c.last_message || '').toLowerCase().includes(q);
    });
  }

  function renderList() {
    const el = $('conv-list');
    const filtering = filter.kind !== 'all' || filter.tagId != null;
    const fb = $('btn-filter');
    const tag = tags.find(t => t.id === filter.tagId);
    fb.textContent = filter.kind === 'waiting' ? 'Te esperan' : filter.kind === 'mine' ? 'Atendés vos' : tag ? tag.name : 'Filtrar';
    fb.classList.toggle('is-active', filtering);
    if (!convs.length) {
      el.innerHTML = '<div class="conv-empty"><p class="conv-empty-title">Todavía no hay conversaciones.</p><p class="conv-empty-sub">Cuando tus clientes te escriban por WhatsApp, aparecen acá.</p></div>';
      return;
    }
    const list = visibleConvs();
    if (!list.length) {
      el.innerHTML = '<div class="conv-empty"><p class="conv-empty-title">Ningún chat coincide.</p>' +
        (filtering || search ? '<button type="button" class="link-btn" data-clear-filters>Ver todos</button>' : '') + '</div>';
      return;
    }
    el.innerHTML = list.map((c) => {
      const w = waiting(c);
      const dots = (c.tags || []).slice(0, 5).map(t => `<span class="tag-dot" style="background:${safeColor(t.color)}" title="${esc(t.name)}"></span>`).join('');
      return `<button type="button" class="conv-item${c.id === openId ? ' is-open' : ''}${w ? ' is-waiting' : ''}" data-id="${c.id}">
        <span class="conv-line1">
          <span class="conv-name">${w ? '<span class="conv-dot" aria-label="Te espera"></span>' : ''}${esc(displayName(c))}</span>
          <span class="conv-time">${esc(formatListDate(c.last_msg_at || c.created_at))}</span>
        </span>
        <span class="conv-line2">
          <span class="conv-preview">${esc(friendlyPreview(c.last_message || '').slice(0, 90))}</span>
          ${dots ? `<span class="tag-dots">${dots}</span>` : ''}
        </span>
      </button>`;
    }).join('');
  }

  async function loadList() {
    const r = await api('/api/conversations');
    if (!r.ok) return false;
    const data = await r.json().catch(() => []);
    convs = sortConvs(Array.isArray(data) ? data : []);
    const sig = convs.map(convSig).join(';');
    if (sig !== listSig) { listSig = sig; renderList(); }
    return true;
  }
  async function loadTags() {
    const r = await api('/api/tags');
    if (r.ok) tags = await r.json().catch(() => []);
  }

  // ── Filter popover ──
  function renderFilterPop() {
    const opt = (kind, tagId, label, dot) => {
      const on = filter.kind === kind && filter.tagId === tagId;
      return `<button type="button" class="pop-item${on ? ' is-on' : ''}" role="menuitemradio" aria-checked="${on}" data-kind="${kind}" data-tag="${tagId == null ? '' : tagId}">
        ${dot ? `<span class="tag-dot" style="background:${safeColor(dot)}"></span>` : ''}<span>${esc(label)}</span>${on ? '<span class="pop-check">✓</span>' : ''}</button>`;
    };
    $('filter-pop').innerHTML =
      opt('all', null, 'Todos los chats') + opt('waiting', null, 'Te esperan') + opt('mine', null, 'Atendés vos') +
      (tags.length ? '<div class="pop-sep">Etiquetas</div>' + tags.map(t => opt('all', t.id, t.name, t.color)).join('') : '');
  }

  // ── Popovers (filter, ⋯) ──
  function closePops() {
    ['filter-pop', 'more-pop'].forEach(id => show($(id), false));
    $('btn-filter').setAttribute('aria-expanded', 'false');
    $('btn-more').setAttribute('aria-expanded', 'false');
  }
  function togglePop(popId, btnId, render) {
    const open = $(popId).hidden;
    closePops();
    if (!open) return;
    render();
    show($(popId), true);
    $(btnId).setAttribute('aria-expanded', 'true');
  }

  // ── Sheet (dialog for tags, files, confirmations) ──
  function openSheet(title, html, onReady) {
    closePops();
    $('sheet-title').textContent = title;
    $('sheet-body').innerHTML = html;
    show($('sheet'), true);
    if (onReady) onReady($('sheet-body'));
  }
  const closeSheet = () => show($('sheet'), false);

  // ── Media (fetched with the embed token → object URL) ──
  function mediaUrl(url) {
    if (blobUrls.has(url)) return blobUrls.get(url);
    const p = fetch(url, { headers: ctx.authHeaders() }).then(async (r) => {
      if (!r.ok) throw new Error('media ' + r.status);
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => blobUrls.delete(url));
    blobUrls.set(url, p);
    return p;
  }
  function hydrateMedia(root) {
    root.querySelectorAll('[data-media]').forEach(async (node) => {
      const url = node.getAttribute('data-media');
      node.removeAttribute('data-media');
      try {
        const obj = await mediaUrl(url);
        if (node.tagName === 'IMG' || node.tagName === 'AUDIO') {
          node.src = obj;
          if (node.tagName === 'IMG') node.addEventListener('load', keepBottomIfNeeded, { once: true });
        } else if (node.tagName === 'A') node.href = obj;
      } catch (_) {
        const box = node.closest('.media');
        if (box) box.classList.add('media--error');
      }
    });
  }
  async function downloadMedia(url, name) {
    try {
      const obj = await mediaUrl(url);
      const a = document.createElement('a');
      a.href = obj; a.download = name || 'archivo';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (_) { toast('No se pudo descargar el archivo.'); }
  }

  function mediaHtml(m) {
    const md = m.media;
    if (!md) return '';
    if (md.kind === 'image') return `<div class="media media-img"><img alt="Foto del cliente" data-media="${esc(md.url)}" /></div>`;
    if (md.kind === 'audio') return `<div class="media media-audio"><audio controls preload="metadata" data-media="${esc(md.url)}"></audio></div>`;
    return `<div class="media media-doc"><a class="media-doc-link" data-media="${esc(md.url)}" download="${esc(md.name || 'documento')}">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.5v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      <span class="media-doc-name">${esc(md.name || 'Documento')}</span><span class="media-doc-dl">Descargar</span></a></div>`;
  }
  function messageText(m) {
    let t = String(m.content || '');
    if (m.media) {
      t = t.replace(/^\[(imagen|audio|documento)(?::[^\]]*)?\]\s*/, '');
      if (m.media.kind === 'audio' && t && !/^\[audio\]$/.test(m.content)) t = 'Transcripción: ' + t;
    }
    return t;
  }

  function renderMessages(messages) {
    const box = $('thread-msgs');
    if (!messages.length) { box.innerHTML = '<p class="thread-none">Sin mensajes todavía.</p>'; return; }
    let lastDay = null;
    const parts = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      const d = toUtcDate(m.created_at);
      const day = d && !isNaN(d) ? uyDay(d) : null;
      if (day && day !== lastDay) { lastDay = day; parts.push(`<div class="day-sep"><span>${esc(dayLabel(day))}</span></div>`); }
      const text = messageText(m);
      parts.push(`<div class="msg ${m.role !== 'user' ? 'msg--out' : 'msg--in'}"><div class="bubble">
        ${mediaHtml(m)}${text ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : ''}
        <span class="bubble-time">${esc(formatTime(m.created_at))}</span></div></div>`);
    }
    box.innerHTML = parts.join('');
    hydrateMedia(box);
  }

  let stickBottom = true;
  function keepBottomIfNeeded() {
    if (!stickBottom) return;
    const box = $('thread-msgs');
    box.scrollTop = box.scrollHeight;
  }

  // One main button whose action depends on the state; the rest lives in "⋯".
  function renderThreadState() {
    const c = openConv;
    if (!c) return;
    $('thread-name').textContent = displayName(c);
    const sub = [];
    if (c.contact_name) sub.push(formatPhone(c.customer_id));
    sub.push(c.is_excluded ? 'El asistente no le responde' : ownerHandling(c) ? 'Atendés vos' : waiting(c) ? 'Te espera' : 'Responde el asistente');
    $('thread-sub').textContent = sub.join(' · ');

    const btn = $('btn-main-action');
    if (c.is_excluded) { show(btn, false); }
    else if (c.needs_attention) { btn.textContent = 'Reactivar asistente'; btn.dataset.action = 'resume'; btn.classList.remove('is-take'); show(btn, true); }
    else { btn.textContent = 'Atiendo yo'; btn.dataset.action = 'take'; btn.classList.add('is-take'); show(btn, true); }

    let text = '';
    if (c.is_excluded) text = 'El asistente nunca le responde a este número. Lo cambiás desde "⋯".';
    else if (ownerHandling(c)) text = 'Atendés vos este chat: el asistente no responde acá.';
    else if (c.needs_attention) text = 'Este cliente te espera: el asistente no responde en este chat.';
    else if (c.needs_human) text = 'El asistente avisó que este cliente necesita una persona. Sigue respondiendo mientras tanto.';
    $('thread-banner-text').textContent = text;
    $('thread-banner').classList.toggle('thread-banner--wait', waiting(c));
    show($('thread-banner'), !!text);
  }

  function renderReplyBox(lastUserAt) {
    const lastMs = lastUserAt ? toUtcDate(lastUserAt).valueOf() : null;
    canReply = !!lastMs && (Date.now() - lastMs <= WINDOW_24H_MS);
    const ta = $('reply-text');
    ta.disabled = !canReply;
    $('reply-send').disabled = !canReply;
    ta.placeholder = canReply ? 'Escribí tu respuesta…'
      : 'No podés responder desde acá: el cliente no escribió en las últimas 24 horas. Escribile desde tu WhatsApp.';
  }

  async function loadThread(id, { initial } = {}) {
    const r = await api(`/api/conversations/${id}/messages`);
    if (id !== openId) return;
    if (!r.ok) {
      $('thread-msgs').innerHTML = `<p class="thread-none">${r.status === 404 ? 'No encontramos esa conversación.' : 'No se pudieron cargar los mensajes.'}</p>`;
      return;
    }
    const data = await r.json();
    if (id !== openId) return;
    const listRow = convs.find((c) => c.id === id);
    openConv = { ...data.conversation, is_excluded: !!data.is_excluded };
    ownerPhone = data.owner_phone || null;
    if (listRow) listRow.is_excluded = !!data.is_excluded;
    renderThreadState();
    renderReplyBox(data.last_user_message_at);
    openMsgs = data.messages || [];
    const sig = openMsgs.length + ':' + (openMsgs.length ? openMsgs[openMsgs.length - 1].id : 0);
    if (initial || sig !== openMsgsSig) {
      const box = $('thread-msgs');
      stickBottom = initial || (box.scrollHeight - box.scrollTop - box.clientHeight < 80);
      openMsgsSig = sig;
      renderMessages(openMsgs);
      keepBottomIfNeeded();
    }
  }

  function openThread(id) {
    openId = id;
    openMsgsSig = '';
    openConv = null;
    openMsgs = [];
    const c = convs.find((x) => x.id === id);
    openSig = c ? convSig(c) : '';
    closePops(); closeSheet();
    renderList();
    show($('thread-empty'), false);
    show($('thread'), true);
    show($('reply-err'), false);
    show($('thread-banner'), false);
    show($('btn-main-action'), false);
    $('reply-text').value = '';
    $('thread-name').textContent = c ? displayName(c) : '';
    $('thread-sub').textContent = '';
    $('thread-msgs').innerHTML = '<p class="thread-none">Cargando mensajes…</p>';
    $('convs-box').classList.add('thread-open');
    loadThread(id, { initial: true });
    if (ctx.onLayout) ctx.onLayout();
  }

  function closeThread() {
    openId = null; openConv = null; openMsgs = [];
    closePops(); closeSheet();
    show($('thread'), false);
    show($('thread-empty'), true);
    $('convs-box').classList.remove('thread-open');
    renderList();
  }

  async function refreshOpen() {
    const id = openId;
    await loadList();
    if (id && id === openId) await loadThread(id);
  }

  // ── Actions ──
  async function setPaused(paused) {
    if (!openId) return;
    const r = await api(`/api/conversations/${openId}/${paused ? 'pause' : 'resume'}`, { method: 'PATCH' });
    if (!r.ok) return toast('No se pudo cambiar. Probá de nuevo.');
    await refreshOpen();
  }

  async function send() {
    if (!openId || !canReply) return;
    const ta = $('reply-text');
    const text = ta.value.trim();
    if (!text) return;
    const btn = $('reply-send'), err = $('reply-err');
    show(err, false);
    btn.disabled = true; btn.textContent = 'Enviando…';
    const id = openId;
    try {
      const r = await api(`/api/conversations/${id}/send`, { method: 'POST', body: { text } });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        err.textContent = d.error_code === 'window_expired'
          ? 'No se puede enviar: el cliente no escribió en las últimas 24 horas. Esperá a que escriba primero.'
          : (d.error || 'No se pudo enviar el mensaje. Probá de nuevo.');
        show(err, true);
        return;
      }
      if (id === openId) { ta.value = ''; ta.style.height = ''; }
      stickBottom = true;
      await refreshOpen();
      keepBottomIfNeeded();
    } finally {
      btn.textContent = 'Enviar';
      btn.disabled = !canReply;
    }
  }

  // ── "⋯" menu: every other function of the Daxos conversations screen ──
  function ownerPhoneMatches(customerId) {
    if (!ownerPhone || !customerId) return false;
    const digits = s => String(s).replace(/\D/g, '');
    const strip = s => (s.startsWith('598') ? s.slice(3) : s);
    const a = digits(ownerPhone), b = digits(customerId);
    return a === b || strip(a) === strip(b);
  }
  function renderMorePop() {
    const c = openConv || {};
    const files = openMsgs.filter(m => m.media).length;
    const item = (act, label, extra = '') => `<button type="button" class="pop-item${extra}" role="menuitem" data-act="${act}">${label}</button>`;
    $('more-pop').innerHTML =
      item('tags', 'Etiquetas') +
      item('label', 'Tipo de contacto') +
      item('files', `Descargar archivos${files ? ` (${files})` : ''}`) +
      item('copy', 'Copiar número') +
      item('exclude', c.is_excluded ? 'Que el asistente vuelva a responderle' : 'Que el asistente nunca le responda') +
      (ownerPhoneMatches(c.customer_id) ? item('reset', 'Reiniciar chat de prueba') : '') +
      '<div class="pop-sep"></div>' +
      item('delete', 'Borrar chat', ' pop-danger');
  }

  function sheetTags() {
    const c = openConv; if (!c) return;
    const row = convs.find(x => x.id === c.id);
    const current = new Set(((row && row.tags) || []).map(t => t.id));
    const list = tags.map(t => `<label class="check-row">
        <input type="checkbox" value="${t.id}" ${current.has(t.id) ? 'checked' : ''}/>
        <span class="tag-dot" style="background:${safeColor(t.color)}"></span><span class="check-name">${esc(t.name)}</span>
        ${t.is_default ? '' : `<button type="button" class="link-btn link-danger" data-del-tag="${t.id}">Eliminar</button>`}
      </label>`).join('') || '<p class="muted">Todavía no tenés etiquetas.</p>';
    const colors = TAG_COLORS.map((col, i) => `<button type="button" class="color-dot${i === 0 ? ' is-on' : ''}" data-color="${col}" style="background:${col}" aria-label="Color ${i + 1}"></button>`).join('');
    openSheet('Etiquetas', `<div class="check-list" id="tag-checks">${list}</div>
      <div class="sheet-sub">Nueva etiqueta</div>
      <div class="new-tag"><input type="text" class="field" id="new-tag-name" maxlength="30" placeholder="Nombre" />
        <div class="color-row" id="new-tag-colors">${colors}</div></div>
      <div class="sheet-actions"><button type="button" class="btn btn-accent" id="tags-save">Guardar</button></div>`, (body) => {
      let color = TAG_COLORS[0];
      body.querySelector('#new-tag-colors').addEventListener('click', (e) => {
        const b = e.target.closest('[data-color]'); if (!b) return;
        color = b.dataset.color;
        body.querySelectorAll('.color-dot').forEach(x => x.classList.toggle('is-on', x === b));
      });
      body.querySelectorAll('[data-del-tag]').forEach(b => b.addEventListener('click', async (e) => {
        e.preventDefault();
        const r = await api(`/api/tags/${b.dataset.delTag}`, { method: 'DELETE' });
        if (!r.ok) return toast('No se pudo eliminar la etiqueta.');
        await loadTags(); await loadList(); sheetTags();
      }));
      body.querySelector('#tags-save').addEventListener('click', async () => {
        const ids = [...body.querySelectorAll('#tag-checks input:checked')].map(i => Number(i.value));
        const name = body.querySelector('#new-tag-name').value.trim();
        if (name) {
          const r = await api('/api/tags', { method: 'POST', body: { name, color } });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return toast(d.error || 'No se pudo crear la etiqueta.');
          ids.push(d.id);
          await loadTags();
        }
        const r2 = await api(`/api/conversations/${c.id}/tags`, { method: 'PUT', body: { tagIds: ids } });
        if (!r2.ok) return toast('No se pudieron guardar las etiquetas.');
        closeSheet(); await refreshOpen(); toast('Etiquetas guardadas.');
      });
    });
  }

  function sheetLabel() {
    const c = openConv; if (!c) return;
    openSheet('Tipo de contacto', `<div class="check-list">${LABELS.map(([v, l]) =>
      `<label class="check-row"><input type="radio" name="conv-label" value="${v}" ${(c.label || '') === v ? 'checked' : ''}/><span class="check-name">${l}</span></label>`).join('')}</div>
      <div class="sheet-actions"><button type="button" class="btn btn-accent" id="label-save">Guardar</button></div>`, (body) => {
      body.querySelector('#label-save').addEventListener('click', async () => {
        const v = (body.querySelector('input[name="conv-label"]:checked') || {}).value || '';
        const r = await api(`/api/conversations/${c.id}/label`, { method: 'PATCH', body: { label: v || null } });
        if (!r.ok) return toast('No se pudo guardar.');
        closeSheet(); await refreshOpen();
      });
    });
  }

  function sheetFiles() {
    const files = openMsgs.filter(m => m.media);
    const kindLabel = { image: 'Foto', audio: 'Audio', document: 'Documento' };
    const html = files.length
      ? `<div class="file-list">${files.map((m, i) => `<button type="button" class="file-row" data-i="${i}">
          <span class="file-kind">${kindLabel[m.media.kind] || 'Archivo'}</span>
          <span class="file-name">${esc(m.media.name || (kindLabel[m.media.kind] || 'Archivo'))}</span>
          <span class="file-date">${esc(formatListDate(m.created_at))} ${esc(formatTime(m.created_at))}</span>
          <span class="file-dl">Descargar</span></button>`).join('')}</div>`
      : '<p class="muted">Este chat no tiene fotos, audios ni documentos.</p>';
    openSheet('Archivos del chat', html, (body) => {
      body.querySelectorAll('.file-row').forEach(b => b.addEventListener('click', () => {
        const m = files[Number(b.dataset.i)];
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'application/pdf': 'pdf' }[m.media.mime] || 'bin';
        downloadMedia(m.media.url, m.media.name || `${m.media.kind}-${m.id}.${ext}`);
      }));
    });
  }

  function sheetConfirm(title, text, okLabel, onOk, { typeWord } = {}) {
    openSheet(title, `<p class="sheet-text">${esc(text)}</p>
      ${typeWord ? `<input type="text" class="field" id="confirm-word" autocomplete="off" placeholder="Escribí ${esc(typeWord)}" />` : ''}
      <div class="sheet-actions"><button type="button" class="chip-btn" id="confirm-cancel">Cancelar</button>
      <button type="button" class="chip-btn chip-danger" id="confirm-ok" ${typeWord ? 'disabled' : ''}>${esc(okLabel)}</button></div>`, (body) => {
      const okBtn = body.querySelector('#confirm-ok');
      if (typeWord) body.querySelector('#confirm-word').addEventListener('input', (e) => { okBtn.disabled = e.target.value.trim() !== typeWord; });
      body.querySelector('#confirm-cancel').addEventListener('click', closeSheet);
      okBtn.addEventListener('click', async () => { okBtn.disabled = true; await onOk(); });
    });
  }

  async function doMenu(act) {
    closePops();
    const c = openConv; if (!c) return;
    if (act === 'tags') return sheetTags();
    if (act === 'label') return sheetLabel();
    if (act === 'files') return sheetFiles();
    if (act === 'copy') {
      const num = '+' + String(c.customer_id).replace(/\D/g, '');
      try { await navigator.clipboard.writeText(num); toast('Número copiado: ' + num); }
      catch (_) { toast(num); }
      return;
    }
    if (act === 'exclude') {
      if (c.is_excluded) {
        const r = await api(`/api/conversations/${c.id}/exclude`, { method: 'DELETE' });
        if (!r.ok) return toast('No se pudo cambiar.');
        toast('El asistente vuelve a responderle.');
        return refreshOpen();
      }
      return sheetConfirm('Que el asistente nunca le responda', 'El asistente deja de responderle a este número en todos sus chats. Lo atendés siempre vos. Lo podés deshacer cuando quieras.', 'Confirmar', async () => {
        const r = await api(`/api/conversations/${c.id}/exclude`, { method: 'POST' });
        closeSheet();
        if (!r.ok) return toast('No se pudo cambiar.');
        toast('Listo: el asistente no le responde más.');
        refreshOpen();
      });
    }
    if (act === 'reset') {
      return sheetConfirm('Reiniciar chat de prueba', 'Se borran todos los mensajes de este chat y vuelve a empezar de cero. Solo para tu propio número de prueba.', 'Reiniciar', async () => {
        const r = await api(`/api/conversations/${c.id}/reset`, { method: 'POST', body: { confirmation: 'BORRAR' } });
        closeSheet();
        if (!r.ok) return toast('No se pudo reiniciar.');
        refreshOpen();
      }, { typeWord: 'BORRAR' });
    }
    if (act === 'delete') {
      return sheetConfirm('Borrar chat', 'Se borra solo de acá (con sus fotos, audios y documentos). En WhatsApp queda igual.', 'Borrar', async () => {
        const r = await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
        closeSheet();
        if (!r.ok) return toast('No se pudo borrar el chat.');
        closeThread(); await loadList(); toast('Chat borrado.');
      });
    }
  }

  // ── Polling ──
  async function tick() {
    if (!running) return;
    if (document.visibilityState === 'visible') {
      try {
        await loadList();
        if (openId) {
          const c = convs.find((x) => x.id === openId);
          if (!c) closeThread();
          else {
            const sig = convSig(c);
            if (sig !== openSig) { openSig = sig; await loadThread(openId); }
          }
        }
      } catch (_) {}
    }
    if (running) pollTimer = setTimeout(tick, POLL_MS);
  }

  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    $('conv-list').addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-filters]')) { filter = { kind: 'all', tagId: null }; search = ''; $('conv-search').value = ''; return renderList(); }
      const item = e.target.closest('.conv-item');
      if (item) openThread(Number(item.dataset.id));
    });
    $('conv-search').addEventListener('input', (e) => { search = e.target.value; renderList(); });
    $('btn-filter').addEventListener('click', (e) => { e.stopPropagation(); togglePop('filter-pop', 'btn-filter', renderFilterPop); });
    $('filter-pop').addEventListener('click', (e) => {
      const b = e.target.closest('.pop-item'); if (!b) return;
      filter = { kind: b.dataset.kind, tagId: b.dataset.tag ? Number(b.dataset.tag) : null };
      closePops(); renderList();
    });
    $('btn-more').addEventListener('click', (e) => { e.stopPropagation(); togglePop('more-pop', 'btn-more', renderMorePop); });
    $('more-pop').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) doMenu(b.dataset.act); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.pop-wrap')) closePops(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePops(); closeSheet(); show($('lightbox'), false); } });
    $('sheet-close').addEventListener('click', closeSheet);
    $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
    $('thread-back').addEventListener('click', closeThread);
    $('btn-main-action').addEventListener('click', (e) => setPaused(e.currentTarget.dataset.action === 'take'));
    $('reply-send').addEventListener('click', send);
    $('reply-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 721px)').matches) { e.preventDefault(); send(); }
    });
    $('reply-text').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    $('thread-msgs').addEventListener('click', (e) => {
      const img = e.target.closest('.media-img img');
      if (img && img.src) { $('lightbox-img').src = img.src; show($('lightbox'), true); }
    });
    $('lightbox').addEventListener('click', () => show($('lightbox'), false));
    document.addEventListener('visibilitychange', () => {
      if (running && document.visibilityState === 'visible') { clearTimeout(pollTimer); tick(); }
    });
  }

  async function start(context) {
    ctx = context;
    wire();
    if (running) return;
    running = true;
    listSig = '';
    await Promise.all([loadTags().catch(() => {}), loadList().catch(() => {})]);
    renderList();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, POLL_MS);
    if (ctx.onLayout) ctx.onLayout();
  }
  function stop() { running = false; clearTimeout(pollTimer); closePops(); }

  window.EmbedConversations = { start, stop };
})();
