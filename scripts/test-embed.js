#!/usr/bin/env node
'use strict';
// Embedded mode tests: framing security (CSP frame-ancestors, X-Frame-Options),
// one-time embed token exchange (expired / reused / wrong mode), token-based session
// auth (no cookies), theme passthrough, and the login-link embed url.
// Run: node scripts/test-embed.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { execSync, spawn } = require('child_process');

const TEST_PORT   = 3119;
const DB_DIR      = '/tmp/test-embed';
const PARTNER_KEY = 'embed-partner-key-test';
const EMBED_ORIGIN = 'https://pupi-pi.vercel.app';
const APP_URL     = `http://localhost:${TEST_PORT}`;

let serverProc = null, passed = 0, failed = 0;

function cleanup() {
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch (_) {} serverProc = null; }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    if (body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = data; try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: data, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const bearer = (k) => ({ headers: { Authorization: `Bearer ${k}` } });
const embed  = (t) => ({ headers: { 'X-Embed-Token': t } });

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

async function main() {
  console.log('Starting server on port', TEST_PORT, '...');
  fs.mkdirSync(DB_DIR, { recursive: true });
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(TEST_PORT), DB_DIR,
      SESSION_SECRET: 'embed-test-secret', PARTNER_CRM_KEY: PARTNER_KEY,
      PARTNER_EMBED_ORIGINS: EMBED_ORIGIN, PARTNER_NAME: 'Pupi', APP_URL,
      NODE_ENV: '', RAILWAY_ENVIRONMENT: '', ENABLE_RATE_LIMIT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  // Seed a crm business
  await req('POST', '/api/partner/businesses',
    { crm_user_id: 'emb_1', name: 'Negocio Embed', email: 'embed@test.com' }, bearer(PARTNER_KEY));

  // ── Suite 1: Framing security ──
  console.log('Suite 1: Framing security');
  {
    const embedPage = await req('GET', '/embed');
    assert(embedPage.status === 200, '/embed serves 200');
    const csp = embedPage.headers['content-security-policy'] || '';
    assert(csp.includes('frame-ancestors') && csp.includes(EMBED_ORIGIN),
      '/embed CSP frame-ancestors lists the allowed origin');
    assert(!csp.includes('evil.com'), '/embed CSP does not list other origins');
    assert(!embedPage.headers['x-frame-options'], '/embed drops X-Frame-Options (uses CSP instead)');

    const dash = await req('GET', '/dashboard');
    assert((dash.headers['x-frame-options'] || '').toUpperCase() === 'SAMEORIGIN',
      '/dashboard keeps X-Frame-Options SAMEORIGIN (unframable by other sites)');
    const dashCsp = dash.headers['content-security-policy'] || '';
    assert(!dashCsp.includes('frame-ancestors'), '/dashboard has no frame-ancestors allowance');
  }

  // ── Suite 2: login-link embed mode ──
  console.log('\nSuite 2: login-link embed mode');
  let embedUrl, embedToken;
  {
    const normal = await req('POST', '/api/partner/login-link', { crm_user_id: 'emb_1' }, bearer(PARTNER_KEY));
    assert(normal.status === 200 && normal.body.url.includes('/api/partner/enter?token='),
      'default mode → /api/partner/enter url');

    const ll = await req('POST', '/api/partner/login-link',
      { crm_user_id: 'emb_1', mode: 'embed', theme: { accent: '#FF0000', bogus: 'x</script>' } }, bearer(PARTNER_KEY));
    assert(ll.status === 200 && ll.body.url.includes('/embed?token='), 'mode=embed → /embed url');
    embedUrl = ll.body.url;
    embedToken = new URL(embedUrl).searchParams.get('token');
  }

  // ── Suite 3: embed session exchange ──
  console.log('\nSuite 3: embed session exchange');
  let sessionToken;
  {
    const noTok = await req('POST', '/api/embed/session', {});
    assert(noTok.status === 401, 'exchange without token → 401');

    const ex = await req('POST', '/api/embed/session', { token: embedToken });
    assert(ex.status === 200 && typeof ex.body.embed_token === 'string', 'valid token → embed_token');
    assert(ex.body.theme.accent === '#FF0000', 'theme override applied (accent from CRM)');
    assert(ex.body.theme.background === '#0B0D14', 'theme fills defaults for unset fields');
    assert(ex.body.theme.bogus === undefined, 'unsafe/unknown theme fields are dropped');
    assert(ex.body.partner_name === 'Pupi', 'partner_name returned');
    assert(Array.isArray(ex.body.origins) && ex.body.origins.includes(EMBED_ORIGIN), 'allowed origins returned');
    sessionToken = ex.body.embed_token;

    const reuse = await req('POST', '/api/embed/session', { token: embedToken });
    assert(reuse.status === 401, 'one-time embed link → second exchange 401 (used)');
  }

  // ── Suite 4: wrong mode + expired ──
  console.log('\nSuite 4: wrong mode + expired token');
  {
    // An 'enter' token must NOT be exchangeable as an embed session.
    const enterLink = await req('POST', '/api/partner/login-link', { crm_user_id: 'emb_1' }, bearer(PARTNER_KEY));
    const enterTok = new URL(enterLink.body.url).searchParams.get('token');
    const wrongMode = await req('POST', '/api/embed/session', { token: enterTok });
    assert(wrongMode.status === 401, 'enter-mode token → embed exchange 401');

    // Expired embed token
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: 'emb_1', mode: 'embed' }, bearer(PARTNER_KEY));
    const tok = new URL(ll.body.url).searchParams.get('token');
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    db.prepare("UPDATE partner_login_tokens SET expires_at = ? WHERE used = 0 AND mode = 'embed'").run(Math.floor(Date.now() / 1000) - 10);
    db.close();
    const expired = await req('POST', '/api/embed/session', { token: tok });
    assert(expired.status === 401, 'expired embed link → 401');
  }

  // ── Suite 5: token-based session auth (no cookies) ──
  console.log('\nSuite 5: embed token auth');
  {
    const noAuth = await req('GET', '/api/embed/state');
    assert(noAuth.status === 401, '/api/embed/state without token → 401');

    const state = await req('GET', '/api/embed/state', null, embed(sessionToken));
    assert(state.status === 200 && state.body.plan === 'crm', 'state with embed token → 200, plan crm');
    assert(state.body.usage && typeof state.body.usage.conv_cap === 'number'
      && typeof state.body.usage.percent_used === 'number', 'state includes percent_used + conversations vs cap');
    assert(state.body.usage.cost_usd === undefined && state.body.usage.spend_cap_usd === undefined
      && JSON.stringify(state.body).indexOf('usd') === -1, 'state never exposes dollars to the owner');
    assert(state.body.config_chat_enabled === true, 'configurador enabled for crm in embed');

    // Pause toggle via embed token (no cookie)
    const pause = await req('POST', '/api/business/bot-paused', { paused: true }, embed(sessionToken));
    assert(pause.status === 200 && pause.body.bot_paused === 1, 'bot-paused via embed token works');
    const resume = await req('POST', '/api/business/bot-paused', { paused: false }, embed(sessionToken));
    assert(resume.status === 200 && resume.body.bot_paused === 0, 'resume via embed token works');

    // Bad embed token → 401
    const bad = await req('GET', '/api/embed/state', null, embed('not-a-real-token'));
    assert(bad.status === 401, 'invalid embed token → 401');
  }

  console.log('\n================================');
  console.log(`Embed tests — ${passed} passed, ${failed} failed`);
  console.log('================================');
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Test run error:', err); cleanup(); process.exit(1); });
