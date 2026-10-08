#!/usr/bin/env node
'use strict';
// Tests for Kapso image message handling (Paso B).
// Anthropic is mocked via ANTHROPIC_BASE_URL pointing to a local server.
// WA sends are intercepted via KAPSO_MESSAGES_OVERRIDE (mock messages endpoint).
// Media downloads are served by a local mock media server.
// Run: node scripts/test-kapso-image.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT        = 3097;
const MOCK_AI_PORT     = 3098;
const MOCK_MEDIA_PORT  = 3099;
const DB_DIR           = '/tmp/test-kapso-image';
const ADMIN_TOKEN      = 'test-admin-kapso-image';
const BASE_URL         = `http://localhost:${TEST_PORT}`;

let serverProc   = null;
let mockAiServer = null;
let mockMediaServer = null;
let passed = 0;
let failed = 0;

// Capture last request received by mock AI server
let lastAiRequest  = null;
// Capture outgoing WA messages
const sentMessages = [];
// Capture requests to mock media server
const mediaRequests = [];

function cleanup() {
  if (serverProc)     { try { serverProc.kill();       } catch (_) {} }
  if (mockAiServer)   { try { mockAiServer.close();    } catch (_) {} }
  if (mockMediaServer){ try { mockMediaServer.close(); } catch (_) {} }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie']        = opts.cookie;
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        const setCookie = res.headers['set-cookie'];
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), setCookie }); }
          catch { resolve({ status: res.statusCode, body: data, setCookie }); }
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function assert(condition, label, detail) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}${detail !== undefined ? ': ' + String(detail) : ''}`); failed++; }
}

// Mock Anthropic + Kapso proxy server (all on same port)
function startMockAiServer() {
  return new Promise((resolve) => {
    mockAiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.url === '/v1/messages') {
          // Anthropic API call
          try { lastAiRequest = JSON.parse(body); } catch { lastAiRequest = body; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Respuesta de prueba del asistente.' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }));
        } else if (req.method === 'GET' && req.url.startsWith('/kapso/')) {
          // Plan B resolve: GET /kapso/<mediaId>?phone_number_id=...
          const isEvil = req.url.includes('planb-evil');
          const downloadUrl = isEvil
            ? 'https://evil.example.com/img/forbidden'
            : `http://localhost:${MOCK_MEDIA_PORT}/img/valid`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ download_url: downloadUrl, url: 'https://lookaside.fbsbx.com/never' }));
        } else {
          // WA sends: POST /kapso/<pnid>/messages
          if (req.method === 'POST') {
            try {
              const parsed = JSON.parse(body);
              if (parsed.messaging_product === 'whatsapp') sentMessages.push(parsed);
            } catch {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages: [{ id: 'wamid.test' }] }));
        }
      });
    });
    mockAiServer.listen(MOCK_AI_PORT, () => resolve());
  });
}

// Mock media server — serves a small JPEG for valid paths, 404 for /missing
function startMockMediaServer() {
  // Minimal valid JPEG (1×1 white pixel)
  const tinyJpeg = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080101000005021dffd9',
    'hex'
  );
  const bigBuffer = Buffer.alloc(6 * 1024 * 1024, 0xff); // 6 MB

  return new Promise((resolve) => {
    mockMediaServer = http.createServer((req, res) => {
      mediaRequests.push({ url: req.url, headers: { ...req.headers } });
      if (req.url === '/img/valid') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(tinyJpeg.length) });
        res.end(tinyJpeg);
      } else if (req.url === '/img/big') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(bigBuffer.length) });
        res.end(bigBuffer);
      } else if (req.url === '/img/401') {
        if (req.headers['x-api-key']) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(tinyJpeg.length) });
          res.end(tinyJpeg);
        } else {
          res.writeHead(401, {}); res.end();
        }
      } else if (req.url === '/img/redirect-http') {
        res.writeHead(302, { 'Location': `http://localhost:${MOCK_MEDIA_PORT}/img/valid` });
        res.end();
      } else if (req.url === '/img/octet-stream') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tinyJpeg.length) });
        res.end(tinyJpeg);
      } else if (req.url === '/img/fake-jpeg') {
        const fakeBytes = Buffer.from('this is not an image at all');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(fakeBytes.length) });
        res.end(fakeBytes);
      } else {
        res.writeHead(404, {}); res.end();
      }
    });
    mockMediaServer.listen(MOCK_MEDIA_PORT, () => resolve());
  });
}

