#!/usr/bin/env node
'use strict';
// Tests for /admin/api/runtime-config endpoints.
// Covers: key whitelist, value range, missing token, audit log.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3106;
const DB_DIR    = '/tmp/test-runtime-config';
const BASE_URL  = `http://localhost:${TEST_PORT}`;
const BEARER    = 'test-runtime-cfg-token';

let serverProc = null;
let passed = 0;
let failed = 0;

function cleanup() {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

async function main() {
  console.log('\nStarting server on port', TEST_PORT, '...');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'rtcfg-test-secret',
      ADMIN_SET_WA_TOKEN: BEARER,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  const BASE = '/admin/api/runtime-config';

  // ── Suite A: authentication ───────────────────────────────────────────────
  console.log('Suite A: authentication');
  {
    const r1 = await req('GET', `${BASE}/cap_conv_hourly`);
    assert(r1.status === 403 || r1.status === 503, 'A1: GET without token → 403 or 503');

    const r2 = await req('GET', `${BASE}/cap_conv_hourly`, null, { bearer: 'wrong-token' });
    assert(r2.status === 403, 'A2: GET with wrong token → 403');

    const r3 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '15' });
    assert(r3.status === 403 || r3.status === 503, 'A3: POST without token → 403 or 503');
  }

  // ── Suite B: key whitelist ────────────────────────────────────────────────
  console.log('\nSuite B: key whitelist');
  {
    const r1 = await req('GET', `${BASE}/ANTHROPIC_API_KEY`, null, { bearer: BEARER });
    assert(r1.status === 400, 'B1: GET disallowed key → 400');
    assert(typeof r1.body?.error === 'string', 'B2: error message in body');

    const r2 = await req('POST', `${BASE}/cap_daily_anthropic_arranque`, { value: '50' }, { bearer: BEARER });
    assert(r2.status === 400, 'B3: POST disallowed key → 400');

    const r3 = await req('GET', `${BASE}/cap_conv_hourly`, null, { bearer: BEARER });
    assert(r3.status === 200, 'B4: GET allowed key → 200');
    assert(r3.body?.key === 'cap_conv_hourly', 'B5: response includes key name');
  }

  // ── Suite C: value validation ─────────────────────────────────────────────
  console.log('\nSuite C: value validation');
  {
    const r1 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '4' }, { bearer: BEARER });
    assert(r1.status === 400, 'C1: value 4 (below min 5) → 400');

    const r2 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '101' }, { bearer: BEARER });
    assert(r2.status === 400, 'C2: value 101 (above max 100) → 400');

    const r3 = await req('POST', `${BASE}/cap_conv_hourly`, { value: 'abc' }, { bearer: BEARER });
    assert(r3.status === 400, 'C3: non-numeric value → 400');

    const r4 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '0' }, { bearer: BEARER });
    assert(r4.status === 400, 'C4: value 0 → 400');

    const r5 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '-1' }, { bearer: BEARER });
    assert(r5.status === 400, 'C5: negative value → 400');

    const r6 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '5' }, { bearer: BEARER });
    assert(r6.status === 200, 'C6: value 5 (min) → 200');
    assert(r6.body?.ok === true, 'C7: ok:true in response');

    const r7 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '100' }, { bearer: BEARER });
    assert(r7.status === 200, 'C8: value 100 (max) → 200');

    const r8 = await req('POST', `${BASE}/cap_conv_hourly`, {}, { bearer: BEARER });
    assert(r8.status === 400, 'C9: missing value field → 400');
  }

  // ── Suite D: read-write round trip ───────────────────────────────────────
  console.log('\nSuite D: read-write round trip');
  {
    const r1 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '30' }, { bearer: BEARER });
    assert(r1.status === 200, 'D1: set to 30 → 200');
    assert(r1.body?.value === '30', 'D2: response value is "30"');

    const r2 = await req('GET', `${BASE}/cap_conv_hourly`, null, { bearer: BEARER });
    assert(r2.status === 200, 'D3: GET after set → 200');
    assert(r2.body?.value === '30', 'D4: GET returns stored value "30"');

    // Reset to default (empty string)
    const r3 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '' }, { bearer: BEARER });
    assert(r3.status === 200, 'D5: reset with empty value → 200');
    assert(r3.body?.value === null, 'D6: response value is null after reset');

    const r4 = await req('GET', `${BASE}/cap_conv_hourly`, null, { bearer: BEARER });
    // After reset, stored value is '' which is falsy — the endpoint should return '' or null
    assert(r4.status === 200, 'D7: GET after reset → 200');
  }

  // ── Suite E: audit log ───────────────────────────────────────────────────
  console.log('\nSuite E: audit log');
  {
    // Set a value and verify audit table was written
    const Database = require('better-sqlite3');
    const dbPath = require('path').join(DB_DIR, 'daxos.db');

    const r1 = await req('POST', `${BASE}/cap_conv_hourly`, { value: '42' }, { bearer: BEARER });
    assert(r1.status === 200, 'E1: set to 42 for audit test');

    const auditDb = new Database(dbPath, { readonly: true });
    const rows = auditDb.prepare("SELECT * FROM runtime_config_audit WHERE key = 'cap_conv_hourly' ORDER BY id DESC").all();
    const latest = rows[0];
    const tbl = auditDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_config_audit'").get();
    auditDb.close();

    assert(rows.length >= 1, 'E2: at least one audit row after change');
    assert(latest.new_value === '42', 'E3: audit row has new_value=42');
    assert(latest.key === 'cap_conv_hourly', 'E4: audit row has correct key');
    assert(typeof latest.changed_by === 'string', 'E5: changed_by recorded');
    assert(typeof latest.changed_at === 'number', 'E6: changed_at is a unix timestamp');
    assert(!!tbl, 'E7: runtime_config_audit table exists independently of error_log');
  }

  console.log('\n================================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('================================================================');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
