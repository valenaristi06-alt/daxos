// Screenshots hero/ruleta/oferta at 390px from test.html, and verifies landing-store-paste.html
// (data URIs render, 0 JS errors) in a minimal wrapper.
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const walkToWheel = async (page) => {
  await page.waitForSelector('#hAge .h-opt');
  await (await page.$$('#hAge .h-opt'))[0].click();
  await new Promise(r => setTimeout(r, 300));
  let n = 0;
  while (n++ < 60) {
    if (await page.$('#hWheel')) return 'wheel';
    if (await page.$('#hana .h-offer')) return 'offer';
    if (await page.$('#hRingC')) { await new Promise(r => setTimeout(r, 7000)); continue; }
    const hasOpts = await page.$('#hana .h-screen .h-opt');
    if (hasOpts) {
      const isMulti = await page.$('#hana .h-screen .h-opt .h-chk');
      await (await page.$$('#hana .h-screen .h-opt'))[0].click();
      await new Promise(r => setTimeout(r, 300));
      if (isMulti) {
        await page.waitForFunction(() => !document.getElementById('hCta').disabled);
        await page.click('#hCta'); await new Promise(r => setTimeout(r, 300));
      }
      continue;
    }
    const footHidden = await page.evaluate(() => document.getElementById('hFoot').hidden);
    if (!footHidden) { await page.click('#hCta'); await new Promise(r => setTimeout(r, 300)); }
    else await new Promise(r => setTimeout(r, 300));
  }
  return 'timeout';
};

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  // ---- screenshots from test.html ----
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto('file://' + path.resolve('test.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: 'shot-390-hero.png' });
  console.log('shot hero');

  const at = await walkToWheel(page);
  if (at === 'wheel') {
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: 'shot-390-ruleta.png' });
    console.log('shot ruleta');
    await page.click('#hCta'); // girar
    await page.waitForSelector('#hWheelOut .h-win', { timeout: 9000 });
    await page.waitForFunction(() => !document.getElementById('hCta').disabled);
    await page.click('#hCta'); // ver plan -> offer
    await page.waitForSelector('#hana .h-offer', { timeout: 5000 });
  }
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: 'shot-390-oferta.png', fullPage: true });
  console.log('shot oferta');

  // ---- verify store-paste self-contained ----
  const paste = fs.readFileSync('landing-store-paste.html', 'utf8');
  const wrap = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=390">
    <script>window.fbq=function(){};</script></head><body>${paste}</body></html>`;
  const tmp = path.resolve('.store-check.html');
  fs.writeFileSync(tmp, wrap);
  const page2 = await browser.newPage();
  const errs = [];
  page2.on('pageerror', e => errs.push(e.message));
  page2.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page2.goto('file://' + tmp, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  const heroOK = await page2.evaluate(() => {
    const img = document.querySelector('#hana .h-pic img');
    return img && img.currentSrc.startsWith('data:') && img.naturalWidth > 0;
  });
  console.log('store-paste JS errors:', errs.length, errs.slice(0, 3).join(' | '));
  console.log('store-paste hero data-URI rendered:', heroOK);
  fs.unlinkSync(tmp);

  await browser.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
