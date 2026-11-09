#!/usr/bin/env node
'use strict';
// Playwright UI test for the self-service agenda activation flow.
// Covers: disabled state, inline service form, activate, apagar, appointments preserved.
// Also saves screenshots to /tmp/agenda-shots/.
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
  const pair = raw.split(';')[0];
  const [name, ...rest] = pair.split('=');
  return { name: name.trim(), value: rest.join('=') };
}

async function register(email) {
  const r = await req('POST', '/auth/register', { email, password: 'Test1234!', name: 'Test' });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  return parseCookie(r.headers['set-cookie']);
}

(async () => {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = startServer();
  await waitForServer();
  console.log('Server up.\n');

  // Setup: register user, set business with hours but NO services
  const ck = await register('activation-ui@test.com');
  await req('PUT', '/api/business', { name: 'UI Test Biz', business_hours: HOURS_JSON }, { cookie: `${ck.name}=${ck.value}` });

  // ── Helper: create page context with injected session cookie ──────────────
  async function newPage(browser, width, height) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      baseURL: BASE_URL,
    });
    await ctx.addCookies([{
      name:   ck.name,
      value:  ck.value,
      domain: 'localhost',
      path:   '/',
    }]);
    return ctx.newPage();
  }

  // ── Shared activation flow test ───────────────────────────────────────────
  async function runActivationFlow(browser, label) {
    const page = await newPage(browser, 390, 844);

    console.log(`\n  [${label}] Activation flow`);

    await page.goto('/agenda.html');

    // view-disabled should appear (not view-agenda)
    await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
    assert(true, `${label}: view-disabled shown`);
    const agendaHidden = await page.$eval('#view-agenda', el => el.style.display === 'none' || !el.offsetParent).catch(() => true);
    assert(agendaHidden, `${label}: view-agenda not visible`);

    // Activar button disabled
    const btnDisabled = await page.$eval('#btn-activate-agenda', el => el.disabled);
    assert(btnDisabled, `${label}: Activar button disabled`);

    // Reason text visible and mentions servicio
    const reasonVisible = await page.$eval('#activate-block-reason', el => el.style.display !== 'none' && el.textContent.trim() !== '');
    assert(reasonVisible, `${label}: block reason visible`);
    const reasonText = await page.$eval('#activate-block-reason', el => el.textContent);
    assert(reasonText.toLowerCase().includes('servicio'), `${label}: reason mentions servicio`);

    // step-service-check shows ○ (not done)
    const svcCheck = await page.$eval('#step-service-check', el => el.textContent.trim());
    assert(svcCheck === '○', `${label}: step-service-check shows ○`);

    // Fill inline service form and submit
    await page.locator('#activate-svc-name').scrollIntoViewIfNeeded();
    await page.fill('#activate-svc-name', 'Corte de pelo');
    await page.fill('#activate-svc-dur', '30');
    await page.locator('#btn-activate-svc-add').scrollIntoViewIfNeeded();
    await page.click('#btn-activate-svc-add', { force: true });

    // Wait for step-service-check to become ✓
    await page.waitForFunction(
      () => document.getElementById('step-service-check')?.textContent.trim() === '✓',
      { timeout: 5000 }
    );
    assert(true, `${label}: step-service-check → ✓ after adding service`);

    // Activar button now enabled
    const btnEnabled = await page.$eval('#btn-activate-agenda', el => !el.disabled);
    assert(btnEnabled, `${label}: Activar button enabled after service`);

    // Click Activar
    await page.click('#btn-activate-agenda');

    // Wait for view-agenda to appear (page reloads)
    await page.waitForSelector('#view-agenda', { state: 'visible', timeout: 10000 });
    assert(true, `${label}: view-agenda visible after activation`);

    const disabledHidden = await page.$eval('#view-disabled', el => el.style.display === 'none').catch(() => true);
    assert(disabledHidden, `${label}: view-disabled hidden after activation`);

    // Create an appointment via API so we can verify it survives deactivation
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo' }).format(new Date());
    const aptR = await req('POST', '/api/agenda/appointments', {
      customerPhone: '+59891234567', date: today, time: '10:00',
    }, { cookie: `${ck.name}=${ck.value}` });
    // Appointment may succeed or clash if already created from prior browser run — either is ok
    const aptCreated = aptR.status === 200 || aptR.status === 409;
    assert(aptCreated, `${label}: appointment created (or already exists)`);

    // Apagar button should be visible in view-agenda toolbar
    await page.waitForSelector('#btn-deactivate-agenda', { state: 'visible', timeout: 5000 });
    assert(true, `${label}: Apagar button visible in agenda`);

    // Handle the confirm dialog that Apagar shows
    page.once('dialog', dialog => dialog.accept());
    await page.click('#btn-deactivate-agenda');

    // view-disabled should reappear
    await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
    assert(true, `${label}: view-disabled reappears after Apagar`);

    // Appointments still exist in the DB
    const listR = await req('GET', `/api/agenda/appointments?date=${today}`, null, { cookie: `${ck.name}=${ck.value}` });
    assert(listR.status === 200, `${label}: GET appointments still returns 200 after deactivation`);
    assert(Array.isArray(listR.body) && listR.body.length > 0, `${label}: appointments preserved after deactivation`);

    await page.context().close();

    // Re-enable for next browser run (service already exists)
    await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: `${ck.name}=${ck.value}` });
  }

  // ── Screenshots ───────────────────────────────────────────────────────────
  async function takeShots(browser, label) {
    for (const [w, h, name] of [[390, 844, 'activar-390.png'], [1280, 800, 'activar-1280.png']]) {
      // Deactivate so view-disabled shows
      await req('PATCH', '/api/business/agenda-enabled', { enabled: false }, { cookie: `${ck.name}=${ck.value}` });

      const page = await newPage(browser, w, h);
      await page.goto('/agenda.html');
      await page.waitForSelector('#view-disabled', { state: 'visible', timeout: 8000 });
      await sleep(600); // let fonts/icons settle

      const shotPath = path.join(SHOTS_DIR, name);
      await page.screenshot({ path: shotPath, fullPage: false });
      console.log(`  → Screenshot saved: ${shotPath}`);
      await page.context().close();

      // Re-enable for next iteration
      await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: `${ck.name}=${ck.value}` });
    }
  }

  // ── Run Chromium ──────────────────────────────────────────────────────────
  console.log('Suite: Chromium — activation flow');
  const cr = await chromium.launch({ headless: true });
  try {
    // First make sure agenda is disabled and no services
    await req('PATCH', '/api/business/agenda-enabled', { enabled: false }, { cookie: `${ck.name}=${ck.value}` });
    // Delete any services from prior runs
    const svcsR = await req('GET', '/api/agenda/services', null, { cookie: `${ck.name}=${ck.value}` });
    if (Array.isArray(svcsR.body)) {
      for (const s of svcsR.body) await req('DELETE', `/api/agenda/services/${s.id}`, null, { cookie: `${ck.name}=${ck.value}` });
    }
    await runActivationFlow(cr, 'Chromium');
  } finally {
    await cr.close();
  }

  // ── WebKit ────────────────────────────────────────────────────────────────
  console.log('\nSuite: WebKit — activation flow');
  const wk = await webkit.launch({ headless: true });
  try {
    // Reset: disable, delete services
    await req('PATCH', '/api/business/agenda-enabled', { enabled: false }, { cookie: `${ck.name}=${ck.value}` });
    const svcsR2 = await req('GET', '/api/agenda/services', null, { cookie: `${ck.name}=${ck.value}` });
    if (Array.isArray(svcsR2.body)) {
      for (const s of svcsR2.body) await req('DELETE', `/api/agenda/services/${s.id}`, null, { cookie: `${ck.name}=${ck.value}` });
    }
    await runActivationFlow(wk, 'WebKit');
  } finally {
    await wk.close();
  }

  // ── Screenshots (Chromium) ────────────────────────────────────────────────
  console.log('\nTaking screenshots...');
  const crShot = await chromium.launch({ headless: true });
  try {
    // Deactivate so view-disabled shows
    await req('PATCH', '/api/business/agenda-enabled', { enabled: false }, { cookie: `${ck.name}=${ck.value}` });
    // Keep one service so step-hours✓ step-service○ shows (most informative state)
    // → delete all services so form is shown
    const svcsR3 = await req('GET', '/api/agenda/services', null, { cookie: `${ck.name}=${ck.value}` });
    if (Array.isArray(svcsR3.body)) {
      for (const s of svcsR3.body) await req('DELETE', `/api/agenda/services/${s.id}`, null, { cookie: `${ck.name}=${ck.value}` });
    }
    await takeShots(crShot, 'Chromium');
  } finally {
    await crShot.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('FATAL:', err.message);
  cleanup();
  process.exit(1);
});
