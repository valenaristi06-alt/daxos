#!/usr/bin/env node
'use strict';
// Agenda API tests.
// Run: node scripts/test-agenda-api.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT       = 3099;
const DB_DIR          = '/tmp/test-agenda-api';
const ADMIN_TOKEN     = 'agenda-api-test-token';
const BASE_URL        = `http://localhost:${TEST_PORT}`;

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
      SESSION_SECRET:      'agenda-api-test-secret',
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

async function register(email, pass) {
  const r = await req('POST', '/auth/register', { email, password: pass, name: 'Test' });
  if (r.status !== 200) throw new Error(`register failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.headers['set-cookie']?.[0]?.split(';')[0];
}

const HOURS_JSON = JSON.stringify({
  '1': [['09:00', '18:00']],
  '2': [['09:00', '18:00']],
  '3': [['09:00', '18:00']],
  '4': [['09:00', '18:00']],
  '5': [['09:00', '18:00']],
});

async function setupBizWithHours(cookie, withHours = true) {
  const r = await req('PUT', '/api/business', {
    name: 'TestBiz',
    business_hours: withHours ? HOURS_JSON : null,
  }, { cookie });
  if (r.status !== 200) throw new Error(`setupBizWithHours failed: ${JSON.stringify(r.body)}`);
}

async function setPlan(email, plan) {
  const r = await req('POST', '/admin/set-plan', { email, plan }, { bearer: ADMIN_TOKEN });
  if (r.status !== 200) throw new Error(`setPlan(${email}, ${plan}) failed: ${JSON.stringify(r.body)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = startServer();
  await waitForServer();
  console.log('Server up.\n');

  // ── Suite 1: GET validation — invalid dates, range limits ────────────────

  console.log('Suite 1: GET /api/agenda/appointments — validation');
  const cookieA = await register('agenda-a@test.com', 'AgendaA1!');
  await setupBizWithHours(cookieA);
  await setPlan('agenda-a@test.com', 'crecimiento');
  await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookieA });

  {
    const r = await req('GET', '/api/agenda/appointments?from=bad-date&to=2026-11-10', null, { cookie: cookieA });
    assert(r.status === 400, 'invalid from date → 400');
  }
  {
    const r = await req('GET', '/api/agenda/appointments?from=2026-11-01&to=bad-date', null, { cookie: cookieA });
    assert(r.status === 400, 'invalid to date → 400');
  }
  {
    const r = await req('GET', '/api/agenda/appointments?from=2026-11-01&to=2027-02-01', null, { cookie: cookieA });
    assert(r.status === 400, 'range > 62 days → 400');
    assert(typeof r.body?.error === 'string' && r.body.error.includes('62'), 'error mentions 62 days');
  }
  {
    const r = await req('GET', '/api/agenda/appointments?from=2026-11-10&to=2026-11-01', null, { cookie: cookieA });
    assert(r.status === 400, 'reversed range (to < from) → 400');
  }
  {
    const r = await req('GET', '/api/agenda/appointments?from=2026-11-01&to=2026-12-31', null, { cookie: cookieA });
    assert(r.status === 200, 'valid 60-day range → 200');
    assert(Array.isArray(r.body), 'returns array');
  }
  {
    const r = await req('GET', '/api/agenda/appointments?date=not-a-date', null, { cookie: cookieA });
    assert(r.status === 400, 'invalid single date → 400');
  }

  // ── Suite 2: data isolation — each business sees only its own appointments ─

  console.log('\nSuite 2: Data isolation — GET only returns own appointments');
  const cookieB = await register('agenda-b@test.com', 'AgendaB1!');
  await setupBizWithHours(cookieB);
  await setPlan('agenda-b@test.com', 'crecimiento');
  await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookieB });

  // Create appointment for A
  const aptResA = await req('POST', '/api/agenda/appointments', {
    customerPhone: '+59899000001', clientName: 'ClientA', date: '2026-12-01', time: '10:00',
  }, { cookie: cookieA });
  assert(aptResA.status === 200, 'bizA creates appointment');

  // B queries the same date — should not see A's appointment
  const rB = await req('GET', '/api/agenda/appointments?date=2026-12-01', null, { cookie: cookieB });
  assert(rB.status === 200, 'bizB GET date → 200');
  assert(Array.isArray(rB.body) && rB.body.length === 0, 'bizB sees no appointments from bizA');

  // A queries — sees its own
  const rA = await req('GET', '/api/agenda/appointments?date=2026-12-01', null, { cookie: cookieA });
  assert(rA.status === 200 && Array.isArray(rA.body) && rA.body.length === 1, 'bizA sees its own appointment');

  // ── Suite 3: plan gating — write routes 403 on insufficient plan ──────────

  console.log('\nSuite 3: Plan gating — write routes return 403 when plan insufficient');
  const cookieC = await register('agenda-c@test.com', 'AgendaC1!');
  await setupBizWithHours(cookieC, false); // no hours; plan stays arranque

  {
    const r = await req('POST', '/api/agenda/services', { name: 'Test', duration_min: 30 }, { cookie: cookieC });
    assert(r.status === 403, 'POST services → 403 on arranque plan');
  }
  {
    const r = await req('POST', '/api/agenda/appointments', {
      customerPhone: '+59899000002', date: '2026-12-01', time: '11:00',
    }, { cookie: cookieC });
    assert(r.status === 403, 'POST appointments → 403 on arranque plan');
  }
  {
    const r = await req('PATCH', '/api/agenda/appointments/9999/cancel', {}, { cookie: cookieC });
    assert(r.status === 403, 'PATCH cancel → 403 on arranque plan');
  }
  {
    const r = await req('PATCH', '/api/agenda/appointments/9999/reschedule', { date: '2026-12-02', time: '10:00' }, { cookie: cookieC });
    assert(r.status === 403, 'PATCH reschedule → 403 on arranque plan');
  }
  // GET still works on any plan
  {
    const r = await req('GET', '/api/agenda/appointments?date=2026-12-01', null, { cookie: cookieC });
    assert(r.status === 200, 'GET appointments → 200 on any plan (read-only ok)');
  }

  // ── Suite 4: agenda disabled — write routes 403 ────────────────────────────

  console.log('\nSuite 4: Agenda disabled — writes blocked');
  const cookieD = await register('agenda-d@test.com', 'AgendaD1!');
  await setupBizWithHours(cookieD);
  await setPlan('agenda-d@test.com', 'crecimiento');
  // Don't enable agenda (remains disabled by default)

  {
    const r = await req('POST', '/api/agenda/appointments', {
      customerPhone: '+59899000003', date: '2026-12-01', time: '10:00',
    }, { cookie: cookieD });
    assert(r.status === 403, 'POST appointments → 403 when agenda disabled');
  }
  {
    const r = await req('PATCH', '/api/agenda/appointments/9999/cancel', {}, { cookie: cookieD });
    assert(r.status === 403, 'PATCH cancel → 403 when agenda disabled');
  }
  {
    const r = await req('PATCH', '/api/agenda/appointments/9999/reschedule', { date: '2026-12-02', time: '10:00' }, { cookie: cookieD });
    assert(r.status === 403, 'PATCH reschedule → 403 when agenda disabled');
  }
  // GET still works when agenda disabled
  {
    const r = await req('GET', '/api/agenda/appointments?date=2026-12-01', null, { cookie: cookieD });
    assert(r.status === 200, 'GET appointments → 200 when agenda disabled (read-only)');
  }

  // ── Suite 5: block activation without business hours ──────────────────────

  console.log('\nSuite 5: Block activation without business hours');
  // Use cookieA (crecimiento plan, agenda currently enabled). Remove hours then try to re-enable.
  await req('PUT', '/api/business', { name: 'TestBiz', business_hours: null }, { cookie: cookieA });
  const rEnable = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookieA });
  assert(rEnable.status === 400, 'enabling agenda without business_hours → 400');
  assert(rEnable.body?.code === 'NO_BUSINESS_HOURS', 'error code is NO_BUSINESS_HOURS');

  // Restore hours and re-enable so later suites work
  await req('PUT', '/api/business', { name: 'TestBiz', business_hours: HOURS_JSON }, { cookie: cookieA });
  await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookieA });

  // ── Suite 6: wa_notify_status stored correctly ────────────────────────────

  console.log('\nSuite 6: wa_notify_status and wa_notify_reason column');
  {
    const Database = require('better-sqlite3');
    const dbPath = require('path').join(DB_DIR, 'daxos.db');
    const rawDb = new Database(dbPath, { readonly: true });
    const cols = rawDb.pragma('table_info(agenda_appointments)').map(c => c.name);
    rawDb.close();
    assert(cols.includes('wa_notify_status'),   'agenda_appointments has wa_notify_status');
    assert(cols.includes('wa_notify_reason'),   'agenda_appointments has wa_notify_reason');
    assert(cols.includes('client_notified_at'), 'agenda_appointments has client_notified_at');
    assert(cols.includes('owner_notified_at'),  'agenda_appointments has owner_notified_at');
  }

  // Create apt (no WA creds in test — status stays null, no crash)
  const aptResB = await req('POST', '/api/agenda/appointments', {
    customerPhone: '+59899000011', clientName: 'WaTest', date: '2026-12-05', time: '10:00',
  }, { cookie: cookieA });
  assert(aptResB.status === 200, 'create apt for notify-status test → 200');
  assert(aptResB.body?.id > 0, 'returned appointment has id');

  const rGet2 = await req('GET', '/api/agenda/appointments?date=2026-12-05', null, { cookie: cookieA });
  assert(Array.isArray(rGet2.body), 'GET date returns array');
  const foundApt = Array.isArray(rGet2.body) ? rGet2.body.find(a => a.id === aptResB.body?.id) : null;
  assert(!!foundApt, 'appointment retrievable after creation');
  assert('wa_notify_status' in (foundApt || {}), 'wa_notify_status field returned in GET');
  assert('wa_notify_reason' in (foundApt || {}), 'wa_notify_reason field returned in GET');

  // ── Suite 7: cancel a confirmed appointment ───────────────────────────────

  console.log('\nSuite 7: Cancel appointment');
  const aptResCancel = await req('POST', '/api/agenda/appointments', {
    customerPhone: '+59899000020', clientName: 'ToCancel', date: '2026-12-10', time: '14:00',
  }, { cookie: cookieA });
  assert(aptResCancel.status === 200, 'create apt for cancel test');

  const cancelRes = await req('PATCH', `/api/agenda/appointments/${aptResCancel.body?.id}/cancel`, {}, { cookie: cookieA });
  assert(cancelRes.status === 200, 'cancel existing confirmed apt → 200');

  // Double-cancel same apt
  const cancelAgain = await req('PATCH', `/api/agenda/appointments/${aptResCancel.body?.id}/cancel`, {}, { cookie: cookieA });
  assert(cancelAgain.status === 409, 'double-cancel → 409');

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
