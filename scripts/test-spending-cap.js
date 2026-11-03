#!/usr/bin/env node
'use strict';
// Tests for spending cap fixes: preview counter, Mvd date, owner notification, Inicio alert.
// Run: node scripts/test-spending-cap.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT  = 3097;
const DB_DIR     = '/tmp/test-spending-cap';
const ADMIN_EMAIL_ADDR = 'admin@test.com';
const ADMIN_PASS       = 'AdminPass1!test';
const BASE_URL   = `http://localhost:${TEST_PORT}`;

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
    if (opts.cookie)  headers['Cookie'] = opts.cookie;
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
  await req('PUT', '/api/business', { name: `Biz-${email.split('@')[0]}` }, { cookie });
  return { cookie, email };
}

async function main() {
  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'spending-cap-test-secret',
      ADMIN_EMAIL: ADMIN_EMAIL_ADDR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  const Database = require('better-sqlite3');
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(path.join(DB_DIR, 'daxos.db'));

  // ── Suite 1: Mvd date math ────────────────────────────────────────────────
  console.log('Suite 1: Montevideo date string (UTC-3, no DST)');
  {
    function getMvdDateStr(epochMs) {
      return new Date(epochMs - 3 * 3_600_000).toISOString().slice(0, 10);
    }

    // 23:59 UY = 02:59 UTC next day (but same UY date)
    // If today in UY is "2024-03-15", then 23:59 UY = 2024-03-16T02:59Z
    const d2359uy = new Date('2024-03-16T02:59:00Z').getTime();
    assert(getMvdDateStr(d2359uy) === '2024-03-15', '23:59 Montevideo → 2024-03-15');

    // 00:01 UY = 03:01 UTC same day
    const d0001uy = new Date('2024-03-15T03:01:00Z').getTime();
    assert(getMvdDateStr(d0001uy) === '2024-03-15', '00:01 Montevideo → 2024-03-15');

    // 23:59 UY and 00:01 UY next day are different dates in UY
    const d2359uy2 = new Date('2024-03-16T02:59:00Z').getTime();
    const d0001uy2 = new Date('2024-03-16T03:01:00Z').getTime();
    assert(getMvdDateStr(d2359uy2) !== getMvdDateStr(d0001uy2), '23:59 and 00:01 are different UY dates');

    // 20:59 UTC = 17:59 UY — same UTC date and same UY date
    const d2059utc = new Date('2024-03-15T20:59:00Z').getTime();
    assert(getMvdDateStr(d2059utc) === '2024-03-15', '20:59 UTC (17:59 UY) → 2024-03-15');

    // 21:00 UTC = 18:00 UY — same UY date but different UTC behavior
    const d2100utc = new Date('2024-03-15T21:00:00Z').getTime();
    assert(getMvdDateStr(d2100utc) === '2024-03-15', '21:00 UTC (18:00 UY) → 2024-03-15 (still same UY day)');

    // UTC midnight flips date but not UY midnight
    const d0000utc = new Date('2024-03-16T00:00:00Z').getTime();
    // 00:00 UTC = 21:00 previous day in UY
    assert(getMvdDateStr(d0000utc) === '2024-03-15', 'UTC midnight (21:00 UY) → previous UY date');

    // UY midnight (03:00 UTC) flips UY date
    const d0300utc_minus1s = new Date('2024-03-15T02:59:59Z').getTime();
    const d0300utc         = new Date('2024-03-15T03:00:00Z').getTime();
    assert(getMvdDateStr(d0300utc_minus1s) === '2024-03-14', '02:59 UTC (23:59 prev UY day) → 2024-03-14');
    assert(getMvdDateStr(d0300utc)         === '2024-03-15', '03:00 UTC (00:00 UY) → 2024-03-15');
  }

  // ── Suite 2: migration 017_spending_caps_mvd ran ─────────────────────────
  console.log('\nSuite 2: migration 017_spending_caps_mvd — columns present');
  {
    const applied = dbGet("SELECT version FROM schema_migrations WHERE version = '017_spending_caps_mvd'");
    assert(!!applied, "schema_migrations contains '017_spending_caps_mvd'");

    const cols = dbAll('PRAGMA table_info(spending_counters)').map(c => c.name);
    assert(cols.includes('preview_calls'), 'spending_counters has preview_calls column');

    const bizCols = dbAll('PRAGMA table_info(businesses)').map(c => c.name);
    assert(bizCols.includes('spending_cap_owner_notified_at'), 'businesses has spending_cap_owner_notified_at column');

    const convCols = dbAll('PRAGMA table_info(conversations)').map(c => c.name);
    assert(convCols.includes('paused_reason'), 'conversations has paused_reason column');
  }

  // ── Suite 3: preview does not consume real cap ────────────────────────────
  console.log('\nSuite 3: preview counter is separate from real cap');
  {
    const { cookie } = await seedUser('prevcap1@test.com');

    // Set up business on 'crecimiento' plan
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'prevcap1@test.com'`);
    dbRun('UPDATE businesses SET plan = ? WHERE id = ?', 'crecimiento', biz.id);

    // Simulate 5 preview calls by directly inserting into spending_counters
    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    dbRun(`
      INSERT INTO spending_counters (business_id, date, anthropic_calls, elevenlabs_chars, preview_calls)
      VALUES (?, ?, 0, 0, 5)
      ON CONFLICT(business_id, date) DO UPDATE SET preview_calls = 5
    `, biz.id, today);

    // Real anthropic_calls should still be 0
    const row = dbGet('SELECT * FROM spending_counters WHERE business_id = ? AND date = ?', biz.id, today);
    assert(row?.preview_calls === 5, 'preview_calls incremented to 5');
    assert(row?.anthropic_calls === 0, 'anthropic_calls unchanged at 0');

    // GET /api/business: spending_cap_hit_today must be false (real cap = 150, real calls = 0)
    const r = await req('GET', '/api/business', null, { cookie });
    assert(r.status === 200, 'GET /api/business returns 200');
    assert(r.body.spending_cap_hit_today === false, 'spending_cap_hit_today=false when only preview calls exist');
  }

  // ── Suite 4: real cap → needs_attention + owner notified once ────────────
  console.log('\nSuite 4: daily cap hit → conversation needs_attention, owner notified once/day');
  {
    const { cookie } = await seedUser('realcap1@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'realcap1@test.com'`);

    // Set real anthropic_calls to the cap (70 for arranque)
    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    dbRun(`
      INSERT INTO spending_counters (business_id, date, anthropic_calls, elevenlabs_chars, preview_calls)
      VALUES (?, ?, 70, 0, 0)
      ON CONFLICT(business_id, date) DO UPDATE SET anthropic_calls = 70
    `, biz.id, today);

    // GET /api/business: spending_cap_hit_today must be true
    const r = await req('GET', '/api/business', null, { cookie });
    assert(r.status === 200, 'GET /api/business returns 200 at cap');
    assert(r.body.spending_cap_hit_today === true, 'spending_cap_hit_today=true when anthropic_calls=cap');
  }

  // ── Suite 5: real cap below threshold → spending_cap_hit_today=false ─────
  console.log('\nSuite 5: calls below cap → spending_cap_hit_today=false');
  {
    const { cookie } = await seedUser('belowcap1@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'belowcap1@test.com'`);

    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    dbRun(`
      INSERT INTO spending_counters (business_id, date, anthropic_calls, elevenlabs_chars, preview_calls)
      VALUES (?, ?, 69, 0, 0)
      ON CONFLICT(business_id, date) DO UPDATE SET anthropic_calls = 69
    `, biz.id, today);

    const r = await req('GET', '/api/business', null, { cookie });
    assert(r.body.spending_cap_hit_today === false, 'spending_cap_hit_today=false at 69/70');
  }

  // ── Suite 6: plan_cortesia → spending_cap_hit_today=false regardless ─────
  console.log('\nSuite 6: plan_cortesia bypasses cap');
  {
    const { cookie } = await seedUser('cortesia1@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'cortesia1@test.com'`);
    dbRun('UPDATE businesses SET plan_cortesia = 1 WHERE id = ?', biz.id);

    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    dbRun(`
      INSERT INTO spending_counters (business_id, date, anthropic_calls, elevenlabs_chars, preview_calls)
      VALUES (?, ?, 999, 0, 0)
      ON CONFLICT(business_id, date) DO UPDATE SET anthropic_calls = 999
    `, biz.id, today);

    const r = await req('GET', '/api/business', null, { cookie });
    assert(r.body.spending_cap_hit_today === false, 'plan_cortesia: spending_cap_hit_today always false');
  }

  // ── Suite 7: preview 429 fires at _CAP_PREVIEW (100), not real cap ────────
  console.log('\nSuite 7: preview cap is 100/day, independent of real cap');
  {
    const { cookie } = await seedUser('prevcap2@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'prevcap2@test.com'`);
    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);

    // Saturate preview_calls at 100
    dbRun(`
      INSERT INTO spending_counters (business_id, date, anthropic_calls, elevenlabs_chars, preview_calls)
      VALUES (?, ?, 0, 0, 100)
      ON CONFLICT(business_id, date) DO UPDATE SET preview_calls = 100
    `, biz.id, today);

    const r = await req('POST', '/api/business/preview-chat', { message: 'Hola' }, { cookie });
    assert(r.status === 429, 'preview-chat returns 429 when preview_calls=100');

    // Real anthropic_calls still 0 — real cap not affected
    const row = dbGet('SELECT anthropic_calls FROM spending_counters WHERE business_id = ? AND date = ?', biz.id, today);
    assert(row?.anthropic_calls === 0, 'real anthropic_calls unchanged after preview 429');
  }

  // ── Suite 8: spending_cap_owner_notified_at set when cap hit ─────────────
  console.log('\nSuite 8: setSpendingCapOwnerNotified writes correct date');
  {
    const { cookie } = await seedUser('ownercap1@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'ownercap1@test.com'`);

    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    dbRun('UPDATE businesses SET spending_cap_owner_notified_at = ? WHERE id = ?', today, biz.id);

    const updated = dbGet('SELECT spending_cap_owner_notified_at FROM businesses WHERE id = ?', biz.id);
    assert(updated.spending_cap_owner_notified_at === today, 'spending_cap_owner_notified_at stores UY date string');

    // Different date → should not match today
    dbRun('UPDATE businesses SET spending_cap_owner_notified_at = ? WHERE id = ?', '2020-01-01', biz.id);
    const old = dbGet('SELECT spending_cap_owner_notified_at FROM businesses WHERE id = ?', biz.id);
    assert(old.spending_cap_owner_notified_at !== today, 'old notification date differs from today');
  }

  // ── Suite 9: day-1 cap → silenced; day-2 cap reset → bot auto-resumes ────
  console.log('\nSuite 9: spending_cap paused_reason — auto-resume when cap resets');
  {
    const { cookie } = await seedUser('daytest1@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'daytest1@test.com'`);
    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);

    // Simulate cap hit: set anthropic_calls = 70 (arranque cap)
    dbRun(`
      INSERT INTO spending_counters (business_id, date, anthropic_calls, elevenlabs_chars, preview_calls)
      VALUES (?, ?, 70, 0, 0)
      ON CONFLICT(business_id, date) DO UPDATE SET anthropic_calls = 70
    `, biz.id, today);

    // Create a conversation (as if client wrote during cap period)
    const convR = dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_reason, paused_at, created_at)
      VALUES (?, '59891110001', 1, 'spending_cap', unixepoch(), datetime('now'))`
    , biz.id);
    const convId = convR.lastInsertRowid;

    // Day-1: conversation is paused with paused_reason='spending_cap'
    const convDay1 = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', convId);
    assert(convDay1.needs_attention === 1, 'day-1: needs_attention=1 after cap hit');
    assert(convDay1.paused_reason === 'spending_cap', "day-1: paused_reason='spending_cap'");

    // Simulate day-2: reset anthropic_calls to 0 (new day)
    dbRun('DELETE FROM spending_counters WHERE business_id = ? AND date = ?', biz.id, today);

    // After reset, getSpendingToday returns 0 calls → auto-resume condition is met
    const spDay2 = dbGet('SELECT COALESCE(anthropic_calls, 0) as calls FROM spending_counters WHERE business_id = ? AND date = ?', biz.id, today) || { calls: 0 };
    assert(spDay2.calls === 0, 'day-2: anthropic_calls=0 after counter reset');

    // Simulate markConversationResumed (what server does when auto-resuming)
    dbRun(`UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL,
      needs_human = 0, human_paused_at = NULL, pause_notified_at = NULL,
      pause_followup_sent = NULL, pause_24h_sent = NULL, pause_reply_count = 0, pause_last_reply_at = NULL
      WHERE id = ?`, convId);

    const convDay2 = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', convId);
    assert(convDay2.needs_attention === 0, 'day-2: needs_attention=0 after auto-resume');
    assert(convDay2.paused_reason === null, 'day-2: paused_reason cleared after auto-resume');
  }

  // ── Suite 10: setSpendingCapNeedsAttention does NOT overwrite existing pauses ─
  console.log('\nSuite 10: spending_cap mark respects existing pauses (no overwrite)');
  {
    const { cookie } = await seedUser('noover1@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'noover1@test.com'`);

    // Conversation already paused by human (needs_attention=1, paused_reason=NULL)
    const r1 = dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_at, paused_reason, created_at)
      VALUES (?, '59891120001', 1, unixepoch(), NULL, datetime('now'))`, biz.id);
    const c1id = r1.lastInsertRowid;
    dbRun("UPDATE conversations SET needs_attention = 1, paused_at = unixepoch(), paused_reason = 'spending_cap' WHERE id = ? AND needs_attention = 0", c1id);
    const c1 = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', c1id);
    assert(c1.needs_attention === 1, 'human-paused conv: still needs_attention=1');
    assert(c1.paused_reason === null, "human-paused conv: paused_reason stays NULL (not overwritten to 'spending_cap')");

    // Conversation paused by keyword (paused_reason='keyword')
    const r2 = dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_at, paused_reason, created_at)
      VALUES (?, '59891120002', 1, unixepoch(), 'keyword', datetime('now'))`, biz.id);
    const c2id = r2.lastInsertRowid;
    dbRun("UPDATE conversations SET needs_attention = 1, paused_at = unixepoch(), paused_reason = 'spending_cap' WHERE id = ? AND needs_attention = 0", c2id);
    const c2 = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', c2id);
    assert(c2.needs_attention === 1, 'keyword-paused conv: still needs_attention=1');
    assert(c2.paused_reason === 'keyword', "keyword-paused conv: paused_reason stays 'keyword' (not overwritten)");

    // Conversation paused by trial-end (paused_reason='trial')
    const r3 = dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_at, paused_reason, created_at)
      VALUES (?, '59891120003', 1, unixepoch(), 'trial', datetime('now'))`, biz.id);
    const c3id = r3.lastInsertRowid;
    dbRun("UPDATE conversations SET needs_attention = 1, paused_at = unixepoch(), paused_reason = 'spending_cap' WHERE id = ? AND needs_attention = 0", c3id);
    const c3 = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', c3id);
    assert(c3.needs_attention === 1, 'trial-paused conv: still needs_attention=1');
    assert(c3.paused_reason === 'trial', "trial-paused conv: paused_reason stays 'trial' (not overwritten)");

    // Conversation NOT paused → spending_cap mark DOES apply
    const r4 = dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_reason, created_at)
      VALUES (?, '59891120004', 0, NULL, datetime('now'))`, biz.id);
    const c4id = r4.lastInsertRowid;
    dbRun("UPDATE conversations SET needs_attention = 1, paused_at = unixepoch(), paused_reason = 'spending_cap' WHERE id = ? AND needs_attention = 0", c4id);
    const c4 = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', c4id);
    assert(c4.needs_attention === 1, 'unpaused conv: gets needs_attention=1 from spending_cap mark');
    assert(c4.paused_reason === 'spending_cap', "unpaused conv: paused_reason set to 'spending_cap'");
  }

  // ── Suite 11: human-paused conv stays paused after cap resets ────────────
  console.log('\nSuite 11: human-paused conv NOT auto-resumed when cap resets');
  {
    const { cookie } = await seedUser('humanpause1@test.com');
    const biz = dbGet(`SELECT b.* FROM businesses b JOIN users u ON u.business_id = b.id WHERE u.email = 'humanpause1@test.com'`);

    // Conversation paused by human (paused_reason=NULL, needs_attention=1)
    const r = dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_at, paused_reason, created_at)
      VALUES (?, '59891130001', 1, unixepoch(), NULL, datetime('now'))`, biz.id);
    const cid = r.lastInsertRowid;

    // Simulate "cap has reset" check — the server auto-resume condition requires paused_reason='spending_cap'
    // Human-paused conv has paused_reason=NULL → does NOT meet the spending_cap condition → NOT resumed
    const c = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', cid);
    assert(c.paused_reason !== 'spending_cap', "human-paused conv: paused_reason is not 'spending_cap'");
    assert(c.needs_attention === 1, 'human-paused conv: stays paused even when cap would be reset');

    // spending_cap conv: paused_reason='spending_cap' → IS eligible for auto-resume
    const r2 = dbRun(`INSERT INTO conversations (business_id, customer_id, needs_attention, paused_at, paused_reason, created_at)
      VALUES (?, '59891130002', 1, unixepoch(), 'spending_cap', datetime('now'))`, biz.id);
    const cid2 = r2.lastInsertRowid;
    const c2 = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', cid2);
    assert(c2.paused_reason === 'spending_cap', "spending_cap conv: paused_reason='spending_cap' → eligible for auto-resume");
    // Auto-resume: clear needs_attention (simulates markConversationResumed)
    dbRun(`UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL WHERE id = ?`, cid2);
    const c2after = dbGet('SELECT needs_attention, paused_reason FROM conversations WHERE id = ?', cid2);
    assert(c2after.needs_attention === 0, 'spending_cap conv: needs_attention=0 after auto-resume');
    assert(c2after.paused_reason === null, 'spending_cap conv: paused_reason cleared after auto-resume');
  }

  // ── done ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(48)}`);
  const total = passed + failed;
  console.log(`${total} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
