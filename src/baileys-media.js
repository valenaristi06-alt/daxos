'use strict';

/**
 * Media for the Baileys connection, without touching baileys.js.
 *
 * baileys.js only forwards text to processIncomingMessage: audios and photos get a
 * "no puedo…" reply and every other type is dropped in silence. Since that file is
 * frozen, the bridge works around it in two steps:
 *
 *  1. rewriteUpsert(): before baileys.js sees a 'messages.upsert' batch, every media
 *     message is swapped for a plain text placeholder ("[audio]", "[imagen]"…) and the
 *     original is kept in a short-lived stash keyed by message id. baileys.js then runs
 *     all its own guards (groups, LID → phone, replay, dedup) exactly as for a text.
 *  2. processIncomingMessage (wrapped): when baileys.js calls it for a stashed id, we
 *     download the media, transcribe / read it, and call the real pipeline with the
 *     result. Unreadable types get an honest reply instead of silence.
 *
 * The swap is installed by wrapping listeners registered for the 'messages.upsert'
 * event (an event name only Baileys uses). It is the only seam available: the Baileys
 * library is an ES module (its exports cannot be wrapped) and baileys.js keeps the
 * socket private.
 */

const { EventEmitter } = require('events');
const {
  IMAGE_MAX_BYTES, DOC_MAX_BYTES, AUDIO_MAX_BYTES, IMG_ALLOWED,
  mediaPlaceholder, readIncomingDocument, classifyBaileysMessage,
} = require('./incoming-media');

const STASH_TTL_MS = 10 * 60_000;
const STASH_MAX = 500;
const DOWNLOAD_TIMEOUT_MS = 20_000;

let _rewrite = null;          // active rewrite function (set by installUpsertHook)
let _origOn = null;           // original EventEmitter.prototype.on while the hook is installed

// Wraps every listener registered for 'messages.upsert' so it receives the rewritten batch.
function installUpsertHook(rewriteUpsert, logError) {
  _rewrite = rewriteUpsert;
  if (_origOn) return uninstallUpsertHook;
  _origOn = EventEmitter.prototype.on;
  const origOn = _origOn;
  function on(event, listener) {
    if (event !== 'messages.upsert' || typeof listener !== 'function') return origOn.call(this, event, listener);
    const wrapped = function (payload) {
      let next = payload;
      try { if (_rewrite) next = _rewrite(payload); }
      catch (err) { try { logError?.('baileys-media-rewrite', { message: err.message, stack: err.stack || '' }); } catch (_) {} }
      return listener.call(this, next);
    };
    wrapped.listener = listener; // keeps off(event, listener) working
    return origOn.call(this, event, wrapped);
  }
  EventEmitter.prototype.on = on;
  EventEmitter.prototype.addListener = on;
  return uninstallUpsertHook;
}

function uninstallUpsertHook() {
  if (_origOn) {
    EventEmitter.prototype.on = _origOn;
    EventEmitter.prototype.addListener = _origOn;
    _origOn = null;
  }
  _rewrite = null;
}

async function _defaultDownload(msg, sock) {
  const lib = await import('@whiskeysockets/baileys');
  const noop = () => {};
  const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return this; } };
  const ctx = sock?.updateMediaMessage ? { logger, reuploadRequest: sock.updateMediaMessage } : undefined;
  return lib.downloadMediaMessage(msg, 'buffer', {}, ctx);
}

