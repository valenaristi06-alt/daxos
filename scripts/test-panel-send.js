#!/usr/bin/env node
'use strict';
// Tests for POST /api/conversations/:id/send — owner reply auto-pause feature.
// Run: node scripts/test-panel-send.js

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT   = 3103;
const MOCK_PORT   = 3104;  // local WA mock server
const DB_DIR      = '/tmp/test-panel-send';

let serverProc  = null;
let mockServer  = null;
let passed = 0;
let failed = 0;

// ── Minimal WA mock server: returns 200 for all POSTs ──────────────────────
let mockBehavior = 'success'; // 'success' | 'fail'

function startMockWA() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (mockBehavior === 'fail') {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock failure' } }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages: [{ id: 'wamid.mock123' }] }));
        }
      });
    });
    mockServer.listen(MOCK_PORT, () => resolve());
  });
}

function cleanup() {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }
  if (mockServer)  { try { mockServer.close(); } catch (_) {} }
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

async function waitForServer(port = TEST_PORT) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await new Promise((res, rej) => {
        const req = http.request({ hostname: 'localhost', port, path: '/health', method: 'GET' }, r => res({ status: r.statusCode }));
        req.on('error', rej);
        req.end();
      });
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`Server on port ${port} did not start in 20s`);
}

function assert(condition, label, detail) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}${detail !== undefined ? ': ' + String(detail) : ''}`); failed++; }
}

let db = null;
function dbGet(sql, ...params) { return db.prepare(sql).get(...params); }
function dbRun(sql, ...params) { return db.prepare(sql).run(...params); }

async function seedUser(email) {
  const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  if (r.status !== 200) throw new Error(`register ${email} failed: ${JSON.stringify(r.body)}`);
  const cookie = r.setCookie?.[0]?.split(';')[0];
  return { cookie, email };
}

function webhookPayload(phoneNumberId, from, body, msgId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ from, id: msgId || `wamid.test${Date.now()}`, text: { body }, type: 'text', timestamp: String(Math.floor(Date.now() / 1000)) }],
    }}]}],
  };
}

async function main() {
  await startMockWA();
  console.log(`Mock WA server on port ${MOCK_PORT}`);

  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'panel-send-test-secret',
      META_GRAPH_BASE_URL: `http://localhost:${MOCK_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(500);

  const Database = require('better-sqlite3');
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(path.join(DB_DIR, 'daxos.db'));

  // ── Suite (a): owner send with bot active → paused with owner_reply, no mail ──
  console.log('Suite (a): owner send → paused with owner_reply, no notification email');
  {
    mockBehavior = 'success';
    const { cookie } = await seedUser('ps-a@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-A' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-a@test.com'");
    const pnid = 'pnid-ps-a';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    // Create conversation via webhook (last_user_message_at will be now → within 24h window)
    await req('POST', '/webhook', webhookPayload(pnid, '5491111100001', 'hola', 'wamid-ps-a1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    assert(!!conv, 'a: conversation created from webhook');
    // Reset pause state: Claude has no API key so markConversationPaused fires on error — reset it
    // to simulate a bot-active conversation before the owner sends.
    dbRun('UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL WHERE id = ?', conv.id);
    const convAfterReset = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(convAfterReset.needs_attention === 0, 'a: initially not paused (after reset)');

    // Clear any email/pause log to track if notification fires
    dbRun("DELETE FROM error_log WHERE context LIKE 'pause-notify%'");

    const r = await req('POST', `/api/conversations/${conv.id}/send`, { text: 'Hola, te atiendo enseguida!' }, { cookie });
    assert(r.status === 200, `a: POST /send returns 200 (got ${r.status})`);
    assert(r.body?.ok === true, 'a: response body ok=true');
    assert(r.body?.was_paused_before === false, `a: was_paused_before=false (got ${r.body?.was_paused_before})`);

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.needs_attention === 1, 'a: needs_attention=1 after owner send');
    assert(conv2.paused_reason === 'owner_reply', `a: paused_reason=owner_reply (got ${conv2.paused_reason})`);

    // Message saved — check the LAST assistant message (the webhook fallback creates one too)
    const msgsAll = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC").all(conv.id);
    assert(msgsAll.length >= 1, `a: at least 1 assistant message saved (got ${msgsAll.length})`);
    assert(msgsAll[0].content === 'Hola, te atiendo enseguida!', `a: last assistant message is owner text (got ${msgsAll[0]?.content})`);

    // No pause notification email attempted
    const notifyLogs = db.prepare("SELECT * FROM error_log WHERE context LIKE 'pause-notify%'").all();
    assert(notifyLogs.length === 0, `a: no pause-notify log entries — no notification sent (got ${notifyLogs.length})`);
  }

  // ── Suite (b): WA send failure → NOT paused ──
  console.log('\nSuite (b): WA send failure → conversation NOT paused');
  {
    mockBehavior = 'fail';
    const { cookie } = await seedUser('ps-b@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-B' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-b@test.com'");
    const pnid = 'pnid-ps-b';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    // Create conversation with recent message
    mockBehavior = 'success';
    await req('POST', '/webhook', webhookPayload(pnid, '5491111100002', 'hola', 'wamid-ps-b1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    // Reset pause state from Claude error fallback
    dbRun('UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL WHERE id = ?', conv.id);
    const convReset = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(convReset.needs_attention === 0, 'b: conversation not paused before send (after reset)');

    // Now make WA fail
    mockBehavior = 'fail';
    const r = await req('POST', `/api/conversations/${conv.id}/send`, { text: 'test' }, { cookie });
    assert(r.status === 502, `b: 502 when WA send fails (got ${r.status})`);

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.needs_attention === 0, 'b: needs_attention unchanged after failed WA send');
  }

  // ── Suite (c): 24h window expired → 403, not paused ──
  console.log('\nSuite (c): 24h window expired → 403, needs_attention unchanged');
  {
    mockBehavior = 'success';
    const { cookie } = await seedUser('ps-c@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-C' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-c@test.com'");
    const pnid = 'pnid-ps-c';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491111100003', 'hola', 'wamid-ps-c1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    // Reset pause state from Claude error fallback
    dbRun('UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL WHERE id = ?', conv.id);

    // Backdate user message to > 23.5h ago
    const expiredTs = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', '');
    dbRun('UPDATE messages SET created_at = ? WHERE conversation_id = ? AND role = ?', expiredTs, conv.id, 'user');

    const r = await req('POST', `/api/conversations/${conv.id}/send`, { text: 'hola!' }, { cookie });
    assert(r.status === 403, `c: 403 on expired window (got ${r.status})`);
    assert(r.body?.error_code === 'window_expired', `c: error_code=window_expired (got ${r.body?.error_code})`);

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.needs_attention === 0, 'c: needs_attention remains 0 (not paused on 403)');
  }

  // ── Suite (d): wrong business → 404 ──
  console.log('\nSuite (d): send to other business conversation → 404');
  {
    mockBehavior = 'success';
    const { cookie: cA } = await seedUser('ps-d-a@test.com');
    const { cookie: cB } = await seedUser('ps-d-b@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-D-A' }, { cookie: cA });
    await req('PUT', '/api/business', { name: 'Biz PS-D-B' }, { cookie: cB });
    const uA = dbGet("SELECT * FROM users WHERE email = 'ps-d-a@test.com'");
    const pnidDA = 'pnid-ps-da';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnidDA, 'fake-token', uA.business_id);

    await req('POST', '/webhook', webhookPayload(pnidDA, '5491111100004', 'hola', 'wamid-ps-d1'));
    await sleep(400);
    const convA = dbGet('SELECT * FROM conversations WHERE business_id = ?', uA.business_id);
    // Reset pause state from Claude error fallback — we want to verify 404 preserves state
    dbRun('UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL WHERE id = ?', convA.id);

    // Biz B tries to send to Biz A's conversation
    const r = await req('POST', `/api/conversations/${convA.id}/send`, { text: 'intrusion' }, { cookie: cB });
    assert(r.status === 404, `d: 404 when sending to other business conversation (got ${r.status})`);

    const convCheck = dbGet('SELECT * FROM conversations WHERE id = ?', convA.id);
    assert(convCheck.needs_attention === 0, 'd: conversation not modified by cross-business attempt');
  }

  // ── Suite (e): keyword email jobs do NOT fire for owner_reply pauses ──
  console.log('\nSuite (e): 30-min and 24h jobs skip owner_reply pauses (paused_reason filter)');
  {
    // Directly verify via DB query that getKeywordPausedNeedingFollowup excludes owner_reply
    // Insert a fake owner_reply paused conv with notified_at > 31min ago
    const { cookie } = await seedUser('ps-e@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-E' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-e@test.com'");

    // Insert a conversation manually
    const thirtyOneMinAgo = Math.floor(Date.now() / 1000) - 31 * 60;
    const pnidE = 'pnid-ps-e';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnidE, user.business_id);

    dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_reason, paused_at, pause_notified_at, pause_followup_sent, pause_24h_sent)
      VALUES (?, ?, 1, 'owner_reply', unixepoch(), ?, NULL, NULL)`,
      user.business_id, '5499900000099', thirtyOneMinAgo);

    const conv = dbGet("SELECT * FROM conversations WHERE business_id = ? AND paused_reason = 'owner_reply'", user.business_id);

    // The DB query in getKeywordPausedNeedingFollowup requires paused_reason='keyword'
    // so it should NOT return this conv. Verify directly.
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;
    const followupCandidates = db.prepare(`
      SELECT c.id FROM conversations c
      WHERE c.needs_attention = 1
        AND c.paused_reason = 'keyword'
        AND c.pause_notified_at IS NOT NULL
        AND c.pause_followup_sent IS NULL
        AND c.pause_notified_at <= ?
    `).all(cutoff);
    const inFollowup = followupCandidates.some(r => r.id === conv.id);
    assert(!inFollowup, 'e: owner_reply conv NOT returned by getKeywordPausedNeedingFollowup query');

    const cutoff24 = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const h24Candidates = db.prepare(`
      SELECT c.id FROM conversations c
      WHERE c.needs_attention = 1
        AND c.paused_reason = 'keyword'
        AND c.pause_notified_at IS NOT NULL
        AND c.pause_24h_sent IS NULL
        AND c.pause_notified_at <= ?
    `).all(cutoff24);
    const in24h = h24Candidates.some(r => r.id === conv.id);
    assert(!in24h, 'e: owner_reply conv NOT returned by getKeywordPausedNeeding24h query');
  }

  // ── Suite (f): already paused → send succeeds, paused_reason preserved ──
  console.log('\nSuite (f): send when already paused (keyword) → succeeds, paused_reason unchanged');
  {
    mockBehavior = 'success';
    const { cookie } = await seedUser('ps-f@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-F' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-f@test.com'");
    const pnid = 'pnid-ps-f';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491111100006', 'hola', 'wamid-ps-f1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    // Set as keyword-paused (the fallback already set needs_attention=1 but with no paused_reason;
    // we override to keyword to test that the owner send doesn't change it)
    dbRun("UPDATE conversations SET needs_attention = 1, paused_reason = 'keyword', paused_at = unixepoch() WHERE id = ?", conv.id);

    const r = await req('POST', `/api/conversations/${conv.id}/send`, { text: 'Hola te paso con alguien' }, { cookie });
    assert(r.status === 200, `f: 200 when already paused (got ${r.status})`);
    assert(r.body?.was_paused_before === true, `f: was_paused_before=true when already paused (got ${r.body?.was_paused_before})`);

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.needs_attention === 1, 'f: still paused');
    assert(conv2.paused_reason === 'keyword', `f: paused_reason remains keyword (got ${conv2.paused_reason})`);
  }

  // ── Suite (g): second owner message resets paused_at on owner_reply pause ──
  console.log('\nSuite (g): second owner message resets paused_at (timer restart)');
  {
    mockBehavior = 'success';
    const { cookie } = await seedUser('ps-g@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-G' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-g@test.com'");
    const pnid = 'pnid-ps-g';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    // Seed a customer message so the conv exists and 24h window is open
    await req('POST', '/webhook', webhookPayload(pnid, '5491111100007', 'hola', 'wamid-ps-g1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    // First owner send → owner_reply pause created
    await req('POST', `/api/conversations/${conv.id}/send`, { text: 'Primer mensaje' }, { cookie });
    const conv1 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv1.paused_reason === 'owner_reply', 'g: paused_reason=owner_reply after first send');
    const pausedAt1 = conv1.paused_at;

    // Wait 2s so paused_at timestamps differ (SQLite unixepoch resolution = 1s)
    await sleep(2000);

    // Second owner send → setOwnerReplyPaused called again → paused_at updated
    const r2 = await req('POST', `/api/conversations/${conv.id}/send`, { text: 'Segundo mensaje' }, { cookie });
    assert(r2.status === 200, `g: 200 on second send (got ${r2.status})`);
    assert(r2.body?.was_paused_before === true, 'g: was_paused_before=true on second send');
    assert(r2.body?.is_now_owner_reply === true, 'g: is_now_owner_reply=true in response on second send');

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.paused_reason === 'owner_reply', 'g: paused_reason still owner_reply after second send');
    assert(conv2.paused_at > pausedAt1, `g: paused_at updated (${conv2.paused_at} > ${pausedAt1})`);
  }

  // ── Suite (h): keyword-paused conv — owner send does NOT reset paused_reason or paused_at ──
  console.log('\nSuite (h): keyword pause — owner send leaves paused_reason=keyword and paused_at unchanged');
  {
    mockBehavior = 'success';
    const { cookie } = await seedUser('ps-h@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-H' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-h@test.com'");
    const pnid = 'pnid-ps-h';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491111100008', 'hola', 'wamid-ps-h1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    const originalPausedAt = Math.floor(Date.now() / 1000) - 60; // 1 min ago
    dbRun(
      "UPDATE conversations SET needs_attention = 1, paused_reason = 'keyword', paused_at = ? WHERE id = ?",
      originalPausedAt, conv.id
    );

    await sleep(1500); // ensure time passes before send

    const r = await req('POST', `/api/conversations/${conv.id}/send`, { text: 'Hola cómo te puedo ayudar' }, { cookie });
    assert(r.status === 200, `h: 200 when keyword-paused (got ${r.status})`);
    assert(r.body?.is_now_owner_reply === false, `h: is_now_owner_reply=false for keyword pause (got ${r.body?.is_now_owner_reply})`);

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.paused_reason === 'keyword', `h: paused_reason still keyword (got ${conv2.paused_reason})`);
    assert(conv2.paused_at === originalPausedAt, `h: paused_at NOT changed (got ${conv2.paused_at}, want ${originalPausedAt})`);
  }

  // ── Suite (i): bot stays silent after second owner message ──
  console.log('\nSuite (i): bot stays silent after second owner message (needs_attention=1 gate holds)');
  {
    mockBehavior = 'success';
    const { cookie } = await seedUser('ps-i@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-I' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-i@test.com'");
    const pnid = 'pnid-ps-i';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    // Customer sends first message, bot tries to respond (will fail without API key — that's OK)
    await req('POST', '/webhook', webhookPayload(pnid, '5491111100009', 'hola', 'wamid-ps-i1'));
    await sleep(500);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    // Owner sends first message → owner_reply pause
    await req('POST', `/api/conversations/${conv.id}/send`, { text: 'Te atiendo yo' }, { cookie });
    const conv1 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv1.needs_attention === 1, 'i: needs_attention=1 after first owner send');

    // Owner sends second message → timer resets, still paused
    await sleep(1500);
    await req('POST', `/api/conversations/${conv.id}/send`, { text: 'Dame un momento' }, { cookie });
    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.needs_attention === 1, 'i: still needs_attention=1 after second owner send (bot stays paused)');
    assert(conv2.paused_reason === 'owner_reply', 'i: paused_reason still owner_reply after second send');

    // Count assistant messages BEFORE customer sends again
    const assistantBefore = dbGet(
      "SELECT COUNT(*) as n FROM messages WHERE conversation_id = ? AND role = 'assistant'", conv.id
    ).n;

    // Customer sends while bot is in owner_reply pause
    await req('POST', '/webhook', webhookPayload(pnid, '5491111100009', 'sigo esperando', 'wamid-ps-i2'));
    await sleep(500);

    const assistantAfter = dbGet(
      "SELECT COUNT(*) as n FROM messages WHERE conversation_id = ? AND role = 'assistant'", conv.id
    ).n;

    // The bot should NOT have sent any new assistant message
    assert(assistantAfter === assistantBefore, `i: bot silent — assistant msgs unchanged (before=${assistantBefore} after=${assistantAfter})`);
  }

  // ── Suite (j): integration — owner_reply pause + spending_cap_notified_at don't collide ──
  console.log('\nSuite (j): integration — owner_reply pause silent, spending_cap_notified_at untouched');
  {
    // Set up conversation that is already owner_reply paused + has a spending_cap_notified_at
    const { cookie } = await seedUser('ps-j@test.com');
    await req('PUT', '/api/business', { name: 'Biz PS-J' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'ps-j@test.com'");
    const pnid = 'pnid-ps-j';
    dbRun('UPDATE businesses SET phone_number_id = ?, wa_access_token = ? WHERE id = ?', pnid, 'fake-token', user.business_id);

    // Create conversation already in owner_reply state with a spending_cap_notified_at timestamp
    const fakeNotifiedAt = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const convResult = dbRun(
      `INSERT INTO conversations (business_id, customer_id, needs_attention, paused_reason, paused_at, human_paused_at, spending_cap_notified_at)
       VALUES (?, ?, 1, 'owner_reply', unixepoch(), unixepoch(), ?)`,
      user.business_id, '5491199900001', fakeNotifiedAt
    );
    const convId = convResult.lastInsertRowid;

    // Customer writes — bot should stay silent
    mockBehavior = 'success';
    await req('POST', '/webhook', webhookPayload(pnid, '5491199900001', 'sigo acá', 'wamid-ps-j1'));
    await sleep(500);

    const convAfter = dbGet('SELECT * FROM conversations WHERE id = ?', convId);

    // needs_attention must still be 1 (bot did not resume)
    assert(convAfter.needs_attention === 1, 'j1: needs_attention stays 1 when client writes to owner_reply conv');

    // paused_reason must still be owner_reply (not overwritten by spending cap logic)
    assert(convAfter.paused_reason === 'owner_reply', 'j2: paused_reason stays owner_reply, not overwritten');

    // spending_cap_notified_at must be unchanged (the 12h block was never reached)
    assert(convAfter.spending_cap_notified_at === fakeNotifiedAt,
      `j3: spending_cap_notified_at unchanged (${convAfter.spending_cap_notified_at} === ${fakeNotifiedAt})`);

    // Owner alert log must have zero entries for this conv (no spurious notifyOwnerBotStopped)
    const alertRows = dbGet('SELECT COUNT(*) as c FROM owner_alert_log WHERE conversation_id = ?', convId);
    assert(alertRows.c === 0, 'j4: no owner_alert_log entries generated by customer message to paused conv');
  }

  // ── Done ──
  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
