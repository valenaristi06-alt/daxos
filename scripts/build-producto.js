// Genera los extras del checkout de Método Hana: 5 PDFs (carta) + 5 portadas 1000x1000.
// PDFs por Playwright desde HTML. Figuras de marca desde motor-anuncios/exercises_poses.json.
const { chromium } = require('playwright');
const QR = require('qrcode');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'producto');
const COVERS = path.join(OUT, 'portadas');
const REVIEW = path.join(OUT, '_review');
[OUT, COVERS, REVIEW].forEach(d => fs.mkdirSync(d, { recursive: true }));

const POSES = require(path.join(__dirname, '..', 'motor-anuncios', 'exercises_poses.json'));
const poseById = id => POSES.find(p => p.id === id);

const PLUM = '#4a2a4f', ACC = '#c2456a', SOFT = '#fbe9ee', BG = '#fffaf5', INK = '#1d1520', GRAY = '#6f6472';

const LINKS = {
  plan: 'https://metodo-hana.vercel.app/plan-cd1a5b5cc7',
  fase2: 'https://metodo-hana.vercel.app/fase2-2840a2230b',
  rodillas: 'https://metodo-hana.vercel.app/rodillas-0ea240558f',
  pdfFase2: 'https://drive.google.com/uc?export=download&id=1EX9oWfPOAuihCkFaMHasZphFweHo69RS',
};

