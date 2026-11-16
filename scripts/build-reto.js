// Anuncios "Reto 21 días" — estructura de la competencia, estética Método Hana.
// Estructura (9:16 1080x1920 / 4:5 1080x1350, 30fps):
//   GANCHO 0-6s   grilla 3x3 de la protagonista + bloque de texto (variante H1/H2)
//   CUERPO 6-30s  clips full-screen encadenados + subtítulos palabra x palabra + PiP app
//   APP    30-38s demo.mp4 full-screen + indicador de toque (pulse) + subtítulos
//   CIERRE 38-41s fondo #fbe9ee + "¡PRUÉBALO AHORA!" + triángulo que rebota
// Voz: si existe motor-anuncios/voces/vo-final.mp3 + words.json -> usa voz real + timing.
//      Si no -> render mudo con timing estimado (para previsualizar la estética).
// Uso: node scripts/build-reto.js [all|gancho] [H1|H2|both] [9x16|4x5|both]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const C = require('./ff-config');

const ROOT = path.join(__dirname, '..');
const PEX = path.join(ROOT, 'motor-anuncios', 'stock', 'pexels');
const APP = path.join(ROOT, 'motor-anuncios', 'app');
const VOCES = path.join(ROOT, 'motor-anuncios', 'voces');
const OUT = path.join(ROOT, 'anuncios');
const TMP = path.join(ROOT, 'motor-anuncios', '_adtmp');
const DEMO = path.join(ROOT, 'video', 'demo.mp4');
const FONT_HAND = path.join(ROOT, 'motor-anuncios', 'fonts', 'Caveat.ttf');
[OUT, TMP, VOCES].forEach(d => fs.mkdirSync(d, { recursive: true }));

const ff = (args) => execFileSync(C.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const txt = (name, s) => { const p = path.join(TMP, 'reto-' + name + '.txt'); fs.writeFileSync(p, s); return p; };

// ---------- assets png (triángulo cierre + anillo de toque) ----------
const ASSETS = path.join(TMP, 'reto-assets'); fs.mkdirSync(ASSETS, { recursive: true });
const TRI = path.join(ASSETS, 'tri.png');
const RING = path.join(ASSETS, 'ring.png');
async function genAssets() {
  const plum = '#c2456a';
  const tri = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="140"><path d="M10 20 H150 L80 125 Z" fill="${plum}"/></svg>`;
  const ring = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><circle cx="110" cy="110" r="90" fill="none" stroke="#ffffff" stroke-width="12" opacity="0.95"/><circle cx="110" cy="110" r="30" fill="#ffffff" opacity="0.85"/></svg>`;
  await sharp(Buffer.from(tri)).png().toFile(TRI);
  await sharp(Buffer.from(ring)).png().toFile(RING);
}

// ---------- timeline ----------
const T_GANCHO = 6, T_BODY = 24, T_APP = 8, T_CLOSE = 3;
const BODY_START = T_GANCHO;                 // 6
const APP_START = BODY_START + T_BODY;        // 30
const CLOSE_START = APP_START + T_APP;        // 38
const TOTAL = CLOSE_START + T_CLOSE;          // 41
const VO_SPAN = T_BODY + T_APP;               // 32 s de voz (6..38)

// ---------- clips protagonista ----------
// [archivo, segundo de inicio] — distintos recortes temporales para variedad
const P = id => path.join(PEX, id + '.mp4');
const GRID_SRC = [
  [P('7531376'), 2], [P('7531378'), 3], [P('7531379'), 5],
  [P('7927851'), 3], [P('7927852'), 4], [P('8939152'), 2],
  [P('7531376'), 12], [P('7531378'), 8], [P('7531379'), 9],
];
const GRID_LABELS = ['3x12', '2x15', '3x10', '2x30 s', '3x8', '2x20', '3x15', '2x12', '15 min'];
// cuerpo: 6 cortes
const BODY_SRC = [
  [P('8939152'), 1], [P('7531376'), 2], [P('7531378'), 2],
  [P('7531379'), 2], [P('7927851'), 3], [P('7927852'), 4],
];

// ---------- guion / subtítulos ----------
// líneas cortas; cada una aparece palabra por palabra y reemplaza a la anterior.
const LINES = [
  'Amiga, deberías empezar', 'el reto de 21 días', 'de calistenia asiática',
  'Son solo 15 minutos al día', 'desde tu sala', 'sin saltos y sin equipo',
  'Haces un test de 1 minuto', 'y la app arma tu plan', 'según tu edad y cómo te sientes',
  'Si algo te molesta,', 'tienes una versión más fácil', 'de cada ejercicio',
  'Empiezas el lunes', 'y llegas a Año Nuevo', 'sintiéndote más fuerte',
  'Haz el test, es gratis',
];

// construye [{text, words:[{w,start,end}], start, end}] en segundos ABSOLUTOS
function buildCaptions() {
  const wj = path.join(VOCES, 'words.json');
  if (fs.existsSync(wj)) {
    // words.json: [{word,start,end}] relativo al inicio de la voz (0 = BODY_START)
    const words = JSON.parse(fs.readFileSync(wj, 'utf8')).map(x => ({
      w: x.word, start: BODY_START + x.start, end: BODY_START + x.end,
    }));
    // re-agrupar palabras en las LINES por coincidencia secuencial
    const caps = []; let wi = 0;
    for (const line of LINES) {
      const toks = line.split(/\s+/);
      const lw = [];
      for (const tk of toks) { if (words[wi]) { lw.push({ w: tk, start: words[wi].start, end: words[wi].end }); wi++; } }
      if (lw.length) caps.push({ text: line, words: lw, start: lw[0].start, end: lw[lw.length - 1].end });
    }
    return caps;
  }
  // estimado: repartir VO_SPAN por cantidad de palabras
  const totalWords = LINES.reduce((n, l) => n + l.split(/\s+/).length, 0);
  const per = VO_SPAN / totalWords;
  let t = BODY_START; const caps = [];
  for (const line of LINES) {
    const toks = line.split(/\s+/); const lw = [];
    for (const tk of toks) { lw.push({ w: tk, start: t, end: t + per }); t += per; }
    caps.push({ text: line, words: lw, start: lw[0].start, end: lw[lw.length - 1].end });
  }
  return caps;
}

// capas drawtext de subtítulos (palabra por palabra, cumulativo por línea).
// offset = tiempo absoluto donde empieza el segmento (los clips tienen t local = 0).
function subtitleLayers(W, H, caps, offset) {
  offset = offset || 0;
  const y = Math.round(H * 0.70);          // zona baja segura
  const fs_ = Math.round(W * 0.052);
  const layers = [];
  caps.forEach((cap, ci) => {
    const lineEnd = (ci < caps.length - 1) ? caps[ci + 1].start : cap.end + 0.4;
    cap.words.forEach((wd, i) => {
      const cum = cap.words.slice(0, i + 1).map(x => x.w).join(' ');
      const tf = txt(`sub-${Math.round(offset)}-${ci}-${i}`, cum);
      const a = (wd.start - offset).toFixed(2), b = (lineEnd - offset).toFixed(2);
      layers.push(`drawtext=fontfile=${C.FONT_EXTRABOLD}:textfile=${tf}:fontcolor=white:fontsize=${fs_}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=0x1d1520@0.55:boxborderw=20:shadowcolor=black@0.6:shadowx=2:shadowy=2:enable='between(t,${a},${b})'`);
    });
  });
  return layers;
}

// ================= GANCHO =================
function norm(input, W, H, dur, ss, out) {
  ff(['-ss', String(ss), '-stream_loop', '-1', '-t', String(dur), '-i', input,
    '-an', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), out]);
  return out;
}

