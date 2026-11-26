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
    assert(state.body.usage === undefined && !('percent_used' in state.body) && !('conv_cap' in state.body),
      'state exposes no usage numbers or percentages');
    assert(state.body.limit_notice === null, 'below 80% → no limit notice');
    assert(JSON.stringify(state.body).indexOf('usd') === -1, 'state never exposes dollars to the owner');
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

  // ── Suite 6: limit notice (80% / 100%), no numbers ──
  console.log('\nSuite 6: limit notice');
  {
    await req('POST', '/api/partner/businesses/quota', { crm_user_id: 'emb_1', conv_cap: 10, spend_cap_usd: 1000 }, bearer(PARTNER_KEY));
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const bizId = db.prepare("SELECT id FROM businesses WHERE crm_user_id = 'emb_1'").get().id;
    const convIns = db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)');
    const msgIns = db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hola', datetime('now'))");
    const addConvs = (n, base) => { for (let i = 0; i < n; i++) msgIns.run(convIns.run(bizId, String(base + i)).lastInsertRowid); };
    addConvs(8, 59890000);
    db.close();
    const near = await req('GET', '/api/embed/state', null, embed(sessionToken));
    assert(near.body.limit_notice === 'near', '8 of 10 conversations (80%) → limit_notice near');
    const db2 = new Database(path.join(DB_DIR, 'daxos.db'));
    const conv2 = db2.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)');
    const msg2 = db2.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hola', datetime('now'))");
    for (let i = 0; i < 2; i++) msg2.run(conv2.run(bizId, String(59891000 + i)).lastInsertRowid);
    db2.close();
    const reached = await req('GET', '/api/embed/state', null, embed(sessionToken));
    assert(reached.body.limit_notice === 'reached', '10 of 10 (100%) → limit_notice reached');
    assert(!/\d+\s*%|percent/.test(JSON.stringify(reached.body)), 'no percentage in the state payload');
  }

  // ── Suite 7: conversations inside the embed + isolation between businesses ──
  console.log('\nSuite 7: embed conversations + isolation');
  {
    await req('POST', '/api/partner/businesses', { crm_user_id: 'emb_2', name: 'Otro Negocio', email: 'otro@test.com' }, bearer(PARTNER_KEY));
    const db = new Database(path.join(DB_DIR, 'daxos.db'));
    const bizA = db.prepare("SELECT id FROM businesses WHERE crm_user_id = 'emb_1'").get().id;
    const bizB = db.prepare("SELECT id FROM businesses WHERE crm_user_id = 'emb_2'").get().id;
    const mkConv = (biz, phone) => db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)').run(biz, phone).lastInsertRowid;
    const mkMsg = (conv, role, content) => db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now'))").run(conv, role, content).lastInsertRowid;
    const convA = mkConv(bizA, '59899111222');
    mkMsg(convA, 'user', 'Hola, ¿tienen turno mañana?');
    const convB = mkConv(bizB, '59899333444');
    mkMsg(convB, 'user', 'Mensaje privado del negocio B');
    // Media for B's conversation (a tiny PNG on disk)
    const mediaDir = path.join(DB_DIR, 'media', String(bizB));
    fs.mkdirSync(mediaDir, { recursive: true });
    const pngPath = path.join(mediaDir, 'b.png');
    fs.writeFileSync(pngPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e0b8a60000000049454e44ae426082', 'hex'));
    const mediaMsgB = mkMsg(convB, 'user', '[imagen]');
    db.prepare("UPDATE messages SET media_kind='image', media_mime='image/png', media_path=? WHERE id=?").run(pngPath, mediaMsgB);
    // Media for A's conversation
    const mediaDirA = path.join(DB_DIR, 'media', String(bizA));
    fs.mkdirSync(mediaDirA, { recursive: true });
    const pngA = path.join(mediaDirA, 'a.png');
    fs.copyFileSync(pngPath, pngA);
    const mediaMsgA = mkMsg(convA, 'user', '[imagen] mirá esto');
    db.prepare("UPDATE messages SET media_kind='image', media_mime='image/png', media_path=? WHERE id=?").run(pngA, mediaMsgA);
    // A path outside the media folder must never be served
    const evilMsg = mkMsg(convA, 'user', '[documento: x]');
    db.prepare("UPDATE messages SET media_kind='document', media_mime='application/pdf', media_path=? WHERE id=?").run(path.join(DB_DIR, 'daxos.db'), evilMsg);
    db.close();

    const list = await req('GET', '/api/conversations', null, embed(sessionToken));
    assert(list.status === 200 && Array.isArray(list.body), 'embed token → own conversation list');
    assert(list.body.some(c => c.id === convA), 'list includes own conversation');
    assert(!list.body.some(c => c.id === convB) && !JSON.stringify(list.body).includes('privado del negocio B'),
      'list never includes the other business\'s conversations');

    const own = await req('GET', `/api/conversations/${convA}/messages`, null, embed(sessionToken));
    assert(own.status === 200 && own.body.messages.length >= 2, 'opens own conversation');
    const withMedia = own.body.messages.find(m => m.id === mediaMsgA);
    assert(withMedia && withMedia.media && withMedia.media.kind === 'image' && withMedia.media.url === `/api/conversations/${convA}/media/${mediaMsgA}`,
      'message carries media kind + url');
    assert(!JSON.stringify(own.body).includes('media_path') && !JSON.stringify(own.body).includes(DB_DIR), 'file path never sent to the browser');

    const ownMedia = await req('GET', `/api/conversations/${convA}/media/${mediaMsgA}`, null, embed(sessionToken));
    assert(ownMedia.status === 200 && ownMedia.headers['content-type'] === 'image/png', 'own media served (image/png)');
    const evil = await req('GET', `/api/conversations/${convA}/media/${evilMsg}`, null, embed(sessionToken));
    assert(evil.status === 404, 'file outside the media folder is never served');
    const noTokMedia = await req('GET', `/api/conversations/${convA}/media/${mediaMsgA}`);
    assert(noTokMedia.status === 401, 'media without token → 401');

    // Every action on B's conversation with A's embed token → 404, and nothing changes.
    const tries = [
      ['GET',    `/api/conversations/${convB}/messages`],
      ['GET',    `/api/conversations/${convB}/media/${mediaMsgB}`],
      ['GET',    `/api/conversations/${convA}/media/${mediaMsgB}`],
      ['PATCH',  `/api/conversations/${convB}/pause`],
      ['PATCH',  `/api/conversations/${convB}/resume`],
      ['POST',   `/api/conversations/${convB}/send`, { text: 'hola' }],
      ['DELETE', `/api/conversations/${convB}`],
    ];
    for (const [m, u, b] of tries) {
      const r = await req(m, u, b || null, embed(sessionToken));
      assert(r.status === 404, `${m} ${u.replace(String(convB), 'B').replace(String(convA), 'A')} → 404 for another business`);
      assert(!r.raw.includes('privado del negocio B'), `${m} leaks nothing from the other business`);
    }
    const dbc = new Database(path.join(DB_DIR, 'daxos.db'));
    const rowB = dbc.prepare('SELECT needs_attention, deleted_at FROM conversations WHERE id = ?').get(convB);
    dbc.close();
    assert(rowB.needs_attention === 0 && rowB.deleted_at === null, 'other business\'s conversation untouched');

    // Own actions work with the embed token
    const p = await req('PATCH', `/api/conversations/${convA}/pause`, null, embed(sessionToken));
    const afterPause = await req('GET', `/api/conversations/${convA}/messages`, null, embed(sessionToken));
    assert(p.status === 200 && afterPause.body.conversation.needs_attention === 1, '"Atiendo yo" pauses the bot in that chat');
    const rs = await req('PATCH', `/api/conversations/${convA}/resume`, null, embed(sessionToken));
    const afterResume = await req('GET', `/api/conversations/${convA}/messages`, null, embed(sessionToken));
    assert(rs.status === 200 && afterResume.body.conversation.needs_attention === 0, 'reactivate turns the bot back on in that chat');
    const del = await req('DELETE', `/api/conversations/${convA}`, null, embed(sessionToken));
    const listAfter = await req('GET', '/api/conversations', null, embed(sessionToken));
    assert(del.status === 200 && !listAfter.body.some(c => c.id === convA), 'delete chat removes it from the list (Daxos only)');
    const dbm = new Database(path.join(DB_DIR, 'daxos.db'));
    const kept = dbm.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convA).n;
    dbm.close();
    assert(kept >= 2, 'deleted chat keeps its messages (counters never drop)');
  }

  console.log('\n================================');
  console.log(`Embed tests — ${passed} passed, ${failed} failed`);
  console.log('================================');
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Test run error:', err); cleanup(); process.exit(1); });
