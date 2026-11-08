#!/usr/bin/env node
'use strict';
/**
 * Suite H: test-harness endpoint security.
 * H1: NODE_ENV=production  → /test/* returns 404
 * H2: NODE_ENV=test, no DAXOS_TEST_HARNESS → /test/* returns 404
 * H3: NODE_ENV=test + RAILWAY_ENVIRONMENT  → server exits immediately (non-zero)
 * H4: harness enabled but X-Test-Token missing → 404
 * H5: harness enabled but X-Test-Token wrong   → 404
 * H6: harness enabled with correct token       → 200 (confirms routes exist when intended)
 */

const path    = require('path');
const http    = require('http');
const { spawn, execSync } = require('child_process');
const fs      = require('fs');

process.chdir(path.join(__dirname, '..'));

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const BASE_PORT = 3218;
const BASE_DB   = '/tmp/test-harness-sec';

function mkdb(tag) {
  const d = `${BASE_DB}-${tag}`;
  try { execSync(`rm -rf ${d}`); } catch (_) {}
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function startServer(extraEnv, tag) {
  const dbDir = mkdb(tag);
  return { proc: spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(BASE_PORT + Number(tag)), DB_DIR: dbDir,
           SESSION_SECRET: `sec-${tag}`, RAILWAY_ENVIRONMENT: '', ...extraEnv },
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  }), dbDir };
}

function req(port, method, urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2', ...extraHeaders } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.write('{}');
    r.end();
  });
}

function waitForServer(port) {
  return new Promise((resolve) => {
    let attempts = 0;
    const iv = setInterval(async () => {
      attempts++;
      try {
        const r = await req(port, 'GET', '/health');
        if (r.status === 200) { clearInterval(iv); resolve(true); }
      } catch (_) {}
      if (attempts > 40) { clearInterval(iv); resolve(false); }
    }, 300);
  });
}

function readToken(proc) {
  return new Promise((resolve) => {
    let buf = '';
    proc.stdout.on('data', d => {
      buf += String(d);
      const m = buf.match(/\[test-harness\] token=([0-9a-f]{64})/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => resolve(null), 8000);
  });
}

async function main() {

  // ── H1: NODE_ENV=production → 404 ─────────────────────────────────────────
  console.log('\n--- H1: NODE_ENV=production — /test/* must be 404 ---');
  {
    const { proc } = startServer({ NODE_ENV: 'production', DAXOS_TEST_HARNESS: '1' }, 0);
    const started = await waitForServer(BASE_PORT + 0);
    ok('H1 server started in production mode', started);
    if (started) {
      const r1 = await req(BASE_PORT + 0, 'POST', '/test/mock-reply');
      ok('H1 /test/mock-reply → 404 in production', r1.status === 404, `got ${r1.status}`);
      const r2 = await req(BASE_PORT + 0, 'POST', '/test/inject-message');
      ok('H1 /test/inject-message → 404 in production', r2.status === 404, `got ${r2.status}`);
    } else {
      ok('H1 /test/mock-reply → 404 in production', false, 'server not started');
      ok('H1 /test/inject-message → 404 in production', false, 'server not started');
    }
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    try { execSync(`rm -rf ${BASE_DB}-0`); } catch (_) {}
  }

  // ── H2: NODE_ENV=test, no DAXOS_TEST_HARNESS → 404 ───────────────────────
  console.log('\n--- H2: NODE_ENV=test without DAXOS_TEST_HARNESS — /test/* must be 404 ---');
  {
    const { proc } = startServer({ NODE_ENV: 'test', DAXOS_TEST_HARNESS: '' }, 1);
    const started = await waitForServer(BASE_PORT + 1);
    ok('H2 server started', started);
    if (started) {
      const r1 = await req(BASE_PORT + 1, 'POST', '/test/mock-reply');
      ok('H2 /test/mock-reply → 404 without DAXOS_TEST_HARNESS', r1.status === 404, `got ${r1.status}`);
      const r2 = await req(BASE_PORT + 1, 'POST', '/test/inject-message');
      ok('H2 /test/inject-message → 404 without DAXOS_TEST_HARNESS', r2.status === 404, `got ${r2.status}`);
    } else {
      ok('H2 /test/mock-reply → 404', false, 'server not started');
      ok('H2 /test/inject-message → 404', false, 'server not started');
    }
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    try { execSync(`rm -rf ${BASE_DB}-1`); } catch (_) {}
  }

  // ── H3: NODE_ENV=test + RAILWAY_ENVIRONMENT → process.exit(1) ─────────────
  console.log('\n--- H3: NODE_ENV=test + RAILWAY_ENVIRONMENT → server must exit ---');
  {
    const dbDir = mkdb(2);
    const proc = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, PORT: String(BASE_PORT + 2), DB_DIR: dbDir,
             SESSION_SECRET: 'sec-h3', NODE_ENV: 'test', DAXOS_TEST_HARNESS: '1',
             RAILWAY_ENVIRONMENT: 'production' },
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitCode = await new Promise(resolve => {
      const t = setTimeout(() => { proc.kill('SIGTERM'); resolve(null); }, 5000);
      proc.on('exit', code => { clearTimeout(t); resolve(code); });
    });
    ok('H3 server exits non-zero when NODE_ENV=test + RAILWAY_ENVIRONMENT', exitCode === 1,
      exitCode === null ? 'timeout (never exited)' : `exit code ${exitCode}`);
    try { execSync(`rm -rf ${dbDir}`); } catch (_) {}
  }

  // ── H4 + H5 + H6: token checks ────────────────────────────────────────────
  console.log('\n--- H4/H5/H6: X-Test-Token enforcement ---');
  {
    const { proc } = startServer({ NODE_ENV: 'test', DAXOS_TEST_HARNESS: '1' }, 3);
    const tokenP  = readToken(proc);
    const started = await waitForServer(BASE_PORT + 3);
    const token   = await tokenP;
    ok('H4 server started with harness', started);
    ok('H4 token received from stdout', !!token, 'no token in stdout');

    if (started) {
      // H4: no token header → 404
      const r4 = await req(BASE_PORT + 3, 'POST', '/test/mock-reply', {});
      ok('H4 /test/mock-reply → 404 without X-Test-Token', r4.status === 404, `got ${r4.status}`);

      // H5: wrong token → 404
      const r5 = await req(BASE_PORT + 3, 'POST', '/test/mock-reply',
        { 'X-Test-Token': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      ok('H5 /test/mock-reply → 404 with wrong X-Test-Token', r5.status === 404, `got ${r5.status}`);

      // H6: correct token → not 404 (might be 400 for missing body fields, but NOT 404)
      if (token) {
        const r6 = await req(BASE_PORT + 3, 'POST', '/test/mock-reply', { 'X-Test-Token': token });
        ok('H6 /test/mock-reply → not 404 with correct X-Test-Token', r6.status !== 404,
          `got ${r6.status} body=${r6.body.slice(0,80)}`);
      } else {
        ok('H6 correct token accepted', false, 'token not available');
      }
    } else {
      ok('H4 token check', false, 'server not started');
      ok('H5 wrong token check', false, 'server not started');
      ok('H6 correct token check', false, 'server not started');
    }
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    try { execSync(`rm -rf ${BASE_DB}-3`); } catch (_) {}
  }

  console.log('\n================================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
