'use strict';

/**
 * Keeps the photos, audios and documents a client sends so the owner can open them in
 * the panel / embed. Files live on the data volume: <DB_DIR>/media/<business_id>/.
 * Nothing is sent anywhere: no external storage, no cost.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEDIA_ROOT = path.join(process.env.DB_DIR || path.join(__dirname, '../data'), 'media');
const MEDIA_KINDS = new Set(['image', 'audio', 'document']);
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/webm': 'webm', 'audio/wav': 'wav',
  'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

function _cleanMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase().slice(0, 100) || null;
}

// Writes the file and returns what to store on the message row, or null if not storable.
function writeMediaFile(businessId, media) {
  if (!media || !MEDIA_KINDS.has(media.kind) || !Buffer.isBuffer(media.buffer)) return null;
  if (media.buffer.length === 0 || media.buffer.length > MEDIA_MAX_BYTES) return null;
  const mime = _cleanMime(media.mime);
  const ext = EXT_BY_MIME[mime] || 'bin';
  const dir = path.join(MEDIA_ROOT, String(Number(businessId)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
  fs.writeFileSync(file, media.buffer);
  const name = media.filename ? String(media.filename).replace(/[\r\n"\\/]/g, '_').slice(0, 120) : null;
  return { kind: media.kind, mime, name, path: file };
}

// Only paths inside MEDIA_ROOT are ever served or deleted.
function isInsideMediaRoot(p) {
  if (!p) return false;
  const rel = path.relative(MEDIA_ROOT, path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function deleteMediaFiles(paths) {
  let n = 0;
  for (const p of paths || []) {
    if (!isInsideMediaRoot(p)) continue;
    try { fs.unlinkSync(p); n++; } catch (_) {}
  }
  return n;
}

module.exports = { MEDIA_ROOT, writeMediaFile, isInsideMediaRoot, deleteMediaFiles };
