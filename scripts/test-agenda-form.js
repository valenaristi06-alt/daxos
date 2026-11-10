#!/usr/bin/env node
'use strict';
// E2E tests: slot list, form validation, booking flow for the "Agregar turno" modal.
// Run: node scripts/test-agenda-form.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const { chromium, webkit } = require('playwright');

const TEST_PORT   = 3263;
const DB_DIR      = '/tmp/test-agenda-form';
const BASE_URL    = `http://localhost:${TEST_PORT}`;
const SHOTS_DIR   = '/tmp/agenda-shots';

let serverProc = null;
let passed = 0;
let failed = 0;

function cleanup() {
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch (_) {} serverProc = null; }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
          catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
        });
      }
    );
    r.on('error', reject);
    if (body != null) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start');
}

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

function parseCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const [name, ...rest] = raw.split(';')[0].split('=');
  return { name: name.trim(), value: rest.join('=') };
}

// Monday–Friday 10:00–12:00 (Tuesday=2, etc.)
const HOURS_JSON = JSON.stringify({
  '1': [['10:00','12:00']], '2': [['10:00','12:00']], '3': [['10:00','12:00']],
  '4': [['10:00','12:00']], '5': [['10:00','12:00']],
});

async function register(email, withHours = false) {
  const r = await req('POST', '/auth/register', { email, password: 'Test1234!', name: 'Test' });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const ck = parseCookie(r.headers['set-cookie']);
  const bizBody = { name: 'TestBiz' };
  if (withHours) bizBody.business_hours = HOURS_JSON;
  await req('PUT', '/api/business', bizBody, { cookie: `${ck.name}=${ck.value}` });
  return ck;
}

