// Captura de la app (vercel) para el UGC: grilla "plan de 21 días" y tarjeta "versión fácil".
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://metodo-hana.vercel.app/plan-cd1a5b5cc7';
const OUT = path.join(__dirname, '..', 'motor-anuncios', 'ugc', 'screens');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1200);
  // intake 4 preguntas
  for (let i = 0; i < 8; i++) {
    const opts = await page.$$('button.opt');
    if (!opts.length) break;
    await opts[0].click(); await page.waitForTimeout(500);
    const next = await page.$('button.cta, button.next, #next, button[type=submit]');
    if (next) { try { await next.click(); await page.waitForTimeout(500); } catch (e) {} }
  }
  await page.waitForTimeout(1000);
  // grilla del plan 21 días
  await page.screenshot({ path: path.join(OUT, 'plan-21.png') });
  console.log('plan-21.png');

  // entrar al Día 1
  const start = await page.$('button.btn');
  if (start) { await start.click(); await page.waitForTimeout(1500); }

  // buscar "Cómo se hace" / versión fácil en la primera card y expandir
  const toggles = await page.$$('button, .toggle, summary, [role=button]');
  let opened = false;
  for (const t of toggles) {
    const tx = ((await t.innerText().catch(() => '')) || '').toLowerCase();
    if (tx.includes('cómo se hace') || tx.includes('como se hace') || tx.includes('fácil') || tx.includes('facil')) {
      try { await t.click(); await page.waitForTimeout(700); opened = true; break; } catch (e) {}
    }
  }
  // screenshot de la primera card (con lo que haya: versión fácil / cómo se hace)
  const card = (await page.$$('div.card'))[0];
  if (card) { await card.screenshot({ path: path.join(OUT, 'card-facil.png') }); console.log('card-facil.png (opened=' + opened + ')'); }
  // también dump de textos con "fácil" para verificar
  const facilTxt = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter(e => /f[aá]cil/i.test(e.childElementCount ? '' : e.textContent || '')).slice(0, 5).map(e => e.textContent.trim().slice(0, 60)));
  console.log('textos fácil:', JSON.stringify(facilTxt));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
