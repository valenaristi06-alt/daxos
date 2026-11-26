#!/usr/bin/env node
'use strict';
// The embed inside a real parent page on another origin (like Pupi): it is allowed to be
// framed, and it tells the parent 'ready' (with connected), 'resize', and 'expired' when
// the one-time link was already used or the 8 h session ended.
// Run: node scripts/test-embed-parent.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const PORT = 3142, HOST_PORT = 3143, KEY = 'parent-key';
const DB_DIR = '/tmp/test-embed-parent';
const HOST = `http://localhost:${HOST_PORT}`;
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
let srv = null, host = null, passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (l, c, x = '') => { if (c) { console.log('  ✓ ' + l); passed++; } else { console.error('  ✗ ' + l + (x ? ' — ' + x : '')); failed++; } };
function cleanup() { if (srv) srv.kill('SIGTERM'); if (host) host.close(); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {} }
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method, headers: h }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  // "Pupi": a page that frames the embed and records what it receives from Daxos only.
  host = http.createServer((q, s) => {
    const src = new URL(q.url, HOST).searchParams.get('src') || '';
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end(`<!doctype html><body><script>
      window.__msgs = [];
      window.addEventListener('message', e => {
        if (e.origin !== 'http://localhost:${PORT}') return;
        if (!e.data || e.data.source !== 'assistant-embed') return;
        window.__msgs.push(e.data);
        if (e.data.event === 'resize') document.getElementById('f').style.height = e.data.height + 'px';
      });
    </script><iframe id="f" src="${src.replace(/"/g, '')}" style="width:900px;height:200px;border:0"
      allow="microphone; clipboard-write"></iframe></body>`);
  }).listen(HOST_PORT);

  srv = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 's', PARTNER_CRM_KEY: KEY,
      PARTNER_EMBED_ORIGINS: HOST, APP_URL: `http://localhost:${PORT}`, NODE_ENV: '', RAILWAY_ENVIRONMENT: '' } });
  for (let i = 0; i < 40; i++) { try { await req('GET', '/health'); break; } catch { await sleep(500); } }
  await req('POST', '/api/partner/businesses', { crm_user_id: 'p1', name: 'P1', email: 'p1@t.com' });

  const browser = await chromium.launch({ headless: true });
  const open = async (url) => {
    const page = await (await browser.newContext()).newPage();
    await page.route('**/connect.facebook.net/**', r => r.abort());
    await page.goto(`${HOST}/?src=${encodeURIComponent(url)}`);
    return page;
  };
  const msgs = (page) => page.evaluate(() => window.__msgs);
  const waitEvent = async (page, ev, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = (await msgs(page)).find(x => x.event === ev); if (m) return m; await sleep(200); }
    return null;
  };

  console.log('Not connected yet');
  let link = (await req('POST', '/api/partner/login-link', { crm_user_id: 'p1', mode: 'embed', theme: { accent: '#7C3AED' } })).url;
  let page = await open(link);
  let ready = await waitEvent(page, 'ready');
  ok('framed by the allowed origin and sends "ready"', !!ready);
  ok('"ready" says not connected', ready && ready.connected === false && ready.configured === false && ready.bot_paused === false, JSON.stringify(ready));
  const rs = await waitEvent(page, 'resize');
  ok('"resize" with a height', rs && rs.height > 100);
  ok('parent applies the height to the iframe', Number((await page.$eval('#f', f => f.style.height)).replace('px', '')) > 100);
  ok('messages carry nothing but source/event/state', (await msgs(page)).every(m => Object.keys(m).every(k => ['source', 'event', 'height', 'connected', 'configured', 'bot_paused'].includes(k))));

  console.log('Link reused (already consumed)');
  const page2 = await open(link);
  ok('"expired" when the one-time link was already used', !!(await waitEvent(page2, 'expired')));

  console.log('Connected + session ends');
  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  db.prepare("UPDATE businesses SET phone_number_id='pn-p' WHERE crm_user_id='p1'").run();
  link = (await req('POST', '/api/partner/login-link', { crm_user_id: 'p1', mode: 'embed' })).url;
  page = await open(link);
  ready = await waitEvent(page, 'ready');
  ok('"ready" says connected (Pupi shows "Conectado")', ready && ready.connected === true);
  db.prepare('UPDATE embed_sessions SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 5);
  ok('"expired" when the 8 h session ends (next refresh)', !!(await waitEvent(page, 'expired', 12000)));
  const frame = page.frames().find(f => f.url().includes(`localhost:${PORT}`));
  ok('embed shows the expired message', frame && (await frame.innerText('#embed-error')).includes('venció'));
  db.close();
  await browser.close();

  console.log(`\nEmbed parent events — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
