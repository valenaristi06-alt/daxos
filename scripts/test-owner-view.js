#!/usr/bin/env node
'use strict';
// Tests for ownerView field allowlist on owner-facing business API endpoints.
// (a) GET/PUT /api/business and POST /businesses never return internal fields
//     (wa_access_token, kapso_*, document_path, etc.)
// (b) dashboard.html-relevant fields present: id, name, phone_number_id, plan,
//     trial_*, wa_provider, wa_connected_at, booking_enabled, voice_id, etc.
// Run: node scripts/test-owner-view.js

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT        = 3097;
const DB_DIR           = '/tmp/test-owner-view';
const TEST_OWNER_EMAIL = 'owner@ownerview.test';
const TEST_OWNER_PASS  = 'ownerpassword123';
const BASE_URL         = `http://localhost:${TEST_PORT}`;

let serverProc = null;

function cleanup() {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: TEST_PORT,
      path: urlPath, method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    };
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

const BLOCKED_FIELDS = [
  'wa_access_token', 'kapso_waba_id', 'kapso_access_token',
  'document_path',
];

const REQUIRED_FIELDS = [
  'id', 'name', 'plan', 'wa_provider', 'phone_number_id', 'waba_id', 'wa_connected_at',
  'trial_starts_at', 'trial_ends_at',
  'booking_enabled', 'voice_id', 'response_mode', 'whatsapp_number',
  'subscription_status', 'plan_expires_at',
  'kapso_customer_id',
  'weekly_summary_enabled',
];

function assertNoBlockedFields(label, body) {
  for (const f of BLOCKED_FIELDS) {
    assert(`${label}: no ${f}`, !(f in body), body[f]);
  }
}

function assertRequiredFields(label, body) {
  for (const f of REQUIRED_FIELDS) {
    assert(`${label}: has ${f}`, f in body, `missing`);
  }
}

async function run() {
  console.log(`\n[test-owner-view] DB: ${DB_DIR}`);

  try { execSync(`lsof -ti :${TEST_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch (_) {}
  await sleep(300);
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  fs.mkdirSync(DB_DIR, { recursive: true });

  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DB_DIR,
      PORT: String(TEST_PORT),
      KAPSO_WEBHOOK_SECRET: '',
      ADMIN_EMAIL: 'admin@ownerview.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('[test-owner-view] server ready\n');

  const db = openDb();

  // ── Register + login owner ───────────────────────────────────────────────
  const regR = await req('POST', '/auth/register', { email: TEST_OWNER_EMAIL, password: TEST_OWNER_PASS });
  if (regR.status !== 200) throw new Error(`Register failed: ${regR.status} ${JSON.stringify(regR.body)}`);
  const ownerCookie = regR.setCookie?.map(c => c.split(';')[0]).join('; ');
  if (!ownerCookie) throw new Error('Register returned no cookie');

  // Create business via PUT /api/business
  const putR = await req('PUT', '/api/business', { name: 'Test Negocio', whatsapp_number: '59899000001' }, ownerCookie);
  if (putR.status !== 200) throw new Error(`PUT /api/business failed: ${putR.status} ${JSON.stringify(putR.body)}`);
  const bizId = putR.body.id;
  if (!bizId) throw new Error(`No id in PUT response: ${JSON.stringify(putR.body)}`);

  // Seed fields directly in DB (wa_access_token NOT set — stored encrypted, raw value breaks decrypt)
  db.prepare(`
    UPDATE businesses
    SET wa_provider = 'kapso',
        phone_number_id = 'pnid_12345678',
        waba_id = 'waba_9999',
        wa_connected_at = datetime('now', '-1 day'),
        plan = 'arranque',
        booking_enabled = 1,
        voice_id = 'voice_xyz',
        trial_starts_at = datetime('now', '-3 days'),
        trial_ends_at = datetime('now', '+11 days'),
        weekly_summary_enabled = 1
    WHERE id = ?
  `).run(bizId);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('Test (a): GET /api/business blocks internal fields, returns required fields');
  {
    const r = await req('GET', '/api/business', null, ownerCookie);
    assert('status 200', r.status === 200, r.status);
    assertNoBlockedFields('GET /api/business', r.body);
    assertRequiredFields('GET /api/business', r.body);
    assert('trial_conv_count present (arranque plan)', 'trial_conv_count' in r.body, JSON.stringify(r.body));
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (a): PUT /api/business blocks internal fields, returns required fields');
  {
    const r = await req('PUT', '/api/business', { name: 'Updated Name' }, ownerCookie);
    assert('status 200', r.status === 200, r.status);
    assertNoBlockedFields('PUT /api/business', r.body);
    assertRequiredFields('PUT /api/business', r.body);
    assert('name updated', r.body.name === 'Updated Name', r.body.name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (b): dashboard fields present — phone_number_id, wa_connected_at, wa_provider');
  {
    const r = await req('GET', '/api/business', null, ownerCookie);
    assert('phone_number_id = pnid_12345678', r.body.phone_number_id === 'pnid_12345678', r.body.phone_number_id);
    assert('wa_connected_at present', !!r.body.wa_connected_at, r.body.wa_connected_at);
    assert('wa_provider = kapso', r.body.wa_provider === 'kapso', r.body.wa_provider);
    assert('booking_enabled = 1', r.body.booking_enabled === 1, r.body.booking_enabled);
    assert('voice_id = voice_xyz', r.body.voice_id === 'voice_xyz', r.body.voice_id);
    assert('weekly_summary_enabled = 1', r.body.weekly_summary_enabled === 1, r.body.weekly_summary_enabled);
    assert('kapso_customer_id present (null ok)', 'kapso_customer_id' in r.body, r.body);
    assert('waba_id = waba_9999', r.body.waba_id === 'waba_9999', r.body.waba_id);
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
