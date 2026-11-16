// Genera overlays PNG transparentes para el UGC (Playwright): subtítulos karaoke,
// stickers con emoji, texto superior, CTA y overlay de cierre.
// Carga Poppins vía FontFace API (file://) y espera document.fonts.ready; verifica
// con getComputedStyle que la fuente aplicada sea Poppins antes de capturar.
// Uso: node scripts/ugc-overlays.js A|B
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UGC = path.join(ROOT, 'motor-anuncios', 'ugc');
const OV = path.join(ROOT, 'motor-anuncios', '_adtmp', 'ugc', 'ov');
fs.mkdirSync(OV, { recursive: true });
const FD = path.join(ROOT, 'node_modules', '@expo-google-fonts', 'poppins');
const FONTS = [
  ['Pop8', `${FD}/800ExtraBold/Poppins_800ExtraBold.ttf`],
  ['Pop9', `${FD}/900Black/Poppins_900Black.ttf`],
  ['Pop6', `${FD}/600SemiBold/Poppins_600SemiBold.ttf`],
];
// @font-face embebido en base64 (sin red, carga fiable en Playwright)
const FONT_CSS = FONTS.map(([name, file]) =>
  `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${fs.readFileSync(file).toString('base64')}) format('truetype');font-weight:400 900;font-style:normal;}`
).join('\n');
const ACC = '#c2456a', PLUM = '#4a2a4f', SOFT = '#fbe9ee';

const VARIANT = (process.argv[2] || 'A').toUpperCase();
const words = JSON.parse(fs.readFileSync(path.join(UGC, `words-${VARIANT}-align.json`), 'utf8'));
const s0 = Math.max(0, words[0].start - 0.04);

