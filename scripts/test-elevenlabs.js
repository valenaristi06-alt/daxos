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

  // ── Default body = natural-voice recipe (blind test 26/11) ──────
  // NULL model → multilingual_v2, stability 0.45, similarity 0.85, style 0.3, speed 1.1
  // (speed inside voice_settings: a top-level "speed" is ignored by ElevenLabs).
  // Text without terminal punctuation so normalizeTtsText adds '.' — matches origin/main behavior
  const TEST_TEXT = 'Hola cómo andás, en qué te puedo ayudar';
  const originMainExpected = {
    text: TEST_TEXT + '.', // normalizeTtsText adds terminal period (no markdown, no terminal punct)
    model_id: 'eleven_multilingual_v2',
    // speed lives inside voice_settings: ElevenLabs ignores a top-level "speed" (fixed 26/11)
    voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true, speed: 1.1 },
  };
  // NULL model (from DB column = NULL after migration)
  const nullModelFromDB = JSON.parse(_ttsBody(TEST_TEXT, { model: null, stability: null }));
  assert(JSON.stringify(nullModelFromDB) === JSON.stringify(originMainExpected),
    'NULL model: body = natural recipe (field-by-field)');

  // Undefined opts (call site before Fase 1) — also identical
  const undefOpts = JSON.parse(_ttsBody(TEST_TEXT));
  assert(JSON.stringify(undefOpts) === JSON.stringify(originMainExpected),
    'undefined opts: body = natural recipe');

  // ── Owner presets: speed, tone, pronunciations ──────────────
  const videos = JSON.parse(_ttsBody('Hola.', { tone: 'expresiva', speed: 'rapida' }));
  assert(videos.voice_settings.stability === 0.35 && videos.voice_settings.style === 0.45, 'tone expresiva: stability 0.35 / style 0.45');
  assert(videos.voice_settings.speed === 1.18, 'speed rapida: 1.18');
  const calm = JSON.parse(_ttsBody('Hola.', { tone: 'tranquila', speed: 'lenta' }));
  assert(calm.voice_settings.stability === 0.6 && calm.voice_settings.style === 0.15 && calm.voice_settings.speed === 1.0, 'tranquila + lenta');
  const junk = JSON.parse(_ttsBody('Hola.', { tone: 'gritona', speed: 'x' }));
  assert(JSON.stringify(junk.voice_settings) === JSON.stringify(originMainExpected.voice_settings), 'unknown presets: default settings');
  const adminWins = JSON.parse(_ttsBody('Hola.', { tone: 'expresiva', stability: 0.7 }));
  assert(adminWins.voice_settings.stability === 0.7, 'admin stability overrides tone preset');
  const pron = JSON.parse(_ttsBody('El HIFU y el hifu-x, hifux.', { pronunciations: JSON.stringify([{ de: 'hifu', a: 'jifu' }]) }));
  assert(pron.text === 'El jifu y el jifu-x, hifux.', 'pronunciations: whole word, case-insensitive');
  const { _applyPronunciations } = require('../src/elevenlabs');
  assert(_applyPronunciations('Ácido hialurónico', [{ de: 'ácido', a: 'asido' }]) === 'asido hialurónico', 'pronunciations: accents');
  assert(_applyPronunciations('a.b axb', [{ de: 'a.b', a: 'ok' }]) === 'ok axb', 'pronunciations: regex chars escaped');
  assert(_applyPronunciations('hola', 'not json') === 'hola', 'pronunciations: bad JSON ignored');


  // ── Natural-voice recipe (receta A, variante 1) ─────────────
  const el = require('../src/elevenlabs');
  const sp = el._splitSentences('Hola, ¿cómo andás? Mañana a las tres tenemos lugar. ¿Te lo agendo?');
  assert(sp.length === 3, 'split: 3 sentences');
  assert(sp[1] === 'Mañana a las tres tenemos lugar.', 'split: sentence kept with its period');
  const ab = el._splitSentences('El Dr. García atiende los martes. Dale');
  assert(ab.length === 1 && ab[0] === 'El Dr. García atiende los martes. Dale.', 'split: "Dr." is not a sentence end; short tail merged; final period added');
  assert(el._splitSentences('Sin punto final').join('|') === 'Sin punto final.', 'split: adds the closing period');
  assert(el._splitSentences('').length === 0, 'split: empty text → no sentences');
  const many = el._splitSentences(Array.from({ length: 12 }, (_, i) => `Frase número ${i + 1} de prueba.`).join(' '));
  assert(many.length === 8, 'split: at most 8 sentences');
  assert(el._wordSimilarity('Te lo agendo.', 'te lo agendo') === 1, 'similarity: same words (case/punct) = 1');
  assert(el._wordSimilarity('Te lo agendo.', 'te la gendo') < 0.5, 'similarity: different words < 0.5');
  // takes as mp3 128 kbps: 16000 bytes per second
  const sec = x => Buffer.alloc(Math.round(x * 16000));
  const mid = 'Mañana a las tres y media tenemos lugar.'; // 40 chars → expected ≈ 2.09 s at 1.1
  assert(Math.abs(el._expectedSeconds(mid, 1.1) - 2.09) < 0.01, 'expected duration at 1.1 ≈ 2.09 s for 40 chars');
  assert(el._expectedSeconds(mid, 1.0) > el._expectedSeconds(mid, 1.1), 'slower speed → longer expected duration');
  // real calibration takes for this sentence: 2.07 2.20 1.94 2.38 — all transcribed perfectly
  assert(el._pickBestTake(mid, [sec(2.07), sec(2.20), sec(1.94), sec(2.38)], [mid, mid, mid, mid], 1.1) === 0,
    'pick: equal transcriptions → closest to the expected duration (2.07 s, not the dragged 2.38 s)');
  assert(el._pickBestTake(mid, [sec(2.40), sec(2.05), sec(2.10), sec(2.60)], [mid, 'mañana a las', mid, mid], 1.1) === 2,
    'pick: a bad transcription is out even if its duration is perfect');
  assert(el._pickBestTake(mid, [sec(2.9), sec(2.5), sec(3.1), sec(2.7)], [mid, mid, mid, mid], 1.1) === 1,
    'pick: all takes dragged → the least dragged one');
  assert(el._pickBestTake(mid, [sec(2.6), sec(2.05), sec(2.3), sec(2.5)], [null, null, null, null], 1.1) === 1,
    'pick: all transcriptions failed → still chosen by duration');
  // credits → takes
  assert(el.planTakes({ known: true, exhausted: false, remaining: 900, remainingRatio: 0.9 }, 100).takes === 4, 'credits 90% left → 4 takes');
  assert(el.planTakes({ known: true, exhausted: false, remaining: 150, remainingRatio: 0.15 }, 100).takes === 1, 'credits 15% left → 1 take');
  assert(el.planTakes({ known: true, exhausted: true, remaining: 0, remainingRatio: 0 }, 100).mode === 'text', 'credits exhausted → text');
  assert(el.planTakes({ known: true, exhausted: false, remaining: 50, remainingRatio: 0.0001 }, 100).mode === 'text', 'credits not enough for this reply → text');
  assert(el.planTakes({ known: false, exhausted: false }, 100).takes === 4, 'credits unknown → full recipe');

  // recipe body is pinned: multilingual_v2 and 0.45 even with an old admin stability / v4 model
  const nb = JSON.parse(_ttsBody('Hola.', el._naturalOpts({ model: 'eleven_v4_turbo', stability: 0.35 })));
  assert(nb.model_id === 'eleven_multilingual_v2', 'recipe: model pinned to multilingual_v2');
  assert(nb.voice_settings.stability === 0.45 && nb.voice_settings.similarity_boost === 0.85 && nb.voice_settings.style === 0.3
    && nb.voice_settings.speed === 1.1 && nb.voice_settings.use_speaker_boost === true && !('speed' in nb),
    'recipe: 0.45 / 0.85 / 0.3, speed 1.1 inside voice_settings, admin stability ignored');

  // ── Instrucciones de voz ────────────────────────────────────
  const cl = require('../src/claude');
  const vi = cl.parseVoiceInstructionsResult('{"velocidad":"rapida","tono":"expresiva","escritura":"Cercano y uruguayo, sin muletillas."}');
  assert(vi.voice_speed === 'rapida' && vi.voice_tone === 'expresiva', 'instructions: presets mapped');
  assert(vi.resumen === 'Velocidad: más rápida. Tono: expresiva. Al hablar: cercano y uruguayo, sin muletillas.', 'instructions: summary shown to owner');
  const viBad = cl.parseVoiceInstructionsResult('{"velocidad":"turbo","tono":"gritona"}');
  assert(viBad.voice_speed === null && viBad.voice_tone === null && viBad.resumen === '', 'instructions: unknown presets ignored');
  assert(cl.parseVoiceInstructionsResult('no json').resumen === '', 'instructions: bad model output → nothing understood');
  assert(cl.buildVoiceInstructionsPrompt('hablá rápido').includes('<instrucciones>\nhablá rápido\n</instrucciones>'), 'instructions: owner text fenced in prompt');
  const bizV = { name: 'X', voice_id: 'v1', voice_instructions: 'tono cercano y uruguayo', response_mode: 'audio' };
  const withAudio = cl.buildSystemPrompt(bizV, null, null, { forAudio: true });
  const sysText = s => JSON.stringify(s);
  assert(sysText(withAudio).includes('tono cercano y uruguayo') && sysText(withAudio).includes('NOTA DE VOZ'), 'prompt: voice instructions when reply is audio');
  assert(!sysText(cl.buildSystemPrompt(bizV, null, null, { forAudio: false })).includes('tono cercano y uruguayo'), 'prompt: no voice instructions for text replies');

  // ── Standard legacy assertions ───────────────────────────────
  const legacyBody = JSON.parse(_ttsBody('Hola cómo andás.'));
  assert(legacyBody.model_id === 'eleven_multilingual_v2', 'legacy: model_id=eleven_multilingual_v2');
  assert(legacyBody.voice_settings.speed === 1.1 && !('speed' in legacyBody), 'legacy: voice_settings.speed=1.1 (not top-level)');
  assert(legacyBody.voice_settings.style === 0.3, 'default: voice_settings.style=0.3');
  assert(legacyBody.voice_settings.stability === 0.45, 'default: voice_settings.stability=0.45');
  assert(legacyBody.voice_settings.similarity_boost === 0.85, 'legacy: similarity_boost=0.85');
  assert(legacyBody.voice_settings.use_speaker_boost === true, 'legacy: use_speaker_boost=true');

  // NULL model from business → same as legacy
  const nullModelBody = JSON.parse(_ttsBody('Hola.', { model: null, stability: null }));
  assert(nullModelBody.model_id === 'eleven_multilingual_v2', 'null model: same legacy model_id');
  assert(nullModelBody.voice_settings.style === 0.3, 'null model: has style (recipe)');
  assert(nullModelBody.voice_settings.speed === 1.1, 'null model: has speed (legacy)');

  // Undefined model from business (column not yet set) → same as legacy
  const undefModelBody = JSON.parse(_ttsBody('Hola.', {}));
  assert(undefModelBody.model_id === 'eleven_multilingual_v2', 'undefined model: same legacy model_id');
  assert(undefModelBody.voice_settings.style === 0.3, 'undefined model: has style (recipe)');

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
  assert(v2Explicit.voice_settings.style === 0.3, 'v2 explicit: recipe path with style');

  // Unknown model → warning + fallback to legacy
  const origError = console.error;
  let warnCaptured = '';
  console.error = (...a) => { warnCaptured += a.join(' '); };
  const unknownModelBody = JSON.parse(_ttsBody('Hola.', { model: 'eleven_turbo_v2_5' }));
  console.error = origError;
  assert(warnCaptured.includes('unknown model'), 'unknown model: warning logged');
  assert(unknownModelBody.voice_settings.style === 0.3, 'unknown model: falls back to default (has style)');
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
  let elTtsRequests = [];     // every TTS call
  let elSttCount = 0;
  let aiReplyText = 'Hola cómo andás.';
  let metaCalls = [];         // all calls to mock meta
  // Mutable ElevenLabs account subscription (for the 80% admin alert tests)
  let elSubscription = { character_count: 0, character_limit: 1000000, next_character_count_reset_unix: 1111 };

  // Mock ElevenLabs server
  await new Promise(resolve => {
    mockElServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        // POST /v1/text-to-speech/:voiceId → return silent MP3
        if (req.method === 'POST' && req.url.startsWith('/v1/text-to-speech/')) {
          const voiceId = req.url.split('/')[3].split('?')[0];
          try { lastElRequest = { voiceId, body: JSON.parse(body) }; }
          catch { lastElRequest = { voiceId, body }; }
          elTtsRequests.push(lastElRequest);
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(MOCK_MP3);
        } else if (req.method === 'POST' && req.url === '/v1/speech-to-text') {
          elSttCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'texto transcripto' }));
        } else if (req.method === 'GET' && req.url.startsWith('/v1/voices/')) {
          const id = req.url.split('/')[3];
          const voices = { libraryVoice1234: { voice_id: 'libraryVoice1234', name: 'Lib Voice', category: 'premade' },
                           cloneVoice12345:  { voice_id: 'cloneVoice12345',  name: 'Alguien', category: 'cloned' } };
          if (voices[id]) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(voices[id])); }
          else { res.writeHead(404); res.end('{}'); }
        } else if (req.method === 'GET' && req.url === '/v1/user/subscription') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(elSubscription));
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
            content: [{ type: 'text', text: aiReplyText }],
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

  // ── Test C1b: owner voice settings + catalog ─────────────────
  {
    console.log('\n  C1b: owner saves speed/tone/pronunciations; catalog voice');
    const cookie = await seedUser('c1b@el-test.com');
    const biz = getBusinessByEmail('c1b@el-test.com');
    configBusiness(biz.id, {
      phone_number_id: 'pnid-c1b', wa_provider: 'meta', wa_access_token: 'fake-wa-token',
      wa_connected_at: new Date().toISOString(), plan: 'crecimiento', plan_paid_at: new Date().toISOString(),
      response_mode: 'audio', voice_id: 'voice-id-c1b', response_delay: 0,
    });

    const bad = await req('PUT', '/api/business/voice/settings', { voice_tone: 'gritona' }, { cookie });
    assert(bad.status === 400, 'C1b: unknown tone rejected');
    const ok = await req('PUT', '/api/business/voice/settings', {
      voice_speed: 'rapida', voice_tone: 'expresiva', voice_pronunciations: [{ de: 'HIFU', a: 'jifu' }],
    }, { cookie });
    assert(ok.status === 200, 'C1b: settings saved');
    const row = db.prepare('SELECT voice_speed, voice_tone, voice_pronunciations FROM businesses WHERE id = ?').get(biz.id);
    assert(row.voice_speed === 'rapida' && row.voice_tone === 'expresiva', 'C1b: speed/tone stored');
    assert(JSON.parse(row.voice_pronunciations)[0].a === 'jifu', 'C1b: pronunciations stored');

    const cat = await req('GET', '/api/voice-catalog', null, { cookie });
    assert(cat.status === 200 && cat.body.voices.length >= 2, 'C1b: catalog listed');
    assert(!cat.body.voices.some(v => v.id === 'qRJbiqbavxXPG4xzVAYS' || v.id === 'JtLxORajLGYcUUERfNcK'),
      'C1b: Vale\'s clone is not in the catalog');
    const notCat = await req('POST', '/api/business/voice/catalog', { voice_id: 'qRJbiqbavxXPG4xzVAYS' }, { cookie });
    assert(notCat.status === 400, 'C1b: non-catalog voice rejected');
    const pick = await req('POST', '/api/business/voice/catalog', { voice_id: cat.body.voices[0].id }, { cookie });
    assert(pick.status === 200, 'C1b: catalog voice picked');
    const after = db.prepare('SELECT voice_id FROM businesses WHERE id = ?').get(biz.id);
    assert(after.voice_id === cat.body.voices[0].id, 'C1b: business now uses the catalog voice');
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
      assert(lastElRequest.body?.voice_settings?.style === 0.3, 'C2: NULL model → style=0.3 (recipe)');
      assert(lastElRequest.body?.voice_settings?.speed === 1.1, 'C2: NULL model → voice_settings.speed=1.1 (legacy)');
      assert(lastElRequest.body?.voice_settings?.stability === 0.45, 'C2: NULL model → stability=0.45 (recipe)');
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

  // Bearer-admin request helper (reused by C5–C7)
  const adminToken = process.env.ADMIN_SET_WA_TOKEN || 'test-admin-voice-token';
  function adminReq(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` };
      const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
      });
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }

  function seedTtsCharsThisMonth(bizId, chars) {
    db.prepare("INSERT INTO claude_usage (business_id, model, input_tokens, output_tokens, tts_chars, created_at) VALUES (?, 'test', 0, 0, ?, datetime('now'))").run(bizId, chars);
    db.pragma('wal_checkpoint(FULL)');
  }

  // ── Test C5: monthly audio cap hit → replies in TEXT + owner notified once ──
  {
    console.log('\n  C5: monthly audio $ cap hit → text fallback + owner notice');
    await seedUser('c5@el-test.com');
    const biz = getBusinessByEmail('c5@el-test.com');
    configBusiness(biz.id, {
      phone_number_id: 'pnid-c5', wa_provider: 'meta', wa_access_token: 'fake-wa-token',
      wa_connected_at: new Date().toISOString(), plan: 'crecimiento', plan_paid_at: new Date().toISOString(),
      response_mode: 'audio', voice_id: 'voice-id-c5', response_delay: 0, // multilingual_v2 → $0.18/1k
    });
    // crecimiento cap = $10 → at $0.18/1k that's ~55.5k chars. Seed 60k → over cap.
    seedTtsCharsThisMonth(biz.id, 60000);

    lastElRequest = null; metaCalls = [];
    await req('POST', '/webhook', metaPayload('pnid-c5', '59899000005', 'Hola'));
    await sleep(3000);

    assert(lastElRequest === null, 'C5: EL TTS NOT called (audio over monthly cap)');
    const textSent = metaCalls.some(c => c.url.includes('/messages') && c.body?.type === 'text');
    assert(textSent, 'C5: a text message was sent (bot never goes silent)');
    const c5after = getBusinessByEmail('c5@el-test.com');
    const nowMonth = new Date().toISOString().slice(0, 7);
    assert(c5after.audio_cap_notified_month === nowMonth, 'C5: owner notified flag set for this month');
  }

  // ── Test C6: turbo stretches further → same chars NOT capped ──
  {
    console.log('\n  C6: turbo ($0.04/1k) — same 60k chars stays under the $10 cap');
    await seedUser('c6@el-test.com');
    const biz = getBusinessByEmail('c6@el-test.com');
    configBusiness(biz.id, {
      phone_number_id: 'pnid-c6', wa_provider: 'meta', wa_access_token: 'fake-wa-token',
      wa_connected_at: new Date().toISOString(), plan: 'crecimiento', plan_paid_at: new Date().toISOString(),
      response_mode: 'audio', voice_id: 'voice-id-c6', voice_tts_model: 'eleven_v4_turbo', response_delay: 0,
    });
    seedTtsCharsThisMonth(biz.id, 60000); // 60k × $0.04/1k = $2.4 < $10 → audio still allowed

    lastElRequest = null; metaCalls = [];
    await req('POST', '/webhook', metaPayload('pnid-c6', '59899000006', 'Hola'));
    await sleep(3000);

    assert(lastElRequest !== null, 'C6: EL TTS called (turbo keeps it under cap)');
    if (lastElRequest) assert(lastElRequest.body?.model_id === 'eleven_v4_turbo', 'C6: used turbo model');
  }

  // ── Test C7: ElevenLabs account 80% → admin alert, once per period ──
  {
    console.log('\n  C7: ElevenLabs 80% usage → admin alert (once per period)');
    elSubscription = { character_count: 850000, character_limit: 1000000, next_character_count_reset_unix: 2222 };
    const r1 = await adminReq('POST', '/admin/api/run-elevenlabs-check');
    assert(r1.status === 200 && r1.body.alerted === true, 'C7: 85% → alerted=true');
    assert(Math.abs(r1.body.pct - 0.85) < 1e-6, 'C7: pct reported = 0.85');

    const r2 = await adminReq('POST', '/admin/api/run-elevenlabs-check');
    assert(r2.status === 200 && r2.body.alerted === false, 'C7: same period again → not re-alerted');

    // New billing period + still ≥80% → alerts again
    elSubscription = { character_count: 900000, character_limit: 1000000, next_character_count_reset_unix: 3333 };
    const r3 = await adminReq('POST', '/admin/api/run-elevenlabs-check');
    assert(r3.status === 200 && r3.body.alerted === true, 'C7: new period ≥80% → alerts again');

    // Below 80% → no alert
    elSubscription = { character_count: 500000, character_limit: 1000000, next_character_count_reset_unix: 3333 };
    const r4 = await adminReq('POST', '/admin/api/run-elevenlabs-check');
    assert(r4.status === 200 && r4.body.alerted === false, 'C7: 50% → no alert');

    // Wrong token → 403
    const r5 = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: '/admin/api/run-elevenlabs-check', method: 'POST', headers: { 'Authorization': 'Bearer wrong' } }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
      r.on('error', reject); r.end();
    });
    assert(r5.status === 403, 'C7: wrong token → 403');
  }

  // ── C8: NULL model → natural recipe in the real webhook ──────
  {
    console.log('\n  C8: natural recipe — 4 takes per sentence, prev/next text, no next on the last');
    elSubscription = { character_count: 0, character_limit: 1000000, next_character_count_reset_unix: 5555 };
    await adminReq('POST', '/admin/api/run-elevenlabs-check');
    const cookie = await seedUser('c8@el-test.com');
    const biz = getBusinessByEmail('c8@el-test.com');
    configBusiness(biz.id, {
      phone_number_id: 'pnid-c8', wa_provider: 'meta', wa_access_token: 'fake-wa-token',
      wa_connected_at: new Date().toISOString(), plan: 'crecimiento', plan_paid_at: new Date().toISOString(),
      response_mode: 'audio', voice_id: 'voice-id-c8', response_delay: 0,
      voice_stability: 0.25, // v4-era admin override: the recipe must ignore it
    });
    aiReplyText = 'Dale, quedó confirmado para el martes. Te mando un recordatorio el día antes. Cualquier cosa me avisás por acá.';
    elTtsRequests = []; elSttCount = 0;
    await req('POST', '/webhook', metaPayload('pnid-c8', '59899000008', 'Hola'));
    await sleep(4000);
    const voiceReqs = elTtsRequests.filter(r => r.voiceId === 'voice-id-c8');
    assert(voiceReqs.length === 12, `C8: 3 sentences × 4 takes = 12 TTS calls (got ${voiceReqs.length})`);
    const texts = [...new Set(voiceReqs.map(r => r.body.text))];
    assert(texts.length === 3 && texts.every(t => /[.!?]$/.test(t)), 'C8: each sentence ends with punctuation');
    const last = voiceReqs.find(r => r.body.text.startsWith('Cualquier cosa'));
    const first = voiceReqs.find(r => r.body.text.startsWith('Dale'));
    assert(last && !('next_text' in last.body) && last.body.previous_text, 'C8: last sentence has previous_text and NO next_text');
    assert(first && first.body.next_text && !('previous_text' in first.body), 'C8: first sentence has next_text, no previous_text');
    const vs = first ? first.body.voice_settings : {};
    assert(vs.stability === 0.45 && vs.similarity_boost === 0.85 && vs.style === 0.3 && vs.speed === 1.1 && first.body.model_id === 'eleven_multilingual_v2',
      'C8: multilingual_v2, stability 0.45, similarity 0.85, style 0.3, speed 1.1 inside voice_settings');
    assert(elSttCount === 12, `C8: every take transcribed to pick the best (got ${elSttCount})`);
    const audioSent = metaCalls.some(c => c.url.includes('/messages') && c.body?.type === 'audio' && c.body?.to === '59899000008');
    assert(audioSent, 'C8: voice note sent');
    const cost = db.prepare('SELECT COALESCE(SUM(audio_cost_usd),0) AS usd FROM spending_counters WHERE business_id = ?').get(biz.id).usd;
    assert(cost > 0, 'C8: real audio cost recorded');
    const billed = db.prepare('SELECT tts_chars FROM claude_usage WHERE business_id = ? ORDER BY id DESC LIMIT 1').get(biz.id);
    assert(billed && billed.tts_chars >= aiReplyText.length * 4 - 10, 'C8: tts_chars = billed chars (all takes)');
  }

  // ── C9: credits under 20% → 1 take per sentence ─────────────
  {
    console.log('\n  C9: ElevenLabs credits < 20% → 1 take per sentence');
    elSubscription = { character_count: 850000, character_limit: 1000000, next_character_count_reset_unix: 6666 };
    await adminReq('POST', '/admin/api/run-elevenlabs-check');
    const biz = getBusinessByEmail('c8@el-test.com');
    db.prepare('UPDATE businesses SET voice_id = ? WHERE id = ?').run('voice-id-c9', biz.id); db.pragma('wal_checkpoint(FULL)');
    aiReplyText = 'Sí, tenemos lugar el jueves a la tarde. ¿Querés que te lo reserve?';
    elTtsRequests = []; elSttCount = 0;
    await req('POST', '/webhook', metaPayload('pnid-c8', '59899000009', 'Hola'));
    await sleep(3000);
    const n = elTtsRequests.filter(r => r.voiceId === 'voice-id-c9').length;
    assert(n === 2, `C9: 2 sentences × 1 take = 2 TTS calls (got ${n})`);
    assert(elSttCount === 0, 'C9: no transcription with a single take');
  }

  // ── C10: credits exhausted → text + 100% alert once ─────────
  {
    console.log('\n  C10: ElevenLabs out of credits → text reply + admin alert at 100%');
    elSubscription = { character_count: 1000000, character_limit: 1000000, next_character_count_reset_unix: 7777 };
    const a1 = await adminReq('POST', '/admin/api/run-elevenlabs-check');
    assert(a1.body.alerted === true && a1.body.alerts.includes(100) && a1.body.alerts.includes(80), 'C10: 80% and 100% alerts sent');
    const a2 = await adminReq('POST', '/admin/api/run-elevenlabs-check');
    assert(a2.body.alerted === false, 'C10: not re-alerted in the same period');
    const biz = getBusinessByEmail('c8@el-test.com');
    db.prepare('UPDATE businesses SET voice_id = ? WHERE id = ?').run('voice-id-c10', biz.id); db.pragma('wal_checkpoint(FULL)');
    aiReplyText = 'Perfecto, te espero.';
    elTtsRequests = []; metaCalls.length = 0;
    await req('POST', '/webhook', metaPayload('pnid-c8', '59899000010', 'Hola'));
    await sleep(2500);
    assert(elTtsRequests.filter(r => r.voiceId === 'voice-id-c10').length === 0, 'C10: no TTS call');
    assert(metaCalls.some(c => c.url.includes('/messages') && c.body?.type === 'text'), 'C10: replied in text');
    elSubscription = { character_count: 0, character_limit: 1000000, next_character_count_reset_unix: 8888 };
    await adminReq('POST', '/admin/api/run-elevenlabs-check');
  }

  // ── C11: Voz panel — preview limit, custom voice_id, instructions ──
  {
    console.log('\n  C11: Voz panel endpoints');
    const cookie = await seedUser('c11@el-test.com');
    const biz = getBusinessByEmail('c11@el-test.com');
    configBusiness(biz.id, { plan: 'crecimiento', plan_paid_at: new Date().toISOString(), voice_id: 'voice-id-c11' });
    db.prepare("INSERT OR REPLACE INTO runtime_config (key, value) VALUES ('voice_preview_daily_limit', '2')").run(); db.pragma('wal_checkpoint(FULL)');

    const info = await req('GET', '/api/business/voice/info', null, { cookie });
    assert(info.status === 200 && info.body.previews_left === 2 && info.body.accepts_speed === true, 'C11: info → 2 tests left, speed accepted');
    const p1 = await req('POST', '/api/business/voice/preview', { voice_speed: 'rapida', text: 'Hola. ¿Te ayudo?' }, { cookie });
    assert(p1.status === 200, 'C11: preview 1 ok');
    const p2 = await req('POST', '/api/business/voice/preview', {}, { cookie });
    assert(p2.status === 200, 'C11: preview 2 ok');
    const p3 = await req('POST', '/api/business/voice/preview', {}, { cookie });
    assert(p3.status === 429 && /pruebas de hoy/.test(p3.body.error || ''), 'C11: preview 3 → daily limit');
    const prevCost = db.prepare('SELECT audio_cost_usd, voice_previews FROM spending_counters WHERE business_id = ?').get(biz.id);
    assert(prevCost && prevCost.voice_previews === 2 && prevCost.audio_cost_usd > 0, 'C11: previews counted in the monthly audio spend');

    const bad = await req('POST', '/api/business/voice/custom', { voice_id: 'x y' }, { cookie });
    assert(bad.status === 400, 'C11: malformed voice_id → 400');
    const cloned = await req('POST', '/api/business/voice/custom', { voice_id: 'cloneVoice12345' }, { cookie });
    assert(cloned.status === 400 && /clonada/.test(cloned.body.error || ''), 'C11: someone else\'s cloned voice rejected');
    const missing = await req('POST', '/api/business/voice/custom', { voice_id: 'missingVoice1234' }, { cookie });
    assert(missing.status === 400, 'C11: voice not in the account → 400');
    const ok = await req('POST', '/api/business/voice/custom', { voice_id: 'libraryVoice1234' }, { cookie });
    assert(ok.status === 200 && ok.body.name === 'Lib Voice', 'C11: library voice accepted');
    assert(getBusinessByEmail('c11@el-test.com').voice_id === 'libraryVoice1234', 'C11: voice_id saved');

    const save = await req('PUT', '/api/business/voice/settings', {
      voice_speed: 'rapida', voice_tone: 'natural', voice_pronunciations: [],
      voice_instructions: 'hablá más rápido, tono cercano', voice_instructions_summary: 'Velocidad: más rápida.',
    }, { cookie });
    assert(save.status === 200 && save.body.voice_instructions === 'hablá más rápido, tono cercano', 'C11: instructions saved');
    const row = getBusinessByEmail('c11@el-test.com');
    assert(row.voice_instructions_summary === 'Velocidad: más rápida.' && row.voice_speed === 'rapida', 'C11: summary + speed stored');
    const keep = await req('PUT', '/api/business/voice/settings', { voice_speed: 'normal', voice_tone: 'natural' }, { cookie });
    assert(keep.status === 200 && getBusinessByEmail('c11@el-test.com').voice_instructions === 'hablá más rápido, tono cercano', 'C11: omitted instructions are kept');

    const cookieA = await seedUser('c11a@el-test.com');
    const bizA = getBusinessByEmail('c11a@el-test.com');
    configBusiness(bizA.id, { plan: 'arranque', voice_id: 'voice-id-c11a' });
    const pA = await req('POST', '/api/business/voice/preview', {}, { cookie: cookieA });
    assert(pA.status === 403, 'C11: plan Arranque → no voice preview');
    const cA = await req('POST', '/api/business/voice/custom', { voice_id: 'libraryVoice1234' }, { cookie: cookieA });
    assert(cA.status === 403, 'C11: plan Arranque → no custom voice');
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
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
