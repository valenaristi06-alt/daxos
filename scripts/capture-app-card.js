// Explora metodo-hana.vercel.app/plan-cd1a5b5cc7 (Día 1) y captura la tarjeta de ejercicio
// para el PiP del anuncio. Primero modo --explore (screenshot + estructura), luego captura fina.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://metodo-hana.vercel.app/plan-cd1a5b5cc7';
const OUT = path.join(__dirname, '..', 'motor-anuncios', 'app');
fs.mkdirSync(OUT, { recursive: true });
const EXPLORE = process.argv.includes('--explore');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);

  // responder el intake de 4 preguntas: click primera .opt, repetir hasta que no haya más
  for (let i = 0; i < 8; i++) {
    const opts = await page.$$('button.opt');
    if (!opts.length) break;
    await opts[0].click();
    await page.waitForTimeout(600);
    // si hay botón continuar/siguiente, clickearlo
    const next = await page.$('button.cta, button.next, #next, button[type=submit]');
    if (next) { try { await next.click(); await page.waitForTimeout(600); } catch (e) {} }
  }
  await page.waitForTimeout(1200);
  // abrir Día 1
  const start = await page.$('button.btn');
  if (start) { try { await start.click(); await page.waitForTimeout(1500); } catch (e) {} }

  if (EXPLORE) {
    await page.screenshot({ path: path.join(OUT, 'explore-full.png'), fullPage: true });
    // mapa de elementos candidatos (texto corto + tamaño)
    const map = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('button, a, [class], section, article, h1, h2, h3').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return;
        const t = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50);
        out.push(`${el.tagName.toLowerCase()}.${(el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : '')} [${Math.round(r.width)}x${Math.round(r.height)}] "${t}"`);
      });
      return out.slice(0, 120);
    });
    fs.writeFileSync(path.join(OUT, 'explore-map.txt'), map.join('\n'));
    console.log('explore listo: explore-full.png + explore-map.txt');
    await browser.close();
    return;
  }

  // captura fina de la tarjeta de ejercicio (card #1 = MOVILIDAD, sin foco abdomen)
  const cards = await page.$$('div.card');
  if (cards.length) {
    await cards[0].screenshot({ path: path.join(OUT, 'card-dia1.png') });
    console.log('card-dia1.png (card #1)');
  }
  // versión alta: desde el título "Día 1" hasta el fin de la 2da card (movilidad + piernas)
  try {
    const box = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const cs = document.querySelectorAll('div.card');
      const top = h1.getBoundingClientRect().top + window.scrollY;
      const bot = cs[1].getBoundingClientRect().bottom + window.scrollY;
      return { x: 16, y: Math.max(0, top - 8), width: 388, height: (bot - top) + 16 };
    });
    await page.screenshot({ path: path.join(OUT, 'card-dia1-tall.png'), clip: box });
    console.log('card-dia1-tall.png (Día 1 + 2 cards)');
  } catch (e) { console.error('tall falló', e.message); }

  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