function buildGancho(W, H, tag, variant) {
  const cw = Math.round(W / 3), ch = Math.round(H / 3);
  const cells = GRID_SRC.map((s, i) => norm(s[0], cw, ch, T_GANCHO, s[1], path.join(TMP, `gch-${tag}-${variant}-c${i}.mp4`)));
  const pos = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) pos.push([c * cw, r * ch]);
  const layout = pos.map(p => `${p[0]}_${p[1]}`).join('|');
  // etiquetas de series arriba de cada celda
  const labelDraw = pos.map((p, i) =>
    `drawtext=fontfile=${C.FONT_EXTRABOLD}:text='${GRID_LABELS[i]}':fontcolor=white:fontsize=${Math.round(W * 0.030)}:x=${p[0] + 14}:y=${p[1] + 12}:box=1:boxcolor=${C.ACC}:boxborderw=9`).join(',');
  // oscurecer un poco el centro para legibilidad del texto
  const dim = `drawbox=x=0:y=${Math.round(H * 0.30)}:w=${W}:h=${Math.round(H * 0.42)}:color=black@0.28:t=fill`;

  // bloque de texto central (reveal 0..6)
  const yC = Math.round(H * 0.36);
  let txtLayers = [];
  if (variant === 'H1') {
    const l1 = txt('h1a', 'CADA MAÑANA,'); const l2 = txt('h1b', '15 MINUTOS.');
    const l3 = txt('h1c', 'ES TODO PARA EMPEZAR\nEL AÑO MÁS FUERTE.');
    txtLayers = [
      `drawtext=fontfile=${C.FONT_EXTRABOLD}:textfile=${l1}:fontcolor=white:fontsize=${Math.round(W * 0.072)}:x=(w-text_w)/2:y=${yC}:shadowcolor=black@0.55:shadowx=3:shadowy=3:enable='gte(t,0.3)'`,
      `drawtext=fontfile=${C.FONT_EXTRABOLD}:textfile=${l2}:fontcolor=white:fontsize=${Math.round(W * 0.092)}:x=(w-text_w)/2:y=${yC + Math.round(H * 0.055)}:shadowcolor=black@0.55:shadowx=3:shadowy=3:enable='gte(t,1.1)'`,
      `drawtext=fontfile=${FONT_HAND}:textfile=${txt('h1hand', 'Hasta Año Nuevo')}:fontcolor=${C.SOFT}:fontsize=${Math.round(W * 0.095)}:x=(w-text_w)/2:y=${yC + Math.round(H * 0.135)}:shadowcolor=black@0.5:shadowx=2:shadowy=2:enable='gte(t,2.2)'`,
      `drawtext=fontfile=${C.FONT_EXTRABOLD}:textfile=${l3}:fontcolor=white:fontsize=${Math.round(W * 0.040)}:line_spacing=8:x=(w-text_w)/2:y=${yC + Math.round(H * 0.225)}:shadowcolor=black@0.55:shadowx=2:shadowy=2:enable='gte(t,3.6)'`,
    ];
  } else {
    const l1 = txt('h2a', 'AMIGA, DEBERÍAS\nEMPEZAR ESTE RETO\nDE 21 DÍAS');
    txtLayers = [
      `drawtext=fontfile=${C.FONT_EXTRABOLD}:textfile=${l1}:fontcolor=white:fontsize=${Math.round(W * 0.072)}:line_spacing=10:x=(w-text_w)/2:y=${yC}:shadowcolor=black@0.55:shadowx=3:shadowy=3:enable='gte(t,0.3)'`,
      `drawtext=fontfile=${FONT_HAND}:textfile=${txt('h2hand', 'llegas a Año Nuevo más fuerte')}:fontcolor=${C.SOFT}:fontsize=${Math.round(W * 0.072)}:x=(w-text_w)/2:y=${yC + Math.round(H * 0.20)}:shadowcolor=black@0.5:shadowx=2:shadowy=2:enable='gte(t,2.4)'`,
    ];
  }

  const inputs = cells.flatMap(c => ['-i', c]);
  const ids = cells.map((_, i) => `[${i}:v]`).join('');
  const fc = `${ids}xstack=inputs=9:layout=${layout}[grid];` +
    `[grid]${labelDraw},${dim},${txtLayers.join(',')}[v]`;
  const out = path.join(TMP, `gancho-${tag}-${variant}.mp4`);
  ff([...inputs, '-filter_complex', fc, '-map', '[v]', '-t', String(T_GANCHO), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// ================= CUERPO =================
function buildBody(W, H, tag, caps) {
  // concat 6 cortes full-screen
  const segDur = T_BODY / BODY_SRC.length;
  const segs = BODY_SRC.map((s, i) => norm(s[0], W, H, segDur, s[1], path.join(TMP, `body-${tag}-s${i}.mp4`)));
  const list = path.join(TMP, `body-${tag}-list.txt`);
  fs.writeFileSync(list, segs.map(p => `file '${p}'`).join('\n'));
  const base = path.join(TMP, `body-${tag}-base.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);

  // PiP: panel blanco redondeado + sombra + card + barra de progreso
  const pipW = Math.round(W * 0.26);
  const pipH = Math.round(pipW * (1443 / 1164)); // card-dia1-tall ratio
  const card = path.join(APP, 'card-dia1-tall.png');
  const pipScaled = path.join(TMP, `pip-${tag}.png`);
  ff(['-i', card, '-vf', `scale=${pipW}:${pipH}`, pipScaled]);
  const pad = Math.round(W * 0.018);
  const px = W - pipW - Math.round(W * 0.05);
  const py = Math.round(H * 0.11);

  // subtítulos
  const subs = subtitleLayers(W, H, caps, BODY_START);

  const out = path.join(TMP, `body-${tag}.mp4`);
  const panelW = pipW + pad * 2, panelH = pipH + pad * 2 + 16;
  const panelShadow = `drawbox=x=${px - pad + 6}:y=${py - pad + 8}:w=${panelW}:h=${panelH}:color=black@0.22:t=fill`;
  const panel = `drawbox=x=${px - pad}:y=${py - pad}:w=${panelW}:h=${panelH}:color=white@0.96:t=fill`;
  const barTop = py + pipH + 6;
  const barFull = panelW - 16;
  const barBg = `drawbox=x=${px - pad + 8}:y=${barTop}:w=${barFull}:h=10:color=0xe4cdd6:t=fill`;
  const barProg = `drawbox=x=${px - pad + 8}:y=${barTop}:w='(${barFull})*min(1,(t-${BODY_START})/${T_BODY})':h=10:color=${C.ACC}:t=fill:enable='gte(t,${BODY_START})'`;

  ff(['-i', base, '-i', pipScaled,
    '-filter_complex',
    `[0:v]${panelShadow},${panel}[bg];[bg][1:v]overlay=${px}:${py}[o];[o]${barBg},${barProg},${subs.join(',')}[v]`,
    '-map', '[v]', '-t', String(T_BODY), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// ================= APP =================
function buildApp(W, H, tag, caps) {
  const subs = subtitleLayers(W, H, caps, APP_START);
  const out = path.join(TMP, `app-${tag}.mp4`);
  // anillo de toque parpadea cada ~2.6s (t local del clip de app)
  const ringX = `(W-w)/2`, ringY = Math.round(H * 0.56);
  const ringEnable = `lt(mod(t\\,2.6)\\,0.55)`;
  if (fs.existsSync(DEMO)) {
    ff(['-stream_loop', '-1', '-t', String(T_APP), '-i', DEMO, '-i', RING,
      '-filter_complex',
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30[bg];` +
      `[bg][1:v]overlay=${ringX}:${ringY}:enable='${ringEnable}'[o];[o]${subs.join(',')}[v]`,
      '-map', '[v]', '-t', String(T_APP), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  } else {
    ff(['-f', 'lavfi', '-i', `color=c=${C.SOFT}:s=${W}x${H}:d=${T_APP}:r=30`,
      '-filter_complex', `[0:v]${subs.join(',')}[v]`, '-map', '[v]', '-t', String(T_APP), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  }
  return out;
}

// ================= CIERRE =================
function buildClose(W, H, tag) {
  const l1 = txt('clz', '¡PRUÉBALO AHORA!');
  const triY = `${Math.round(H * 0.56)}+${Math.round(H * 0.022)}*sin(2*PI*t*2)`;
  const out = path.join(TMP, `close-${tag}.mp4`);
  ff(['-f', 'lavfi', '-i', `color=c=${C.SOFT}:s=${W}x${H}:d=${T_CLOSE}:r=30`, '-i', TRI,
    '-filter_complex',
    `[0:v]drawtext=fontfile=${C.FONT_BLACK}:textfile=${l1}:fontcolor=${C.PLUM}:fontsize=${Math.round(W * 0.085)}:x=(w-text_w)/2:y=${Math.round(H * 0.40)}[bg];` +
    `[bg][1:v]overlay=(W-w)/2:'${triY}'[v]`,
    '-map', '[v]', '-t', String(T_CLOSE), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

function concatAll(parts, out) {
  const list = path.join(TMP, 'reto-concat-' + path.basename(out) + '.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

function muxAudio(video, out) {
  const vo = path.join(VOCES, 'vo-final.mp3');
  if (!fs.existsSync(vo)) { fs.copyFileSync(video, out); return { out, audio: false }; }
  // voz empieza en BODY_START
  const delayMs = Math.round(BODY_START * 1000);
  ff(['-i', video, '-i', vo,
    '-filter_complex', `[1:a]adelay=${delayMs}|${delayMs},apad[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', out]);
  return { out, audio: true };
}

// ---------- run ----------
const MODE = process.argv[2] || 'all';
const VARWANT = process.argv[3] || 'both';
const RATWANT = process.argv[4] || 'both';
const RATIOS = RATWANT === 'both' ? [[1080, 1920, '9x16'], [1080, 1350, '4x5']] : (RATWANT === '4x5' ? [[1080, 1350, '4x5']] : [[1080, 1920, '9x16']]);
const VARIANTS = VARWANT === 'both' ? ['H1', 'H2'] : [VARWANT];

(async () => {
  await genAssets();
  const caps = buildCaptions();
  const results = [];
  for (const [W, H, tag] of RATIOS) {
    if (MODE === 'gancho') {
      for (const v of VARIANTS) results.push(buildGancho(W, H, tag, v));
      continue;
    }
    const body = buildBody(W, H, tag, caps);
    const app = buildApp(W, H, tag, caps);
    const close = buildClose(W, H, tag);
    for (const v of VARIANTS) {
      const gancho = buildGancho(W, H, tag, v);
      const silent = concatAll([gancho, body, app, close], path.join(TMP, `reto-${v}-${tag}-silent.mp4`));
      const final = path.join(OUT, `Hana-Reto-${v}-${tag}.mp4`);
      const { audio } = muxAudio(silent, final);
      results.push(final + (audio ? ' (con voz)' : ' (MUDO)'));
    }
  }
  console.log('\nSalidas:');
  results.forEach(r => console.log('  ' + path.relative(ROOT, r.replace ? r : r)));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
