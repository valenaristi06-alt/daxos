#!/usr/bin/env node
'use strict';
// Tests: cross-business isolation + single-conv message deletion for resetConversation.
// Run: node scripts/test-reset-conv.js

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3095;
const DB_DIR    = '/tmp/test-reset-conv';
const BASE_URL  = `http://localhost:${TEST_PORT}`;

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

function assert(cond, label, detail) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail !== undefined ? ': ' + String(detail) : ''}`); failed++; }
}

function req(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        const setCookie = res.headers['set-cookie'];
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), setCookie }); }
          catch { resolve({ status: res.statusCode, body: data, setCookie }); }
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
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

async function register(email) {
  const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  if (r.status !== 200) throw new Error(`register failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.setCookie?.[0]?.split(';')[0];
}

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.join(DB_DIR, 'daxos.db'));
}

async function seedBusiness(db, email, pnid, cookie, ownerPhone) {
  await req('PUT', '/api/business', { name: `Biz ${email}`, plan: 'crecimiento' }, cookie);
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id;
  const bizId  = db.prepare('SELECT business_id FROM users WHERE id = ?').get(userId)?.business_id;
  db.prepare(`UPDATE businesses SET
    phone_number_id = ?, wa_provider = 'kapso',
    wa_connected_at = datetime('now'), plan = 'crecimiento',
    plan_paid_at = datetime('now'), response_delay = 0
    WHERE id = ?`).run(pnid, bizId);
  if (ownerPhone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(ownerPhone, userId);
  db.pragma('wal_checkpoint(FULL)');
  return { bizId, userId };
}

async function main() {
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(DB_DIR, { recursive: true });

  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT), DB_DIR,
      SESSION_SECRET:    'reset-test-secret',
      ANTHROPIC_API_KEY: 'test-key-not-real',
      KAPSO_API_KEY:     'test-kapso-key',
      KAPSO_TEST_ALLOW_LOCALHOST: '1',
      KAPSO_WEBHOOK_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  const db = openDb();

  // Register two users
  const cookieA = await register('biz-a@test.com');
  const cookieB = await register('biz-b@test.com');

  // ownerPhone for A matches convA1's customer_id (with +598 prefix variant)
  const { bizId: bizA } = await seedBusiness(db, 'biz-a@test.com', 'pnid-a', cookieA, '+5985491100001');
  const { bizId: bizB } = await seedBusiness(db, 'biz-b@test.com', 'pnid-b', cookieB, '5491100003');

  // Seed conversations and messages directly in DB
  // convA1: customer matches ownerA (5491100001 == strip598(+5985491100001))
  const convA1 = db.prepare(
    "INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)"
  ).run(bizA, '5491100001').lastInsertRowid;
  // convA2: customer does NOT match ownerA → reset should return 403
  const convA2 = db.prepare(
    "INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)"
  ).run(bizA, '5491100002').lastInsertRowid;
  const convB1 = db.prepare(
    "INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)"
  ).run(bizB, '5491100003').lastInsertRowid;

  // Seed messages
  const addMsg = db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)");
  addMsg.run(convA1, 'msg-a1-1'); addMsg.run(convA1, 'msg-a1-2'); // 2 msgs in convA1
  addMsg.run(convA2, 'msg-a2-1');                                  // 1 msg in convA2
  addMsg.run(convB1, 'msg-b1-1'); addMsg.run(convB1, 'msg-b1-2'); // 2 msgs in convB1

  db.pragma('wal_checkpoint(FULL)');

  function countMessages(convId) {
    return db.prepare('SELECT COUNT(*) as n FROM messages WHERE conversation_id = ?').get(convId).n;
  }

  // ── Suite 1: biz A cannot reset a conversation from biz B ─────────────────
  console.log('Suite 1: negocio A NO puede resetear conversación del negocio B');
  {
    const before = countMessages(convB1);
    const r = await req('POST', `/api/conversations/${convB1}/reset`,
      { confirmation: 'BORRAR' }, cookieA);
    const after = countMessages(convB1);
    assert(r.status === 404, '1.1 endpoint devuelve 404', `got ${r.status}`);
    assert(after === before, `1.2 mensajes de convB1 intactos (${before})`, `got ${after}`);
  }
  console.log();

  // ── Suite 2: reset correcto borra solo mensajes de ESA conversación ────────
  console.log('Suite 2: reset de convA1 borra sus mensajes y no toca convA2 ni convB1');
  {
    const beforeA1 = countMessages(convA1);
    const beforeA2 = countMessages(convA2);
    const beforeB1 = countMessages(convB1);

    const r = await req('POST', `/api/conversations/${convA1}/reset`,
      { confirmation: 'BORRAR' }, cookieA);
    assert(r.status === 200, '2.1 reset devuelve 200', `got ${r.status}`);

    const afterA1 = countMessages(convA1);
    const afterA2 = countMessages(convA2);
    const afterB1 = countMessages(convB1);

    assert(beforeA1 === 2, '2.2 convA1 tenía 2 mensajes antes', `had ${beforeA1}`);
    assert(afterA1  === 0, '2.3 convA1 tiene 0 mensajes después del reset', `got ${afterA1}`);
    assert(afterA2 === beforeA2, `2.4 convA2 intacta (${beforeA2} msgs)`, `got ${afterA2}`);
    assert(afterB1 === beforeB1, `2.5 convB1 intacta (${beforeB1} msgs)`, `got ${afterB1}`);
  }
  console.log();

  // ── Suite 3: conversación de cliente real → 403, no borra nada ───────────
  console.log('Suite 3: convA2 (cliente real, no dueño) → 403, mensajes intactos');
  {
    const before = countMessages(convA2);
    const r = await req('POST', `/api/conversations/${convA2}/reset`,
      { confirmation: 'BORRAR' }, cookieA);
    const after = countMessages(convA2);
    assert(r.status === 403, '3.1 endpoint devuelve 403 para conv de cliente', `got ${r.status}`);
    assert(after === before, `3.2 mensajes de convA2 intactos (${before})`, `got ${after}`);
  }
  console.log();

  // ── Suite 4: confirmación incorrecta → 400, no borra nada ─────────────────
  console.log('Suite 4: confirmación inválida → 400, mensajes intactos');
  {
    // Re-seed convA1 messages (was reset in suite 2)
    db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'msg-reseed')").run(convA1);
    db.pragma('wal_checkpoint(FULL)');
    const before = countMessages(convA1);
    const r = await req('POST', `/api/conversations/${convA1}/reset`,
      { confirmation: 'borrar' }, cookieA);
    const after = countMessages(convA1);
    assert(r.status === 400, '4.1 endpoint devuelve 400 con confirmación incorrecta', `got ${r.status}`);
    assert(after === before, `4.2 mensajes intactos (${before})`, `got ${after}`);
  }
  console.log();

  // ── Suite 5: audit log registra el reset ──────────────────────────────────
  console.log('Suite 5: error_log registra el reset');
  {
    const entry = db.prepare(
      "SELECT message FROM error_log WHERE context = 'conv-reset' ORDER BY id DESC LIMIT 1"
    ).get();
    assert(!!entry, '5.1 existe entrada en error_log con context=conv-reset');
    assert(entry?.message?.includes(`conv_id=${convA1}`),
      `5.2 entrada menciona conv_id=${convA1}`, entry?.message);
  }
  console.log();

  console.log('──────────────────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('[fatal]', err.message); cleanup(); process.exit(1); });
