// Builds revision/index.html — one-page review of the whole Método Hana project.
const fs = require('fs');

const TITLES = [
  'Portada — ¿Cuántos años tienes?',
  'Prueba social — Miles de mujeres 40+',
  '¿Ya probaste la calistenia asiática?',
  'Respuesta personalizada',
  '¿Qué objetivo es más importante hoy?',
  '¿Cómo describirías tu cuerpo hoy?',
  '¿Qué te molesta más hoy? (múltiple)',
  '¿Cómo te gustaría verte?',
  '¿Qué zonas trabajar primero? (múltiple)',
  'Solo 15 minutos al día',
  '¿Con qué frecuencia haces ejercicio?',
  '¿Te sientes cómoda con este movimiento?',
  '¿Cuántas sentadillas seguidas?',
  '¿Qué tan flexible eres?',
  '¿Cómo es un día normal tuyo?',
  '¿Y cómo suele cambiar tu peso?',
  'Tu tipo de cuerpo (biotipo)',
  '¿Última vez que te sentiste orgullosa?',
  '¿Sientes dolor en alguna zona? (múltiple)',
  'Beneficios de la calistenia asiática',
  '¿Cómo prefieres empezar?',
  'Intensidad de tu plan + semanas',
  '¿Cuánto mides?',
  '¿Cuál es tu peso actual?',
  '¿A qué peso te gustaría llegar?',
  '¿Cuánta agua tomas al día?',
  '¿Cuántas horas duermes?',
  '¿Cómo es tu alimentación?',
  '¿Cómo está tu energía durante el día?',
  'Evolución de energía y fuerza (gráfico)',
  'Creando tu plan (carga 0→100%)',
  'Tu protocolo casi listo (comparación)',
  'Tu perfil está listo (IMC)',
  'Recupera tu energía (emocional)',
  'Compromiso — ¿Qué tan segura estás?',
  'Ruleta de bienvenida',
  'Oferta (barra 14:59 · MX$400 → MX$300)',
];

const ADS = [
  { k: 'A · Sin saltos', vid: 'Hana-V1-sin-saltos-9x16.mp4', img: 'Hana-E1-sin-saltos-4x5.jpg',
    principal: 'Calistenia asiática pensada para mujeres de 40+ 🌸 Movimientos lentos, sin saltos y sin equipo: 15 minutos al día desde tu sala. Haz el test de 1 minuto y recibe tu plan de 21 días, con demostración animada de cada ejercicio y una versión más fácil si algo molesta. Pago único, sin suscripción.',
    titulo: 'Haz el test de 1 minuto', desc: 'Tu plan de 21 días en el celular' },
  { k: 'B · Test de 1 minuto', vid: 'Hana-V2-test-1-minuto-9x16.mp4', img: 'Hana-E2-plan-21-dias-4x5.jpg',
    principal: '¿Cuánto tiempo tienes al día? ¿Qué zonas quieres trabajar? Con tus respuestas armamos tu plan de calistenia asiática de 21 días: rutinas de 10, 15 o 20 minutos, sin impacto. Al final del test te espera un regalo de bienvenida 🎁',
    titulo: 'Tu plan de calistenia asiática', desc: 'Test gratis · 1 minuto' },
  { k: 'C · Rodillas', vid: 'Hana-V3-rodillas-9x16.mp4', img: 'Hana-E3-rodillas-4x5.jpg',
    principal: 'Moverte sin castigar las rodillas es posible. El plan Método Hana usa movimientos sin impacto, cada uno con su versión más fácil, y se adapta si tienes molestias en rodillas o espalda. 15 minutos al día. Contenido educativo: si tienes una lesión, consulta a tu médico.',
    titulo: 'Calistenia sin impacto', desc: 'Plan de 21 días adaptado a ti' },
];

