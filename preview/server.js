// Método Hana — servidor de PREVIEW local (modo prueba).
// Simula el funnel real: anuncio -> landing/quiz -> ruleta -> oferta -> checkout -> gracias -> producto.
// No toca nada publicado. No manda nada a Meta. No cobra nada.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4321;

// ---------------- datos ----------------
const PRICE = 'MX$ 400';
const TOKENS = { price: 'MX$ 400', original_price: 'MX$ 400', savings: 'MX$ 100', currency: 'MXN' };

const LANDING = (() => {
  let s = fs.readFileSync(path.join(ROOT, 'landing-store-paste.html'), 'utf8');
  for (const [k, v] of Object.entries(TOKENS)) s = s.split('{{' + k + '}}').join(v);
  return s;
})();

const ADS = [
  { vid: 'Hana-V1-sin-saltos-9x16.mp4',
    txt: 'Calistenia asiática pensada para mujeres de 40+ 🌸 Movimientos lentos, sin saltos y sin equipo: 15 minutos al día desde tu sala. Haz el test de 1 minuto y recibe tu plan de 21 días, con demostración animada de cada ejercicio y una versión más fácil si algo molesta. Pago único, sin suscripción.' },
  { vid: 'Hana-V2-test-1-minuto-9x16.mp4',
    txt: '¿Cuánto tiempo tienes al día? ¿Qué zonas quieres trabajar? Con tus respuestas armamos tu plan de calistenia asiática de 21 días: rutinas de 10, 15 o 20 minutos, sin impacto. Al final del test te espera un regalo de bienvenida 🎁' },
  { vid: 'Hana-V3-rodillas-9x16.mp4',
    txt: 'Moverte sin castigar las rodillas es posible. El plan Método Hana usa movimientos sin impacto, cada uno con su versión más fácil, y se adapta si tienes molestias en rodillas o espalda. 15 minutos al día. Contenido educativo: si tienes una lesión, consulta a tu médico.' },
];

const APP = 'https://metodo-hana.vercel.app/plan-cd1a5b5cc7';
const APP_RODILLAS = 'https://metodo-hana.vercel.app/rodillas-0ea240558f';
const APP_FASE2 = 'https://metodo-hana.vercel.app/fase2-2840a2230b';
const DL = id => `https://drive.google.com/uc?export=download&id=${id}`;
const PDF_ACCESO = DL('1QHPDNr45hXvjSKwtRKClokBTROFeYQvS');
const PDF_BONOS = DL('1Awa6QZuQjdH-ifoSJDDOxWvY4zc7xAVN');
const PDF_RODILLAS = DL('1VxXII85xD9vD7arpzIpYX1VQU11K0WHk');
const PDF_FASE2 = DL('1EX9oWfPOAuihCkFaMHasZphFweHo69RS');

// ---------------- stub del píxel + panel de prueba ----------------
const FBQ_STUB = `<script>
(function(){
  window.fbq=function(){
    var a=Array.prototype.slice.call(arguments);
    try{console.log('[fbq]',a.join(' | '));}catch(e){}
    try{var k='hana_fbq_events';var L=JSON.parse(localStorage.getItem(k)||'[]');
      L.push({e:a.join(' '),t:new Date().toLocaleTimeString()});localStorage.setItem(k,JSON.stringify(L));}catch(e){}
  };
  window._fbq=window.fbq;
})();
</script>`;

