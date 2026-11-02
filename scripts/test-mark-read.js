#!/usr/bin/env node
'use strict';
// Tests for markAsRead behavior after point-3 change.
// Uses Kapso webhook path so WA sends are interceptable via KAPSO_API_BASE_URL.
// processIncomingMessage is identical for both providers.
// Run: node scripts/test-mark-read.js

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { execSync, spawn } = require('child_process');

const TEST_PORT   = 3091;
const MOCK_PORT   = 3092;
const DB_DIR      = '/tmp/test-mark-read';
const BASE_URL    = `http://localhost:${TEST_PORT}`;

let serverProc = null;
let mockServer = null;
let passed = 0;
let failed = 0;

// Configurable per test
let nextAiReply  = 'Respuesta normal del bot.';
let failNextSend = false;  // make WA text sends return 500
const waCalls    = [];     // all captured calls to WA API

function cleanup() {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }
  if (mockServer)  { try { mockServer.close(); } catch (_) {} }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
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
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function assert(cond, label, detail) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail !== undefined ? ': ' + String(detail) : ''}`); failed++; }
}

function startMockServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req2, res) => {
      let body = '';
      req2.on('data', c => { body += c; });
      req2.on('end', () => {
        if (req2.url === '/v1/messages') {
          // Anthropic mock
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_test', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: nextAiReply }],
            model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }));
        } else if (req2.method === 'POST') {
          // WA messages endpoint: /kapso/{pnid}/messages
          let parsed = null;
          try { parsed = JSON.parse(body); } catch {}
          if (parsed?.messaging_product === 'whatsapp') waCalls.push({ ...parsed, _at: Date.now() });

          // For "send fails" test: return 500 on text sends only
          const isTextSend = parsed?.type === 'text';
          if (failNextSend && isTextSend) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'mock forced failure' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ messages: [{ id: 'wamid.test' }] }));
          }
        } else {
          res.writeHead(200); res.end('{}');
        }
      });
    });
    mockServer.listen(MOCK_PORT, () => resolve());
  });
}

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.join(DB_DIR, 'daxos.db'));
}

async function seedBusiness(db, opts = {}) {
  const { email, pnid, provider = 'kapso', responseDelay = 0 } = opts;
  const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  if (r.status !== 200) throw new Error(`register: ${JSON.stringify(r.body)}`);
  const cookie = r.setCookie?.[0]?.split(';')[0];
  await req('PUT', '/api/business', { name: 'Mark-Read Test', plan: 'crecimiento' }, { cookie });
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id;
  const bizId  = db.prepare('SELECT business_id FROM users WHERE id = ?').get(userId)?.business_id;
  db.prepare(`UPDATE businesses SET
    phone_number_id = ?, wa_provider = ?,
    wa_connected_at = datetime('now'), plan = 'crecimiento',
    plan_paid_at = datetime('now'), response_delay = ?
    WHERE id = ?`).run(pnid, provider, responseDelay, bizId);
  db.pragma('wal_checkpoint(FULL)');
  return { bizId, pnid };
}

function textPayload(pnid, from, text, msgId) {
  return {
    event: 'whatsapp.message.received',
    phone_number_id: pnid,
    message: {
      id: msgId || `wamid.${Date.now()}${Math.random()}`,
      from, type: 'text', timestamp: String(Math.floor(Date.now() / 1000)),
      text: { body: text },
    },
  };
}

function metaPayload(pnid, from, text, msgId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: pnid },
          messages: [{
            id: msgId || `wamid.${Date.now()}${Math.random()}`,
            from, type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

// {status:'read'} without typing_indicator → plain markAsRead call
function countMarkAsRead(calls) {
  return calls.filter(c => c.status === 'read' && !c.typing_indicator).length;
}

// {status:'read', typing_indicator} → markReadAndTyping call
function countMarkReadAndTyping(calls) {
  return calls.filter(c => c.status === 'read' && !!c.typing_indicator).length;
}

// Returns the _at timestamp of the first text message in calls, or null.
function firstTextAt(calls) {
  return calls.find(c => c.type === 'text')?._at ?? null;
}

function countTextSent(calls) {
  return calls.filter(c => c.type === 'text').length;
}

async function main() {
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(DB_DIR, { recursive: true });

  console.log('Starting mock server...');
  await startMockServer();

  console.log(`Starting app server on port ${TEST_PORT}...`);
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT), DB_DIR,
      SESSION_SECRET:    'mark-read-test-secret',
      ANTHROPIC_BASE_URL: `http://localhost:${MOCK_PORT}`,
      ANTHROPIC_API_KEY:  'test-key-not-real',
      KAPSO_API_KEY:      'test-kapso-key',
      KAPSO_API_BASE_URL: `http://localhost:${MOCK_PORT}/kapso`,
      KAPSO_TEST_ALLOW_LOCALHOST: '1',
      KAPSO_WEBHOOK_SECRET: '',
      META_GRAPH_BASE_URL: `http://localhost:${MOCK_PORT}`,
      META_SYSTEM_TOKEN:   'test-meta-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  const db = openDb();

  // ── Suite 1: mensaje normal → markAsRead llamado una vez, después del envío ──
  console.log('Suite 1: mensaje normal → markAsRead llamado una vez, después del envío');
  {
    const { pnid } = await seedBusiness(db, { email: 'mr1@test.com', pnid: 'pnid-mr1' });
    nextAiReply = 'Hola, ¿en qué te puedo ayudar?';
    failNextSend = false;
    waCalls.length = 0;

    await req('POST', '/webhook/kapso', textPayload(pnid, '5491100000001', 'Hola'));
    await sleep(800);

    const readCalls  = countMarkAsRead(waCalls);
    const textCalls  = countTextSent(waCalls);
    assert(textCalls >= 1,   '1.1 bot envió respuesta de texto', `got ${textCalls}`);
    assert(readCalls === 1,  '1.2 markAsRead llamado exactamente una vez', `got ${readCalls}`);

    // Verify order: text send happens BEFORE markAsRead
    const firstTextIdx = waCalls.findIndex(c => c.type === 'text');
    const firstReadIdx = waCalls.findIndex(c => c.status === 'read');
    assert(firstTextIdx < firstReadIdx, '1.3 markAsRead llega DESPUÉS del envío de texto',
      `textIdx=${firstTextIdx} readIdx=${firstReadIdx}`);
  }
  console.log();

  // ── Suite 2: [NEEDS_HUMAN] → markAsRead NO llamado ──────────────────────────
  console.log('Suite 2: [NEEDS_HUMAN] → markAsRead NO llamado (derivación)');
  {
    const { pnid } = await seedBusiness(db, { email: 'mr2@test.com', pnid: 'pnid-mr2' });
    nextAiReply = '[NEEDS_HUMAN]\nTe paso con alguien del equipo ahora.';
    failNextSend = false;
    waCalls.length = 0;

    await req('POST', '/webhook/kapso', textPayload(pnid, '5491100000002', 'Quiero hablar con una persona'));
    await sleep(800);

    const readCalls = countMarkAsRead(waCalls);
    const textCalls = countTextSent(waCalls);
    assert(textCalls >= 1,  '2.1 bot envió respuesta de texto antes de derivar', `got ${textCalls}`);
    assert(readCalls === 0, '2.2 markAsRead NO llamado en derivación', `got ${readCalls}`);
  }
  console.log();

  // ── Suite 3: envío falla → markAsRead NO llamado ─────────────────────────────
  console.log('Suite 3: envío falla → markAsRead NO llamado');
  {
    const { pnid } = await seedBusiness(db, { email: 'mr3@test.com', pnid: 'pnid-mr3' });
    nextAiReply = 'Esta respuesta no llegará porque el envío falla.';
    failNextSend = true;
    waCalls.length = 0;

    await req('POST', '/webhook/kapso', textPayload(pnid, '5491100000003', 'Hola'));
    await sleep(800);

    failNextSend = false;
    const readCalls = countMarkAsRead(waCalls);
    assert(readCalls === 0, '3.1 markAsRead NO llamado cuando sendWhatsAppMessage falla', `got ${readCalls}`);
  }
  console.log();

  // ── Suite 4: booking flow ([WANTS_BOOKING]) → respuesta enviada → markAsRead sí ──
  console.log('Suite 4: WANTS_BOOKING → reply enviado → markAsRead llamado');
  {
    const { bizId, pnid } = await seedBusiness(db, { email: 'mr4@test.com', pnid: 'pnid-mr4' });
    db.prepare('UPDATE businesses SET booking_enabled = 1 WHERE id = ?').run(bizId);
    db.pragma('wal_checkpoint(FULL)');

    nextAiReply = '[WANTS_BOOKING]\n¿Cuál es tu nombre completo para el turno?';
    failNextSend = false;
    waCalls.length = 0;

    await req('POST', '/webhook/kapso', textPayload(pnid, '5491100000004', 'Quiero sacar un turno'));
    await sleep(800);

    const readCalls = countMarkAsRead(waCalls);
    const textCalls = countTextSent(waCalls);
    assert(textCalls >= 1,  '4.1 bot envió respuesta de turno', `got ${textCalls}`);
    assert(readCalls === 1, '4.2 markAsRead llamado en booking (no es derivación)', `got ${readCalls}`);
  }
  console.log();

  // ── Suite 5: Meta normal → markReadAndTyping 1×, markAsRead 0× ──────────────
  console.log('Suite 5: Meta — markReadAndTyping 1×, markAsRead 0× (_readAndTypingDone guard)');
  {
    const { pnid } = await seedBusiness(db, { email: 'mr5@test.com', pnid: 'pnid-mr5', provider: 'meta' });
    nextAiReply = 'Respuesta normal del bot.';
    failNextSend = false;
    waCalls.length = 0;

    await req('POST', '/webhook', metaPayload(pnid, '5491100000005', 'Hola'));
    // Timing: markReadAndTyping fires, then sleeps _typingMs (1-3 s) before first send.
    await sleep(4000);

    const readTypingCalls = countMarkReadAndTyping(waCalls);
    const markAsReadCalls = countMarkAsRead(waCalls);
    const textCalls       = countTextSent(waCalls);
    assert(textCalls >= 1,        '5.1 bot envió respuesta de texto', `got ${textCalls}`);
    assert(readTypingCalls === 1, '5.2 markReadAndTyping llamado exactamente 1 vez', `got ${readTypingCalls}`);
    assert(markAsReadCalls === 0, '5.3 markAsRead NO llamado (_readAndTypingDone=true)', `got ${markAsReadCalls}`);
    // markReadAndTyping must arrive before the text send
    const markIdx = waCalls.findIndex(c => c.status === 'read' && !!c.typing_indicator);
    const textIdx = waCalls.findIndex(c => c.type === 'text');
    assert(markIdx < textIdx, '5.4 markReadAndTyping antes del envío de texto',
      `markIdx=${markIdx} textIdx=${textIdx}`);
  }
  console.log();

  // ── Suite 6: Meta + [NEEDS_HUMAN] → ninguna llamada de read ──────────────────
  console.log('Suite 6: Meta + [NEEDS_HUMAN] → markReadAndTyping 0×, markAsRead 0×');
  {
    const { pnid } = await seedBusiness(db, { email: 'mr6@test.com', pnid: 'pnid-mr6', provider: 'meta' });
    nextAiReply = '[NEEDS_HUMAN]\nTe paso con alguien del equipo ahora.';
    failNextSend = false;
    waCalls.length = 0;

    await req('POST', '/webhook', metaPayload(pnid, '5491100000006', 'Quiero hablar con una persona'));
    await sleep(4000);

    const readTypingCalls = countMarkReadAndTyping(waCalls);
    const markAsReadCalls = countMarkAsRead(waCalls);
    assert(readTypingCalls === 0, '6.1 markReadAndTyping NO llamado (needsHuman)', `got ${readTypingCalls}`);
    assert(markAsReadCalls === 0, '6.2 markAsRead NO llamado (needsHuman)', `got ${markAsReadCalls}`);
  }
  console.log();

  // ── Suites 7-9: response_delay enforcement ───────────────────────────────────
  // These verify that no message reaches WA before _delayEnd regardless of provider
  // or needsHuman flag. (b) and (c) fail without the else-branch in server.js that
  // enforces the delay for non-Meta/needsHuman paths.
  const DELAY_S = 2;
  const DELAY_MS = DELAY_S * 1000;
  const DELAY_TOLERANCE = 300; // ms below delayEnd still accepted (CI headroom)

  // Suite 7: Meta normal, delay=2s — message must not arrive before delayEnd.
  // Passes with both old and new code (Meta timing logic already enforces delay);
  // included for completeness and to catch future regressions.
  console.log(`Suite 7: Meta normal, delay=${DELAY_S}s → texto no antes de delayEnd`);
  {
    const { pnid } = await seedBusiness(db, {
      email: 'mr7@test.com', pnid: 'pnid-mr7', provider: 'meta', responseDelay: DELAY_S,
    });
    nextAiReply = 'Respuesta normal del bot.';
    failNextSend = false;
    waCalls.length = 0;

    const sentAt = Date.now();
    await req('POST', '/webhook', metaPayload(pnid, '5491100000007', 'Hola'));
    await sleep(6000); // 2s delay + up to 3s typing + margin

    const textTs = firstTextAt(waCalls);
    assert(textTs != null, '7.1 bot envió texto', `calls=${waCalls.length}`);
    assert(
      textTs != null && textTs - sentAt >= DELAY_MS - DELAY_TOLERANCE,
      `7.2 Meta normal: texto llega >= ${DELAY_MS - DELAY_TOLERANCE}ms tras webhook`,
      `elapsed=${textTs != null ? textTs - sentAt : 'N/A'}ms`,
    );
  }
  console.log();

  // Suite 8: Meta + [NEEDS_HUMAN], delay=2s — fails without else-branch.
  console.log(`Suite 8: Meta+[NEEDS_HUMAN], delay=${DELAY_S}s → texto no antes de delayEnd`);
  {
    const { pnid } = await seedBusiness(db, {
      email: 'mr8@test.com', pnid: 'pnid-mr8', provider: 'meta', responseDelay: DELAY_S,
    });
    nextAiReply = '[NEEDS_HUMAN]\nTe paso con alguien del equipo ahora.';
    failNextSend = false;
    waCalls.length = 0;

    const sentAt = Date.now();
    await req('POST', '/webhook', metaPayload(pnid, '5491100000008', 'Quiero hablar con una persona'));
    await sleep(4000);

    const textTs = firstTextAt(waCalls);
    assert(textTs != null, '8.1 bot envió texto', `calls=${waCalls.length}`);
    assert(
      textTs != null && textTs - sentAt >= DELAY_MS - DELAY_TOLERANCE,
      `8.2 Meta+needsHuman: texto llega >= ${DELAY_MS - DELAY_TOLERANCE}ms tras webhook`,
      `elapsed=${textTs != null ? textTs - sentAt : 'N/A'}ms`,
    );
  }
  console.log();

  // Suite 9: Kapso, delay=2s — fails without else-branch.
  console.log(`Suite 9: Kapso, delay=${DELAY_S}s → texto no antes de delayEnd`);
  {
    const { pnid } = await seedBusiness(db, {
      email: 'mr9@test.com', pnid: 'pnid-mr9', provider: 'kapso', responseDelay: DELAY_S,
    });
    nextAiReply = 'Respuesta Kapso normal.';
    failNextSend = false;
    waCalls.length = 0;

    const sentAt = Date.now();
    await req('POST', '/webhook/kapso', textPayload(pnid, '5491100000009', 'Hola'));
    await sleep(4000);

    const textTs = firstTextAt(waCalls);
    assert(textTs != null, '9.1 bot envió texto', `calls=${waCalls.length}`);
    assert(
      textTs != null && textTs - sentAt >= DELAY_MS - DELAY_TOLERANCE,
      `9.2 Kapso: texto llega >= ${DELAY_MS - DELAY_TOLERANCE}ms tras webhook`,
      `elapsed=${textTs != null ? textTs - sentAt : 'N/A'}ms`,
    );
  }
  console.log();

  // Suite 10: Meta, delay=0 → no typing wait, text arrives < 500ms.
  // Fails without the delayMs > 0 guard (sleep(_typingMs) fires even with delay=0).
  console.log('Suite 10: Meta, delay=0 → texto llega < 500ms (sin espera de escribiendo)');
  {
    const { pnid } = await seedBusiness(db, {
      email: 'mr10@test.com', pnid: 'pnid-mr10', provider: 'meta', responseDelay: 0,
    });
    nextAiReply = 'Respuesta rápida.';
    failNextSend = false;
    waCalls.length = 0;

    const sentAt = Date.now();
    await req('POST', '/webhook', metaPayload(pnid, '5491100000010', 'Hola'));
    await sleep(2000);

    const textTs = firstTextAt(waCalls);
    assert(textTs != null, '10.1 bot envió texto', `calls=${waCalls.length}`);
    assert(
      textTs != null && textTs - sentAt < 500,
      '10.2 Meta delay=0: texto llega < 500ms (sin sleep de typing)',
      `elapsed=${textTs != null ? textTs - sentAt : 'N/A'}ms`,
    );
  }
  console.log();

  console.log('──────────────────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('[fatal]', err.message); cleanup(); process.exit(1); });