function displayToken(w, next) {
  const t = w.word;
  if (/^quince$/i.test(t)) return '15';
  if (/^veintiún$|^veintiuno$/i.test(t)) return '21';
  if (/^un$/i.test(t) && next && /^minuto/i.test(next.word)) return '1';
  return t;
}
function groupLines(words) {
  const lines = []; let cur = [];
  for (let i = 0; i < words.length; i++) {
    cur.push(i);
    const tk = words[i].word;
    const strongEnd = /[.:!?]$/.test(tk), softEnd = /[,;]$/.test(tk);
    if (cur.length >= 3 || strongEnd || (softEnd && cur.length >= 2) || i === words.length - 1) { lines.push(cur); cur = []; }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

let page;
async function shot(html, w, h, file) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><head><meta charset="utf8"><style>${FONT_CSS}
    html,body{margin:0;padding:0;width:${w}px;height:${h}px;background:transparent;overflow:hidden}
    *{box-sizing:border-box}</style></head><body><div id="probe" style="font-family:'Pop8';position:absolute;left:-9999px">probe</div>${html}</body></html>`, { waitUntil: 'load' });
  await page.evaluate(async () => { await document.fonts.load("800 80px 'Pop8'"); await document.fonts.load("900 80px 'Pop9'"); await document.fonts.ready; });
  const fam = await page.evaluate(() => getComputedStyle(document.getElementById('probe')).fontFamily);
  if (!/pop8/i.test(fam)) throw new Error('Poppins NO aplicada (getComputedStyle=' + fam + ')');
  const loaded = await page.evaluate(() => document.fonts.check("800 80px 'Pop8'"));
  if (!loaded) throw new Error('Pop8 no cargó (document.fonts.check=false)');
  await page.waitForTimeout(40);
  await page.screenshot({ path: path.join(OV, file), omitBackground: true });
}

(async () => {
  const browser = await chromium.launch();
  page = await browser.newPage({ deviceScaleFactor: 1 });

  // ---------- subtítulos karaoke ----------
  // inactiva: blanca borde negro grueso + sombra. activa: blanca sobre píldora #c2456a.
  const capWrap = `display:flex;gap:16px;align-items:center;justify-content:center;width:1080px;height:300px;white-space:nowrap`;
  const wInactive = `font-family:'Pop8';font-size:78px;line-height:1;color:#fff;-webkit-text-stroke:11px #000;paint-order:stroke fill;text-shadow:0 6px 10px rgba(0,0,0,.6)`;
  const wActive = `font-family:'Pop8';font-size:84px;line-height:1;color:#fff;background:${ACC};padding:6px 26px;border-radius:22px;box-shadow:0 8px 20px rgba(0,0,0,.45);text-shadow:0 3px 6px rgba(0,0,0,.4)`;

  const lines = groupLines(words);
  const manifest = []; let idx = 0;
  for (const line of lines) {
    for (let k = 0; k < line.length; k++) {
      const html = `<div style="${capWrap}">` + line.map((wi, j) => {
        const disp = displayToken(words[wi], words[wi + 1]);
        return `<span style="${j === k ? wActive : wInactive}">${disp}</span>`;
      }).join('') + `</div>`;
      const file = `cap-${VARIANT}-${String(idx).padStart(3, '0')}.png`;
      await shot(html, 1080, 300, file);
      manifest.push({ png: file, wi: line[k] }); // wi = índice de palabra activa (timing lo pone build con newT)
      idx++;
    }
  }
  fs.writeFileSync(path.join(OV, `cap-${VARIANT}-manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(`captions ${VARIANT}: ${idx} pngs`);

  // ---------- stickers / checks / CTA ----------
  const pill = (bg, color, txt, fsz = 64) => `<div style="display:inline-flex;align-items:center;gap:14px;
    font-family:'Pop8';font-size:${fsz}px;color:${color};background:${bg};padding:22px 42px;border-radius:999px;
    box-shadow:0 10px 30px rgba(0,0,0,.28);white-space:nowrap">${txt}</div>`;
  const center = (inner, w = 1080, h = 240) => `<div style="display:flex;align-items:center;justify-content:center;width:${w}px;height:${h}px">${inner}</div>`;
  await shot(center(pill('#ffffff', PLUM, 'CALISTENIA ASIÁTICA 🌸')), 1080, 240, 'stk-calistenia.png');
  await shot(center(pill('#ffffff', PLUM, '🎆 AÑO NUEVO')), 1080, 240, 'stk-anionuevo.png');
  await shot(center(pill(ACC, '#ffffff', '🕒 15 MIN')), 1080, 240, 'stk-15min.png');
  await shot(center(pill(ACC, '#ffffff', 'SIN GIMNASIO')), 1080, 240, 'stk-singim.png');
  await shot(center(pill('#2f8a5b', '#ffffff', '✓ SIN SALTOS')), 1080, 240, 'chk-saltos.png');
  await shot(center(pill('#2f8a5b', '#ffffff', '✓ SIN EQUIPO')), 1080, 240, 'chk-equipo.png');
  await shot(center(pill(ACC, '#ffffff', 'HAZ EL TEST GRATIS 👇', 72), 1080, 260), 1080, 260, 'cta.png');

  // ---------- texto superior: tira fina de 1 línea (no toca la cara) ----------
  const topTxt = VARIANT === 'A' ? '15 MIN · SIN SALTOS · SIN EQUIPO' : '21 DÍAS ANTES DE AÑO NUEVO';
  const topHtml = `<div style="display:flex;align-items:center;justify-content:center;width:1080px;height:130px">
    <div style="font-family:'Pop8';font-size:44px;line-height:1;color:#fff;background:${PLUM}E6;white-space:nowrap;
      padding:16px 34px;border-radius:999px;text-align:center;letter-spacing:.5px">${topTxt}</div></div>`;
  await shot(topHtml, 1080, 130, `top-${VARIANT}.png`);

  // ---------- overlay de cierre (transparente; fondo = presentadora desenfocada en ffmpeg) ----------
  for (const [w, h, tag] of [[1080, 1920, '9x16'], [1080, 1350, '4x5']]) {
    const html = `<div style="width:${w}px;height:${h}px;display:flex;flex-direction:column;align-items:center;
      justify-content:center;text-align:center;gap:28px;padding:0 60px">
      <div style="display:flex;align-items:center;gap:18px">
        <div style="width:64px;height:64px;border-radius:50%;background:radial-gradient(circle at 35% 30%, #e6a7bd, ${ACC})"></div>
        <div style="font-family:'Pop9';font-size:52px;color:#fff;letter-spacing:3px;text-shadow:0 3px 10px rgba(0,0,0,.6)">MÉTODO HANA</div>
      </div>
      <div style="font-family:'Pop9';font-size:104px;line-height:1.02;color:#fff;-webkit-text-stroke:3px ${PLUM};paint-order:stroke fill;text-shadow:0 8px 18px rgba(0,0,0,.5)">HAZ EL TEST<br>GRATIS</div>
      <div style="font-family:'Pop8';font-size:46px;color:#fff;text-shadow:0 3px 10px rgba(0,0,0,.7)">1 minuto <span style="color:#ffd3df">→</span> tu plan de 21 días</div>
      <div style="font-family:'Pop6';font-size:36px;color:#fff;text-shadow:0 3px 10px rgba(0,0,0,.7)">🎁 Regalo de bienvenida al final</div>
      <div id="btn" style="margin-top:46px;font-family:'Pop8';font-size:58px;color:#fff;background:${ACC};padding:26px 60px;border-radius:999px;box-shadow:0 14px 38px rgba(194,69,106,.6)">HAZ EL TEST GRATIS</div>
    </div>`;
    await shot(html, w, h, `close-ov-${tag}.png`);
  }
  console.log('stickers/top/cta/close listos');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
