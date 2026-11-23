// Barra superior del asistente, visible en todas las pantallas del panel.
// - Asistente encendido: interruptor para pausar (pide confirmación).
// - Pausado por el dueño: aviso rojo "no responde a ningún cliente" + botón Reanudar.
// - Silenciado por un admin de Daxos: aviso "pausado por Daxos" SIN botón (el dueño no
//   puede levantar un silencio puesto por admin; su interruptor solo toca bot_paused).
(function () {
  'use strict';

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  async function getState() {
    try {
      const r = await fetch('/api/business', { credentials: 'same-origin' });
      if (!r.ok) return null;
      return await r.json(); // null if no business yet
    } catch (_) { return null; }
  }

  async function setPaused(paused) {
    const r = await fetch('/api/business/bot-paused', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ paused }),
    });
    if (!r.ok) throw new Error('No se pudo cambiar el estado del asistente.');
    return r.json();
  }

  function render(state, bar) {
    bar.innerHTML = '';
    if (!state) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';

    const adminSilenced = !!state.admin_silenced;
    const paused = !!state.bot_paused;

    if (adminSilenced) {
      bar.style.background = '#7f1d1d';
      bar.appendChild(el('div', { style: 'color:#fff;font-weight:700;' },
        '⏸️ Asistente pausado por Daxos. No responde a ningún cliente.'));
      return;
    }

    if (paused) {
      bar.style.background = '#b91c1c';
      const wrap = el('div', { style: 'display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;' });
      wrap.appendChild(el('span', { style: 'color:#fff;font-weight:700;' },
        '⏸️ Tu asistente está pausado. No responde a ningún cliente.'));
      const btn = el('button', { type: 'button',
        style: 'background:#fff;color:#b91c1c;border:0;border-radius:8px;padding:8px 18px;font-weight:700;cursor:pointer;' },
        'Reanudar');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await setPaused(false); await refresh(bar); }
        catch (e) { alert(e.message); btn.disabled = false; }
      });
      wrap.appendChild(btn);
      bar.appendChild(wrap);
      return;
    }

    // Encendido: interruptor para pausar.
    bar.style.background = '#065f46';
    const wrap = el('div', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;' });
    wrap.appendChild(el('span', { style: 'color:#d1fae5;font-weight:600;' }, '🟢 Asistente encendido'));
    const btn = el('button', { type: 'button',
      style: 'background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:6px 14px;font-weight:600;cursor:pointer;' },
      'Pausar asistente');
    btn.addEventListener('click', async () => {
      const ok = window.confirm('¿Pausar el asistente? Dejará de responder a TODOS los clientes (de este y de nuevos chats) hasta que lo reanudes. Los mensajes que lleguen se guardan, pero el bot no envía nada.');
      if (!ok) return;
      btn.disabled = true;
      try { await setPaused(true); await refresh(bar); }
      catch (e) { alert(e.message); btn.disabled = false; }
    });
    wrap.appendChild(btn);
    bar.appendChild(wrap);
  }

  async function refresh(bar) {
    const state = await getState();
    render(state, bar);
  }

  function mount() {
    if (document.getElementById('bot-pause-bar')) return;
    const bar = el('div', { id: 'bot-pause-bar',
      style: 'position:sticky;top:0;z-index:9999;width:100%;padding:10px 16px;text-align:center;box-sizing:border-box;display:none;' });
    document.body.insertBefore(bar, document.body.firstChild);
    refresh(bar);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
