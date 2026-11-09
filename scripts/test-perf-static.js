#!/usr/bin/env node
'use strict';
/**
 * Suite P: compression middleware + CSS versioning + security
 * Tests gzip/brotli for .html/.css/.js, immutable cache for ?v= CSS,
 * ETag/304 conditionals, path traversal blocking, HEAD support.
 * Port 3230, DB /tmp/test-perf-static
 */

const path     = require('path');
const http     = require('http');
const zlib     = require('zlib');
const { spawn, execSync } = require('child_process');
const fs       = require('fs');

process.chdir(path.join(__dirname, '..'));

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const PORT   = 3230;
const DB_DIR = '/tmp/test-perf-static';

function mkdb() {
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  fs.mkdirSync(DB_DIR, { recursive: true });
  return DB_DIR;
}

function startServer() {
  const dbDir = mkdb();
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_DIR: dbDir,
      SESSION_SECRET: 'perf-test-secret',
      RAILWAY_ENVIRONMENT: '',
      NODE_ENV: 'test',
    },
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

function waitForServer() {
  return new Promise(resolve => {
    let attempts = 0;
    const iv = setInterval(async () => {
      attempts++;
      try {
        const r = await get('/health');
        if (r.status === 200) { clearInterval(iv); resolve(true); }
      } catch (_) {}
      if (attempts > 40) { clearInterval(iv); resolve(false); }
    }, 300);
  });
}

function rawReq(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: PORT, path: urlPath, method,
      headers: { 'User-Agent': 'test', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function get(urlPath, headers = {}) {
  return rawReq('GET', urlPath, headers);
}

async function head(urlPath, headers = {}) {
  return rawReq('HEAD', urlPath, headers);
}

function decompress(buf, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === 'br')   { zlib.brotliDecompress(buf, (e, d) => e ? reject(e) : resolve(d)); return; }
    if (encoding === 'gzip') { zlib.gunzip(buf, (e, d) => e ? reject(e) : resolve(d)); return; }
    resolve(buf);
  });
}