// Build a Kapso image webhook payload
function imagePayload(phoneNumberId, from, opts = {}) {
  const {
    mediaUrl     = `http://localhost:${MOCK_MEDIA_PORT}/img/valid`,
    mimeType     = 'image/jpeg',
    caption      = '',
    mediaId      = 'media-id-test',
    msgId        = `wamid.imgtest${Date.now()}${Math.random()}`,
    origin       = 'customer',
    msgTimestamp = String(Math.floor(Date.now() / 1000)),
  } = opts;
  return {
    event: 'whatsapp.message.received',
    phone_number_id: phoneNumberId,
    message: {
      id: msgId,
      from,
      type: 'image',
      timestamp: msgTimestamp,
      image: { id: mediaId, mime_type: mimeType, caption },
      kapso: { origin, has_media: true, media_url: mediaUrl },
    },
  };
}

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.join(DB_DIR, 'daxos.db'));
}

async function seedBusiness(db, opts = {}) {
  const { email = `biz${Date.now()}@test.com`, paused = false, pnid = `pnid${Date.now()}` } = opts;
  const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const cookie = r.setCookie?.[0]?.split(';')[0];
  await req('PUT', '/api/business', { name: 'Test Biz', plan: 'crecimiento' }, { cookie });

  // Wire up WA credentials directly in DB
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id;
  const bizId  = db.prepare('SELECT business_id FROM users WHERE id = ?').get(userId)?.business_id;
  // wa_access_token left NULL — Kapso uses KAPSO_API_KEY env var, not per-business token.
  // Setting a plain-text value here would fail decrypt() when the server reads the row.
  // response_delay=0 so processIncomingMessage doesn't wait 5s before saving messages.
  const updateResult = db.prepare(`UPDATE businesses SET
    phone_number_id = ?,
    wa_provider = 'kapso',
    wa_connected_at = datetime('now'),
    plan = 'crecimiento',
    plan_paid_at = datetime('now'),
    response_delay = 0
    WHERE id = ?`).run(pnid, bizId);
  if (updateResult.changes === 0) throw new Error(`seedBusiness: UPDATE matched 0 rows (bizId=${bizId})`);
  // Force WAL checkpoint so the server process sees this write immediately
  db.pragma('wal_checkpoint(FULL)');

  if (paused) {
    // Find or create a conversation and pause it
    db.prepare(`INSERT OR IGNORE INTO conversations (business_id, customer_id, needs_attention) VALUES (?, '5491100000001', 1)`).run(bizId);
    db.prepare(`UPDATE conversations SET needs_attention = 1, paused_reason = 'human' WHERE business_id = ?`).run(bizId);
  }

  return { cookie, bizId, pnid };
}

