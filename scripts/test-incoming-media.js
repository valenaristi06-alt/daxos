'use strict';
/**
 * Incoming media — by type and by connection (Meta Cloud API and Baileys).
 *
 *  A. Unit: texts, document reading, Baileys message classification.
 *  B. Baileys: every type goes through the REAL src/baileys.js handler (untouched) plus
 *     the media bridge. Audio is transcribed, photos reach the model as images, documents
 *     as text, and everything else gets an honest reply — nothing is dropped in silence.
 *  C. Meta: every type goes through the real server (/webhook) with mock Graph,
 *     ElevenLabs and Anthropic servers.
 *
 * Run: node scripts/test-incoming-media.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { execSync, spawn } = require('child_process');

const DB_DIR = '/tmp/test-incoming-media';
const PORT = 3273, EL_PORT = 3274, META_PORT = 3275, AI_PORT = 3276;
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;
delete process.env.RAILWAY_ENVIRONMENT;
process.env.NODE_ENV = 'test';

const media = require('../src/incoming-media');
const { createBaileysMediaBridge, installUpsertHook, uninstallUpsertHook } = require('../src/baileys-media');
const baileys = require('../src/baileys');

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(60); }
  return false;
}

// ── Sample files ─────────────────────────────────────────────────────────────
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 1)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 2)]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(64, 3)]);
const TXT = Buffer.from('Lista de pedido:\n3 remeras talle M\n1 buzo gris', 'utf8');
function makePdf(lineText) {
  const objs = [];
  const push = s => objs.push(Buffer.from(s, 'latin1'));
  const stream = `BT /F1 12 Tf 72 720 Td (${lineText}) Tj ET`;
  push('<< /Type /Catalog /Pages 2 0 R >>');
  push('<< /Type /Pages /Kids [4 0 R] /Count 1 >>');
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>');
  push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]); });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${out.length}\n%%EOF`;
  return Buffer.concat([out, Buffer.from(xref, 'latin1')]);
}
const PDF = makePdf('Presupuesto 4321 para Marta');

// Same sniffing the server uses (kept tiny here so part A/B need no server).
function detect(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf.slice(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (buf[0] === 0x50 && buf[1] === 0x4B) return 'application/zip';
  return null;
}
const fakeExtract = async (buf, mime) => {
  if (mime === 'application/pdf') return 'Presupuesto 4321 para Marta';
  if (mime.includes('wordprocessingml')) return 'Contrato de servicio';
  return buf.toString('utf8');
};

(async () => {
  // ══ A. Unit ════════════════════════════════════════════════════════════════
  console.log('\n--- A. Texts and document reading ---');
  ok('video reply is honest', media.mediaReply('video') === 'No puedo ver videos, ¿me contás qué necesitás?');
  for (const k of ['video', 'sticker', 'location', 'contacts', 'other', 'audio_failed', 'audio_too_long', 'image_failed', 'document_failed', 'document_unsupported', 'document_empty']) {
    ok(`reply for ${k} asks the client to continue`, /\?$/.test(media.mediaReply(k)) && !/equipo|persona/.test(media.mediaReply(k)));
  }
  ok('unknown kind falls back to the generic honest reply', media.mediaReply('whatever') === media.MEDIA_REPLIES.other);
  ok('placeholders', media.mediaPlaceholder('audio_failed') === '[audio]' && media.mediaPlaceholder('image', 'mirá') === '[imagen] mirá' && media.mediaPlaceholder('video') === '[video]');
  {
    const rd = a => media.readIncomingDocument({ extractTextFromFile: fakeExtract, detectMimeFromBytes: detect, ...a });
    const pdf = await rd({ buffer: PDF, mime: 'application/pdf', filename: 'presu.pdf', caption: '¿está bien?' });
    ok('PDF → text for the model', pdf.ok && pdf.kind === 'text' && pdf.claudeText.includes('Presupuesto 4321') && pdf.claudeText.includes('"presu.pdf"') && pdf.claudeText.includes('¿está bien?'));
    ok('PDF → stored excerpt', pdf.storedText.startsWith('[documento: presu.pdf] ¿está bien?') && pdf.storedText.includes('Presupuesto 4321'));
    ok('document text is flagged as client content, not instructions', /no instrucciones/.test(pdf.claudeText));
    const docx = await rd({ buffer: XLSX, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'contrato.docx' });
    ok('Word → text', docx.ok && docx.claudeText.includes('Contrato de servicio'));
    const txt = await rd({ buffer: TXT, mime: 'text/plain', filename: 'pedido.txt' });
    ok('plain text → text', txt.ok && txt.claudeText.includes('3 remeras talle M'));
    const img = await rd({ buffer: JPEG, mime: 'image/jpeg', filename: 'foto.jpg', caption: 'mirá' });
    ok('photo sent as document → image', img.ok && img.kind === 'image' && img.imageData.mimeType === 'image/jpeg' && img.storedText === '[imagen] mirá');
    const xl = await rd({ buffer: XLSX, mime: 'application/vnd.ms-excel', filename: 'lista.xlsx' });
    ok('spreadsheet → unsupported', !xl.ok && xl.reason === 'document_unsupported');
    const bin = await rd({ buffer: Buffer.from([0, 1, 2, 3, 0, 0]), mime: 'text/plain', filename: 'raro.txt' });
    ok('binary pretending to be text → unsupported', !bin.ok && bin.reason === 'document_unsupported');
    const empty = await media.readIncomingDocument({ buffer: PDF, mime: 'application/pdf', filename: 'scan.pdf', extractTextFromFile: async () => '  ', detectMimeFromBytes: detect });
    ok('scanned PDF without text → empty', !empty.ok && empty.reason === 'document_empty');
    const broken = await media.readIncomingDocument({ buffer: PDF, mime: 'application/pdf', filename: 'x.pdf', extractTextFromFile: async () => { throw new Error('bad'); }, detectMimeFromBytes: detect });
    ok('unparseable PDF → failed', !broken.ok && broken.reason === 'document_failed');
    const long = await media.readIncomingDocument({ buffer: PDF, mime: 'application/pdf', filename: 'l.pdf', extractTextFromFile: async () => 'a'.repeat(40_000), detectMimeFromBytes: detect });
    ok('long document is cut for the model', long.ok && long.truncated && long.claudeText.length < media.DOC_MAX_CHARS + 600 && long.storedText.length < media.DOC_STORE_CHARS + 100);
  }
  {
    const c = m => media.classifyBaileysMessage(m).kind;
    ok('classify: text', c({ conversation: 'hola' }) === 'text' && c({ extendedTextMessage: { text: 'hola' } }) === 'text');
    ok('classify: audio / image / document', c({ audioMessage: {} }) === 'audio' && c({ imageMessage: {} }) === 'image' && c({ documentMessage: {} }) === 'document');
    ok('classify: document with caption envelope', c({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'x' } } } }) === 'document');
    ok('classify: video / sticker / location / contacts', c({ videoMessage: {} }) === 'video' && c({ stickerMessage: {} }) === 'sticker' && c({ locationMessage: {} }) === 'location' && c({ contactMessage: {} }) === 'contacts');
    ok('classify: disappearing-chat envelope is unwrapped', media.classifyBaileysMessage({ ephemeralMessage: { message: { conversation: 'hola' } } }).wrapped === true);
    ok('classify: reaction / protocol are silent', c({ reactionMessage: {} }) === 'silent' && c({ protocolMessage: {} }) === 'silent');
    ok('classify: poll → other', c({ pollCreationMessage: {} }) === 'other');
    ok('classify: metadata key first does not hide the content', c({ messageContextInfo: {}, audioMessage: {} }) === 'audio');
  }

  // ══ B. Baileys ═════════════════════════════════════════════════════════════
  console.log('\n--- B. Baileys: every type through the real baileys.js handler ---');
  {
    const BIZ = { id: baileys.BAILEYS_BUSINESS_ID, name: 'Biz Baileys' };
    let calls, replies, logs, downloads, marks, downloadImpl, sttImpl, skip;
    const reset = () => {
      calls = []; replies = []; logs = []; downloads = 0; marks = new Set(); skip = false;
      downloadImpl = async () => OGG; sttImpl = async () => 'quiero un turno para mañana';
    };
    reset();
    const bridge = createBaileysMediaBridge({
      processIncomingMessage: async (business, creds, args) => { calls.push({ business, creds, args }); },
      replyUnprocessable: async (business, creds, args) => { replies.push({ business, creds, args }); return { sent: true }; },
      shouldSkipMedia: () => skip,
      extractTextFromFile: fakeExtract, detectMimeFromBytes: detect,
      transcribeAudio: (buf, mime) => sttImpl(buf, mime),
      logError: (ctx, e) => logs.push(`${ctx} ${e.message}`),
      download: async (msg) => { downloads++; return downloadImpl(msg); },
    });
    const deps = {
      logError: (ctx, e) => logs.push(`${ctx} ${e.message}`),
      getBusinessById: () => BIZ,
      processIncomingMessage: bridge.processIncomingMessage,
      tryMarkProcessed: (b, id) => { if (marks.has(id)) return false; marks.add(id); return true; },
      deleteProcessedMessage: (b, id) => marks.delete(id),
    };
    let n = 0;
    const waMsg = (message, over = {}) => ({
      key: { remoteJid: '59899111222@s.whatsapp.net', fromMe: false, id: `BMSG${++n}`, ...over },
      messageTimestamp: Math.floor(Date.now() / 1000), message,
    });
    // What the socket emits → rewritten batch → the untouched baileys.js handler.
    const deliver = async (msg) => {
      const out = bridge.rewriteUpsert({ type: 'notify', messages: [msg] });
      await baileys._forTest.handleMessage(out.messages[0], null, deps);
      return out.messages[0];
    };

    // text: untouched
    reset();
    const t = waMsg({ conversation: 'hola' });
    ok('text: message object is not modified', (await deliver(t)) === t);
    ok('text: reaches the pipeline as before', calls.length === 1 && calls[0].args.text === 'hola' && downloads === 0);

    // audio: transcribed in our code after download
    reset();
    await deliver(waMsg({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, fileLength: 9000 } }));
    ok('audio: downloaded and transcribed', downloads === 1 && calls.length === 1 && calls[0].args.text === 'quiero un turno para mañana', JSON.stringify(calls[0]?.args));
    ok('audio: old "no puedo escuchar audios" reply is gone', replies.length === 0 && !logs.some(l => l.includes('baileys-audio-fallback')));
    ok('audio: phone resolved by baileys.js', calls[0].args.customerPhone === '59899111222' && calls[0].creds.provider === 'baileys');

    reset(); sttImpl = async () => '';
    await deliver(waMsg({ audioMessage: { mimetype: 'audio/ogg' } }));
    ok('audio: empty transcript → honest reply', calls.length === 0 && replies[0]?.args.kind === 'audio_failed' && replies[0].args.storedText === '[audio]');

    reset(); downloadImpl = async () => { throw new Error('media key expired'); };
    await deliver(waMsg({ audioMessage: { mimetype: 'audio/ogg' } }));
    ok('audio: download error → honest reply', calls.length === 0 && replies[0]?.args.kind === 'audio_failed');

    reset();
    await deliver(waMsg({ audioMessage: { mimetype: 'audio/ogg', fileLength: 9_000_000 } }));
    ok('audio: too long → says so, no download', downloads === 0 && replies[0]?.args.kind === 'audio_too_long');

    // image: read as an image
    reset(); downloadImpl = async () => JPEG;
    await deliver(waMsg({ imageMessage: { mimetype: 'image/jpeg', caption: '¿tienen este?' } }));
    ok('image: reaches the model as an image with caption', calls.length === 1 && calls[0].args.imageData?.mimeType === 'image/jpeg' && calls[0].args.imageData.caption === '¿tienen este?' && calls[0].args.text === '[imagen] ¿tienen este?');
    ok('image: base64 payload matches the download', calls[0].args.imageData.base64 === JPEG.toString('base64'));

    reset(); downloadImpl = async () => JPEG;
    await deliver(waMsg({ imageMessage: { mimetype: 'image/jpeg' } }));
    ok('image without caption: read (old "no puedo ver fotos" reply is gone)', calls.length === 1 && !!calls[0].args.imageData && replies.length === 0);

    reset(); downloadImpl = async () => Buffer.from('not an image at all');
    await deliver(waMsg({ imageMessage: { mimetype: 'image/jpeg' } }));
    ok('image: unreadable bytes → honest reply', calls.length === 0 && replies[0]?.args.kind === 'image_failed');

    // documents: text is read
    reset(); downloadImpl = async () => PDF;
    await deliver(waMsg({ documentMessage: { mimetype: 'application/pdf', fileName: 'presu.pdf', caption: 'revisalo' } }));
    ok('PDF: text reaches the model', calls.length === 1 && calls[0].args.claudeText.includes('Presupuesto 4321') && calls[0].args.text.startsWith('[documento: presu.pdf] revisalo'));

    reset(); downloadImpl = async () => PDF;
    await deliver(waMsg({ documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf', caption: 'mirá' } } } }));
    ok('PDF with caption envelope: read', calls.length === 1 && calls[0].args.claudeText.includes('Presupuesto 4321'));

    reset(); downloadImpl = async () => XLSX;
    await deliver(waMsg({ documentMessage: { mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'contrato.docx' } }));
    ok('Word: text reaches the model', calls.length === 1 && calls[0].args.claudeText.includes('Contrato de servicio'));

    reset(); downloadImpl = async () => TXT;
    await deliver(waMsg({ documentMessage: { mimetype: 'text/plain', fileName: 'pedido.txt' } }));
    ok('text file: content reaches the model', calls.length === 1 && calls[0].args.claudeText.includes('3 remeras talle M'));

    reset(); downloadImpl = async () => XLSX;
    await deliver(waMsg({ documentMessage: { mimetype: 'application/vnd.ms-excel', fileName: 'lista.xlsx' } }));
    ok('spreadsheet: honest "no puedo leer ese tipo de archivo"', calls.length === 0 && replies[0]?.args.kind === 'document_unsupported');

    reset(); downloadImpl = async () => JPEG;
    await deliver(waMsg({ documentMessage: { mimetype: 'image/jpeg', fileName: 'foto.jpg' } }));
    ok('photo sent as document: read as image', calls.length === 1 && calls[0].args.imageData?.mimeType === 'image/jpeg');

    // everything else: honest reply, never silence
    for (const [label, message, kind] of [
      ['video', { videoMessage: { mimetype: 'video/mp4' } }, 'video'],
      ['video note', { ptvMessage: {} }, 'video'],
      ['sticker', { stickerMessage: {} }, 'sticker'],
      ['location', { locationMessage: { degreesLatitude: -34.9, degreesLongitude: -56.1 } }, 'location'],
      ['live location', { liveLocationMessage: {} }, 'location'],
      ['contact', { contactMessage: { displayName: 'Juan' } }, 'contacts'],
      ['poll', { pollCreationMessage: { name: '¿cuál?' } }, 'other'],
    ]) {
      reset();
      await deliver(waMsg(message));
      ok(`${label}: honest reply (${kind}), no download, not dropped`, replies.length === 1 && replies[0].args.kind === kind && downloads === 0 && calls.length === 0 && !logs.some(l => l.includes('baileys-unsupported-type')), JSON.stringify(logs));
      ok(`${label}: reply text`, media.mediaReply(replies[0]?.args.kind) === media.MEDIA_REPLIES[kind] && replies[0].args.customerPhone === '59899111222');
    }

    // disappearing chats: text used to be dropped as an unknown type
    reset();
    await deliver(waMsg({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hola, ¿abren hoy?' } } } }));
    ok('text in a disappearing chat is answered', calls.length === 1 && calls[0].args.text === 'hola, ¿abren hoy?');

    // reactions stay silent on purpose
    reset();
    await deliver(waMsg({ reactionMessage: { text: '👍' } }));
    ok('reaction: no reply (not a message to answer)', calls.length === 0 && replies.length === 0);

    // baileys.js guards still apply to media
    reset();
    await deliver(waMsg({ audioMessage: {} }, { fromMe: true }));
    await deliver(waMsg({ audioMessage: {} }, { remoteJid: '123456@g.us' }));
    ok('own messages and groups are ignored for media too', calls.length === 0 && replies.length === 0 && downloads === 0 && bridge._stash.size === 0);

    reset();
    const dup = waMsg({ audioMessage: { mimetype: 'audio/ogg' } });
    await deliver(dup); await deliver(dup);
    ok('duplicate audio is processed once', calls.length === 1 && downloads === 1);

    reset();
    await deliver({ ...waMsg({ audioMessage: {} }), messageTimestamp: 1_600_000_000 });
    ok('old replayed audio is dropped before any download', calls.length === 0 && downloads === 0);

    reset(); skip = true;
    await deliver(waMsg({ audioMessage: { mimetype: 'audio/ogg' } }));
    ok('excluded contact: stored as [audio], no download, no transcription', downloads === 0 && calls.length === 1 && calls[0].args.text === '[audio]');

    reset();
    await deliver(waMsg({ audioMessage: {} }, { remoteJid: '111222333444@lid', remoteJidAlt: '59899333444@s.whatsapp.net' }));
    ok('LID contact: audio transcribed with the resolved phone', calls.length === 1 && calls[0].args.customerPhone === '59899333444' && calls[0].creds.remoteJid === '111222333444@lid');

    // The seam: listeners registered for 'messages.upsert' receive the rewritten batch.
    reset();
    const uninstall = installUpsertHook(bridge.rewriteUpsert, () => {});
    const { makeEventBuffer } = await import('@whiskeysockets/baileys');
    const noop = () => {};
    const ev = makeEventBuffer({ trace: noop, debug: noop, info: noop, warn: noop, error: noop });
    let seen = null, other = null;
    const listener = p => { seen = p; };
    ev.on('messages.upsert', listener);
    ev.on('connection.update', p => { other = p; });
    const original = waMsg({ audioMessage: { mimetype: 'audio/ogg' } });
    ev.emit('messages.upsert', { type: 'notify', messages: [original] });
    ev.emit('connection.update', { connection: 'open' });
    ok('hook: a real Baileys event buffer delivers the rewritten audio', seen?.messages?.[0]?.message?.conversation === '[audio]' && seen.messages[0].key.id === original.key.id);
    ok('hook: the original message is kept for download', bridge._stash.get(original.key.id)?.msg === original && !!original.message.audioMessage);
    ok('hook: other events are untouched', other?.connection === 'open');
    seen = null; ev.emit('messages.upsert', { type: 'append', messages: [waMsg({ audioMessage: {} })] });
    ok('hook: history batches (type≠notify) are not rewritten', !!seen?.messages?.[0]?.message?.audioMessage);
    seen = null; ev.off('messages.upsert', listener); ev.emit('messages.upsert', { type: 'notify', messages: [waMsg({ conversation: 'x' })] });
    ok('hook: off() with the original listener still works', seen === null);
    uninstall();
    const plain = new EventEmitter(); let raw = null;
    plain.on('messages.upsert', p => { raw = p; }); plain.emit('messages.upsert', { type: 'notify', messages: [waMsg({ audioMessage: {} })] });
    ok('hook: uninstall restores EventEmitter', !!raw?.messages?.[0]?.message?.audioMessage);
    uninstallUpsertHook();

    const diff = (() => { try { return execSync('git diff --name-only origin/main -- src/baileys.js package.json package-lock.json patches', { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim(); } catch (_) { return 'git-unavailable'; } })();
    ok('baileys.js, package.json, lockfile and patches are untouched', diff === '', diff);
  }

  // ══ C. Meta ════════════════════════════════════════════════════════════════
  console.log('\n--- C. Meta: every type through the real /webhook ---');
  const files = {
    'img-ok': { buf: JPEG, mime: 'image/jpeg' }, 'aud-ok': { buf: OGG, mime: 'audio/ogg' },
    'pdf-ok': { buf: PDF, mime: 'application/pdf' }, 'txt-ok': { buf: TXT, mime: 'text/plain' },
    'xlsx': { buf: XLSX, mime: 'application/vnd.ms-excel' }, 'aud-big': { buf: OGG, mime: 'audio/ogg', size: 3 * 1024 * 1024 },
  };
  const sent = [];      // messages the server sent to WhatsApp: { to, text }
  const aiCalls = [];   // last user content of each model call
  let sttText = 'quiero un turno para mañana', sttCalls = 0;

  const metaSrv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const dl = req.url.match(/^\/dl\/([\w-]+)/);
      const id = req.url.slice(1).split('?')[0];
      if (req.method === 'GET' && dl && files[dl[1]]) {
        res.writeHead(200, { 'Content-Type': files[dl[1]].mime }); return res.end(files[dl[1]].buf);
      }
      if (req.method === 'GET' && files[id]) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ url: `http://localhost:${META_PORT}/dl/${id}`, mime_type: files[id].mime, file_size: files[id].size || files[id].buf.length }));
      }
      if (req.method === 'GET') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"not found"}}'); }
      if (req.method === 'POST' && req.url.includes('/messages')) {
        try { const b = JSON.parse(body); if (b.type === 'text') sent.push({ to: b.to, text: b.text.body }); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ messages: [{ id: 'wamid.out' }] }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    });
  }).listen(META_PORT);
  const elSrv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url.includes('/speech-to-text')) { sttCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ text: sttText })); }
      res.writeHead(404); res.end('{}');
    });
  }).listen(EL_PORT);
  const aiSrv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { const b = JSON.parse(body); aiCalls.push(b.messages[b.messages.length - 1].content); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Recibido, gracias.' }], model: 'claude-test', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  }).listen(AI_PORT);

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 'media-secret', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '',
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
      const reg = await req('POST', '/auth/register', { email: `m-${Date.now()}@t.com`, password: 'M1Pass1!x' });
      const cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
      await req('PUT', '/api/business', { name: 'Media Biz' }, cookie);
      const bizId = (await req('GET', '/api/business', null, cookie)).body?.id;
      const Database = require('better-sqlite3');
      const sql = new Database(path.join(DB_DIR, 'daxos.db'));
      sql.prepare(`UPDATE businesses SET phone_number_id='pnid-media', wa_provider='meta', wa_access_token='fake', wa_connected_at=datetime('now'),
        plan='crecimiento', plan_paid_at=datetime('now'), response_delay=0 WHERE id=?`).run(bizId);
      sql.pragma('wal_checkpoint(FULL)');

      let seq = 0;
      const post = (from, msg) => req('POST', '/webhook', { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'pnid-media' },
        messages: [{ id: `wamid.T${Date.now()}${++seq}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
      } }] }] });
      const repliesTo = phone => sent.filter(s => s.to === phone).map(s => s.text);
      const stored = phone => sql.prepare(`SELECT m.role, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.business_id = ? AND c.customer_id = ? ORDER BY m.id`).all(bizId, phone);
      // Sends one message and waits for the reply to that phone. Returns the model input.
      const run = async (phone, msg, { expectAi = true } = {}) => {
        const aiBefore = aiCalls.length;
        await post(phone, msg);
        await waitFor(() => repliesTo(phone).length > 0, 7000);
        return { ai: expectAi ? aiCalls[aiCalls.length - 1] : null, aiCalled: aiCalls.length > aiBefore, replies: repliesTo(phone) };
      };

      let r = await run('59891000001', { type: 'text', text: { body: 'hola' } });
      ok('text: answered by the model', r.aiCalled && r.replies[0] === 'Recibido, gracias.');

      r = await run('59891000002', { type: 'image', image: { id: 'img-ok', mime_type: 'image/jpeg', caption: '¿tienen este?' } });
      ok('image: model receives the image', Array.isArray(r.ai) && r.ai[0]?.type === 'image' && r.ai[0].source.media_type === 'image/jpeg' && r.ai[1]?.text === '¿tienen este?', JSON.stringify(r.ai)?.slice(0, 200));

      r = await run('59891000003', { type: 'image', image: { id: 'img-missing', mime_type: 'image/jpeg' } }, { expectAi: false });
      ok('image that cannot be downloaded: honest reply', !r.aiCalled && r.replies[0] === media.MEDIA_REPLIES.image_failed, JSON.stringify(r.replies));

      r = await run('59891000004', { type: 'audio', audio: { id: 'aud-ok', mime_type: 'audio/ogg; codecs=opus', voice: true } });
      ok('audio: transcript reaches the model', r.ai === 'quiero un turno para mañana' && r.replies[0] === 'Recibido, gracias.', JSON.stringify(r.ai));
      ok('audio: transcript is stored in the conversation', stored('59891000004')[0]?.content === 'quiero un turno para mañana');

      sttText = '';
      r = await run('59891000005', { type: 'audio', audio: { id: 'aud-ok' } }, { expectAi: false });
      ok('audio with empty transcript: honest reply', !r.aiCalled && r.replies[0] === media.MEDIA_REPLIES.audio_failed);
      sttText = 'quiero un turno para mañana';

      const sttBefore = sttCalls;
      r = await run('59891000006', { type: 'audio', audio: { id: 'aud-big' } }, { expectAi: false });
      ok('audio too long: says so, not transcribed', !r.aiCalled && r.replies[0] === media.MEDIA_REPLIES.audio_too_long && sttCalls === sttBefore);

      r = await run('59891000007', { type: 'document', document: { id: 'pdf-ok', mime_type: 'application/pdf', filename: 'presu.pdf', caption: '¿está bien este presupuesto?' } });
      ok('PDF: its text reaches the model', typeof r.ai === 'string' && r.ai.includes('Presupuesto 4321 para Marta') && r.ai.includes('"presu.pdf"') && r.ai.includes('¿está bien este presupuesto?'), String(r.ai).slice(0, 200));
      ok('PDF: stored with an excerpt', (stored('59891000007')[0]?.content || '').startsWith('[documento: presu.pdf] ¿está bien este presupuesto?'));

      r = await run('59891000008', { type: 'document', document: { id: 'txt-ok', mime_type: 'text/plain', filename: 'pedido.txt' } });
      ok('text document: content reaches the model', typeof r.ai === 'string' && r.ai.includes('3 remeras talle M'));

      r = await run('59891000009', { type: 'document', document: { id: 'img-ok', mime_type: 'image/jpeg', filename: 'foto.jpg' } });
      ok('photo sent as document: model receives the image', Array.isArray(r.ai) && r.ai[0]?.type === 'image');

      r = await run('59891000010', { type: 'document', document: { id: 'xlsx', mime_type: 'application/vnd.ms-excel', filename: 'lista.xlsx' } }, { expectAi: false });
      ok('spreadsheet: honest "no puedo leer ese tipo de archivo"', !r.aiCalled && r.replies[0] === media.MEDIA_REPLIES.document_unsupported);

      r = await run('59891000011', { type: 'document', document: { id: 'gone', mime_type: 'application/pdf', filename: 'x.pdf' } }, { expectAi: false });
      ok('document that cannot be downloaded: honest reply', !r.aiCalled && r.replies[0] === media.MEDIA_REPLIES.document_failed);

      let phoneN = 20;
      for (const [label, msg, kind] of [
        ['video', { type: 'video', video: { id: 'v1', mime_type: 'video/mp4' } }, 'video'],
        ['sticker', { type: 'sticker', sticker: { id: 's1' } }, 'sticker'],
        ['location', { type: 'location', location: { latitude: -34.9, longitude: -56.1 } }, 'location'],
        ['contacts', { type: 'contacts', contacts: [{ name: { formatted_name: 'Juan' } }] }, 'contacts'],
        ['unknown type (order)', { type: 'order', order: {} }, 'other'],
        ['unsupported (Meta placeholder)', { type: 'unsupported', errors: [{ code: 131051 }] }, 'other'],
      ]) {
        const phone = `598910000${++phoneN}`;
        r = await run(phone, msg, { expectAi: false });
        ok(`${label}: honest reply, never silence`, !r.aiCalled && r.replies.length === 1 && r.replies[0] === media.MEDIA_REPLIES[kind], JSON.stringify(r.replies));
        const rows = stored(phone);
        ok(`${label}: both sides stored in the conversation`, rows.length === 2 && rows[0].role === 'user' && rows[1].content === media.MEDIA_REPLIES[kind]);
      }
      ok('video reply is exactly the agreed text', sent.some(s => s.text === 'No puedo ver videos, ¿me contás qué necesitás?'));

      // burst of stickers → one reply
      await post('59891000022', { type: 'sticker', sticker: { id: 's2' } });
      await post('59891000022', { type: 'sticker', sticker: { id: 's3' } });
      await sleep(600);
      ok('sticker burst: one reply, the rest only stored', repliesTo('59891000022').length === 1 && stored('59891000022').filter(m => m.role === 'user').length === 3);

      const before = sent.length, aiBefore = aiCalls.length;
      await post('59891000030', { type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } });
      await sleep(500);
      ok('reaction: no reply (not a message to answer)', sent.length === before && aiCalls.length === aiBefore);

      r = await run('59891000031', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sí, confirmo' } } });
      ok('button reply: treated as text', r.ai === 'Sí, confirmo' && r.replies[0] === 'Recibido, gracias.');

      // paused bot: media is stored, nothing is sent
      sql.prepare('UPDATE businesses SET bot_paused = 1 WHERE id = ?').run(bizId); sql.pragma('wal_checkpoint(FULL)');
      const sentBefore = sent.length;
      await post('59891000040', { type: 'video', video: { id: 'v2' } });
      await sleep(600);
      ok('bot paused: video stored, no reply sent', sent.length === sentBefore && stored('59891000040').length === 1 && stored('59891000040')[0].content === '[video]');
      sql.close();
    } catch (e) {
      ok('Meta run', false, e.stack || e.message);
    }
  }
  server.kill('SIGTERM'); metaSrv.close(); elSrv.close(); aiSrv.close();

  console.log('\n================================================================');
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
