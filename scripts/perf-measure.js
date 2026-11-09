#!/usr/bin/env node
'use strict';
/**
 * Playwright CDP performance measurement — before vs after perf-tabs.
 * Metric: "time to main content visible" (not DOMContentLoaded).
 * Network: 140ms RTT latency + 10 Mbps (emulated via CDP).
 * Runs: 5 per page per cache state; reports median.
 *
 * Content-visible selectors per page:
 *   inicio        → #inicio-headline has non-empty text
 *   conversations → #conv-skeleton hidden (list or empty state ready)
 *   dashboard     → #form visible (business data loaded)
 *   agenda        → one of #view-upsell/#view-disabled/#view-no-hours/#view-agenda visible
 *
 * Usage:
 *   node scripts/perf-measure.js                      # current build (after)
 *   BASELINE_DIR=/tmp/daxos-baseline node scripts/perf-measure.js  # before + after
 */

const { chromium } = require('playwright');
const http  = require('http');
const { spawn, execSync } = require('child_process');
const fs    = require('fs');
const path  = require('path');

process.chdir(path.join(__dirname, '..'));

const PORT_AFTER  = 3250;
const PORT_BEFORE = 3251;
const DB_AFTER    = '/tmp/test-perf-after';
const DB_BEFORE   = '/tmp/test-perf-before';

const NETWORK = {
  offline:            false,
  downloadThroughput: 10 * 1024 * 1024 / 8,  // 10 Mbps
  uploadThroughput:   10 * 1024 * 1024 / 8,
  latency:            140,
};

const PAGES = [
  {
    path:    '/inicio.html',
    label:   'Inicio',
    waitFn:  "document.getElementById('inicio-headline')?.textContent?.trim().length > 0",
  },
  {
    path:    '/conversations.html',
    label:   'Conversaciones',
    // skeleton hidden = list or empty-state ready
    waitFn:  "!document.getElementById('conv-skeleton') || document.getElementById('conv-skeleton').style.display === 'none' || getComputedStyle(document.getElementById('conv-skeleton')).display === 'none'",
  },
  {
    path:    '/dashboard.html',
    label:   'Panel',
    // form becomes visible when business data loads (starts display:none)
    waitFn:  "document.getElementById('form') && document.getElementById('form').style.display !== 'none' && getComputedStyle(document.getElementById('form')).display !== 'none'",
  },
  {
    path:    '/agenda.html',
    label:   'Agenda',
    // one of the main views is visible
    waitFn:  "['view-upsell','view-disabled','view-no-hours','view-agenda','view-error'].some(id => { const el = document.getElementById(id); return el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none'; })",
  },
];

const RUNS = 5;

function mkdb(dir) {
  try { execSync(`rm -rf ${dir}`); } catch (_) {}
  fs.mkdirSync(dir, { recursive: true });
}

function startServer(cwd, port, dbDir) {
  mkdb(dbDir);
  return spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), DB_DIR: dbDir, SESSION_SECRET: `sec-${port}`, RAILWAY_ENVIRONMENT: '', NODE_ENV: 'test' },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForServer(port) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const iv = setInterval(() => {
      n++;
      http.get(`http://localhost:${port}/health`, r => { if (r.statusCode === 200) { clearInterval(iv); resolve(); } r.resume(); }).on('error', () => {});
      if (n > 60) { clearInterval(iv); reject(new Error(`server on ${port} did not start`)); }
    }, 300);
  });
}

