// Conversations inside the embed (partner CRM iframe). Same data and actions as the
// Daxos conversations screen (/api/conversations…), authenticated with the embed token
// (X-Embed-Token) instead of cookies. Refreshes itself by polling while visible.
(function () {
  'use strict';

  const POLL_MS = 4000;
  const WINDOW_24H_MS = 23.5 * 3600 * 1000;

  let ctx = null;            // { authHeaders, onLayout }
  let running = false;
  let pollTimer = null;
  let convs = [];
  let listSig = '';
  let openId = null;
  let openSig = '';
  let openConv = null;       // conversation row from /messages
  let openMsgsSig = '';
  let canReply = false;
  const blobUrls = new Map(); // media url → object URL (fetched with the embed token)

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.hidden = !on; };

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

  // ── Formatting (same rules as the Daxos conversations screen) ──
  function formatPhone(raw) {
    if (!raw) return 'Desconocido';
    const d = String(raw).replace(/\D/g, '');
    if (d.startsWith('598') && d.length === 11) return `+598 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
    if (d.length === 9 && d.startsWith('0')) return `+598 ${d.slice(1, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
    if (/^\d{8,15}$/.test(d)) return '+' + d;
    return String(raw);
  }
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
  // "[imagen] hola" → "📷 Foto · hola" for list previews.
  function friendlyPreview(text) {
    const t = String(text || '');
    const m = t.match(/^\[(imagen|audio|documento|video|sticker|ubicación|contacto)(?::[^\]]*)?\]\s*(.*)$/s);
    if (!m) return t;
    const label = { imagen: '📷 Foto', audio: '🎤 Audio', documento: '📄 Documento', video: '🎬 Video', sticker: 'Sticker', 'ubicación': '📍 Ubicación', contacto: '👤 Contacto' }[m[1]];
    return m[2] ? `${label} · ${m[2]}` : label;
  }

  // ── Conversation state ──
  // ownerHandling: the owner took the chat ("Atiendo yo", or wrote from here / WhatsApp).
  // waiting: the client is waiting for a person (asked for one, the assistant flagged it,
  // or the plan limit / trial paused it).
  function ownerHandling(c) {
    return !!c.needs_attention && (c.paused_reason === 'owner_reply' || c.paused_reason === 'owner' || (!c.paused_reason && !!c.human_paused_at));
  }
  function waiting(c) {
    return !!c.needs_human || (!!c.needs_attention && !ownerHandling(c));
  }
  function sortConvs(list) {
    return list.slice().sort((a, b) => {
      const wa = waiting(a) ? 1 : 0, wb = waiting(b) ? 1 : 0;
      if (wa !== wb) return wb - wa;
      const ta = (toUtcDate(a.last_msg_at || a.created_at) || 0).valueOf();
      const tb = (toUtcDate(b.last_msg_at || b.created_at) || 0).valueOf();
      return tb - ta;
    });
  }
  const convSig = (c) => [c.id, c.last_msg_at, c.last_message, c.needs_attention, c.needs_human, c.paused_reason, c.human_paused_at, c.is_excluded].join('|');

  // ── List ──
  function renderList() {
    const el = $('conv-list');
    if (!convs.length) {
      el.innerHTML = '<div class="conv-empty"><p class="conv-empty-title">Todavía no hay conversaciones.</p><p class="conv-empty-sub">Cuando tus clientes te escriban por WhatsApp, aparecen acá.</p></div>';
      return;
    }
    el.innerHTML = convs.map((c) => {
      const w = waiting(c);
      const mine = ownerHandling(c) || c.is_excluded;
      return `<button type="button" class="conv-item${c.id === openId ? ' is-open' : ''}${w ? ' is-waiting' : ''}" data-id="${c.id}">
        <span class="conv-line1">
          <span class="conv-name">${w ? '<span class="conv-dot" aria-hidden="true"></span>' : ''}${esc(formatPhone(c.customer_id))}</span>
          <span class="conv-time">${esc(formatListDate(c.last_msg_at || c.created_at))}</span>
        </span>
        <span class="conv-preview">${esc(friendlyPreview(c.last_message || '').slice(0, 90))}</span>
        ${w ? '<span class="conv-badge conv-badge--wait">Te espera</span>' : mine ? '<span class="conv-badge">Atendés vos</span>' : ''}
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
        } else if (node.tagName === 'A') {
          node.href = obj;
        }
      } catch (_) {
        node.closest('.media')?.classList.add('media--error');
      }
    });
  }

  function mediaHtml(m) {
    const md = m.media;
    if (!md) return '';
    if (md.kind === 'image') {
      return `<div class="media media-img"><img alt="Foto del cliente" data-media="${esc(md.url)}" /></div>`;
    }
    if (md.kind === 'audio') {
      return `<div class="media media-audio"><audio controls preload="metadata" data-media="${esc(md.url)}"></audio>
        <a class="media-dl" data-media="${esc(md.url)}" download="audio">Descargar audio</a></div>`;
    }
    return `<div class="media media-doc"><a class="media-doc-link" data-media="${esc(md.url)}" download="${esc(md.name || 'documento')}">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.5v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      <span>${esc(md.name || 'Documento')}</span><span class="media-doc-dl">Descargar</span></a></div>`;
  }

  // Text shown under a media item: drop the "[imagen]" style placeholder, keep caption /
  // transcript / document name.
  function messageText(m) {
    let t = String(m.content || '');
    if (m.media) {
      t = t.replace(/^\[(imagen|audio|documento)(?::[^\]]*)?\]\s*/, '');
      if (m.media.kind === 'audio' && t) t = 'Transcripción: ' + t;
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
      const mine = m.role !== 'user';
      parts.push(`<div class="msg ${mine ? 'msg--out' : 'msg--in'}"><div class="bubble">
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

  function renderThreadState() {
    const c = openConv;
    if (!c) return;
    $('thread-phone').textContent = formatPhone(c.customer_id);
    const mine = ownerHandling(c) || c.is_excluded;
    const w = waiting(c);
    $('thread-sub').textContent = mine ? 'Atendés vos' : w ? 'Te espera' : 'Responde el asistente';
    show($('btn-take'), !c.needs_attention && !c.is_excluded);

    const banner = $('thread-banner'), btn = $('btn-banner-action');
    let text = '', action = null;
    if (c.is_excluded) {
      text = 'El asistente no le responde a este contacto. Lo atendés vos.';
    } else if (ownerHandling(c)) {
      text = 'Atendés vos este chat. El asistente no responde acá.';
      action = 'resume';
    } else if (c.needs_attention) {
      text = 'Este cliente te espera. El asistente no responde en este chat.';
      action = 'resume';
    } else if (c.needs_human) {
      text = 'El asistente avisó que este cliente necesita una persona. Sigue respondiendo mientras tanto.';
      action = 'take';
    }
    banner.classList.toggle('thread-banner--wait', w);
    $('thread-banner-text').textContent = text;
    btn.textContent = action === 'resume' ? 'Reactivar asistente' : 'Atiendo yo';
    btn.dataset.action = action || '';
    show(btn, !!action);
    show(banner, !!text);
    if (action === 'take') show($('btn-take'), false);
  }

  function renderReplyBox(lastUserAt) {
    const lastMs = lastUserAt ? toUtcDate(lastUserAt).valueOf() : null;
    canReply = !!lastMs && (Date.now() - lastMs <= WINDOW_24H_MS);
    const ta = $('reply-text');
    ta.disabled = !canReply;
    $('reply-send').disabled = !canReply;
    ta.placeholder = canReply
      ? 'Escribí tu respuesta…'
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
    if (listRow) listRow.is_excluded = !!data.is_excluded;
    renderThreadState();
    renderReplyBox(data.last_user_message_at);
    const msgs = data.messages || [];
    const sig = msgs.length + ':' + (msgs.length ? msgs[msgs.length - 1].id : 0);
    if (initial || sig !== openMsgsSig) {
      const box = $('thread-msgs');
      stickBottom = initial || (box.scrollHeight - box.scrollTop - box.clientHeight < 80);
      openMsgsSig = sig;
      renderMessages(msgs);
      keepBottomIfNeeded();
    }
  }

  function openThread(id) {
    openId = id;
    openMsgsSig = '';
    openConv = null;
    const c = convs.find((x) => x.id === id);
    openSig = c ? convSig(c) : '';
    renderList();
    show($('thread-empty'), false);
    show($('thread'), true);
    show($('delete-confirm'), false);
    show($('reply-err'), false);
    show($('thread-banner'), false);
    $('reply-text').value = '';
    $('thread-phone').textContent = c ? formatPhone(c.customer_id) : '';
    $('thread-sub').textContent = '';
    $('thread-msgs').innerHTML = '<p class="thread-none">Cargando mensajes…</p>';
    $('convs-box').classList.add('thread-open');
    loadThread(id, { initial: true });
    ctx.onLayout && ctx.onLayout();
  }

  function closeThread() {
    openId = null;
    openConv = null;
    show($('thread'), false);
    show($('thread-empty'), true);
    $('convs-box').classList.remove('thread-open');
    renderList();
  }

  // ── Actions ──
  async function setPaused(paused) {
    if (!openId) return;
    const id = openId;
    const r = await api(`/api/conversations/${id}/${paused ? 'pause' : 'resume'}`, { method: 'PATCH' });
    if (!r.ok) return;
    await loadList();
    if (id === openId) loadThread(id);
  }

  async function deleteOpen() {
    if (!openId) return;
    const id = openId;
    const r = await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (!r.ok) return;
    closeThread();
    await loadList();
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
      if (id === openId) ta.value = '';
      stickBottom = true;
      await loadList();
      if (id === openId) await loadThread(id);
      keepBottomIfNeeded();
    } finally {
      btn.textContent = 'Enviar';
      btn.disabled = !canReply;
    }
  }

  // ── Polling: list every few seconds; the open chat reloads when it changed ──
  async function tick() {
    if (!running) return;
    if (document.visibilityState === 'visible') {
      try {
        await loadList();
        if (openId) {
          const c = convs.find((x) => x.id === openId);
          if (!c) { closeThread(); }
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
      const item = e.target.closest('.conv-item');
      if (item) openThread(Number(item.dataset.id));
    });
    $('thread-back').addEventListener('click', closeThread);
    $('btn-take').addEventListener('click', () => setPaused(true));
    $('btn-banner-action').addEventListener('click', (e) => {
      const a = e.currentTarget.dataset.action;
      if (a === 'resume') setPaused(false);
      if (a === 'take') setPaused(true);
    });
    $('btn-delete').addEventListener('click', () => show($('delete-confirm'), true));
    $('btn-delete-cancel').addEventListener('click', () => show($('delete-confirm'), false));
    $('btn-delete-ok').addEventListener('click', deleteOpen);
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
    await loadList().catch(() => {});
    renderList();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, POLL_MS);
    ctx.onLayout && ctx.onLayout();
  }

  function stop() {
    running = false;
    clearTimeout(pollTimer);
  }

  window.EmbedConversations = { start, stop, _openThread: (id) => openThread(id) };
})();
