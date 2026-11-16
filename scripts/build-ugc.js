// UGC alta retención (presentadora IA) — v3 calidad agencia.
// Jump-cuts físicos (recorta silencios >0.25s, alterna zoom 100/112), storyboard por frase,
// teléfono grande + PiP de la presentadora, subtítulos karaoke, SFX + música, loudnorm -14 LUFS.
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

const ff = (args) => { try { return execFileSync(C.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { const er = (e.stderr || '').toString(); throw new Error('ffmpeg: ' + er.split('\n').filter(Boolean).slice(-4).join(' | ')); } };
const ffCap = (args) => { const r = spawnSync(C.FFMPEG, ['-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }); return (r.stdout || '') + (r.stderr || ''); };
const P = id => path.join(PEX, id + '.mp4');
const ov = f => path.join(OVD, f);
// solo mujeres adultas 50-60 (se quitó el clip de mancuernas por verse joven/ambiguo)
const BROLL = [[P('7531376'), 2], [P('7531378'), 2], [P('7531379'), 2], [P('8939152'), 1]];

const TRI = path.join(ASSET, 'tri.png');
const CMASK = path.join(ASSET, 'cmask.png');
const RING = path.join(ASSET, 'ring.png');
async function genAssets() {
  const tri = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="130"><path d="M10 18 H140 L75 118 Z" fill="#c2456a"/></svg>`;
  await sharp(Buffer.from(tri)).png().toFile(TRI);
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><circle cx="150" cy="150" r="150" fill="#fff"/></svg>`;
  await sharp(Buffer.from(mask)).png().toFile(CMASK);
  const ring = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><circle cx="150" cy="150" r="142" fill="none" stroke="#fff" stroke-width="10"/></svg>`;
  await sharp(Buffer.from(ring)).png().toFile(RING);
}

// ---------------- retiming (jump cuts) ----------------
function buildRuns(words) {
  const GAP = 0.25, PAD = 0.08;
  const n = words.length; const segs = []; let startIdx = 0;
  for (let k = 0; k < n; k++) {
    const gap = (k < n - 1) ? words[k + 1].start - words[k].end : Infinity;
    if (gap > GAP) { segs.push([startIdx, k]); startIdx = k + 1; }
  }
  const runs = []; let acc = 0;
  segs.forEach(([a, b], i) => {
    const srcStart = Math.max(0, words[a].start - PAD);
    const srcEnd = words[b].end + PAD;
    const len = +(srcEnd - srcStart).toFixed(3);
    runs.push({ srcStart, srcEnd, len, newStart: +acc.toFixed(3), zoom: i % 2 === 0 ? 1.0 : 1.12, a, b });
    acc += len;
  });
  // tiempos nuevos por palabra
  const newT = words.map(() => null);
  runs.forEach(r => { for (let k = r.a; k <= r.b; k++) newT[k] = +(r.newStart + (words[k].start - r.srcStart)).toFixed(3); });
  return { runs, bodyDur: +acc.toFixed(3), newT };
}

// ---------------- scene renderers ----------------
function cropFrac(W, H) { return (H / W < 1.4) ? 0.26 : 0.5; }
function presenterRun(input, W, H, srcStart, len, zoom, out) {
  const zw = Math.round(W * zoom), zh = Math.round(H * zoom), frac = cropFrac(W, H);
  ff(['-ss', String(srcStart), '-t', String(len), '-i', input, '-an',
    '-vf', `scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*${frac},setsar=1,fps=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(len), out]);
  return out;
}
function brollSeg(clip, W, H, dur, out) {
  ff(['-ss', String(clip[1]), '-stream_loop', '-1', '-t', String(dur), '-i', clip[0], '-an',
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), out]);
  return out;
}
function gridSeg(W, H, dur, out) {
  const cw = Math.round(W / 3), ch = Math.round(H / 3), cells = [];
  for (let i = 0; i < 9; i++) { const c = BROLL[i % BROLL.length]; const o = path.join(TMP, `grd-${i}-${W}.mp4`); brollSeg([c[0], c[1] + (i % 3)], cw, ch, dur, o); cells.push(o); }
  const pos = []; for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) pos.push(`${cc * cw}_${r * ch}`);
  const inputs = cells.flatMap(c => ['-i', c]);
  const labels = ['3x12', '2x15', '3x10', '2x30', '3x8', '2x20', '3x15', '2x12', '15m'];
  const lab = pos.map((p, i) => { const [x, y] = p.split('_'); return `drawtext=fontfile=${C.FONT_EXTRABOLD}:text='${labels[i]}':fontcolor=white:fontsize=${Math.round(W * 0.028)}:x=${+x + 12}:y=${+y + 10}:box=1:boxcolor=${C.ACC}:boxborderw=7`; }).join(',');
  const fc = cells.map((_, i) => `[${i}:v]`).join('') + `xstack=inputs=9:layout=${pos.join('|')}[g];[g]${lab}[v]`;
  ff([...inputs, '-filter_complex', fc, '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
function splitSeg(input, W, H, srcStart, dur, clip, out) {
  const half = Math.round(H / 2);
  const top = presenterRun(input, W, half, srcStart, dur, 1.0, path.join(TMP, `sp-top-${W}.mp4`));
  const bot = brollSeg(clip, W, H - half, dur, path.join(TMP, `sp-bot-${W}.mp4`));
  ff(['-i', top, '-i', bot, '-filter_complex', `[0:v][1:v]vstack=inputs=2[v]`, '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
// teléfono GRANDE con scroll + toques (sin PiP, el PiP se agrega después sobre la base)
function phoneSeg(W, H, dur, screenPng, opts, out) {
  opts = opts || {};
  const phH = Math.round(H * 0.84);
  const pw = Math.round(phH * 0.462);
  const bw = pw + 22, bh = phH + 22;
  const bx = Math.round((W - bw) / 2), by = Math.round((H - bh) / 2);
  const ox = bx + 11, oy = by + 11;
  const sc = 1.14, sw = Math.round(pw * sc), sh = Math.round(phH * sc);
  const yexpr = opts.bottom ? `(ih-${phH})` : `(ih-${phH})*min(1\\,t/${dur})*0.85`;
  const tapX = ox + Math.round(pw * 0.5), tapY = oy + Math.round(phH * (opts.bottom ? 0.8 : 0.45));
  const tapEnable = opts.tap ? `lt(mod(t\\,1.4)\\,0.5)` : '0';
  ff(['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${C.SOFT}:s=${W}x${H}:r=30`,
    '-loop', '1', '-t', String(dur), '-i', screenPng, '-i', RING,
    '-filter_complex',
    `[1:v]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${pw}:${phH}:(iw-${pw})/2:'${yexpr}',setsar=1,fps=30[scr];` +
    `[2:v]scale=150:150[rg];` +
    `[0:v]drawbox=x=${bx - 3}:y=${by - 3}:w=${bw + 6}:h=${bh + 6}:color=black@0.18:t=fill,drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${C.PLUM}:t=fill[bg];` +
    `[bg][scr]overlay=${ox}:${oy}[p];` +
    (opts.highlight ? `[p]drawbox=x=${ox}:y=${oy + Math.round(phH * 0.78)}:w=${pw}:h=${Math.round(phH * 0.08)}:color=${C.ACC}@0.35:t=fill[p2];` : `[p]null[p2];`) +
    `[p2][rg]overlay=${tapX - 75}:${tapY - 75}:enable='${tapEnable}'[v]`,
    '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}
// calendario B: título arriba, casillas abajo (sin superponer)
function calendarSeg(W, H, dur, out) {
  const gw = 7, bs = Math.round(W * 0.10), gap = Math.round(W * 0.028);
  const totalW = gw * bs + (gw - 1) * gap, x0 = Math.round((W - totalW) / 2), y0 = Math.round(H * 0.52);
  const title = `drawtext=fontfile=${C.FONT_BLACK}:text='21 DÍAS':fontcolor=${C.PLUM}:fontsize=${Math.round(W * 0.095)}:x=(w-text_w)/2:y=${Math.round(H * 0.33)}`;
  let boxes = [title];
  for (let i = 0; i < 21; i++) {
    const cx = x0 + (i % gw) * (bs + gap), cy = y0 + Math.floor(i / gw) * (bs + gap);
    boxes.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=white@0.95:t=6`);
    const tt = (0.2 + i * (dur * 0.85 / 21)).toFixed(2);
    boxes.push(`drawbox=x=${cx}:y=${cy}:w=${bs}:h=${bs}:color=${C.ACC}:t=fill:enable='gte(t,${tt})'`);
  }
  ff(['-f', 'lavfi', '-t', String(dur), '-i', `color=c=${C.SOFT}:s=${W}x${H}:r=30`, '-vf', boxes.join(','), '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// ---------------- storyboard ----------------
function findTime(words, newT, anchor, afterTime) {
  for (let i = 0; i < words.length; i++) {
    if (newT[i] != null && newT[i] >= afterTime - 0.001 && words[i].word.toLowerCase().replace(/[.,:;!?]/g, '') === anchor.toLowerCase()) return { t: newT[i], srcT: words[i].start };
  }
  return null;
}
function sceneList(VARIANT, words, newT) {
  const raw = VARIANT === 'A' ? [
    { anchor: null, type: 'face' },
    { anchor: 'prueba', type: 'grid' },
    { anchor: 'se', type: 'face', sticker: 'stk-calistenia.png' },
    { anchor: 'movimientos', type: 'broll', clip: 0 },
    { anchor: 'sin', type: 'broll', clip: 1, checks: ['chk-saltos.png', 'chk-equipo.png'] },
    { anchor: 'son', type: 'split', clip: 2, sticker: 'stk-15min.png' },
    { anchor: 'haces', type: 'phone', screen: 'quiz-edad.png', tap: true, pip: true },
    { anchor: 'y', type: 'phone', screen: 'plan-21.png', pip: true },
    { anchor: 'y', type: 'phone', screen: 'card-facil.png', bottom: true, highlight: true, pip: true },
    { anchor: 'el', type: 'facecta' },
  ] : [
    { anchor: null, type: 'face', sticker: 'stk-anionuevo.png' },
    { anchor: 'empieza', type: 'calendar' },
    { anchor: 'son', type: 'grid' },
    { anchor: 'quince', type: 'broll', clip: 0, sticker: 'stk-singim.png' },
    { anchor: 'respondes', type: 'phone', screen: 'quiz-zonas.png', tap: true, pip: true },
    { anchor: 'y', type: 'phone', screen: 'plan-21.png', pip: true },
    { anchor: 'haz', type: 'facecta' },
  ];
  let after = 0; const scenes = [];
  for (const sc of raw) {
    let r = sc.anchor ? findTime(words, newT, sc.anchor, after + 0.01) : { t: 0, srcT: words[0].start };
    if (!r) r = { t: after + 0.3, srcT: 0 };
    scenes.push({ ...sc, t: r.t });
    after = r.t;
  }
  return scenes;
}

// ---------------- build ----------------
function buildOne(W, H, tag, VARIANT, input, words, meta) {
  const { runs, bodyDur, newT } = meta;
  const scenes = sceneList(VARIANT, words, newT);
  // 1) PRES base (jump-cut, zoom alternado)
  const runVids = runs.map((r, i) => presenterRun(input, W, H, r.srcStart, r.len, r.zoom, path.join(TMP, `run-${tag}-${i}.mp4`)));
  const vlist = path.join(TMP, `pres-${tag}.txt`); fs.writeFileSync(vlist, runVids.map(p => `file '${p}'`).join('\n'));
  const presV = path.join(TMP, `presV-${tag}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', vlist, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', presV]);
  // audio de cada run -> concat
  const runAuds = runs.map((r, i) => { const o = path.join(TMP, `rau-${tag}-${i}.wav`); ff(['-ss', String(r.srcStart), '-t', String(r.len), '-i', input, '-vn', '-ac', '2', '-ar', '44100', o]); return o; });
  const alist = path.join(TMP, `presA-${tag}.txt`); fs.writeFileSync(alist, runAuds.map(p => `file '${p}'`).join('\n'));
  const presA = path.join(TMP, `presA-${tag}.wav`);
  ff(['-f', 'concat', '-safe', '0', '-i', alist, '-c', 'copy', presA]);

  // 2) escenas no-face -> override sobre presV + PiP en teléfonos
  const nonface = []; const cuts = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i]; const start = sc.t, end = (i < scenes.length - 1 ? scenes[i + 1].t : bodyDur), dur = +(end - start).toFixed(3);
    sc._start = start; sc._end = end; sc._dur = dur;
    if (i > 0) cuts.push({ t: start, type: sc.type });
    if (sc.type === 'face' || sc.type === 'facecta') continue;
    const o = path.join(TMP, `sc-${tag}-${i}.mp4`);
    if (sc.type === 'broll') brollSeg(BROLL[sc.clip], W, H, dur, o);
    else if (sc.type === 'grid') gridSeg(W, H, dur, o);
    else if (sc.type === 'split') splitSeg(input, W, H, runs[0].srcStart + start, dur, BROLL[sc.clip], o);
    else if (sc.type === 'phone') phoneSeg(W, H, dur, path.join(SCR, sc.screen), { tap: sc.tap, bottom: sc.bottom, highlight: sc.highlight }, o);
    else if (sc.type === 'calendar') calendarSeg(W, H, dur, o);
    sc._clip = o; nonface.push(sc);
  }
  const PIP = Math.round(W * 0.24);
  const px = Math.round(W * 0.045), py = Math.round(H * 0.085);
  const inputs = ['-i', presV]; let ix = 1;
  nonface.forEach(sc => { inputs.push('-i', sc._clip); sc._ix = ix++; });
  inputs.push('-i', RING); const ringIx = ix++;
  const cc = Math.round(PIP / 2), rr2 = (Math.round(PIP / 2) - 2) ** 2;
  let fc = `[0:v]split=2[base][pf];[pf]scale=${PIP}:${PIP}:force_original_aspect_ratio=increase,crop=${PIP}:${PIP},setsar=1,format=rgba,` +
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt((X-${cc})*(X-${cc})+(Y-${cc})*(Y-${cc}),${rr2}),0,255)'[pipc];[${ringIx}:v]scale=${PIP}:${PIP}[rng];`;
  let cur = 'base';
  nonface.forEach((sc, k) => { const nl = `n${k}`; fc += `[${sc._ix}:v]tpad=start_duration=${sc._start}:color=0x000000,setpts=PTS-STARTPTS[d${k}];[${cur}][d${k}]overlay=0:0:enable='between(t,${sc._start.toFixed(2)},${sc._end.toFixed(2)})'[${nl}];`; cur = nl; });
  const phoneSpans = nonface.filter(s => s.pip).map(s => `between(t,${s._start.toFixed(2)},${s._end.toFixed(2)})`).join('+') || '0';
  fc += `[${cur}][pipc]overlay=${px}:${py}:enable='${phoneSpans}'[wp];[wp][rng]overlay=${px}:${py}:enable='${phoneSpans}'[v]`;
  const vScenes = path.join(TMP, `vsc-${tag}.mp4`);
  ff([...inputs, '-filter_complex', fc, '-map', '[v]', '-t', String(bodyDur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vScenes]);

  // 3) elementos (top, stickers/checks/cta, barra, marca) + subtítulos
  const capY = tag === '9x16' ? 820 : 600;
  const manifest = JSON.parse(fs.readFileSync(ov(`cap-${VARIANT}-manifest.json`), 'utf8'));
  const ein = ['-i', vScenes]; let ei = 1; const els = [];
  const addEl = (png, x, y, a, b) => { ein.push('-i', ov(png)); els.push({ ix: ei, x, y, a, b }); ei++; };
  addEl(`top-${VARIANT}.png`, '(W-w)/2', Math.round(H * 0.05), 0, 2.5);
  scenes.forEach((sc, i) => {
    const a = sc._start, b = sc._end;
    if (sc.sticker) addEl(sc.sticker, '(W-w)/2', Math.round(H * 0.26), a + 0.05, b);
    if (sc.checks) { const mid = (a + b) / 2; addEl(sc.checks[0], '(W-w)/2', Math.round(H * 0.28), a + 0.1, mid); addEl(sc.checks[1], '(W-w)/2', Math.round(H * 0.28), mid, b); }
    if (sc.type === 'facecta') addEl('cta.png', '(W-w)/2', Math.round(H * 0.70), a + 0.1, b);
  });
  manifest.forEach(m => { const a = newT[m.wi]; const b = (m.wi < words.length - 1 && newT[m.wi + 1] != null) ? newT[m.wi + 1] : bodyDur; addEl(m.png, '(W-w)/2', capY, +a.toFixed(2), +b.toFixed(2)); });
  let efc = `[0:v]drawbox=x=0:y=0:w='${W}*min(1,t/${bodyDur})':h=10:color=${C.ACC}:t=fill,` +
    `drawtext=fontfile=${C.FONT_SEMIBOLD}:text='Presentadora generada con IA':fontcolor=white@0.6:fontsize=${Math.round(W * 0.022)}:x=22:y=${H - Math.round(H * 0.03)}:box=1:boxcolor=black@0.25:boxborderw=7[b0];`;
  let pv = 'b0';
  els.forEach((o, k) => { const nl = `e${k}`; efc += `[${pv}][${o.ix}:v]overlay=${o.x}:${o.y}:enable='between(t,${o.a},${o.b})'[${nl}];`; pv = nl; });
  efc = efc.replace(/;$/, '');
  const bodyfx = path.join(TMP, `bodyfx-${tag}.mp4`);
  ff([...ein, '-filter_complex', efc, '-map', `[${pv}]`, '-t', String(bodyDur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bodyfx]);

  // 4) cierre 2s: presentadora desenfocada + overlay + flecha que rebota
  const lastFrame = path.join(TMP, `lf-${tag}.png`);
  ff(['-sseof', '-0.3', '-i', presV, '-frames:v', '1', lastFrame]);
  const close = path.join(TMP, `close-${tag}.mp4`);
  const triY = `${Math.round(H * 0.80)}+${Math.round(H * 0.018)}*sin(2*PI*t*2.5)`;
  ff(['-loop', '1', '-t', '2', '-i', lastFrame, '-i', ov(`close-ov-${tag}.png`), '-i', TRI,
    '-filter_complex', `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.08,fps=30[bg];` +
    `[bg][1:v]overlay=0:0[c];[c][2:v]overlay=(W-w)/2:'${triY}'[v]`,
    '-map', '[v]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', close]);

  // 5) concat video
  const flist = path.join(TMP, `full-${tag}.txt`); fs.writeFileSync(flist, `file '${bodyfx}'\nfile '${close}'`);
  const vfull = path.join(TMP, `vfull-${tag}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', flist, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vfull]);

  // 6) audio: voz + sfx + música -> loudnorm 2 pasadas
  const sfxFor = t => (t === 'grid' || t === 'broll' || t === 'split' || t === 'phone' || t === 'calendar') ? 'swoosh.mp3' : (t === 'facecta' ? 'ding.mp3' : 'pop.mp3');
  const ain = ['-i', presA, '-stream_loop', '-1', '-i', path.join(UGC, 'music.mp3')];
  let aidx = 2; const parts = ['[0:a]volume=1.0[vz]', `[1:a]volume=0.125,atrim=0:${(bodyDur + 2).toFixed(2)}[mus]`]; const mixL = ['[vz]', '[mus]'];
  cuts.forEach((c, i) => { const f = path.join(SFXD, sfxFor(c.type)); if (!fs.existsSync(f)) return; ain.push('-i', f); parts.push(`[${aidx}:a]adelay=${Math.round(c.t * 1000)}|${Math.round(c.t * 1000)},volume=0.3[s${i}]`); mixL.push(`[s${i}]`); aidx++; });
  ain.push('-i', path.join(SFXD, 'ding.mp3')); parts.push(`[${aidx}:a]adelay=${Math.round(bodyDur * 1000)}|${Math.round(bodyDur * 1000)},volume=0.4[sc]`); mixL.push('[sc]');
  const mix = path.join(TMP, `mix-${tag}.wav`);
  ff([...ain, '-filter_complex', parts.join(';') + `;${mixL.join('')}amix=inputs=${mixL.length}:normalize=0:dropout_transition=0[a]`, '-map', '[a]', '-t', String(bodyDur + 2), mix]);
  // loudnorm pass 1 (medir)
  const meas = ffCap(['-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  let m = {}; try { m = JSON.parse(meas.slice(meas.lastIndexOf('{'), meas.lastIndexOf('}') + 1)); } catch (e) { }
  if (!m.input_i) console.error('  (loudnorm: no se pudo medir, uso single-pass)');
  const audio = path.join(TMP, `audio-${tag}.m4a`);
  const ln = m.input_i ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true` : 'loudnorm=I=-14:TP=-1.5:LRA=11';
  ff(['-i', mix, '-af', `${ln},alimiter=limit=0.85:level=false`, '-ar', '44100', '-c:a', 'aac', '-b:a', '160k', audio]);

  // 7) mux
  const outFile = path.join(OUT, `Hana-UGC-${VARIANT}-${tag}.mp4`);
  ff(['-i', vfull, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', outFile]);
  return { outFile, dur: +(bodyDur + 2).toFixed(1) };
}

// ---------------- run ----------------
const VARIANT = (process.argv[2] || 'A').toUpperCase();
const RATWANT = process.argv[3] || 'both';
const RATIOS = RATWANT === 'both' ? [[1080, 1920, '9x16'], [1080, 1350, '4x5']] : (RATWANT === '4x5' ? [[1080, 1350, '4x5']] : [[1080, 1920, '9x16']]);
const INPUT = path.join(UGC, `guion-${VARIANT}.mp4`);

(async () => {
  await genAssets();
  const words = JSON.parse(fs.readFileSync(path.join(UGC, `words-${VARIANT}-align.json`), 'utf8'));
  const meta = buildRuns(words);
  const results = [];
  for (const [W, H, tag] of RATIOS) results.push(buildOne(W, H, tag, VARIANT, INPUT, words, meta));
  console.log('\nSalidas:'); results.forEach(r => console.log('  ' + path.relative(ROOT, r.outFile) + '  (' + r.dur + 's)'));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
