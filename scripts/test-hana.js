// Headless smoke test for test.html (Método Hana quiz funnel)
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const errors = [];
  const fbq = [];
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t);
    if (t.startsWith('[fbq]')) fbq.push(t.replace('[fbq] track | ', ''));
  });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('file://' + path.resolve('test.html'), { waitUntil: 'networkidle0' });

  const clickFirstOpt = async () => {
    await page.waitForSelector('#hana .h-screen .h-opt', { visible: true });
    const opts = await page.$$('#hana .h-screen .h-opt');
    await opts[0].click();
    await new Promise(r => setTimeout(r, 300));
  };
  const clickCta = async () => {
    await page.waitForFunction(() => {
      const f = document.getElementById('hFoot');
      const c = document.getElementById('hCta');
      return f && !f.hidden && c && !c.disabled;
    }, { timeout: 8000 });
    await page.click('#hCta');
    await new Promise(r => setTimeout(r, 300));
  };
  const curType = () => page.evaluate(() => {
    const h1 = document.querySelector('#hana .h-screen h1');
    return h1 ? h1.textContent.slice(0, 40) : '(no h1)';
  });

  // walk screens 0..35 (stop before offer handled specially)
  let bar0 = await page.evaluate(() => document.getElementById('hBar').style.width);
  // screen 0: cover age buttons
  await page.waitForSelector('#hAge .h-opt');
  await (await page.$$('#hAge .h-opt'))[0].click();
  await new Promise(r => setTimeout(r, 300));

  let safety = 0;
  while (safety++ < 60) {
    const h1 = await curType();
    // detect wheel
    const isWheel = await page.$('#hWheel');
    const isOffer = await page.$('#hana .h-offer');
    const hasOpts = await page.$('#hana .h-screen .h-opt');
    const footHidden = await page.evaluate(() => document.getElementById('hFoot').hidden);

    if (isOffer) { console.log('reached OFFER'); break; }
    if (isWheel) {
      console.log('WHEEL screen, spinning...');
      await page.click('#hCta'); // girar
      await page.waitForSelector('#hWheelOut .h-win', { timeout: 9000 });
      const winTxt = await page.$eval('#hWheelOut .big', e => e.textContent);
      console.log('wheel result:', winTxt);
      await clickCta(); // ver mi plan
      continue;
    }
    if (hasOpts) {
      // if multi (has checkbox) still click first then cta; else auto-advance
      const isMulti = await page.$('#hana .h-screen .h-opt .h-chk');
      await clickFirstOpt();
      if (isMulti) await clickCta();
      continue;
    }
    // loader: wait it out
    const isLoader = await page.$('#hRingC');
    if (isLoader) { await new Promise(r => setTimeout(r, 7000)); continue; }
    // image/info/slider/etc: click cta
    if (!footHidden) { await clickCta(); continue; }
    // slider fallback
    await new Promise(r => setTimeout(r, 400));
  }

  // --- OFFER checks ---
  const buyHref = await page.$eval('#hana .h-buy', a => a.getAttribute('href'));
  const newPrice = await page.$eval('#hana .h-price .new', e => e.textContent);
  const oldPrice = await page.$eval('#hana .h-price .old', e => e.textContent);
  const clock = await page.$eval('#hClock', e => e.textContent);
  const ctaTxt = await page.$eval('#hCta', e => e.textContent);

  console.log('--- RESULTS ---');
  console.log('buy href     :', buyHref);
  console.log('old price     :', oldPrice);
  console.log('new price     :', newPrice);
  console.log('clock         :', clock);
  console.log('cta           :', ctaTxt);
  console.log('fbq events    :', fbq.join(', '));

  // force timer expiry
  await page.evaluate(() => {
    sessionStorage.setItem('hana_deadline', String(Date.now() - 1000));
  });
  await new Promise(r => setTimeout(r, 1300));
  const buyHrefExp = await page.$eval('#hana .h-buy', a => a.getAttribute('href'));
  const newPriceExp = await page.$eval('#hana .h-price .new', e => e.textContent);
  const ctaExp = await page.$eval('#hCta', e => e.textContent);
  const urgExp = await page.$eval('#hUrgText', e => e.textContent);
  console.log('--- AFTER EXPIRY ---');
  console.log('buy href     :', buyHrefExp);
  console.log('new price     :', newPriceExp);
  console.log('cta           :', ctaExp);
  console.log('urg text      :', urgExp);

  console.log('--- CONSOLE ERRORS:', errors.length);
  errors.forEach(e => console.log('  !', e));

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
