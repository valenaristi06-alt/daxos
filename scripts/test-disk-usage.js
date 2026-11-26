#!/usr/bin/env node
'use strict';
// Data volume usage: admin alert above 80% (once per 24 h) and no client media saved
// above 90%, so the database never runs out of space.
// Run: node scripts/test-disk-usage.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const PORT = 3133, META_PORT = 3134;
const DB_DIR = '/tmp/test-disk-usage';
const ADMIN = 'admin-disk@test.com';
let srv = null, metaSrv = null, passed = 0, failed = 0;
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (l, c, extra = '') => { if (c) { console.log('  ✓ ' + l); passed++; } else { console.error('  ✗ ' + l + (extra ? ' — ' + extra : '')); failed++; } };
function cleanup() { if (srv) srv.kill('SIGTERM'); if (metaSrv) metaSrv.close(); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {} }

function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let b = d; try { b = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: b, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  console.log('Unit: disk usage');
  {
    delete process.env.DISK_CAP_MB;
    const disk = require('../src/disk');
    const u = disk.getDiskUsage(DB_DIR);
    ok('statfs: total > used > 0, pct in 0..1', u.totalBytes > u.usedBytes && u.usedBytes > 0 && u.pct > 0 && u.pct < 1 && u.source === 'statfs');
    fs.writeFileSync(path.join(DB_DIR, 'filler.bin'), Buffer.alloc(900 * 1024));
    process.env.DISK_CAP_MB = '1';
    const c = disk.getDiskUsage(DB_DIR);
    ok('DISK_CAP_MB: measures the data dir against the cap', c.source === 'cap' && c.pct > 0.8 && c.pct < 1, JSON.stringify(c));
    fs.unlinkSync(path.join(DB_DIR, 'filler.bin'));
    delete process.env.DISK_CAP_MB;
  }

  const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 1)]);
  metaSrv = http.createServer((q, s) => {
    q.on('data', () => {});
    q.on('end', () => {
      if (q.url.startsWith('/dl/')) { s.writeHead(200, { 'Content-Type': 'image/jpeg' }); return s.end(JPEG); }
      if (q.method === 'GET') { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify({ url: `http://localhost:${META_PORT}/dl/x`, mime_type: 'image/jpeg', file_size: JPEG.length })); }
      s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"messages":[{"id":"w"}]}');
    });
  }).listen(META_PORT);

  // Cap far below the database size → volume "over 100%".
  srv = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 's', ADMIN_EMAIL: ADMIN, DISK_CAP_MB: '0.05',
      NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '', RESEND_API_KEY: '', META_GRAPH_BASE_URL: `http://localhost:${META_PORT}`,
      WEBHOOK_SIG_MODE: 'off', BAILEYS_ENABLED: '', ANTHROPIC_API_KEY: 'x' } });
  let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 40 && !out.includes('Server running'); i++) await sleep(500);
  await sleep(300);

  console.log('Admin alert above 80%');
  {
    const reg = await req('POST', '/auth/register', { email: ADMIN, password: 'AdminPass1!' });
    let cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
    const login = await req('POST', '/admin/auth/login', { email: ADMIN, password: 'AdminPass1!' }, cookie);
    cookie = login.headers['set-cookie']?.[0]?.split(';')[0] || cookie;
    const noAdmin = await req('POST', '/admin/api/run-disk-check');
    ok('disk check is admin-only', noAdmin.status === 403);
    const first = await req('POST', '/admin/api/run-disk-check', null, cookie);
    ok('above 80% → admin alerted', first.status === 200 && first.body.pct > 0.8 && first.body.alerted === true, JSON.stringify(first.body));
    const second = await req('POST', '/admin/api/run-disk-check', null, cookie);
    ok('second check within 24 h → no repeat email', second.body.alerted === false);
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'), { readonly: true });
    const logged = db.prepare("SELECT COUNT(*) n FROM error_log WHERE context = 'disk-usage'").get().n;
    db.close();
    ok('alert logged once', logged === 1, String(logged));
  }

  console.log('No client media saved above 90%');
  {
    const reg = await req('POST', '/auth/register', { email: `o-${Date.now()}@t.com`, password: 'OwnerPass1!' });
    const cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
    await req('PUT', '/api/business', { name: 'Disk Biz' }, cookie);
    const bizId = (await req('GET', '/api/business', null, cookie)).body.id;
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    db.prepare("UPDATE businesses SET phone_number_id='pn-disk', wa_provider='meta', wa_access_token='f', wa_connected_at=datetime('now'), bot_paused=1 WHERE id=?").run(bizId);
    db.pragma('wal_checkpoint(FULL)');
    await req('POST', '/webhook', { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn-disk' },
      messages: [{ id: 'wamid.disk1', from: '59899000777', timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'img1', mime_type: 'image/jpeg' } }],
    } }] }] });
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      row = db.prepare("SELECT m.content, m.media_path FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.business_id=? AND m.role='user'").get(bizId);
      if (!row) await sleep(150);
    }
    ok('message still stored', row && row.content === '[imagen]');
    ok('photo NOT saved to disk (volume full)', row && row.media_path === null && !fs.existsSync(path.join(DB_DIR, 'media', String(bizId))));
    const skipped = db.prepare("SELECT COUNT(*) n FROM error_log WHERE context = 'media-skip-disk'").get().n;
    ok('skip logged', skipped >= 1);
    db.close();
  }

  console.log(`\nDisk usage — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
