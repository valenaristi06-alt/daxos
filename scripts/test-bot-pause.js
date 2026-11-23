#!/usr/bin/env node
'use strict';
// Tests for the owner master switch bot_paused (migration 027).
// Run: node scripts/test-bot-pause.js
//
// "The bot sent nothing" == zero assistant rows in messages for that conversation
// (the reply / audio / after-hours / pause-reply paths all write an assistant row
// right before sending; the mute gate returns before any of them).

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3112;
const DB_DIR    = '/tmp/test-bot-pause';
const BASE_URL  = `http://localhost:${TEST_PORT}`;

let serverProc = null;
let passed = 0, failed = 0;

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
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers }, (res) => {
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
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

let db = null;
const dbGet = (sql, ...p) => db.prepare(sql).get(...p);
const dbRun = (sql, ...p) => db.prepare(sql).run(...p);
const dbAll = (sql, ...p) => db.prepare(sql).all(...p);

async function seedUser(email) {
  const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  if (r.status !== 200) throw new Error(`register ${email} failed: ${JSON.stringify(r.body)}`);
  return { cookie: r.setCookie?.[0]?.split(';')[0], email };
}

function webhook(pnid, from, body, msgId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: pnid },
      messages: [{ from, id: msgId || `wamid.test${Date.now()}`, text: { body }, type: 'text', timestamp: String(Math.floor(Date.now() / 1000)) }],
    }}]}],
  };
}

function assistantCount(convId) {
  return dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', convId, 'assistant').length;
}

async function setupBiz(email, pnid, provider) {
  const { cookie } = await seedUser(email);
  await req('PUT', '/api/business', { name: `Biz ${email}` }, { cookie });
  const user = dbGet('SELECT * FROM users WHERE email = ?', email);
  dbRun('UPDATE businesses SET phone_number_id = ?, wa_provider = ? WHERE id = ?', pnid, provider, user.business_id);
  return { cookie, businessId: user.business_id };
}

async function main() {
  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 'bot-pause-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  await sleep(500);
  const Database = require('better-sqlite3');
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(path.join(DB_DIR, 'daxos.db'));

  // ── Migration 027 columns exist, default off ───────────────────────────────
  console.log('Suite (0): migration 027 columns');
  {
    const cols = db.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
    assert(cols.includes('bot_paused'), 'businesses.bot_paused exists');
    assert(cols.includes('bot_paused_at'), 'businesses.bot_paused_at exists');
  }

  // ── (a) Meta business paused: existing chat + new customer → nothing sent ───
  console.log('\nSuite (a): paused Meta business sends nothing');
  const A = await setupBiz('a@test.com', 'pnid-a', 'meta');
  {
    const r = await req('POST', '/api/business/bot-paused', { paused: true }, { cookie: A.cookie });
    assert(r.status === 200 && r.body.bot_paused === 1, 'owner pauses own business via API');
    assert(dbGet('SELECT bot_paused FROM businesses WHERE id = ?', A.businessId).bot_paused === 1, 'bot_paused=1 in DB');

    await req('POST', '/webhook', webhook('pnid-a', '5491111111111', 'Hola, info?', 'a1'));
    await req('POST', '/webhook', webhook('pnid-a', '5491111111111', 'Siguen ahí?', 'a2'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', A.businessId);
    assert(!!conv, 'existing-chat conversation created while paused');
    assert(assistantCount(conv.id) === 0, 'existing chat: 0 assistant replies (nothing sent)');
    const userMsgs = dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', conv.id, 'user');
    assert(userMsgs.length === 2 && userMsgs.every(m => m.silent === 1), 'incoming msgs saved as silent');

    // New customer while paused
    await req('POST', '/webhook', webhook('pnid-a', '5492222222222', 'Primera vez', 'a3'));
    await sleep(300);
    const conv2 = dbGet('SELECT * FROM conversations WHERE business_id = ? AND customer_id LIKE ?', A.businessId, '%2222222222%');
    assert(!!conv2 && assistantCount(conv2.id) === 0, 'new customer while paused: 0 assistant replies');
  }

  // ── (b) Baileys business paused → nothing sent (shared gate) ────────────────
  console.log('\nSuite (b): paused Baileys business sends nothing');
  {
    const B = await setupBiz('b@test.com', 'pnid-b', 'baileys');
    await req('POST', '/api/business/bot-paused', { paused: true }, { cookie: B.cookie });
    await req('POST', '/webhook', webhook('pnid-b', '5493333333333', 'Hola baileys', 'b1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', B.businessId);
    assert(!!conv && assistantCount(conv.id) === 0, 'baileys paused: 0 assistant replies');
    const um = dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', conv.id, 'user');
    assert(um.length === 1 && um[0].silent === 1, 'baileys incoming saved as silent');
  }

  // ── (c) Resume does NOT answer old accumulated messages (no replay) ─────────
  console.log('\nSuite (c): resume does not reply to old messages');
  {
    const r = await req('POST', '/api/business/bot-paused', { paused: false }, { cookie: A.cookie });
    assert(r.status === 200 && r.body.bot_paused === 0, 'owner resumes own business');
    assert(dbGet('SELECT bot_paused FROM businesses WHERE id = ?', A.businessId).bot_paused === 0, 'bot_paused=0 in DB after resume');
    await sleep(1200); // give any catch-up job a chance to (wrongly) fire
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ? AND customer_id LIKE ?', A.businessId, '%1111111111%');
    assert(assistantCount(conv.id) === 0, 'after resume: old messages still unanswered (no replay)');
  }

  // ── (d) One business cannot pause another ───────────────────────────────────
  console.log('\nSuite (d): a business cannot pause another');
  {
    const C = await setupBiz('c@test.com', 'pnid-c', 'meta');
    // Owner C pauses — route is scoped to the session's own business, no id param.
    await req('POST', '/api/business/bot-paused', { paused: true }, { cookie: C.cookie });
    assert(dbGet('SELECT bot_paused FROM businesses WHERE id = ?', C.businessId).bot_paused === 1, 'owner C paused own business');
    assert(dbGet('SELECT bot_paused FROM businesses WHERE id = ?', A.businessId).bot_paused === 0, "owner C did NOT affect business A");
    // Business A is resumed; a message to A must still be processed normally (not muted).
    await req('POST', '/webhook', webhook('pnid-a', '5494444444444', 'cliente de A', 'a4'));
    await sleep(300);
    const convA = dbGet('SELECT * FROM conversations WHERE business_id = ? AND customer_id LIKE ?', A.businessId, '%4444444444%');
    const uA = dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', convA.id, 'user');
    assert(uA.length >= 1 && uA[0].silent !== 1, 'un-paused business A: new msg processed normally (not muted)');
  }

  // ── (e) Untouched business behaves like today (default off) ─────────────────
  console.log('\nSuite (e): untouched business unchanged');
  {
    const D = await setupBiz('d@test.com', 'pnid-d', 'meta');
    const view = await req('GET', '/api/business', null, { cookie: D.cookie });
    assert(view.body.bot_paused === 0, 'default bot_paused=0 in owner view');
    assert(view.body.admin_silenced === false, 'default admin_silenced=false');
    await req('POST', '/webhook', webhook('pnid-d', '5495555555555', 'hola', 'd1'));
    await sleep(300);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', D.businessId);
    const u = dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', conv.id, 'user');
    assert(u.length >= 1 && u[0].silent !== 1, 'untouched business: inbound not muted');
  }

  console.log(`\n── Results ── passed=${passed} failed=${failed}`);
  db.close();
  serverProc.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); cleanup(); process.exit(1); });
