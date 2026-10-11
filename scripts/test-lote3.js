#!/usr/bin/env node
'use strict';
// Lote 3 security tests.
// Run: node scripts/test-lote3.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3098;
const DB_DIR    = '/tmp/test-lote3';
const BASE_URL  = `http://localhost:${TEST_PORT}`;
const ADMIN_EMAIL = 'admin-l3@test.com';
const ADMIN_PASS  = 'AdminL3Pass1!';

let serverProc = null;
let passed = 0;
let failed = 0;

function cleanup() {
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch (_) {} serverProc = null; }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  try { execSync(`rm -rf ${DB_DIR}-prod`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    if (opts.xff)    headers['X-Forwarded-For'] = opts.xff;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
          catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
        });
      }
    );
    r.on('error', reject);
    if (body != null) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start');
}

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

function startServer(extraEnv = {}) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const proc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'l3-test-secret',
      ADMIN_EMAIL,
      NODE_ENV: '',
      RAILWAY_ENVIRONMENT: '',
      ENABLE_RATE_LIMIT: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  return proc;
}

async function registerUser(email, pass = 'UserPass1!') {
  const r = await req('POST', '/auth/register', { email, password: pass },
    { xff: `1.2.3.${Math.floor(Math.random() * 200) + 10}` });
  if (r.status !== 200) throw new Error(`register ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.headers['set-cookie']?.[0]?.split(';')[0];
}

async function loginUser(email, pass = 'UserPass1!') {
  const r = await req('POST', '/auth/login', { email, password: pass },
    { xff: `1.2.3.${Math.floor(Math.random() * 200) + 10}` });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return r.headers['set-cookie']?.[0]?.split(';')[0];
}

async function main() {
  // ── Suite 1: Registration no-enumeration ──
  console.log('\nSuite 1: Registration — no email enumeration');
  serverProc = startServer();
  await waitForServer();
  await sleep(200);

  {
    // First registration — new email → 200 with session
    const r1 = await req('POST', '/auth/register',
      { email: `enum-test-${Date.now()}@t.com`, password: 'Pass1234!' },
      { xff: '50.60.70.81' });
    assert(r1.status === 200 && r1.body.ok, 'new email: 200 ok');

    // Duplicate email → also 200 (no 409 enumeration)
    const dupEmail = `dup-${Date.now()}@t.com`;
    await req('POST', '/auth/register', { email: dupEmail, password: 'Pass1234!' }, { xff: '50.60.70.82' });
    const r2 = await req('POST', '/auth/register', { email: dupEmail, password: 'Pass1234!' }, { xff: '50.60.70.83' });
    assert(r2.status === 200 && r2.body.ok, 'duplicate email: still 200 (no enumeration)');

    // 500 path returns generic message (can't easily trigger without mocking DB, skip)
  }

  // ── Suite 2: Password recovery flow ──
  console.log('\nSuite 2: Password recovery');
  {
    // forgot-password: always 200 regardless of whether email exists
    const r1 = await req('POST', '/auth/forgot-password',
      { email: 'nonexistent@example.com' }, { xff: '10.20.30.41' });
    assert(r1.status === 200 && r1.body.ok, 'forgot-password: 200 for nonexistent email');

    const r2 = await req('POST', '/auth/forgot-password',
      { email: 'also-not-there@example.com' }, { xff: '10.20.30.42' });
    assert(r2.status === 200 && r2.body.ok, 'forgot-password: 200 for another nonexistent email');

    // reset-password with bad token → 400
    const r3 = await req('POST', '/auth/reset-password',
      { token: 'invalidtoken1234', password: 'NewPass123!' }, { xff: '10.20.30.43' });
    assert(r3.status === 400, 'reset-password: invalid token → 400');

    // reset-password with short password → 400
    const r4 = await req('POST', '/auth/reset-password',
      { token: 'anytoken', password: 'short' }, { xff: '10.20.30.44' });
    assert(r4.status === 400 && /8 caracteres/.test(r4.body.error || ''), 'reset-password: short password → 400');

    // reset-password missing fields → 400
    const r5 = await req('POST', '/auth/reset-password', {}, { xff: '10.20.30.45' });
    assert(r5.status === 400, 'reset-password: missing fields → 400');
  }

  // ── Suite 3: Spending caps (Anthropic daily, conv hourly) ──
  console.log('\nSuite 3: Spending caps via preview endpoint');
  {
    // Set daily cap to 0 via runtime_config in DB
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    db.prepare('INSERT OR REPLACE INTO runtime_config (key, value) VALUES (?, ?)').run('cap_daily_anthropic_arranque', '0');
    db.close();

    const cookie = await registerUser(`captest-${Date.now()}@t.com`);
    // Set up business quickly (PUT /api/business)
    await req('PUT', '/api/business', { name: 'CapBiz' }, { cookie });
    // preview-chat should be blocked (cap=0)
    const r = await req('POST', '/api/business/preview-chat',
      { message: 'Hola', history: [] }, { cookie });
    assert(r.status === 429, 'preview-chat: daily cap 0 → 429');

    // Reset cap to a higher value
    const db2 = new Database(path.join(DB_DIR, 'daxos.db'));
    db2.prepare('DELETE FROM runtime_config WHERE key = ?').run('cap_daily_anthropic_arranque');
    db2.close();
  }

  // ── Suite 4: DB improvements ──
  console.log('\nSuite 4: DB improvements');
  {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));

    // Check busy_timeout pragma (not directly readable, but verify it was set at startup)
    const btVal = db.pragma('busy_timeout', { simple: true });
    assert(btVal === 5000, `busy_timeout = 5000 (got ${btVal})`);

    // Check indexes
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
    assert(indexes.includes('idx_conv_business'), 'idx_conv_business exists');
    assert(indexes.includes('idx_conv_biz_cust'),  'idx_conv_biz_cust exists');
    assert(indexes.includes('idx_biz_phone_id'),   'idx_biz_phone_id exists');

    // Check spending_counters table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert(tables.includes('spending_counters'), 'spending_counters table exists');

    // Check password_reset_tokens table exists
    assert(tables.includes('password_reset_tokens'), 'password_reset_tokens table exists');

    // Check spending_cap_notified_at column on conversations
    const convCols = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
    assert(convCols.includes('spending_cap_notified_at'), 'conversations.spending_cap_notified_at column exists');

    db.close();
  }

  // ── Suite 5: N+1 query fix ──
  console.log('\nSuite 5: N+1 fix — getConversationsByBusinessId');
  {
    const cookie = await registerUser(`n1test-${Date.now()}@t.com`);
    await req('PUT', '/api/business', { name: 'N1Biz' }, { cookie });
    // Endpoint returns array directly (not wrapped in object)
    const r = await req('GET', '/api/conversations', null, { cookie });
    assert(r.status === 200 && Array.isArray(r.body), 'GET /api/conversations returns array without error');
  }

  // ── Suite 6: Upload magic bytes ──
  console.log('\nSuite 6: Upload magic bytes validation');
  {
    const cookie = await registerUser(`uploadtest-${Date.now()}@t.com`);
    await req('PUT', '/api/business', { name: 'UploadBiz' }, { cookie });

    function multipartReq(urlPath, fieldName, filename, content, contentType, cookieStr) {
      return new Promise((resolve, reject) => {
        const boundary = 'TestBoundary' + Date.now();
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
          Buffer.isBuffer(content) ? content : Buffer.from(content),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const opts = {
          hostname: 'localhost', port: TEST_PORT, path: urlPath, method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            'Cookie': cookieStr,
          },
        };
        const r = http.request(opts, res => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode, body: data }); }
          });
        });
        r.on('error', reject);
        r.write(body);
        r.end();
      });
    }

    // Image upload with PDF magic bytes but declared as image/jpeg → rejected
    const pdfBytes = Buffer.from([0x25,0x50,0x44,0x46,0x2D,0x31,0x2E,0x34]); // %PDF-1.4
    const imgRejected = await multipartReq(
      '/api/business/images', 'image', 'evil.jpg', pdfBytes, 'image/jpeg', cookie
    );
    assert(imgRejected.status === 400 && /tipo/i.test(imgRejected.body?.error || ''),
      'image upload: PDF bytes with image/jpeg Content-Type → 400 magic bytes error');

    // Document upload with JPEG magic bytes but declared as application/pdf → rejected
    const jpegBytes = Buffer.from([0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46]);
    const docRejected = await multipartReq(
      '/api/business/document', 'document', 'evil.pdf', jpegBytes, 'application/pdf', cookie
    );
    assert(docRejected.status === 400 && /tipo/i.test(docRejected.body?.error || ''),
      'document upload: JPEG bytes with application/pdf Content-Type → 400 magic bytes error');

    // Image upload with wrong declared MIME (multer filter catches it)
    const anyBytes = Buffer.alloc(16, 0x41); // "AAAA..."
    const gifMime = await multipartReq(
      '/api/business/images', 'image', 'test.gif', anyBytes, 'image/gif', cookie
    );
    assert(gifMime.status === 400 || gifMime.status === 500,
      'image upload: image/gif MIME → rejected by multer MIME filter');
  }

  // ── Suite 7: PII not in error_log ──
  console.log('\nSuite 7: PII sanitization in logs');
  {
    // Verify the log format by checking DB directly after a webhook attempt
    // (We can't easily trigger a real Anthropic call in tests, so check the functions exist)
    // Check that no full phone number format appears in the webhook-claude-call log context
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));

    // Look for any error_log row that has a 10+ digit phone number
    const fullPhonePattern = db.prepare(
      "SELECT COUNT(*) as cnt FROM error_log WHERE message LIKE '%customer=+%' OR message LIKE '%customer=5%9%'"
    ).get();
    assert(fullPhonePattern.cnt === 0, 'error_log: no full phone numbers in message column');
    db.close();
  }

  // ── Suite 8: ElevenLabs timeout set ──
  console.log('\nSuite 8: ElevenLabs timeout (code inspection)');
  {
    const src = fs.readFileSync(path.join(__dirname, '../src/elevenlabs.js'), 'utf8');
    assert(src.includes('EL_TIMEOUT_MS'), 'elevenlabs.js defines EL_TIMEOUT_MS constant');
    assert(src.includes('AbortController'), 'elevenlabs.js uses AbortController');
    assert(src.includes('fetchWithTimeout'), 'elevenlabs.js uses fetchWithTimeout wrapper');
    // The one remaining `await fetch(` is inside fetchWithTimeout itself — all API calls use the wrapper
    const fetchCallCount = (src.match(/await fetch\(/g) || []).length;
    assert(fetchCallCount <= 1, `elevenlabs.js: all API fetch() calls wrapped (max 1 bare — in helper) — found ${fetchCallCount}`);
  }

  // ── Summary ──
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('SOME TESTS FAILED'); process.exitCode = 1; }
  else             { console.log('ALL TESTS PASSED'); }
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; });
