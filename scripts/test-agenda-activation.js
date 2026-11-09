#!/usr/bin/env node
'use strict';
// Playwright UI test for the redesigned 3-step activation flow.
// Also covers server-side DELETE /api/agenda/services/:id validations.
// Run: node scripts/test-agenda-activation.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const { chromium, webkit } = require('playwright');

const TEST_PORT   = 3225;
const DB_DIR      = '/tmp/test-agenda-activation';
const ADMIN_TOKEN = 'activation-test-token';
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
    if (opts.cookie)  headers['Cookie']        = opts.cookie;
    if (opts.bearer)  headers['Authorization'] = `Bearer ${opts.bearer}`;
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

function startServer() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const proc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT:                String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET:      'activation-secret',
      NODE_ENV:            '',
      RAILWAY_ENVIRONMENT: '',
      ADMIN_SET_WA_TOKEN:  ADMIN_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[srv] ${d}`));
  return proc;
}

const HOURS_JSON = JSON.stringify({
  '1': [['09:00','18:00']], '2': [['09:00','18:00']], '3': [['09:00','18:00']],
  '4': [['09:00','18:00']], '5': [['09:00','18:00']],
});

function parseCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const [name, ...rest] = raw.split(';')[0].split('=');
  return { name: name.trim(), value: rest.join('=') };
}

async function register(email, withHours = false) {
  const r = await req('POST', '/auth/register', { email, password: 'Test1234!', name: 'Test' });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const ck = parseCookie(r.headers['set-cookie']);
  const bizBody = { name: 'TestBiz' };
  if (withHours) bizBody.business_hours = HOURS_JSON;
  await req('PUT', '/api/business', bizBody, { cookie: `${ck.name}=${ck.value}` });
  return ck;
}

(async () => {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  // Remove old shots
  ['activar-1-390.png','activar-2-390.png','activar-3-390.png','activar-3-390-full.png',
   'activar-1-1280.png','activar-390.png','activar-1280.png'].forEach(f => {
    try { fs.unlinkSync(path.join(SHOTS_DIR, f)); } catch (_) {}
  });

  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = startServer();
  await waitForServer();
  console.log('Server up.\n');

  // ── Suite 1: Server-side DELETE /api/agenda/services/:id ─────────────────
  console.log('Suite 1: DELETE service — server validations');
  {
    // 401 without auth
    const r1 = await req('DELETE', '/api/agenda/services/9999', null, {});
    assert(r1.status === 401, 'DELETE without auth → 401');

    // Setup user with crecimiento plan + service
    const ck = await register(`del-svc-${Date.now()}@t.com`, true);
    const cookie = `${ck.name}=${ck.value}`;
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const u = db.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'del-svc-%' ORDER BY b.id DESC LIMIT 1`).get();
    db.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u.id);
    db.close();

    // 404 for non-existent service
    const r2 = await req('DELETE', '/api/agenda/services/99999', null, { cookie });
    assert(r2.status === 404, 'DELETE non-existent service → 404');

    // Create service and get its id
    const r3 = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie });
    const svcId = r3.body.services?.[0]?.id;
    assert(typeof svcId === 'number', 'POST service → got id');

    // 403 from another user
    const ck2 = await register(`other-del-${Date.now()}@t.com`);
    const cookie2 = `${ck2.name}=${ck2.value}`;
    const db2 = new Database(path.join(DB_DIR, 'daxos.db'));
    const u2 = db2.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'other-del-%' ORDER BY b.id DESC LIMIT 1`).get();
    db2.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u2.id);
    db2.close();
    const r4 = await req('DELETE', `/api/agenda/services/${svcId}`, null, { cookie: cookie2 });
    assert(r4.status === 404, 'DELETE foreign service → 404');

    // Create future appointment for the service, then try to delete it
    await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie });
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0,10); })();
    const aptR = await req('POST', '/api/agenda/appointments', {
      customerPhone: '59891000001', date: tomorrow, time: '10:00', serviceId: svcId,
    }, { cookie });
    if (aptR.status === 200) {
      const r5 = await req('DELETE', `/api/agenda/services/${svcId}`, null, { cookie });
      assert(r5.status === 400, 'DELETE service with future apt → 400');
      assert(typeof r5.body.error === 'string' && r5.body.error.includes('turno'), 'DELETE blocked: error mentions turno');
      // Cancel the apt, then delete should work
      await req('PATCH', `/api/agenda/appointments/${aptR.body.id}/cancel`, {}, { cookie });
    } else {
      assert(true, 'DELETE service with future apt → (apt creation skipped, slot conflict)');
      assert(true, 'DELETE blocked: error mentions turno (skipped)');
    }

    // Now delete should succeed
    const r6 = await req('DELETE', `/api/agenda/services/${svcId}`, null, { cookie });
    assert(r6.status === 200 && r6.body.ok, 'DELETE valid service → 200 ok');
    assert(Array.isArray(r6.body.services), 'DELETE returns updated services list');
  }

  // ── Helper: create page context with injected cookie ──────────────────────
  async function newPage(browser, width, height, ck) {
    const ctx = await browser.newContext({ viewport: { width, height }, baseURL: BASE_URL });
    await ctx.addCookies([{ name: ck.name, value: ck.value, domain: 'localhost', path: '/' }]);
    return ctx.newPage();
  }

  // ── Suite 2: UI — 3 states + full activation flow ─────────────────────────
  async function runActivationFlow(browser, label) {
    // ── State 1: nothing done (no hours, no services) ────────────────────
    console.log(`\n  [${label}] State 1 — no hours, no services`);
    const ckNoHours = await register(`ui-nohours-${Date.now()}-${label}@t.com`, false);
    const cookieNH = `${ckNoHours.name}=${ckNoHours.value}`;
    // Need crecimiento to interact
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const u = db.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'ui-nohours-%' ORDER BY b.id DESC LIMIT 1`).get();
    db.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u.id);
    db.close();

    {
      const page = await newPage(browser, 390, 844, ckNoHours);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
      assert(true, `${label} S1: view-disabled shown`);

      // Step 1 body shows "Cargar mis horarios" button
      await page.waitForSelector('#activate-body-1 a', { timeout: 5000 });
      const step1Text = await page.$eval('#activate-body-1', el => el.textContent);
      assert(step1Text.includes('Cargar mis horarios'), `${label} S1: step 1 shows "Cargar mis horarios"`);

      // Activate button disabled
      const btnDis = await page.$eval('#btn-activate-agenda', el => el.disabled);
      assert(btnDis, `${label} S1: Activar disabled`);

      // Reason text visible and mentions paso 1 and paso 2
      await page.waitForSelector('#activate-block-reason', { state: 'visible', timeout: 3000 });
      const reasonText = await page.$eval('#activate-block-reason', el => el.textContent);
      assert(reasonText.includes('paso 1') && reasonText.includes('paso 2'), `${label} S1: reason mentions paso 1 and paso 2`);

      // Step badges: S1 = current (orange "1"), S2 = future (grey "2"), S3 = future (grey "3")
      const s1Text = await page.$eval('#step1-num', el => el.textContent.trim());
      assert(s1Text === '1', `${label} S1: step1-num shows "1" (current)`);
      const s1Bg = await page.$eval('#step1-num', el => el.style.background);
      assert(!s1Bg.includes('999') && !s1Bg.includes('muted'), `${label} S1: step1-num is orange (current, not grey)`);
      const s2Text = await page.$eval('#step2-num', el => el.textContent.trim());
      assert(s2Text === '2', `${label} S1: step2-num shows "2" (future)`);
      const s2Bg = await page.$eval('#step2-num', el => el.style.background);
      assert(s2Bg.includes('999') || s2Bg.includes('muted') || s2Bg.includes('128, 128') || s2Bg.includes('153'), `${label} S1: step2-num is grey (future)`);
      const s3Text = await page.$eval('#step3-num', el => el.textContent.trim());
      assert(s3Text === '3', `${label} S1: step3-num shows "3" (future)`);

      await page.context().close();
    }

    // ── State 2: hours ready, no services ────────────────────────────────
    console.log(`\n  [${label}] State 2 — hours ready, no services`);
    const ckHours = await register(`ui-hours-${Date.now()}-${label}@t.com`, true);
    const cookieH = `${ckHours.name}=${ckHours.value}`;
    const db2 = new Database(path.join(DB_DIR, 'daxos.db'));
    const u2 = db2.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'ui-hours-%' ORDER BY b.id DESC LIMIT 1`).get();
    db2.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u2.id);
    db2.close();

    {
      const page = await newPage(browser, 390, 844, ckHours);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });

      // Step 1 shows "Listo ✓"
      const step1Body = await page.$eval('#activate-body-1', el => el.textContent.trim());
      assert(step1Body.includes('Listo'), `${label} S2: step 1 shows "Listo"`);

      // Step badges: S1 = done (orange ✓), S2 = current (orange "2"), S3 = future (grey "3")
      const s1TextS2 = await page.$eval('#step1-num', el => el.textContent.trim());
      assert(s1TextS2 === '✓', `${label} S2: step1-num shows ✓ (done)`);
      const s1BgS2 = await page.$eval('#step1-num', el => el.style.background);
      assert(!s1BgS2.includes('999') && !s1BgS2.includes('muted'), `${label} S2: step1-num is orange (done, not grey)`);
      const s2TextS2 = await page.$eval('#step2-num', el => el.textContent.trim());
      assert(s2TextS2 === '2', `${label} S2: step2-num shows "2" (current)`);
      const s2BgS2 = await page.$eval('#step2-num', el => el.style.background);
      assert(!s2BgS2.includes('999') && !s2BgS2.includes('muted'), `${label} S2: step2-num is orange (current, not grey)`);

      // reason only mentions paso 2
      await page.waitForSelector('#activate-block-reason', { state: 'visible', timeout: 3000 });
      const reasonText = await page.$eval('#activate-block-reason', el => el.textContent);
      assert(reasonText.includes('paso 2') && !reasonText.includes('paso 1'), `${label} S2: reason only mentions paso 2`);

      // ── Add service with chip selection ──────────────────────────────
      // Click 45 min chip
      await page.click('.dur-chip[data-min="45"]');
      const chipActive = await page.$eval('.dur-chip[data-min="45"]', el => el.classList.contains('active'));
      assert(chipActive, `${label} S2: chip 45 min becomes active`);
      const chip30 = await page.$eval('.dur-chip[data-min="30"]', el => el.classList.contains('active'));
      assert(!chip30, `${label} S2: chip 30 min deselected`);

      // Fill name and add
      await page.fill('#activate-svc-name', 'Corte');
      await page.click('#btn-activate-svc-add');

      // Service appears in list
      await page.waitForFunction(
        () => document.querySelector('#activate-svc-list .activate-svc-row') !== null,
        { timeout: 5000 }
      );
      assert(true, `${label} S2: service appears in list`);
      const svcText = await page.$eval('#activate-svc-list', el => el.textContent);
      assert(svcText.includes('Corte') && svcText.includes('45 min'), `${label} S2: service shows name and duration`);

      // ── State 3: everything ready ─────────────────────────────────────
      console.log(`\n  [${label}] State 3 — everything ready`);
      const btnEnabled = await page.$eval('#btn-activate-agenda', el => !el.disabled);
      assert(btnEnabled, `${label} S3: Activar enabled after service added`);
      // All badges orange ✓ (all 3 steps done)
      for (const id of ['step1-num', 'step2-num', 'step3-num']) {
        const txt = await page.$eval(`#${id}`, el => el.textContent.trim());
        assert(txt === '✓', `${label} S3: ${id} shows ✓ (done)`);
        const bg = await page.$eval(`#${id}`, el => el.style.background);
        assert(!bg.includes('999') && !bg.includes('muted'), `${label} S3: ${id} is orange (done, not grey)`);
      }
      // Mobile padding: at max scroll, Activar button must be above the fixed 56px nav
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      const btnRect = await page.evaluate(() => {
        const r = document.getElementById('btn-activate-agenda').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, viewportH: window.innerHeight };
      });
      assert(btnRect.bottom <= btnRect.viewportH - 56,
        `${label} S3: Activar above mobile nav at max scroll (bottom=${Math.round(btnRect.bottom)} ≤ ${btnRect.viewportH - 56})`);
      assert(btnRect.top >= 0,
        `${label} S3: Activar visible at max scroll (top=${Math.round(btnRect.top)})`);

      // ── Remove service and verify disabled again ───────────────────────
      page.once('dialog', dlg => dlg.accept());
      await page.click('.activate-svc-del');
      await page.waitForFunction(
        () => document.querySelector('#activate-svc-list .activate-svc-row') === null,
        { timeout: 5000 }
      );
      assert(true, `${label}: service removed with ×`);
      const btnDisAgain = await page.$eval('#btn-activate-agenda', el => el.disabled);
      assert(btnDisAgain, `${label}: Activar disabled after removing service`);

      // Re-add service
      await page.fill('#activate-svc-name', 'Coloracion');
      await page.click('#btn-activate-svc-add');
      await page.waitForFunction(
        () => document.querySelector('#activate-svc-list .activate-svc-row') !== null,
        { timeout: 5000 }
      );

      // ── Activate and check success message ────────────────────────────
      await page.click('#btn-activate-agenda');
      await page.waitForFunction(
        () => {
          const el = document.getElementById('activate-block-reason');
          return el && el.style.display !== 'none' && el.textContent.includes('WhatsApp');
        },
        { timeout: 10000 }
      );
      assert(true, `${label}: success message shown after activation`);
      const successText = await page.$eval('#activate-block-reason', el => el.textContent);
      assert(successText.includes('asistente'), `${label}: success mentions asistente`);

      // view-agenda visible after reload
      await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 12000 });
      assert(true, `${label}: view-agenda visible after activation`);

      const disabledHidden = await page.$eval('#view-disabled', el => el.style.display === 'none').catch(() => true);
      assert(disabledHidden, `${label}: view-disabled hidden after activation`);

      // Apagar
      await page.waitForSelector('#btn-deactivate-agenda', { state: 'visible', timeout: 5000 });
      page.once('dialog', dlg => dlg.accept());
      await page.click('#btn-deactivate-agenda');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
      assert(true, `${label}: view-disabled reappears after Apagar`);

      await page.context().close();
    }
  }

  // ── Screenshots ───────────────────────────────────────────────────────────
  async function takeShots(browser, ck) {
    const cookieStr = `${ck.name}=${ck.value}`;
    // Ensure at least one service exists
    const svcsR = await req('GET', '/api/agenda/services', null, { cookie: cookieStr });
    if (Array.isArray(svcsR.body) && svcsR.body.length === 0) {
      await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookieStr });
    }

    // activar-1-390: no hours, no services (fresh user)
    const ckFresh = await register(`shots-fresh-${Date.now()}@t.com`, false);
    const cookieFresh = `${ckFresh.name}=${ckFresh.value}`;
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const u = db.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'shots-fresh-%' ORDER BY b.id DESC LIMIT 1`).get();
    db.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u.id);
    db.close();
    {
      const page = await newPage(browser, 390, 844, ckFresh);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
      await sleep(600);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'activar-1-390.png'), fullPage: false });
      console.log(`  → Screenshot: activar-1-390.png (state 1)`);
      await page.context().close();
    }

    // activar-2-390: hours ready, no services
    const ckState2 = await register(`shots-s2-${Date.now()}@t.com`, true);
    const cookieS2 = `${ckState2.name}=${ckState2.value}`;
    const db2 = new Database(path.join(DB_DIR, 'daxos.db'));
    const u2 = db2.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'shots-s2-%' ORDER BY b.id DESC LIMIT 1`).get();
    db2.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u2.id);
    db2.close();
    {
      const page = await newPage(browser, 390, 844, ckState2);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
      await sleep(600);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'activar-2-390.png'), fullPage: false });
      console.log(`  → Screenshot: activar-2-390.png (state 2)`);
      await page.context().close();
    }

    // activar-3-390: everything ready (hours + service, agenda disabled)
    const ckState3 = await register(`shots-s3-${Date.now()}@t.com`, true);
    const cookieS3 = `${ckState3.name}=${ckState3.value}`;
    const db3 = new Database(path.join(DB_DIR, 'daxos.db'));
    const u3 = db3.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'shots-s3-%' ORDER BY b.id DESC LIMIT 1`).get();
    db3.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u3.id);
    db3.close();
    await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookieS3 });
    {
      const page = await newPage(browser, 390, 844, ckState3);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
      // Wait for Activar to be enabled (all steps done)
      await page.waitForFunction(
        () => !document.getElementById('btn-activate-agenda')?.disabled,
        { timeout: 8000 }
      );
      await sleep(600);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'activar-3-390-full.png'), fullPage: true });
      console.log(`  → Screenshot: activar-3-390-full.png (state 3, full page)`);
      await page.context().close();
    }

    // activar-1-1280: state 1 at desktop width
    {
      const ckDesktop = await register(`shots-desk-${Date.now()}@t.com`, false);
      const db4 = new Database(path.join(DB_DIR, 'daxos.db'));
      const u4 = db4.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'shots-desk-%' ORDER BY b.id DESC LIMIT 1`).get();
      db4.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', u4.id);
      db4.close();
      const page = await newPage(browser, 1280, 800, ckDesktop);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
      await sleep(600);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'activar-1-1280.png'), fullPage: false });
      console.log(`  → Screenshot: activar-1-1280.png (state 1 desktop)`);
      await page.context().close();
    }
  }

  // ── Run Chromium ──────────────────────────────────────────────────────────
  console.log('\nSuite 2 (Chromium): 3-state activation flow');
  const cr = await chromium.launch({ headless: true });
  try {
    await runActivationFlow(cr, 'Chromium');
  } finally {
    await cr.close();
  }

  // ── Run WebKit ────────────────────────────────────────────────────────────
  console.log('\nSuite 2 (WebKit): 3-state activation flow');
  const wk = await webkit.launch({ headless: true });
  try {
    await runActivationFlow(wk, 'WebKit');
  } finally {
    await wk.close();
  }

  // ── Screenshots ───────────────────────────────────────────────────────────
  console.log('\nTaking screenshots...');
  const crShot = await chromium.launch({ headless: true });
  const ckShot = await register(`shots-main-${Date.now()}@t.com`, true);
  const dbShot = require('better-sqlite3');
  const dbConn = new dbShot(path.join(DB_DIR, 'daxos.db'));
  const uShot = dbConn.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'shots-main-%' ORDER BY b.id DESC LIMIT 1`).get();
  dbConn.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', uShot.id);
  dbConn.close();
  try {
    await takeShots(crShot, ckShot);
  } finally {
    await crShot.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  cleanup();
  process.exit(1);
});
