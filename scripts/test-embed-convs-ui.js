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
  const firstDot = await page.locator('.conv-item').first().locator('.conv-dot').count();
  ok('new waiting chat appears by itself, first and marked', first.includes('99 000 222') && firstDot === 1);

  await page.click('.conv-item:has-text("000 111")');
  await page.waitForSelector('#btn-main-action:not([hidden])');
  ok('main button says "Atiendo yo"', (await page.innerText('#btn-main-action')) === 'Atiendo yo');
  await page.click('#btn-main-action');
  await page.waitForSelector('#btn-main-action:has-text("Reactivar asistente")');
  ok('"Atiendo yo" → same button becomes "Reactivar asistente"', db.prepare('SELECT needs_attention FROM conversations WHERE id=?').get(c1).needs_attention === 1);
  await page.click('#btn-main-action');
  await page.waitForSelector('#btn-main-action:has-text("Atiendo yo")');
  ok('reactivate → bot back on in that chat', db.prepare('SELECT needs_attention FROM conversations WHERE id=?').get(c1).needs_attention === 0);

  // Search + filter
  await page.click('#thread-back');
  await page.fill('#conv-search', '000 222');
  await page.waitForTimeout(150);
  ok('search finds by number', (await page.locator('.conv-item').count()) === 1);
  await page.fill('#conv-search', '');
  await page.click('#btn-filter');
  await page.click('#filter-pop [data-kind="waiting"]');
  ok('filter "Te esperan" shows only waiting chats', (await page.locator('.conv-item').count()) === 1 && (await page.innerText('.conv-item')).includes('000 222'));
  await page.click('#btn-filter');
  await page.click('#filter-pop [data-kind="all"][data-tag=""]');
  // ⋯ menu: tag the chat, then delete it
  await page.click('.conv-item:has-text("000 111")');
  await page.waitForSelector('.msg--in');
  await page.click('#btn-more');
  const moreText = await page.innerText('#more-pop');
  ok('⋯ menu has the rest of the functions', ['Etiquetas', 'Tipo de contacto', 'Descargar archivos', 'Copiar número', 'Borrar chat'].every(t => moreText.includes(t)));
  await page.click('#more-pop [data-act="tags"]');
  await page.fill('#new-tag-name', 'VIP');
  await page.click('#tags-save');
  await page.waitForSelector('.conv-item.is-open .tag-dot', { timeout: 6000, state: 'attached' });
  ok('new tag created and shown as a dot in the list', db.prepare("SELECT COUNT(*) n FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=? AND t.name='VIP'").get(c1).n === 1);
  await page.click('#btn-more');
  await page.click('#more-pop [data-act="label"]');
  await page.check('input[name="conv-label"][value="cliente"]');
  await page.click('#label-save');
  await page.waitForTimeout(500);
  ok('tipo de contacto saved', db.prepare('SELECT label FROM conversations WHERE id=?').get(c1).label === 'cliente');
  await page.click('#thread-back');

  // Más ajustes: saving one section keeps the rest of the profile
  db.prepare("UPDATE businesses SET business_context='Pastelería', business_hours=?, pause_keywords='persona' WHERE id=?").run(JSON.stringify({ 1: [['09:00', '18:00']] }), biz);
  await page.click('#btn-open-settings');
  await page.waitForSelector('#more-list details[data-sec="biz"]');
  await page.click('#more-list details[data-sec="biz"] summary');
  await page.fill('#s-pricing', 'Torta $1.450');
  await page.click('#save-biz');
  await page.waitForSelector('#save-biz-status:has-text("Guardado")', { timeout: 6000 });
  const after = db.prepare('SELECT pricing_info, business_context, business_hours, pause_keywords FROM businesses WHERE id=?').get(biz);
  ok('settings: price saved', after.pricing_info === 'Torta $1.450');
  ok('settings: other fields untouched', after.business_context === 'Pastelería' && after.pause_keywords === 'persona' && after.business_hours.includes('09:00'));
  await page.click('#more-list details[data-sec="alerts"] summary');
  await page.fill('#s-ownerphone', '099123456');
  await page.click('#save-alerts');
  await page.waitForSelector('#save-alerts-status:has-text("Guardado")', { timeout: 6000 });
  ok('settings: owner phone saved through the embed token', !!db.prepare('SELECT phone FROM users WHERE business_id=?').get(biz)?.phone);
  await page.click('#btn-back-convs');
  await page.waitForSelector('#embed-convs:not([hidden])');

  // Agenda (plan crm): even with agenda_access = paid, crm keeps access.
  db.prepare("INSERT OR REPLACE INTO runtime_config (key, value) VALUES ('agenda_access', 'paid')").run();
  db.prepare('UPDATE businesses SET business_hours=? WHERE id=?')
    .run(JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [['08:00', '22:00']]]))), biz);
  await page.click('#btn-open-settings');
  await page.waitForSelector('#agenda-card:not([hidden]) #ag-enabled', { state: 'attached' });
  await page.click('#agenda-body details[data-sec="ag-services"] summary');
  await page.fill('#ag-svc-name', 'Corte');
  await page.click('[data-ag="add-svc"]');
  await page.waitForSelector('#agenda-body .ex-row:has-text("Corte")');
  ok('agenda: service created from the embed (crm plan)', db.prepare('SELECT COUNT(*) n FROM agenda_services WHERE business_id=? AND active=1').get(biz).n === 1);
  await page.click('#agenda-body .set-switch .slider');
  await page.waitForSelector('[data-ag="open-new"]', { timeout: 6000 });
  ok('agenda: turned on', db.prepare('SELECT agenda_enabled FROM businesses WHERE id=?').get(biz).agenda_enabled === 1);
  await page.click('[data-ag="open-new"]');
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date(Date.now() + 86400000));
  await page.fill('#ag-phone', '099111222');
  await page.fill('#ag-name', 'Carla');
  await page.fill('#ag-date', tomorrow);
  await page.dispatchEvent('#ag-date', 'change');
  await page.waitForFunction(() => { const s = document.getElementById('ag-time'); return s && s.value && /^\d\d:\d\d$/.test(s.value); }, null, { timeout: 6000 });
  await page.click('[data-ag="create"]');
  await page.waitForSelector('.ag-appt:has-text("Carla")', { timeout: 6000 });
  const apt = db.prepare("SELECT id, status FROM agenda_appointments WHERE business_id=? AND client_name='Carla'").get(biz);
  ok('agenda: appointment created and listed', apt && apt.status === 'confirmed');
  await page.click('.ag-appt:has-text("Carla") [data-ag="ask-cancel"]');
  await page.click('[data-ag="cancel"]');
  await page.waitForSelector('#ag-status:has-text("cancelado")', { timeout: 6000 });
  ok('agenda: appointment cancelled', db.prepare('SELECT status FROM agenda_appointments WHERE id=?').get(apt.id).status === 'cancelled');
  await page.click('#btn-back-convs');
  await page.waitForSelector('#embed-convs:not([hidden])');

  await page.click('#btn-open-settings');
  ok('settings show the 3 steps with back link', await page.isVisible('#step-3') && await page.isVisible('#btn-back-convs'));
  ok('step 3 has no bar, percent or counts', !(await page.innerText('#step-3')).match(/\d+\s*%|conversaciones|de tu plan este mes/i) || false);
  db.close();
  await browser.close();
  console.log(`\nEmbed conversations UI — ${passed} passed, ${failed} failed`);
  srv.kill('SIGTERM'); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); if (srv) srv.kill(); process.exit(1); });
