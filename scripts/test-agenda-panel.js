#!/usr/bin/env node
'use strict';
// Panel agenda API tests (no AI calls, no WA sends)
// Run: node scripts/test-agenda-panel.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT   = 3097;
const DB_DIR      = '/tmp/test-agenda-panel';
const BASE_URL    = `http://localhost:${TEST_PORT}`;
const ADMIN_TOKEN = 'panel-test-token';

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

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

function startServer() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const proc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT:             String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET:   'ap-test-secret',
      NODE_ENV:            '',
      RAILWAY_ENVIRONMENT: '',
      ENABLE_RATE_LIMIT:   'true',
      ADMIN_SET_WA_TOKEN:  ADMIN_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  return proc;
}

async function setAccess(value) {
  await req('POST', '/admin/api/runtime-config/agenda_access', { value }, { bearer: ADMIN_TOKEN });
}

async function registerUser(email, pass = 'UserPass1!') {
  const r = await req('POST', '/auth/register', { email, password: pass },
    { xff: `9.9.9.${Math.floor(Math.random() * 200) + 10}` });
  if (r.status !== 200) throw new Error(`register ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.headers['set-cookie']?.[0]?.split(';')[0];
}

async function main() {
  serverProc = startServer();
  await waitForServer();
  await sleep(200);

  const Database = require('better-sqlite3');

  // Set access=paid so plan-gating tests get 403 for arranque
  await setAccess('paid');

  // ── Suite 1: Plan gating ──────────────────────────────────────────────────
  console.log('\nSuite 1: Plan gating — arranque cannot write agenda');
  {
    const cookie = await registerUser(`arranque-${Date.now()}@t.com`);
    await req('PUT', '/api/business', { name: 'ArranqueBiz' }, { cookie });
    // By default plan is arranque (trial) — check that write routes return 403
    const r1 = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie });
    assert(r1.status === 403, 'agenda-enabled: arranque → 403');
    const r2 = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie });
    assert(r2.status === 403, 'POST /api/agenda/services: arranque → 403');
    const r3 = await req('POST', '/api/agenda/appointments', { customerPhone: '59891000000', date: '2026-12-01', time: '10:00' }, { cookie });
    assert(r3.status === 403, 'POST /api/agenda/appointments: arranque → 403');
    // GET appointments is allowed (read-only survives downgrades)
    const r4 = await req('GET', '/api/agenda/appointments?date=2026-12-01', null, { cookie });
    assert(r4.status === 200, 'GET /api/agenda/appointments: arranque → 200 (read-only)');
  }

  // Reset access to default before subsequent suites
  await setAccess('');

  // ── Suite 2: Upgrade plan, enable agenda, CRUD services ──────────────────
  console.log('\nSuite 2: Crecimiento plan — services CRUD');
  let bizId, cookie2;
  {
    cookie2 = await registerUser(`crecimiento-${Date.now()}@t.com`);
    await req('PUT', '/api/business', { name: 'CrecBiz' }, { cookie: cookie2 });

    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const u  = db.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'crecimiento-%' ORDER BY b.id DESC LIMIT 1`).get();
    bizId = u.id;
    db.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', bizId);
    // Set business_hours so agenda can be enabled
    db.prepare("UPDATE businesses SET business_hours = ? WHERE id = ?").run(
      JSON.stringify({ 1:[['09:00','18:00']], 2:[['09:00','18:00']], 3:[['09:00','18:00']], 4:[['09:00','18:00']], 5:[['09:00','18:00']] }),
      bizId
    );
    db.close();

    // Create a temp service to satisfy the activation requirement (deleted after enable)
    const tmpR = await req('POST', '/api/agenda/services', { name: '_setup', duration_min: 1 }, { cookie: cookie2 });
    const tmpSvcId = tmpR.body.services?.[0]?.id;

    // Enable agenda
    const r1 = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookie2 });
    assert(r1.status === 200 && r1.body.agenda_enabled === true, 'agenda-enabled: crecimiento → 200');

    // Remove the temp service so the CRUD test starts from an empty list
    if (tmpSvcId) await req('DELETE', `/api/agenda/services/${tmpSvcId}`, null, { cookie: cookie2 });

    // Set cancel_min_before
    const r2 = await req('PATCH', '/api/business/agenda-cancel-min', { minutes: 60 }, { cookie: cookie2 });
    assert(r2.status === 200 && r2.body.agenda_cancel_min_before === 60, 'agenda-cancel-min → 200');

    // GET services (empty)
    const r3 = await req('GET', '/api/agenda/services', null, { cookie: cookie2 });
    assert(r3.status === 200 && Array.isArray(r3.body) && r3.body.length === 0, 'GET services: empty array');

    // POST service
    const r4 = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookie2 });
    assert(r4.status === 200 && r4.body.services?.length === 1, 'POST service: created');
    const svcId = r4.body.services[0]?.id;

    // POST second service
    const r5 = await req('POST', '/api/agenda/services', { name: 'Coloración', duration_min: 120 }, { cookie: cookie2 });
    assert(r5.status === 200 && r5.body.services?.length === 2, 'POST second service: 2 total');

    // DELETE service
    const r6 = await req('DELETE', `/api/agenda/services/${svcId}`, null, { cookie: cookie2 });
    assert(r6.status === 200 && r6.body.ok, 'DELETE service → ok');
    const r7 = await req('GET', '/api/agenda/services', null, { cookie: cookie2 });
    assert(r7.status === 200 && r7.body.length === 1, 'After DELETE: 1 service left');
  }

  // ── Suite 3: Appointments CRUD ────────────────────────────────────────────
  console.log('\nSuite 3: Appointments CRUD (no WA — no credentials set)');
  {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo' }).format(new Date());

    // GET appointments (empty)
    const r1 = await req('GET', `/api/agenda/appointments?date=${today}`, null, { cookie: cookie2 });
    assert(r1.status === 200 && Array.isArray(r1.body), 'GET appointments for today: array');

    // POST appointment
    const r2 = await req('POST', '/api/agenda/appointments', {
      customerPhone: '59891234567', clientName: 'Test Cliente', date: today, time: '10:00',
    }, { cookie: cookie2 });
    assert(r2.status === 200 && r2.body.id, 'POST appointment: created');
    const aptId = r2.body.id;

    // GET — should see the appointment now
    const r3 = await req('GET', `/api/agenda/appointments?date=${today}`, null, { cookie: cookie2 });
    assert(r3.status === 200 && r3.body.some(a => a.id === aptId), 'GET appointments: new apt visible');

    // POST clash — same time → 409
    const r4 = await req('POST', '/api/agenda/appointments', {
      customerPhone: '59892345678', date: today, time: '10:00',
    }, { cookie: cookie2 });
    assert(r4.status === 409, 'POST appointment: clash → 409');

    // PATCH cancel
    const r5 = await req('PATCH', `/api/agenda/appointments/${aptId}/cancel`, {}, { cookie: cookie2 });
    assert(r5.status === 200 && r5.body.ok, 'PATCH cancel → ok');

    // PATCH cancel again → 409
    const r6 = await req('PATCH', `/api/agenda/appointments/${aptId}/cancel`, {}, { cookie: cookie2 });
    assert(r6.status === 409, 'PATCH cancel already cancelled → 409');
  }

  // ── Suite 4: Reschedule ───────────────────────────────────────────────────
  console.log('\nSuite 4: Owner reschedule');
  {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo' }).format(new Date());
    const tomorrow = (() => {
      const d = new Date(); d.setDate(d.getDate() + 1);
      return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo' }).format(d);
    })();

    // Create apt at 14:00 today
    const r1 = await req('POST', '/api/agenda/appointments', {
      customerPhone: '59897654321', clientName: 'Resched Test', date: today, time: '14:00',
    }, { cookie: cookie2 });
    assert(r1.status === 200, 'Create apt for reschedule test');
    const aptId = r1.body.id;

    // Reschedule to tomorrow 15:00
    const r2 = await req('PATCH', `/api/agenda/appointments/${aptId}/reschedule`, {
      date: tomorrow, time: '15:00',
    }, { cookie: cookie2 });
    assert(r2.status === 200 && r2.body.id !== aptId, 'Reschedule → new id');
    assert(r2.body.customer_phone === '59897654321', 'Reschedule: customer_phone preserved');

    // Old apt should be cancelled
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const old = db.prepare('SELECT status FROM agenda_appointments WHERE id = ?').get(aptId);
    assert(old?.status === 'cancelled', 'Old apt → cancelled after reschedule');
    db.close();
  }

  // ── Suite 5: Ownership guard ──────────────────────────────────────────────
  console.log('\nSuite 5: Ownership guard — other user cannot touch appointments');
  {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo' }).format(new Date());
    // Create apt with cookie2
    const r1 = await req('POST', '/api/agenda/appointments', {
      customerPhone: '59890000001', date: today, time: '11:00',
    }, { cookie: cookie2 });
    const aptId = r1.body.id;

    // Another user
    const cookie3 = await registerUser(`other-${Date.now()}@t.com`);
    await req('PUT', '/api/business', { name: 'OtherBiz' }, { cookie: cookie3 });
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const u3 = db.prepare(`SELECT b.id FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email LIKE 'other-%' ORDER BY b.id DESC LIMIT 1`).get();
    db.prepare('UPDATE businesses SET plan = ?, agenda_enabled = 1 WHERE id = ?').run('crecimiento', u3.id);
    db.close();

    const r2 = await req('PATCH', `/api/agenda/appointments/${aptId}/cancel`, {}, { cookie: cookie3 });
    assert(r2.status === 404, 'Other user cannot cancel foreign apt → 404');
    const r3 = await req('PATCH', `/api/agenda/appointments/${aptId}/reschedule`, { date: today, time: '12:00' }, { cookie: cookie3 });
    assert(r3.status === 404, 'Other user cannot reschedule foreign apt → 404');
  }

  // ── Suite 6: OWNER_BUSINESS_FIELDS includes agenda fields ────────────────
  console.log('\nSuite 6: /api/business returns agenda fields');
  {
    const r = await req('GET', '/api/business', null, { cookie: cookie2 });
    assert(r.status === 200 && 'agenda_enabled' in r.body, 'agenda_enabled in /api/business');
    assert('agenda_cancel_min_before' in r.body, 'agenda_cancel_min_before in /api/business');
    assert('agenda_slot_min' in r.body, 'agenda_slot_min in /api/business');
  }

  // ── Suite 7: formatMinutes helper (via cancel window message) ─────────────
  console.log('\nSuite 7: _formatMinutes — code inspection');
  {
    const src = require('fs').readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    assert(src.includes('_formatMinutes'), 'server.js defines _formatMinutes');
    assert(src.includes("return `${m} min`") || src.includes("return m + ' min'"), '_formatMinutes handles minutes-only case');
    assert(src.includes('_formatMinutes(_cancelMinBefore)'), 'cancel window uses _formatMinutes');
  }

  // ── Suite 8: activation link target exists in dashboard ───────────────────
  console.log('\nSuite 8: dashboard.html has id="card-horarios"');
  {
    const html = require('fs').readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
    assert(html.includes('id="card-horarios"'), 'dashboard.html has id="card-horarios"');
    const agendaHtml = require('fs').readFileSync(path.join(__dirname, '../public/agenda.html'), 'utf8');
    assert(agendaHtml.includes('/dashboard.html#card-horarios'), 'agenda.html activation link points to #card-horarios');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) console.error('SOME TESTS FAILED');
  else            console.log('ALL TESTS PASSED');
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); cleanup(); process.exit(1); });
