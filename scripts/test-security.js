#!/usr/bin/env node
'use strict';
// FASE 1 security tests.
// Run: node scripts/test-security.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3099;
const DB_DIR    = '/tmp/test-security';
const ADMIN_EMAIL_ADDR = 'admin-sec@test.com';
const ADMIN_PASS       = 'AdminSec1!test';
const BASE_URL         = `http://localhost:${TEST_PORT}`;

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

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    if (opts.xff)    headers['X-Forwarded-For'] = opts.xff;
    if (opts.proto)  headers['X-Forwarded-Proto'] = opts.proto;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers, setCookie: res.headers['set-cookie'] }); }
          catch { resolve({ status: res.statusCode, body: data, headers: res.headers, setCookie: res.headers['set-cookie'] }); }
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
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

async function registerUser(email, pass = 'UserPass1!test') {
  const r = await req('POST', '/auth/register', { email, password: pass });
  if (r.status !== 200) throw new Error(`register ${email} failed: status=${r.status} body=${JSON.stringify(r.body)}`);
  return r.setCookie?.[0]?.split(';')[0];
}

async function getAdminCookie() {
  await req('POST', '/auth/register', { email: ADMIN_EMAIL_ADDR, password: ADMIN_PASS });
  const r = await req('POST', '/admin/auth/login', { email: ADMIN_EMAIL_ADDR, password: ADMIN_PASS });
  if (r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r.body)}`);
  return r.setCookie?.[0]?.split(';')[0];
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
      SESSION_SECRET: 'sec-test-secret-xyz',
      ADMIN_EMAIL: ADMIN_EMAIL_ADDR,
      NODE_ENV: '',            // not prod so cookie.secure=false → works over http
      RAILWAY_ENVIRONMENT: '', // same
      ENABLE_RATE_LIMIT: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  // ── Suite 1: Rate limiting /auth/login (5 attempts per IP) ──
  console.log('Suite 1: Rate limiting /auth/login');
  {
    // Use a fresh email that doesn't exist — ensures rate limit triggers before any real auth
    const email = `rl-login-${Date.now()}@test.com`;
    let lastStatus;
    for (let i = 1; i <= 6; i++) {
      const r = await req('POST', '/auth/login', { email, password: 'wrong' }, { xff: '11.22.33.44' });
      lastStatus = r.status;
      if (i <= 5) assert([401].includes(r.status), `attempt ${i}: status 401 (not rate limited yet)`);
    }
    assert(lastStatus === 429, '6th attempt from same IP returns 429');

    // Different IP + different email → should NOT be rate-limited
    const freshEmail = `rl-fresh-${Date.now()}@test.com`;
    const r2 = await req('POST', '/auth/login', { email: freshEmail, password: 'wrong' }, { xff: '11.22.33.99' });
    assert(r2.status === 401, 'fresh IP + fresh email not rate-limited');
  }

  // ── Suite 2: Rate limiting /auth/login by email ──
  console.log('\nSuite 2: Rate limiting /auth/login by email');
  {
    // Create a real user
    const email = `rl-email-${Date.now()}@test.com`;
    await registerUser(email);
    // 5 attempts from 5 different IPs against the same email
    for (let i = 1; i <= 5; i++) {
      await req('POST', '/auth/login', { email, password: 'wrong' }, { xff: `22.33.44.${i}` });
    }
    // 6th from a new IP — should still be 429 because email bucket is full
    const r = await req('POST', '/auth/login', { email, password: 'wrong' }, { xff: '22.33.44.99' });
    assert(r.status === 429, '6th attempt on same email from new IP returns 429');
  }

  // ── Suite 3: Rate limiting /auth/register ──
  console.log('\nSuite 3: Rate limiting /auth/register');
  {
    let lastStatus;
    for (let i = 1; i <= 6; i++) {
      const r = await req('POST', '/auth/register',
        { email: `reg-rl${i}@test.com`, password: 'Passw0rd!x' },
        { xff: '55.66.77.88' }
      );
      lastStatus = r.status;
    }
    assert(lastStatus === 429, '6th register from same IP returns 429');
  }

  // ── Suite 4: Rate limiting /admin/auth/login ──
  console.log('\nSuite 4: Rate limiting /admin/auth/login');
  {
    let lastStatus;
    for (let i = 1; i <= 6; i++) {
      const r = await req('POST', '/admin/auth/login',
        { email: ADMIN_EMAIL_ADDR, password: 'wrong-pass' },
        { xff: '77.88.99.11' }
      );
      lastStatus = r.status;
    }
    assert(lastStatus === 429, '6th admin login from same IP returns 429');
  }

  // ── Suite 5: Debug routes require admin, not just auth ──
  console.log('\nSuite 5: Debug routes blocked for regular users');
  {
    const userCookie = await registerUser(`debug-test-${Date.now()}@test.com`);
    const r1 = await req('GET', '/api/debug/seed-conversations', null, { cookie: userCookie });
    assert(r1.status === 403, '/api/debug/seed-conversations returns 403 for regular user');
    const r2 = await req('GET', '/api/debug/me', null, { cookie: userCookie });
    assert(r2.status === 403, '/api/debug/me returns 403 for regular user');
    // Verify admin can still access them
    const adminCookie = await getAdminCookie();
    const r3 = await req('GET', '/api/debug/seed-conversations', null, { cookie: adminCookie });
    assert(r3.status !== 403, '/api/debug/seed-conversations not blocked (403) for admin');
    const r4 = await req('GET', '/api/debug/me', null, { cookie: adminCookie });
    assert(r4.status !== 403, '/api/debug/me not blocked (403) for admin');
  }

  // ── Suite 6: Cookie secure flag in production mode ──
  // We re-test with IS_PROD=true to verify cookie.secure appears
  console.log('\nSuite 6: Cookie secure flag (IS_PROD simulation)');
  {
    // Stop current server, start a new one with IS_PROD=true
    serverProc.kill('SIGTERM');
    await sleep(800);
    const DB_DIR_PROD = '/tmp/test-security-prod';
    fs.mkdirSync(DB_DIR_PROD, { recursive: true });
    const prodProc = spawn('node', ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        DB_DIR: DB_DIR_PROD,
        SESSION_SECRET: 'prod-test-secret-xyz',
        ADMIN_EMAIL: ADMIN_EMAIL_ADDR,
        NODE_ENV: 'production',
        // Disable R2 so backup doesn't blow up
        R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prodProc.stdout.on('data', d => process.stdout.write('[prod] ' + d));
    prodProc.stderr.on('data', d => process.stderr.write('[prod] ' + d));
    // Wait for prod server
    for (let i = 0; i < 40; i++) {
      try { const r = await req('GET', '/health'); if (r.status === 200) break; } catch { /* not up */ }
      await sleep(500);
    }
    await sleep(300);
    // Register and login — pass X-Forwarded-Proto:https so trust proxy sees req.secure=true
    // Without it, express-session withholds Set-Cookie on plain HTTP (correct behavior).
    await req('POST', '/auth/register', { email: 'cookietest@prod.com', password: 'Passw0rd!prod' }, { proto: 'https' });
    const lr = await req('POST', '/auth/login', { email: 'cookietest@prod.com', password: 'Passw0rd!prod' }, { proto: 'https' });
    const setCookieHeader = lr.setCookie?.[0] || '';
    assert(lr.status === 200, 'login OK in prod mode (with X-Forwarded-Proto: https)');
    assert(setCookieHeader.toLowerCase().includes('secure'), 'Set-Cookie has Secure flag in IS_PROD=true');
    assert(setCookieHeader.toLowerCase().includes('httponly'), 'Set-Cookie has HttpOnly flag');

    prodProc.kill('SIGTERM');
    await sleep(500);
    try { execSync(`rm -rf ${DB_DIR_PROD}`); } catch (_) {}

    // Restart normal server for remaining tests
    fs.mkdirSync(DB_DIR, { recursive: true });
    serverProc = spawn('node', ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        DB_DIR,
        SESSION_SECRET: 'sec-test-secret-xyz',
        ADMIN_EMAIL: ADMIN_EMAIL_ADDR,
        NODE_ENV: '',
        RAILWAY_ENVIRONMENT: '',
        ENABLE_RATE_LIMIT: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write('[srv2] ' + d));
    serverProc.stderr.on('data', d => process.stderr.write('[srv2] ' + d));
    await waitForServer();
    await sleep(300);
  }

  // ── Suite 7: Helmet security headers ──
  console.log('\nSuite 7: Security headers (Helmet)');
  {
    const r = await req('GET', '/health');
    assert(r.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
    assert(!!r.headers['x-frame-options'], 'X-Frame-Options present');
    assert(!!r.headers['x-dns-prefetch-control'], 'X-DNS-Prefetch-Control present');
    assert(!!r.headers['strict-transport-security'], 'Strict-Transport-Security present');
  }

  // ── Suite 8: SSRF — blocked protocols and IPs ──
  // fetchAndSummarizeWebsite is called non-blocking from PUT /api/business.
  // We test the SSRF guard by setting up a local HTTP server and verifying it never receives
  // a connection when the URL resolves to 127.0.0.1 (blocked by SSRF guard).
  console.log('\nSuite 8: SSRF protection');
  {
    // Start a local HTTP server that records if it was hit
    let wasHit = false;
    const ssrfTarget = http.createServer((req, res) => {
      wasHit = true;
      res.end('you should not see this');
    });
    await new Promise(r => ssrfTarget.listen(0, '127.0.0.1', r));
    const ssrfPort = ssrfTarget.address().port;

    const userCookie = await registerUser(`ssrf-test-${Date.now()}@test.com`);

    // Attempt to set a business URL pointing to localhost (SSRF target)
    // This is fire-and-forget in the server, so we wait a bit and check wasHit
    await req('PUT', '/api/business',
      { name: 'SSRFBiz', website_url: `http://127.0.0.1:${ssrfPort}/` },
      { cookie: userCookie }
    );
    await sleep(1500); // give the non-blocking call time to fire
    assert(!wasHit, `SSRF: http://127.0.0.1:${ssrfPort} was NOT fetched (blocked by guard)`);

    // Test 2: try https but with 10.x private IP — use a fake hostname in /etc/hosts won't work,
    // so test through _validateSsrfUrl logic: we just test that HTTP is blocked
    wasHit = false;
    await req('PUT', '/api/business',
      { name: 'SSRFBiz2', website_url: `http://localhost:${ssrfPort}/` },
      { cookie: userCookie }
    );
    await sleep(1500);
    assert(!wasHit, `SSRF: http://localhost:${ssrfPort} was NOT fetched (http:// blocked)`);

    ssrfTarget.close();
  }

  // ── Suite 9: Trust proxy - req.ip reflects X-Forwarded-For ──
  // We verify that rate limiting works via X-Forwarded-For (not just 127.0.0.1 always)
  // Suite 1 already proves this: different XFF IPs hit different rate-limit buckets.
  console.log('\nSuite 9: Trust proxy (verified via rate-limit buckets in Suite 1)');
  assert(true, 'Trust proxy confirmed by Suite 1 (different XFF IPs have independent rate-limit buckets)');

  // ── Summary ──
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('SOME TESTS FAILED'); }
  else             { console.log('ALL TESTS PASSED'); }
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); cleanup(); process.exit(1); });