const TEST_PANEL = `<style>
#hpv-fab{position:fixed;left:12px;bottom:12px;z-index:99999;width:44px;height:44px;border-radius:50%;
  border:none;background:rgba(74,42,79,.92);color:#fff;font-size:20px;cursor:pointer;
  box-shadow:0 4px 14px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center}
#hpv{position:fixed;left:12px;bottom:64px;z-index:99999;display:none;flex-direction:column;gap:6px;width:200px;
  font:600 12px/1.3 -apple-system,system-ui,sans-serif;background:rgba(29,21,32,.95);
  padding:9px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.35)}
#hpv.open{display:flex}
#hpv .ttl{color:#e9d7df;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:2px 2px 4px}
#hpv button{background:#c2456a;color:#fff;border:none;border-radius:8px;padding:9px 10px;cursor:pointer;font:inherit;text-align:left}
#hpv button.g{background:#4a2a4f}
#hpv-m{max-height:40vh;overflow:auto;background:#fff;color:#1d1520;border-radius:8px;padding:9px;
  font:11px/1.5 -apple-system,system-ui;display:none;margin-top:2px}
#hpv-m.show{display:block}
#hpv-m b{color:#4a2a4f}
</style>
<button id="hpv-fab" title="Panel de prueba" onclick="hpvToggle()">🧪</button>
<div id="hpv">
  <div class="ttl">Panel de prueba (solo local)</div>
  <button onclick="hpvReset()">↺ Reiniciar</button>
  <button class="g" onclick="hpvExpire()">⏱ Vencer timer</button>
  <button class="g" onclick="hpvEvents()">👁 Ver eventos fbq</button>
  <div id="hpv-m"></div>
</div>
<script>
(function(){
  var h=location.hostname;
  var local=(h==='localhost'||h==='127.0.0.1'||/^192\\.168\\./.test(h)||/^10\\./.test(h)||/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(h));
  if(!local){var f=document.getElementById('hpv-fab');if(f)f.style.display='none';}
})();
function hpvToggle(){document.getElementById('hpv').classList.toggle('open');}
function hpvReset(){try{sessionStorage.clear();localStorage.clear();}catch(e){}location.href='/';}
function hpvExpire(){try{sessionStorage.setItem('hana_deadline',String(Date.now()-1000));}catch(e){}
  var m=document.getElementById('hpv-m');m.classList.add('show');
  m.innerHTML='<b>Timer vencido.</b><br>En la oferta el precio pasa a MX$ 400 y el botón va a /checkout sin cupón. Recargá la oferta si ya estabas en ella.';}
function hpvEvents(){var m=document.getElementById('hpv-m');var L=[];try{L=JSON.parse(localStorage.getItem('hana_fbq_events')||'[]');}catch(e){}
  m.classList.toggle('show');
  m.innerHTML='<b>Eventos fbq ('+L.length+')</b><br>'+(L.length?L.map(function(x){return x.t+' — '+x.e;}).join('<br>'):'(ninguno todavía)');}
</script>`;

