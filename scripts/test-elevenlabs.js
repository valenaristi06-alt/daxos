#!/usr/bin/env node
'use strict';
/**
 * Tests for ElevenLabs voice config — Fase 1.
 * Part A: unit tests for ttsBody (body construction by model)
 * Part B: migration 022_voice_config idempotency
 * Part C: server integration — audio webhook with mock EL + mock Meta
 *
 * Run: node scripts/test-elevenlabs.js
 */

const fs            = require('fs');
const path          = require('path');
const http          = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT     = 3108;
const MOCK_EL_PORT  = 3240;
const MOCK_META_PORT = 3241;
const MOCK_AI_PORT  = 3242;
const DB_DIR        = '/tmp/test-elevenlabs';

let serverProc   = null;
let mockElServer = null;
let mockMetaServer = null;
let mockAiServer = null;
let passed = 0;
let failed = 0;

// Minimal valid silent MP3 (0.3 s, 32kbps) — avoids real EL calls in integration tests
const MOCK_MP3_B64 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA/+NIwAAAAAAAAAAAAEluZm8AAAAPAAAABwAACQAAQEBAQEBAQEBAQEBAQEBgYGBgYGBgYGBgYGBgYICAgICAgICAgICAgICAoKCgoKCgoKCgoKCgoKCgwMDAwMDAwMDAwMDAwMDg4ODg4ODg4ODg4ODg4P//////////////////AAAAAExhdmM1OC4xMwAAAAAAAAAAAAAAACQEIAAAAAAAAAkAXC4ylgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+NIxAAAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+NIxAAAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+NIxAAAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+NIxAAAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+NIxAAAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+NIxAAAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+NIxAAAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
const MOCK_MP3 = Buffer.from(MOCK_MP3_B64, 'base64');

function cleanup() {
  if (serverProc)    { try { serverProc.kill();    } catch (_) {} }
  if (mockElServer)  { try { mockElServer.close(); } catch (_) {} }
  if (mockMetaServer){ try { mockMetaServer.close(); } catch (_) {} }
  if (mockAiServer)  { try { mockAiServer.close(); } catch (_) {} }
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

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.join(DB_DIR, 'daxos.db'));
}