function enableAgenda(bizEmail) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  const u = db.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = ?`).get(bizEmail);
  if (u) db.prepare('UPDATE businesses SET plan=?, agenda_enabled=1 WHERE id=?').run('a_medida', u.id);
  db.close();
}

(async () => {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 'form-test', NODE_ENV: '', RAILWAY_ENVIRONMENT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForServer();
  console.log('Server ready.');

  // ── Suite 1: API tests (phone normalization, hours, conflict) ─────────────
  console.log('\nSuite 1: API validation');

  const email1 = `api-${Date.now()}@t.com`;
  const ck1 = await register(email1, true);
  enableAgenda(email1);
  const cookie1 = `${ck1.name}=${ck1.value}`;
  const svcR = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookie1 });
  const svcId = svcR.body?.services?.[0]?.id ?? 1;
  const DATE = '2026-11-11'; // Tuesday, within business hours

  // 1a. 8-digit phone normalizes correctly
  const r1a = await req('POST', '/api/agenda/appointments', {
    customerPhone: '98323308', clientName: 'T', serviceId: svcId, date: DATE, time: '10:00',
  }, { cookie: cookie1 });
  assert(r1a.status === 200 && r1a.body.customer_phone === '59898323308', '8-digit phone normalized to 59898323308');

  // 1b. 9-digit with leading 0 normalizes correctly
  const r1b = await req('POST', '/api/agenda/appointments', {
    customerPhone: '098323309', clientName: 'T2', serviceId: svcId, date: DATE, time: '10:30',
  }, { cookie: cookie1 });
  assert(r1b.status === 200 && r1b.body.customer_phone === '59898323309', '9-digit (leading 0) phone normalized');

  // 1c. Already-normalized phone accepted
  const r1c = await req('POST', '/api/agenda/appointments', {
    customerPhone: '59898323310', clientName: 'T3', serviceId: svcId, date: DATE, time: '11:00',
  }, { cookie: cookie1 });
  assert(r1c.status === 200 && r1c.body.customer_phone === '59898323310', 'Full international format accepted');

  // 1d. Phone with spaces normalized
  const r1d = await req('POST', '/api/agenda/appointments', {
    customerPhone: '098 323 311', clientName: 'T4', serviceId: svcId, date: DATE, time: '11:30',
  }, { cookie: cookie1 });
  assert(r1d.status === 200, 'Phone with spaces accepted and normalized');

  // 1e. Slot conflict returns 409
  const r1e = await req('POST', '/api/agenda/appointments', {
    customerPhone: '59891111111', clientName: 'T5', serviceId: svcId, date: DATE, time: '10:00',
  }, { cookie: cookie1 });
  assert(r1e.status === 409, 'Duplicate slot → 409');
  assert(r1e.body.error?.includes('confirmado'), '409 body has correct message');

  // 1f. Out-of-hours → 400
  const r1f = await req('POST', '/api/agenda/appointments', {
    customerPhone: '59891111111', clientName: 'T6', serviceId: svcId, date: DATE, time: '22:00',
  }, { cookie: cookie1 });
  assert(r1f.status === 400, 'Out-of-hours → 400');
  assert(r1f.body.error?.includes('horario de atención'), '400 body mentions horario de atención');

  // 1g. Day without hours → 400
  const r1g = await req('POST', '/api/agenda/appointments', {
    customerPhone: '59891111111', clientName: 'T7', serviceId: svcId, date: '2026-11-15', time: '10:00',
  }, { cookie: cookie1 });
  assert(r1g.status === 400, 'Day without hours → 400');

  // ── Suite 2: GET /api/agenda/slots ──────────────────────────────────────
  console.log('\nSuite 2: GET /api/agenda/slots');

  // 2a. Returns available slots for day with hours
  const slots1 = await req('GET', `/api/agenda/slots?date=${DATE}&serviceId=${svcId}`, null, { cookie: cookie1 });
  assert(slots1.status === 200, 'GET /api/agenda/slots → 200');
  assert(Array.isArray(slots1.body.slots), 'Response has slots array');

  // 10:00 and 10:30 are occupied (booked in 1a, 1b); check they are unavailable
  const slot10 = slots1.body.slots?.find(s => s.time === '10:00');
  const slot1030 = slots1.body.slots?.find(s => s.time === '10:30');
  assert(slot10 && !slot10.available, '10:00 (occupied) is unavailable');
  assert(slot1030 && !slot1030.available, '10:30 (occupied) is unavailable');

  // 2b. No session → 401
  const slotsNoAuth = await req('GET', `/api/agenda/slots?date=${DATE}`, null, {});
  assert(slotsNoAuth.status === 401, 'GET /api/agenda/slots without session → 401');

  // 2c. Agenda disabled → 403
  await req('PATCH', '/api/business/agenda-enabled', { enabled: false }, { cookie: cookie1 });
  const slotsDisabled = await req('GET', `/api/agenda/slots?date=${DATE}`, null, { cookie: cookie1 });
  assert(slotsDisabled.status === 403, 'GET /api/agenda/slots with agenda disabled → 403');
  await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookie1 });

  // 2d. Missing date → 400
  const slotsBadDate = await req('GET', '/api/agenda/slots', null, { cookie: cookie1 });
  assert(slotsBadDate.status === 400, 'GET /api/agenda/slots missing date → 400');

  // 2e. Invalid date format → 400
  const slotsInvalidDate = await req('GET', '/api/agenda/slots?date=bad', null, { cookie: cookie1 });
  assert(slotsInvalidDate.status === 400, 'GET /api/agenda/slots invalid date → 400');

  // 2f. Day without hours returns empty slots
  const slots2 = await req('GET', '/api/agenda/slots?date=2026-11-15', null, { cookie: cookie1 });
  assert(slots2.status === 200 && slots2.body.slots?.length === 0, 'Sunday → empty slots');

  // 2g. Duration affects slot count (60min service = half as many slots as 30min in 2h window)
  const svc60 = await req('POST', '/api/agenda/services', { name: 'Larga', duration_min: 60 }, { cookie: cookie1 });
  const svcId60 = svc60.body?.services?.find(s => s.duration_min === 60)?.id;
  const slots3 = await req('GET', `/api/agenda/slots?date=${DATE}&serviceId=${svcId60}`, null, { cookie: cookie1 });
  const slots30 = slots1.body.slots?.length ?? 0;
  const slotsCount60 = slots3.body.slots?.length ?? 0;
  assert(slotsCount60 < slots30, `60min service has fewer slots (${slotsCount60}) than 30min (${slots30})`);

  // ── Suite 3: UI (Playwright) ─────────────────────────────────────────────
  console.log('\nSuite 3: UI — Chromium');
  const cr = await chromium.launch({ headless: true });
  try { await runUITests(cr, 'Chromium'); } finally { await cr.close(); }

  console.log('\nSuite 3: UI — WebKit');
  const wk = await webkit.launch({ headless: true });
  try { await runUITests(wk, 'WebKit'); } finally { await wk.close(); }

  // ── Screenshots (WebKit, with animation settle) ──────────────────────────
  console.log('\nTaking screenshots...');
  const wkShot = await webkit.launch({ headless: true });
  try { await takeShots(wkShot); } finally { await wkShot.close(); }

  const total = passed + failed;
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

  async function takeShots(browser) {
    const email = `shots-${Date.now()}@t.com`;
    // Full 09:00–18:00 hours for form-long shot
    const longHours = JSON.stringify({
      '1':[['09:00','18:00']],'2':[['09:00','18:00']],'3':[['09:00','18:00']],
      '4':[['09:00','18:00']],'5':[['09:00','18:00']],
    });
    const ckS = await register(email);
    const cookieS = `${ckS.name}=${ckS.value}`;
    await req('PUT', '/api/business', { name: 'ShotBiz', business_hours: longHours }, { cookie: cookieS });
    enableAgenda(email);
    await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookieS });
    // Pre-book 10:00 so disabled slots show
    await req('POST', '/api/agenda/appointments', {
      customerPhone: '59891111111', clientName: 'Pre-booked', serviceId: 1, date: DATE, time: '10:00',
    }, { cookie: cookieS });

    async function newPage(width, height) {
      const ctx = await browser.newContext({ viewport: { width, height }, baseURL: BASE_URL });
      await ctx.addCookies([{ name: ckS.name, value: ckS.value, domain: 'localhost', path: '/' }]);
      return ctx.newPage();
    }
    async function openModalOnDate(page, date, vpWidth) {
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      await page.click(vpWidth < 600 ? '#btn-add-apt-fab' : '#btn-add-apt-header');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      await page.fill('#m-date', date);
      await page.dispatchEvent('#m-date', 'change');
      await page.waitForFunction(() => {
        const loading = document.getElementById('m-slots-loading');
        return document.querySelector('#m-slots .slot-btn') && loading.style.display === 'none';
      }, { timeout: 5000 });
      await page.waitForTimeout(400); // let CSS transition finish
    }

    // form-390.png: 390px — initial state: modal open, slot list visible, "¿Otra hora? Escribila" link, no manual field
    {
      const page = await newPage(390, 844);
      await page.goto('/agenda.html');
      await openModalOnDate(page, DATE, 390);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'form-390.png'), fullPage: false });
      console.log('  → form-390.png (390px WebKit, modal inicial)');
      await page.context().close();
    }

    // form-1280.png: desktop 1280x800 — modal open, slot list visible
    {
      const page = await newPage(1280, 800);
      await page.goto('/agenda.html');
      await openModalOnDate(page, DATE, 1280);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'form-1280.png'), fullPage: false });
      console.log('  → form-1280.png (1280px WebKit, modal open)');
      await page.context().close();
    }

    // form-error-390.png: 390px — modal open, phone error visible
    {
      const page = await newPage(390, 844);
      await page.goto('/agenda.html');
      await openModalOnDate(page, DATE, 390);
      // Select a slot then leave phone empty to trigger error
      await page.click('#m-slots .slot-btn:not(:disabled)');
      await page.fill('#m-phone', '');
      await page.click('#modal-save');
      await page.waitForFunction(() => {
        const el = document.getElementById('modal-error');
        return el && el.offsetHeight > 0 && el.textContent.trim().length > 0;
      }, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'form-error-390.png'), fullPage: false });
      console.log('  → form-error-390.png (390px WebKit, phone error)');
      await page.context().close();
    }

    // form-error-hours-390.png: 390px — out-of-hours error via "Otra hora" 23:00
    {
      const page = await newPage(390, 844);
      await page.goto('/agenda.html');
      await openModalOnDate(page, DATE, 390);
      await page.fill('#m-phone', '59891112233');
      await page.click('#m-other-btn');
      await page.waitForTimeout(150);
      await page.fill('#m-time-manual', '23:00');
      await page.click('#modal-save');
      await page.waitForFunction(() => {
        const el = document.getElementById('modal-error');
        return el && el.offsetHeight > 0 && el.textContent.trim().length > 0;
      }, { timeout: 5000 }).catch(() => {});
      await page.$eval('#modal-error', el => el.scrollIntoView({ block: 'center' })).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'form-error-hours-390.png'), fullPage: false });
      console.log('  → form-error-hours-390.png (390px WebKit, out-of-hours error)');
      await page.context().close();
    }

    // form-long-390.png: 390px — 09:00-18:00 / 30min = many slots, limited height + scroll visible
    {
      const page = await newPage(390, 844);
      await page.goto('/agenda.html');
      await openModalOnDate(page, DATE, 390);
      // Verify slot list has scroll: max-height exceeded
      const listInfo = await page.$eval('#m-slots', el => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        count: el.querySelectorAll('.slot-btn').length,
      }));
      console.log(`  slot list: ${listInfo.count} slots, scrollHeight=${listInfo.scrollHeight} clientHeight=${listInfo.clientHeight}`);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'form-long-390.png'), fullPage: false });
      console.log('  → form-long-390.png (390px WebKit, long hours list with scroll)');
      await page.context().close();
    }
  }

  async function runUITests(browser, label) {
    const email = `ui-form-${Date.now()}-${label}@t.com`;
    const ck = await register(email, true);
    enableAgenda(email);
    const cookie = `${ck.name}=${ck.value}`;

    // Create a 30min service
    const sR = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: `${ck.name}=${ck.value}` });
    const uiSvcId = sR.body?.services?.[0]?.id ?? 1;

    // Pre-book 10:00 slot via API
    await req('POST', '/api/agenda/appointments', {
      customerPhone: '59891111111', clientName: 'Pre-booked',
      serviceId: uiSvcId, date: DATE, time: '10:00',
    }, { cookie: `${ck.name}=${ck.value}` });

    async function newPage(width, height) {
      const ctx = await browser.newContext({ viewport: { width, height }, baseURL: BASE_URL });
      await ctx.addCookies([{ name: ck.name, value: ck.value, domain: 'localhost', path: '/' }]);
      return ctx.newPage();
    }

    // ── 3a. Slot list renders when modal opens ─────────────────────────────
    console.log(`  [${label}] 3a: slot list renders`);
    {
      const page = await newPage(1280, 800);
      await page.goto(`/agenda.html#${DATE}`);
      // Navigate to DATE
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      // Click btn-add-apt-header
      await page.click('#btn-add-apt-header');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      // Set date to DATE
      await page.fill('#m-date', DATE);
      await page.dispatchEvent('#m-date', 'change');
      // Wait for slots
      await page.waitForFunction(() => document.querySelector('#m-slots .slot-btn'), { timeout: 5000 });
      const slotCount = await page.$$eval('#m-slots .slot-btn', btns => btns.length);
      assert(slotCount >= 2, `${label} 3a: slot list has ≥2 buttons (got ${slotCount})`);

      // 10:00 slot is disabled (pre-booked)
      const slot1000 = await page.$('#m-slots .slot-btn[data-time="10:00"]');
      const isDisabled = await slot1000?.isDisabled();
      assert(isDisabled === true, `${label} 3a: 10:00 slot is disabled (occupied)`);

      // 10:30 slot is available
      const slot1030el = await page.$('#m-slots .slot-btn[data-time="10:30"]');
      const is1030Disabled = await slot1030el?.isDisabled();
      assert(is1030Disabled === false, `${label} 3a: 10:30 slot is available`);

      await page.context().close();
    }

    // ── 3b. Mobile slot list ───────────────────────────────────────────────
    console.log(`  [${label}] 3b: mobile slot list`);
    {
      const page = await newPage(390, 844);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      await page.click('#btn-add-apt-fab');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      await page.fill('#m-date', DATE);
      await page.dispatchEvent('#m-date', 'change');
      await page.waitForFunction(() => document.querySelector('#m-slots .slot-btn'), { timeout: 5000 });
      const slotCount = await page.$$eval('#m-slots .slot-btn', btns => btns.length);
      assert(slotCount >= 2, `${label} 3b: mobile slot list renders (${slotCount} slots)`);

      // Slot buttons have min-height 44px (touch target); use offsetHeight (layout size, not visual/transformed)
      const minH = await page.$eval('#m-slots .slot-btn', btn => btn.offsetHeight);
      assert(minH >= 44, `${label} 3b: slot btn height ≥ 44px (got ${minH.toFixed(0)}px)`);

      await page.context().close();
    }

    // ── 3c. Manual time fallback ───────────────────────────────────────────
    console.log(`  [${label}] 3c: manual time fallback`);
    {
      const page = await newPage(390, 844);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      await page.click('#btn-add-apt-fab');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      // Manual input hidden by default
      const manualHidden = await page.$eval('#m-time-manual', el => el.style.display === 'none' || getComputedStyle(el).display === 'none');
      assert(manualHidden, `${label} 3c: manual input hidden by default`);
      // "¿Otra hora?" is a plain text button (not checkbox)
      const otherBtn = await page.$('#m-other-btn');
      assert(!!otherBtn, `${label} 3c: #m-other-btn exists`);
      const otherBtnTag = await page.$eval('#m-other-btn', el => el.tagName);
      assert(otherBtnTag === 'BUTTON', `${label} 3c: #m-other-btn is a BUTTON element`);
      // Click link → input appears and is focused
      await page.click('#m-other-btn');
      await sleep(150);
      const manualVisible = await page.$eval('#m-time-manual', el => el.style.display !== 'none' && getComputedStyle(el).display !== 'none');
      assert(manualVisible, `${label} 3c: manual input visible after clicking ¿Otra hora?`);
      // Placeholder is correct
      const placeholder = await page.$eval('#m-time-manual', el => el.placeholder);
      assert(placeholder === 'HH:MM, ej. 15:30', `${label} 3c: placeholder is "HH:MM, ej. 15:30"`);
      // Phone hint text present
      const hintVisible = await page.$eval('.field-hint', el => el.textContent.includes('098'));
      assert(hintVisible, `${label} 3c: phone hint "Ej: 098 123 456" present`);
      await page.context().close();
    }

    // ── 3d. Success flow: select slot + fill form + save ───────────────────
    console.log(`  [${label}] 3d: success flow`);
    {
      const page = await newPage(1280, 800);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      await page.click('#btn-add-apt-header');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      await page.fill('#m-date', DATE);
      await page.dispatchEvent('#m-date', 'change');
      // Wait for slots to load for DATE (loading indicator gone + at least one available slot)
      await page.waitForFunction(() => {
        const loading = document.getElementById('m-slots-loading');
        const btn = document.querySelector('#m-slots .slot-btn:not(:disabled)');
        return btn && (loading.style.display === 'none' || !loading);
      }, { timeout: 5000 });
      await page.waitForTimeout(200); // let any stale load settle
      // Fill form
      await page.fill('#m-phone', '098999001');
      await page.fill('#m-name', 'Juan Test');
      // Select first available slot
      await page.click('#m-slots .slot-btn:not(:disabled)');
      const selectedTime = await page.$eval('#m-slots .slot-btn.selected', btn => btn.dataset.time).catch(() => null);
      assert(selectedTime !== null, `${label} 3d: slot can be selected`);
      // Save
      await page.click('#modal-save');
      // Modal should close after successful save
      await page.waitForFunction(() => !document.getElementById('apt-modal').classList.contains('open'), { timeout: 8000 }).catch(() => {});
      const modalClosed = await page.$eval('#apt-modal', el => !el.classList.contains('open')).catch(() => false);
      assert(modalClosed, `${label} 3d: modal closes after save`);
      // Appointment should appear in calendar
      await sleep(800);
      const aptCards = await page.$$('.apt-card, .day-apt, [class*="apt"]');
      assert(aptCards.length >= 1, `${label} 3d: appointment appears in calendar after booking`);
      await page.context().close();
    }

    // ── 3e. Error: invalid phone ───────────────────────────────────────────
    console.log(`  [${label}] 3e: invalid phone error`);
    {
      const page = await newPage(390, 844);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      await page.click('#btn-add-apt-fab');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      await page.fill('#m-date', DATE);
      await page.dispatchEvent('#m-date', 'change');
      await page.waitForFunction(() => document.querySelector('#m-slots .slot-btn:not(:disabled)'), { timeout: 5000 });
      await page.click('#m-slots .slot-btn:not(:disabled)');
      // Leave phone empty
      await page.fill('#m-phone', '');
      await page.click('#modal-save');
      await sleep(400);
      const errVisible = await page.isVisible('#modal-error').catch(() => false);
      const errText3e  = await page.$eval('#modal-error', el => el.textContent.trim()).catch(() => '');
      assert(errVisible && errText3e.includes('teléfono'), `${label} 3e: error shown and visible for empty phone`);
      const btnText = await page.$eval('#modal-save', btn => btn.textContent.trim());
      assert(btnText === 'Guardar turno', `${label} 3e: button text restored after validation error`);

      await page.context().close();
    }

    // ── 3f. Error: out-of-hours via manual time ────────────────────────────
    console.log(`  [${label}] 3f: out-of-hours via manual time`);
    {
      const page = await newPage(1280, 800);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      await page.click('#btn-add-apt-header');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      await page.fill('#m-date', DATE);
      await page.dispatchEvent('#m-date', 'change');
      await page.fill('#m-phone', '59891112222');
      await page.click('#m-other-btn');
      await sleep(200);
      await page.fill('#m-time-manual', '22:00');
      await page.click('#modal-save');
      await sleep(600);
      const errVisible3f = await page.isVisible('#modal-error').catch(() => false);
      const errText3f    = await page.$eval('#modal-error', el => el.textContent.trim()).catch(() => '');
      assert(errVisible3f && (errText3f.includes('horario') || errText3f.includes('atención')), `${label} 3f: error visible and text mentions horario/atención`);
      const modalStillOpen = await page.$eval('#apt-modal', el => el.classList.contains('open'));
      assert(modalStillOpen, `${label} 3f: modal stays open on out-of-hours error`);
      await page.context().close();
    }

    // ── 3g. Error: slot occupied ───────────────────────────────────────────
    console.log(`  [${label}] 3g: occupied slot shows disabled`);
    {
      const page = await newPage(1280, 800);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      await page.click('#btn-add-apt-header');
      await page.waitForSelector('#apt-modal.open', { timeout: 5000 });
      // Must set date to DATE where the pre-booking lives
      await page.fill('#m-date', DATE);
      await page.dispatchEvent('#m-date', 'change');
      await page.waitForFunction(() => document.querySelector('#m-slots .slot-btn'), { timeout: 5000 });
      // 10:00 was pre-booked at the start → must be disabled
      const is10Disabled = await page.$eval('#m-slots .slot-btn[data-time="10:00"]', btn => btn.disabled).catch(() => null);
      assert(is10Disabled === true, `${label} 3g: pre-booked slot disabled in list`);
      await page.context().close();
    }

    // ── 3h. Booked appointment appears in day view ─────────────────────────
    console.log(`  [${label}] 3h: booking appears in agenda`);
    {
      const page = await newPage(1280, 800);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
      // Navigate to DATE
      await page.fill('#date-input', DATE).catch(() => {});
      await page.evaluate((d) => {
        window._currentDate = d;
        if (typeof navigateTo === 'function') return navigateTo(d);
      }, DATE).catch(() => {});
      await sleep(1000);
      // The pre-booked appointment at 10:00 should be in the day view
      const pageText = await page.textContent('body');
      assert(pageText.includes('Pre-booked') || pageText.includes('10:00'), `${label} 3h: pre-booked appointment visible in calendar`);
      await page.context().close();
    }
  }

})().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  cleanup();
  process.exit(1);
});
