#!/usr/bin/env node
'use strict';
// Partner CRM API tests.
// Run: node scripts/test-partner.js
// Covers: 401 (no key / wrong key), idempotent creation, 409 on pre-existing email,
// login-link only for CRM accounts, single-use link, expired link, and that a crm
// business does NOT unlock Crecimiento-only features (voice cloning).

const fs   = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { execSync, spawn } = require('child_process');

const TEST_PORT   = 3097;
const DB_DIR      = '/tmp/test-partner';
const PARTNER_KEY = 'partner-secret-key-test-xyz';
const APP_URL     = `http://localhost:${TEST_PORT}`;

let serverProc = null;
let passed = 0;
let failed = 0;

function cleanup() {
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch (_) {} serverProc = null; }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Generic request. opts.headers merges extra headers; redirects are NOT followed.
function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    if (body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const payload = body == null ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* non-JSON (redirects, html) */ }
          resolve({
            status: res.statusCode, body: parsed, raw: data,
            headers: res.headers,
            location: res.headers['location'],
            setCookie: res.headers['set-cookie'],
          });
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function bearer(key) { return { headers: { Authorization: `Bearer ${key}` } }; }

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

// Minimal multipart/form-data body with a single file field. Buffer starts with the
// "ID3" magic so the server detects it as audio/mpeg and reaches the plan gate.
function audioMultipart(fieldName) {
  const boundary = '----partnertestboundary' + Date.now();
  const fileBytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 0)]);
  const consent = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="consent"\r\n\r\n` +
    `true\r\n`
  );
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="v.mp3"\r\n` +
    `Content-Type: audio/mpeg\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([consent, head, fileBytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  console.log('Starting server on port', TEST_PORT, '...');
  fs.mkdirSync(DB_DIR, { recursive: true });
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'partner-test-secret',
      PARTNER_CRM_KEY: PARTNER_KEY,
      APP_URL,
      NODE_ENV: '',            // not prod → cookie.secure=false over http
      RAILWAY_ENVIRONMENT: '',
      ENABLE_RATE_LIMIT: '',   // disable rate limiting for this suite
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  // ── Suite 1: Auth (401 without / with wrong key) ──
  console.log('Suite 1: Partner key auth');
  {
    const noKey = await req('POST', '/api/partner/businesses', { crm_user_id: 'x', name: 'X', email: 'x@test.com' });
    assert(noKey.status === 401, 'create without key → 401');

    const badKey = await req('POST', '/api/partner/businesses',
      { crm_user_id: 'x', name: 'X', email: 'x@test.com' }, bearer('wrong-key'));
    assert(badKey.status === 401, 'create with wrong key → 401');

    const llNoKey = await req('POST', '/api/partner/login-link', { crm_user_id: 'x' });
    assert(llNoKey.status === 401, 'login-link without key → 401');

    const llBad = await req('POST', '/api/partner/login-link', { crm_user_id: 'x' }, bearer('nope'));
    assert(llBad.status === 401, 'login-link with wrong key → 401');
  }

  // ── Suite 2: Create + idempotency ──
  console.log('\nSuite 2: Create + idempotency');
  let crmBizId;
  {
    const c1 = await req('POST', '/api/partner/businesses',
      { crm_user_id: 'crm_1', name: 'Peluquería Lola', email: 'lola@test.com' }, bearer(PARTNER_KEY));
    assert(c1.status === 200 && c1.body.created === true && Number.isInteger(c1.body.business_id),
      'first create → 200 created:true with business_id');
    crmBizId = c1.body.business_id;

    const c2 = await req('POST', '/api/partner/businesses',
      { crm_user_id: 'crm_1', name: 'Peluquería Lola', email: 'lola@test.com' }, bearer(PARTNER_KEY));
    assert(c2.status === 200 && c2.body.created === false && c2.body.business_id === crmBizId,
      'second create same crm_user_id → same business, created:false (no duplicate)');

    // Idempotent even if name/email differ on the retry
    const c3 = await req('POST', '/api/partner/businesses',
      { crm_user_id: 'crm_1', name: 'Otro', email: 'otro@test.com' }, bearer(PARTNER_KEY));
    assert(c3.status === 200 && c3.body.business_id === crmBizId, 'idempotent by crm_user_id regardless of body');

    const bad = await req('POST', '/api/partner/businesses', { crm_user_id: 'crm_2', name: 'NoMail' }, bearer(PARTNER_KEY));
    assert(bad.status === 400, 'missing email → 400');
  }

  // ── Suite 3: Never adopt a pre-existing account (409) ──
  console.log('\nSuite 3: Pre-existing account is never linked');
  {
    // (a) A normal Daxos signup, not created by the CRM.
    const email = 'existing@test.com';
    const reg = await req('POST', '/auth/register', { email, password: 'UserPass1!test' });
    assert(reg.status === 200, 'pre-existing user registered normally');

    const conflict = await req('POST', '/api/partner/businesses',
      { crm_user_id: 'crm_takeover', name: 'Takeover', email }, bearer(PARTNER_KEY));
    assert(conflict.status === 409, 'create with an email that already has a non-CRM account → 409');
    assert(conflict.body && conflict.body.business_id === undefined,
      '409 response leaks no account data (no business_id)');

    // login-link must not work for that pre-existing (non-CRM) account.
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: 'crm_takeover' }, bearer(PARTNER_KEY));
    assert(ll.status === 404, 'login-link for an id that was refused → 404 (no account created)');

    // (b) Email already used by a CRM account, different crm_user_id → also 409.
    const conflict2 = await req('POST', '/api/partner/businesses',
      { crm_user_id: 'crm_other', name: 'Dup', email: 'lola@test.com' }, bearer(PARTNER_KEY));
    assert(conflict2.status === 409, 'create reusing a CRM account email under a new crm_user_id → 409');
  }

  // ── Suite 4: login-link only for CRM accounts ──
  console.log('\nSuite 4: login-link scoping');
  {
    const missing = await req('POST', '/api/partner/login-link', { crm_user_id: 'does_not_exist' }, bearer(PARTNER_KEY));
    assert(missing.status === 404, 'login-link for unknown crm_user_id → 404');
  }

  // ── Suite 5: One-time login link logs the owner in ──
  console.log('\nSuite 5: Login link enters the panel');
  {
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: 'crm_1' }, bearer(PARTNER_KEY));
    assert(ll.status === 200 && typeof ll.body.url === 'string' && ll.body.url.includes('/api/partner/enter?token='),
      'login-link → 200 with enter url');
    assert(typeof ll.body.expires_at === 'string', 'login-link returns expires_at');

    const token = new URL(ll.body.url).searchParams.get('token');
    const enter = await req('GET', `/api/partner/enter?token=${token}`);
    assert(enter.status === 303 && enter.location === '/inicio.html', 'enter → 303 redirect to /inicio.html');
    const cookie = enter.setCookie?.[0]?.split(';')[0];
    assert(!!cookie, 'enter sets a session cookie');

    const me = await req('GET', '/auth/me', null, { cookie });
    assert(me.status === 200, '/auth/me with session cookie → 200 (logged in)');

    // ── Suite 7 (reuses this session): crm does NOT unlock Crecimiento ──
    const mp = audioMultipart('audio');
    const voice = await req('POST', '/api/business/voice', mp.body, { cookie, headers: { 'Content-Type': mp.contentType } });
    assert(voice.status === 403, 'crm business cannot clone voice (Crecimiento-only) → 403');

    const biz = await req('GET', '/api/business', null, { cookie });
    assert(biz.status === 200 && biz.body.plan === 'crm', 'owner view reports plan=crm');
  }

  // ── Suite 6: Link is single-use ──
  console.log('\nSuite 6: Single-use link');
  {
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: 'crm_1' }, bearer(PARTNER_KEY));
    const token = new URL(ll.body.url).searchParams.get('token');
    const first = await req('GET', `/api/partner/enter?token=${token}`);
    assert(first.status === 303, 'first use of link → 303 (ok)');
    const second = await req('GET', `/api/partner/enter?token=${token}`);
    assert(second.status === 401, 'second use of same link → 401');
  }

  // ── Suite 7: Expired link ──
  console.log('\nSuite 7: Expired link');
  {
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: 'crm_1' }, bearer(PARTNER_KEY));
    const token = new URL(ll.body.url).searchParams.get('token');
    // Backdate the just-issued token so it is already expired.
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    db.prepare('UPDATE partner_login_tokens SET expires_at = ? WHERE used = 0').run(Math.floor(Date.now() / 1000) - 10);
    db.close();
    const enter = await req('GET', `/api/partner/enter?token=${token}`);
    assert(enter.status === 401, 'expired link → 401');
  }

  // ── Summary ──
  console.log('\n================================');
  console.log(`Partner tests — ${passed} passed, ${failed} failed`);
  console.log('================================');
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test run error:', err);
  cleanup();
  process.exit(1);
});