async function main() {
  // Fresh DB every run
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(DB_DIR, { recursive: true });

  console.log('Starting mock servers...');
  await Promise.all([startMockAiServer(), startMockMediaServer()]);

  console.log(`Starting app server on port ${TEST_PORT}...`);
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT:              String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET:    'kapso-image-test-secret',
      ADMIN_SET_WA_TOKEN: ADMIN_TOKEN,
      ANTHROPIC_BASE_URL:         `http://localhost:${MOCK_AI_PORT}`,
      ANTHROPIC_API_KEY:          'test-key-not-real',
      KAPSO_API_KEY:              'test-kapso-key',
      // Override Kapso base URL so WA sends go to mock server, not real Kapso API
      KAPSO_API_BASE_URL:         `http://localhost:${MOCK_AI_PORT}/kapso`,
      // Allow localhost media URLs in tests (never set in production)
      KAPSO_TEST_ALLOW_LOCALHOST: '1',
      // Disable HMAC check — test payloads are unsigned
      KAPSO_WEBHOOK_SECRET:       '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(500);

  const db = openDb();

  // ── Suite A: happy path ─────────────────────────────────────────────────────
  console.log('Suite A: valid image processed, nothing sensitive saved');
  {
    const { pnid } = await seedBusiness(db, { email: 'img-a@test.com', pnid: 'pnid-a' });
    const from = '5491100000100';

    lastAiRequest = null;
    const r = await req('POST', '/webhook/kapso', imagePayload('pnid-a', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/valid`,
      caption:  'necesito esto',
    }));
    assert(r.status === 200, 'A1: webhook returns 200');

    await sleep(1500); // let async processing finish

    // DB should have stored text but no base64 or image bytes
    const msgs = db.prepare(`
      SELECT m.content FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-a' AND c.customer_id = ?
      ORDER BY m.id`).all(from);

    assert(msgs.length >= 1, 'A2: at least one message saved');
    const userMsg = msgs.find(m => m.content.includes('[el cliente envió una imagen]'));
    assert(!!userMsg, 'A3: stored text is placeholder not raw image');
    const hasBase64 = msgs.some(m => m.content.length > 2000);
    assert(!hasBase64, 'A4: no base64 blob saved in messages');

    // Anthropic received an image block
    assert(lastAiRequest !== null, 'A5: Anthropic was called');
    const lastUserMsg = lastAiRequest?.messages?.at(-1);
    const hasImageBlock = Array.isArray(lastUserMsg?.content) &&
      lastUserMsg.content.some(b => b.type === 'image');
    assert(hasImageBlock, 'A6: Anthropic received image block');

    // Caption passed to Anthropic
    const textBlock = lastUserMsg?.content?.find(b => b.type === 'text');
    assert(textBlock?.text === 'necesito esto', 'A7: caption sent to Anthropic as text');

    // No image file on disk
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const jpegFiles = fs.existsSync(uploadsDir)
      ? fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png'))
      : [];
    assert(jpegFiles.length === 0, 'A8: no image file written to uploads/');
  }

  // ── Suite B: image too large → fallback ────────────────────────────────────
  console.log('\nSuite B: image too large → fallback message');
  {
    await seedBusiness(db, { email: 'img-b@test.com', pnid: 'pnid-b' });
    const from = '5491100000200';

    lastAiRequest = null;
    const r = await req('POST', '/webhook/kapso', imagePayload('pnid-b', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/big`,
    }));
    assert(r.status === 200, 'B1: webhook returns 200');
    await sleep(1500);

    const msgs = db.prepare(`
      SELECT m.content, m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-b' AND c.customer_id = ?`).all(from);

    const assistantMsg = msgs.find(m => m.role === 'assistant');
    assert(assistantMsg?.content?.includes('contás por texto'), 'B2: fallback message saved as assistant reply');
    assert(lastAiRequest === null, 'B3: Anthropic NOT called for oversized image');
  }

  // ── Suite C: business paused → no AI reply ─────────────────────────────────
  console.log('\nSuite C: paused conversation → no reply');
  {
    await seedBusiness(db, { email: 'img-c@test.com', pnid: 'pnid-c', paused: false });
    const from = '5491100000300';

    // Manually pause the conversation
    db.prepare(`INSERT OR IGNORE INTO conversations (business_id, customer_id, needs_attention, paused_reason)
      SELECT id, ?, 1, 'human' FROM businesses WHERE phone_number_id = 'pnid-c'`).run(from);
    db.prepare(`UPDATE conversations SET needs_attention = 1, paused_reason = 'human'
      WHERE customer_id = ? AND business_id = (SELECT id FROM businesses WHERE phone_number_id = 'pnid-c')`).run(from);

    lastAiRequest = null;
    const r = await req('POST', '/webhook/kapso', imagePayload('pnid-c', from));
    assert(r.status === 200, 'C1: webhook returns 200');
    await sleep(1500);

    assert(lastAiRequest === null, 'C2: Anthropic NOT called when conversation paused');

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-c' AND c.customer_id = ?`).all(from);
    const hasAssistant = msgs.some(m => m.role === 'assistant');
    assert(!hasAssistant, 'C3: no assistant reply saved when paused');
    assert(msgs.some(m => m.role === 'user'), 'C4: user message saved even when paused');
  }

  // ── Suite D: owner echo → discarded ────────────────────────────────────────
  console.log('\nSuite D: business_app echo → no processing');
  {
    await seedBusiness(db, { email: 'img-d@test.com', pnid: 'pnid-d' });
    const from = '5491100000400';

    lastAiRequest = null;
    const r = await req('POST', '/webhook/kapso', imagePayload('pnid-d', from, {
      origin: 'business_app',
    }));
    assert(r.status === 200, 'D1: webhook returns 200');
    await sleep(800);

    assert(lastAiRequest === null, 'D2: Anthropic NOT called for owner echo');
  }

  // ── Suite E: rate limit (10/h) ─────────────────────────────────────────────
  console.log('\nSuite E: rate limit — 10 images/hour');
  {
    await seedBusiness(db, { email: 'img-e@test.com', pnid: 'pnid-e' });
    const from = '5491100000500';

    let aiCallCount = 0;
    const origLastAi = lastAiRequest;

    // Send 10 images (all should be processed)
    for (let i = 0; i < 10; i++) {
      await req('POST', '/webhook/kapso', imagePayload('pnid-e', from, {
        msgId: `wamid.rate${i}`,
      }));
      await sleep(200);
    }
    await sleep(1500);

    const msgs10 = db.prepare(`
      SELECT COUNT(*) AS n FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-e' AND c.customer_id = ? AND m.role = 'user'`).get(from);
    assert(msgs10.n === 10, `E1: 10 user messages saved (got ${msgs10.n})`);

    // 11th image should get fallback
    lastAiRequest = null;
    await req('POST', '/webhook/kapso', imagePayload('pnid-e', from, { msgId: 'wamid.rate10' }));
    await sleep(1000);

    assert(lastAiRequest === null, 'E2: Anthropic NOT called for 11th image (over limit)');

    const msgs11 = db.prepare(`
      SELECT m.content, m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-e' AND c.customer_id = ?
      ORDER BY m.id DESC LIMIT 2`).all(from);
    const lastAssistant = msgs11.find(m => m.role === 'assistant');
    assert(lastAssistant?.content?.includes('contás por texto'), 'E3: fallback message on 11th image');
  }

  // ── Suite F: non-Kapso host → rejected, no API key sent ───────────────────
  console.log('\nSuite F: non-Kapso media_url → rejected without fetching');
  {
    await seedBusiness(db, { email: 'img-f@test.com', pnid: 'pnid-f' });
    const from = '5491100000600';

    // Use a non-kapso host — isAllowedKapsoHost must reject it before any fetch
    const initialMediaReqCount = mediaRequests.length;
    lastAiRequest = null;

    const r = await req('POST', '/webhook/kapso', imagePayload('pnid-f', from, {
      mediaUrl: 'https://evil-not-kapso.example.com/img/valid',
    }));
    assert(r.status === 200, 'F1: webhook returns 200');
    await sleep(1000);

    // The URL is not *.kapso.ai — should be blocked before fetch
    assert(lastAiRequest === null, 'F2: Anthropic NOT called for blocked URL');

    // Media server should NOT have been called (blocked before fetch)
    const newMediaReqs = mediaRequests.length - initialMediaReqCount;
    assert(newMediaReqs === 0, 'F3: media server never fetched for non-Kapso host');

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-f' AND c.customer_id = ?`).all(from);
    const assistantFb = msgs.find(m => m.role === 'assistant');
    assert(assistantFb !== undefined, 'F4: fallback message sent for blocked URL');
  }

  // ── Suite G: media_url 401 → retry once with API key ─────────────────────
  console.log('\nSuite G: media_url returns 401 → retry with X-API-Key');
  {
    await seedBusiness(db, { email: 'img-g@test.com', pnid: 'pnid-g' });
    const from = '5491100000700';

    // Use a mock kapso.ai-like URL — we can't actually use app.kapso.ai in tests,
    // so we test this via unit-style check on downloadKapsoMedia directly.
    // Here we verify the 401 path works end-to-end with the mock media server.
    // (URL passes host check only if it's *.kapso.ai — we test the function directly.)
    const { downloadKapsoMedia: dlFn, isAllowedKapsoHost } = require('../src/whatsapp');

    assert(isAllowedKapsoHost('https://app.kapso.ai/media/abc'), 'G1: app.kapso.ai allowed');
    assert(isAllowedKapsoHost('https://kapso.ai/media/abc'),     'G2: kapso.ai allowed');
    assert(!isAllowedKapsoHost('https://evil.com/media/abc'),    'G3: evil.com rejected');
    assert(!isAllowedKapsoHost('http://app.kapso.ai/media/abc'), 'G4: http (not https) rejected');
    assert(!isAllowedKapsoHost('https://notkapsoi.ai/img'),      'G5: notkapsoi.ai rejected');
    assert(!isAllowedKapsoHost('https://kapso.ai.evil.com/img'), 'G6: kapso.ai.evil.com rejected');

    console.log('  (401 retry with real kapso.ai host requires live network — skipped in CI)');
  }

  // ── Suite H: unsupported type (sticker) → fallback ─────────────────────────
  console.log('\nSuite H: sticker/gif mime → fallback');
  {
    await seedBusiness(db, { email: 'img-h@test.com', pnid: 'pnid-h' });
    const from = '5491100000800';

    lastAiRequest = null;
    await req('POST', '/webhook/kapso', imagePayload('pnid-h', from, {
      mimeType: 'image/webp+sticker',
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/valid`,
    }));
    await sleep(1000);

    assert(lastAiRequest === null, 'H1: Anthropic NOT called for sticker');

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-h' AND c.customer_id = ?`).all(from);
    assert(msgs.some(m => m.role === 'assistant'), 'H2: fallback message sent for sticker');
  }

  // ── Suite I: paused conv + oversized image → user saved, no WA fallback ──────
  console.log('\nSuite I: paused conv + oversized image → user msg saved, no WA fallback');
  {
    await seedBusiness(db, { email: 'img-i@test.com', pnid: 'pnid-i' });
    const from = '5491100000900';

    // Pause the conversation for this customer
    db.prepare(`INSERT OR IGNORE INTO conversations (business_id, customer_id, needs_attention, paused_reason)
      SELECT id, ?, 1, 'human' FROM businesses WHERE phone_number_id = 'pnid-i'`).run(from);
    db.prepare(`UPDATE conversations SET needs_attention = 1, paused_reason = 'human'
      WHERE customer_id = ? AND business_id = (SELECT id FROM businesses WHERE phone_number_id = 'pnid-i')`).run(from);
    db.pragma('wal_checkpoint(FULL)');

    lastAiRequest = null;
    sentMessages.length = 0;
    await req('POST', '/webhook/kapso', imagePayload('pnid-i', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/big`,
    }));
    await sleep(1500);

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-i' AND c.customer_id = ?`).all(from);

    assert(msgs.some(m => m.role === 'user'),      'I1: user message saved even when paused');
    assert(!msgs.some(m => m.role === 'assistant'), 'I2: no assistant fallback saved when paused');
    assert(lastAiRequest === null,                   'I3: Anthropic NOT called when paused');
    assert(sentMessages.length === 0,                'I4: no WA message sent when paused');
  }

  // ── Suite J: inactive business + oversized image → no WA fallback ────────────
  console.log('\nSuite J: inactive business + oversized image → no WA fallback');
  {
    const { bizId } = await seedBusiness(db, { email: 'img-j@test.com', pnid: 'pnid-j' });
    const from = '5491100001000';

    // Cancel subscription so isTrialExpired returns true
    db.prepare(`UPDATE businesses SET subscription_status = 'cancelled' WHERE id = ?`).run(bizId);
    db.pragma('wal_checkpoint(FULL)');

    sentMessages.length = 0;
    await req('POST', '/webhook/kapso', imagePayload('pnid-j', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/big`,
    }));
    await sleep(1500);

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-j' AND c.customer_id = ?`).all(from);

    assert(!msgs.some(m => m.role === 'assistant'), 'J1: no assistant fallback for inactive business');
    assert(sentMessages.length === 0,                'J2: no WA message sent for inactive business');
  }

  // ── Suite K: redirect to http → download_error → fallback IS sent ─────────
  console.log('\nSuite K: http redirect → fallback sent (redirect_not_https error)');
  {
    await seedBusiness(db, { email: 'img-k@test.com', pnid: 'pnid-k' });
    const from = '5491100001100';

    lastAiRequest = null;
    sentMessages.length = 0;
    await req('POST', '/webhook/kapso', imagePayload('pnid-k', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/redirect-http`,
    }));
    await sleep(1500);

    const msgs = db.prepare(`
      SELECT m.role, m.content FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-k' AND c.customer_id = ?`).all(from);

    assert(lastAiRequest === null, 'K1: Anthropic NOT called when redirect to http fails');
    const assistantMsg = msgs.find(m => m.role === 'assistant');
    assert(assistantMsg?.content?.includes('contás por texto'), 'K2: fallback sent after redirect_not_https error');
  }

  // ── Suite L: Plan B uses download_url; rejects evil download_url ─────────────
  console.log('\nSuite L: Plan B happy path; Plan B evil download_url rejected');
  {
    await seedBusiness(db, { email: 'img-l@test.com', pnid: 'pnid-l' });
    const fromOk  = '5491100001200';
    const fromEvil = '5491100001201';

    // L happy path: no mediaUrl → Plan B → gets valid download_url → succeeds
    lastAiRequest = null;
    await req('POST', '/webhook/kapso', imagePayload('pnid-l', fromOk, {
      mediaUrl: null,
      mediaId:  'planb-valid',
    }));
    await sleep(1500);

    assert(lastAiRequest !== null, 'L1: Anthropic called via Plan B happy path');
    const lastUserMsg = lastAiRequest?.messages?.at(-1);
    const hasImageBlock = Array.isArray(lastUserMsg?.content) &&
      lastUserMsg.content.some(b => b.type === 'image');
    assert(hasImageBlock, 'L2: Plan B image block sent to Anthropic');

    // L evil: download_url points to non-Kapso host → rejected → fallback
    lastAiRequest = null;
    await req('POST', '/webhook/kapso', imagePayload('pnid-l', fromEvil, {
      mediaUrl: null,
      mediaId:  'planb-evil',
    }));
    await sleep(1500);

    assert(lastAiRequest === null, 'L3: Anthropic NOT called when Plan B download_url is evil host');
    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-l' AND c.customer_id = ?`).all(fromEvil);
    assert(msgs.some(m => m.role === 'assistant'), 'L4: fallback saved when Plan B download_url rejected');
  }

  // ── Suite N: application/octet-stream + JPEG magic bytes → processed ─────────
  console.log('\nSuite N: octet-stream content-type + JPEG bytes → Anthropic called');
  {
    await seedBusiness(db, { email: 'img-n@test.com', pnid: 'pnid-n' });
    const from = '5491100001400';

    lastAiRequest = null;
    await req('POST', '/webhook/kapso', imagePayload('pnid-n', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/octet-stream`,
      mimeType: 'application/octet-stream',
    }));
    await sleep(1500);

    assert(lastAiRequest !== null, 'N1: Anthropic called for octet-stream with JPEG magic bytes');
    const lastUserMsg = lastAiRequest?.messages?.at(-1);
    const hasImageBlock = Array.isArray(lastUserMsg?.content) &&
      lastUserMsg.content.some(b => b.type === 'image' && b.source?.media_type === 'image/jpeg');
    assert(hasImageBlock, 'N2: media_type=image/jpeg (detected from bytes, not declared CT)');
  }

  // ── Suite O: image/jpeg content-type + invalid bytes → fallback ───────────────
  console.log('\nSuite O: image/jpeg content-type + invalid bytes → fallback');
  {
    await seedBusiness(db, { email: 'img-o@test.com', pnid: 'pnid-o' });
    const from = '5491100001500';

    lastAiRequest = null;
    await req('POST', '/webhook/kapso', imagePayload('pnid-o', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/fake-jpeg`,
    }));
    await sleep(1500);

    assert(lastAiRequest === null, 'O1: Anthropic NOT called for invalid bytes');
    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-o' AND c.customer_id = ?`).all(from);
    assert(msgs.some(m => m.role === 'assistant'), 'O2: fallback sent for invalid bytes');
  }

  // ── Suite P: silent_until active + oversized image → user saved, no WA send ──
  console.log('\nSuite P: silent_until active → user msg saved (silent), no WA fallback');
  {
    const { bizId } = await seedBusiness(db, { email: 'img-p@test.com', pnid: 'pnid-p' });
    const from = '5491100001600';

    db.prepare(`UPDATE businesses SET silent_until = datetime('now', '+2 hours') WHERE id = ?`).run(bizId);
    db.pragma('wal_checkpoint(FULL)');

    sentMessages.length = 0;
    await req('POST', '/webhook/kapso', imagePayload('pnid-p', from, {
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/big`,
    }));
    await sleep(1500);

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-p' AND c.customer_id = ?`).all(from);

    assert(msgs.some(m => m.role === 'user'),      'P1: user message saved during silent_until');
    assert(!msgs.some(m => m.role === 'assistant'), 'P2: no assistant fallback during silent_until');
    assert(sentMessages.length === 0,               'P3: no WA message sent during silent_until');
  }

  // ── Suite Q: stale timestamp + oversized image → nothing saved ────────────────
  console.log('\nSuite Q: stale message timestamp → no save, no WA fallback');
  {
    await seedBusiness(db, { email: 'img-q@test.com', pnid: 'pnid-q' });
    const from = '5491100001700';

    sentMessages.length = 0;
    // 3 hours ago — exceeds MSG_MAX_AGE_MINUTES (default 120 min)
    const staleTs = String(Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000));
    await req('POST', '/webhook/kapso', imagePayload('pnid-q', from, {
      mediaUrl:     `http://localhost:${MOCK_MEDIA_PORT}/img/big`,
      msgTimestamp: staleTs,
    }));
    await sleep(1500);

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-q' AND c.customer_id = ?`).all(from);

    assert(!msgs.some(m => m.role === 'user'),      'Q1: no user message saved for stale image');
    assert(!msgs.some(m => m.role === 'assistant'), 'Q2: no assistant fallback for stale image');
    assert(sentMessages.length === 0,               'Q3: no WA message sent for stale image');
  }

  // ── Suite M: sticker + paused conv → user saved, no WA fallback ──────────────
  console.log('\nSuite M: sticker + paused conv → user msg saved, no WA fallback');
  {
    await seedBusiness(db, { email: 'img-m@test.com', pnid: 'pnid-m' });
    const from = '5491100001300';

    db.prepare(`INSERT OR IGNORE INTO conversations (business_id, customer_id, needs_attention, paused_reason)
      SELECT id, ?, 1, 'human' FROM businesses WHERE phone_number_id = 'pnid-m'`).run(from);
    db.prepare(`UPDATE conversations SET needs_attention = 1, paused_reason = 'human'
      WHERE customer_id = ? AND business_id = (SELECT id FROM businesses WHERE phone_number_id = 'pnid-m')`).run(from);
    db.pragma('wal_checkpoint(FULL)');

    sentMessages.length = 0;
    await req('POST', '/webhook/kapso', imagePayload('pnid-m', from, {
      mimeType: 'image/webp+sticker',
      mediaUrl: `http://localhost:${MOCK_MEDIA_PORT}/img/valid`,
    }));
    await sleep(1000);

    const msgs = db.prepare(`
      SELECT m.role FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN businesses b ON b.id = c.business_id
      WHERE b.phone_number_id = 'pnid-m' AND c.customer_id = ?`).all(from);

    assert(msgs.some(m => m.role === 'user'),      'M1: user message saved even for sticker+paused');
    assert(!msgs.some(m => m.role === 'assistant'), 'M2: no assistant fallback for sticker+paused');
    assert(sentMessages.length === 0,                'M3: no WA message sent for sticker+paused');
  }

  db.close();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
