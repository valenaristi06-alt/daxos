#!/usr/bin/env node
'use strict';
/**
 * A business that is NOT on the crm plan behaves exactly like on main.
 * Runs origin/main (git archive) and this branch side by side, with the same mocks
 * (Meta Graph, ElevenLabs, Anthropic) and the same steps, and compares what each returns
 * and stores. The only intended differences are listed and asserted separately.
 * Run: node scripts/test-non-crm-parity.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const MAIN_DIR = '/tmp/test-parity-main-src';
const RUNS = {
  main:   { port: 3137, db: '/tmp/test-parity-db-main', cwd: MAIN_DIR },
  branch: { port: 3138, db: '/tmp/test-parity-db-branch', cwd: ROOT },
};
const META_PORT = 3139, EL_PORT = 3140, AI_PORT = 3141;
let passed = 0, failed = 0;
const procs = [], servers = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (l, c, x = '') => { if (c) { console.log('  ✓ ' + l); passed++; } else { console.error('  ✗ ' + l + (x ? ' — ' + String(x).slice(0, 400) : '')); failed++; } };
function cleanup() {
  procs.forEach(p => { try { p.kill('SIGTERM'); } catch (_) {} });
  servers.forEach(s => { try { s.close(); } catch (_) {} });
  try { execSync(`rm -rf ${MAIN_DIR} ${RUNS.main.db} ${RUNS.branch.db}`); } catch (_) {}
}
process.on('exit', cleanup);

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 1)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 2)]);
const TXT = Buffer.from('Lista: 3 remeras talle M', 'utf8');
const files = { img: { buf: JPEG, mime: 'image/jpeg' }, aud: { buf: OGG, mime: 'audio/ogg' }, txt: { buf: TXT, mime: 'text/plain' } };

function req(port, method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port, path: p, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let b = d; try { b = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: b, raw: d, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sentBy = { main: [], branch: [] };
function strip(v) {
  // Values that legitimately differ between two runs (ids, clocks).
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (/(^id$|_id$|_at$|^created|^updated|timestamp)/.test(k)) continue;
      o[k] = strip(v[k]);
    }
    return o;
  }
  return v;
}

(async () => {
  console.log('Preparing origin/main …');
  execSync(`rm -rf ${MAIN_DIR} ${RUNS.main.db} ${RUNS.branch.db} && mkdir -p ${MAIN_DIR} ${RUNS.main.db} ${RUNS.branch.db}`);
  execSync(`git -C "${ROOT}" fetch -q origin main && git -C "${ROOT}" archive origin/main | tar -x -C ${MAIN_DIR}`);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(MAIN_DIR, 'node_modules'));

  // Shared mocks. Meta records outgoing messages per run by phone_number_id.
  servers.push(http.createServer((q, s) => {
    let body = ''; q.on('data', d => body += d);
    q.on('end', () => {
      const dl = q.url.match(/^\/dl\/(\w+)/);
      const id = q.url.slice(1).split('?')[0];
      if (q.method === 'GET' && dl && files[dl[1]]) { s.writeHead(200, { 'Content-Type': files[dl[1]].mime }); return s.end(files[dl[1]].buf); }
      if (q.method === 'GET' && files[id]) { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify({ url: `http://localhost:${META_PORT}/dl/${id}`, mime_type: files[id].mime, file_size: files[id].buf.length })); }
      if (q.method === 'POST' && q.url.includes('/messages')) {
        try { const b = JSON.parse(body); const run = q.url.includes('pn-main') ? 'main' : 'branch'; if (b.type === 'text') sentBy[run].push({ to: b.to, text: b.text.body }); } catch (_) {}
        s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end('{"messages":[{"id":"w"}]}');
      }
      s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{}');
    });
  }).listen(META_PORT));
  servers.push(http.createServer((q, s) => { q.on('data', () => {}); q.on('end', () => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ text: 'quiero un turno' })); }); }).listen(EL_PORT));
  servers.push(http.createServer((q, s) => { q.on('data', () => {}); q.on('end', () => {
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Recibido, gracias.' }], model: 'claude-test', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  }); }).listen(AI_PORT));

  for (const [name, run] of Object.entries(RUNS)) {
    const p = spawn('node', ['src/server.js'], { cwd: run.cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(run.port), DB_DIR: run.db, SESSION_SECRET: 'p', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '',
        ANTHROPIC_BASE_URL: `http://localhost:${AI_PORT}`, ANTHROPIC_API_KEY: 'x', ELEVENLABS_API_KEY: 'x', ELEVENLABS_BASE_URL: `http://localhost:${EL_PORT}`,
        META_GRAPH_BASE_URL: `http://localhost:${META_PORT}`, WEBHOOK_SIG_MODE: 'off', BAILEYS_ENABLED: '', GROUNDING_MODE: 'off' } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    procs.push(p);
    for (let i = 0; i < 40 && !out.includes('Server running'); i++) await sleep(500);
    run.up = out.includes('Server running');
  }
  ok('main and branch servers started', RUNS.main.up && RUNS.branch.up);
  await sleep(300);

  // Same steps on both: a "crecimiento" business, conversations, incoming media.
  const results = {};
  for (const [name, run] of Object.entries(RUNS)) {
    const R = (m, p, b, c) => req(run.port, m, p, b, c);
    const reg = await R('POST', '/auth/register', { email: 'owner@parity.test', password: 'Parity1!x' });
    const cookie = reg.headers['set-cookie'][0].split(';')[0];
    await R('PUT', '/api/business', { name: 'Negocio Normal', business_context: 'Ropa' }, cookie);
    const bizId = (await R('GET', '/api/business', null, cookie)).body.id;
    const db = new Database(path.join(run.db, 'daxos.db'));
    db.prepare(`UPDATE businesses SET phone_number_id=?, wa_provider='meta', wa_access_token='t', wa_connected_at=datetime('now'),
      plan='crecimiento', plan_paid_at=datetime('now'), response_delay=0 WHERE id=?`).run(`pn-${name}`, bizId);
    // A long chat (250 messages) and a short one.
    const c1 = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)').run(bizId, '59899000001').lastInsertRowid;
    for (let i = 0; i < 250; i++) db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', ?))").run(c1, i % 2 ? 'assistant' : 'user', `m${i}`, `-${(260 - i) * 60} seconds`);
    const c2 = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)').run(bizId, '59899000002').lastInsertRowid;
    db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hola', datetime('now', '-1 hour'))").run(c2);
    db.pragma('wal_checkpoint(FULL)');

    const hook = (from, msg) => R('POST', '/webhook', { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: `pn-${name}` }, contacts: [{ wa_id: from, profile: { name: 'Cliente Prueba' } }],
      messages: [{ id: `wamid.${name}.${from}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }] } }] }] });
    await hook('59899000010', { type: 'image', image: { id: 'img', mime_type: 'image/jpeg', caption: '¿tienen este?' } });
    await hook('59899000011', { type: 'audio', audio: { id: 'aud', mime_type: 'audio/ogg' } });
    await hook('59899000012', { type: 'document', document: { id: 'txt', mime_type: 'text/plain', filename: 'pedido.txt' } });
    await hook('59899000013', { type: 'text', text: { body: 'hola' } });
    for (let i = 0; i < 60; i++) { if (sentBy[name].length >= 4) break; await sleep(150); }
    await sleep(400);

    const list = await R('GET', '/api/conversations', null, cookie);
    const short = await R('GET', `/api/conversations/${c2}/messages`, null, cookie);
    const long = await R('GET', `/api/conversations/${c1}/messages`, null, cookie);
    const stored = db.prepare(`SELECT c.customer_id, m.role, m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.business_id=? AND c.customer_id IN ('59899000010','59899000011','59899000012','59899000013') ORDER BY c.customer_id, m.id`).all(bizId);
    const cols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    const branchOnly = name === 'branch' ? {
      media: db.prepare('SELECT COUNT(*) n FROM messages WHERE media_path IS NOT NULL').get().n,
      names: db.prepare('SELECT COUNT(*) n FROM conversations WHERE contact_name IS NOT NULL').get().n,
      mediaDir: fs.existsSync(path.join(run.db, 'media')),
      mediaApi: (await R('GET', `/api/conversations/${c2}/media/1`, null, cookie)).status,
    } : null;
    const pages = {};
    for (const pg of ['/conversations.html', '/dashboard.html', '/inicio.html', '/js/config-chat.js', '/styles.css']) pages[pg] = (await R('GET', pg)).raw;
    const biz = (await R('GET', '/api/business', null, cookie)).body;
    const tags = await R('GET', '/api/tags', null, cookie);
    results[name] = { list, short, long, stored, sent: sentBy[name], branchOnly, pages, biz, tags, cols };
    db.close();
  }
  const M = results.main, B = results.branch;

  console.log('\nSame as main');
  ok('conversation list: same content', JSON.stringify(strip(M.list.body)) === JSON.stringify(strip(B.list.body)),
    JSON.stringify(strip(B.list.body)[0]));
  ok('conversation list: no new fields for a non-crm business', (B.list.body || []).every(c => !('contact_name' in c)));
  ok('short chat: same messages, same fields', JSON.stringify(strip(M.short.body)) === JSON.stringify(strip(B.short.body)), JSON.stringify(strip(B.short.body)).slice(0, 300));
  ok('messages carry no media fields', !/media/.test(B.short.raw) && !/media/.test(B.long.raw));
  ok('incoming photo / audio / document: same stored conversation', JSON.stringify(M.stored) === JSON.stringify(B.stored), JSON.stringify(B.stored));
  ok('same replies sent to WhatsApp', JSON.stringify(M.sent.map(x => [x.to, x.text]).sort()) === JSON.stringify(B.sent.map(x => [x.to, x.text]).sort()));
  ok('no client files saved, no media folder', B.branchOnly.media === 0 && B.branchOnly.names === 0 && !B.branchOnly.mediaDir);
  ok('media endpoint does not exist for a non-crm business (404)', B.branchOnly.mediaApi === 404);
  for (const pg of Object.keys(M.pages)) ok(`panel page unchanged: ${pg}`, M.pages[pg] === B.pages[pg]);
  ok('/api/business: same fields and values', JSON.stringify(strip(M.biz)) === JSON.stringify(strip(B.biz)));
  ok('tags (panel): same as main', JSON.stringify(strip(M.tags.body)) === JSON.stringify(strip(B.tags.body)));

  console.log('\nIntended difference (fix for everyone): long chats show the newest messages');
  const mLong = M.long.body.messages.map(m => m.content), bLong = B.long.body.messages.map(m => m.content);
  ok('main: first 200 (m0…m199) — newest 50 were hidden', mLong.length === 200 && mLong[0] === 'm0' && mLong[199] === 'm199');
  ok('branch: same 200 count, the latest ones (m50…m249)', bLong.length === 200 && bLong[0] === 'm50' && bLong[199] === 'm249');

  console.log(`\nNon-crm parity — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
