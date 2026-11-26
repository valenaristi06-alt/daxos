#!/usr/bin/env node
'use strict';
// When the owner creates / moves / cancels an appointment, the client gets a WhatsApp
// notice — and when it cannot go out (24 h window, Meta rejects it, Baileys), the owner
// is always told, with the exact text to send by hand. Never silent.
// Run: node scripts/test-agenda-notice.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const Database = require('better-sqlite3');

const PORT = 3135, META_PORT = 3136, KEY = 'notice-key';
const DB_DIR = '/tmp/test-agenda-notice';
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
let srv = null, meta = null, passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (l, c, x = '') => { if (c) { console.log('  ✓ ' + l); passed++; } else { console.error('  ✗ ' + l + (x ? ' — ' + x : '')); failed++; } };
function cleanup() { if (srv) srv.kill('SIGTERM'); if (meta) meta.close(); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {} }

const sent = []; // { to, text }
const REJECT = '59899000333';
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json', ...headers };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method, headers: h }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let b = d; try { b = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  meta = http.createServer((q, s) => {
    let body = ''; q.on('data', d => body += d);
    q.on('end', () => {
      let b = {}; try { b = JSON.parse(body); } catch {}
      if (b.to === REJECT) { s.writeHead(400, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } })); }
      if (b.type === 'text') sent.push({ to: b.to, text: b.text.body });
      s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"messages":[{"id":"w"}]}');
    });
  }).listen(META_PORT);

  srv = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 's', PARTNER_CRM_KEY: KEY, NODE_ENV: 'test',
      RAILWAY_ENVIRONMENT: '', META_GRAPH_BASE_URL: `http://localhost:${META_PORT}`, BAILEYS_ENABLED: '', APP_URL: `http://localhost:${PORT}` } });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  for (let i = 0; i < 40 && !out.includes('Server running'); i++) await sleep(500);
  await sleep(300);

  const bearer = { Authorization: `Bearer ${KEY}` };
  await req('POST', '/api/partner/businesses', { crm_user_id: 'n1', name: 'Turnos', email: 'n1@t.com' }, bearer);
  await req('POST', '/api/partner/businesses', { crm_user_id: 'n2', name: 'Otro', email: 'n2@t.com' }, bearer);
  const embedFor = async (id) => {
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: id, mode: 'embed' }, bearer);
    const ex = await req('POST', '/api/embed/session', { token: new URL(ll.body.url).searchParams.get('token') });
    return { 'X-Embed-Token': ex.body.embed_token };
  };
  const A = await embedFor('n1'), B = await embedFor('n2');

  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  const biz = db.prepare("SELECT id FROM businesses WHERE crm_user_id='n1'").get().id;
  db.prepare("UPDATE businesses SET phone_number_id='pn-n', wa_provider='meta', wa_access_token='tok', business_hours=?, bot_paused=1 WHERE id=?")
    .run(JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [['06:00', '23:00']]]))), biz);
  const svc = await req('POST', '/api/agenda/services', { name: 'Corte', duration_min: 30 }, A);
  const svcId = svc.body.services[0].id;
  const on = await req('PATCH', '/api/business/agenda-enabled', { enabled: true }, A);
  ok('crm plan can turn the agenda on', on.status === 200, JSON.stringify(on.body));

  const conv = (phone, hoursAgo) => {
    const c = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)').run(biz, phone).lastInsertRowid;
    db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hola', datetime('now', ?))").run(c, `-${hoursAgo * 60} minutes`);
  };
  conv('59899000111', 1);   // wrote 1 h ago → inside the window
  conv('59899000222', 30);  // wrote 30 h ago → outside
  conv(REJECT, 1);          // inside, but Meta rejects

  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date(Date.now() + 2 * 86400000));
  const create = (phone, time) => req('POST', '/api/agenda/appointments', { serviceId: svcId, customerPhone: phone, clientName: 'X', date: day, time }, A);

  console.log('Inside the 24 h window');
  let r = await create('59899000111', '10:00');
  ok('created + notice sent (even with the bot paused: owner action)', r.status === 200 && r.body.client_notice?.sent === true && sent.some(x => x.to === '59899000111' && x.text.includes('agendado')), JSON.stringify(r.body.client_notice));
  const aptOk = r.body.id;
  r = await req('PATCH', `/api/agenda/appointments/${aptOk}/reschedule`, { date: day, time: '11:00' }, A);
  ok('moved + notice sent', r.status === 200 && r.body.client_notice?.sent === true && sent.some(x => x.text.includes('se movió')));

  console.log('Outside the window / never wrote');
  const before = sent.length;
  r = await create('59899000222', '12:00');
  ok('client wrote 30 h ago → not sent, owner told why', r.status === 200 && r.body.client_notice?.sent === false && /24 h/.test(r.body.client_notice.reason));
  ok('… with the exact text to send by hand', /Tu turno quedó agendado/.test(r.body.client_notice.text) && r.body.client_notice.phone === '59899000222');
  ok('… and nothing was sent to Meta', sent.length === before);
  const apt2 = r.body.id;
  let row = db.prepare('SELECT wa_notify_status, wa_notify_reason, client_notice_text FROM agenda_appointments WHERE id=?').get(apt2);
  ok('… kept on the appointment until handled', row.wa_notify_status === 'failed' && /24 h/.test(row.wa_notify_reason) && /agendado/.test(row.client_notice_text));
  r = await create('59899000999', '13:00');
  ok('client never wrote → not sent, owner told', r.body.client_notice?.sent === false);
  r = await req('PATCH', `/api/agenda/appointments/${apt2}/cancel`, {}, A);
  ok('cancel outside the window → owner told with the cancel text', r.status === 200 && r.body.client_notice?.sent === false && /fue cancelado/.test(r.body.client_notice.text));

  console.log('Meta rejects inside the window');
  r = await create(REJECT, '14:00');
  ok('Meta 131047 → not sent, owner told', r.status === 200 && r.body.client_notice?.sent === false && /24 h/.test(r.body.client_notice.reason));

  console.log('Owner marks it as done');
  const other = await req('PATCH', `/api/agenda/appointments/${apt2}/notice-done`, null, B);
  ok('other business cannot touch it', other.status === 404);
  r = await req('PATCH', `/api/agenda/appointments/${apt2}/notice-done`, null, A);
  row = db.prepare('SELECT wa_notify_status, client_notice_text FROM agenda_appointments WHERE id=?').get(apt2);
  ok('"Ya le avisé" clears the pending notice', r.status === 200 && row.wa_notify_status === 'owner_manual' && row.client_notice_text === null);
  const list = await req('GET', `/api/agenda/appointments?from=${day}&to=${day}`, null, A);
  ok('pending notices come back in the appointments list', list.body.filter(a => a.wa_notify_status === 'failed' && a.client_notice_text).length === 2);

  console.log('Baileys connection');
  db.prepare("UPDATE businesses SET wa_provider='baileys' WHERE id=?").run(biz);
  r = await create('59899000111', '15:00');
  ok('Baileys → not sent, owner told the connection cannot send from here', r.body.client_notice?.sent === false && /conexión/.test(r.body.client_notice.reason));
  db.close();

  console.log(`\nAgenda notice — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