function _withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('download_timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * @param {object} deps
 * @param {Function} deps.processIncomingMessage  the real pipeline (server.js)
 * @param {Function} deps.replyUnprocessable      (business, creds, { customerPhone, kind, storedText, msgTimestamp }) → honest reply with all gates
 * @param {Function} deps.shouldSkipMedia         (business, customerPhone, msgTimestamp) → true when the bot will not answer anyway
 * @param {Function} deps.extractTextFromFile
 * @param {Function} deps.detectMimeFromBytes
 * @param {Function} deps.transcribeAudio
 * @param {Function} deps.logError
 * @param {Function} [deps.download]              (msg, socket) → Buffer — injectable for tests
 */
function createBaileysMediaBridge(deps) {
  const { processIncomingMessage, replyUnprocessable, shouldSkipMedia, extractTextFromFile, detectMimeFromBytes, transcribeAudio, logError } = deps;
  const download = deps.download || _defaultDownload;
  const stash = new Map(); // msgId → { msg, kind, caption, content, at }

  function _prune(now) {
    for (const [id, e] of stash) {
      if (now - e.at > STASH_TTL_MS || stash.size > STASH_MAX) stash.delete(id); else break;
    }
  }

  function rewriteMessage(msg) {
    if (!msg || !msg.message || !msg.key || msg.key.fromMe || !msg.key.id) return msg;
    const jid = msg.key.remoteJid || '';
    if (jid.endsWith('@g.us') || jid === 'status@broadcast') return msg;
    const info = classifyBaileysMessage(msg.message);
    if (info.kind === 'silent') return msg;
    if (info.kind === 'text') {
      // Plain text is left alone; text inside an envelope (disappearing chats) is unwrapped
      // so baileys.js recognises it instead of dropping it as an unknown type.
      return info.wrapped ? { ...msg, message: { conversation: info.text } } : msg;
    }
    const now = Date.now();
    _prune(now);
    stash.set(msg.key.id, { msg, kind: info.kind, caption: info.caption, content: info.content, at: now });
    return { ...msg, message: { conversation: mediaPlaceholder(info.kind, info.caption) } };
  }

  function rewriteUpsert(payload) {
    if (!payload || payload.type !== 'notify' || !Array.isArray(payload.messages)) return payload;
    return { ...payload, messages: payload.messages.map(rewriteMessage) };
  }

  async function _fetch(entry, waCredentials, maxBytes, media) {
    const declared = Number(media?.fileLength ?? 0);
    if (declared > maxBytes) throw new Error(`too_large:file_length=${declared}`);
    const buffer = await _withTimeout(download(entry.msg, waCredentials?.socket || null), DOWNLOAD_TIMEOUT_MS);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('empty_download');
    if (buffer.length > maxBytes) throw new Error(`too_large:bytes=${buffer.length}`);
    return buffer;
  }

  async function wrappedProcessIncomingMessage(business, waCredentials, args) {
    const entry = args && args.msgId ? stash.get(args.msgId) : null;
    if (!entry) return processIncomingMessage(business, waCredentials, args);
    stash.delete(args.msgId);

    const { kind, caption, content } = entry;
    const { customerPhone, msgTimestamp } = args;
    const tag = `business_id=${business.id} msgId=${args.msgId}`;
    // `media`: the downloaded file, kept so the owner can still open it in the panel.
    const fail = (failKind, err, media = null) => {
      logError('baileys-media-fallback', { message: `${tag} kind=${failKind}${err ? ' err=' + String(err.message || err).slice(0, 160) : ''}`, stack: '' });
      return replyUnprocessable(business, waCredentials, { customerPhone, kind: failKind, storedText: mediaPlaceholder(failKind, caption), msgTimestamp, media });
    };

    // Contact excluded or message too old: the pipeline stores/drops the placeholder and
    // stays silent. No download and no transcription cost.
    if (shouldSkipMedia(business, customerPhone, msgTimestamp)) {
      return processIncomingMessage(business, waCredentials, args);
    }

    if (kind === 'audio') {
      let text, media = null;
      try {
        const buffer = await _fetch(entry, waCredentials, AUDIO_MAX_BYTES, content.audioMessage);
        media = { kind: 'audio', buffer, mime: content.audioMessage?.mimetype || 'audio/ogg' };
        logError('audio-download', { message: `${tag} provider=baileys bytes=${buffer.length}`, stack: '' });
        text = (await transcribeAudio(buffer, (content.audioMessage?.mimetype || 'audio/ogg').split(';')[0].trim()) || '').trim();
        logError('audio-transcribe', { message: `${tag} provider=baileys chars=${text.length}`, stack: '' });
      } catch (err) {
        return fail(/^too_large/.test(err.message) ? 'audio_too_long' : 'audio_failed', err, media);
      }
      if (!text) return fail('audio_failed', 'empty_transcript', media);
      return processIncomingMessage(business, waCredentials, { ...args, text, media });
    }

    if (kind === 'image') {
      let buffer, mimeType;
      try {
        buffer = await _fetch(entry, waCredentials, IMAGE_MAX_BYTES, content.imageMessage);
        mimeType = detectMimeFromBytes(buffer);
        if (!mimeType || !IMG_ALLOWED.has(mimeType)) throw new Error(`unsupported_content:${mimeType}`);
      } catch (err) {
        return fail('image_failed', err);
      }
      logError('baileys-image-vision', { message: `${tag} mime=${mimeType} bytes=${buffer.length} has_caption=${!!caption}`, stack: '' });
      return processIncomingMessage(business, waCredentials, {
        ...args,
        text: mediaPlaceholder('image', caption),
        imageData: { base64: buffer.toString('base64'), mimeType, caption },
      });
    }

    if (kind === 'document') {
      const doc = content.documentMessage || {};
      let read, media = null;
      try {
        const buffer = await _fetch(entry, waCredentials, DOC_MAX_BYTES, doc);
        media = { kind: 'document', buffer, mime: detectMimeFromBytes(buffer) || doc.mimetype, filename: doc.fileName || doc.title };
        read = await readIncomingDocument({ buffer, mime: doc.mimetype, filename: doc.fileName || doc.title, caption, extractTextFromFile, detectMimeFromBytes });
      } catch (err) {
        return fail('document_failed', err);
      }
      if (!read.ok) return fail(read.reason, null, media);
      logError('baileys-document-read', { message: `${tag} as=${read.kind}${read.kind === 'text' ? ` chars=${read.chars} truncated=${read.truncated}` : ''}`, stack: '' });
      if (read.kind === 'image') return processIncomingMessage(business, waCredentials, { ...args, text: read.storedText, imageData: read.imageData });
      return processIncomingMessage(business, waCredentials, { ...args, text: read.storedText, claudeText: read.claudeText, media });
    }

    // video, sticker, location, contacts, other
    return fail(kind);
  }

  return { rewriteUpsert, rewriteMessage, processIncomingMessage: wrappedProcessIncomingMessage, _stash: stash };
}

module.exports = { createBaileysMediaBridge, installUpsertHook, uninstallUpsertHook };
