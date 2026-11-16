// Captura pantallas del quiz del landing (localhost:4321) para los teléfonos del UGC.
// Bloquea facebook para no ensuciar el píxel. iPhone 390x844 dSF3.
// Targets: edad, "¿Qué zonas quieres trabajar?", "¿Sientes dolor en alguna zona?", ruleta.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://localhost:4321/?country=MX';
const OUT = path.join(__dirname, '..', 'motor-anuncios', 'ugc', 'screens');
fs.mkdirSync(OUT, { recursive: true });

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const want = [
  { file: 'quiz-edad.png', match: ['cuantos anos', 'edad'] },
  { file: 'quiz-zonas.png', match: ['zonas quieres trabajar'] },
  { file: 'quiz-dolor.png', match: ['dolor en alguna zona'] },
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/facebook\.(com|net)/.test(u)) return route.abort();
    route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(800);

  const heading = async () => page.evaluate(() => {
    const el = document.querySelector('#hana .h-screen h2, #hana .h-screen .h-q, #hAge h2, #hAge .h-q, #hana h2');
    return el ? el.innerText : (document.querySelector('#hana') || document.body).innerText.slice(0, 80);
  });
  const shotIfWanted = async () => {
    const h = norm(await heading());
    for (const w of want) {
      if (!w.done && w.match.some(m => h.includes(norm(m)))) {
        await page.screenshot({ path: path.join(OUT, w.file) });
        w.done = true; console.log('cap', w.file, '::', h.slice(0, 40));
      }
    }
  };

  // pantalla de edad primero
  await page.waitForSelector('#hAge .h-opt', { timeout: 15000 });
  await shotIfWanted();
  await page.$$eval('#hAge .h-opt', els => els[0].click());
  await page.waitForTimeout(400);

  let n = 0;
  while (n++ < 60) {
    if (await page.$('#hWheel')) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(OUT, 'ruleta.png') }); console.log('cap ruleta.png'); break; }
    if (await page.$('#hRingC')) { await page.waitForTimeout(1500); continue; }
    await shotIfWanted();
    const opts = await page.$$('#hana .h-screen .h-opt');
    if (opts.length) {
      const multi = await page.$('#hana .h-screen .h-opt .h-chk');
      await opts[0].click(); await page.waitForTimeout(250);
      if (multi) {
        try { await page.waitForFunction(() => { const c = document.getElementById('hCta'); return c && !c.disabled; }, { timeout: 3000 }); await page.click('#hCta'); await page.waitForTimeout(250); } catch (e) {}
      }
      continue;
    }
    const footHidden = await page.evaluate(() => { const f = document.getElementById('hFoot'); return !f || f.hidden; });
    if (!footHidden) { try { await page.click('#hCta'); } catch (e) {} await page.waitForTimeout(250); }
    else await page.waitForTimeout(250);
  }

  console.log('faltan:', want.filter(w => !w.done).map(w => w.file).join(', ') || '(ninguna)');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
