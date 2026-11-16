// Genera overlays PNG transparentes para el UGC (Playwright): subtítulos karaoke,
// stickers con emoji, checks, texto superior, botón CTA y pantalla de cierre.
// Uso: node scripts/ugc-overlays.js A|B
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UGC = path.join(ROOT, 'motor-anuncios', 'ugc');
const OV = path.join(ROOT, 'motor-anuncios', '_adtmp', 'ugc', 'ov');
fs.mkdirSync(OV, { recursive: true });
const FONTDIR = path.join(ROOT, 'node_modules', '@expo-google-fonts', 'poppins');
const fontFace = `
@font-face{font-family:'Pop8';src:url('file://${FONTDIR}/800ExtraBold/Poppins_800ExtraBold.ttf');}
@font-face{font-family:'Pop9';src:url('file://${FONTDIR}/900Black/Poppins_900Black.ttf');}
@font-face{font-family:'Pop6';src:url('file://${FONTDIR}/600SemiBold/Poppins_600SemiBold.ttf');}
`;
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
// agrupa palabras en líneas de 2-4, cortando en puntuación fuerte
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

async function shot(page, html, w, h, file) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><head><meta charset="utf8"><style>${fontFace}
    html,body{margin:0;padding:0;width:${w}px;height:${h}px;background:transparent;overflow:hidden}
    *{box-sizing:border-box}</style></head><body>${html}</body></html>`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(60);
  await page.screenshot({ path: path.join(OV, file), omitBackground: true });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  // estilo karaoke: palabra blanca borde negro; activa accent y 1.15x
  const capCss = `display:flex;gap:16px;align-items:center;justify-content:center;width:1080px;height:300px;
    font-family:'Pop8';white-space:nowrap;`;
  const wordCss = (active) => `font-size:${active ? 80 : 70}px;line-height:1;
    color:${active ? ACC : '#ffffff'};
    -webkit-text-stroke:${active ? 8 : 6}px #111;paint-order:stroke fill;
    text-shadow:0 5px 0 rgba(0,0,0,.35);letter-spacing:.3px;`;

  // ---- subtítulos karaoke: un PNG por palabra (línea con palabra activa) ----
  const lines = groupLines(words);
  const manifest = [];
  let idx = 0;
  for (const line of lines) {
    for (let k = 0; k < line.length; k++) {
      const activeI = line[k];
      const html = `<div style="${capCss}">` + line.map((wi, j) => {
        const disp = displayToken(words[wi], words[wi + 1]);
        return `<span style="${wordCss(j === k)}">${disp}</span>`;
      }).join('') + `</div>`;
      const file = `cap-${VARIANT}-${String(idx).padStart(3, '0')}.png`;
      await shot(page, html, 1080, 300, file);
      const a = +(words[activeI].start - s0).toFixed(2);
      const b = +((activeI < words.length - 1 ? words[activeI + 1].start : words[activeI].end + 0.3) - s0).toFixed(2);
      manifest.push({ png: file, a, b });
      idx++;
    }
  }
  fs.writeFileSync(path.join(OV, `cap-${VARIANT}-manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(`captions ${VARIANT}: ${idx} pngs`);

  // ---- stickers / checks / top / CTA (compartidos) ----
  const pill = (bg, color, txt, fsz = 64) => `<div style="display:inline-flex;align-items:center;gap:14px;
    font-family:'Pop8';font-size:${fsz}px;color:${color};background:${bg};padding:22px 40px;border-radius:999px;
    box-shadow:0 10px 30px rgba(0,0,0,.25);white-space:nowrap">${txt}</div>`;
  const wrapCenter = (inner, w = 1080, h = 240) => `<div style="display:flex;align-items:center;justify-content:center;width:${w}px;height:${h}px">${inner}</div>`;

  await shot(page, wrapCenter(pill('#ffffff', PLUM, 'CALISTENIA ASIÁTICA 🌸')), 1080, 240, 'stk-calistenia.png');
  await shot(page, wrapCenter(pill('#ffffff', PLUM, '🎆 AÑO NUEVO')), 1080, 240, 'stk-anionuevo.png');
  await shot(page, wrapCenter(pill(ACC, '#ffffff', '🕒 15 MIN')), 1080, 240, 'stk-15min.png');
  await shot(page, wrapCenter(pill(ACC, '#ffffff', 'SIN GIMNASIO')), 1080, 240, 'stk-singim.png');
  await shot(page, wrapCenter(pill('#2f8a5b', '#ffffff', '✓ SIN SALTOS')), 1080, 240, 'chk-saltos.png');
  await shot(page, wrapCenter(pill('#2f8a5b', '#ffffff', '✓ SIN EQUIPO')), 1080, 240, 'chk-equipo.png');

  // texto superior (sin sonido)
  const topTxt = VARIANT === 'A' ? '15 MIN · SIN SALTOS · SIN EQUIPO' : '21 DÍAS ANTES DE AÑO NUEVO';
  await shot(page, wrapCenter(`<div style="font-family:'Pop9';font-size:66px;color:#fff;-webkit-text-stroke:8px ${PLUM};paint-order:stroke fill;text-align:center;letter-spacing:1px">${topTxt}</div>`), 1080, 220, `top-${VARIANT}.png`);

  // botón CTA
  await shot(page, wrapCenter(pill(ACC, '#ffffff', 'HAZ EL TEST GRATIS 👇', 72), 1080, 260), 1080, 260, 'cta.png');

  // ---- pantalla de cierre (9x16 y 4x5) ----
  for (const [w, h, tag] of [[1080, 1920, '9x16'], [1080, 1350, '4x5']]) {
    const html = `<div style="width:${w}px;height:${h}px;background:${SOFT};display:flex;flex-direction:column;
      align-items:center;justify-content:center;text-align:center;gap:34px;font-family:'Pop8'">
      <div style="display:flex;align-items:center;gap:20px">
        <div style="width:74px;height:74px;border-radius:50%;background:radial-gradient(circle at 35% 30%, #d98aa6, ${ACC})"></div>
        <div style="font-family:'Pop9';font-size:60px;color:${PLUM};letter-spacing:3px">MÉTODO HANA</div>
      </div>
      <div style="font-size:58px;color:${PLUM};max-width:900px;line-height:1.15">Test de 1 minuto <span style="color:${ACC}">→</span> tu plan de 21 días</div>
      <div style="font-size:40px;color:#6b5a66;max-width:860px;line-height:1.25">🎁 Al final del test te espera un regalo de bienvenida</div>
      <div style="margin-top:14px;font-family:'Pop8';font-size:62px;color:#fff;background:${ACC};padding:26px 56px;border-radius:999px;box-shadow:0 12px 34px rgba(194,69,106,.4)">HAZ EL TEST GRATIS</div>
    </div>`;
    await shot(page, html, w, h, `close-${tag}.png`);
  }
  console.log('stickers/top/cta/close listos');

  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
