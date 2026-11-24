'use strict';
/**
 * Capturas del modo embed (/embed) con la estética de Pupi: los 3 pasos en
 * computadora y celular. Capturas → /tmp/embed-shots/
 * Run: node scripts/screenshot-embed.js
 */
const path = require('path');
const fs   = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const TEST_PORT = 3129;
const DB_DIR    = '/tmp/screenshot-embed';
const BASE      = `http://localhost:${TEST_PORT}`;
const SHOTS_DIR = '/tmp/embed-shots';
const WORKTREE  = path.join(__dirname, '..');
const PARTNER_KEY = 'shot-partner-key';

fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });
let serverProc = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(500); }
  return false;
}

async function main() {
  serverProc = spawn('node', ['src/server.js'], {
    cwd: WORKTREE,
    env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 'shot-secret',
      PARTNER_CRM_KEY: PARTNER_KEY, PARTNER_EMBED_ORIGINS: 'https://pupi-pi.vercel.app', PARTNER_NAME: 'Pupi',
      APP_URL: BASE, NODE_ENV: '', RAILWAY_ENVIRONMENT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', d => { const s = String(d); if (/error|Error/.test(s)) process.stderr.write(s); });
  if (!(await waitForServer())) throw new Error('server did not start');
  await sleep(300);

  const bearer = { headers: { Authorization: `Bearer ${PARTNER_KEY}` } };
  await req('POST', '/api/partner/businesses', { crm_user_id: 'shot_1', name: 'Café Luna', email: 'cafe@shot.com' }, bearer);
  // Dale un tope de gasto para que se vea la barra de dólares en el paso 3.
  await req('POST', '/api/partner/businesses/quota', { crm_user_id: 'shot_1', conv_cap: 700, spend_cap_usd: 14 }, bearer);

  // Algo de uso del mes para que las barras no estén en cero.
  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  const bizId = db.prepare("SELECT id FROM businesses WHERE crm_user_id='shot_1'").get().id;
  const convIns = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)');
  const msgIns = db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hola', datetime('now'))");
  for (let i = 0; i < 180; i++) { const c = convIns.run(bizId, '5989' + i).lastInsertRowid; msgIns.run(c); }
  // Uso moderado: ~US$7.6 sobre un tope de US$14 → ~55% (el dueño ve solo el %, nunca el monto).
  db.prepare("INSERT INTO claude_usage (business_id, model, input_tokens, output_tokens, tts_chars, created_at) VALUES (?, 'm', 1200000, 150000, 10000, datetime('now'))").run(bizId);
  db.pragma('wal_checkpoint(FULL)');
  db.close();

  const browser = await chromium.launch({ headless: true });

  async function shoot(name, w, h) {
    const ll = await req('POST', '/api/partner/login-link',
      { crm_user_id: 'shot_1', mode: 'embed', theme: {} }, bearer);
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    // Bloquear el SDK de Facebook (red externa) para que no demore la captura.
    await page.route('**/connect.facebook.net/**', r => r.abort());
    await page.goto(ll.body.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#embed-steps:not([hidden])', { timeout: 10000 });
    await page.waitForSelector('.cfg-ta', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    const file = path.join(SHOTS_DIR, name);
    await page.screenshot({ path: file, fullPage: true });
    console.log('  📸 ' + file);
    await ctx.close();
  }

  console.log('--- Capturas embed ---');
  await shoot('embed-compu.png', 1000, 1000);
  await shoot('embed-celu.png', 390, 1200);

  await browser.close();
  console.log('Capturas en /tmp/embed-shots/:');
  fs.readdirSync(SHOTS_DIR).sort().forEach(f => console.log('  ' + path.join(SHOTS_DIR, f)));
}

main()
  .catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; })
  .finally(() => { if (serverProc) serverProc.kill('SIGTERM'); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {} });
