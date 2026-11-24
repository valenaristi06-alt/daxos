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
  const MIC_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
  const REC_MAX_MS = 3 * 60 * 1000; // 3 minutos

  // MediaRecorder state (sin dependencias nuevas; funciona en iPhone y Android).
  let mediaRecorder = null, recChunks = [], recStream = null, recTimerInt = null, recMaxTO = null;

  function pickAudioMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    // Android Chrome → webm/opus; iPhone Safari → mp4/aac.
    for (const c of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg']) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function stopTracks() {
    if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
    if (recTimerInt) { clearInterval(recTimerInt); recTimerInt = null; }
    if (recMaxTO) { clearTimeout(recMaxTO); recMaxTO = null; }
  }

  const MIC_DENIED = 'Activá el micrófono en tu navegador para grabar, o escribilo acá.';

  async function startRecording(taWrap, ta, row, mic) {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      bot(MIC_DENIED); scroll(); return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { bot(MIC_DENIED); scroll(); return; }
    recStream = stream; recChunks = [];
    const mime = pickAudioMime();
    try { mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) {
      try { mediaRecorder = new MediaRecorder(stream); }
      catch (e2) { stopTracks(); bot(MIC_DENIED); scroll(); return; }
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const type = mediaRecorder.mimeType || mime || 'audio/webm';
      stopTracks();
      const blob = new Blob(recChunks, { type });
      recChunks = [];
      if (!blob.size) { bot('No se grabó audio. Probá de nuevo o escribilo acá.'); stage = 'intro'; ingestInput(); scroll(); return; }
      const ext = (type.includes('mp4') || type.includes('aac')) ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      doIngest('', '', new File([blob], 'grabacion.' + ext, { type }), null, true);
    };
    try { mediaRecorder.start(); }
    catch (e) { stopTracks(); bot(MIC_DENIED); scroll(); return; }
    showRecordingBar(taWrap, ta, row, mic);
    recMaxTO = setTimeout(stopRecording, REC_MAX_MS); // tope 3 minutos
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (e) { stopTracks(); }
    }
  }

  function showRecordingBar(taWrap, ta, row, mic) {
    ta.style.display = 'none';
    mic.style.display = 'none';
    if (row) row.style.display = 'none';
    const bar = el('div', { class: 'cfg-rec' });
    const dot = el('span', { class: 'cfg-rec-dot', 'aria-hidden': 'true' });
    const time = el('span', { class: 'cfg-rec-time' }, '0:00');
    const label = el('span', { class: 'cfg-rec-label' }, 'Grabando…');
    const stop = el('button', { type: 'button', class: 'cfg-rec-stop', 'aria-label': 'Detener grabación' }, 'Detener');
    bar.append(dot, time, label, stop);
    taWrap.appendChild(bar);
    const t0 = Date.now();
    recTimerInt = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      time.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 500);
    stop.onclick = stopRecording;
  }

  function ingestInput() {
    const wrap = el('div', { class: 'cfg-ingest' });
    const taWrap = el('div', { class: 'cfg-ta-wrap' });
    const ta = el('textarea', { class: 'cfg-ta cfg-ta--mic', rows: '2', placeholder: 'Escribí acá o tocá el micrófono para contármelo en un audio' });
    const mic = el('button', { type: 'button', class: 'cfg-mic', 'aria-label': 'Grabar audio' }, MIC_SVG);
    taWrap.append(ta, mic);
    const urlRow = el('div', { style: 'display:none;margin-top:8px;' });
    const urlInput = el('input', { class: 'cfg-input', type: 'url', placeholder: 'https://tunegocio.com' });
    urlRow.appendChild(urlInput);
    const imgInput = el('input', { type: 'file', accept: 'image/*', multiple: '', style: 'display:none' });
    const row = el('div', { class: 'cfg-btn-row' });
    const bWeb = el('button', { type: 'button', class: 'cfg-chip' }, 'Pegar mi web');
    bWeb.onclick = () => { urlRow.style.display = urlRow.style.display === 'none' ? 'block' : 'none'; };
    row.appendChild(bWeb);
    const bImg = el('button', { type: 'button', class: 'cfg-chip' }, 'Subir capturas');
    bImg.onclick = () => imgInput.click();
    row.appendChild(bImg);
    const send = el('button', { type: 'button', class: 'cfg-send' }, 'Enviar');
    send.onclick = () => doIngest(ta.value, urlInput.value, null, imgInput.files);
    imgInput.onchange = () => { if (imgInput.files.length) doIngest('', '', null, imgInput.files); };
    row.appendChild(send);
    mic.onclick = () => startRecording(taWrap, ta, row, mic);
    wrap.append(taWrap, urlRow, row, imgInput);
    foot.appendChild(wrap);
  }

  async function doIngest(text, url, audio, images, isAudio) {
    const fd = new FormData();
    if (text && text.trim()) { fd.append('text', text.trim()); me(text.trim()); }
    if (url && url.trim()) { fd.append('url', url.trim()); me(url.trim()); }
    if (audio) { fd.append('audio', audio); me('🎤 (audio)'); }
    if (images && images.length) { for (const f of images) fd.append('images', f); me(`🖼️ (${images.length} captura/s)`); }
    foot.innerHTML = ''; bot(isAudio ? 'Escuchando tu audio…' : 'Dame un segundo, estoy leyendo…'); scroll();
    try { applyStateFromResponse(await post('/api/config-chat/ingest', fd, true)); }
    catch (e) {
      bot(isAudio ? 'No pude escuchar el audio. Probá de nuevo o escribilo acá.' : 'No pude leer eso. Probá escribirlo.');
      stage = 'intro'; ingestInput(); scroll();
    }
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
    if (stage === 'intro') {
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
