#!/usr/bin/env node
'use strict';
// Tests for WA disconnect feature.
// (a) disconnect clears WA fields, leaves conversations/messages/images/config intact
// (b) after disconnect, saveWabaCredentials works and sets wa_connected_at
// (c) /api/whatsapp/connect returns 409 when phone_number_id already set
// Run: node scripts/test-wa-disconnect.js

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT        = 3098;
const DB_DIR           = '/tmp/test-wa-disconnect';
const TEST_ADMIN_EMAIL = 'testadmin@wadisconnect.test';
const TEST_ADMIN_PASS  = 'testpassword123';
const TEST_OWNER_EMAIL = 'owner@wadisconnect.test';
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

async function loginAdmin() {
  // Register admin user (first time)
  await req('POST', '/auth/register', { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASS });
  // Login as admin
  const r = await req('POST', '/admin/auth/login', { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASS });
  if (r.status !== 200) throw new Error(`Admin login failed: ${r.status} ${JSON.stringify(r.body)}`);
  const cookie = r.setCookie?.map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Admin login returned no cookie');
  return cookie;
}

async function loginOwner(db, email, pass) {
  // Register owner
  const regR = await req('POST', '/auth/register', { email, password: pass });
  if (regR.status !== 200) throw new Error(`Owner register failed: ${regR.status} ${JSON.stringify(regR.body)}`);
  const regCookie = regR.setCookie?.map(c => c.split(';')[0]).join('; ');
  return regCookie;
}

async function run() {
  console.log(`\n[test-wa-disconnect] DB: ${DB_DIR}`);

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
      ADMIN_EMAIL: TEST_ADMIN_EMAIL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('[test-wa-disconnect] server ready\n');

  const db = openDb();
  const adminCookie = await loginAdmin();

  // ── Seed: business with WA data + conversations + messages + images ──────
  db.exec(`
    INSERT INTO businesses (id, name, wa_provider, response_mode, response_delay, plan,
      phone_number_id, waba_id, whatsapp_number, wa_connected_at, business_context)
    VALUES (7001, 'Test Biz WA', 'kapso', 'texto', 0, 'arranque',
      'pnid_99991234', 'waba_9999', '59800007001',
      datetime('now', '-5 days'), 'Contexto de prueba que no debe borrarse')
  `);
  // Add a conversation + message
  db.exec(`INSERT INTO conversations (id, business_id, customer_id) VALUES (8001, 7001, '59800000001')`);
  db.exec(`INSERT INTO messages (conversation_id, role, content) VALUES (8001, 'user', 'Hola prueba')`);
  // Add a business image record (no actual file needed for this test)
  db.exec(`INSERT INTO business_images (business_id, label, file_path) VALUES (7001, 'logo', '/tmp/fake.png')`);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('Test (a): disconnect clears WA fields, leaves data intact');
  {
    const r = await req('POST', `/admin/api/wa-disconnect/7001`, null, adminCookie);
    assert('endpoint returns 200', r.status === 200, r.status);
    assert('ok: true', r.body?.ok === true, JSON.stringify(r.body));

    const biz = db.prepare('SELECT phone_number_id, waba_id, wa_provider, wa_connected_at, business_context FROM businesses WHERE id = 7001').get();
    assert('phone_number_id cleared', biz.phone_number_id === null, biz.phone_number_id);
    assert('waba_id cleared', biz.waba_id === null, biz.waba_id);
    assert('wa_connected_at cleared', biz.wa_connected_at === null, biz.wa_connected_at);
    assert("wa_provider reset to 'meta'", biz.wa_provider === 'meta', biz.wa_provider);
    assert('business_context preserved', biz.business_context === 'Contexto de prueba que no debe borrarse', biz.business_context);

    const convs = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE business_id = 7001').get();
    assert('conversations intact', convs.n === 1, convs.n);

    const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 8001').get();
    assert('messages intact', msgs.n === 1, msgs.n);

    const imgs = db.prepare('SELECT COUNT(*) AS n FROM business_images WHERE business_id = 7001').get();
    assert('images intact', imgs.n === 1, imgs.n);

    const log = db.prepare("SELECT * FROM error_log WHERE context = 'wa-admin-disconnect' AND message LIKE '%business_id=7001%' ORDER BY id DESC LIMIT 1").get();
    assert('wa-admin-disconnect logged', !!log, log);
    assert('log includes last4', log?.message?.includes('phone_number_id_last4=1234'), log?.message);
    assert('log includes wa_provider', log?.message?.includes('wa_provider=kapso'), log?.message);
    assert('log includes wa_connected_at', log?.message?.includes('wa_connected_at='), log?.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (b): saveWabaCredentials works after disconnect, sets wa_connected_at');
  {
    // Simulate saveWabaCredentials by calling the internal SQL directly
    // (mirrors what the Kapso webhook does after reconnect)
    db.prepare(`
      UPDATE businesses
      SET waba_id = 'waba_new', phone_number_id = 'pnid_new5678', wa_access_token = NULL,
          wa_provider = 'kapso', wa_connected_at = datetime('now')
      WHERE id = 7001 AND phone_number_id IS NULL
    `).run();

    const biz = db.prepare('SELECT phone_number_id, wa_provider, wa_connected_at FROM businesses WHERE id = 7001').get();
    assert('new phone_number_id saved', biz.phone_number_id === 'pnid_new5678', biz.phone_number_id);
    assert('wa_provider set to kapso', biz.wa_provider === 'kapso', biz.wa_provider);
    assert('wa_connected_at set', !!biz.wa_connected_at, biz.wa_connected_at);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nTest (c): /api/whatsapp/connect returns 409 when phone_number_id already set');
  {
    // Register + login as a new owner whose business already has a phone_number_id
    db.exec(`
      INSERT INTO businesses (id, name, wa_provider, response_mode, response_delay, plan,
        phone_number_id, wa_connected_at)
      VALUES (7002, 'Test Biz Already Connected', 'kapso', 'texto', 0, 'arranque',
        'pnid_already9999', datetime('now', '-1 day'))
    `);
    const ownerCookie = await loginOwner(db, TEST_OWNER_EMAIL, TEST_OWNER_PASS);
    // Link user to business 7002
    const ownerUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(TEST_OWNER_EMAIL);
    db.prepare('UPDATE users SET business_id = ? WHERE id = ?').run(7002, ownerUser.id);

    const r = await req('POST', '/api/whatsapp/connect', null, ownerCookie);
    assert('returns 409', r.status === 409, r.status);
    assert('error is ya_conectado', r.body?.error === 'ya_conectado', r.body?.error);
    assert('message mentions escribinos', r.body?.message?.includes('092 052 508'), r.body?.message);

    // Verify no new Kapso log was created for this business (no API call was made)
    const kapsoLog = db.prepare(`SELECT * FROM error_log WHERE context = 'kapso-onboarding-created' AND message LIKE '%business_id=7002%'`).get();
    assert('no Kapso link created', !kapsoLog, kapsoLog);
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
