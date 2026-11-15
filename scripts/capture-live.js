// Live capture of the published Método Hana landing (Impultienda).
// iPhone 390x844 dSF2. Blocks facebook* to keep the pixel clean. No data entered anywhere.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://vialiviana.impultienda.ar';
const LANDING = BASE + '/?country=MX';
const CHECKOUT = BASE + '/checkout?cupon=HANA25&country=MX';

const SHOTS = 'revision/shots';
const MEDIA = 'revision/media';
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const TITLES = [
  'Portada — ¿Cuántos años tienes?',
  'Prueba social — Miles de mujeres 40+',
  '¿Ya probaste la calistenia asiática?',
  'Respuesta personalizada',
  '¿Qué objetivo es más importante hoy?',
  '¿Cómo describirías tu cuerpo hoy?',
  '¿Qué te molesta más hoy? (múltiple)',
  '¿Cómo te gustaría verte?',
  '¿Qué zonas quieres trabajar primero? (múltiple)',
  'Solo 15 minutos al día',
  '¿Con qué frecuencia haces ejercicio?',
  '¿Te sientes cómoda con este movimiento?',
  '¿Cuántas sentadillas puedes hacer seguidas?',
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
  'Creando tu plan (carga)',
  'Tu protocolo casi listo (comparación)',
  'Tu perfil está listo (IMC)',
  'Recupera tu energía (emocional)',
  'Compromiso — ¿Qué tan segura estás?',
  'Ruleta de bienvenida',
  'Oferta',
];

const ctxOpts = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

const blockFB = (page) => page.route(/facebook\.(com|net)|connect\.facebook\.net/, r => r.abort());
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function settle(page) {
  // wait for the current quiz screen to be present and scrolled to top
  await page.waitForSelector('#hana .h-screen', { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(450);
}

// advance one screen; returns a tag for the screen kind
async function advance(page) {
  if (await page.$('#hAge .h-opt')) { await (await page.$$('#hAge .h-opt'))[0].click(); await wait(350); return 'cover'; }
  if (await page.$('#hRingC')) { await page.waitForSelector('#hRingC', { state: 'detached', timeout: 15000 }).catch(()=>{}); return 'loader'; }
  const opts = await page.$$('#hana .h-screen .h-opt');
  if (opts.length) {
    const multi = await page.$('#hana .h-screen .h-opt .h-chk');
    await opts[0].click(); await wait(300);
    if (multi) {
      await page.waitForFunction(() => !document.getElementById('hCta').disabled, { timeout: 5000 });
      await page.click('#hCta'); await wait(350);
      return 'multi';
    }
    return 'single';
  }
  // info / slider / biotipo / intensity / graph / etc.
  const footHidden = await page.evaluate(() => document.getElementById('hFoot').hidden);
  if (!footHidden) { await page.click('#hCta'); await wait(350); return 'cta'; }
  return 'none';
}

(async () => {
  const browser = await chromium.launch();
  const report = { consoleErrors: [], brokenImages: [], priceOffer: null, screens: 0 };

  // ---------------- PASS 1: 37 screenshots ----------------
  const ctx1 = await browser.newContext(ctxOpts);
  const page = await ctx1.newPage();
  await blockFB(page);
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  page.on('pageerror', e => report.consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(LANDING, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page);

  for (let i = 0; i < 37; i++) {
    await settle(page);
    const n = String(i + 1).padStart(2, '0');
    await page.screenshot({ path: `${SHOTS}/${n}.png` });
    report.screens++;

    if (i === 35) { // wheel -> spin -> win -> continue to offer
      await page.click('#hCta');
      await page.waitForSelector('#hWheelOut .h-win', { timeout: 12000 });
      await page.waitForFunction(() => !document.getElementById('hCta').disabled, { timeout: 8000 });
      await page.click('#hCta');
      await page.waitForSelector('#hana .h-offer', { timeout: 8000 });
      continue;
    }
    if (i === 36) break; // offer captured
    await advance(page);
  }

  // offer price check + broken images
  report.priceOffer = await page.evaluate(() => {
    const o = document.querySelector('#hana .h-price .old');
    const nw = document.querySelector('#hana .h-price .new');
    return { old: o ? o.textContent : null, new: nw ? nw.textContent : null };
  });
  report.brokenImages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#hana img'))
      .filter(im => im.getAttribute('src') && im.naturalWidth === 0 && im.style.display !== 'none')
      .map(im => im.getAttribute('src').slice(0, 80));
  });
  await ctx1.close();
  console.log('PASS1 done:', report.screens, 'screens. offer price:', JSON.stringify(report.priceOffer));

  // ---------------- PASS 2: wheel -> offer video ----------------
  const ctx2 = await browser.newContext({ ...ctxOpts, recordVideo: { dir: MEDIA, size: { width: 390, height: 844 } } });
  const p2 = await ctx2.newPage();
  await blockFB(p2);
  await p2.goto(LANDING, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(p2);
  // fast walk to wheel
  for (let i = 0; i < 35; i++) { await settle(p2); await advance(p2); }
  await settle(p2); // wheel visible
  await wait(800);
  await p2.click('#hCta'); // girar
  await p2.waitForSelector('#hWheelOut .h-win', { timeout: 12000 });
  await wait(1500); // show "¡Ganaste!"
  await p2.waitForFunction(() => !document.getElementById('hCta').disabled, { timeout: 8000 });
  await p2.click('#hCta'); // ver plan -> offer
  await p2.waitForSelector('#hana .h-offer', { timeout: 8000 });
  await wait(1200); // show urgency bar
  // scroll to first price block
  await p2.evaluate(() => {
    const pr = document.querySelector('#hana .h-price');
    if (pr) pr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await wait(2500);
  const vpath = await p2.video().path();
  await ctx2.close();
  const finalVideo = path.join(MEDIA, 'ruleta-oferta.webm');
  fs.renameSync(vpath, finalVideo);
  console.log('PASS2 video:', finalVideo);

  // ---------------- checkout screenshot ----------------
  const ctx3 = await browser.newContext(ctxOpts);
  const p3 = await ctx3.newPage();
  await blockFB(p3);
  await p3.goto(CHECKOUT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(4000);
  await p3.screenshot({ path: `${MEDIA}/checkout.png`, fullPage: true });
  await ctx3.close();
  console.log('checkout shot saved');

  await browser.close();
  fs.writeFileSync('revision/report.json', JSON.stringify(report, null, 2));
  console.log('--- REPORT ---');
  console.log('console errors:', report.consoleErrors.length, report.consoleErrors.slice(0,5));
  console.log('broken images :', report.brokenImages.length, report.brokenImages);
  console.log('offer price   :', JSON.stringify(report.priceOffer));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
