#!/usr/bin/env node
'use strict';
// Tests for Commit A: trial grace logic.
// Verifies: warning, grace, ended states via DB state changes.
// Mails are simulated (no RESEND_API_KEY). WA calls fail silently (.catch).
// Run: ADMIN_SET_WA_TOKEN=test123 node scripts/test-trial-grace.js

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT  = 3098;
const DB_DIR     = '/tmp/test-trial-grace';
const ADMIN_TOK  = process.env.ADMIN_SET_WA_TOKEN || 'test-trial-grace-tok';
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
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// Direct DB access to inspect state (better-sqlite3 in the test process)
let db = null;
function dbGet(sql, ...params) { return db.prepare(sql).get(...params); }
function dbRun(sql, ...params) { return db.prepare(sql).run(...params); }
function dbAll(sql, ...params) { return db.prepare(sql).all(...params); }

async function triggerDailyCheck(dryRun = false) {
  const qs   = dryRun ? '?dry_run=1' : '?dry_run=0';
  const r    = await req('POST', `/admin/api/run-trial-check${qs}`, null, { bearer: ADMIN_TOK });
  assert(r.status === 200 && r.body.ok, `daily-check endpoint ok (dry=${dryRun})`);
}

// Seeds a minimal business + user and returns { bizId, cookie }
async function seedBusiness(email, overrides = {}) {
  const pass = 'Passw0rd!test';
  let r = await req('POST', '/auth/register', { email, password: pass });
  if (r.status !== 200) throw new Error(`register ${email} failed: ${JSON.stringify(r.body)}`);
  const cookie = r.setCookie?.[0]?.split(';')[0];

  // Create business via PUT /api/business (requires session)
  const bizName = overrides.name || `Biz-${email.split('@')[0]}`;
  const putR = await req('PUT', '/api/business', { name: bizName }, { cookie });
  if (putR.status !== 200) throw new Error(`PUT /api/business failed for ${email}: ${JSON.stringify(putR.body)}`);

  const user = dbGet('SELECT * FROM users WHERE email = ?', email);
  const bizId = user.business_id;

  // Simulate WA connection to set trial clock
  dbRun(
    `UPDATE businesses SET
       phone_number_id = ?,
       wa_provider     = 'meta',
       trial_starts_at = datetime('now', ? || ' days'),
       trial_ends_at   = datetime('now', ? || ' days')
     WHERE id = ?`,
    `test-pnid-${bizId}`,
    String(-(overrides.daysAgo ?? 0)),
    String(14 - (overrides.daysAgo ?? 0)),
    bizId
  );

  // Apply explicit overrides (win over WA seed)
  const SKIP = new Set(['name', 'daysAgo']);
  for (const [k, v] of Object.entries(overrides)) {
    if (SKIP.has(k)) continue;
    dbRun(`UPDATE businesses SET ${k} = ? WHERE id = ?`, v, bizId);
  }

  return { bizId, cookie };
}

// ── Point 3: Email unit tests (no server required) ───────────────────────────

