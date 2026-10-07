#!/usr/bin/env node
'use strict';
// Tests for enhanced WA health check (runWaHealthCheck / /admin/api/run-health-check).
// (a) dry-run is default when WA_HEALTH_ALERTS != 'on'
// (b) ?dryRun=1 forces dry-run regardless of WA_HEALTH_ALERTS
// (c) WA_HEALTH_ALERTS=on without ?dryRun → dryRun:false in response
// (d) non-unhealthy Kapso response (bad key → 401/404, status ≠ 'unhealthy') never sets wa_health_alerted_at
// (e) two consecutive calls with non-unhealthy response don't set wa_health_alerted_at
// (f) biz id=1 excluded: error_log shows no "checked biz=1" even when it has a phone_number_id
// Run: node scripts/test-wa-health-check.js

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT        = 3096;
const DB_DIR           = '/tmp/test-wa-health-check';
const TEST_ADMIN_EMAIL = 'testadmin@wahealthcheck.test';
const TEST_ADMIN_PASS  = 'testpassword123';
const BASE_URL         = `http://localhost:${TEST_PORT}`;
const BEARER_TOKEN     = 'test-wa-health-bearer-token';

let serverProc = null;

function cleanup() {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, cookie, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (token)  headers['Authorization'] = `Bearer ${token}`;
    const opts = { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers };
    const r = http.request(opts, (res) => {
      let data = '';
      const setCookie = res.headers['set-cookie'];
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), setCookie }); }
        catch { resolve({ status: res.statusCode, body: data, setCookie }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try { await req('GET', '/health'); return; }
    catch { await sleep(500); }
  }
  throw new Error('Server did not start in 15s');
}

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.join(DB_DIR, 'daxos.db'));
}

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail !== undefined ? ': ' + String(detail) : ''}`);
    failed++;
  }
}

function startServer(extraEnv = {}) {
  return spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DB_DIR,
      PORT: String(TEST_PORT),
      KAPSO_WEBHOOK_SECRET: '',
      ADMIN_EMAIL: TEST_ADMIN_EMAIL,
      KAPSO_API_KEY: 'fake-test-key-for-health-check',
      ADMIN_SET_WA_TOKEN: BEARER_TOKEN,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function run() {
  console.log(`\n[test-wa-health-check] DB: ${DB_DIR}`);

  try { execSync(`lsof -ti :${TEST_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch (_) {}
  await sleep(300);
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  fs.mkdirSync(DB_DIR, { recursive: true });

  // ── Start server WITHOUT WA_HEALTH_ALERTS=on (dry-run default) ─────────────
  serverProc = startServer();
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await waitForServer();
  console.log('[test-wa-health-check] server ready\n');

  const db = openDb();

  // Register admin
  await req('POST', '/auth/register', { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASS });

  // Seed: biz id=1 (will be first created, mimics Varela that must be excluded)
  db.exec(`
    INSERT INTO businesses (id, name, wa_provider, response_mode, response_delay, plan,
      phone_number_id, waba_id, whatsapp_number, wa_connected_at)
    VALUES (1, 'Varela Test', 'kapso', 'texto', 0, 'arranque',
      'pnid_varela_001', 'waba_varela', '59891001001', datetime('now', '-1 day'))
  `);

  // Seed: biz id=2 (normal connected business, fake pnid → Kapso will return error, not 'unhealthy')
  db.exec(`
    INSERT INTO businesses (id, name, wa_provider, response_mode, response_delay, plan,
      phone_number_id, waba_id, whatsapp_number, wa_connected_at)
    VALUES (2, 'Test Biz Health', 'kapso', 'texto', 0, 'arranque',
      'pnid_fakeid_99999', 'waba_fake', '59891002002', datetime('now', '-1 day'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('Test (a): dry-run is default when WA_HEALTH_ALERTS not set');
  {
    const r = await req('POST', '/admin/api/run-health-check', null, null, BEARER_TOKEN);
    assert('endpoint returns 200', r.status === 200, r.status);
    assert('ok: true', r.body?.ok === true, JSON.stringify(r.body));
    assert('dryRun: true by default', r.body?.dryRun === true, r.body?.dryRun);

    const biz2 = db.prepare('SELECT wa_health_alerted_at FROM businesses WHERE id = 2').get();
    assert('wa_health_alerted_at stays NULL (dry-run)', biz2.wa_health_alerted_at === null, biz2.wa_health_alerted_at);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (b): ?dryRun=1 forces dry-run');
  {
    const r = await req('POST', '/admin/api/run-health-check?dryRun=1', null, null, BEARER_TOKEN);
    assert('endpoint returns 200', r.status === 200, r.status);
    assert('dryRun: true with ?dryRun=1', r.body?.dryRun === true, r.body?.dryRun);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (d): non-unhealthy Kapso response never sets wa_health_alerted_at');
  // Fake pnid → Kapso returns 401/404/error JSON with status != 'unhealthy'
  // In dry-run mode, even if status were unhealthy, no alert fires.
  // Key point: even in non-dry-run mode, non-unhealthy status must not alert.
  // We simulate this by manually setting WA_HEALTH_ALERTS=on in DB env and using ?dryRun=0 (skipped)
  // Here we just verify the DB stays clean regardless.
  {
    const r = await req('POST', '/admin/api/run-health-check', null, null, BEARER_TOKEN);
    assert('returns 200', r.status === 200, r.status);
    const biz2 = db.prepare('SELECT wa_health_alerted_at FROM businesses WHERE id = 2').get();
    assert('wa_health_alerted_at still NULL after check', biz2.wa_health_alerted_at === null, biz2.wa_health_alerted_at);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (e): two consecutive calls with non-unhealthy/network responses — no alert, no consecutive counter trigger');
  {
    // Call twice in dry-run mode
    await req('POST', '/admin/api/run-health-check', null, null, BEARER_TOKEN);
    await req('POST', '/admin/api/run-health-check', null, null, BEARER_TOKEN);

    const biz2 = db.prepare('SELECT wa_health_alerted_at FROM businesses WHERE id = 2').get();
    assert('wa_health_alerted_at NULL after two calls', biz2.wa_health_alerted_at === null, biz2.wa_health_alerted_at);

    // Error log must NOT have any alert/recovery entry for biz=2 (only network/non-JSON/dry-run logs are ok)
    const alertLog = db.prepare(`
      SELECT * FROM error_log
      WHERE context IN ('wa-health-check', 'wa-health-alert')
        AND message LIKE '%alerted biz=2%'
      LIMIT 1
    `).get();
    assert('no alert log entry for biz=2 after two calls', !alertLog, alertLog?.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (f): biz id=1 excluded from check cycle');
  {
    await req('POST', '/admin/api/run-health-check', null, null, BEARER_TOKEN);

    // No "checked biz=1" log should exist in error_log
    const checkedBiz1 = db.prepare(`
      SELECT * FROM error_log
      WHERE context = 'wa-health-check'
        AND message LIKE '%checked biz=1 %'
      LIMIT 1
    `).get();
    assert('no "checked biz=1" log (excluded from cycle)', !checkedBiz1, checkedBiz1?.message);

    // But biz=2 was checked (network error or kapso cache skip — either way some log exists)
    const anyBiz2Log = db.prepare(`
      SELECT * FROM error_log
      WHERE context = 'wa-health-check'
        AND (message LIKE '%biz=2 %' OR message LIKE '%biz=2 p%')
      LIMIT 1
    `).get();
    assert('biz=2 was processed (appears in wa-health-check log)', !!anyBiz2Log, anyBiz2Log);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Restart server WITH WA_HEALTH_ALERTS=on to test dryRun:false
  console.log('\nTest (c): WA_HEALTH_ALERTS=on → dryRun:false in response');
  {
    serverProc.kill();
    await sleep(500);
    try { execSync(`lsof -ti :${TEST_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch (_) {}
    await sleep(300);

    serverProc = startServer({ WA_HEALTH_ALERTS: 'on' });
    serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
    serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
    await waitForServer();

    const r = await req('POST', '/admin/api/run-health-check', null, null, BEARER_TOKEN);
    assert('endpoint returns 200', r.status === 200, r.status);
    assert('dryRun: false when WA_HEALTH_ALERTS=on', r.body?.dryRun === false, r.body?.dryRun);

    // ?dryRun=1 still overrides even when WA_HEALTH_ALERTS=on
    const r2 = await req('POST', '/admin/api/run-health-check?dryRun=1', null, null, BEARER_TOKEN);
    assert('?dryRun=1 overrides WA_HEALTH_ALERTS=on', r2.body?.dryRun === true, r2.body?.dryRun);

    // wa_health_alerted_at must still be NULL: Kapso returned non-unhealthy (fake key → not 'unhealthy')
    const biz2 = db.prepare('SELECT wa_health_alerted_at FROM businesses WHERE id = 2').get();
    assert('wa_health_alerted_at NULL even with WA_HEALTH_ALERTS=on (non-unhealthy response)', biz2.wa_health_alerted_at === null, biz2.wa_health_alerted_at);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n──────────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
