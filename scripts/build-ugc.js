// UGC alta retención (presentadora IA) — v4 calidad agencia.
// Reencuadre por cara (OpenCV), subtítulos/stickers bajo el mentón (nunca sobre la cara),
// jump-cuts físicos con corte v+a JUNTO (frame-aligned, afade 10ms), teléfono entero + PiP de cara,
// SFX + música, loudnorm -14 LUFS. Fuente CFR 30.
// Uso: node scripts/build-ugc.js A|B [9x16|4x5|both]
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const C = require('./ff-config');

const ROOT = path.join(__dirname, '..');
const UGC = path.join(ROOT, 'motor-anuncios', 'ugc');
const SFXD = path.join(UGC, 'sfx');
const SCR = path.join(UGC, 'screens');
const OVD = path.join(ROOT, 'motor-anuncios', '_adtmp', 'ugc', 'ov');
const PEX = path.join(ROOT, 'motor-anuncios', 'stock', 'pexels');
const OUT = path.join(ROOT, 'anuncios');
const TMP = path.join(ROOT, 'motor-anuncios', '_adtmp', 'ugc');
const ASSET = path.join(TMP, 'assets'); fs.mkdirSync(ASSET, { recursive: true });

const ff = (args) => { try { return execFileSync(C.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { throw new Error('ffmpeg: ' + ((e.stderr || '') + '').split('\n').filter(Boolean).slice(-4).join(' | ')); } };
const ffCap = (args) => { const r = spawnSync(C.FFMPEG, ['-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }); return (r.stdout || '') + (r.stderr || ''); };
const P = id => path.join(PEX, id + '.mp4');
const ov = f => path.join(OVD, f);
const fr = t => Math.round(t * 30) / 30; // redondeo a borde de cuadro (30fps)
const BROLL = [[P('7531376'), 2], [P('7531378'), 2], [P('7531379'), 2], [P('8939152'), 1]];
const SRCW = 704, SRCH = 1280;

const TRI = path.join(ASSET, 'tri.png');
const RING = path.join(ASSET, 'ring.png');
async function genAssets() {
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="130"><path d="M10 18 H140 L75 118 Z" fill="#c2456a"/></svg>`)).png().toFile(TRI);
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><circle cx="150" cy="150" r="144" fill="none" stroke="#fff" stroke-width="12"/></svg>`)).png().toFile(RING);
}

// ---------------- layout por relación ----------------
const LAYOUT = {
  // stkYov = debajo del subtítulo (sticker nunca toca la cara). topYov = tira fina arriba.
  '9x16': { W: 1080, H: 1920, eyes: 450, capYov: 1000, stkYov: 1250, topYov: 12 },
  '4x5': { W: 1080, H: 1350, eyes: 380, capYov: 745, stkYov: 1060, topYov: 10, skipTop: true },
};

// reencuadre: escala ancho a W*zoom; recorta para ojos en L.eyes y cara centrada (dentro de límites)
function reframeVf(L, zoom, face) {
  const s = (L.W / SRCW) * zoom;
  const sw = Math.round(SRCW * s), sh = Math.round(SRCH * s);
  const eyesSrcY = face.y + 0.42 * face.h;
  const cropY = Math.max(0, Math.min(sh - L.H, Math.round(eyesSrcY * s - L.eyes)));
  const faceCX = (face.x + face.w / 2) * s;
  const cropX = Math.max(0, Math.min(sw - L.W, Math.round(faceCX - L.W / 2)));
  return { vf: `scale=${sw}:${sh},crop=${L.W}:${L.H}:${cropX}:${cropY},setsar=1,fps=30`, s, cropX, cropY };
}
// caja de la cara en el frame reencuadrado (para PiP y verificación)
function faceBoxTarget(L, zoom, face) {
  const { s, cropX, cropY } = reframeVf(L, zoom, face);
  return { x: Math.round(face.x * s - cropX), y: Math.round(face.y * s - cropY), w: Math.round(face.w * s), h: Math.round(face.h * s) };
}

// ---------------- retiming (jump cuts, frame-aligned) ----------------
// Default: SIN recorte de silencios (voz con ritmo natural) -> 0 palabras cortadas garantizado
// y lip-sync perfecto. UGC_NO_CUTS=0 reactiva el recorte en huecos > 0.35 s (experimental).
const NO_CUTS = process.env.UGC_NO_CUTS !== '0';
function buildRuns(words) {
  const GAP = NO_CUTS ? 1e9 : 0.35, PAD = 0.12, n = words.length; const segs = []; let si = 0;
  for (let k = 0; k < n; k++) { const gap = (k < n - 1) ? words[k + 1].start - words[k].end : Infinity; if (gap > GAP) { segs.push([si, k]); si = k + 1; } }
  const runs = []; let acc = 0;
  segs.forEach(([a, b], i) => {
    const srcStart = fr(Math.max(0, words[a].start - PAD));
    const srcEnd = fr(words[b].end + PAD);
    const len = +(srcEnd - srcStart).toFixed(3);
    runs.push({ srcStart, srcEnd, len, newStart: +acc.toFixed(3), zoom: i % 2 === 0 ? 1.0 : 1.12, a, b });
    acc += len;
  });
  const newT = words.map(() => null);
  runs.forEach(r => { for (let k = r.a; k <= r.b; k++) newT[k] = +(r.newStart + (words[k].start - r.srcStart)).toFixed(3); });
  return { runs, bodyDur: +acc.toFixed(3), newT };
}

// ---------------- scene renderers ----------------
function brollSeg(clip, W, H, dur, out) {
  ff(['-ss', String(clip[1]), '-stream_loop', '-1', '-t', String(dur), '-i', clip[0], '-an',
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), out]);
  return out;
}
function gridSeg(W, H, dur, out) {
  const cw = Math.round(W / 3), ch = Math.round(H / 3), cells = [];
  for (let i = 0; i < 9; i++) { const c = BROLL[i % BROLL.length]; const o = path.join(TMP, `grd-${i}-${W}.mp4`); brollSeg([c[0], c[1] + (i % 3)], cw, ch, dur, o); cells.push(o); }
  const pos = []; for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) pos.push(`${cc * cw}_${r * ch}`);
  const labels = ['3x12', '2x15', '3x10', '2x30', '3x8', '2x20', '3x15', '2x12', '15m'];
  const lab = pos.map((p, i) => { const [x, y] = p.split('_'); return `drawtext=fontfile=${C.FONT_EXTRABOLD}:text='${labels[i]}':fontcolor=white:fontsize=${Math.round(W * 0.028)}:x=${+x + 12}:y=${+y + 10}:box=1:boxcolor=${C.ACC}:boxborderw=7`; }).join(',');
  const fc = cells.map((_, i) => `[${i}:v]`).join('') + `xstack=inputs=9:layout=${pos.join('|')}[g];[g]${lab}[v]`;
  ff([...cells.flatMap(c => ['-i', c]), '-filter_complex', fc, '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
function splitSeg(presV, W, H, startNew, dur, clip, out) {
  const half = Math.round(H / 2);
  const top = path.join(TMP, `sp-top-${W}.mp4`);
  ff(['-ss', String(startNew), '-t', String(dur), '-i', presV, '-an', '-vf', `crop=${W}:${half}:0:0,setsar=1,fps=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), top]);
  const bot = brollSeg(clip, W, H - half, dur, path.join(TMP, `sp-bot-${W}.mp4`));
  ff(['-i', top, '-i', bot, '-filter_complex', `[0:v][1:v]vstack=inputs=2[v]`, '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
// teléfono ENTERO centrado; scroll/pan DENTRO de la pantalla (el marco no se mueve).
// opts.fit = muestra la captura COMPLETA (sin recortar los costados) centrada.
function phoneSeg(W, H, dur, screenPng, opts, out) {
  opts = opts || {};
  const bh = Math.round(H * 0.82), pw = 2 * Math.round(bh * 0.462 / 2), bw = pw + 22;
  const bx = Math.round((W - bw) / 2), by = Math.round((H - bh) / 2), ox = bx + 11, oy = by + 11, phH = bh - 22;
  let scr, hl;
  if (opts.fit) {
    // tarjeta completa: cabe entera por ancho; resalta el renglón "Versión más fácil" (abajo)
    const cardW = 1164, cardH = 981, chf = Math.round(pw * cardH / cardW), cardTop = oy + Math.round((phH - chf) / 2);
    scr = `[1:v]scale=${pw}:${phH}:force_original_aspect_ratio=decrease,pad=${pw}:${phH}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=30[scr]`;
    hl = `[p]drawbox=x=${ox + 6}:y=${cardTop + Math.round(chf * 0.86)}:w=${pw - 12}:h=${Math.round(chf * 0.11)}:color=${C.ACC}@0.33:t=fill[p2]`;
  } else {
    const sc = 1.14, sw = Math.round(pw * sc), sh = Math.round(phH * sc);
    const yexpr = `(ih-${phH})*min(1\\,t/${dur})*0.85`;
    scr = `[1:v]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${pw}:${phH}:(iw-${pw})/2:'${yexpr}',setsar=1,fps=30[scr]`;
    hl = `[p]null[p2]`;
  }
  const tapX = ox + Math.round(pw * 0.5), tapY = oy + Math.round(phH * 0.45);
  const tapEnable = opts.tap ? `lt(mod(t\\,1.4)\\,0.5)` : '0';
  ff(['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${C.SOFT}:s=${W}x${H}:r=30`, '-loop', '1', '-t', String(dur), '-i', screenPng, '-i', RING,
    '-filter_complex',
    `${scr};[2:v]scale=140:140[rg];` +
    `[0:v]drawbox=x=${bx - 3}:y=${by - 3}:w=${bw + 6}:h=${bh + 6}:color=black@0.18:t=fill,drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${C.PLUM}:t=fill[bg];` +
    `[bg][scr]overlay=${ox}:${oy}[p];${hl};` +
    `[p2][rg]overlay=${tapX - 70}:${tapY - 70}:enable='${tapEnable}'[v]`,
    '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return { out, bx, by, bw, bh };
}
// casillas DEBAJO del subtítulo (capYov), título arriba (no se superponen)
function calendarSeg(W, H, dur, capYov, out) {
  const gw = 7, bs = Math.round(W * 0.088), gap = Math.round(W * 0.024), totalW = gw * bs + (gw - 1) * gap;
  const x0 = Math.round((W - totalW) / 2), y0 = capYov + 235; // debajo de la banda del subtítulo (~+210)
  let boxes = [`drawtext=fontfile=${C.FONT_BLACK}:text='21 DÍAS':fontcolor=${C.PLUM}:fontsize=${Math.round(W * 0.095)}:x=(w-text_w)/2:y=${Math.round(H * 0.26)}`];
  for (let i = 0; i < 21; i++) {
    const cx = x0 + (i % gw) * (bs + gap), cy = y0 + Math.floor(i / gw) * (bs + gap);
    boxes.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=white@0.95:t=6`);
    boxes.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=${C.ACC}:t=fill:enable='gte(t,${(0.2 + i * (dur * 0.85 / 21)).toFixed(2)})'`);
  }
  ff(['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${C.SOFT}:s=${W}x${H}:r=30`, '-vf', boxes.join(','), '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// ---------------- storyboard ----------------
function findTime(words, newT, anchor, after) {
  for (let i = 0; i < words.length; i++) if (newT[i] != null && newT[i] >= after - 0.001 && words[i].word.toLowerCase().replace(/[.,:;!?]/g, '') === anchor.toLowerCase()) return newT[i];
  return null;
}
function sceneList(VARIANT, words, newT) {
  const raw = VARIANT === 'A' ? [
    { anchor: null, type: 'face' }, { anchor: 'prueba', type: 'grid' },
    { anchor: 'se', type: 'face', sticker: 'stk-calistenia.png' }, { anchor: 'movimientos', type: 'broll', clip: 0 },
    { anchor: 'sin', type: 'broll', clip: 1, checks: ['chk-saltos.png', 'chk-equipo.png'] },
    { anchor: 'son', type: 'split', clip: 2, sticker: 'stk-15min.png' },
    { anchor: 'haces', type: 'phone', screen: 'quiz-edad.png', tap: true, pip: true },
    { anchor: 'y', type: 'phone', screen: 'plan-21.png', pip: true },
    { anchor: 'y', type: 'phone', screen: 'card-facil.png', fit: true, highlight: true, pip: true },
    { anchor: 'el', type: 'facecta' },
  ] : [
    { anchor: null, type: 'face', sticker: 'stk-anionuevo.png' }, { anchor: 'empieza', type: 'calendar' },
    { anchor: 'son', type: 'grid' }, { anchor: 'quince', type: 'broll', clip: 0, sticker: 'stk-singim.png' },
    { anchor: 'respondes', type: 'phone', screen: 'quiz-zonas.png', tap: true, pip: true },
    { anchor: 'y', type: 'phone', screen: 'plan-21.png', pip: true }, { anchor: 'haz', type: 'facecta' },
  ];
  let after = 0; const scenes = [];
  for (const sc of raw) { let t = sc.anchor ? findTime(words, newT, sc.anchor, after + 0.01) : 0; if (t == null) t = after + 0.3; scenes.push({ ...sc, t }); after = t; }
  return scenes;
}

// ---------------- build ----------------
function buildOne(tag, VARIANT, input, words, meta, faceMed) {
  const L = LAYOUT[tag], W = L.W, H = L.H;
  const { runs, bodyDur, newT } = meta;
  const scenes = sceneList(VARIANT, words, newT);

  // 1) PRES: corte v+a por run con MISMO srcStart/len (locked, frame-aligned).
  //    Video reencuadrado (sin audio) + audio PCM por run (afade 30ms) -> sin delay de AAC.
  const runVids = runs.map((r, i) => {
    const o = path.join(TMP, `run-${tag}-${i}.mp4`);
    const { vf } = reframeVf(L, r.zoom, faceMed);
    ff(['-i', input, '-ss', String(r.srcStart), '-t', String(r.len), '-an', '-vf', vf,
      '-r', '30', '-vsync', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(r.len), o]);
    return o;
  });
  const runAuds = runs.map((r, i) => {
    // 1) extracción limpia (sin filtro: con -ss después de -i, un afade mal puesto silencia el run)
    const raw = path.join(TMP, `raw-${tag}-${i}.wav`);
    ff(['-i', input, '-ss', String(r.srcStart), '-t', String(r.len), '-vn', '-ac', '2', '-ar', '44100', '-t', String(r.len), raw]);
    // 2) afade 30ms sobre el wav limpio (PTS ya en 0 -> el afade funciona bien)
    const o = path.join(TMP, `rau-${tag}-${i}.wav`);
    ff(['-i', raw, '-af', `afade=t=in:st=0:d=0.03,afade=t=out:st=${Math.max(0, r.len - 0.03).toFixed(3)}:d=0.03`, '-ac', '2', '-ar', '44100', o]);
    return o;
  });
  const vlist = path.join(TMP, `presV-${tag}.txt`); fs.writeFileSync(vlist, runVids.map(p => `file '${p}'`).join('\n'));
  const presV = path.join(TMP, `presV-${tag}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', vlist, '-c:v', 'copy', presV]);
  const alist = path.join(TMP, `presA-${VARIANT}-${tag}.txt`); fs.writeFileSync(alist, runAuds.map(p => `file '${p}'`).join('\n'));
  const presA = path.join(TMP, `presA-${VARIANT}-${tag}.wav`);
  ff(['-f', 'concat', '-safe', '0', '-i', alist, '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', presA]);

  // 2) escenas no-face -> override + PiP (centrado en la cara) en teléfonos
  const nonface = []; const cuts = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i]; const start = sc.t, end = (i < scenes.length - 1 ? scenes[i + 1].t : bodyDur), dur = +(end - start).toFixed(3);
    sc._start = start; sc._end = end; sc._dur = dur;
    if (i > 0) cuts.push({ t: start, type: sc.type });
    if (sc.type === 'face' || sc.type === 'facecta') continue;
    const o = path.join(TMP, `sc-${tag}-${i}.mp4`);
    const rdur = dur + 0.2; // clip más largo para cubrir el borde (sin frame negro)
    if (sc.type === 'broll') brollSeg(BROLL[sc.clip], W, H, rdur, o);
    else if (sc.type === 'grid') gridSeg(W, H, rdur, o);
    else if (sc.type === 'split') splitSeg(presV, W, H, start, rdur, BROLL[sc.clip], o);
    else if (sc.type === 'phone') { const r = phoneSeg(W, H, rdur, path.join(SCR, sc.screen), { tap: sc.tap, fit: sc.fit, highlight: sc.highlight }, o); sc._phone = r; }
    else if (sc.type === 'calendar') calendarSeg(W, H, rdur, L.capYov, o);
    sc._clip = o; nonface.push(sc);
  }
  // PiP: recorte cuadrado centrado en la cara (reencuadre zoom=1), cara ~62% del círculo
  const fb = faceBoxTarget(L, 1.0, faceMed);
  const side = Math.round(fb.h / 0.62);
  const sqx = Math.round(fb.x + fb.w / 2 - side / 2), sqy = Math.round(fb.y + fb.h / 2 - side / 2);
  const PIP = 220, cc = PIP / 2, rr2 = (PIP / 2 - 6) ** 2;
  // posición PiP: abajo-derecha sobre el borde del teléfono
  const anyPhone = nonface.find(s => s._phone);
  const pbx = anyPhone ? anyPhone._phone.bx : Math.round(W * 0.75), pby = anyPhone ? anyPhone._phone.by : 0, pbw = anyPhone ? anyPhone._phone.bw : 0, pbh = anyPhone ? anyPhone._phone.bh : H;
  const px = Math.min(W - PIP - 20, pbx + pbw - Math.round(PIP * 0.55));
  const py = Math.min(H - PIP - 30, pby + pbh - PIP + 15); // más abajo: separa del subtítulo

  const inputs = ['-i', presV]; let ix = 1;
  nonface.forEach(sc => { inputs.push('-i', sc._clip); sc._ix = ix++; });
  inputs.push('-i', RING); const ringIx = ix++;
  let fc = `[0:v]split=2[base][pf];` +
    `[pf]crop=${side}:${side}:${Math.max(0, sqx)}:${Math.max(0, sqy)},scale=${PIP}:${PIP},format=rgba,` +
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt((X-${cc})*(X-${cc})+(Y-${cc})*(Y-${cc}),${rr2}),0,255)'[pipc];[${ringIx}:v]scale=${PIP}:${PIP}[rng];`;
  let cur = 'base';
  nonface.forEach((sc, k) => { const s0 = Math.max(0, sc._start - 0.05); fc += `[${sc._ix}:v]tpad=start_duration=${s0.toFixed(3)}:color=0x000000,setpts=PTS-STARTPTS[d${k}];[${cur}][d${k}]overlay=0:0:enable='between(t,${s0.toFixed(2)},${sc._end.toFixed(2)})'[n${k}];`; cur = `n${k}`; });
  const pipSpans = nonface.filter(s => s.pip).map(s => `between(t,${s._start.toFixed(2)},${s._end.toFixed(2)})`).join('+') || '0';
  fc += `[${cur}][pipc]overlay=${px}:${py}:enable='${pipSpans}'[wp];[wp][rng]overlay=${px}:${py}:enable='${pipSpans}'[v]`;
  const vScenes = path.join(TMP, `vsc-${tag}.mp4`);
  ff([...inputs, '-filter_complex', fc, '-map', '[v]', '-t', String(bodyDur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vScenes]);

  // 3) elementos + subtítulos
  const manifest = JSON.parse(fs.readFileSync(ov(`cap-${VARIANT}-manifest.json`), 'utf8'));
  const ein = ['-i', vScenes]; let ei = 1; const els = []; const rects = [];
  // band = filas visibles de texto dentro del png; onFace = puede caer sobre la cara (se verifica)
  const addEl = (png, yov, a, b, band, onFace, tag) => { ein.push('-i', ov(png)); els.push({ ix: ei++, x: '(W-w)/2', y: yov, a, b }); if (onFace) rects.push({ a: +a.toFixed(2), b: +b.toFixed(2), y0: yov + band[0], y1: yov + band[1], tag: tag || 'other' }); };
  // texto superior: tira fina arriba (no toca la cara). En 4:5 (angosto) se omite.
  if (!L.skipTop) addEl(`top-${VARIANT}.png`, L.topYov, 0, 2.5, [15, 110], true, 'top');
  // botón CTA: debajo del subtítulo (>=40 px entre borde inferior del subtítulo y borde superior del botón)
  const ctaYov = L.capYov + 200;
  scenes.forEach((sc) => {
    const a = sc._start, b = sc._end;
    if (sc.sticker) addEl(sc.sticker, L.stkYov, a + 0.05, b, [55, 185], true, 'stk');
    if (sc.checks) { const mid = (a + b) / 2; addEl(sc.checks[0], L.stkYov, a + 0.1, mid, [55, 185], false); addEl(sc.checks[1], L.stkYov, mid, b, [55, 185], false); }
    if (sc.type === 'facecta') addEl('cta.png', ctaYov, a + 0.1, b, [55, 205], true, 'cta');
  });
  manifest.forEach(m => { const a = newT[m.wi]; const b = (m.wi < words.length - 1 && newT[m.wi + 1] != null) ? newT[m.wi + 1] : bodyDur; addEl(m.png, L.capYov, +a.toFixed(2), +b.toFixed(2), [90, 210], true, 'cap'); });
  // inset 0.08s: excluye los bordes donde la escena vecina entra 1-2 cuadros antes
  const faceSpans = scenes.filter(s => s.type === 'face' || s.type === 'facecta').map(s => [+(s._start + 0.08).toFixed(2), +(s._end - 0.08).toFixed(2)]);
  const pipSpansArr = nonface.filter(s => s.pip).map(s => [+(s._start + 0.08).toFixed(2), +(s._end - 0.08).toFixed(2)]);
  fs.writeFileSync(path.join(TMP, `layout-${VARIANT}-${tag}.json`), JSON.stringify({ W, H, bodyDur, rects, faceSpans, pipSpans: pipSpansArr, pip: { x: px, y: py, size: PIP } }, null, 2));
  let efc = `[0:v]drawbox=x=0:y=0:w='${W}*min(1,t/${bodyDur})':h=10:color=${C.ACC}:t=fill[b0];`;
  let pv = 'b0';
  els.forEach((o, k) => { efc += `[${pv}][${o.ix}:v]overlay=${o.x}:${o.y}:enable='between(t,${o.a},${o.b})'[e${k}];`; pv = `e${k}`; });
  efc = efc.replace(/;$/, '');
  const bodyfx = path.join(TMP, `bodyfx-${tag}.mp4`);
  ff([...ein, '-filter_complex', efc, '-map', `[${pv}]`, '-t', String(bodyDur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bodyfx]);

  // 4) cierre 2s
  const lastFrame = path.join(TMP, `lf-${tag}.png`);
  ff(['-sseof', '-0.3', '-i', presV, '-frames:v', '1', lastFrame]);
  const close = path.join(TMP, `close-${tag}.mp4`);
  const triY = `${Math.round(H * 0.80)}+${Math.round(H * 0.018)}*sin(2*PI*t*2.5)`;
  ff(['-loop', '1', '-t', '2', '-i', lastFrame, '-i', ov(`close-ov-${tag}.png`), '-i', TRI,
    '-filter_complex', `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.08,fps=30[bg];[bg][1:v]overlay=0:0[c];[c][2:v]overlay=(W-w)/2:'${triY}'[v]`,
    '-map', '[v]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', close]);

  // 5) concat + audio (loudnorm 2 pasadas) + mux
  const flist = path.join(TMP, `full-${tag}.txt`); fs.writeFileSync(flist, `file '${bodyfx}'\nfile '${close}'`);
  const vfull = path.join(TMP, `vfull-${tag}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', flist, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vfull]);

  const sfxFor = t => (t === 'grid' || t === 'broll' || t === 'split' || t === 'phone' || t === 'calendar') ? 'swoosh.mp3' : (t === 'facecta' ? 'ding.mp3' : 'pop.mp3');
  const ain = ['-i', presA, '-stream_loop', '-1', '-i', path.join(UGC, 'music.mp3')];
  let aidx = 2; const parts = ['[0:a]volume=1.0[vz]', `[1:a]volume=0.125,atrim=0:${(bodyDur + 2).toFixed(2)}[mus]`]; const mixL = ['[vz]', '[mus]'];
  cuts.forEach((c, i) => { const f = path.join(SFXD, sfxFor(c.type)); if (!fs.existsSync(f)) return; ain.push('-i', f); parts.push(`[${aidx}:a]adelay=${Math.round(c.t * 1000)}|${Math.round(c.t * 1000)},volume=0.3[s${i}]`); mixL.push(`[s${i}]`); aidx++; });
  ain.push('-i', path.join(SFXD, 'ding.mp3')); parts.push(`[${aidx}:a]adelay=${Math.round(bodyDur * 1000)}|${Math.round(bodyDur * 1000)},volume=0.4[sc]`); mixL.push('[sc]');
  const mix = path.join(TMP, `mix-${tag}.wav`);
  ff([...ain, '-filter_complex', parts.join(';') + `;${mixL.join('')}amix=inputs=${mixL.length}:normalize=0:dropout_transition=0[a]`, '-map', '[a]', '-t', String(bodyDur + 2), mix]);
  const meas = ffCap(['-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  let m = {}; try { m = JSON.parse(meas.slice(meas.lastIndexOf('{'), meas.lastIndexOf('}') + 1)); } catch (e) { }
  const audio = path.join(TMP, `audio-${tag}.m4a`);
  const ln = m.input_i ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true` : 'loudnorm=I=-14:TP=-1.5:LRA=11';
  ff(['-i', mix, '-af', `${ln},alimiter=limit=0.85:level=false`, '-ar', '44100', '-c:a', 'aac', '-b:a', '160k', audio]);

  const outFile = path.join(OUT, `Hana-UGC-${VARIANT}-${tag}.mp4`);
  ff(['-i', vfull, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', outFile]);
  // metadata para verificación
  fs.writeFileSync(path.join(TMP, `meta-${VARIANT}-${tag}.json`), JSON.stringify({ bodyDur, W, H, capYov: L.capYov, stkYov: L.stkYov, pip: { px, py, PIP } }, null, 2));
  return { outFile, dur: +(bodyDur + 2).toFixed(1) };
}

// ---------------- run ----------------
const VARIANT = (process.argv[2] || 'A').toUpperCase();
const RATWANT = process.argv[3] || 'both';
const TAGS = RATWANT === 'both' ? ['9x16', '4x5'] : [RATWANT];
const INPUT = path.join(UGC, `guion-${VARIANT}-30.mp4`);

(async () => {
  await genAssets();
  const words = JSON.parse(fs.readFileSync(path.join(UGC, `words-${VARIANT}-align.json`), 'utf8'));
  const faceMed = JSON.parse(fs.readFileSync(path.join(UGC, `face-${VARIANT}.json`), 'utf8')).median;
  const meta = buildRuns(words);
  // volcado para verificación de palabras completas (orig start/end + tiempo nuevo)
  fs.writeFileSync(path.join(TMP, `words-final-${VARIANT}.json`), JSON.stringify(words.map((w, i) => ({ w: w.word, oStart: w.start, oEnd: w.end, nStart: meta.newT[i] })), null, 2));
  const results = [];
  for (const tag of TAGS) results.push(buildOne(tag, VARIANT, INPUT, words, meta, faceMed));
  console.log('\nSalidas:'); results.forEach(r => console.log('  ' + path.relative(ROOT, r.outFile) + '  (' + r.dur + 's)'));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
