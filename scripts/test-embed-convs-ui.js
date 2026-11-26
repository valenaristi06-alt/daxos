'use strict';
// Embed conversations in a real browser: before connecting WhatsApp only the 3 steps
// show; after, the chat list is the main view and refreshes by itself when a message
// arrives (no reload). Run: node scripts/test-embed-convs-ui.js
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const PORT = 3132, DB_DIR = '/tmp/test-embed-convs-ui', KEY = 'ui-key';
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
let srv = null, passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (l, c) => { if (c) { console.log('  ✓ ' + l); passed++; } else { console.error('  ✗ ' + l); failed++; } };
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  srv = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 's', PARTNER_CRM_KEY: KEY,
      PARTNER_EMBED_ORIGINS: 'https://pupi-pi.vercel.app', APP_URL: `http://localhost:${PORT}`, NODE_ENV: '', RAILWAY_ENVIRONMENT: '' } });
  for (let i = 0; i < 40; i++) { try { await req('GET', '/health'); break; } catch { await sleep(500); } }
  await req('POST', '/api/partner/businesses', { crm_user_id: 'ui_1', name: 'UI', email: 'ui@t.com' });
  const browser = await chromium.launch({ headless: true });
  const open = async () => {
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: 'ui_1', mode: 'embed' });
    const page = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
    await page.route('**/connect.facebook.net/**', r => r.abort());
    await page.goto(ll.url);
    return page;
  };

  console.log('Before connecting WhatsApp');
  let page = await open();
  await page.waitForSelector('#embed-steps:not([hidden])', { timeout: 10000 });
  ok('3 steps shown', await page.isVisible('#step-1') && await page.isVisible('#step-3'));
  ok('no conversations view, no back link', !(await page.isVisible('#embed-convs')) && !(await page.isVisible('#btn-back-convs')));
  ok('connect button shown', await page.isVisible('#btn-wa-connect'));

  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  const biz = db.prepare("SELECT id FROM businesses WHERE crm_user_id='ui_1'").get().id;
  db.prepare("UPDATE businesses SET phone_number_id='pn-ui' WHERE id=?").run(biz);
  const c1 = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)').run(biz, '59899000111').lastInsertRowid;
  db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'hola')").run(c1);

  console.log('After connecting');
  page = await open();
  await page.waitForSelector('#embed-convs:not([hidden]) .conv-item', { timeout: 10000 });
  ok('conversation list is the main view', !(await page.isVisible('#embed-steps')));
  ok('"Ajustes del asistente" link shown', await page.isVisible('#btn-open-settings'));
  await page.click('.conv-item');
  await page.waitForSelector('.msg--in');
  ok('mobile: chat opens full width (list hidden)', !(await page.isVisible('#conv-list')));

  // New message in the open chat + a new chat waiting for attention, no reload.
  db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', '¿tienen envío?')").run(c1);
  const c2 = db.prepare('INSERT INTO conversations (business_id, customer_id, needs_attention, paused_reason) VALUES (?, ?, 1, ?)').run(biz, '59899000222', 'keyword').lastInsertRowid;
  db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'quiero hablar con alguien')").run(c2);
  const got = await page.waitForSelector('.msg--in >> text=¿tienen envío?', { timeout: 9000 }).then(() => true).catch(() => false);
  ok('open chat shows the new message by itself', got);
  await page.click('#thread-back');
  const first = await page.locator('.conv-item').first().innerText();
  ok('new waiting chat appears by itself, first and marked', first.includes('99 000 222') && first.includes('Te espera'));

  await page.click('.conv-item:has-text("000 111")');
  await page.click('#btn-take');
  await page.waitForSelector('#thread-banner:not([hidden])');
  ok('"Atiendo yo" → banner + reactivate button', (await page.innerText('#btn-banner-action')) === 'Reactivar asistente');
  await page.click('#btn-banner-action');
  await page.waitForSelector('#btn-take:not([hidden])');
  ok('reactivate → bot back on in that chat', db.prepare('SELECT needs_attention FROM conversations WHERE id=?').get(c1).needs_attention === 0);

  await page.click('#btn-open-settings');
  ok('settings show the 3 steps with back link', await page.isVisible('#step-3') && await page.isVisible('#btn-back-convs'));
  ok('step 3 has no bar, percent or counts', !(await page.innerText('#step-3')).match(/\d+\s*%|conversaciones|de tu plan este mes/i) || false);
  db.close();
  await browser.close();
  console.log(`\nEmbed conversations UI — ${passed} passed, ${failed} failed`);
  srv.kill('SIGTERM'); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); if (srv) srv.kill(); process.exit(1); });