function metaPayload(pnid, from, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: pnid },
          messages: [{
            id: `wamid.${Date.now()}${Math.random()}`,
            from, type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

// ════════════════════════════════════════════════════════════════
// PART A — Unit tests: ttsBody by model
// ════════════════════════════════════════════════════════════════

function runUnitTests() {
  console.log('\nPart A — Unit: ttsBody construction by model');

  // Load without .env.local side-effects (API_KEY not needed for pure function tests)
  process.env.ELEVENLABS_API_KEY = 'unit-test-fake';
  const { _ttsBody, _normalizeTtsText } = require('../src/elevenlabs');

  // ── Comparison against origin/main body (Condición 4) ──────────
  // origin/main ttsBody(text) produced exactly:
  //   { text: normalizeTtsText(T), model_id: 'eleven_multilingual_v2', speed: 1.1,
  //     voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true } }
  // New code with voice_tts_model=NULL must produce IDENTICAL body.
  // Text without terminal punctuation so normalizeTtsText adds '.' — matches origin/main behavior
  const TEST_TEXT = 'Hola cómo andás, en qué te puedo ayudar';
  const originMainExpected = {
    text: TEST_TEXT + '.', // normalizeTtsText adds terminal period (no markdown, no terminal punct)
    model_id: 'eleven_multilingual_v2',
    speed: 1.1,
    voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true },
  };
  // NULL model (from DB column = NULL after migration)
  const nullModelFromDB = JSON.parse(_ttsBody(TEST_TEXT, { model: null, stability: null }));
  assert(JSON.stringify(nullModelFromDB) === JSON.stringify(originMainExpected),
    'NULL model: body identical to origin/main (field-by-field)');

  // Undefined opts (call site before Fase 1) — also identical
  const undefOpts = JSON.parse(_ttsBody(TEST_TEXT));
  assert(JSON.stringify(undefOpts) === JSON.stringify(originMainExpected),
    'undefined opts: body identical to origin/main');

  // ── Standard legacy assertions ───────────────────────────────
  const legacyBody = JSON.parse(_ttsBody('Hola cómo andás.'));
  assert(legacyBody.model_id === 'eleven_multilingual_v2', 'legacy: model_id=eleven_multilingual_v2');
  assert(legacyBody.speed === 1.1, 'legacy: speed=1.1');
  assert(legacyBody.voice_settings.style === 0.2, 'legacy: voice_settings.style=0.2');
  assert(legacyBody.voice_settings.stability === 0.5, 'legacy: voice_settings.stability=0.5');
  assert(legacyBody.voice_settings.similarity_boost === 0.85, 'legacy: similarity_boost=0.85');
  assert(legacyBody.voice_settings.use_speaker_boost === true, 'legacy: use_speaker_boost=true');

  // NULL model from business → same as legacy
  const nullModelBody = JSON.parse(_ttsBody('Hola.', { model: null, stability: null }));
  assert(nullModelBody.model_id === 'eleven_multilingual_v2', 'null model: same legacy model_id');
  assert(nullModelBody.voice_settings.style === 0.2, 'null model: has style (legacy)');
  assert(nullModelBody.speed === 1.1, 'null model: has speed (legacy)');

  // Undefined model from business (column not yet set) → same as legacy
  const undefModelBody = JSON.parse(_ttsBody('Hola.', {}));
  assert(undefModelBody.model_id === 'eleven_multilingual_v2', 'undefined model: same legacy model_id');
  assert(undefModelBody.voice_settings.style === 0.2, 'undefined model: has style (legacy)');

  // v4 turbo path
  const v4Body = JSON.parse(_ttsBody('Hola cómo andás.', { model: 'eleven_v4_turbo' }));
  assert(v4Body.model_id === 'eleven_v4_turbo', 'v4: model_id=eleven_v4_turbo');
  assert(v4Body.voice_settings.stability === 0.35, 'v4: stability default=0.35');
  assert(v4Body.voice_settings.similarity_boost === 0.75, 'v4: similarity_boost=0.75');
  assert(!('style' in v4Body.voice_settings), 'v4: no style');
  assert(!('speed' in v4Body), 'v4: no speed');
  assert(!('use_speaker_boost' in v4Body.voice_settings), 'v4: no use_speaker_boost');

  // v4 with custom stability
  const v4Custom = JSON.parse(_ttsBody('Hola.', { model: 'eleven_v4_turbo', stability: 0.3 }));
  assert(v4Custom.voice_settings.stability === 0.3, 'v4 custom stability=0.3');

  // eleven_v4 (not turbo) also takes v4 path
  const v4Full = JSON.parse(_ttsBody('Hola.', { model: 'eleven_v4' }));
  assert(v4Full.model_id === 'eleven_v4', 'eleven_v4: takes v4 path');
  assert(!('style' in v4Full.voice_settings), 'eleven_v4: no style');

  // eleven_multilingual_v2 explicit → NOT v4 → legacy path
  const v2Explicit = JSON.parse(_ttsBody('Hola.', { model: 'eleven_multilingual_v2' }));
  assert(v2Explicit.voice_settings.style === 0.2, 'v2 explicit: legacy path with style');

  // Unknown model → warning + fallback to legacy
  const origError = console.error;
  let warnCaptured = '';
  console.error = (...a) => { warnCaptured += a.join(' '); };
  const unknownModelBody = JSON.parse(_ttsBody('Hola.', { model: 'eleven_turbo_v2_5' }));
  console.error = origError;
  assert(warnCaptured.includes('unknown model'), 'unknown model: warning logged');
  assert(unknownModelBody.voice_settings.style === 0.2, 'unknown model: falls back to legacy (has style)');
  assert(!unknownModelBody.model_id.includes('eleven_turbo_v2_5'), 'unknown model: not passed to EL');

  // voice_stability out of range → warning + default
  warnCaptured = '';
  console.error = (...a) => { warnCaptured += a.join(' '); };
  const badStabilityBody = JSON.parse(_ttsBody('Hola.', { model: 'eleven_v4_turbo', stability: 1.5 }));
  console.error = origError;
  assert(warnCaptured.includes('out of range'), 'stability 1.5: warning logged');
  assert(badStabilityBody.voice_settings.stability === 0.35, 'stability 1.5: falls back to default 0.35');

  // voice_stability negative → warning + default
  warnCaptured = '';
  console.error = (...a) => { warnCaptured += a.join(' '); };
  const negStabilityBody = JSON.parse(_ttsBody('Hola.', { model: 'eleven_v4_turbo', stability: -0.1 }));
  console.error = origError;
  assert(warnCaptured.includes('out of range'), 'stability -0.1: warning logged');
  assert(negStabilityBody.voice_settings.stability === 0.35, 'stability -0.1: falls back to default 0.35');

  // voice_stability 0 and 1 (boundary) → valid
  const stab0 = JSON.parse(_ttsBody('Hola.', { model: 'eleven_v4_turbo', stability: 0 }));
  assert(stab0.voice_settings.stability === 0, 'stability 0: valid boundary');
  const stab1 = JSON.parse(_ttsBody('Hola.', { model: 'eleven_v4_turbo', stability: 1 }));
  assert(stab1.voice_settings.stability === 1, 'stability 1: valid boundary');

  // URL stripping — only in v4 path
  const textWithUrl = 'Visitá www.foo.com más info en https://bar.com/baz para más detalles.';
  const v4WithUrl = JSON.parse(_ttsBody(textWithUrl, { model: 'eleven_v4_turbo' }));
  assert(!v4WithUrl.text.includes('http'), 'v4: URLs stripped from text');
  assert(v4WithUrl.text.includes('Visitá'), 'v4: non-URL text preserved');

  const legacyWithUrl = JSON.parse(_ttsBody(textWithUrl));
  assert(legacyWithUrl.text.includes('http'), 'legacy: URLs NOT stripped');

  // normalizeTtsText without stripUrls preserves URLs
  const norm = _normalizeTtsText('Texto con https://example.com enlace');
  assert(norm.includes('https://'), 'normalizeTtsText: URL preserved when stripUrls=false');

  // normalizeTtsText with stripUrls removes URLs
  const normStripped = _normalizeTtsText('Texto con https://example.com enlace', { stripUrls: true });
  assert(!normStripped.includes('http'), 'normalizeTtsText stripUrls=true: URL removed');
  assert(normStripped.includes('Texto'), 'normalizeTtsText stripUrls=true: text preserved');
}

// ════════════════════════════════════════════════════════════════
// PART B — Migration 022: idempotency on fresh DB
// ════════════════════════════════════════════════════════════════

function runMigrationTests() {
  console.log('\nPart B — Migration 022_voice_config');

  const freshDir = '/tmp/test-elevenlabs-mig';
  try { execSync(`rm -rf ${freshDir}`); } catch (_) {}
  fs.mkdirSync(freshDir, { recursive: true });

  // First run
  process.env.DB_DIR = freshDir;
  // Clear cached db module so it re-initializes with fresh DB_DIR
  delete require.cache[require.resolve('../src/db')];
  require('../src/db');

  const Database = require('better-sqlite3');
  const raw1 = new Database(path.join(freshDir, 'daxos.db'));
  const cols1 = raw1.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
  const mig1 = raw1.prepare("SELECT version FROM schema_migrations WHERE version='022_voice_config'").all();
  raw1.close();

  assert(cols1.includes('voice_tts_model'), 'migration 022: voice_tts_model column added');
  assert(cols1.includes('voice_stability'), 'migration 022: voice_stability column added');
  assert(mig1.length === 1, 'migration 022: exactly 1 row in schema_migrations');

  // Second run (idempotency) — re-require triggers runMigrations again on same DB
  delete require.cache[require.resolve('../src/db')];
  require('../src/db');

  const raw2 = new Database(path.join(freshDir, 'daxos.db'));
  const mig2 = raw2.prepare("SELECT version FROM schema_migrations WHERE version='022_voice_config'").all();
  raw2.close();
  assert(mig2.length === 1, 'migration 022: idempotent — still 1 row after second init');

  try { execSync(`rm -rf ${freshDir}`); } catch (_) {}
}

// ════════════════════════════════════════════════════════════════
// PART C — Integration: audio webhook with mock EL + mock Meta
// ════════════════════════════════════════════════════════════════

async function runIntegrationTests() {
  console.log('\nPart C — Integration: audio webhook path');

  // State captured by mocks
  let lastElRequest = null;   // { voiceId, body }
  let metaCalls = [];         // all calls to mock meta

  // Mock ElevenLabs server
  await new Promise(resolve => {
    mockElServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        // POST /v1/text-to-speech/:voiceId → return silent MP3
        if (req.method === 'POST' && req.url.startsWith('/v1/text-to-speech/')) {
          const voiceId = req.url.split('/')[3];
          try { lastElRequest = { voiceId, body: JSON.parse(body) }; }
          catch { lastElRequest = { voiceId, body }; }
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(MOCK_MP3);
        } else {
          res.writeHead(404); res.end('{}');
        }
      });
    });
    mockElServer.listen(MOCK_EL_PORT, () => resolve());
  });

  // Mock Meta/Graph server
  await new Promise(resolve => {
    mockMetaServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        const call = { method: req.method, url: req.url, body: parsed || body };
        metaCalls.push(call);
        // Media upload
        if (req.method === 'POST' && req.url.includes('/media')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'fake-media-id-test' }));
        // Message send
        } else if (req.method === 'POST' && req.url.includes('/messages')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages: [{ id: 'wamid.test' }] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      });
    });
    mockMetaServer.listen(MOCK_META_PORT, () => resolve());
  });

  // Mock Anthropic server — returns a non-streaming JSON response
  await new Promise(resolve => {
    mockAiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/v1/messages') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hola cómo andás.' }],
            model: 'claude-haiku-4-5-20251001',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5,
                     cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      });
    });
    mockAiServer.listen(MOCK_AI_PORT, () => resolve());
  });

  // Start Daxos server with mocks wired in
  fs.mkdirSync(DB_DIR, { recursive: true });
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT:                  String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET:        'el-test-secret',
      ADMIN_EMAIL:           'admin@el-test.com',
      ADMIN_SET_WA_TOKEN:    'test-admin-voice-token',
      ANTHROPIC_BASE_URL:    `http://localhost:${MOCK_AI_PORT}`,
      ANTHROPIC_API_KEY:     'test-key-not-real',
      ELEVENLABS_API_KEY:    'test-el-key-not-real',
      ELEVENLABS_BASE_URL:   `http://localhost:${MOCK_EL_PORT}`,
      META_GRAPH_BASE_URL:   `http://localhost:${MOCK_META_PORT}`,
      // Disable WA HMAC check for test payloads
      WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('  Server up.');
  await sleep(300);

  // ── Seed helpers ──────────────────────────────────────────────
  async function seedUser(email) {
    const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
    if (r.status !== 200) throw new Error(`register ${email}: ${JSON.stringify(r.body)}`);
    const cookie = r.setCookie?.[0]?.split(';')[0];
    await req('PUT', '/api/business', { name: `Biz-${email}`, plan: 'crecimiento' }, { cookie });
    return cookie;
  }

  const db = openDb();

  function getBusinessByEmail(email) {
    return db.prepare(`
      SELECT b.* FROM businesses b
      JOIN users u ON u.business_id = b.id
      WHERE u.email = ?
    `).get(email);
  }

  function configBusiness(bizId, overrides) {
    const sets = Object.entries(overrides).map(([k]) => `${k} = ?`).join(', ');
    const vals = Object.values(overrides);
    db.prepare(`UPDATE businesses SET ${sets} WHERE id = ?`).run(...vals, bizId);
    db.pragma('wal_checkpoint(FULL)');
  }

  // ── Test C1: v4 path — EL called with correct body ───────────
  {
    console.log('\n  C1: v4 model — EL request body has correct settings');
    const cookie = await seedUser('c1@el-test.com');
    const biz = getBusinessByEmail('c1@el-test.com');
    configBusiness(biz.id, {
      phone_number_id: 'pnid-c1',
      wa_provider:     'meta',
      wa_access_token: 'fake-wa-token',
      wa_connected_at: new Date().toISOString(),
      plan:            'crecimiento',
      plan_paid_at:    new Date().toISOString(),
      response_mode:   'audio',
      voice_id:        'voice-id-c1',
      voice_tts_model: 'eleven_v4_turbo',
      response_delay:  0,
    });

    lastElRequest = null;
    metaCalls = [];
    await req('POST', '/webhook', metaPayload('pnid-c1', '59899000001', 'Hola'));
    await sleep(3000); // allow async webhook processing + EL + convertToOgg

    assert(lastElRequest !== null, 'C1: EL mock was called');
    if (lastElRequest) {
      assert(lastElRequest.voiceId === 'voice-id-c1', 'C1: EL called with correct voice_id');
      assert(lastElRequest.body?.model_id === 'eleven_v4_turbo', 'C1: model_id=eleven_v4_turbo');
      assert(lastElRequest.body?.voice_settings?.stability === 0.35, 'C1: stability=0.35 (default)');
      assert(lastElRequest.body?.voice_settings?.similarity_boost === 0.75, 'C1: similarity_boost=0.75');
      assert(!('style' in (lastElRequest.body?.voice_settings || {})), 'C1: no style in v4 body');
      assert(!('speed' in (lastElRequest.body || {})), 'C1: no speed in v4 body');
      assert(!('use_speaker_boost' in (lastElRequest.body?.voice_settings || {})), 'C1: no use_speaker_boost in v4');
    }
  }

  // ── Test C2: NULL voice_tts_model → legacy body ───────────────
  {
    console.log('\n  C2: voice_tts_model=NULL → legacy body (identical to before Fase 1)');
    const cookie = await seedUser('c2@el-test.com');
    const biz = getBusinessByEmail('c2@el-test.com');
    configBusiness(biz.id, {
      phone_number_id: 'pnid-c2',
      wa_provider:     'meta',
      wa_access_token: 'fake-wa-token',
      wa_connected_at: new Date().toISOString(),
      plan:            'crecimiento',
      plan_paid_at:    new Date().toISOString(),
      response_mode:   'audio',
      voice_id:        'voice-id-c2',
      response_delay:  0,
      // voice_tts_model intentionally not set → NULL → legacy
    });

    lastElRequest = null;
    await req('POST', '/webhook', metaPayload('pnid-c2', '59899000002', 'Hola'));
    await sleep(3000);

    assert(lastElRequest !== null, 'C2: EL mock was called');
    if (lastElRequest) {
      assert(lastElRequest.body?.voice_settings?.style === 0.2, 'C2: NULL model → style=0.2 (legacy)');
      assert(lastElRequest.body?.speed === 1.1, 'C2: NULL model → speed=1.1 (legacy)');
      assert(lastElRequest.body?.voice_settings?.stability === 0.5, 'C2: NULL model → stability=0.5 (legacy)');
      assert(lastElRequest.body?.voice_settings?.use_speaker_boost === true, 'C2: NULL model → use_speaker_boost (legacy)');
    }
  }

  // ── Test C3: custom stability override ───────────────────────
  {
    console.log('\n  C3: voice_stability=0.25 passed through to v4 body');
    const cookie = await seedUser('c3@el-test.com');
    const biz = getBusinessByEmail('c3@el-test.com');
    configBusiness(biz.id, {
      phone_number_id: 'pnid-c3',
      wa_provider:     'meta',
      wa_access_token: 'fake-wa-token',
      wa_connected_at: new Date().toISOString(),
      plan:            'crecimiento',
      plan_paid_at:    new Date().toISOString(),
      response_mode:   'audio',
      voice_id:        'voice-id-c3',
      voice_tts_model: 'eleven_v4_turbo',
      voice_stability: 0.25,
      response_delay:  0,
    });

    lastElRequest = null;
    await req('POST', '/webhook', metaPayload('pnid-c3', '59899000003', 'Hola'));
    await sleep(3000);

    assert(lastElRequest !== null, 'C3: EL mock was called');
    if (lastElRequest) {
      assert(lastElRequest.body?.voice_settings?.stability === 0.25, 'C3: voice_stability=0.25 forwarded');
    }
  }

  // ── Test C4: admin endpoint voice-config ─────────────────────
  {
    console.log('\n  C4: /admin/api/business/:id/voice-config endpoint');
    const adminToken = process.env.ADMIN_SET_WA_TOKEN || 'test-admin-voice-token';

    function adminReq(method, urlPath, body) {
      return new Promise((resolve, reject) => {
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`,
        };
        const r = http.request(
          { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
          (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
              try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
              catch { resolve({ status: res.statusCode, body: data }); }
            });
          }
        );
        r.on('error', reject);
        if (body) r.write(JSON.stringify(body));
        r.end();
      });
    }

    // Seed a business for admin tests
    const c4cookie = await seedUser('c4@el-test.com');
    const c4biz = getBusinessByEmail('c4@el-test.com');
    const c4id = c4biz.id;

    // Set v4_turbo + stability 0.4
    const r1 = await adminReq('POST', `/admin/api/business/${c4id}/voice-config`,
      { voice_tts_model: 'eleven_v4_turbo', voice_stability: 0.4 });
    assert(r1.status === 200, 'C4: set v4_turbo returns 200');
    assert(r1.body?.voice_tts_model === 'eleven_v4_turbo', 'C4: response has voice_tts_model');
    assert(r1.body?.voice_stability === 0.4, 'C4: response has voice_stability');

    // Verify DB updated
    const c4bizAfter = getBusinessByEmail('c4@el-test.com');
    assert(c4bizAfter.voice_tts_model === 'eleven_v4_turbo', 'C4: DB updated voice_tts_model');
    assert(c4bizAfter.voice_stability === 0.4, 'C4: DB updated voice_stability');

    // Clear back to null
    const r2 = await adminReq('POST', `/admin/api/business/${c4id}/voice-config`,
      { voice_tts_model: null, voice_stability: null });
    assert(r2.status === 200, 'C4: clear to null returns 200');
    assert(r2.body?.voice_tts_model === null, 'C4: cleared voice_tts_model is null');

    // Reject invalid model
    const r3 = await adminReq('POST', `/admin/api/business/${c4id}/voice-config`,
      { voice_tts_model: 'eleven_turbo_v2_5' });
    assert(r3.status === 400, 'C4: invalid model returns 400');

    // Reject stability > 1
    const r4 = await adminReq('POST', `/admin/api/business/${c4id}/voice-config`,
      { voice_tts_model: 'eleven_v4_turbo', voice_stability: 1.5 });
    assert(r4.status === 400, 'C4: stability > 1 returns 400');

    // Reject stability < 0
    const r5 = await adminReq('POST', `/admin/api/business/${c4id}/voice-config`,
      { voice_tts_model: 'eleven_v4_turbo', voice_stability: -0.1 });
    assert(r5.status === 400, 'C4: stability < 0 returns 400');

    // eleven_v4 (not turbo) is valid
    const r6 = await adminReq('POST', `/admin/api/business/${c4id}/voice-config`,
      { voice_tts_model: 'eleven_v4', voice_stability: 0.5 });
    assert(r6.status === 200, 'C4: eleven_v4 is valid model');

    // Non-existent business → 404
    const r7 = await adminReq('POST', `/admin/api/business/99999/voice-config`,
      { voice_tts_model: 'eleven_v4_turbo' });
    assert(r7.status === 404, 'C4: unknown business_id → 404');

    // Wrong token → 403
    const r8 = await new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer wrong-token' };
      const r = http.request(
        { hostname: 'localhost', port: TEST_PORT,
          path: `/admin/api/business/${c4id}/voice-config`, method: 'POST', headers },
        (res) => { res.resume(); resolve({ status: res.statusCode }); }
      );
      r.on('error', reject);
      r.write(JSON.stringify({ voice_tts_model: 'eleven_v4_turbo' }));
      r.end();
    });
    assert(r8.status === 403, 'C4: wrong token → 403');
  }

  db.close();
}

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('=== test-elevenlabs ===');

  // Part A — pure unit tests
  runUnitTests();

  // Part B — migration
  runMigrationTests();

  // Reset DB_DIR for Part C (integration)
  process.env.DB_DIR = DB_DIR;
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/elevenlabs')];

  // Part C — integration
  await runIntegrationTests();

  const total = passed + failed;
  console.log(`\n${'='.repeat(40)}`);
  console.log(`${total} tests — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
