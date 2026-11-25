'use strict';
// Capturas de la landing (/) con los cambios de agenda, en compu y celular.
// Capturas → /tmp/landing-shots/
const path = require('path');
const fs   = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');

const TEST_PORT = 3139;
const DB_DIR    = '/tmp/screenshot-landing';
const BASE      = `http://localhost:${TEST_PORT}`;
const SHOTS_DIR = '/tmp/landing-shots';
const WORKTREE  = path.join(__dirname, '..');

fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });
let serverProc = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method: 'GET' }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject); r.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if (await get('/health') === 200) return true; } catch {} await sleep(500); }
  return false;
}

async function main() {
  serverProc = spawn('node', ['src/server.js'], {
    cwd: WORKTREE,
    env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 'shot', NODE_ENV: '', RAILWAY_ENVIRONMENT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', d => { const s = String(d); if (/Error/.test(s)) process.stderr.write(s); });
  if (!(await waitForServer())) throw new Error('server did not start');
  await sleep(300);

  const browser = await chromium.launch({ headless: true });

  for (const vp of [{ name: 'compu', w: 1280, h: 900 }, { name: 'celu', w: 390, h: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await sleep(500);
    // Full page
    await page.screenshot({ path: path.join(SHOTS_DIR, `landing-${vp.name}-full.png`), fullPage: true });
    console.log('  📸 landing-' + vp.name + '-full.png');
    // Bloque agenda
    const ag = await page.$('.agenda-section');
    if (ag) { await ag.scrollIntoViewIfNeeded(); await sleep(200); await ag.screenshot({ path: path.join(SHOTS_DIR, `agenda-${vp.name}.png`) }); console.log('  📸 agenda-' + vp.name + '.png'); }
    // Planes
    const pr = await page.$('.pricing-section');
    if (pr) { await pr.scrollIntoViewIfNeeded(); await sleep(200); await pr.screenshot({ path: path.join(SHOTS_DIR, `planes-${vp.name}.png`) }); console.log('  📸 planes-' + vp.name + '.png'); }
    await ctx.close();
  }

  await browser.close();
  console.log('Capturas en /tmp/landing-shots/:');
  fs.readdirSync(SHOTS_DIR).sort().forEach(f => console.log('  ' + path.join(SHOTS_DIR, f)));
}

main().catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; })
  .finally(() => { if (serverProc) serverProc.kill('SIGTERM'); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {} });
