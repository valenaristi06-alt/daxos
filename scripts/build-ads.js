// Construye los 3 anuncios (G1 grilla, G2 "Dame 21 días", G3 "Sin gimnasio")
// en 9:16 (1080x1920) y 4:5 (1080x1350), 15 s, con ffmpeg empaquetado + Poppins.
// Usa los clips de motor-anuncios/stock/clip-*.mp4. Si no hay, genera placeholders
// para validar el pipeline (pasá --placeholders para forzarlos).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const C = require('./ff-config');

const ROOT = path.join(__dirname, '..');
const STOCK = path.join(ROOT, 'motor-anuncios', 'stock');
const OUT = path.join(ROOT, 'anuncios');
const TMP = path.join(ROOT, 'motor-anuncios', '_adtmp');
const DEMO = path.join(ROOT, 'video', 'demo.mp4');
[OUT, TMP].forEach(d => fs.mkdirSync(d, { recursive: true }));

const FORCE_PH = process.argv.includes('--placeholders');
const ff = (args) => execFileSync(C.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const txt = (name, s) => { const p = path.join(TMP, name + '.txt'); fs.writeFileSync(p, s); return p; };

// ---------- assets png (check + flecha) ----------
const ASSETS = path.join(TMP, 'assets'); fs.mkdirSync(ASSETS, { recursive: true });
const CHECK = path.join(ASSETS, 'check.png');
const ARROW = path.join(ASSETS, 'arrow.png');
let _assetsReady = false;
async function genAssets() {
  if (_assetsReady) return;
  const check = `<svg xmlns="http://www.w3.org/2000/svg" width="110" height="110"><circle cx="55" cy="55" r="52" fill="#2f8a5b"/><path d="M30 57 L48 76 L82 36" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const arrow = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="130"><path d="M55 12 h40 v52 h30 L75 118 L20 64 h35 z" fill="#c2456a"/></svg>`;
  await sharp(Buffer.from(check)).png().toFile(CHECK);
  await sharp(Buffer.from(arrow)).png().toFile(ARROW);
  _assetsReady = true;
}

// ---------- clips de entrada ----------
function stockClips() {
  if (!fs.existsSync(STOCK)) return [];
  return fs.readdirSync(STOCK).filter(f => /^clip-.*\.mp4$/.test(f)).sort().map(f => path.join(STOCK, f));
}
function makePlaceholders() {
  const dir = path.join(TMP, 'ph'); fs.mkdirSync(dir, { recursive: true });
  const cols = ['0x6b4a6f', '0x8a5a78', '0xb06a86', '0x7a4a6a', '0x9a5a7a', '0xc2456a', '0x5a3a52', '0xa85f7e', '0x734963', '0xb8738f', '0x8f5570', '0x6f4560'];
  const out = [];
  for (let i = 0; i < 12; i++) {
    const o = path.join(dir, `ph-${String(i + 1).padStart(2, '0')}.mp4`);
    if (!fs.existsSync(o)) {
      ff(['-f', 'lavfi', '-i', `color=c=${cols[i]}:s=1080x1920:d=6:r=30`,
        '-vf', `drawtext=fontfile=${C.FONT_BLACK}:text='${i + 1}':fontcolor=white@0.5:fontsize=360:x=(w-text_w)/2:y=(h-text_h)/2`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', o]);
    }
    out.push(o);
  }
  return out;
}
let CLIPS = FORCE_PH ? [] : stockClips();
if (CLIPS.length < 6) { console.log('(usando placeholders — faltan clips reales en motor-anuncios/stock/)'); CLIPS = makePlaceholders(); }

// ---------- helpers ----------
// normaliza un clip a WxH (cover+crop), duración dur, 30fps, sin audio
function norm(input, W, H, dur, out) {
  ff(['-stream_loop', '-1', '-t', String(dur), '-i', input,
    '-an', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), out]);
  return out;
}
// capas de texto palabra por palabra (cumulativo), centrado en x, y fijo
function revealLayers(words, t0, perWord, hold, y, fs_, font, boxcol) {
  const N = words.length;
  const endAll = (t0 + N * perWord + hold).toFixed(2);
  let layers = [];
  for (let i = 0; i < N; i++) {
    const ti = (t0 + i * perWord).toFixed(2);
    const te = (i === N - 1) ? endAll : (t0 + (i + 1) * perWord).toFixed(2);
    const cum = words.slice(0, i + 1).join(' ').replace(/ \n /g, '\n').replace(/ \n/g, '\n').replace(/\n /g, '\n');
    const tf = txt(`rv-${Math.round(t0 * 100)}-${i}`, cum);
    layers.push(`drawtext=fontfile=${font}:textfile=${tf}:fontcolor=white:fontsize=${fs_}:line_spacing=14:x=(w-text_w)/2:y=${y}:box=1:boxcolor=${boxcol}@0.82:boxborderw=26:enable='between(t,${ti},${te})'`);
  }
  return { layers, endAll: parseFloat(endAll) };
}
const esc = s => s.replace(/:/g, '\\:').replace(/'/g, "’");

// tarjeta de cierre 3 s (bg soft, 2 líneas) -> archivo
function closingCard(W, H, out) {
  const l1 = txt('cl1', 'Calistenia asiática\npara mujeres de 40+');
  const l2 = txt('cl2', 'Haz el test de 1 minuto');
  const yMid = Math.round(H * 0.34);
  const arrowY = yMid + Math.round(H * 0.235);
  ff(['-f', 'lavfi', '-i', `color=c=${C.SOFT}:s=${W}x${H}:d=3:r=30`, '-i', ARROW,
    '-filter_complex', `[0:v]` + [
      `drawtext=fontfile=${C.FONT_BLACK}:textfile=${l1}:fontcolor=${C.PLUM}:fontsize=${Math.round(W * 0.066)}:line_spacing=12:x=(w-text_w)/2:y=${yMid}`,
      `drawtext=fontfile=${C.FONT_EXTRABOLD}:textfile=${l2}:fontcolor=${C.ACC}:fontsize=${Math.round(W * 0.05)}:x=(w-text_w)/2:y=${yMid + Math.round(H * 0.16)}:box=1:boxcolor=white@0.9:boxborderw=22`,
    ].join(',') + `[bg];[bg][1:v]overlay=(W-w)/2:${arrowY}[v]`,
    '-map', '[v]', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

function concat(parts, out) {
  const list = path.join(TMP, 'concat-' + path.basename(out) + '.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// ================= G1 · GRILLA =================
function buildG1(W, H, tag) {
  const cellW = Math.round(W / 2), cellH = Math.round(H / 3);
  const six = CLIPS.slice(0, 6).map((c, i) => norm(c, cellW, cellH, 12, path.join(TMP, `g1-${tag}-cell${i}.mp4`)));
  const labels = ['3x12', '3x10', '2x30 s', '3x15', '2x20', '3x8'];
  const pos = [[0, 0], [cellW, 0], [0, cellH], [cellW, cellH], [0, cellH * 2], [cellW, cellH * 2]];

  const P1 = revealLayers(['Cada', 'mañana,', '\n', '15', 'minutos.'], 0.3, 0.45, 1.6, Math.round(H * 0.40), Math.round(W * 0.085), C.FONT_BLACK, C.PLUM);
  const P2 = revealLayers(['Hasta', '\n', 'Año', 'Nuevo.'], 4.3, 0.5, 2.0, Math.round(H * 0.40), Math.round(W * 0.095), C.FONT_BLACK, C.ACC);
  const P3 = revealLayers(['Es', 'todo', 'lo', 'que', '\n', 'necesitas', 'para', '\n', 'empezar.'], 8.2, 0.33, 1.2, Math.round(H * 0.40), Math.round(W * 0.066), C.FONT_BLACK, C.PLUM);

  const labelDraw = pos.map((p, i) =>
    `drawtext=fontfile=${C.FONT_EXTRABOLD}:text='${labels[i]}':fontcolor=white:fontsize=${Math.round(W * 0.038)}:x=${p[0] + 20}:y=${p[1] + 18}:box=1:boxcolor=${C.ACC}:boxborderw=12`).join(',');

  const inputs = six.flatMap(c => ['-i', c]);
  const layout = pos.map(p => `${p[0]}_${p[1]}`).join('|');
  const fc = `[0:v][1:v][2:v][3:v][4:v][5:v]xstack=inputs=6:layout=${layout}[grid];` +
    `[grid]${labelDraw},${[...P1.layers, ...P2.layers, ...P3.layers].join(',')}[v]`;
  const grid = path.join(TMP, `g1-${tag}-grid.mp4`);
  ff([...inputs, '-filter_complex', fc, '-map', '[v]', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', grid]);

  const close = closingCard(W, H, path.join(TMP, `close-${tag}.mp4`));
  return concat([grid, close], path.join(OUT, `Hana-G1-grilla-${tag}.mp4`));
}

// ================= G2 · DAME 21 DÍAS =================
function buildG2(W, H, tag) {
  const bg = norm(CLIPS[6 % CLIPS.length] || CLIPS[0], W, H, 12, path.join(TMP, `g2-${tag}-bg.mp4`));
  const P1 = revealLayers(['Dame', '21', 'días.'], 0.3, 0.5, 2.2, Math.round(H * 0.38), Math.round(W * 0.13), C.FONT_BLACK, C.PLUM);
  const P2 = revealLayers(['15', 'minutos', 'al', 'día,', '\n', 'sin', 'saltos,', '\n', 'desde', 'tu', 'sala.'], 4.4, 0.3, 1.5, Math.round(H * 0.40), Math.round(W * 0.062), C.FONT_BLACK, C.PLUM);

  // calendario 21 casillas (7x3) que se tachan, 9s..12s
  const gw = 7, gh = 3, bs = Math.round(W * 0.085), gap = Math.round(W * 0.025);
  const totalW = gw * bs + (gw - 1) * gap;
  const x0 = Math.round((W - totalW) / 2), y0 = Math.round(H * 0.42);
  let cal = [];
  for (let i = 0; i < 21; i++) {
    const cx = x0 + (i % gw) * (bs + gap), cy = y0 + Math.floor(i / gw) * (bs + gap);
    cal.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=white@0.85:t=4:enable='gte(t,9)'`);
    const tt = (9 + i * 0.12).toFixed(2);
    cal.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=${C.ACC}:t=fill:enable='gte(t,${tt})'`);
  }
  const fc = `[0:v]${[...P1.layers, ...P2.layers, ...cal].join(',')}[v]`;
  const main = path.join(TMP, `g2-${tag}-main.mp4`);
  ff(['-i', bg, '-filter_complex', fc, '-map', '[v]', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', main]);
  const close = closingCard(W, H, path.join(TMP, `close2-${tag}.mp4`));
  return concat([main, close], path.join(OUT, `Hana-G2-21dias-${tag}.mp4`));
}

// ================= G3 · SIN GIMNASIO =================
function buildG3(W, H, tag) {
  const lines = ['Sin gimnasio', 'Sin saltos', 'Sin equipo', '15 minutos'];
  const segs = [];
  for (let i = 0; i < 4; i++) {
    const c = norm(CLIPS[(i + 2) % CLIPS.length], W, H, 1.5, path.join(TMP, `g3-${tag}-c${i}.mp4`));
    const tf = txt(`g3l-${tag}-${i}`, lines[i]);
    const o = path.join(TMP, `g3-${tag}-s${i}.mp4`);
    const ty = Math.round(H * 0.42);
    ff(['-i', c, '-i', CHECK, '-filter_complex',
      `[0:v]drawtext=fontfile=${C.FONT_BLACK}:textfile=${tf}:fontcolor=white:fontsize=${Math.round(W * 0.085)}:x=(w-text_w)/2:y=${ty}:box=1:boxcolor=${C.PLUM}@0.85:boxborderw=26[t];` +
      `[t][1:v]overlay=(W-w)/2:${ty - 170}[v]`,
      '-map', '[v]', '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', o]);
    segs.push(o);
  }
  // demo app en teléfono 3s
  const phone = path.join(TMP, `g3-${tag}-phone.mp4`);
  const pw = Math.round(W * 0.5), ph = Math.round(pw * 16 / 9);
  const bw = pw + 24, bh = ph + 24;
  const bx = Math.round((W - bw) / 2), by = Math.round((H - bh) / 2);
  const ox = Math.round((W - pw) / 2), oy = Math.round((H - ph) / 2);
  if (fs.existsSync(DEMO)) {
    ff(['-f', 'lavfi', '-i', `color=c=${C.SOFT}:s=${W}x${H}:d=3:r=30`, '-stream_loop', '-1', '-t', '3', '-i', DEMO,
      '-filter_complex', `[1:v]scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph},setsar=1[dm];` +
      `[0:v]drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${C.PLUM}:t=fill[bgp];` +
      `[bgp][dm]overlay=${ox}:${oy}[v]`,
      '-map', '[v]', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', phone]);
  } else {
    ff(['-f', 'lavfi', '-i', `color=c=${C.SOFT}:s=${W}x${H}:d=3:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', phone]);
  }
  const close = closingCard(W, H, path.join(TMP, `close3-${tag}.mp4`));
  return concat([...segs, phone, close], path.join(OUT, `Hana-G3-singimnasio-${tag}.mp4`));
}

// ---------- stills ----------
function stills(video, times) {
  const base = path.basename(video, '.mp4');
  const dir = path.join(TMP, 'stills'); fs.mkdirSync(dir, { recursive: true });
  const outs = [];
  times.forEach((t, i) => {
    const o = path.join(dir, `${base}-t${t}.png`);
    ff(['-ss', String(t), '-i', video, '-frames:v', '1', o]);
    outs.push(o);
  });
  return outs;
}

// ---------- run ----------
(async () => {
  await genAssets();
  const results = [];
  for (const [W, H, tag] of [[1080, 1920, '9x16'], [1080, 1350, '4x5']]) {
    results.push(buildG1(W, H, tag));
    results.push(buildG2(W, H, tag));
    results.push(buildG3(W, H, tag));
  }
  console.log('\nAnuncios:');
  results.forEach(r => console.log(' ', path.relative(ROOT, r)));
  ['Hana-G1-grilla-9x16', 'Hana-G2-21dias-9x16', 'Hana-G3-singimnasio-9x16'].forEach(n => {
    stills(path.join(OUT, n + '.mp4'), [1, 7, 13]);
  });
  console.log('stills en motor-anuncios/_adtmp/stills/');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
