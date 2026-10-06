#!/usr/bin/env node
'use strict';
// Tests for pause-keyword feature (migration 007).
// Run: node scripts/test-pause-keyword.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT        = 3100;
const DB_DIR           = '/tmp/test-pause-keyword';
const ADMIN_TOKEN      = 'test-admin-token-007';
const BASE_URL         = `http://localhost:${TEST_PORT}`;

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

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; }
    catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

let db = null;
function dbGet(sql, ...params) { return db.prepare(sql).get(...params); }
function dbRun(sql, ...params) { return db.prepare(sql).run(...params); }
function dbAll(sql, ...params) { return db.prepare(sql).all(...params); }

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
  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'pause-kw-test-secret',
      ADMIN_SET_WA_TOKEN: ADMIN_TOKEN,
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

  // ── Suite (a): keyword → pauses conv, sends 1 assistant reply ──
  console.log('Suite (a): keyword triggers pause + assistant reply');
  {
    const { cookie } = await seedUser('kwa@test.com');
    await req('PUT', '/api/business', {
      name: 'Biz A',
      pause_keywords: 'contra entrega,devolución',
      pause_reply_text: 'Te atendemos enseguida.',
    }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwa@test.com'");
    const pnid = 'pnid-a';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491111111111', 'Quiero contra entrega', 'wamid-a1'));
    await sleep(300);

    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    assert(!!conv, 'conversation created');
    assert(conv.needs_attention === 1, 'needs_attention=1 after keyword');
    assert(conv.paused_reason === 'keyword', 'paused_reason=keyword');
    assert(conv.pause_reply_count === 1, 'pause_reply_count=1');
    assert(!!conv.pause_last_reply_at, 'pause_last_reply_at set');

    const msgs = dbAll('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', conv.id);
    const assistantMsgs = msgs.filter(m => m.role === 'assistant');
    assert(assistantMsgs.length === 1, '1 assistant reply sent');
    assert(assistantMsgs[0].content === 'Te atendemos enseguida.', 'reply uses pause_reply_text');

    const userMsgs = msgs.filter(m => m.role === 'user');
    assert(userMsgs.length === 1, '1 user message recorded');
  }

  // ── Suite (b): repeat reply throttling ──
  console.log('\nSuite (b): repeat reply throttled by 15-min window');
  {
    const { cookie } = await seedUser('kwb@test.com');
    await req('PUT', '/api/business', { name: 'Biz B', pause_keywords: 'urgente' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwb@test.com'");
    const pnid = 'pnid-b';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    // Trigger keyword pause
    await req('POST', '/webhook', webhookPayload(pnid, '5491122222222', 'es urgente', 'wamid-b1'));
    await sleep(300);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    // Backdate pause_last_reply_at to 5 min ago → below 15-min threshold → no reply
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 5 * 60;
    dbRun('UPDATE conversations SET pause_last_reply_at = ? WHERE id = ?', fiveMinAgo, conv.id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491122222222', 'sigo esperando', 'wamid-b2'));
    await sleep(300);
    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    const msgs2 = dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', conv.id, 'assistant');
    assert(msgs2.length === 1, 'no second reply within 5-min window');
    assert(conv2.pause_reply_count === 1, 'pause_reply_count still 1 within window');

    // Backdate to 16 min ago → above threshold → reply sent
    const sixteenMinAgo = Math.floor(Date.now() / 1000) - 16 * 60;
    dbRun('UPDATE conversations SET pause_last_reply_at = ? WHERE id = ?', sixteenMinAgo, conv.id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491122222222', 'alguien me atiende?', 'wamid-b3'));
    await sleep(300);
    const conv3 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    const msgs3 = dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', conv.id, 'assistant');
    assert(msgs3.length === 2, 'second reply sent after 16-min window');
    assert(conv3.pause_reply_count === 2, 'pause_reply_count=2 after second reply');
  }

  // ── Suite (b2): max 3 replies per pause ──
  console.log('\nSuite (b2): max 3 replies per pause');
  {
    const { cookie } = await seedUser('kwb2@test.com');
    await req('PUT', '/api/business', { name: 'Biz B2', pause_keywords: 'devolucion' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwb2@test.com'");
    const pnid = 'pnid-b2';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491133333333', 'devolucion', 'wamid-b2-1'));
    await sleep(300);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    // Manually set count=3 and last_reply to long ago
    dbRun('UPDATE conversations SET pause_reply_count = 3, pause_last_reply_at = ? WHERE id = ?',
      Math.floor(Date.now() / 1000) - 20 * 60, conv.id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491133333333', 'sigo esperando', 'wamid-b2-2'));
    await sleep(300);
    const msgs = dbAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', conv.id, 'assistant');
    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(msgs.length === 1, 'no reply when pause_reply_count=3 (max reached)');
    assert(conv2.pause_reply_count === 3, 'pause_reply_count unchanged at 3');
  }

  // ── Suite (c): pause_notified_at set after notify chain ──
  console.log('\nSuite (c): pause_notified_at set after notification');
  {
    const { cookie } = await seedUser('kwc@test.com');
    await req('PUT', '/api/business', { name: 'Biz C', pause_keywords: 'cancelar' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwc@test.com'");
    const pnid = 'pnid-c';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491144444444', 'quiero cancelar', 'wamid-c1'));
    await sleep(400);

    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    // sendPauseEmail warns+returns when no RESEND_API_KEY, so .then() fires and sets pause_notified_at
    assert(!!conv.pause_notified_at, 'pause_notified_at set (notify chain fired)');
  }

  // ── Suite (d): 30-min followup job ──
  console.log('\nSuite (d): /admin/api/run-pause-jobs sends 30-min followup');
  {
    const { cookie } = await seedUser('kwd@test.com');
    await req('PUT', '/api/business', { name: 'Biz D', pause_keywords: 'hablar' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwd@test.com'");
    const pnid = 'pnid-d';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491155555555', 'quiero hablar', 'wamid-d1'));
    await sleep(400);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    // Backdate pause_notified_at to 31 min ago
    const thirtyOneMinAgo = Math.floor(Date.now() / 1000) - 31 * 60;
    dbRun('UPDATE conversations SET pause_notified_at = ?, pause_followup_sent = NULL WHERE id = ?',
      thirtyOneMinAgo, conv.id);

    const r = await req('POST', '/admin/api/run-pause-jobs', null, { bearer: ADMIN_TOKEN });
    assert(r.status === 200, '/admin/api/run-pause-jobs returns 200');

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    // No RESEND_API_KEY → email skipped → but setPauseFollowupSent still called in catch? No — it's in try after await
    // With no key, sendPauseFollowupEmail warns+returns (no throw), so setPauseFollowupSent fires
    assert(!!conv2.pause_followup_sent, 'pause_followup_sent set after job');
  }

  // ── Suite (e): auto-resume resumes paused_reason=keyword after 12h; never resumes 'trial' ──
  console.log('\nSuite (e): auto-resume resumes keyword after 12h, excludes trial');
  {
    const { cookie } = await seedUser('kwe@test.com');
    await req('PUT', '/api/business', { name: 'Biz E', pause_keywords: 'test' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwe@test.com'");
    const pnid = 'pnid-e';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    // Two conversations: keyword-paused 13h ago (should resume), trial-paused 25h ago (should NOT)
    await req('POST', '/webhook', webhookPayload(pnid, '5491166666666', 'test keyword', 'wamid-e1'));
    await sleep(300);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    const thirteenHoursAgo = Math.floor(Date.now() / 1000) - 13 * 60 * 60;
    dbRun('UPDATE conversations SET needs_attention = 1, paused_reason = ?, paused_at = ? WHERE id = ?',
      'keyword', thirteenHoursAgo, conv.id);

    // Create a trial-paused conversation manually
    dbRun('INSERT INTO conversations (business_id, customer_id, needs_attention, paused_reason, paused_at) VALUES (?, ?, 1, ?, ?)',
      user.business_id, '5499999999', 'trial', thirteenHoursAgo);
    const trialConv = dbGet("SELECT * FROM conversations WHERE business_id = ? AND paused_reason = 'trial'", user.business_id);

    const r = await req('POST', '/admin/api/run-auto-resume', null, { bearer: ADMIN_TOKEN });
    assert(r.status === 200, '/admin/api/run-auto-resume returns 200');

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.needs_attention === 0, 'needs_attention cleared (keyword paused 13h auto-resumed at 12h cutoff)');
    assert(conv2.paused_reason === null, 'paused_reason cleared after auto-resume');

    const trialConv2 = dbGet('SELECT * FROM conversations WHERE id = ?', trialConv.id);
    assert(trialConv2.needs_attention === 1, 'trial-paused still needs_attention=1 (trial excluded from auto-resume)');
  }

  // ── Suite (f): needs_attention=1 paused_reason=NULL → no pause_reply_count change ──
  console.log('\nSuite (f): human-paused conv (paused_reason=NULL) → no keyword reply logic');
  {
    const { cookie } = await seedUser('kwf@test.com');
    await req('PUT', '/api/business', { name: 'Biz F', pause_keywords: 'devolucion' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwf@test.com'");
    const pnid = 'pnid-f';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    // Create conversation and manually set human-paused (needs_attention=1, paused_reason=NULL)
    await req('POST', '/webhook', webhookPayload(pnid, '5491177777777', 'hola', 'wamid-f1'));
    await sleep(300);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    dbRun('UPDATE conversations SET needs_attention = 1, paused_reason = NULL, pause_reply_count = 0 WHERE id = ?', conv.id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491177777777', 'devolucion urgente', 'wamid-f2'));
    await sleep(300);

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.pause_reply_count === 0, 'pause_reply_count unchanged (human-paused, not keyword)');
    assert(conv2.needs_attention === 1, 'still paused');
  }

  // ── Suite (g): pause_reply_text stored and returned as-is ──
  console.log('\nSuite (g): pause_reply_text stored + returned via GET /api/business');
  {
    const { cookie } = await seedUser('kwg@test.com');
    const xssText = '<script>alert(1)</script>';
    const r = await req('PUT', '/api/business', {
      name: 'Biz G',
      pause_keywords: 'test',
      pause_reply_text: xssText,
    }, { cookie });
    assert(r.status === 200, 'PUT /api/business with pause_reply_text → 200');

    const get = await req('GET', '/api/business', null, { cookie });
    assert(get.status === 200, 'GET /api/business 200');
    assert(get.body.pause_reply_text === xssText, 'pause_reply_text returned raw (safe in input.value)');
  }

  // ── Suite (h): resume clears all pause fields ──
  console.log('\nSuite (h): PATCH /api/conversations/:id/resume clears all pause fields');
  {
    const { cookie } = await seedUser('kwh@test.com');
    await req('PUT', '/api/business', { name: 'Biz H', pause_keywords: 'test' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwh@test.com'");
    const pnid = 'pnid-h';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    await req('POST', '/webhook', webhookPayload(pnid, '5491188888888', 'test kw', 'wamid-h1'));
    await sleep(300);
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);

    // Set all pause fields
    const now = Math.floor(Date.now() / 1000);
    dbRun(`UPDATE conversations SET
      needs_attention = 1, paused_reason = 'keyword', paused_at = ?,
      pause_reply_count = 2, pause_last_reply_at = ?,
      pause_notified_at = ?, pause_followup_sent = ?, pause_24h_sent = ?
      WHERE id = ?`, now, now, now, now, now, conv.id);

    const r = await req('PATCH', `/api/conversations/${conv.id}/resume`, null, { cookie });
    assert(r.status === 200, 'PATCH /resume returns 200');

    const conv2 = dbGet('SELECT * FROM conversations WHERE id = ?', conv.id);
    assert(conv2.needs_attention === 0, 'needs_attention cleared');
    assert(conv2.paused_reason === null, 'paused_reason cleared');
    assert(conv2.paused_at === null, 'paused_at cleared');
    assert(conv2.pause_reply_count === 0, 'pause_reply_count reset to 0');
    assert(conv2.pause_last_reply_at === null, 'pause_last_reply_at cleared');
    assert(conv2.pause_notified_at === null, 'pause_notified_at cleared');
    assert(conv2.pause_followup_sent === null, 'pause_followup_sent cleared');
    assert(conv2.pause_24h_sent === null, 'pause_24h_sent cleared');
  }

  // ── Suite (i): keyword normalization ──
  console.log('\nSuite (i): keyword normalization — accents, case, punctuation, double spaces');
  {
    const { cookie } = await seedUser('kwi@test.com');
    await req('PUT', '/api/business', {
      name: 'Biz I',
      pause_keywords: 'devolución,contra entrega,reacción',
      pause_reply_text: 'Normalization test.',
    }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwi@test.com'");
    const pnid = 'pnid-i';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnid, user.business_id);

    const cases = [
      ['DEVOLUCIÓN',              'wamid-i1', 'DEVOLUCIÓN matches keyword devolución'],
      ['devolucion',              'wamid-i2', 'devolucion (no accent) matches keyword devolución'],
      ['Quiero contra  entrega!', 'wamid-i3', 'double space + punctuation matches contra entrega'],
      ['tengo una reaccion hoy',  'wamid-i4', 'reaccion (no accent) matches keyword reacción'],
    ];

    for (const [body, msgId, label] of cases) {
      // Reset any existing conv so each message creates fresh context
      const existingConv = dbGet('SELECT id FROM conversations WHERE business_id = ?', user.business_id);
      if (existingConv) {
        dbRun('UPDATE conversations SET needs_attention = 0, paused_reason = NULL, paused_at = NULL, pause_reply_count = 0 WHERE id = ?', existingConv.id);
      }
      await req('POST', '/webhook', webhookPayload(pnid, '5491199999990', body, msgId));
      await sleep(300);
      const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
      assert(conv.needs_attention === 1, label);
    }

    // No match — should NOT pause
    const existingConv = dbGet('SELECT id FROM conversations WHERE business_id = ?', user.business_id);
    if (existingConv) {
      dbRun('UPDATE conversations SET needs_attention = 0, paused_reason = NULL, paused_at = NULL, pause_reply_count = 0 WHERE id = ?', existingConv.id);
    }
    await req('POST', '/webhook', webhookPayload(pnid, '5491199999990', 'hola como estas', 'wamid-i5'));
    await sleep(500); // wait longer since this goes to Claude (will fail → no change)
    const convFinal = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    assert(convFinal.needs_attention === 0, 'hola como estas → no pause (no keyword match)');
  }

  // ── Suite (j): owner phone normalization ──
  console.log('\nSuite (j): owner phone normalization');
  {
    // Test the normalization logic directly via DB inspection
    // 099123456 → 59899123456, +59899123456 → 59899123456, 59899123456 → 59899123456
    const { cookie } = await seedUser('kwj@test.com');
    await req('PUT', '/api/business', { name: 'Biz J', pause_keywords: 'test' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwj@test.com'");
    const pnid = 'pnid-j';
    dbRun('UPDATE businesses SET phone_number_id = ?, whatsapp_number = ? WHERE id = ?',
      pnid, '59899000001', user.business_id);

    const phoneCases = [
      ['099123456',      '59899123456'],
      ['+59899123456',   '59899123456'],
      ['59899123456',    '59899123456'],
    ];
    // Set owner phone and trigger pause; check error_log table for wa-error log
    // (WA will fail with no real creds — error should contain ****3456)
    for (const [rawPhone, normalized] of phoneCases) {
      dbRun('UPDATE users SET phone = ? WHERE id = ?', rawPhone, user.id);
      // Clear error_log for this label
      dbRun("DELETE FROM error_log WHERE context = 'pause-notify-wa-error'");

      // Reset conv
      const existingConv = dbGet('SELECT id FROM conversations WHERE business_id = ?', user.business_id);
      if (existingConv) {
        dbRun('UPDATE conversations SET needs_attention = 0, paused_reason = NULL, paused_at = NULL, pause_reply_count = 0 WHERE id = ?', existingConv.id);
      }

      await req('POST', '/webhook', webhookPayload(pnid, '5491100000000', 'test kw', `wamid-j-${rawPhone}`));
      await sleep(400);

      const error_log = dbAll("SELECT * FROM error_log WHERE context = 'pause-notify-wa-error'");
      // No real WA creds → should fail → error logged with last 4 of normalized phone
      const last4 = normalized.slice(-4);
      const hasLastFour = error_log.some(e => e.message.includes(last4));
      assert(hasLastFour, `${rawPhone} → normalized ****${last4} appears in error log`);
    }
  }

  // ── Suite (k): self-send prevention ──
  console.log('\nSuite (k): owner phone == business WA → self-send prevented + logged');
  {
    const { cookie } = await seedUser('kwk@test.com');
    await req('PUT', '/api/business', { name: 'Biz K', pause_keywords: 'cancelar' }, { cookie });
    const user = dbGet("SELECT * FROM users WHERE email = 'kwk@test.com'");
    const pnid = 'pnid-k';
    const sharedPhone = '59899777777';
    dbRun('UPDATE businesses SET phone_number_id = ?, whatsapp_number = ? WHERE id = ?',
      pnid, sharedPhone, user.business_id);
    dbRun('UPDATE users SET phone = ? WHERE id = ?', sharedPhone, user.id);
    dbRun("DELETE FROM error_log WHERE context = 'pause-notify-wa-error'");

    await req('POST', '/webhook', webhookPayload(pnid, '5491111111199', 'cancelar pedido', 'wamid-k1'));
    await sleep(400);

    const error_log = dbAll("SELECT * FROM error_log WHERE context = 'pause-notify-wa-error'");
    const selfSendLog = error_log.find(e => e.message.includes('self-send'));
    assert(!!selfSendLog, 'self-send prevented and logged as pause-notify-wa-error');

    // Email must still be attempted (sendPauseEmail warns+returns with no RESEND_API_KEY, no crash)
    const conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', user.business_id);
    assert(conv.needs_attention === 1, 'conversation still paused (email path ran, no crash)');
  }

  // ── Suite (l): business hours — 3 default text situations ──
  console.log('\nSuite (l): business hours default text');
  {
    // l1: no hours configured → "en cuanto pueda 💗"
    const { cookie: cl1 } = await seedUser('kwl1@test.com');
    await req('PUT', '/api/business', { name: 'Biz L1', pause_keywords: 'cancelar' }, { cookie: cl1 });
    const ul1 = dbGet("SELECT * FROM users WHERE email = 'kwl1@test.com'");
    const pnidL1 = 'pnid-l1';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnidL1, ul1.business_id);
    // no business_hours set

    await req('POST', '/webhook', webhookPayload(pnidL1, '549100000001', 'cancelar pedido', 'wamid-l1'));
    await sleep(300);
    const cl1conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', ul1.business_id);
    const cl1msgs = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", cl1conv.id);
    assert(cl1msgs.length === 1, 'l1: exactly 1 assistant reply with no hours configured');
    assert(cl1msgs[0].content === 'Te paso con una persona del equipo, te escribe en cuanto pueda 💗',
      'l1: default text is "en cuanto pueda 💗" when no hours set');

    // l2: within hours (00:00–23:59) → same "en cuanto pueda 💗"
    const { cookie: cl2 } = await seedUser('kwl2@test.com');
    await req('PUT', '/api/business', { name: 'Biz L2', pause_keywords: 'cancelar' }, { cookie: cl2 });
    const ul2 = dbGet("SELECT * FROM users WHERE email = 'kwl2@test.com'");
    const pnidL2 = 'pnid-l2';
    dbRun('UPDATE businesses SET phone_number_id = ?, business_hours_start = ?, business_hours_end = ? WHERE id = ?',
      pnidL2, '00:00', '23:59', ul2.business_id);

    await req('POST', '/webhook', webhookPayload(pnidL2, '549100000002', 'cancelar pedido', 'wamid-l2'));
    await sleep(300);
    const cl2conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', ul2.business_id);
    const cl2msgs = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", cl2conv.id);
    assert(cl2msgs.length === 1, 'l2: exactly 1 assistant reply within hours');
    assert(cl2msgs[0].content === 'Te paso con una persona del equipo, te escribe en cuanto pueda 💗',
      'l2: default text is "en cuanto pueda 💗" when within hours');

    // l3: always outside hours (23:59–00:00) → "fuera de horario"
    const { cookie: cl3 } = await seedUser('kwl3@test.com');
    await req('PUT', '/api/business', { name: 'Biz L3', pause_keywords: 'cancelar' }, { cookie: cl3 });
    const ul3 = dbGet("SELECT * FROM users WHERE email = 'kwl3@test.com'");
    const pnidL3 = 'pnid-l3';
    // start=23:59, end=00:00 → outside = (nowMin < 1439 || nowMin >= 0) = always true
    dbRun('UPDATE businesses SET phone_number_id = ?, business_hours_start = ?, business_hours_end = ? WHERE id = ?',
      pnidL3, '23:59', '00:00', ul3.business_id);

    await req('POST', '/webhook', webhookPayload(pnidL3, '549100000003', 'cancelar pedido', 'wamid-l3'));
    await sleep(300);
    const cl3conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', ul3.business_id);
    const cl3msgs = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", cl3conv.id);
    assert(cl3msgs.length === 1, 'l3: exactly 1 assistant reply outside hours');
    assert(cl3msgs[0].content === 'Te paso con una persona del equipo. Ahora estamos fuera de horario: te escribimos apenas podamos 💗',
      'l3: default text is "fuera de horario 💗" when outside hours');

    // l4: has pause_reply_text + outside hours → custom text, not default
    const { cookie: cl4 } = await seedUser('kwl4@test.com');
    await req('PUT', '/api/business', {
      name: 'Biz L4',
      pause_keywords: 'cancelar',
      pause_reply_text: 'Texto personalizado.',
    }, { cookie: cl4 });
    const ul4 = dbGet("SELECT * FROM users WHERE email = 'kwl4@test.com'");
    const pnidL4 = 'pnid-l4';
    dbRun('UPDATE businesses SET phone_number_id = ?, business_hours_start = ?, business_hours_end = ? WHERE id = ?',
      pnidL4, '23:59', '00:00', ul4.business_id);

    await req('POST', '/webhook', webhookPayload(pnidL4, '549100000004', 'cancelar pedido', 'wamid-l4'));
    await sleep(300);
    const cl4conv = dbGet('SELECT * FROM conversations WHERE business_id = ?', ul4.business_id);
    const cl4msgs = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", cl4conv.id);
    assert(cl4msgs.length === 1, 'l4: exactly 1 reply with custom text outside hours');
    assert(cl4msgs[0].content === 'Texto personalizado.',
      'l4: pause_reply_text overrides default even outside hours');
  }

  // ── Suite (m): pause_reply_text > 300 → 400 ──
  console.log('\nSuite (m): pause_reply_text > 300 chars → 400 error');
  {
    const { cookie } = await seedUser('kwm@test.com');
    const long301 = 'A'.repeat(301);
    const long300 = 'A'.repeat(300);

    const r400 = await req('PUT', '/api/business', {
      name: 'Biz M',
      pause_reply_text: long301,
    }, { cookie });
    assert(r400.status === 400, '301-char pause_reply_text → 400');
    assert(r400.body.field === 'pause_reply_text', 'error field = pause_reply_text');

    const r200 = await req('PUT', '/api/business', {
      name: 'Biz M',
      pause_reply_text: long300,
    }, { cookie });
    assert(r200.status === 200, '300-char pause_reply_text → 200');
  }

  // ── Suite (n): safeNextUrl validation (inline, no server needed) ──
  console.log('\nSuite (n): safeNextUrl validation');
  {
    function safeNextUrl(val) {
      if (!val) return null;
      let d;
      try { d = decodeURIComponent(val); } catch { return null; }
      if (!/^\/[a-zA-Z]/.test(d) || /[\\:\n\r]|\/\//.test(d)) return null;
      const p = d.split('?')[0];
      return ['/conversations.html', '/inicio.html', '/dashboard.html'].includes(p) ? d : null;
    }

    assert(safeNextUrl('//sitio-malo.com') === null,          'n: //sitio-malo.com → null');
    assert(safeNextUrl('/\\sitio-malo.com') === null,         'n: /\\sitio-malo.com → null');
    assert(safeNextUrl('https://sitio-malo.com') === null,    'n: https://sitio-malo.com → null');
    assert(safeNextUrl('javascript:alert(1)') === null,       'n: javascript:alert(1) → null');
    assert(safeNextUrl('%2F%2Fsitio-malo.com') === null,      'n: %2F%2Fsitio-malo.com → null');
    assert(safeNextUrl('/other.html') === null,               'n: /other.html → null (not in allowlist)');
    assert(safeNextUrl('/conversations.html?conv=16') === '/conversations.html?conv=16',
      'n: /conversations.html?conv=16 → passes through');
    assert(safeNextUrl('/inicio.html') === '/inicio.html',    'n: /inicio.html → passes through');
    assert(safeNextUrl('/dashboard.html') === '/dashboard.html', 'n: /dashboard.html → passes through');
    assert(safeNextUrl(null) === null,                        'n: null → null');
    assert(safeNextUrl('') === null,                          'n: empty string → null');
  }

  // ── Suite (o): business isolation — biz A cannot see biz B's conversations ──
  console.log('\nSuite (o): business isolation');
  {
    const { cookie: cA } = await seedUser('kwo-a@test.com');
    const { cookie: cB } = await seedUser('kwo-b@test.com');
    await req('PUT', '/api/business', { name: 'Biz OA', pause_keywords: 'test' }, { cookie: cA });
    await req('PUT', '/api/business', { name: 'Biz OB', pause_keywords: 'test' }, { cookie: cB });
    const uA = dbGet("SELECT * FROM users WHERE email = 'kwo-a@test.com'");
    const pnidOA = 'pnid-oa';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnidOA, uA.business_id);

    // Create a conversation in biz A
    await req('POST', '/webhook', webhookPayload(pnidOA, '549100001111', 'hola', 'wamid-oa1'));
    await sleep(300);
    const convA = dbGet('SELECT * FROM conversations WHERE business_id = ?', uA.business_id);

    // Biz B tries to access biz A's conversation
    const r = await req('GET', `/api/conversations/${convA.id}/messages`, null, { cookie: cB });
    assert(r.status === 404, 'o: biz B gets 404 for biz A conversation (no info leak)');
    assert(r.body.error !== 'Forbidden', 'o: response does not say "Forbidden" (avoids existence leak)');

    // Biz A can access own conversation
    const rOk = await req('GET', `/api/conversations/${convA.id}/messages`, null, { cookie: cA });
    assert(rOk.status === 200, 'o: biz A can access own conversation');
  }

  // ── Suite (p): human-paused and needs_human do NOT send keyword reply to client ──
  console.log('\nSuite (p): human-paused and needs_human → no keyword reply sent');
  {
    // p1: needs_attention=1, paused_reason=NULL (human-paused via owner WA reply)
    const { cookie: cp } = await seedUser('kwp@test.com');
    await req('PUT', '/api/business', { name: 'Biz P', pause_keywords: 'devolucion' }, { cookie: cp });
    const up = dbGet("SELECT * FROM users WHERE email = 'kwp@test.com'");
    const pnidP = 'pnid-p';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnidP, up.business_id);

    // Seed a conversation and mark it human-paused
    await req('POST', '/webhook', webhookPayload(pnidP, '549100002222', 'hola', 'wamid-p1'));
    await sleep(300);
    const pconv = dbGet('SELECT * FROM conversations WHERE business_id = ?', up.business_id);
    dbRun('UPDATE conversations SET needs_attention = 1, paused_reason = NULL, pause_reply_count = 0 WHERE id = ?', pconv.id);

    const msgsBefore = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", pconv.id);

    await req('POST', '/webhook', webhookPayload(pnidP, '549100002222', 'devolucion urgente', 'wamid-p2'));
    await sleep(300);

    const pconv2 = dbGet('SELECT * FROM conversations WHERE id = ?', pconv.id);
    const msgsAfter = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", pconv.id);
    assert(pconv2.pause_reply_count === 0, 'p1: pause_reply_count unchanged for human-paused (paused_reason=NULL)');
    assert(msgsAfter.length === msgsBefore.length, 'p1: no new assistant message sent for human-paused conv');

    // p2: needs_attention=1, paused_reason='trial' → no keyword reply either
    const { cookie: cp2 } = await seedUser('kwp2@test.com');
    await req('PUT', '/api/business', { name: 'Biz P2', pause_keywords: 'devolucion' }, { cookie: cp2 });
    const up2 = dbGet("SELECT * FROM users WHERE email = 'kwp2@test.com'");
    const pnidP2 = 'pnid-p2';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnidP2, up2.business_id);

    await req('POST', '/webhook', webhookPayload(pnidP2, '549100003333', 'hola', 'wamid-p2-1'));
    await sleep(300);
    const pconv3 = dbGet('SELECT * FROM conversations WHERE business_id = ?', up2.business_id);
    dbRun("UPDATE conversations SET needs_attention = 1, paused_reason = 'trial', pause_reply_count = 0 WHERE id = ?", pconv3.id);

    const msgsBefore2 = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", pconv3.id);
    await req('POST', '/webhook', webhookPayload(pnidP2, '549100003333', 'devolucion', 'wamid-p2-2'));
    await sleep(300);

    const pconv4 = dbGet('SELECT * FROM conversations WHERE id = ?', pconv3.id);
    const msgsAfter2 = dbAll("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant'", pconv3.id);
    assert(pconv4.pause_reply_count === 0, 'p2: pause_reply_count unchanged for trial-paused (paused_reason=trial)');
    assert(msgsAfter2.length === msgsBefore2.length, 'p2: no new assistant message sent for trial-paused conv');
  }

  // ── Suite (q): 30-min and 24h followup jobs are idempotent ──
  console.log('\nSuite (q): followup jobs are idempotent (run twice → no duplicate)');
  {
    const { cookie } = await seedUser('kwq@test.com');
    await req('PUT', '/api/business', { name: 'Biz Q', pause_keywords: 'test' }, { cookie });
    const uq = dbGet("SELECT * FROM users WHERE email = 'kwq@test.com'");
    const pnidQ = 'pnid-q';
    dbRun('UPDATE businesses SET phone_number_id = ? WHERE id = ?', pnidQ, uq.business_id);

    await req('POST', '/webhook', webhookPayload(pnidQ, '549100004444', 'test kw', 'wamid-q1'));
    await sleep(400);
    const qconv = dbGet('SELECT * FROM conversations WHERE business_id = ?', uq.business_id);

    // Set notified 31 min ago, 24h+1 ago, no followup/24h sent
    const thirtyOneMinAgo = Math.floor(Date.now() / 1000) - 31 * 60;
    const twentyFiveHoursAgo = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    dbRun('UPDATE conversations SET pause_notified_at = ?, pause_followup_sent = NULL, pause_24h_sent = NULL WHERE id = ?',
      thirtyOneMinAgo, qconv.id);

    // First run
    await req('POST', '/admin/api/run-pause-jobs', null, { bearer: ADMIN_TOKEN });
    const afterFirst = dbGet('SELECT * FROM conversations WHERE id = ?', qconv.id);
    assert(!!afterFirst.pause_followup_sent, 'q: pause_followup_sent set after first run');
    const followupTs1 = afterFirst.pause_followup_sent;

    // Second run — should NOT re-send (conv no longer in query)
    await req('POST', '/admin/api/run-pause-jobs', null, { bearer: ADMIN_TOKEN });
    const afterSecond = dbGet('SELECT * FROM conversations WHERE id = ?', qconv.id);
    assert(afterSecond.pause_followup_sent === followupTs1, 'q: pause_followup_sent unchanged on second run (idempotent)');

    // Now test 24h idempotency
    dbRun('UPDATE conversations SET pause_notified_at = ?, pause_followup_sent = ?, pause_24h_sent = NULL WHERE id = ?',
      twentyFiveHoursAgo, afterSecond.pause_followup_sent, qconv.id);

    await req('POST', '/admin/api/run-pause-jobs', null, { bearer: ADMIN_TOKEN });
    const after24h1 = dbGet('SELECT * FROM conversations WHERE id = ?', qconv.id);
    assert(!!after24h1.pause_24h_sent, 'q: pause_24h_sent set after first 24h run');
    const ts24h1 = after24h1.pause_24h_sent;

    await req('POST', '/admin/api/run-pause-jobs', null, { bearer: ADMIN_TOKEN });
    const after24h2 = dbGet('SELECT * FROM conversations WHERE id = ?', qconv.id);
    assert(after24h2.pause_24h_sent === ts24h1, 'q: pause_24h_sent unchanged on second run (idempotent)');
  }

  // ── Done ──
  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