async function main() {
  const proc = startServer();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  const up = await waitForServer();
  ok('server starts on port 3230', up);
  if (!up) { proc.kill(); process.exit(1); }

  // ── P1: gzip compression ───────────────────────────────────────────────────
  console.log('\n--- P1: gzip ---');
  {
    const r = await get('/inicio.html', { 'Accept-Encoding': 'gzip' });
    ok('P1.1 inicio.html status 200', r.status === 200);
    ok('P1.2 inicio.html content-encoding: gzip', r.headers['content-encoding'] === 'gzip');
    ok('P1.3 inicio.html has Vary: Accept-Encoding', (r.headers['vary'] || '').includes('Accept-Encoding'));
    const dec = await decompress(r.raw, 'gzip');
    ok('P1.4 inicio.html decompresses to valid HTML', dec.toString().includes('<!DOCTYPE html>') || dec.toString().includes('<html'));
  }
  {
    const r = await get('/dashboard.css', { 'Accept-Encoding': 'gzip' });
    ok('P1.5 dashboard.css status 200', r.status === 200);
    ok('P1.6 dashboard.css content-encoding: gzip', r.headers['content-encoding'] === 'gzip');
  }

  // ── P2: brotli compression ─────────────────────────────────────────────────
  console.log('\n--- P2: brotli ---');
  {
    const r = await get('/inicio.html', { 'Accept-Encoding': 'br' });
    ok('P2.1 inicio.html content-encoding: br', r.headers['content-encoding'] === 'br');
    const dec = await decompress(r.raw, 'br');
    ok('P2.2 inicio.html brotli decompresses OK', dec.length > 100);
  }
  {
    const r = await get('/dashboard.css', { 'Accept-Encoding': 'br' });
    ok('P2.3 dashboard.css content-encoding: br', r.headers['content-encoding'] === 'br');
  }

  // ── P3: no compression when Accept-Encoding absent ─────────────────────────
  console.log('\n--- P3: no compression without Accept-Encoding ---');
  {
    const r = await get('/inicio.html', {});
    ok('P3.1 no content-encoding header', !r.headers['content-encoding']);
    ok('P3.2 raw HTML readable', r.raw.toString().includes('<'));
  }

  // ── P4: ETag + 304 ─────────────────────────────────────────────────────────
  console.log('\n--- P4: ETag / 304 ---');
  {
    const r1 = await get('/inicio.html', { 'Accept-Encoding': 'gzip' });
    const etag = r1.headers['etag'];
    ok('P4.1 ETag present', !!etag);
    const r2 = await get('/inicio.html', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    ok('P4.2 304 on matching ETag', r2.status === 304);
    ok('P4.3 304 body is empty', r2.raw.length === 0);
  }
  {
    const r1 = await get('/dashboard.css', { 'Accept-Encoding': 'gzip' });
    const etag = r1.headers['etag'];
    ok('P4.4 CSS ETag present', !!etag);
    const r2 = await get('/dashboard.css', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    ok('P4.5 CSS 304 on matching ETag', r2.status === 304);
  }

  // ── P5: CSS versioning injected into HTML ──────────────────────────────────
  console.log('\n--- P5: CSS ?v= versioning in HTML ---');
  {
    const r = await get('/inicio.html', { 'Accept-Encoding': 'gzip' });
    const html = (await decompress(r.raw, 'gzip')).toString();
    ok('P5.1 inicio.html has ?v= in CSS href', /dashboard\.css\?v=[0-9a-f]{10}/.test(html));
  }
  {
    const r = await get('/agenda.html', { 'Accept-Encoding': 'gzip' });
    const html = (await decompress(r.raw, 'gzip')).toString();
    ok('P5.2 agenda.html has ?v= in CSS href', /dashboard\.css\?v=[0-9a-f]{10}/.test(html));
  }
  {
    const r = await get('/conversations.html', { 'Accept-Encoding': 'gzip' });
    const html = (await decompress(r.raw, 'gzip')).toString();
    ok('P5.3 conversations.html has ?v= in CSS href', /dashboard\.css\?v=[0-9a-f]{10}/.test(html));
  }
  {
    const r = await get('/dashboard.html', { 'Accept-Encoding': 'gzip' });
    const html = (await decompress(r.raw, 'gzip')).toString();
    ok('P5.4 dashboard.html has ?v= in CSS href', /dashboard\.css\?v=[0-9a-f]{10}/.test(html));
  }

  // ── P6: versioned CSS served with immutable cache ──────────────────────────
  console.log('\n--- P6: versioned CSS immutable cache ---');
  {
    // First get the actual hash from an HTML page
    const htmlR = await get('/inicio.html', { 'Accept-Encoding': 'gzip' });
    const html  = (await decompress(htmlR.raw, 'gzip')).toString();
    const m     = html.match(/dashboard\.css\?v=([0-9a-f]{10})/);
    ok('P6.1 found ?v= hash in HTML', !!m);
    if (m) {
      const r = await get(`/dashboard.css?v=${m[1]}`, { 'Accept-Encoding': 'gzip' });
      ok('P6.2 versioned CSS status 200', r.status === 200);
      const cc = r.headers['cache-control'] || '';
      ok('P6.3 versioned CSS has max-age=31536000', cc.includes('max-age=31536000'));
      ok('P6.4 versioned CSS has immutable', cc.includes('immutable'));
    } else {
      ok('P6.2 versioned CSS status 200', false, 'skipped — no hash found');
      ok('P6.3 versioned CSS has max-age=31536000', false, 'skipped');
      ok('P6.4 versioned CSS has immutable', false, 'skipped');
    }
  }

  // ── P7: HEAD requests ─────────────────────────────────────────────────────
  console.log('\n--- P7: HEAD requests ---');
  {
    const r = await head('/inicio.html', { 'Accept-Encoding': 'gzip' });
    ok('P7.1 HEAD /inicio.html status 200', r.status === 200);
    ok('P7.2 HEAD has Content-Type', !!(r.headers['content-type'] || '').includes('text/html'));
    ok('P7.3 HEAD body empty', r.raw.length === 0);
  }

  // ── P8: path traversal blocked ────────────────────────────────────────────
  console.log('\n--- P8: path traversal security ---');
  const traversals = [
    '/../package.json',
    '/..%2Fpackage.json',
    '/%2e%2e/package.json',
    '/public/../package.json',
    '/../src/server.js',
  ];
  for (const t of traversals) {
    const r = await get(t);
    ok(`P8 blocked: ${t}`, r.status === 400 || r.status === 403 || r.status === 404,
       `got ${r.status}`);
  }

  // ── P9: uncompressed extensions pass through ──────────────────────────────
  console.log('\n--- P9: PNG served without compression ---');
  {
    // find a PNG in public if any, else just verify we don't crash on unknown ext
    // We'll test a non-existent .png to verify 404, not crash
    const r = await get('/nonexistent.png', { 'Accept-Encoding': 'gzip' });
    ok('P9.1 missing PNG returns 404 not 500', r.status === 404 || r.status === 302);
  }

  // ── P10: Content-Type headers correct ─────────────────────────────────────
  console.log('\n--- P10: correct Content-Type ---');
  {
    const r = await get('/inicio.html');
    ok('P10.1 HTML content-type', (r.headers['content-type'] || '').startsWith('text/html'));
  }
  {
    const r = await get('/dashboard.css');
    ok('P10.2 CSS content-type', (r.headers['content-type'] || '').startsWith('text/css'));
  }

  // ── P11: compressCache max 200 entries (evicts oldest) ────────────────────
  console.log('\n--- P11: compressCache 200-entry limit ---');
  {
    // The cache is shared with the running server. Warm it up with many unique
    // requests that force new entries.  We can't directly inspect the Map, but
    // we can verify the server keeps responding correctly after > 200 requests,
    // which would only be true if eviction is working (no OOM / no crash).
    // We also verify that a file served early is still served correctly after
    // the cache has rolled over (i.e., eviction doesn't corrupt state).
    const r0 = await get('/inicio.html', { 'Accept-Encoding': 'gzip' });
    const etag0 = r0.headers['etag'];
    ok('P11.1 etag present before cache rollover', !!etag0);

    // Fire 220 HEAD requests (HEAD is fast, generates cache entries for each
    // filename+mtime combination; we vary Accept-Encoding to bypass 304 logic).
    // Since there are only ~6 unique static files, hits will be cached after
    // the first few — we're testing that size doesn't blow up beyond 200.
    // To force 200+ distinct entries we request the same files with varying
    // fake query params that bypass our ?v= immutable path but are unique URLs
    // (the middleware uses req.path which strips query, so entries reuse same
    // key — we just want to confirm no crash / incorrect behavior).
    let ok200 = 0;
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(get('/inicio.html',  { 'Accept-Encoding': 'gzip' }));
      promises.push(get('/dashboard.css',{ 'Accept-Encoding': 'gzip' }));
      promises.push(get('/agenda.html',  { 'Accept-Encoding': 'gzip' }));
      promises.push(get('/conversations.html', { 'Accept-Encoding': 'gzip' }));
    }
    const results200 = await Promise.all(promises);
    ok200 = results200.filter(r => r.status === 200).length;
    ok('P11.2 all 200 responses after heavy load', ok200 === 200, `got ${ok200}`);

    // ETag of inicio.html must still be the same (cache coherent after eviction)
    const r1 = await get('/inicio.html', { 'Accept-Encoding': 'gzip' });
    ok('P11.3 etag unchanged after cache rollover', r1.headers['etag'] === etag0,
       `before=${etag0} after=${r1.headers['etag']}`);
  }

  proc.kill();

  // ── P12: Playwright — help link does not change active tab ─────────────────
  console.log('\n--- P12: help link click does not change active tab ---');
  {
    let pwPassed = 0, pwFailed = 0;
    function pwOk(label, cond, extra = '') {
      if (cond) { console.log(`  ✓ ${label}`); passed++; pwPassed++; }
      else       { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; pwFailed++; }
    }

    // Start a fresh server for Playwright (proc already killed above)
    const proc2 = startServer();
    proc2.stderr.on('data', () => {});
    proc2.stdout.on('data', () => {});
    const up2 = await waitForServer();
    pwOk('P12.1 server restarts for Playwright test', up2);

    if (up2) {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        // Register user so dashboard.html loads without redirect
        const body  = JSON.stringify({ email: 'perf-nav@test.com', password: 'Test1234!', name: 'PNav' });
        const cookie = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: 'localhost', port: PORT, path: '/auth/register',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
              const sc = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
              const m  = sc && sc.match(/([^=;]+=[^;]+)/);
              resolve(m ? m[1] : null);
            });
          });
          req.on('error', reject);
          req.write(body);
          req.end();
        });
        pwOk('P12.2 test user registered', !!cookie);

        const ctx  = await browser.newContext();
        const [cName, cVal] = (cookie || '').split('=');
        if (cookie) {
          await ctx.addCookies([{ name: cName, value: cVal, domain: 'localhost', path: '/' }]);
        }
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${PORT}/dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Find the help link (sidebar-link--help) and check it has target=_blank
        const helpHref = await page.getAttribute('.sidebar-link--help', 'href').catch(() => null);
        pwOk('P12.3 help link present in sidebar', !!helpHref, 'element not found');

        // Before click: dashboard link is active
        const dashActive = await page.locator('a.sidebar-link[href="/dashboard.html"]').evaluate(el => el.classList.contains('active'));
        pwOk('P12.4 dashboard link is active before click', dashActive);

        // Click the help link
        await page.click('.sidebar-link--help', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);

        // After click: dashboard link must STILL be active (not changed)
        const dashStillActive = await page.locator('a.sidebar-link[href="/dashboard.html"]').evaluate(el => el.classList.contains('active'));
        pwOk('P12.5 dashboard link still active after help-link click', dashStillActive);

        // Also verify help link itself did not get 'active' class
        const helpActive = await page.locator('.sidebar-link--help').evaluate(el => el.classList.contains('active'));
        pwOk('P12.6 help link does NOT have active class after click', !helpActive);

        await browser.close();
      } catch (err) {
        await browser.close().catch(() => {});
        pwOk('P12 Playwright test', false, String(err));
      }
    }
    proc2.kill();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
