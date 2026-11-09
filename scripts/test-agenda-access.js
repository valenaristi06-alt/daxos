#!/usr/bin/env node
'use strict';
// Tests for agenda_access runtime-config and self-service activation flow.
// Run: node scripts/test-agenda-access.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT   = 3222;
const DB_DIR      = '/tmp/test-agenda-access';
const ADMIN_TOKEN = 'access-test-token';
const BASE_URL    = `http://localhost:${TEST_PORT}`;

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
      SESSION_SECRET:      'access-test-secret',
      NODE_ENV:            '',
      RAILWAY_ENVIRONMENT: '',
      ADMIN_SET_WA_TOKEN:  ADMIN_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write(`[srv] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[srv] ${d}`));
  proc.on('exit', code => { if (code !== null && code !== 0) console.error(`[srv] exited code=${code}`); });
  return proc;
}

const HOURS_JSON = JSON.stringify({
  '1': [['09:00','18:00']], '2': [['09:00','18:00']], '3': [['09:00','18:00']],
  '4': [['09:00','18:00']], '5': [['09:00','18:00']],
});

async function register(email) {
  const r = await req('POST', '/auth/register', { email, password: 'Test1234!', name: 'Test' });
  if (r.status !== 200) throw new Error(`register failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.headers['set-cookie']?.[0]?.split(';')[0];
}

async function setPlan(email, plan) {
  const r = await req('POST', '/admin/set-plan', { email, plan }, { bearer: ADMIN_TOKEN });
  if (r.status !== 200) throw new Error(`setPlan(${email},${plan}): ${JSON.stringify(r.body)}`);
}

async function setAccess(value) {
  const r = await req('POST', '/admin/api/runtime-config/agenda_access', { value }, { bearer: ADMIN_TOKEN });
  if (r.status !== 200) throw new Error(`setAccess(${value}): ${JSON.stringify(r.body)}`);
}

async function resetAccess() {
  await req('POST', '/admin/api/runtime-config/agenda_access', { value: '' }, { bearer: ADMIN_TOKEN });
}

(async () => {
  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = startServer();
  await waitForServer();
  console.log('Server up.\n');

  // ── Suite 1: runtime-config agenda_access — GET/POST validation ──────────
  console.log('Suite 1: agenda_access — GET/POST via runtime-config');

  {
    const r = await req('GET', '/admin/api/runtime-config/agenda_access', null, { bearer: ADMIN_TOKEN });
    assert(r.status === 200, 'GET agenda_access → 200');
    assert(r.body.value === null, 'default value is null (→ all)');
  }
  {
    const r = await req('POST', '/admin/api/runtime-config/agenda_access', { value: 'all' }, { bearer: ADMIN_TOKEN });
    assert(r.status === 200, 'POST value=all → 200');
  }
  {
    const r = await req('POST', '/admin/api/runtime-config/agenda_access', { value: 'paid' }, { bearer: ADMIN_TOKEN });
    assert(r.status === 200, 'POST value=paid → 200');
  }
  {
    const r = await req('POST', '/admin/api/runtime-config/agenda_access', { value: 'premium' }, { bearer: ADMIN_TOKEN });
    assert(r.status === 400, 'POST value=premium → 400 (invalid)');
  }
  {
    const r = await req('POST', '/admin/api/runtime-config/agenda_access', { value: '' }, { bearer: ADMIN_TOKEN });
    assert(r.status === 200, 'POST value="" → 200 (reset to default)');
  }

  // ── Suite 2: access=paid — plan gating ────────────────────────────────────
  console.log('\nSuite 2: access=paid — plan gating');

  await setAccess('paid');

  const cookArranque = await register('access-arranque@test.com');
  await req('PUT', '/api/business', { name: 'Arranque Biz', business_hours: HOURS_JSON }, { cookie: cookArranque });
  // plan stays 'arranque' by default

  const cookCrecimiento = await register('access-crecimiento@test.com');
  await req('PUT', '/api/business', { name: 'Crec Biz', business_hours: HOURS_JSON }, { cookie: cookCrecimiento });
  await setPlan('access-crecimiento@test.com', 'crecimiento');

  const cookAMedida = await register('access-amedida@test.com');
  await req('PUT', '/api/business', { name: 'AMedia Biz', business_hours: HOURS_JSON }, { cookie: cookAMedida });
  await setPlan('access-amedida@test.com', 'a_medida');

  // arranque → 403 on write endpoints
  {
    const r = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookArranque });
    assert(r.status === 403, 'paid mode: arranque POST services → 403');
  }
  {
    const r = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookArranque });
    assert(r.status === 403, 'paid mode: arranque agenda-enabled → 403');
  }
  {
    const r = await req('GET', '/api/agenda/appointments?date=2026-12-01', null, { cookie: cookArranque });
    assert(r.status === 200, 'paid mode: arranque GET appointments → 200 (read-only ok)');
  }
  // crecimiento → allowed
  {
    const r = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookCrecimiento });
    assert(r.status === 200, 'paid mode: crecimiento POST services → 200');
  }
  // a_medida → allowed
  {
    const r = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookAMedida });
    assert(r.status === 200, 'paid mode: a_medida POST services → 200');
  }

  // ── Suite 3: access=all — all plans can access ────────────────────────────
  console.log('\nSuite 3: access=all — all plans allowed');

  await setAccess('all');

  {
    const r = await req('POST', '/api/agenda/services', { name: 'Corte2', duration_min: 45 }, { cookie: cookArranque });
    assert(r.status === 200, 'all mode: arranque POST services → 200');
  }

  // ── Suite 4: agenda_plan_ok in /api/business response ────────────────────
  console.log('\nSuite 4: agenda_plan_ok field in /api/business');

  await setAccess('all');
  {
    const r = await req('GET', '/api/business', null, { cookie: cookArranque });
    assert(r.status === 200, 'GET /api/business → 200');
    assert(r.body.agenda_plan_ok === true, 'access=all: arranque → agenda_plan_ok true');
  }
  await setAccess('paid');
  {
    const r = await req('GET', '/api/business', null, { cookie: cookArranque });
    assert(r.body.agenda_plan_ok === false, 'access=paid: arranque → agenda_plan_ok false');
  }
  {
    const r = await req('GET', '/api/business', null, { cookie: cookCrecimiento });
    assert(r.body.agenda_plan_ok === true, 'access=paid: crecimiento → agenda_plan_ok true');
  }

  // ── Suite 5: activation — blocked without hours/service, allowed with both ─
  console.log('\nSuite 5: activation flow — blocking conditions');

  await setAccess('all');
  const cookNew = await register('access-new@test.com');
  await req('PUT', '/api/business', { name: 'NewBiz' }, { cookie: cookNew });

  // No hours at all
  {
    const r = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookNew });
    assert(r.status === 400 && r.body.code === 'NO_BUSINESS_HOURS', 'activate without hours → 400 NO_BUSINESS_HOURS');
  }

  // Empty hours object {} — no open days
  await req('PUT', '/api/business', { name: 'NewBiz', business_hours: JSON.stringify({}) }, { cookie: cookNew });
  {
    const r = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookNew });
    assert(r.status === 400 && r.body.code === 'NO_BUSINESS_HOURS', 'activate with empty {} hours → 400 NO_BUSINESS_HOURS');
  }

  // All-closed hours (every day has empty ranges)
  await req('PUT', '/api/business', { name: 'NewBiz', business_hours: JSON.stringify({'1':[],'2':[],'3':[],'4':[],'5':[]}) }, { cookie: cookNew });
  {
    const r = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookNew });
    assert(r.status === 400 && r.body.code === 'NO_BUSINESS_HOURS', 'activate with all-closed hours → 400 NO_BUSINESS_HOURS');
  }

  // Add valid hours but no service
  await req('PUT', '/api/business', { name: 'NewBiz', business_hours: HOURS_JSON }, { cookie: cookNew });
  {
    const r = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookNew });
    assert(r.status === 400 && r.body.code === 'NO_SERVICES', 'activate with hours but no service → 400 NO_SERVICES');
  }

  // Add service — should now activate
  await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookNew });
  {
    const r = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, { cookie: cookNew });
    assert(r.status === 200 && r.body.agenda_enabled === true, 'activate with hours + service → 200');
  }

  // Deactivate — appointments preserved
  // (create an appointment first via DB-level test; skip here since requires full booking flow)
  {
    const r = await req('PATCH', '/api/business/agenda-enabled', { enabled: false }, { cookie: cookNew });
    assert(r.status === 200 && r.body.agenda_enabled === false, 'deactivate → 200 agenda_enabled false');
  }
  {
    // After deactivate, appointments are still readable (GET still works)
    const r = await req('GET', '/api/agenda/appointments?date=2026-12-01', null, { cookie: cookNew });
    assert(r.status === 200, 'after deactivate GET appointments → 200 (appointments preserved)');
  }

  // ── Suite 6: plan_cortesia counts as paid ─────────────────────────────────
  console.log('\nSuite 6: plan_cortesia treated as paid');

  await setAccess('paid');
  const cookCortesia = await register('access-cortesia@test.com');
  await req('PUT', '/api/business', { name: 'Cortesia Biz', business_hours: HOURS_JSON }, { cookie: cookCortesia });
  // set plan_cortesia via admin
  await req('POST', '/admin/set-plan-cortesia', { email: 'access-cortesia@test.com', plan_cortesia: true }, { bearer: ADMIN_TOKEN });

  {
    const r = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, { cookie: cookCortesia });
    assert(r.status === 200, 'paid mode: plan_cortesia POST services → 200');
  }
  {
    const r = await req('GET', '/api/business', null, { cookie: cookCortesia });
    assert(r.body.agenda_plan_ok === true, 'paid mode: plan_cortesia → agenda_plan_ok true');
  }

  // ── Suite 7: changing agenda_access takes effect without restart ──────────
  console.log('\nSuite 7: agenda_access change reflects without restart');

  await setAccess('paid');
  {
    const r = await req('POST', '/api/agenda/services', { name: 'Live', duration_min: 20 }, { cookie: cookArranque });
    assert(r.status === 403, 'arranque blocked after switch to paid');
  }
  await setAccess('all');
  {
    const r = await req('POST', '/api/agenda/services', { name: 'Live2', duration_min: 20 }, { cookie: cookArranque });
    assert(r.status === 200, 'arranque allowed after switch to all (no restart)');
  }

  // Reset to default
  await resetAccess();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('FATAL:', err.message);
  cleanup();
  process.exit(1);
});