const PDFS = [
  ['Metodo-Hana-Acceso.pdf', '1QHPDNr45hXvjSKwtRKClokBTROFeYQvS'],
  ['Metodo-Hana-Pack-de-Bonos.pdf', '1Awa6QZuQjdH-ifoSJDDOxWvY4zc7xAVN'],
  ['Metodo-Hana-Rodillas-y-Espalda.pdf', '1VxXII85xD9vD7arpzIpYX1VQU11K0WHk'],
  ['Metodo-Hana-Fase-2.pdf', '1EX9oWfPOAuihCkFaMHasZphFweHo69RS'],
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const shots = TITLES.map((t, i) => {
  const n = String(i + 1).padStart(2, '0');
  return `<figure class="shot">
      <div class="shotimg"><img loading="lazy" src="shots/${n}.png" alt="Pantalla ${n}"></div>
      <figcaption><span class="num">${i + 1}</span>${esc(t)}</figcaption>
    </figure>`;
}).join('\n');

const ads = ADS.map(a => `<article class="ad">
    <h3>${esc(a.k)}</h3>
    <div class="admedia">
      <video controls muted playsinline preload="metadata" src="../anuncios/${a.vid}"></video>
      <img loading="lazy" src="../anuncios/${a.img}" alt="${esc(a.k)} estático">
    </div>
    <div class="copy">
      <p><b>Texto principal:</b> ${esc(a.principal)}</p>
      <p><b>Título:</b> ${esc(a.titulo)} &nbsp;·&nbsp; <b>Descripción:</b> ${esc(a.desc)}</p>
    </div>
  </article>`).join('\n');

const pdfs = PDFS.map(([name, id]) =>
  `<a class="pill" target="_blank" rel="noopener" href="https://drive.google.com/file/d/${id}/view">📄 ${esc(name)}</a>`
).join('\n');

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Método Hana — Revisión completa</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root{--plum:#4a2a4f;--acc:#c2456a;--soft:#fbe9ee;--ink:#1d1520;--gray:#6f6472}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Poppins',system-ui,sans-serif;color:var(--ink);background:#fff7f9;line-height:1.5}
  header{background:var(--plum);color:#fff;padding:34px 22px}
  header h1{font-size:28px;font-weight:900}
  header p{color:#e9d7df;margin-top:6px;font-size:14px}
  nav{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--soft);padding:10px 18px;display:flex;gap:8px;flex-wrap:wrap}
  nav a{font-size:13px;font-weight:700;color:var(--plum);text-decoration:none;background:var(--soft);padding:7px 12px;border-radius:20px}
  nav a:hover{background:var(--acc);color:#fff}
  main{max-width:1180px;margin:0 auto;padding:22px}
  section{margin-top:40px}
  h2{font-size:22px;font-weight:800;color:var(--plum);border-left:5px solid var(--acc);padding-left:12px;margin-bottom:6px}
  .lead{color:var(--gray);font-size:14px;margin-bottom:18px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:18px}
  .shot{background:#fff;border:1px solid var(--soft);border-radius:14px;overflow:hidden;box-shadow:0 3px 10px rgba(74,42,79,.06)}
  .shotimg{background:#faeef2;max-height:430px;overflow:hidden;display:flex;justify-content:center}
  .shot img{width:100%;height:auto;display:block}
  figcaption{font-size:12.5px;font-weight:600;padding:10px 12px;display:flex;gap:8px;align-items:flex-start;min-height:52px}
  .num{background:var(--acc);color:#fff;font-weight:800;border-radius:7px;padding:1px 7px;font-size:12px;flex:0 0 auto}
  .media-row{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
  video{border-radius:14px;background:#000;max-width:100%}
  .vbox{width:300px;max-width:100%}
  .vbox video{width:100%}
  .cap{background:#fff;border:1px solid var(--soft);border-radius:14px;overflow:hidden;width:300px;max-width:100%}
  .cap img{width:100%;display:block}
  .cap .t{padding:10px 12px;font-size:13px;color:var(--gray)}
  .ad{background:#fff;border:1px solid var(--soft);border-radius:16px;padding:18px;margin-bottom:18px}
  .ad h3{color:var(--acc);font-size:17px;margin-bottom:12px}
  .admedia{display:flex;gap:16px;flex-wrap:wrap}
  .admedia video{width:230px}
  .admedia img{width:230px;border-radius:12px;height:max-content}
  .copy{margin-top:14px;font-size:13.5px}
  .copy p{margin-top:8px}
  .copy b{color:var(--plum)}
  .pills{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
  .pill{display:inline-block;background:#fff;border:2px solid var(--soft);color:var(--plum);font-weight:700;
    text-decoration:none;padding:11px 16px;border-radius:12px;font-size:14px}
  .pill:hover{border-color:var(--acc)}
  .pill.big{background:var(--acc);color:#fff;border-color:var(--acc)}
  .note{background:var(--soft);border-radius:12px;padding:14px 16px;font-size:13.5px;color:var(--plum);margin-top:12px}
  footer{text-align:center;color:var(--gray);font-size:12px;padding:40px 20px}
</style>
</head>
<body>
<header>
  <h1>Método Hana — Revisión completa</h1>
  <p>Landing-quiz en vivo · ruleta · checkout · anuncios · producto — capturas iPhone 390×844. Generado ${new Date().toISOString().slice(0,10)}.</p>
</header>
<nav>
  <a href="#landing">Landing (37)</a>
  <a href="#ruleta">Ruleta y urgencia</a>
  <a href="#checkout">Checkout</a>
  <a href="#anuncios">Anuncios</a>
  <a href="#producto">Producto</a>
</nav>
<main>

  <section id="landing">
    <h2>a) Landing — las 37 pantallas</h2>
    <p class="lead">Recorrido completo del quiz en vialiviana.impultienda.ar (píxel de Facebook bloqueado durante la captura).</p>
    <div class="grid">
      ${shots}
    </div>
  </section>

  <section id="ruleta">
    <h2>b) Ruleta y urgencia</h2>
    <p class="lead">Secuencia: girar la ruleta → “¡Ganaste! 25% OFF” → página de oferta con la barra “Tu 25% OFF está reservado por 14:59” y scroll al precio MX$400 tachado / MX$300.</p>
    <div class="vbox"><video controls playsinline preload="metadata" src="media/ruleta-oferta.webm"></video></div>
  </section>

  <section id="checkout">
    <h2>c) Checkout</h2>
    <p class="lead">Checkout con cupón HANA25 aplicado. No se cargó ningún dato ni se realizó pago.</p>
    <div class="cap">
      <img loading="lazy" src="media/checkout.png" alt="Checkout HANA25">
      <div class="t">Cupón <b>HANA25 −25%</b> aplicado · total <b>MX$ 300</b> · métodos MX (Google Pay, tarjeta, OXXO, SPEI) · order bump rodillas/espalda +MX$99.</div>
    </div>
  </section>

  <section id="anuncios">
    <h2>d) Anuncios (Meta · México)</h2>
    <p class="lead">3 anuncios, cada uno con su video 9:16 + estático 4:5 y los textos del plan.</p>
    ${ads}
    <div class="note">Campaña propuesta: objetivo Ventas · píxel 1704965227908722 · solo México, mujeres 35-65 · US$10/día, tope US$60 · lanzar con OK del dueño.</div>
  </section>

  <section id="producto">
    <h2>e) Producto</h2>
    <p class="lead">La app que recibe la clienta y los PDFs de entrega (Google Drive).</p>
    <div class="pills">
      <a class="pill big" target="_blank" rel="noopener" href="https://metodo-hana.vercel.app/plan-cd1a5b5cc7">🌸 Abrir la app — plan de 21 días</a>
    </div>
    <div class="pills">
      ${pdfs}
    </div>
  </section>

</main>
<footer>Método Hana · documento de revisión interna · rama metodo-hana</footer>
</body>
</html>`;

fs.writeFileSync('revision/index.html', html);
console.log('revision/index.html written', (Buffer.byteLength(html) / 1024).toFixed(1) + 'KB');
