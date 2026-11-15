// End-to-end funnel check against the local preview server (http://localhost:4321).
const { chromium } = require('playwright');
const wait = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://localhost:4321';
const errors = [];
const results = [];
const ok = (name, cond, extra='') => { results.push((cond?'✓':'✗')+' '+name+(extra?'  '+extra:'')); if(!cond) process.exitCode = 1; };

async function walkToOffer(p) {
  await p.waitForSelector('#hana .h-screen', { timeout: 15000 });
  async function adv() {
    if (await p.$('#hAge .h-opt')) { await (await p.$$('#hAge .h-opt'))[0].click(); await wait(300); return; }
    if (await p.$('#hRingC')) { await p.waitForSelector('#hRingC', { state: 'detached', timeout: 15000 }).catch(()=>{}); return; }
    const o = await p.$$('#hana .h-screen .h-opt');
    if (o.length) { const m = await p.$('#hana .h-screen .h-opt .h-chk'); await o[0].click(); await wait(250);
      if (m) { await p.waitForFunction(()=>!document.getElementById('hCta').disabled); await p.click('#hCta'); await wait(300); } return; }
    if (!(await p.evaluate(()=>document.getElementById('hFoot').hidden))) { await p.click('#hCta'); await wait(300); }
  }
  for (let i = 0; i < 35; i++) { await p.evaluate(()=>window.scrollTo(0,0)); await wait(200); await adv(); }
  // wheel
  await wait(400);
  await p.click('#hCta');
  await p.waitForSelector('#hWheelOut .h-win', { timeout: 12000 });
  const win = await p.$eval('#hWheelOut .big', e => e.textContent);
  await p.waitForFunction(()=>!document.getElementById('hCta').disabled);
  await p.click('#hCta'); // ver plan -> offer
  await p.waitForSelector('#hana .h-offer', { timeout: 8000 });
  return win;
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type()==='error') errors.push('['+p.url()+'] '+m.text()); });
  p.on('pageerror', e => errors.push('[pageerror] '+e.message));

  // --- landing full walk ---
  await p.goto(BASE + '/', { waitUntil:'domcontentloaded' });
  const win = await walkToOffer(p);
  ok('ruleta cae en 25% OFF', /25% OFF/.test(win), win);

  // offer price + CTA target
  const offer = await p.evaluate(() => {
    const old = document.querySelector('#hana .h-price .old')?.textContent;
    const nw = document.querySelector('#hana .h-price .new')?.textContent;
    const buy = document.querySelector('#hana .h-buy')?.getAttribute('href');
    return { old, nw, buy };
  });
  ok('oferta precio MX$400 / MX$300', offer.old==='MX$ 400' && offer.nw==='MX$ 300', JSON.stringify(offer));
  ok('CTA oferta -> /checkout?cupon=HANA25', /\/checkout\?cupon=HANA25/.test(offer.buy||''), offer.buy);

  // --- follow landing CTA to checkout ---
  await p.click('#hCta'); // "Quiero mi plan con 25% OFF" -> ClickCheckout + navigate
  await p.waitForURL(/\/checkout/, { timeout: 8000 });
  await p.waitForSelector('#ck-total');
  const t1 = await p.$eval('#ck-total', e => e.textContent);
  ok('checkout con HANA25 total MX$ 300', t1==='MX$ 300', t1);

  // toggle bump
  await p.click('#ck-bump');
  await wait(200);
  const t2 = await p.$eval('#ck-total', e => e.textContent);
  const buyLabel = await p.$eval('#ck-buy', e => e.textContent.trim());
  const buyHref = await p.$eval('#ck-buy', e => e.getAttribute('href'));
  ok('checkout con bump total MX$ 399', t2==='MX$ 399', t2);
  ok('boton checkout refleja 399', /399/.test(buyLabel), buyLabel);

  // --- go to gracias (with bump) ---
  await p.click('#ck-buy');
  await p.waitForURL(/\/gracias/, { timeout: 8000 });
  const gr = await p.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'));
    return {
      aprobado: /Pago aprobado/.test(document.body.innerText),
      app: links.some(h => h && h.includes('metodo-hana.vercel.app/plan-cd1a5b5cc7')),
      pdfAcceso: links.some(h => h && h.includes('1QHPDNr45hXvjSKwtRKClokBTROFeYQvS')),
      pdfBonos: links.some(h => h && h.includes('1Awa6QZuQjdH-ifoSJDDOxWvY4zc7xAVN')),
      rodillasApp: links.some(h => h && h.includes('rodillas-0ea240558f')),
      pdfRodillas: links.some(h => h && h.includes('1VxXII85xD9vD7arpzIpYX1VQU11K0WHk')),
      fase2Btn: /Fase 2/.test(document.body.innerText),
    };
  });
  ok('gracias: pago aprobado', gr.aprobado);
  ok('gracias: link app plan', gr.app);
  ok('gracias: PDF acceso + bonos', gr.pdfAcceso && gr.pdfBonos);
  ok('gracias: seccion rodillas (bump=1)', gr.rodillasApp && gr.pdfRodillas);
  ok('gracias: upsell Fase 2', gr.fase2Btn);

  // --- fase2 ---
  await p.click('a[href="/gracias-fase2"]');
  await p.waitForURL(/\/gracias-fase2/, { timeout: 8000 });
  const f2 = await p.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'));
    return { app: links.some(h=>h&&h.includes('fase2-2840a2230b')), pdf: links.some(h=>h&&h.includes('1EX9oWfPOAuihCkFaMHasZphFweHo69RS')),
      aviso: /no está activa en la tienda real/.test(document.body.innerText) };
  });
  ok('fase2: link app + PDF + aviso Starter', f2.app && f2.pdf && f2.aviso);

  // --- timer vencido -> checkout sin cupon = 400 ---
  await p.goto(BASE + '/checkout', { waitUntil:'domcontentloaded' });
  const t3 = await p.$eval('#ck-total', e => e.textContent);
  ok('checkout sin cupon (timer vencido) MX$ 400', t3==='MX$ 400', t3);

  await b.close();
  console.log(results.join('\n'));
  console.log('\nconsole errors:', errors.length);
  errors.slice(0,8).forEach(e => console.log('  !', e));
})().catch(e => { console.error('FATAL', e); process.exit(2); });
