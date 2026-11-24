// Chat configurador (Fase 2). Vive arriba de Configuración, encima de los bloques.
// Oculto si el negocio no tiene el flag. Usa /api/config-chat/* (lector de Fase 1).
(function () {
  'use strict';
  const sec = document.getElementById('config-chat');
  if (!sec) return;
  const msgs = document.getElementById('cfg-chat-msgs');
  const foot = document.getElementById('cfg-chat-foot');
  const titleEl = document.getElementById('cfg-chat-title');

  let state = null;     // { enabled, plan_allows_voice, configured, draft, summary, next_question }
  let stage = 'intro';  // intro | questions | summary | changes | done

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) (k === 'style') ? (n.style.cssText = attrs[k]) : n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }
  function bot(text) { msgs.appendChild(el('div', { class: 'cfg-bub cfg-bub--bot' }, text)); }
  function me(text) { msgs.appendChild(el('div', { class: 'cfg-bub cfg-bub--me' }, text)); }
  function scroll() { msgs.scrollTop = msgs.scrollHeight; }

  async function getState() {
    const r = await fetch('/api/config-chat/state', { credentials: 'same-origin' });
    return r.ok ? r.json() : { enabled: false };
  }

  async function post(path, body, isForm) {
    const opts = { method: 'POST', credentials: 'same-origin' };
    if (isForm) opts.body = body;
    else { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body || {}); }
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
    return r.json();
  }

  function applyStateFromResponse(resp) {
    state.draft = resp.draft; state.summary = resp.summary; state.next_question = resp.next_question;
    stage = resp.next_question ? 'questions' : 'summary';
    render();
  }

  // ── Inputs ──
  function ingestInput() {
    const wrap = el('div', { class: 'cfg-ingest' });
    const ta = el('textarea', { class: 'cfg-ta', rows: '2', placeholder: 'Escribí acá, o usá los botones…' });
    const urlRow = el('div', { style: 'display:none;margin-top:8px;' });
    const urlInput = el('input', { class: 'cfg-input', type: 'url', placeholder: 'https://tunegocio.com' });
    urlRow.appendChild(urlInput);
    const audioInput = el('input', { type: 'file', accept: 'audio/*', style: 'display:none' });
    const imgInput = el('input', { type: 'file', accept: 'image/*', multiple: '', style: 'display:none' });
    const row = el('div', { class: 'cfg-btn-row' });
    const bWeb = el('button', { type: 'button', class: 'cfg-chip' }, 'Pegar mi web');
    bWeb.onclick = () => { urlRow.style.display = urlRow.style.display === 'none' ? 'block' : 'none'; };
    row.appendChild(bWeb);
    // Audio del dueño para explicar su negocio: disponible en TODOS los planes.
    // (El límite por plan es para las respuestas con VOZ del bot, no para esto.)
    const bAud = el('button', { type: 'button', class: 'cfg-chip' }, 'Mandar audio');
    bAud.onclick = () => audioInput.click();
    row.appendChild(bAud);
    const bImg = el('button', { type: 'button', class: 'cfg-chip' }, 'Subir capturas');
    bImg.onclick = () => imgInput.click();
    row.appendChild(bImg);
    const send = el('button', { type: 'button', class: 'cfg-send' }, 'Enviar');
    send.onclick = () => doIngest(ta.value, urlInput.value, audioInput.files[0], imgInput.files);
    audioInput.onchange = () => { if (audioInput.files[0]) doIngest('', '', audioInput.files[0], null); };
    imgInput.onchange = () => { if (imgInput.files.length) doIngest('', '', null, imgInput.files); };
    row.appendChild(send);
    wrap.append(ta, urlRow, row, audioInput, imgInput);
    foot.appendChild(wrap);
  }

  async function doIngest(text, url, audio, images) {
    const fd = new FormData();
    if (text && text.trim()) { fd.append('text', text.trim()); me(text.trim()); }
    if (url && url.trim()) { fd.append('url', url.trim()); me(url.trim()); }
    if (audio) { fd.append('audio', audio); me('🎤 (audio enviado)'); }
    if (images && images.length) { for (const f of images) fd.append('images', f); me(`🖼️ (${images.length} captura/s)`); }
    foot.innerHTML = ''; bot('Dame un segundo, estoy leyendo…'); scroll();
    try { applyStateFromResponse(await post('/api/config-chat/ingest', fd, true)); }
    catch (e) { bot('No pude leer eso. Probá escribirlo.'); stage = 'intro'; render(); }
  }

  function questionInput(q) {
    const wrap = el('div', { class: 'cfg-qinput' });
    if (q.type === 'buttons' && q.options) {
      const row = el('div', { class: 'cfg-btn-row' });
      for (const opt of q.options) {
        const b = el('button', { type: 'button', class: 'cfg-chip cfg-chip--opt' }, opt);
        b.onclick = () => { if (opt === 'Otro') { ta.style.display = 'block'; ta.focus(); } else { me(opt); answer(q.field, opt); } };
        row.appendChild(b);
      }
      wrap.appendChild(row);
    }
    const ta = el('textarea', { class: 'cfg-ta', rows: '2', placeholder: 'Escribí tu respuesta…', style: (q.type === 'buttons' && !q.freeText) ? 'display:none;margin-top:8px;' : 'margin-top:8px;' });
    const send = el('button', { type: 'button', class: 'cfg-send', style: 'margin-top:8px;' }, 'Enviar');
    send.onclick = () => { if (ta.value.trim()) { me(ta.value.trim()); answer(q.field, ta.value.trim()); } };
    wrap.append(ta, send);
    foot.appendChild(wrap);
  }

  async function answer(field, value) {
    foot.innerHTML = '';
    try { applyStateFromResponse(await post('/api/config-chat/answer', { field, value })); }
    catch (e) { bot('Ups, no se guardó. Probá de nuevo.'); render(); }
  }

  // ── Resumen "Esto es lo que entendí" ──
  function renderSummary() {
    const box = el('div', { class: 'cfg-summary' });
    box.appendChild(el('div', { class: 'cfg-summary-title' }, 'Esto es lo que entendí'));
    for (const block of (state.summary || [])) {
      box.appendChild(el('div', { class: 'cfg-sum-block' }, block.title));
      for (const it of block.items) {
        const row = el('div', { class: 'cfg-sum-item' });
        row.appendChild(el('div', { class: 'cfg-sum-label' }, it.label + (it.needs_confirm ? ' <span class="cfg-sum-flag">a confirmar</span>' : '')));
        row.appendChild(el('div', { class: 'cfg-sum-val' }, (it.value || '').slice(0, 180)));
        row.appendChild(el('div', { class: 'cfg-sum-src' }, it.source || ''));
        box.appendChild(row);
      }
    }
    foot.appendChild(box);
    const apply = el('button', { type: 'button', class: 'cfg-send cfg-apply' }, state.configured ? 'Aplicar cambios' : 'Aplicar y configurar');
    apply.onclick = onApply;
    foot.appendChild(apply);
  }

  async function onApply() {
    if (state.configured) {
      const r = await fetch('/api/config-chat/changes', { credentials: 'same-origin' });
      const data = r.ok ? await r.json() : { changes: [] };
      state.changes = data.changes || [];
      stage = 'changes'; render();
    } else {
      await post('/api/config-chat/apply', {});
      stage = 'done'; render();
    }
  }

  function renderChanges() {
    bot('Estos son los cambios sobre tu configuración actual. Aceptá los que quieras:');
    const box = el('div', { class: 'cfg-summary' });
    const checks = [];
    if (!state.changes.length) box.appendChild(el('div', { class: 'cfg-sum-val' }, 'No hay cambios.'));
    for (const c of state.changes) {
      const row = el('label', { class: 'cfg-change' });
      const cb = el('input', { type: 'checkbox' }); cb.checked = true; cb.dataset.field = c.field;
      checks.push(cb);
      const txt = el('div', {}, `<b>${c.label}</b><div class="cfg-chg-from">antes: ${c.from || '(vacío)'}</div><div class="cfg-chg-to">ahora: ${c.to}</div>`);
      row.append(cb, txt);
      box.appendChild(row);
    }
    foot.appendChild(box);
    const btn = el('button', { type: 'button', class: 'cfg-send cfg-apply' }, 'Confirmar cambios');
    btn.onclick = async () => {
      const acceptedFields = checks.filter((c) => c.checked).map((c) => c.dataset.field);
      await post('/api/config-chat/apply', { acceptedFields });
      stage = 'done'; render();
    };
    foot.appendChild(btn);
  }

  // ── Render principal ──
  function render() {
    msgs.innerHTML = ''; foot.innerHTML = '';
    titleEl.textContent = state.configured ? 'Revisá tu asistente' : 'Configurá tu asistente';
    if (stage === 'intro') {
      bot('Contame de tu negocio como se lo contarías a un cliente nuevo. Podés escribir, mandarme un audio, pegar tu web o subir capturas de tu Instagram.');
      ingestInput();
    } else if (stage === 'questions' && state.next_question) {
      bot(state.next_question.text);
      questionInput(state.next_question);
    } else if (stage === 'summary') {
      renderSummary();
    } else if (stage === 'changes') {
      renderChanges();
    } else if (stage === 'done') {
      bot('¡Listo! Tu asistente quedó configurado. Revisá los bloques de abajo cuando quieras.');
      const b = el('button', { type: 'button', class: 'cfg-send' }, 'Ver mi configuración');
      b.onclick = () => location.reload();
      foot.appendChild(b);
    }
    scroll();
  }

  (async function init() {
    state = await getState();
    if (!state || !state.enabled) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    // Si ya hay borrador en curso, retomar en preguntas o resumen.
    if (state.draft && state.draft.length) stage = state.next_question ? 'questions' : 'summary';
    else stage = 'intro';
    render();
  })();
})();
