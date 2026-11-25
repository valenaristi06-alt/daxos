'use strict';
/**
 * Outgoing audio must arrive as a VOICE NOTE (profile photo + waveform), not as an audio
 * file (orange headphones icon) — on both connections.
 *
 *   File:    OGG container, Opus codec, mono.
 *   Meta:    upload type "audio/ogg" + audio.voice = true.
 *   Baileys: mimetype "audio/ogg; codecs=opus" + ptt = true + seconds + waveform.
 *
 *  1. The converter output (real ffmpeg).
 *  2. Meta: the exact upload and message requests (captured by a mock Graph server).
 *  3. Baileys: what is handed to the socket, and the message the real Baileys library
 *     builds from it.
 *  4. Kapso is left as it was.
 *  5. End to end: an audio reply from the real server over Meta.
 *
 * Run: node scripts/test-voice-note.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, execSync, spawn } = require('child_process');

const DB_DIR = '/tmp/test-voice-note';
const PORT = 3279, EL_PORT = 3280, META_PORT = 3281, AI_PORT = 3282;
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;
process.env.NODE_ENV = 'test';
delete process.env.RAILWAY_ENVIRONMENT;
process.env.META_GRAPH_BASE_URL = `http://localhost:${META_PORT}`;
process.env.KAPSO_API_BASE_URL = `http://localhost:${META_PORT}/kapso`;
process.env.META_SYSTEM_TOKEN = 'test-system-token';

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(80); }
  return false;
}

// A real MP3 like the TTS provider returns (44.1 kHz), generated locally with ffmpeg.
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const mp3Path = path.join(os.tmpdir(), `voice-note-src-${process.pid}.mp3`);
execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-ac', '2', '-ar', '44100', '-b:a', '128k', mp3Path], { stdio: 'ignore' });
const MP3 = fs.readFileSync(mp3Path);
fs.unlinkSync(mp3Path);

// Captured requests on the mock Graph server.
const uploads = [];   // { url, typeField, fileContentType, filename, bytes }
const messages = [];  // { url, body }
const metaSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url.includes('/media')) {
      const txt = raw.toString('latin1');
      uploads.push({
        url: req.url,
        typeField: (txt.match(/name="type"\r\n\r\n([^\r]*)/) || [])[1],
        fileContentType: (txt.match(/name="file"; filename="[^"]*"\r\nContent-Type: ([^\r]*)/) || [])[1],
        filename: (txt.match(/name="file"; filename="([^"]*)"/) || [])[1],
        hasOgg: txt.includes('OggS') && txt.includes('OpusHead'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"id":"MEDIA-1"}');
    }
    if (req.method === 'POST' && req.url.includes('/messages')) {
      let body = null; try { body = JSON.parse(raw.toString('utf8')); } catch (_) {}
      messages.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"messages":[{"id":"wamid.out"}]}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
});

(async () => {
  await new Promise(r => metaSrv.listen(META_PORT, r));
  const { convertToOgg, analyzeVoiceNote } = require('../src/audio');
  const wa = require('../src/whatsapp');

  // ── 1. The file ────────────────────────────────────────────────────────────
  console.log('\n--- 1. Converter output ---');
  const ogg = await convertToOgg(MP3);
  const head = ogg.indexOf('OpusHead');
  ok('OGG container', ogg.slice(0, 4).toString() === 'OggS');
  ok('Opus codec', head > 0 && ogg.indexOf('OpusTags') > head);
  ok('mono (stereo source is downmixed)', ogg[head + 9] === 1, `channels=${ogg[head + 9]}`);
  ok('a single audio stream, no leftover metadata', ogg.indexOf('OpusHead', head + 8) === -1 && !ogg.includes('title='));
  ok('small enough for the play button (Meta: ≤ 512 KB)', ogg.length < 512 * 1024, `${ogg.length} bytes`);
  const voice = await analyzeVoiceNote(ogg);
  ok('duration is measured', voice.seconds === 6, `seconds=${voice.seconds}`);
  ok('waveform: 64 points from 0 to 100', voice.waveform instanceof Uint8Array && voice.waveform.length === 64 && voice.waveform.every(v => v >= 0 && v <= 100) && Math.max(...voice.waveform) === 100);
  let shortErr = null;
  try { await analyzeVoiceNote(Buffer.from('not audio')); } catch (e) { shortErr = e; }
  ok('unreadable audio → analysis rejects (caller sends without waveform)', !!shortErr);

  // ── 2. Meta ────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Meta: upload + message ---');
  {
    const creds = { provider: 'meta', phoneNumberId: 'PN-META', accessToken: 'biz-token' };
    const mediaId = await wa.uploadMedia(ogg, 'reply.ogg', 'audio/ogg; codecs=opus', creds);
    await wa.sendWhatsAppAudio('59899000111', mediaId, creds, { voice });
    const up = uploads[uploads.length - 1], msg = messages[messages.length - 1];
    ok('upload goes to /<phone-number-id>/media', up.url === '/PN-META/media');
    ok('upload "type" field is audio/ogg', up.typeField === 'audio/ogg', up.typeField);
    ok('file part Content-Type is audio/ogg', up.fileContentType === 'audio/ogg', up.fileContentType);
    ok('file name ends in .ogg (matches the type)', up.filename === 'reply.ogg');
    ok('uploaded bytes are the OGG/Opus file', up.hasOgg);
    ok('message type is audio', msg.body.type === 'audio' && msg.body.messaging_product === 'whatsapp' && msg.body.to === '59899000111');
    ok('message uses the uploaded media id', msg.body.audio.id === 'MEDIA-1');
    ok('voice flag is boolean true', msg.body.audio.voice === true);
    ok('Baileys-only fields are not sent to Meta', !('ptt' in msg.body.audio) && !('waveform' in msg.body.audio) && !('seconds' in msg.body.audio));

    // Other media keeps its own type.
    await wa.uploadMedia(Buffer.from('%PDF-1.4'), 'lista.pdf', 'application/pdf', creds);
    ok('documents are uploaded with their own type', uploads[uploads.length - 1].typeField === 'application/pdf');
  }

  // ── 3. Baileys ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Baileys: voice note fields ---');
  {
    const sent = [];
    const creds = { provider: 'baileys', remoteJid: '59899000222@s.whatsapp.net', socket: { sendMessage: async (jid, content) => { sent.push({ jid, content }); } } };
    const before = uploads.length;
    const sentinel = await wa.uploadMedia(ogg, 'reply.ogg', 'audio/ogg; codecs=opus', creds);
    ok('no HTTP upload for Baileys (sent from the buffer)', uploads.length === before && sentinel._baileys === true);
    await wa.sendWhatsAppAudio('59899000222', sentinel, creds, { voice });
    const c = sent[0].content;
    ok('ptt = true (voice note marker)', c.ptt === true);
    ok('mimetype is audio/ogg; codecs=opus', c.mimetype === 'audio/ogg; codecs=opus');
    ok('audio is the OGG/Opus buffer', c.audio === ogg);
    ok('duration and waveform are included', c.seconds === 6 && c.waveform === voice.waveform);
    ok('sent to the original chat id', sent[0].jid === '59899000222@s.whatsapp.net');

    // What the real library builds from that content (upload stubbed, nothing leaves the machine).
    const lib = await import('@whiskeysockets/baileys');
    const noop = () => {};
    const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, child() { return this; } };
    const built = await lib.generateWAMessageContent(c, { upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/x' }), logger });
    const a = built.audioMessage;
    ok('Baileys builds an audioMessage with ptt=true', !!a && a.ptt === true);
    ok('Baileys keeps our waveform (64 points)', a.waveform && a.waveform.length === 64);
    ok('Baileys keeps the duration', a.seconds === 6);
    ok('Baileys keeps the Opus mimetype', a.mimetype === 'audio/ogg; codecs=opus');

    // Without our analysis the library cannot draw the wave: this was the defect.
    const bare = await lib.generateWAMessageContent({ audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/x' }), logger });
    ok('before: the library alone produced no waveform', !bare.audioMessage.waveform || bare.audioMessage.waveform.length === 0);

    // Analysis failed → still a voice note.
    sent.length = 0;
    await wa.sendWhatsAppAudio('59899000222', sentinel, creds, { voice: null });
    ok('no waveform available → still sent with ptt=true', sent[0].content.ptt === true && sent[0].content.mimetype === 'audio/ogg; codecs=opus' && !('waveform' in sent[0].content));
    sent.length = 0;
    await wa.sendWhatsAppAudio('59899000222', { _baileys: true, buffer: ogg, mimeType: 'audio/ogg' }, creds);
    ok('mimetype is forced to the Opus one even if the caller passed a bare type', sent[0].content.mimetype === 'audio/ogg; codecs=opus' && sent[0].content.ptt === true);
  }

  // ── 4. Kapso untouched ─────────────────────────────────────────────────────
  console.log('\n--- 4. Kapso is left as it was ---');
  {
    const creds = { provider: 'kapso', phoneNumberId: 'PN-KAPSO' };
    const id = await wa.uploadMedia(ogg, 'reply.ogg', 'audio/ogg; codecs=opus', creds);
    await wa.sendWhatsAppAudio('59899000333', id, creds, { voice });
    const up = uploads[uploads.length - 1], msg = messages[messages.length - 1];
    ok('Kapso upload type unchanged', up.url.startsWith('/kapso/') && up.typeField === 'audio/ogg; codecs=opus');
    ok('Kapso message unchanged', msg.url.startsWith('/kapso/') && msg.body.audio.voice === true && msg.body.audio.id === 'MEDIA-1');
  }

  // ── 5. End to end over Meta ────────────────────────────────────────────────
  console.log('\n--- 5. End to end: audio reply from the server (Meta) ---');
  const elSrv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url.includes('/text-to-speech/')) { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(MP3); }
      res.writeHead(404); res.end('{}');
    });
  }).listen(EL_PORT);
  const aiSrv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hola, ¿en qué te ayudo?' }], model: 'claude-test', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  }).listen(AI_PORT);
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 'voice-secret', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '',
      ANTHROPIC_BASE_URL: `http://localhost:${AI_PORT}`, ANTHROPIC_API_KEY: 'test-key-not-real',
      ELEVENLABS_API_KEY: 'test-el-key-not-real', ELEVENLABS_BASE_URL: `http://localhost:${EL_PORT}`,
      META_GRAPH_BASE_URL: `http://localhost:${META_PORT}`, WHATSAPP_VERIFY_TOKEN: 'test-verify-token', WEBHOOK_SIG_MODE: 'off', BAILEYS_ENABLED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', d => { out += String(d); });
  server.stderr.on('data', d => { out += String(d); });
  const up = await waitFor(() => out.includes('Server running'), 15000);
  ok('server started', up, out.slice(-300));

  function req(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      const data = body ? JSON.stringify(body) : null;
      if (data) headers['Content-Length'] = Buffer.byteLength(data);
      const r = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method, headers }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); } catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); } });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  }
  if (up) {
    try {
      await sleep(300);
      const reg = await req('POST', '/auth/register', { email: `v-${Date.now()}@t.com`, password: 'V1Pass1!x' });
      const cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
      await req('PUT', '/api/business', { name: 'Voz Biz' }, cookie);
      const bizId = (await req('GET', '/api/business', null, cookie)).body?.id;
      const Database = require('better-sqlite3');
      const sql = new Database(path.join(DB_DIR, 'daxos.db'));
      sql.prepare(`UPDATE businesses SET phone_number_id='pnid-voice', wa_provider='meta', wa_access_token='fake', wa_connected_at=datetime('now'),
        plan='crecimiento', plan_paid_at=datetime('now'), response_delay=0, response_mode='audio', voice_id='voice-1' WHERE id=?`).run(bizId);
      sql.pragma('wal_checkpoint(FULL)'); sql.close();

      const u0 = uploads.length, m0 = messages.length;
      await req('POST', '/webhook', { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'pnid-voice' },
        messages: [{ id: `wamid.V${Date.now()}`, from: '59899000444', type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'hola' } }],
      } }] }] });
      await waitFor(() => messages.slice(m0).some(m => m.body?.type === 'audio'), 10000);
      const upl = uploads.slice(u0).find(u => u.url === '/pnid-voice/media');
      const audioMsg = messages.slice(m0).find(m => m.body?.type === 'audio');
      ok('reply is uploaded as audio/ogg with an OGG/Opus file', !!upl && upl.typeField === 'audio/ogg' && upl.fileContentType === 'audio/ogg' && upl.filename === 'reply.ogg' && upl.hasOgg, JSON.stringify(upl));
      ok('reply is sent as an audio message with voice=true', !!audioMsg && audioMsg.body.audio.voice === true && audioMsg.body.audio.id === 'MEDIA-1' && audioMsg.body.to === '59899000444', JSON.stringify(audioMsg?.body));
      ok('no text fallback was needed', !messages.slice(m0).some(m => m.body?.type === 'text'));
    } catch (e) {
      ok('end-to-end run', false, e.stack || e.message);
    }
  }
  server.kill('SIGTERM'); metaSrv.close(); elSrv.close(); aiSrv.close();

  console.log('\n================================================================');
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