function apiReq(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

async function setupUser(port) {
  const email = `perf_${port}_${Date.now()}@test.com`;
  const r = await apiReq(port, 'POST', '/auth/register', { email, password: 'PerfTest123!', name: 'PerfUser' });
  if (r.status !== 200) throw new Error(`register failed on port ${port}: ${r.body}`);
  const sc = Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie'];
  const m  = sc && sc.match(/([^=;]+=[^;]+)/);
  if (!m) throw new Error('no session cookie');
  const cookie = m[1];
  await apiReq(port, 'PUT', '/api/business', { name: 'PerfBiz' }, { Cookie: cookie });
  return cookie;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

async function measurePage(page, cdpSession, port, pg) {
  await cdpSession.send('Network.clearBrowserCache');
  const cold_times = [];
  const warm_times = [];

  for (let i = 0; i < RUNS; i++) {
    // cold: clear cache each time
    await cdpSession.send('Network.clearBrowserCache');
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}${pg.path}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(pg.waitFn, { timeout: 10000 });
    cold_times.push(Date.now() - t0);

    // warm: re-navigate without clearing cache
    const t1 = Date.now();
    await page.goto(`http://localhost:${port}${pg.path}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(pg.waitFn, { timeout: 10000 });
    warm_times.push(Date.now() - t1);
  }

  return {
    label:        pg.label,
    cold_median:  median(cold_times),
    warm_median:  median(warm_times),
    cold_all:     cold_times,
    warm_all:     warm_times,
  };
}

async function runMeasurements(port, cookie) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  const page       = await context.newPage();
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.emulateNetworkConditions', NETWORK);

  const results = [];
  for (const pg of PAGES) {
    const r = await measurePage(page, cdpSession, port, pg);
    results.push(r);
  }
  await browser.close();
  return results;
}

function printTable(before, after) {
  const W = 72;
  console.log('\n' + '─'.repeat(W));
  console.log('  Tiempo hasta contenido principal visible (ms, mediana de 5 corridas)');
  console.log('  Red emulada: 140ms RTT · 10 Mbps · localhost — NO es producción');
  console.log('─'.repeat(W));
  console.log(`  ${'Página'.padEnd(16)} ${'Caché'.padEnd(6)} ${'origin/main'.padStart(12)} ${'perf-tabs'.padStart(10)} ${'Δ'.padStart(8)} ${'%'.padStart(6)}`);
  console.log('  ' + '─'.repeat(16) + ' ' + '─'.repeat(6) + ' ' + '─'.repeat(12) + ' ' + '─'.repeat(10) + ' ' + '─'.repeat(8) + ' ' + '─'.repeat(6));

  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    const b = before ? before[i] : null;
    for (const type of ['cold', 'warm']) {
      const aVal = a[`${type}_median`];
      const bVal = b ? b[`${type}_median`] : null;
      const delta = bVal != null ? aVal - bVal : null;
      const pct   = bVal != null ? ((aVal - bVal) / bVal * 100).toFixed(0) : null;
      const deltaStr = delta != null ? (delta > 0 ? `+${delta}` : String(delta)) : '—';
      const pctStr   = pct   != null ? (pct   > 0 ? `+${pct}%`  : `${pct}%`)  : '—';
      const bStr = bVal != null ? String(bVal) : '—';
      console.log(`  ${a.label.padEnd(16)} ${type.padEnd(6)} ${bStr.padStart(12)} ${String(aVal).padStart(10)} ${deltaStr.padStart(8)} ${pctStr.padStart(6)}`);
    }
  }
  console.log('─'.repeat(W));
  console.log('  DATO medido en localhost con latencia emulada — no extrapolable a producción directamente.');
  console.log('  Mejoras reales en prod esperadas en la misma dirección pero distintas magnitudes.');
}

async function main() {
  const baselineDir = process.env.BASELINE_DIR;
  const afterDir    = path.join(__dirname, '..');

  // Start after server
  console.log('Iniciando servidor after (feature/perf-tabs)...');
  const afterProc = startServer(afterDir, PORT_AFTER, DB_AFTER);
  afterProc.stderr.on('data', () => {});
  afterProc.stdout.on('data', () => {});

  // Start before server if baseline dir given
  let beforeProc = null;
  if (baselineDir) {
    console.log(`Iniciando servidor before (${baselineDir})...`);
    beforeProc = startServer(baselineDir, PORT_BEFORE, DB_BEFORE);
    beforeProc.stderr.on('data', () => {});
    beforeProc.stdout.on('data', () => {});
  }

  try {
    await waitForServer(PORT_AFTER);
    if (baselineDir) await waitForServer(PORT_BEFORE);

    const afterCookie  = await setupUser(PORT_AFTER);
    const beforeCookie = baselineDir ? await setupUser(PORT_BEFORE) : null;

    console.log(`Midiendo (${RUNS} corridas por página por caché)...\n`);

    const afterResults  = await runMeasurements(PORT_AFTER,  afterCookie);
    const beforeResults = baselineDir ? await runMeasurements(PORT_BEFORE, beforeCookie) : null;

    printTable(beforeResults, afterResults);

  } finally {
    afterProc.kill();
    if (beforeProc) beforeProc.kill();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