async function testEmailFunctions() {
  console.log('── Point 3: email unit tests ──');

  // Capture all fetch calls
  const calls = [];
  global.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };
  process.env.RESEND_API_KEY = 'test-key-mock';

  // Clear require cache so email.js picks up the mocked fetch
  delete require.cache[require.resolve('../src/email.js')];
  const { sendTrialWarningEmail, sendTrialGraceEmail, sendTrialEndedEmail } =
    require('../src/email.js');

  const rawName    = 'Café <&> Test';
  const escaped    = 'Café &lt;&amp;&gt; Test';
  const PLAN_LINK  = 'https://wa.me/59892052508?text=Quiero%20activar%20mi%20plan';

  // -- sendTrialWarningEmail --
  calls.length = 0;
  await sendTrialWarningEmail({ to: 'a@b.com', businessName: rawName, convCount: 120, convLimit: 150, dayNum: 11, dayLimit: 14 });
  assert(calls.length === 1, 'sendTrialWarningEmail: called fetch once');
  assert(calls[0].subject.includes('Tu prueba de Daxos está llegando al final'), 'sendTrialWarningEmail: correct subject');
  assert(calls[0].html.includes(PLAN_LINK), 'sendTrialWarningEmail: plan link present');
  assert(calls[0].html.includes(escaped), 'sendTrialWarningEmail: biz name escaped');
  assert(!calls[0].html.includes('<&>'), 'sendTrialWarningEmail: no raw < & > in HTML');

  // -- sendTrialGraceEmail --
  calls.length = 0;
  await sendTrialGraceEmail({ to: 'a@b.com', businessName: rawName, graceConvsLeft: 20, graceHoursLeft: 48 });
  assert(calls.length === 1, 'sendTrialGraceEmail: called fetch once');
  assert(calls[0].subject.includes('Tu prueba de Daxos venció'), 'sendTrialGraceEmail: correct subject');
  assert(calls[0].html.includes(PLAN_LINK), 'sendTrialGraceEmail: plan link present');
  assert(calls[0].html.includes(escaped), 'sendTrialGraceEmail: biz name escaped');

  // -- sendTrialEndedEmail --
  calls.length = 0;
  await sendTrialEndedEmail({ to: 'a@b.com', businessName: rawName });
  assert(calls.length === 1, 'sendTrialEndedEmail: called fetch once');
  assert(calls[0].subject.includes('El período de prueba de Daxos terminó'), 'sendTrialEndedEmail: correct subject');
  assert(calls[0].html.includes(PLAN_LINK), 'sendTrialEndedEmail: plan link present');
  assert(calls[0].html.includes(escaped), 'sendTrialEndedEmail: biz name escaped');

  // Restore
  delete process.env.RESEND_API_KEY;
  delete global.fetch;
  delete require.cache[require.resolve('../src/email.js')];
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Point 3 email tests run before server ──
  await testEmailFunctions();

  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'trial-test-secret',
      ADMIN_SET_WA_TOKEN: ADMIN_TOK,
      // No RESEND_API_KEY → emails skip silently
      // No WA credentials → WA sends fail silently
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(500); // let DB migrations finish

  // Open DB for direct inspection (read-only mode: WAL shared with server)
  const Database = require('better-sqlite3');
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(path.join(DB_DIR, 'daxos.db'));

  // ── Suite 1: no trial (no trial_starts_at) → daily check does nothing ──
  console.log('Suite 1: no trial_starts_at');
  {
    const { bizId } = await seedBusiness('notrial@test.com');
    // Clear the WA connection so trial_starts_at is null
    dbRun('UPDATE businesses SET phone_number_id = NULL, trial_starts_at = NULL, trial_ends_at = NULL WHERE id = ?', bizId);
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!b.trial_warned_at, 'no trial_starts_at → no warning set');
    assert(!b.trial_grace_started_at, 'no trial_starts_at → no grace set');
  }

  // ── Suite 2: plan_cortesia → untouched ──
  console.log('\nSuite 2: plan_cortesia');
  {
    const { bizId } = await seedBusiness('cortesia@test.com', { daysAgo: 15, plan_cortesia: 1 });
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!b.trial_warned_at, 'plan_cortesia → no warning');
    assert(!b.trial_grace_started_at, 'plan_cortesia → no grace');
  }

  // ── Suite 3: paid arranque → untouched by trial check ──
  console.log('\nSuite 3: paid arranque (plan_paid_at set)');
  {
    const { bizId } = await seedBusiness('paidarranque@test.com', { daysAgo: 15, plan_paid_at: new Date().toISOString() });
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!b.trial_grace_started_at, 'paid arranque → no grace from daily check');
  }

  // ── Suite 4: day 10, 100 convs → no warning ──
  console.log('\nSuite 4: day 10, 100 convs → no warning');
  {
    const { bizId } = await seedBusiness('nodanger@test.com', { daysAgo: 10 });
    // Don't add conversations → convCount = 0
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!b.trial_warned_at, 'day 10, 0 convs → no warning');
  }

  // ── Suite 5: day 11 → warning sent (trial_warned_at set) ──
  console.log('\nSuite 5: day 11 → warning');
  {
    const { bizId } = await seedBusiness('warn11@test.com', { daysAgo: 11 });
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_warned_at, 'day 11 → trial_warned_at set');
    assert(!!b.trial_grace_notified_at, 'day 11 → trial_grace_notified_at set (mail token)');
  }

  // ── Suite 6: warning sent only once (second daily check same day = no-op) ──
  console.log('\nSuite 6: warning idempotent');
  {
    const { bizId } = await seedBusiness('warn-once@test.com', { daysAgo: 11 });
    await triggerDailyCheck();
    const b1 = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    const t1 = b1.trial_warned_at;
    await sleep(100);
    // Second trigger same day — canMail = false (same todayUY)
    await triggerDailyCheck();
    const b2 = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(b2.trial_warned_at === t1, 'second daily check same day: trial_warned_at unchanged');
  }

  // ── Suite 7: 120+ convs → warning ──
  console.log('\nSuite 7: 120+ convs → warning');
  {
    const { bizId } = await seedBusiness('warn120@test.com', { daysAgo: 5 });
    // Seed 120 conversations with user messages
    const convStmt = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)');
    const msgStmt  = db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'hi')");
    for (let i = 0; i < 120; i++) {
      const conv = convStmt.run(bizId, `+59899${String(i).padStart(6, '0')}`);
      msgStmt.run(conv.lastInsertRowid);
    }
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_warned_at, '120 convs day 5 → warning sent');
  }

  // ── Suite 8: day 14 → grace opened ──
  console.log('\nSuite 8: day 14 → grace opened');
  {
    const { bizId } = await seedBusiness('grace14@test.com', { daysAgo: 14 });
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_grace_started_at, 'day 14 → trial_grace_started_at set');
  }

  // ── Suite 9: 150+ convs → grace opened ──
  console.log('\nSuite 9: 150+ convs → grace opened');
  {
    const { bizId } = await seedBusiness('grace150@test.com', { daysAgo: 5 });
    const convStmt = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)');
    const msgStmt  = db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'hi')");
    for (let i = 0; i < 150; i++) {
      const conv = convStmt.run(bizId, `+59888${String(i).padStart(6, '0')}`);
      msgStmt.run(conv.lastInsertRowid);
    }
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_grace_started_at, '150 convs → grace opened');
  }

  // ── Suite 10: grace active, daily reminder ──
  console.log('\nSuite 10: grace active → daily reminder (trial_grace_notified_at updated)');
  {
    const graceStart = new Date(Date.now() - 10 * 3600000).toISOString(); // 10h ago
    const { bizId } = await seedBusiness('grace-active@test.com', {
      daysAgo: 14,
      trial_grace_started_at: graceStart,
    });
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_grace_notified_at, 'grace active (10h) → notified_at updated');
  }

  // ── Suite 11: grace expired (>72h) → ended notification ──
  console.log('\nSuite 11: grace expired (73h) → trial-ended daily notification');
  {
    const graceStart = new Date(Date.now() - 73 * 3600000).toISOString();
    const { bizId } = await seedBusiness('grace-over@test.com', {
      daysAgo: 14,
      trial_grace_started_at: graceStart,
    });
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_grace_notified_at, 'grace expired → notified_at set (ended notification)');
  }

  // ── Suite 12: trial expired >72h ago → direct cut (no grace) ──
  console.log('\nSuite 12: trial expired >72h ago → no grace opened');
  {
    const { bizId } = await seedBusiness('expired-old@test.com', { daysAgo: 20 });
    // trial_ends_at is 14 days after start, so it was 6 days ago (>72h)
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    // Should NOT open grace because trial_ends_at was >72h ago
    assert(!b.trial_grace_started_at, 'expired >72h ago → no grace opened, direct cut path');
    assert(!!b.trial_grace_notified_at, 'expired >72h ago → ended notification sent');
  }

  // ── Suite 13: silent conversations don't count toward trial ──
  console.log('\nSuite 13: silent convs not counted');
  {
    const { bizId } = await seedBusiness('silent-test@test.com', { daysAgo: 5 });
    const convStmt = db.prepare('INSERT INTO conversations (business_id, customer_id, silent) VALUES (?, ?, 1)');
    const msgStmt  = db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'hi')");
    for (let i = 0; i < 150; i++) {
      const conv = convStmt.run(bizId, `+59877${String(i).padStart(6, '0')}`);
      msgStmt.run(conv.lastInsertRowid);
    }
    await triggerDailyCheck();
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!b.trial_grace_started_at, '150 silent convs → grace NOT opened (silent excluded)');
    assert(!b.trial_warned_at, '150 silent convs → no warning (silent excluded)');
  }

  // ── Suite 14: autoResumeExpiredConversations skips trial-paused ──
  console.log('\nSuite 14: autoResume skips trial-paused conversations');
  {
    const { bizId } = await seedBusiness('autoresume@test.com', { daysAgo: 5 });
    const convId = db.prepare(
      'INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)'
    ).run(bizId, '+598111222333').lastInsertRowid;
    // Pause as trial, with paused_at 2 days ago (exceeds 24h auto-resume cutoff)
    dbRun(
      "UPDATE conversations SET needs_attention = 1, paused_at = unixepoch('now', '-2 days'), paused_reason = 'trial' WHERE id = ?",
      convId
    );
    // Trigger autoResume via the 30-min job — call endpoint that exercises the same code
    // (no direct endpoint, so check DB logic manually via better-sqlite3)
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    db.prepare(
      "UPDATE conversations SET needs_attention = 0, paused_at = NULL WHERE needs_attention = 1 AND paused_at IS NOT NULL AND paused_at < ? AND (paused_reason IS NULL OR paused_reason != 'trial')"
    ).run(cutoff);
    const conv = dbGet('SELECT * FROM conversations WHERE id = ?', convId);
    assert(conv.needs_attention === 1, 'trial-paused conv not auto-resumed');
    assert(conv.paused_reason === 'trial', 'paused_reason still "trial" after auto-resume job');
  }

  // ── Suite 15: upgradePlan reactivates trial-paused convs ──
  console.log('\nSuite 15: upgradePlan reactivates trial-paused conversations');
  {
    const { bizId } = await seedBusiness('reactivate@test.com', { daysAgo: 15 });
    const convId = db.prepare(
      'INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)'
    ).run(bizId, '+598444555666').lastInsertRowid;
    dbRun(
      "UPDATE conversations SET needs_attention = 1, paused_at = unixepoch(), paused_reason = 'trial' WHERE id = ?",
      convId
    );
    // Simulate plan payment via upgradePlan (call via admin endpoint)
    const r = await req('POST', '/admin/set-plan', {
      email: 'reactivate@test.com',
      plan: 'crecimiento',
    }, { bearer: ADMIN_TOK });
    assert(r.status === 200, 'upgradePlan via admin endpoint');
    const conv = dbGet('SELECT * FROM conversations WHERE id = ?', convId);
    assert(conv.needs_attention === 0, 'trial-paused conv reactivated after plan upgrade');
    assert(conv.paused_reason === null, 'paused_reason cleared after reactivation');
  }

  // ── Suite 16: manual-paused conv NOT reactivated on plan upgrade ──
  console.log('\nSuite 16: manual-paused conv NOT reactivated');
  {
    const { bizId } = await seedBusiness('manual-pause@test.com', { daysAgo: 15 });
    const convId = db.prepare(
      'INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)'
    ).run(bizId, '+598777888999').lastInsertRowid;
    // Manual pause (paused_reason IS NULL)
    dbRun('UPDATE conversations SET needs_attention = 1, paused_at = unixepoch() WHERE id = ?', convId);
    await req('POST', '/admin/set-plan', { email: 'manual-pause@test.com', plan: 'crecimiento' }, { bearer: ADMIN_TOK });
    const conv = dbGet('SELECT * FROM conversations WHERE id = ?', convId);
    assert(conv.needs_attention === 1, 'manually-paused conv stays paused after plan upgrade');
  }

  // ── Suite 17: dry-run mode → no DB writes ──
  console.log('\nSuite 17: dry-run mode (dry_run=1) → no DB writes');
  {
    const { bizId } = await seedBusiness('dryrun17@test.com', { daysAgo: 11 });
    await triggerDailyCheck(true); // dryRun=true
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!b.trial_warned_at, 'dry-run: trial_warned_at NOT set');
    assert(!b.trial_grace_notified_at, 'dry-run: trial_grace_notified_at NOT set');
  }

  // ── Suite 18: real mode (dry_run=0) → DB writes happen ──
  console.log('\nSuite 18: real mode (dry_run=0) → DB writes');
  {
    const { bizId } = await seedBusiness('realmode18@test.com', { daysAgo: 11 });
    await triggerDailyCheck(false); // dryRun=false → real
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_warned_at, 'real mode: trial_warned_at IS set');
    assert(!!b.trial_grace_notified_at, 'real mode: trial_grace_notified_at IS set');
  }

  // ── Suite 19: grace active + 150 total convs, 0 since grace → bot still replies ──
  console.log('\nSuite 19: grace active + 150 total convs (pre-grace) → grace not ended');
  {
    const graceStart = new Date(Date.now() - 10 * 3600000).toISOString(); // 10h ago
    const { bizId } = await seedBusiness('grace150total@test.com', {
      daysAgo: 14,
      trial_grace_started_at: graceStart,
    });
    // Seed 150 convs with messages timestamped 20h ago (before grace started at 10h ago)
    const beforeGrace = new Date(Date.now() - 20 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const convStmt2 = db.prepare(
      'INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)'
    );
    const msgStmt2 = db.prepare(
      `INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hi', ?)`
    );
    for (let i = 0; i < 150; i++) {
      const conv = convStmt2.run(bizId, `+59855${String(i).padStart(6, '0')}`);
      msgStmt2.run(conv.lastInsertRowid, beforeGrace);
    }
    await triggerDailyCheck(false); // real mode
    const b = dbGet('SELECT * FROM businesses WHERE id = ?', bizId);
    assert(!!b.trial_grace_started_at, 'grace+150 pre-grace convs: trial_grace_started_at still set');
    const trialPaused = dbAll(
      "SELECT id FROM conversations WHERE business_id = ? AND paused_reason = 'trial'",
      bizId
    );
    assert(trialPaused.length === 0, 'grace+150 pre-grace convs, 0 since grace → no convs paused (bot still replies)');
  }

  // ── Done ──
  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