// ---------------- helpers de página ----------------
function shell(title, body, extraHead) {
  return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&display=swap" rel="stylesheet">
${FBQ_STUB}${extraHead || ''}
</head><body>${body}${TEST_PANEL}</body></html>`;
}

const css = `*{box-sizing:border-box;margin:0;padding:0;font-family:'Poppins',system-ui,sans-serif}
body{background:#fff7f9;color:#1d1520}
.wrap{max-width:460px;margin:0 auto;padding:16px 16px 120px}
.brand{text-align:center;padding:14px 0}
.brand b{color:#4a2a4f;letter-spacing:3px;font-weight:900;font-size:20px}
.testbar{background:#4a2a4f;color:#fff;text-align:center;font-weight:700;font-size:13px;padding:9px}
h1{font-size:22px;font-weight:800;color:#4a2a4f}
.card{background:#fff;border:1px solid #fbe9ee;border-radius:16px;padding:16px;margin-top:14px;box-shadow:0 3px 10px rgba(74,42,79,.05)}
.row{display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:7px 0}
.row.free{color:#2f8a5b;font-weight:700}
.row.disc{color:#c2456a;font-weight:700}
.row.total{border-top:2px solid #fbe9ee;margin-top:6px;padding-top:12px;font-size:18px;font-weight:900;color:#4a2a4f}
.muted{color:#6f6472;font-size:12.5px}
.btn{display:block;width:100%;text-align:center;background:#c2456a;color:#fff;border:none;border-radius:14px;
  padding:16px;font-size:16px;font-weight:800;cursor:pointer;text-decoration:none;margin-top:14px;box-shadow:0 6px 18px rgba(194,69,106,.35)}
.btn.plum{background:#4a2a4f;box-shadow:none}
.btn.ghost{background:#fff;color:#4a2a4f;border:2px solid #fbe9ee;box-shadow:none}
.field{width:100%;border:2px solid #fbe9ee;border-radius:12px;padding:13px;margin-top:8px;font-size:15px;background:#faf3f5;color:#6f6472}
.pay{display:flex;gap:8px;margin-top:10px}
.pay label{flex:1;border:2px solid #fbe9ee;border-radius:12px;padding:12px;text-align:center;font-weight:700;font-size:13px;cursor:pointer}
.pay input{margin-right:4px}
.bump{border:2px dashed #c2456a;border-radius:14px;padding:14px;margin-top:14px;background:#fff}
.bump .h{font-weight:800;color:#c2456a;font-size:14px}
.sim{display:inline-block;background:#fbe9ee;color:#c2456a;font-weight:700;font-size:11px;border-radius:20px;padding:3px 9px}`;

// ---------------- /anuncio ----------------
function pageAnuncio() {
  const feed = ADS.map(a => `<div class="card" style="padding:0;overflow:hidden">
    <div style="padding:10px 14px;font-weight:800;color:#4a2a4f">🌸 metodo.hana <span class="muted" style="font-weight:400">· Patrocinado</span></div>
    <video style="width:100%;display:block;background:#000" controls muted playsinline preload="metadata" src="/anuncios/${a.vid}"></video>
    <div style="padding:14px">
      <p style="font-size:14px;line-height:1.55">${a.txt}</p>
      <a class="btn" href="/">Más información</a>
    </div>
  </div>`).join('\n');
  return shell('Método Hana — Anuncios', `<style>${css}</style>
    <div class="testbar">MODO PRUEBA — feed de anuncios simulado</div>
    <div class="wrap"><div class="brand"><b>HANA</b></div>
    <p class="muted" style="text-align:center;margin-bottom:6px">Simulación del feed de Instagram/Facebook</p>
    ${feed}</div>`);
}

// ---------------- /checkout ----------------
function pageCheckout(query) {
  const coupon = (query.cupon || '').toUpperCase() === 'HANA25';
  const base = 400;
  const discount = coupon ? 100 : 0;
  const total0 = base - discount;
  const body = `<style>${css}</style>
  <div class="testbar">MODO PRUEBA — no se cobra nada</div>
  <div class="wrap">
    <div class="brand"><b>HANA</b> · Checkout seguro</div>

    <div class="card">
      <h1 style="font-size:17px">Resumen del pedido</h1>
      <div class="row"><span>Método Hana: plan de calistenia asiática de 21 días para mujeres 40+</span><b>MX$ 400</b></div>
      <div class="row free"><span>Pack de bonos: rutina express de 7 min, guía de sueño profundo 40+ y calendario imprimible de 21 días</span><b>GRATIS</b></div>
      ${coupon ? `<div class="row disc"><span>Cupón HANA25</span><b>−MX$ 100</b></div>` : ''}
      <div class="row bumprow" style="display:none"><span>Rutina para rodillas y espalda</span><b>+MX$ 99</b></div>
      <div class="row total"><span>Total</span><b id="ck-total">MX$ ${total0}</b></div>
      ${coupon ? '' : '<p class="muted" style="margin-top:6px">Sin cupón activo — precio normal MX$ 400.</p>'}
    </div>

    <div class="bump">
      <div class="h">¿Te molestan las rodillas o la espalda?</div>
      <p style="font-size:13.5px;margin:6px 0">Rutina para rodillas y espalda: 8 movimientos suaves para cuidar tus articulaciones. <b>+MX$ 99</b></p>
      <button class="btn ghost" id="ck-bump" type="button" onclick="toggleBump()">＋ Agregar a mi compra</button>
    </div>

    <div class="card">
      <h1 style="font-size:16px">Datos personales <span class="sim">Simulación</span></h1>
      <input class="field" type="email" placeholder="Correo electrónico (opcional en modo prueba)">
      <div class="pay">
        <label><input type="radio" name="pay" checked>Tarjeta</label>
        <label><input type="radio" name="pay">OXXO</label>
        <label><input type="radio" name="pay">SPEI</label>
      </div>
      <input class="field" disabled placeholder="Número de tarjeta — Simulación">
      <div style="display:flex;gap:8px"><input class="field" disabled placeholder="MM/AA — Simulación"><input class="field" disabled placeholder="CVC — Simulación"></div>
    </div>

    <a class="btn" id="ck-buy" href="/gracias?cupon=${coupon ? 'HANA25' : ''}&bump=0">Quiero mi plan Hana · MX$ ${total0}</a>
    <p class="muted" style="text-align:center;margin-top:10px">🔒 Compra 100% segura · Garantía de 7 días · <b>MODO PRUEBA</b></p>
  </div>
  <script>
    var BASE=${base}, DISC=${discount}, bump=false;
    try{window.fbq&&fbq('track','InitiateCheckout');}catch(e){}
    function toggleBump(){
      bump=!bump;
      document.querySelector('.bumprow').style.display=bump?'flex':'none';
      document.getElementById('ck-bump').textContent=bump?'✓ Rutina agregada':'＋ Agregar a mi compra';
      var t=BASE-DISC+(bump?99:0);
      document.getElementById('ck-total').textContent='MX$ '+t;
      var b=document.getElementById('ck-buy');
      b.textContent='Quiero mi plan Hana · MX$ '+t;
      b.href='/gracias?cupon=${coupon ? 'HANA25' : ''}&bump='+(bump?1:0);
    }
  </script>`;
  return shell('Método Hana — Checkout (prueba)', body);
}

// ---------------- /gracias ----------------
function pageGracias(query) {
  const bump = query.bump === '1';
  try { } catch (e) {}
  const body = `<style>${css}</style>
  <div class="testbar">MODO PRUEBA — pago simulado, no se cobró nada</div>
  <div class="wrap">
    <div class="brand"><b>HANA</b></div>
    <div class="card" style="text-align:center">
      <div style="font-size:52px">✅</div>
      <h1>¡Pago aprobado!</h1>
      <p class="muted" style="margin-top:6px">Tu plan de 21 días está listo. Acceso inmediato.</p>
      <a class="btn" href="${APP}" target="_blank" rel="noopener">Abrir mi plan</a>
      <a class="btn plum" href="${PDF_ACCESO}" target="_blank" rel="noopener">⬇ PDF de acceso</a>
      <a class="btn ghost" href="${PDF_BONOS}" target="_blank" rel="noopener">⬇ Pack de bonos</a>
    </div>

    ${bump ? `<div class="card">
      <h1 style="font-size:17px">Tu extra: rodillas y espalda</h1>
      <p class="muted" style="margin:6px 0">Incluiste la rutina para cuidar tus articulaciones.</p>
      <a class="btn" href="${APP_RODILLAS}" target="_blank" rel="noopener">Abrir rutina de rodillas y espalda</a>
      <a class="btn ghost" href="${PDF_RODILLAS}" target="_blank" rel="noopener">⬇ PDF rodillas y espalda</a>
    </div>` : ''}

    <div class="card" style="border:2px solid #c2456a">
      <span class="sim">Oferta 1 clic</span>
      <h1 style="font-size:18px;margin-top:8px">Suma la Fase 2 — MX$ 199</h1>
      <p class="muted" style="margin:6px 0">Continúa tu progreso con una fase más avanzada, en un solo clic.</p>
      <a class="btn" href="/gracias-fase2">Sí, quiero la Fase 2</a>
      <p class="muted" style="margin-top:8px">Esta oferta no está activa en la tienda real todavía (requiere plan Starter).</p>
    </div>
  </div>`;
  return shell('Método Hana — ¡Pago aprobado!', body);
}

function pageFase2() {
  const body = `<style>${css}</style>
  <div class="testbar">MODO PRUEBA — upsell simulado</div>
  <div class="wrap">
    <div class="brand"><b>HANA</b></div>
    <div class="card" style="text-align:center">
      <div style="font-size:52px">🎉</div>
      <h1>¡Fase 2 agregada!</h1>
      <p class="muted" style="margin-top:6px">Gracias por seguir con el método.</p>
      <a class="btn" href="${APP_FASE2}" target="_blank" rel="noopener">Abrir Fase 2</a>
      <a class="btn plum" href="${PDF_FASE2}" target="_blank" rel="noopener">⬇ PDF Fase 2</a>
      <p class="muted" style="margin-top:10px">Recordatorio: esta oferta no está activa en la tienda real todavía (requiere plan Starter).</p>
    </div>
  </div>`;
  return shell('Método Hana — Fase 2', body);
}

// ---------------- static anuncios ----------------
const MIME = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function serveStatic(res, rel) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------------- router ----------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = Object.fromEntries(u.searchParams);
  const send = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };

  if (u.pathname === '/') return send(shell('Método Hana — Calistenia asiática', LANDING));
  if (u.pathname === '/anuncio') return send(pageAnuncio());
  if (u.pathname === '/checkout') return send(pageCheckout(q));
  if (u.pathname === '/gracias') return send(pageGracias(q));
  if (u.pathname === '/gracias-fase2') return send(pageFase2());
  if (u.pathname.startsWith('/anuncios/')) return serveStatic(res, decodeURIComponent(u.pathname.slice(1)));
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<p>404 — <a href="/">ir a la landing</a> · <a href="/anuncio">ver anuncios</a></p>');
});

function localIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) {
      if (i.family === 'IPv4' && !i.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(i.address)) return i.address;
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = localIP();
  console.log('\n  Método Hana · PREVIEW (modo prueba) — no se cobra nada, no se manda nada a Meta\n');
  console.log('  Local:   http://localhost:' + PORT);
  if (ip) console.log('  Red:     http://' + ip + ':' + PORT + '   (abrir desde el celular en la misma wifi)');
  else console.log('  Red:     (no se detectó IP local)');
  console.log('\n  Rutas: /  /anuncio  /checkout?cupon=HANA25  /gracias  /gracias-fase2\n');
});