// ---------- figura de marca desde pose (dimensionada por ALTO) ----------
function figSVG(pose, frame, boxH) {
  const k = pose[frame] || pose.A;
  const P = Object.values(k);
  const xs = P.map(a => a[0]), ys = P.map(a => a[1]);
  const pad = 18;
  const minx = Math.min(...xs) - pad, maxx = Math.max(...xs) + pad;
  const miny = Math.min(...ys) - pad - 6, maxy = Math.max(...ys) + pad;
  const w = maxx - minx, h = maxy - miny;
  const seg = (pts, wd) => {
    const d = 'M' + pts.map(q => q[0] + ',' + q[1]).join(' L');
    return `<path d="${d}" fill="none" stroke="#fff" stroke-width="${wd + 5}" stroke-linecap="round" stroke-linejoin="round"/>` +
           `<path d="${d}" fill="none" stroke="${PLUM}" stroke-width="${wd}" stroke-linecap="round" stroke-linejoin="round"/>`;
  };
  const hr = Math.max(11, Math.hypot(k.neck[0] - k.head[0], k.neck[1] - k.head[1]) * 0.8 + 4);
  const bx = k.head[0] + hr * 0.62, by = k.head[1] - hr * 0.6;
  let g = '';
  g += seg([k.hip, k.knee_f, k.ankle_f, k.toe_f], 10);
  g += seg([k.hip, k.knee_n, k.ankle_n, k.toe_n], 10);
  g += seg([k.hip, k.neck], 13);
  g += seg([k.neck, k.elbow_f, k.hand_f], 9);
  g += seg([k.neck, k.elbow_n, k.hand_n], 9);
  g += `<circle cx="${bx}" cy="${by}" r="${hr * 0.45}" fill="#fff"/><circle cx="${bx}" cy="${by}" r="${hr * 0.38}" fill="${PLUM}"/>`;
  g += `<circle cx="${k.head[0]}" cy="${k.head[1]}" r="${hr + 3}" fill="#fff"/><circle cx="${k.head[0]}" cy="${k.head[1]}" r="${hr}" fill="${PLUM}"/>`;
  const vw = Math.round(boxH * w / h);
  return `<svg width="${vw}" height="${boxH}" viewBox="${minx} ${miny} ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

// ---------- CSS compartido de los PDFs ----------
const PDFCSS = `
  @page { size: Letter; margin: 0; }
  *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:'Poppins',system-ui,sans-serif;color:${INK}}
  .page{width:8.5in;height:11in;padding:0.62in 0.66in 0.5in;position:relative;page-break-after:always;background:#fff;overflow:hidden}
  .page:last-child{page-break-after:auto}
  .ph{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid ${SOFT};padding-bottom:10px;margin-bottom:16px}
  .ph .logo{font-weight:900;letter-spacing:3px;color:${PLUM};font-size:16px}
  .ph .tag{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:${GRAY}}
  .ph .pill{font-size:10px;font-weight:700;color:${ACC};background:${SOFT};padding:4px 10px;border-radius:20px}
  h1{font-size:26px;font-weight:900;color:${PLUM};line-height:1.12}
  h2{font-size:17px;font-weight:800;color:${ACC};margin:14px 0 8px}
  h3{font-size:13.5px;font-weight:800;color:${PLUM}}
  .lead{color:${GRAY};font-size:12px;line-height:1.5;margin-top:6px}
  .foot{position:absolute;left:0.66in;right:0.66in;bottom:0.34in;border-top:1px solid ${SOFT};padding-top:7px;font-size:8.5px;color:${GRAY};text-align:center}
  .day{border:1px solid ${SOFT};border-radius:12px;padding:11px 13px;margin-bottom:9px;background:${BG}}
  .day .dh{font-weight:900;color:${ACC};font-size:13px;margin-bottom:5px}
  .meal{display:flex;gap:8px;font-size:11.5px;line-height:1.35;padding:2.5px 0}
  .meal b{color:${PLUM};min-width:70px;flex:0 0 auto}
  .cols{column-count:2;column-gap:20px}
  .shop h3{margin:10px 0 5px}
  .shop ul{list-style:none}
  .shop li{font-size:11.5px;padding:3px 0;display:flex;gap:7px;align-items:center;break-inside:avoid}
  .box{width:13px;height:13px;border:1.5px solid ${ACC};border-radius:3px;flex:0 0 auto}
  .mov{display:flex;gap:12px;align-items:center;border:1px solid ${SOFT};border-radius:12px;padding:9px 12px;margin-bottom:8px;background:${BG}}
  .mov .fig{width:58px;height:70px;background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;border:1px solid ${SOFT};overflow:hidden}
  .mov .mi h3{font-size:12.5px}
  .mov .mi .d{font-size:10.5px;color:${GRAY};margin-top:2px}
  .tip{background:${SOFT};border-radius:10px;padding:9px 12px;font-size:11px;color:${PLUM};margin-top:4px}
  .tip b{font-weight:800}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{border:1px solid #e6d6dc;padding:0;font-size:10px;text-align:center}
  th{background:${PLUM};color:#fff;font-weight:700;padding:7px 3px;font-size:9.5px}
  td{height:26px;color:${INK}}
  td.d{background:${SOFT};font-weight:800;color:${PLUM};width:52px}
  .cover{height:11in;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;
    background:radial-gradient(circle at 50% 35%, ${SOFT}, ${BG});padding:1in}
  .cover .kick{font-size:12px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:${ACC}}
  .cover h1{font-size:40px;margin-top:14px}
  .cover .sub{font-size:15px;color:${GRAY};margin-top:14px;max-width:5in}
  .cover .seal{margin-top:26px;font-size:12px;font-weight:800;color:#fff;background:${ACC};padding:9px 20px;border-radius:30px}
  .idx{list-style:none;margin-top:12px}
  .idx li{display:flex;justify-content:space-between;border-bottom:1px dashed ${SOFT};padding:11px 2px;font-size:13px;color:${PLUM};font-weight:600}
  .idx li span{color:${GRAY};font-weight:400}
  .acc{display:flex;gap:16px;align-items:center;border:2px solid ${SOFT};border-radius:14px;padding:14px;margin-bottom:12px}
  .acc img{width:96px;height:96px;flex:0 0 auto}
  .acc .ai h3{font-size:15px;color:${PLUM}}
  .acc .ai p{font-size:11px;color:${GRAY};margin-top:3px;line-height:1.4}
  .acc .ai a{font-size:10px;color:${ACC};word-break:break-all}
`;

const FOOT = `<div class="foot">Contenido educativo. No reemplaza la indicación de tu médico o nutrióloga.</div>`;
const HEADER = pill => `<div class="ph"><div><span class="logo">HANA</span> <span class="tag">Calistenia asiática</span></div><span class="pill">${pill}</span></div>`;
const page = (pill, inner) => `<div class="page">${HEADER(pill)}${inner}${FOOT}</div>`;
const coverPage = (kick, title, sub, seal) => `<div class="page"><div class="cover"><div class="kick">${kick}</div><h1>${title}</h1><div class="sub">${sub}</div>${seal ? `<div class="seal">${seal}</div>` : ''}</div></div>`;

// ================= CONTENIDO =================
// --- 1. Menú 7 días ---
const MENU = [
  ['Lunes', 'Huevos a la mexicana con frijoles de la olla y tortilla de maíz', 'Yogur natural con avena y plátano', 'Tinga de pollo deshebrado con arroz y ensalada de nopal', 'Quesadillas de queso panela con champiñones'],
  ['Martes', 'Avena con leche, canela y manzana + 1 huevo cocido', 'Jícama con limón y un puño de cacahuates', 'Pescado a la plancha con calabacitas y arroz', 'Tacos de frijol refrito con panela y aguacate'],
  ['Miércoles', 'Molletes de frijol y queso panela gratinado + pico de gallo', 'Yogur natural con fresas', 'Pollo asado con ensalada de nopal, jitomate y cebolla', 'Caldo de verduras con pollo deshebrado y tortilla'],
  ['Jueves', 'Huevos revueltos con nopal y frijoles', 'Manzana con crema de cacahuate', 'Picadillo de res magra con papa y zanahoria + tortilla', 'Quesadillas de champiñón y epazote con panela'],
  ['Viernes', 'Licuado de leche, avena, plátano y cacahuate + 1 huevo cocido', 'Zanahoria y pepino con limón y chile', 'Tostadas de atún con frijol, lechuga y aguacate', 'Sopa de fideo con pollo y aguacate'],
  ['Sábado', 'Chilaquiles verdes con huevo y queso panela', 'Yogur natural con avena y miel', 'Fajitas de pollo con pimiento y cebolla + tortilla y frijoles', 'Ensalada de atún con jitomate, aguacate y frijol'],
  ['Domingo', 'Huevos estrellados sobre frijoles con tortilla y aguacate', 'Fruta de temporada con semillas', 'Caldo tlalpeño de pollo con garbanzo y verduras + arroz', 'Quesadillas de flor de calabaza con queso panela'],
];
const SHOP = {
  'Proteínas y huevo': ['Huevos', 'Pechuga de pollo', 'Pescado blanco (tilapia o mojarra)', 'Atún en agua (latas)', 'Carne molida de res magra'],
  'Lácteos': ['Queso panela', 'Yogur natural', 'Leche'],
  'Frijol y granos': ['Frijol (de la olla o en lata)', 'Arroz', 'Avena', 'Tortillas de maíz', 'Fideo', 'Garbanzo'],
  'Verduras': ['Jitomate', 'Cebolla', 'Nopales', 'Calabacita', 'Champiñones', 'Zanahoria', 'Papa', 'Pimiento', 'Lechuga', 'Pepino', 'Jícama', 'Flor de calabaza'],
  'Frutas': ['Plátano', 'Manzana', 'Fresas', 'Limón', 'Aguacate', 'Fruta de temporada'],
  'Despensa': ['Cacahuate y crema de cacahuate', 'Semillas', 'Canela', 'Chile', 'Epazote', 'Aceite', 'Miel'],
};
function menuDayCard(d) {
  return `<div class="day"><div class="dh">${d[0]}</div>
    <div class="meal"><b>Desayuno</b><span>${d[1]}</span></div>
    <div class="meal"><b>Colación</b><span>${d[2]}</span></div>
    <div class="meal"><b>Comida</b><span>${d[3]}</span></div>
    <div class="meal"><b>Cena</b><span>${d[4]}</span></div></div>`;
}
function menuPages(withTitle) {
  const p1 = page('Menú 7 días', `${withTitle ? '<h1>Come rico toda la semana</h1><p class="lead">7 días de cocina mexicana casera. Proteína en cada comida, saciedad y energía. Platos de 15 a 20 minutos.</p>' : '<h2>Menú de la semana</h2>'}${MENU.slice(0, 4).map(menuDayCard).join('')}`);
  const p2 = page('Menú 7 días', `${MENU.slice(4).map(menuDayCard).join('')}
    <div class="tip" style="margin-top:12px"><b>Idea:</b> cocina el pollo y los frijoles una vez y úsalos en varias comidas de la semana.</div>`);
  const shop = `<h2>Lista del súper</h2><p class="lead">Marca lo que ya tienes en casa.</p><div class="cols shop">` +
    Object.entries(SHOP).map(([k, items]) => `<h3>${k}</h3><ul>${items.map(i => `<li><span class="box"></span>${i}</li>`).join('')}</ul>`).join('') + `</div>`;
  const p3 = page('Lista del súper', shop);
  return [p1, p2, p3];
}

// --- 2. Arranque 7 días ---
const WEEK = [
  { d: 1, foco: 'Movilidad y respiración', mov: ['respiracion-sol', 'circulos-hombros'], tip: 'Toma un vaso de agua apenas te levantes: arrancás el día hidratada.' },
  { d: 2, foco: 'Movilidad y piernas', mov: ['tai-chi-brazos', 'marcha'], tip: 'Deja la ropa cómoda lista la noche anterior. Una excusa menos.' },
  { d: 3, foco: 'Espalda y postura', mov: ['gato-vaca', 'isquios'], tip: 'Si ayer faltaste, retoma hoy sin culpa. Un día no borra tu avance.' },
  { d: 4, foco: 'Piernas y equilibrio', mov: ['talones', 'alcance-puntas'], tip: 'Apaga las pantallas 30 minutos antes de dormir: descansas mejor.' },
  { d: 5, foco: 'Movilidad y calma', mov: ['circulos-hombros', 'nino'], tip: 'Reparte media jarra de agua a lo largo del día.' },
  { d: 6, foco: 'Cuerpo completo suave', mov: ['respiracion-sol', 'tai-chi-brazos'], tip: 'Festeja: ya casi completas tu primera semana de hábito.' },
  { d: 7, foco: 'Descanso activo', mov: ['respiracion-caja', 'nino'], tip: 'Hoy camina y respira. Descansar también es parte del plan.' },
];
function weekDayBlock(w) {
  const movs = w.mov.map(id => { const p = poseById(id); return `<div class="mov"><div class="fig">${figSVG(p, 'A', 60)}</div><div class="mi"><h3>${p.name}</h3><div class="d">${p.dosis} · ${p.zona}</div></div></div>`; }).join('');
  return `<div class="day"><div class="dh">Día ${w.d} · ${w.foco}</div>
    <p style="font-size:11.5px;color:${PLUM};margin-bottom:8px">Abre tu rutina del Día ${w.d} en la app Método Hana y súmale estos 5 minutos de movilidad:</p>
    ${movs}
    <div class="tip"><b>Consejo del día:</b> ${w.tip}</div></div>`;
}
function weekPages(withTitle) {
  const head = withTitle ? '<h1>Arranque de 7 días</h1><p class="lead">Tu primera semana, día por día. La rutina del plan en la app + 5 minutos extra de movilidad, con una figura guía de cada movimiento.</p>' : '<h2>Arranque de 7 días · Semana 1</h2>';
  const p1 = page('Arranque 7 días', `${head}${WEEK.slice(0, 2).map(weekDayBlock).join('')}`);
  const p2 = page('Arranque 7 días', WEEK.slice(2, 5).map(weekDayBlock).join(''));
  const p3 = page('Arranque 7 días', WEEK.slice(5).map(weekDayBlock).join(''));
  return [p1, p2, p3];
}

// --- 3. Progreso sin báscula ---
function trackRows(from, to) {
  let r = '';
  for (let i = from; i <= to; i++) {
    r += `<tr><td class="d">Día ${i}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  }
  return r;
}
function trackTable(from, to) {
  return `<table><thead><tr>
    <th>Día</th><th>Cintura<br>(cm, opcional)</th><th>Energía<br>1–5</th><th>Sueño<br>1–5</th><th>Cómo me<br>queda la ropa</th><th>¿Hice mi<br>rutina? ✓</th>
    </tr></thead><tbody>${trackRows(from, to)}</tbody></table>`;
}
function trackPages(withTitle) {
  const head = withTitle ? '<h1>Tu progreso sin báscula</h1><p class="lead">Lo importante es cómo te sientes y si mantienes el hábito. Anota cada día lo que quieras; la cintura es opcional.</p>' : '<h2>Tu progreso sin báscula · 21 días</h2>';
  const p1 = page('Progreso 21 días', `${head}${trackTable(1, 11)}`);
  const p2 = page('Progreso 21 días', `${trackTable(12, 21)}
    <div class="tip" style="margin-top:14px"><b>Recuerda:</b> lo importante es cómo te sientes y si mantienes el hábito. Un día de descanso no es un retroceso.</div>`);
  return [p1, p2];
}

// ---------- build docs ----------
const doc = (title, pages) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<title>${title}</title><style>${PDFCSS}</style></head><body>${pages.join('')}</body></html>`;

async function accessPage() {
  const qrOpts = { margin: 1, width: 180, color: { dark: PLUM, light: '#ffffff' } };
  const qFase2 = await QR.toDataURL(LINKS.fase2, qrOpts);
  const qRod = await QR.toDataURL(LINKS.rodillas, qrOpts);
  const qPlan = await QR.toDataURL(LINKS.plan, qrOpts);
  const acc = (img, title, desc, link) => `<div class="acc"><img src="${img}" alt="QR"><div class="ai"><h3>${title}</h3><p>${desc}</p><a>${link}</a></div></div>`;
  return page('Plan 42 días', `<h1>Plan completo de 42 días</h1>
    <p class="lead">Escanea cada código con la cámara de tu celular para abrir tus accesos. También te llegan por correo.</p>
    ${acc(qPlan, 'Tu plan base (días 1–21)', 'La app Método Hana con tu rutina personalizada.', LINKS.plan)}
    ${acc(qFase2, 'Fase 2 · días 22–42', 'La continuación de tu programa en la app. PDF de acceso incluido en tu correo.', LINKS.fase2)}
    ${acc(qRod, 'Rutina de rodillas y espalda', '8 movimientos suaves para cuidar tus articulaciones.', LINKS.rodillas)}`);
}

async function buildAll() {
  const browser = await chromium.launch();
  const page0 = await browser.newPage();

  const docs = [
    { file: 'come-rico-toda-la-semana', title: 'Come rico toda la semana', pages: menuPages(true) },
    { file: 'arranque-7-dias', title: 'Arranque de 7 días', pages: weekPages(true) },
    { file: 'progreso-sin-bascula', title: 'Tu progreso sin báscula', pages: trackPages(true) },
  ];

  // 4. Pack 3 en 1
  const packIdx = `<h1>Pack Arranque 3 en 1</h1><p class="lead">Todo para empezar con el pie derecho.</p>
    <ul class="idx">
      <li>1 · Come rico toda la semana <span>Menú de 7 días + lista del súper</span></li>
      <li>2 · Arranque de 7 días <span>Tu Semana 1 con 5 min extra de movilidad</span></li>
      <li>3 · Tu progreso sin báscula <span>Seguimiento imprimible de 21 días</span></li>
    </ul>`;
  docs.push({
    file: 'pack-arranque-3-en-1', title: 'Pack Arranque 3 en 1',
    pages: [
      coverPage('Pack de bienvenida', 'Pack Arranque<br>3 en 1', 'Menú de 7 días · Arranque de Semana 1 · Progreso sin báscula', '3 guías en 1'),
      page('Índice', packIdx),
      ...menuPages(false), ...weekPages(false), ...trackPages(false),
    ],
  });

  // 5. Plan completo 42 días (acceso)
  const plan42Idx = `<h2>Incluye además el Pack Arranque</h2>
    <ul class="idx">
      <li>Come rico toda la semana <span>Menú 7 días + lista del súper</span></li>
      <li>Arranque de 7 días <span>Semana 1 con movilidad extra</span></li>
      <li>Tu progreso sin báscula <span>Seguimiento de 21 días</span></li>
    </ul>
    <div class="tip" style="margin-top:14px"><b>Cómo usarlo:</b> termina tus días 1–21, continúa con la Fase 2 (días 22–42) y usa la rutina de rodillas y espalda cuando lo necesites.</div>`;
  docs.push({
    file: 'plan-completo-42-dias', title: 'Plan completo de 42 días',
    pages: [
      coverPage('Programa completo', 'Plan completo<br>de 42 días', 'Duplica tu programa con la Fase 2 + Pack Arranque + rutina de rodillas y espalda', 'Acceso total'),
      await accessPage(),
      page('Índice', plan42Idx),
    ],
  });

  // render PDFs + review screenshots
  for (const d of docs) {
    const html = doc(d.title, d.pages);
    await page0.setContent(html, { waitUntil: 'networkidle' });
    await page0.pdf({ path: path.join(OUT, d.file + '.pdf'), format: 'Letter', printBackground: true });
    // review: screenshot each .page element at ~110 dpi
    await page0.setViewport ? null : null;
    const handles = await page0.$$('.page');
    for (let i = 0; i < handles.length; i++) {
      await handles[i].screenshot({ path: path.join(REVIEW, `${d.file}-${i + 1}.png`) });
    }
    console.log('PDF:', d.file + '.pdf', '·', d.pages.length, 'págs');
  }

  await browser.close();
  return docs;
}

// ---------- portadas 1000x1000 ----------
function coverImg(opts) {
  // mockup PDF inclinado con sombra
  const sheet = (rot, title, z, extra) => `<div class="sheet" style="transform:rotate(${rot}deg);z-index:${z};${extra || ''}">
    <div class="sh-head"><span class="sh-logo">HANA</span></div>
    <div class="sh-title">${title}</div>
    <div class="sh-lines">${'<i></i>'.repeat(5)}</div>
  </div>`;
  const phone = `<div class="phone"><div class="pscreen"><div class="plogo">MÉTODO HANA</div><div class="pbar"></div><div class="pfig">${figSVG(poseById('puente'), 'B', 90)}</div></div></div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700;800;900&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:'Poppins',sans-serif;-webkit-print-color-adjust:exact}
    body{width:1000px;height:1000px;background:radial-gradient(circle at 50% 38%, ${SOFT}, ${BG});display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden}
    .kick{font-size:20px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:${ACC};margin-bottom:10px}
    .stage{position:relative;width:620px;height:560px;display:flex;align-items:center;justify-content:center}
    .sheet{position:absolute;width:300px;height:390px;background:#fff;border-radius:18px;box-shadow:0 30px 60px rgba(74,42,79,.28);
      border:1px solid #f0e3e8;padding:26px 24px}
    .sh-head{border-bottom:3px solid ${SOFT};padding-bottom:10px;margin-bottom:18px}
    .sh-logo{font-weight:900;letter-spacing:4px;color:${PLUM};font-size:20px}
    .sh-title{font-size:30px;font-weight:900;color:${PLUM};line-height:1.1}
    .sh-lines{margin-top:20px}
    .sh-lines i{display:block;height:11px;border-radius:6px;background:${SOFT};margin-bottom:12px}
    .sh-lines i:nth-child(odd){width:85%}
    .phone{position:absolute;width:200px;height:400px;background:${PLUM};border-radius:30px;padding:12px;box-shadow:0 30px 60px rgba(74,42,79,.32);z-index:5}
    .pscreen{background:#fff;border-radius:20px;height:100%;padding:18px;display:flex;flex-direction:column;align-items:center}
    .plogo{font-weight:900;letter-spacing:2px;color:${PLUM};font-size:13px}
    .pbar{width:70%;height:7px;border-radius:5px;background:${SOFT};margin:14px 0}
    .pfig{flex:1;display:flex;align-items:center;justify-content:center}
    .ttl{font-size:40px;font-weight:900;color:${PLUM};text-align:center;margin-top:26px;max-width:720px;line-height:1.1}
  </style></head><body>
    <div class="kick">${opts.kick}</div>
    <div class="stage">${opts.stage}</div>
    <div class="ttl">${opts.ttl}</div>
  </body></html>`;
}

async function buildCovers() {
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
  const sheet = (rot, title, extra) => `<div class="sheet" style="transform:rotate(${rot}deg);${extra || ''}"><div class="sh-head"><span class="sh-logo">HANA</span></div><div class="sh-title">${title}</div><div class="sh-lines"><i></i><i></i><i></i><i></i><i></i></div></div>`;
  const phone = `<div class="phone"><div class="pscreen"><div class="plogo">MÉTODO HANA</div><div class="pbar"></div><div class="pfig">${figSVG(poseById('puente'), 'B', 95)}</div></div></div>`;

  const covers = [
    { file: 'come-rico-toda-la-semana', kick: 'Menú 7 días', ttl: 'Come rico toda la semana', stage: sheet(-7, 'Menú<br>7 días') },
    { file: 'arranque-7-dias', kick: 'Semana 1', ttl: 'Arranque de 7 días', stage: sheet(-7, 'Arranque<br>7 días') },
    { file: 'progreso-sin-bascula', kick: 'Seguimiento 21 días', ttl: 'Tu progreso sin báscula', stage: sheet(-7, 'Progreso<br>21 días') },
    { file: 'pack-arranque-3-en-1', kick: 'Pack de bienvenida', ttl: 'Pack Arranque 3 en 1', stage: `${sheet(-14, 'Menú', 'left:120px;top:70px')}${sheet(-2, 'Semana 1', 'left:210px;top:110px;z-index:3')}${sheet(9, 'Progreso', 'left:300px;top:90px;z-index:4')}` },
    { file: 'plan-completo-42-dias', kick: 'Programa completo', ttl: 'Plan completo de 42 días', stage: `${sheet(-13, 'Fase 2', 'left:95px;top:95px')}${sheet(-4, 'Pack', 'left:175px;top:120px;z-index:2')}${phone.replace('class="phone"', 'class="phone" style="left:330px;top:80px"')}` },
  ];
  for (const c of covers) {
    await p.setContent(coverImg(c), { waitUntil: 'networkidle' });
    await p.screenshot({ path: path.join(COVERS, c.file + '.png'), clip: { x: 0, y: 0, width: 1000, height: 1000 } });
    console.log('Portada:', c.file + '.png');
  }
  await browser.close();
}

(async () => {
  await buildAll();
  await buildCovers();
  console.log('\nListo. PDFs en producto/, portadas en producto/portadas/, revisión en producto/_review/');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
