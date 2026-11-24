'use strict';
/**
 * Configurador — micrófono dentro de la caja (MediaRecorder, sin deps nuevas).
 * Tests + capturas (computadora y celular) de: caja vacía, grabando, "Escuchando tu audio…".
 * Usa mic falso de Chromium (--use-fake-device-for-media-stream).
 * Capturas → /tmp/config-mic-shots/
 *
 * Run: node scripts/test-config-mic.js
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const TEST_PORT = 3271;
const DB_DIR    = '/tmp/test-config-mic';
const BASE      = `http://localhost:${TEST_PORT}`;
const SHOTS_DIR = '/tmp/config-mic-shots';
const WORKTREE  = path.join(__dirname, '..');

const VIEWPORTS = [
  { name: 'compu', w: 1280, h: 900 },
  { name: 'celu',  w: 390,  h: 844 },
];

fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });

let serverProc = null;
let passed = 0, failed = 0;
let userEmail = '';
const userPass = 'MicPass1!';

function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {}
    await sleep(500);
  }
  return false;
}

function startServer() {
  return spawn('node', ['src/server.js'], {
    cwd: WORKTREE,
    env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 'mic-test-secret', NODE_ENV: '', RAILWAY_ENVIRONMENT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function setup() {
  serverProc = startServer();
  if (!(await waitForServer())) throw new Error('Server did not start');
  await sleep(300);

  userEmail = `mic-${Date.now()}@t.com`;
  const r1 = await req('POST', '/auth/register', { email: userEmail, password: userPass });
  const cookie = r1.headers['set-cookie']?.[0]?.split(';')[0];
  if (!cookie) throw new Error('No cookie from register');

  // Business with name only → `configured` stays false → chat opens on the intro (empty box).
  await req('PUT', '/api/business', { name: 'Negocio Mic Test' }, { cookie });

  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  db.prepare("UPDATE businesses SET config_chat_enabled = 1 WHERE name = 'Negocio Mic Test'").run();
  db.close();
}

async function loginPage(browser, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', userEmail);
  await page.fill('#password', userPass);
  await page.click('button[type=submit]');
  await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
  await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#config-chat', { state: 'visible', timeout: 8000 });
  await page.waitForSelector('.cfg-ta', { timeout: 8000 });
  await sleep(300);
  return { page, ctx };
}

async function shoot(page, name) {
  const elh = await page.$('#config-chat');
  const file = path.join(SHOTS_DIR, name);
  if (elh) await elh.screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log(`  📸 ${file}`);
}

async function main() {
  console.log('\n--- Setup ---');
  await setup();
  console.log(`  ✓ server ready (${userEmail})`);

  // Fake mic so getUserMedia + MediaRecorder actually produce audio in headless Chromium.
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });

  let staticAsserted = false;

  for (const vp of VIEWPORTS) {
    console.log(`\n--- ${vp.name} (${vp.w}x${vp.h}) ---`);
    const { page, ctx } = await loginPage(browser, vp.w, vp.h);

    // ── Estado inicial: caja vacía ──
    const info = await page.evaluate(() => {
      const ta = document.querySelector('.cfg-ta');
      const chips = Array.from(document.querySelectorAll('.cfg-btn-row .cfg-chip')).map(c => c.textContent.trim());
      return {
        title: (document.getElementById('cfg-chat-title') || {}).textContent || '',
        sub: (document.querySelector('.cfg-chat-sub') || {}).textContent || '',
        placeholder: ta ? ta.getAttribute('placeholder') : null,
        micInBox: !!document.querySelector('.cfg-ta-wrap .cfg-mic'),
        chips,
      };
    });

    if (!staticAsserted) {
      ok('título = "Armá tu asistente hablando"', info.title.trim() === 'Armá tu asistente hablando', `got "${info.title}"`);
      ok('subtítulo presente con instrucciones', /No cambia nada hasta que toques Aplicar/.test(info.sub), info.sub.slice(0, 40));
      ok('placeholder correcto', info.placeholder === 'Escribí acá o tocá el micrófono para contármelo en un audio', `got "${info.placeholder}"`);
      ok('micrófono dentro de la caja', info.micInBox);
      ok('chip "Pegar mi web" presente', info.chips.includes('Pegar mi web'), info.chips.join(','));
      ok('chip "Subir capturas" presente', info.chips.includes('Subir capturas'), info.chips.join(','));
      ok('chip "Mandar audio" eliminado', !info.chips.includes('Mandar audio'), info.chips.join(','));
      staticAsserted = true;
    }
    await shoot(page, `caja-vacia-${vp.name}.png`);

    // ── Grabando ──
    await page.click('.cfg-mic');
    await page.waitForSelector('.cfg-rec', { timeout: 5000 });
    const rec = await page.evaluate(() => ({
      dot: !!document.querySelector('.cfg-rec-dot'),
      time: (document.querySelector('.cfg-rec-time') || {}).textContent || '',
      stop: !!document.querySelector('.cfg-rec-stop'),
    }));
    ok(`${vp.name}: barra de grabación con punto rojo`, rec.dot);
    ok(`${vp.name}: contador de tiempo visible`, /^\d+:\d\d$/.test(rec.time), `got "${rec.time}"`);
    ok(`${vp.name}: botón Detener visible`, rec.stop);
    await sleep(1100); // deja correr el contador para la captura
    await shoot(page, `grabando-${vp.name}.png`);

    // ── "Escuchando tu audio…" (stall del ingest para capturarlo) ──
    await page.route('**/api/config-chat/ingest', async route => { await sleep(4000); route.abort(); });
    await page.click('.cfg-rec-stop');
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('.cfg-bub')).some(b => b.textContent.includes('Escuchando tu audio')),
      { timeout: 8000 },
    );
    ok(`${vp.name}: muestra "Escuchando tu audio…" tras frenar`, true);
    await shoot(page, `escuchando-${vp.name}.png`);
    await page.unroute('**/api/config-chat/ingest');

    await ctx.close();
  }

  // ── Permiso de micrófono denegado ──
  console.log('\n--- Permiso denegado ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      // Forzar rechazo de getUserMedia para probar el mensaje de ayuda.
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      }
    });
    await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#email', userEmail);
    await page.fill('#password', userPass);
    await page.click('button[type=submit]');
    await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
    await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cfg-mic', { timeout: 8000 });
    await page.click('.cfg-mic');
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('.cfg-bub')).some(b => b.textContent.includes('Activá el micrófono en tu navegador')),
      { timeout: 6000 },
    ).then(() => ok('mic denegado → muestra mensaje de ayuda', true))
     .catch(() => ok('mic denegado → muestra mensaje de ayuda', false, 'no apareció el mensaje'));
    await ctx.close();
  }

  // ── Chequeo estático: tope de 3 min + MediaRecorder sin deps ──
  console.log('\n--- Código ---');
  {
    const js = fs.readFileSync(path.join(WORKTREE, 'public/js/config-chat.js'), 'utf8');
    ok('usa MediaRecorder del navegador', /new MediaRecorder\(/.test(js));
    ok('tope de grabación 3 minutos', /REC_MAX_MS\s*=\s*3\s*\*\s*60\s*\*\s*1000/.test(js));
    ok('sin "Mandar audio" en el JS', !/Mandar audio/.test(js));
  }

  await browser.close();

  console.log('\n================================================================');
  console.log(`${passed + failed} checks — ${passed} passed, ${failed} failed`);
  console.log('================================================================');
  console.log('Capturas en /tmp/config-mic-shots/:');
  fs.readdirSync(SHOTS_DIR).sort().forEach(f => console.log('  ' + path.join(SHOTS_DIR, f)));
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; })
  .finally(() => {
    if (serverProc) serverProc.kill('SIGTERM');
    try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  });
