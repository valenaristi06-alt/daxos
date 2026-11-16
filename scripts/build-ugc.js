// UGC de alta retención (presentadora IA) — storyboard por frase, calidad agencia.
// Escenas ancladas a tiempos de palabra (forced alignment). Overlays PNG (Playwright):
// subtítulos karaoke, stickers, checks, CTA, cierre. SFX + música ElevenLabs.
// Uso: node scripts/build-ugc.js A|B [9x16|4x5|both]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('./ff-config');

const ROOT = path.join(__dirname, '..');
const UGC = path.join(ROOT, 'motor-anuncios', 'ugc');
const SFXD = path.join(UGC, 'sfx');
const SCR = path.join(UGC, 'screens');
const OVD = path.join(ROOT, 'motor-anuncios', '_adtmp', 'ugc', 'ov');
const PEX = path.join(ROOT, 'motor-anuncios', 'stock', 'pexels');
const OUT = path.join(ROOT, 'anuncios');
const TMP = path.join(ROOT, 'motor-anuncios', '_adtmp', 'ugc');
const DEMO = path.join(ROOT, 'video', 'demo.mp4');
fs.mkdirSync(TMP, { recursive: true });

const ff = (args) => execFileSync(C.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const P = id => path.join(PEX, id + '.mp4');
const ov = f => path.join(OVD, f);
const BROLL = [[P('7531378'), 2], [P('7927851'), 3], [P('7531379'), 2], [P('8939152'), 1], [P('7531376'), 3]];

// ---------------- scene renderers (clip WxH, dur, sin audio) ----------------
function presenterSeg(input, W, H, s, dur, zoom, out) {
  const zw = Math.round(W * zoom), zh = Math.round(H * zoom);
  // sesgo de recorte hacia arriba en 4:5 para no cortar la cabeza (cara arriba-centro)
  const frac = (H / W < 1.4) ? 0.26 : 0.5;
  ff(['-ss', String(s), '-t', String(dur), '-i', input, '-an',
    '-vf', `scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*${frac},setsar=1,fps=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), out]);
  return out;
}
function brollSeg(clip, W, H, dur, out) {
  ff(['-ss', String(clip[1]), '-stream_loop', '-1', '-t', String(dur), '-i', clip[0], '-an',
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), out]);
  return out;
}
// grilla 3x3 de B-roll (flash)
function gridSeg(W, H, dur, out) {
  const cw = Math.round(W / 3), ch = Math.round(H / 3);
  const cells = [];
  for (let i = 0; i < 9; i++) { const c = BROLL[i % BROLL.length]; const o = path.join(TMP, `g-${i}-${W}.mp4`); brollSeg([c[0], c[1] + (i % 3)], cw, ch, dur, o); cells.push(o); }
  const pos = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) pos.push(`${c * cw}_${r * ch}`);
  const inputs = cells.flatMap(c => ['-i', c]);
  const labels = ['3x12', '2x15', '3x10', '2x30', '3x8', '2x20', '3x15', '2x12', '15m'];
  const lab = pos.map((p, i) => { const [x, y] = p.split('_'); return `drawtext=fontfile=${C.FONT_EXTRABOLD}:text='${labels[i]}':fontcolor=white:fontsize=${Math.round(W * 0.028)}:x=${+x + 12}:y=${+y + 10}:box=1:boxcolor=${C.ACC}:boxborderw=7`; }).join(',');
  const fc = cells.map((_, i) => `[${i}:v]`).join('') + `xstack=inputs=9:layout=${pos.join('|')}[g];[g]${lab}[v]`;
  ff([...inputs, '-filter_complex', fc, '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
// split: presentadora arriba, B-roll abajo
function splitSeg(input, W, H, s, dur, clip, out) {
  const half = Math.round(H / 2);
  const top = presenterSeg(input, W, half, s, dur, 1.0, path.join(TMP, `sp-top-${W}.mp4`));
  const bot = brollSeg(clip, W, H - half, dur, path.join(TMP, `sp-bot-${W}.mp4`));
  ff(['-i', top, '-i', bot, '-filter_complex', `[0:v][1:v]vstack=inputs=2[v]`, '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
// teléfono con captura estática (quiz) o demo.mp4; toque opcional
function phoneSeg(W, H, dur, screenPng, useDemo, tap, out) {
  const pw = Math.round(W * 0.52), ph = Math.round(pw * 2436 / 1125); // ratio iPhone
  const phH = Math.min(ph, Math.round(H * 0.82));
  const pw2 = Math.round(phH * 1125 / 2436);
  const bw = pw2 + 24, bh = phH + 24;
  const bx = Math.round((W - bw) / 2), by = Math.round((H - bh) / 2);
  const ox = Math.round((W - pw2) / 2), oy = Math.round((H - phH) / 2);
  const inner = useDemo ? DEMO : screenPng;
  const srcArgs = useDemo ? ['-stream_loop', '-1', '-t', String(dur), '-i', inner] : ['-loop', '1', '-t', String(dur), '-i', inner];
  const tapRing = tap ? `,drawbox=x=${ox + Math.round(pw2 * 0.5) - 60}:y=${oy + Math.round(phH * 0.55)}:w=120:h=120:color=white@0.0:t=fill` : '';
  ff(['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${C.SOFT}:s=${W}x${H}:r=30`, ...srcArgs,
    '-filter_complex', `[1:v]scale=${pw2}:${phH}:force_original_aspect_ratio=increase,crop=${pw2}:${phH},setsar=1,fps=30[ph];` +
    `[0:v]drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${C.PLUM}:t=fill[bg];[bg][ph]overlay=${ox}:${oy}${tapRing}[v]`,
    '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
// tarjeta "versión fácil" (png) con slow pan sobre soft bg
function cardSeg(W, H, dur, out) {
  const cardPng = path.join(SCR, 'card-facil.png');
  const cw = Math.round(W * 0.84);
  ff(['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${C.SOFT}:s=${W}x${H}:r=30`, '-loop', '1', '-t', String(dur), '-i', cardPng,
    '-filter_complex', `[1:v]scale=${cw}:-1,fps=30[c];[0:v][c]overlay=(W-w)/2:'(H-h)/2 - 60 + 120*t/${dur}'[v]`,
    '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
// calendario de 21 casillas que se tachan (B)
function calendarSeg(W, H, dur, out) {
  const gw = 7, gh = 3, bs = Math.round(W * 0.10), gap = Math.round(W * 0.025);
  const totalW = gw * bs + (gw - 1) * gap, x0 = Math.round((W - totalW) / 2), y0 = Math.round(H * 0.40);
  let boxes = [];
  for (let i = 0; i < 21; i++) {
    const cx = x0 + (i % gw) * (bs + gap), cy = y0 + Math.floor(i / gw) * (bs + gap);
    boxes.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=white@0.9:t=5`);
    const tt = (i * (dur * 0.9 / 21)).toFixed(2);
    boxes.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=${C.ACC}:t=fill:enable='gte(t,${tt})'`);
  }
  ff(['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${C.SOFT}:s=${W}x${H}:r=30`,
    '-vf', boxes.join(','), '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// ---------------- storyboards ----------------
function findTime(words, anchor, afterTime) {
  for (let i = 0; i < words.length; i++) {
    if (words[i].start >= afterTime - 0.001 && words[i].word.toLowerCase().replace(/[.,:;!?]/g, '') === anchor.toLowerCase()) return words[i].start;
  }
  return null;
}
function sceneList(VARIANT, words, s0) {
  const raw = VARIANT === 'A' ? [
    { anchor: null, type: 'face', zoom: 1.0 },
    { anchor: 'prueba', type: 'grid' },
    { anchor: 'se', type: 'face', zoom: 1.12, sticker: 'stk-calistenia.png' },
    { anchor: 'movimientos', type: 'broll', clip: 0 },
    { anchor: 'sin', type: 'broll', clip: 1, checks: ['chk-saltos.png', 'chk-equipo.png'] },
    { anchor: 'son', type: 'split', clip: 3, sticker: 'stk-15min.png' },
    { anchor: 'haces', type: 'phone', screen: 'quiz-edad.png', tap: true },
    { anchor: 'y', type: 'phone', screen: 'plan-21.png' },
    { anchor: 'y', type: 'card' },
    { anchor: 'el', type: 'facecta', zoom: 1.0 },
  ] : [
    { anchor: null, type: 'face', zoom: 1.0, sticker: 'stk-anionuevo.png' },
    { anchor: 'empieza', type: 'calendar' },
    { anchor: 'son', type: 'grid' },
    { anchor: 'quince', type: 'broll', clip: 0, sticker: 'stk-singim.png' },
    { anchor: 'respondes', type: 'phone', screen: 'quiz-zonas.png', tap: true },
    { anchor: 'y', type: 'phone', screen: 'plan-21.png' },
    { anchor: 'haz', type: 'facecta', zoom: 1.0 },
  ];
  // resolver tiempos (búsqueda secuencial)
  let after = 0; const scenes = [];
  for (const sc of raw) {
    let t = sc.anchor ? findTime(words, sc.anchor, after + 0.01) : s0;
    if (t == null) t = after + 0.3;
    scenes.push({ ...sc, t });
    after = t;
  }
  return scenes;
}

// ---------------- build ----------------
function buildOne(W, H, tag, VARIANT, input, words, s0, bodyDur) {
  const scenes = sceneList(VARIANT, words, s0);
  // render cada escena
  const segs = []; const cuts = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const start = sc.t, end = (i < scenes.length - 1 ? scenes[i + 1].t : s0 + bodyDur);
    const dur = +(end - start).toFixed(3);
    const o = path.join(TMP, `sc-${tag}-${i}.mp4`);
    if (sc.type === 'face' || sc.type === 'facecta') presenterSeg(input, W, H, start, dur, sc.zoom || 1.0, o);
    else if (sc.type === 'broll') brollSeg(BROLL[sc.clip], W, H, dur, o);
    else if (sc.type === 'grid') gridSeg(W, H, dur, o);
    else if (sc.type === 'split') splitSeg(input, W, H, start, dur, BROLL[sc.clip], o);
    else if (sc.type === 'phone') phoneSeg(W, H, dur, sc.screen ? path.join(SCR, sc.screen) : null, !!sc.demo, !!sc.tap, o);
    else if (sc.type === 'card') cardSeg(W, H, dur, o);
    else if (sc.type === 'calendar') calendarSeg(W, H, dur, o);
    segs.push(o);
    if (i > 0) cuts.push({ t: +(start - s0).toFixed(2), type: sc.type });
  }
  const list = path.join(TMP, `body-${tag}-list.txt`);
  fs.writeFileSync(list, segs.map(p => `file '${p}'`).join('\n'));
  const body = path.join(TMP, `body-${tag}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', body]);

  // ---- overlays pass (barra, marca, top, stickers/checks/cta, captions) ----
  const capY = tag === '9x16' ? 800 : 560;
  const manifest = JSON.parse(fs.readFileSync(ov(`cap-${VARIANT}-manifest.json`), 'utf8'));
  const inputs = ['-i', body]; let ix = 1;
  const overlays = []; // {idx,x,y,a,b}
  const add = (png, x, y, a, b) => { inputs.push('-i', ov(png)); overlays.push({ idx: ix, x, y, a, b }); ix++; };
  // top (0..2.5)
  add(`top-${VARIANT}.png`, '(W-w)/2', Math.round(H * 0.06), 0, 2.5);
  // stickers/checks/cta por escena
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i]; const a = +(sc.t - s0).toFixed(2); const b = +((i < scenes.length - 1 ? scenes[i + 1].t : s0 + bodyDur) - s0).toFixed(2);
    if (sc.sticker) add(sc.sticker, '(W-w)/2', Math.round(H * 0.28), a + 0.05, b);
    if (sc.checks) { const mid = (a + b) / 2; add(sc.checks[0], '(W-w)/2', Math.round(H * 0.30), a + 0.1, mid); add(sc.checks[1], '(W-w)/2', Math.round(H * 0.30), mid, b); }
    if (sc.type === 'facecta') { add('cta.png', '(W-w)/2', Math.round(H * 0.72), a + 0.1, b); }
  }
  // captions (una por palabra)
  manifest.forEach(m => add(m.png, '(W-w)/2', capY, m.a, m.b));

  // filtro
  const barH = 10;
  let fc = `[0:v]drawbox=x=0:y=0:w='${W}*min(1,t/${bodyDur})':h=${barH}:color=${C.ACC}:t=fill,` +
    `drawtext=fontfile=${C.FONT_SEMIBOLD}:text='Presentadora generada con IA':fontcolor=white@0.6:fontsize=${Math.round(W * 0.022)}:x=22:y=${H - Math.round(H * 0.03)}:box=1:boxcolor=black@0.25:boxborderw=7[b0];`;
  let prev = 'b0';
  overlays.forEach((o, k) => { const nl = `v${k}`; fc += `[${prev}][${o.idx}:v]overlay=${o.x}:${o.y}:enable='between(t,${o.a},${o.b})'[${nl}];`; prev = nl; });
  fc = fc.replace(/;$/, '');
  const bodyfx = path.join(TMP, `bodyfx-${tag}.mp4`);
  ff([...inputs, '-filter_complex', fc, '-map', `[${prev}]`, '-t', String(bodyDur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bodyfx]);

  // ---- cierre 2.5s ----
  const close = path.join(TMP, `close-${tag}.mp4`);
  ff(['-loop', '1', '-t', '2.5', '-i', ov(`close-${tag}.png`),
    '-vf', `fps=30,setsar=1`, '-t', '2.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', close]);

  // ---- audio: voz + sfx + música ----
  const voice = path.join(TMP, `voice-${tag}.m4a`);
  ff(['-ss', String(s0), '-t', String(bodyDur), '-i', input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'aac', voice]);
  const sfxFor = t => t === 'grid' || t === 'broll' || t === 'split' || t === 'phone' || t === 'calendar' ? 'swoosh.mp3' : (t === 'facecta' ? 'ding.mp3' : 'pop.mp3');
  const ain = ['-i', voice, '-stream_loop', '-1', '-i', path.join(UGC, 'music.mp3')];
  let aidx = 2; const parts = ['[0:a]volume=1.0[vz]']; const mixL = ['[vz]'];
  parts.push(`[1:a]volume=0.1,atrim=0:${(bodyDur + 2.5).toFixed(2)}[mus]`); mixL.push('[mus]');
  cuts.forEach((c, i) => { const f = path.join(SFXD, sfxFor(c.type)); if (!fs.existsSync(f)) return; ain.push('-i', f); parts.push(`[${aidx}:a]adelay=${Math.round(c.t * 1000)}|${Math.round(c.t * 1000)},volume=0.35[s${i}]`); mixL.push(`[s${i}]`); aidx++; });
  // ding en cierre
  ain.push('-i', path.join(SFXD, 'ding.mp3')); parts.push(`[${aidx}:a]adelay=${Math.round(bodyDur * 1000)}|${Math.round(bodyDur * 1000)},volume=0.4[sc]`); mixL.push('[sc]');
  const afc = parts.join(';') + `;${mixL.join('')}amix=inputs=${mixL.length}:normalize=0:dropout_transition=0[a]`;
  const audio = path.join(TMP, `audio-${tag}.m4a`);
  ff([...ain, '-filter_complex', afc, '-map', '[a]', '-t', String(bodyDur + 2.5), '-c:a', 'aac', '-b:a', '160k', audio]);

  // ---- ensamble ----
  const vlist = path.join(TMP, `full-${tag}.txt`);
  fs.writeFileSync(vlist, `file '${bodyfx}'\nfile '${close}'`);
  const vid = path.join(TMP, `vid-${tag}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', vlist, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid]);
  const outFile = path.join(OUT, `Hana-UGC-${VARIANT}-${tag}.mp4`);
  ff(['-i', vid, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', outFile]);
  return { outFile, dur: +(bodyDur + 2.5).toFixed(1) };
}

// ---------------- run ----------------
const VARIANT = (process.argv[2] || 'A').toUpperCase();
const RATWANT = process.argv[3] || 'both';
const RATIOS = RATWANT === 'both' ? [[1080, 1920, '9x16'], [1080, 1350, '4x5']] : (RATWANT === '4x5' ? [[1080, 1350, '4x5']] : [[1080, 1920, '9x16']]);
const INPUT = path.join(UGC, `guion-${VARIANT}.mp4`);
const RAW = path.join(UGC, `words-${VARIANT}-align.json`);

(async () => {
  const words = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const s0 = Math.max(0, words[0].start - 0.04);
  const bodyDur = +(words[words.length - 1].end + 0.25 - s0).toFixed(2);
  const results = [];
  for (const [W, H, tag] of RATIOS) results.push(buildOne(W, H, tag, VARIANT, INPUT, words, s0, bodyDur));
  console.log('\nSalidas:'); results.forEach(r => console.log('  ' + path.relative(ROOT, r.outFile) + '  (' + r.dur + 's)'));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
