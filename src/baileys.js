'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────────────

// Hardcoded for production safety. In local/dev, BAILEYS_BUSINESS_ID_OVERRIDE
// can point to any existing business for testing — never honoured when IS_PROD.
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const BAILEYS_BUSINESS_ID = (() => {
  if (!IS_PROD) {
    const override = parseInt(process.env.BAILEYS_BUSINESS_ID_OVERRIDE || '', 10);
    if (override > 0) return override;
  }
  return 10;
})();

const _processStartedAt = Math.floor(Date.now() / 1000);

const DB_DIR       = process.env.DB_DIR || path.join(__dirname, '../data');
const SESSION_DIR  = path.join(DB_DIR, 'baileys-session');
const LOCK_FILE    = path.join(SESSION_DIR, 'baileys.lock');
// Written on graceful SIGTERM shutdown; read on next startup so messages from
// the Railway restart window are not dropped by the replay guard.
const SHUTDOWN_FILE = path.join(SESSION_DIR, 'last_shutdown.json');

// Lock timing: heartbeat every 10 s, lock considered stale after 30 s without one.
const LOCK_HEARTBEAT_INTERVAL_MS = 10_000;
const LOCK_STALE_THRESHOLD_S     = 30;

// QR timeout: if nobody scans the QR within this window, release the lock and
// stop Baileys. Meta then resumes for new messages only. Messages that arrived
// during the QR_PENDING window are lost — WA Cloud API does not re-deliver
// webhooks that were already discarded by the suppression guard.
// Override in dev via BAILEYS_QR_TIMEOUT_MS (milliseconds).
const QR_TIMEOUT_MS = parseInt(process.env.BAILEYS_QR_TIMEOUT_MS || '', 10) || 5 * 60_000;

// ── Replay guard threshold ────────────────────────────────────────────────────
// On graceful restart (Railway deploy, SIGTERM): previous process writes
// shutdownAt to SHUTDOWN_FILE. We restore it so the guard baseline matches the
// moment the old process stopped, not when this new process started.
// This ensures messages sent during the restart window (between SIGTERM and new
// connect) are NOT dropped.
//
// On crash / first boot (no file): threshold = _processStartedAt. The 30s grace
// window handles clock skew. Messages older than 30s before process start are
// dropped — this is correct because on first-ever boot WA delivers the full
// unread backlog (~24h), and we must not flood the system with old messages.
function _loadReplayThreshold() {
  try {
    const raw  = fs.readFileSync(SHUTDOWN_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data.shutdownAt === 'number' && data.shutdownAt > 1_700_000_000) {
      return data.shutdownAt;
    }
  } catch { /* no file or corrupt — use process start time */ }
  return _processStartedAt;
}

// Immutable for the lifetime of this process.
const _replayThreshold = _loadReplayThreshold();

// ── Internal state ────────────────────────────────────────────────────────────

let _socket      = null;
let _qrB64       = null;   // data:image/png;base64,... while QR_PENDING
let _state       = 'IDLE'; // IDLE|CONNECTING|QR_PENDING|CONNECTED|DISCONNECTED|STOPPED
let _retries     = 0;
let _connectedAt = null;   // epoch seconds — set on 'open'
const MAX_RETRIES = 10;
const PAUSE_AFTER_MAX_MS = 5 * 60_000;

// Baileys ESM module, cached after first import
let _baileysLib = null;

// Dependencies injected by initBaileys
let _deps = null;

// ── Lock state ─────────────────────────────────────────────────────────────────
// Lock file format: { token, lockedAt, heartbeatAt }
// 'token' is a UUID generated once per process. releaseLock only deletes the file
// if the token still matches (fencing: won't delete a new owner's lock).
// _lockAcquired is the canonical "does this process hold the lock right now" flag,
// used by isBaileysLockHeld() to gate Meta/Kapso suppression in server.js.

let _lockToken    = null;   // UUID we wrote into the lock file; null if not owner
let _lockAcquired = false;  // true only while we actively hold a live lock
let _heartbeatTimer = null;

let _qrTimeoutTimer = null; // fires if QR not scanned within QR_TIMEOUT_MS
let _qrTimedOut     = false; // latches to true when timeout fires; visible via getBaileysState()

// ── Lock file — token-based O_EXCL + heartbeat ───────────────────────────────

function acquireLock() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const myToken = crypto.randomUUID();
  const now     = Math.floor(Date.now() / 1000);
  const content = JSON.stringify({ token: myToken, lockedAt: now, heartbeatAt: now });

  // Attempt 1: atomic O_EXCL — no lock file exists
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    _lockToken = myToken;
    _lockAcquired = true;
    _startHeartbeat();
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // Lock file exists — read and evaluate staleness
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { /* corrupt */ }

  const heartbeatAge = now - (existing?.heartbeatAt ?? 0);
  if (heartbeatAge <= LOCK_STALE_THRESHOLD_S) {
    return false; // lock is fresh — another active instance owns it
  }

  // Lock is stale (>30 s without heartbeat): steal via unlink + O_EXCL.
  // Two processes racing here: only one wins the O_EXCL; the loser returns false.
  try { fs.unlinkSync(LOCK_FILE); } catch { /* another process beat us to the unlink */ }
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    _lockToken = myToken;
    _lockAcquired = true;
    _startHeartbeat();
    return true;
  } catch {
    return false; // lost the race to another process
  }
}

function releaseLock() {
  _stopHeartbeat();
  _lockAcquired = false;
  if (!_lockToken) return;
  // Fencing: only delete if our token is still in the file.
  // If the lock was stolen (different token), do not delete the new owner's lock.
  try {
    const raw  = fs.readFileSync(LOCK_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.token === _lockToken) fs.unlinkSync(LOCK_FILE);
  } catch { /* lock already gone — nothing to do */ }
  _lockToken = null;
}

function _startHeartbeat() {
  _stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
    if (!_lockToken) return;
    const now = Math.floor(Date.now() / 1000);
    try {
      const raw  = fs.readFileSync(LOCK_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.token !== _lockToken) {
        // Lock was stolen by another process — stop immediately
        _stopHeartbeat();
        _lockAcquired = false;
        _deps?.logError('baileys-lock-stolen', {
          message: `token mismatch: ours=${_lockToken} found=${data.token} — stopping`,
          stack: '',
        });
        stopBaileys(); // idempotent
        return;
      }
      data.heartbeatAt = now;
      fs.writeFileSync(LOCK_FILE, JSON.stringify(data));
    } catch {
      // Lock file disappeared or became unreadable — treat as lost
      _stopHeartbeat();
      _lockAcquired = false;
      _deps?.logError('baileys-lock-lost', {
        message: 'lock file gone or unreadable — stopping Baileys',
        stack: '',
      });
      stopBaileys();
    }
  }, LOCK_HEARTBEAT_INTERVAL_MS).unref(); // .unref() so this timer alone won't block process.exit
}

function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

function _clearQrTimeout() {
  if (_qrTimeoutTimer) { clearTimeout(_qrTimeoutTimer); _qrTimeoutTimer = null; }
}

// Returns true only when this process actively holds the lock.
// Used by server.js to gate Meta/Kapso suppression for COLBET.
function isBaileysLockHeld() {
  return _lockAcquired;
}

// ── Disconnect reason classification ──────────────────────────────────────────

// 401: WA revoked session (user unpaired from phone) — credentials invalid, re-QR needed
// 411: multi-device not joined — session data unusable, re-QR needed
const CLEAR_SESSION_CODES = new Set([401, 411]);

// 403: number permanently banned — no point reconnecting
const TERMINAL_CODES = new Set([403]);

// 440: another connection replaced ours (stream:error conflict).
// Our credentials are still valid — they're being used by the other connection.
// Stop this instance gracefully WITHOUT clearing session data.
const YIELD_CODES = new Set([440]);

// 515: WA server rolling restart — reconnect immediately, not a real failure
const RESTART_SIGNAL_CODES = new Set([515]);

function classifyDisconnect(lastDisconnect) {
  // Baileys wraps errors in Boom objects: error.output.statusCode
  const code = lastDisconnect?.error?.output?.statusCode
             ?? lastDisconnect?.error?.statusCode
             ?? 0;
  return {
    code,
    shouldClearSession: CLEAR_SESSION_CODES.has(code),
    isTerminal:         TERMINAL_CODES.has(code),
    shouldYield:        YIELD_CODES.has(code),
    isRestartSignal:    RESTART_SIGNAL_CODES.has(code),
  };
}

// ── Session data management ───────────────────────────────────────────────────

function clearSessionData() {
  try {
    const entries = fs.readdirSync(SESSION_DIR);
    for (const name of entries) {
      if (name === 'baileys.lock') continue; // never delete our own lock
      const full = path.join(SESSION_DIR, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        fs.unlinkSync(full);
      }
    }
  } catch (e) {
    _deps?.logError('baileys-clear-session', { message: e.message, stack: '' });
  }
}

// ── Baileys module loader ─────────────────────────────────────────────────────

async function _getBaileys() {
  if (_baileysLib) return _baileysLib;
  _baileysLib = await import('@whiskeysockets/baileys');
  return _baileysLib;
}

// ── Silent logger for Baileys internals ──────────────────────────────────────

function _makeSilentLogger() {
  const noop = () => {};
  const l = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  l.child = () => l;
  return l;
}

// ── Reconnect helpers ─────────────────────────────────────────────────────────

function _backoffMs(n) {
  return Math.min(1000 * Math.pow(2, n), 60_000);
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Graceful stop ─────────────────────────────────────────────────────────────
// Called by server.js SIGTERM handler (before HTTP server close + DB close + exit).
// Also registered on SIGINT for local dev. Safe to call multiple times.

function stopBaileys() {
  if (_deps === null)        return; // never initialized — no socket, no lock
  if (_state === 'STOPPED') return; // already stopped
  _state = 'STOPPED';
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(SHUTDOWN_FILE, JSON.stringify({ shutdownAt: Math.floor(Date.now() / 1000) }));
  } catch (e) {
    // Next startup will use processStartedAt instead of shutdownAt.
    // Messages sent during the restart window may be dropped by the replay guard.
    console.error('[baileys] CRITICAL: failed to write shutdown file:', e.message);
    if (_deps?.logError) {
      _deps.logError('baileys-shutdown-file-error', {
        message: `writeFile ${SHUTDOWN_FILE} failed: ${e.message} — next restart may drop restart-window messages`,
        stack: e.stack || '',
      });
    }
  }
  _clearQrTimeout();
  if (_socket) {
    try { _socket.end?.(); } catch {}
    _socket = null;
  }
  releaseLock(); // also sets _lockAcquired = false and stops heartbeat
}

// ── Core connect / reconnect loop ─────────────────────────────────────────────

async function _connect() {
  if (_state === 'STOPPED') return;
  _state = 'CONNECTING';
  _qrB64 = null;
  _qrTimedOut = false;
  _clearQrTimeout();

  const { logError, getBusinessById, processIncomingMessage, tryMarkProcessed, deleteProcessedMessage } = _deps;

  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = await _getBaileys();
    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = [2, 3000, 1023521775]; // known-good fallback
    }

    const sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: _makeSilentLogger(),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Ignore groups and status at the socket level for efficiency
      shouldIgnoreJid: jid => jid.endsWith('@g.us') || jid === 'status@broadcast',
      getMessage: async () => undefined, // don't fetch missing messages from store
    });

    _socket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const QRCode = require('qrcode');
          _qrB64 = await QRCode.toDataURL(qr);
          _state = 'QR_PENDING';
          logError('baileys-qr-ready', { message: `business_id=${BAILEYS_BUSINESS_ID}`, stack: '' });
          // Start the QR timeout only once per connect attempt (WA refreshes the QR
          // every ~20 s; we want the total window, not reset on each refresh).
          if (!_qrTimeoutTimer) {
            _qrTimeoutTimer = setTimeout(() => {
              _qrTimeoutTimer = null;
              _qrTimedOut = true;
              logError('baileys-qr-timeout', {
                message: `business_id=${BAILEYS_BUSINESS_ID} QR not scanned within ${QR_TIMEOUT_MS / 1000}s — releasing lock. Meta resumes for new messages only. Messages received during QR_PENDING are lost.`,
                stack: '',
              });
              stopBaileys();
            }, QR_TIMEOUT_MS);
          }
        } catch (e) {
          logError('baileys-qr-encode', { message: e.message, stack: '' });
        }
        return;
      }

      if (connection === 'open') {
        _clearQrTimeout(); // authenticated — cancel the timeout
        _state = 'CONNECTED';
        _qrB64   = null;
        _retries = 0;
        _connectedAt = Math.floor(Date.now() / 1000);
        logError('baileys-connected', { message: `business_id=${BAILEYS_BUSINESS_ID} connected_at=${_connectedAt}`, stack: '' });
        return;
      }

      if (connection === 'close') {
        _clearQrTimeout(); // socket closed — timeout no longer relevant
        _socket = null;
        const { code, shouldClearSession, isTerminal, shouldYield, isRestartSignal } = classifyDisconnect(lastDisconnect);

        logError('baileys-disconnect', {
          message: `business_id=${BAILEYS_BUSINESS_ID} code=${code} yield=${shouldYield} terminal=${isTerminal} retries=${_retries}`,
          stack: '',
        });

        if (shouldClearSession) {
          // Session credentials are invalid — wipe them so next connect starts fresh with QR
          clearSessionData();
          logError('baileys-reauth-required', {
            message: `business_id=${BAILEYS_BUSINESS_ID} code=${code} session_cleared=true`,
            stack: '',
          });
        }

        if (isTerminal || _state === 'STOPPED') {
          _state = 'STOPPED';
          releaseLock();
          logError('baileys-terminal', { message: `business_id=${BAILEYS_BUSINESS_ID} code=${code}`, stack: '' });
          return;
        }

        if (shouldYield) {
          // 440: another connection replaced ours. Credentials are valid — the other
          // connection is using them right now. Stop without clearing session data.
          _state = 'STOPPED';
          releaseLock();
          logError('baileys-yielded', {
            message: `business_id=${BAILEYS_BUSINESS_ID} code=440 — yielding to other connection`,
            stack: '',
          });
          return;
        }

        if (isRestartSignal) {
          // 515: WA server rolling restart — not a failure, don't penalise retry counter
          _retries = 0;
          if (_state !== 'STOPPED') await _connect();
          return;
        }

        // Recoverable (408 connectionLost, 428 connectionClosed, 500 badSession, 503, etc.)
        if (_retries >= MAX_RETRIES) {
          logError('baileys-max-retries', {
            message: `business_id=${BAILEYS_BUSINESS_ID} pausing ${PAUSE_AFTER_MAX_MS / 1000}s`,
            stack: '',
          });
          _state = 'DISCONNECTED';
          _retries = 0;
          await _sleep(PAUSE_AFTER_MAX_MS);
        } else {
          const delay = _backoffMs(_retries++);
          _state = 'DISCONNECTED';
          await _sleep(delay);
        }

        if (_state !== 'STOPPED') await _connect();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        await _handleMessage(msg, { logError, getBusinessById, processIncomingMessage, tryMarkProcessed, deleteProcessedMessage })
          .catch(err => logError('baileys-msg-error', { message: err.message, stack: err.stack || '' }));
      }
    });

  } catch (err) {
    logError('baileys-connect-error', { message: err.message, stack: err.stack || '' });
    _socket = null;
    _state = 'DISCONNECTED';
    // Sleep first, THEN check: SIGTERM may have set _state = 'STOPPED' during the wait.
    await _sleep(_backoffMs(_retries++));
    if (_state !== 'STOPPED') {
      await _connect();
    }
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

async function _handleMessage(msg, { logError, getBusinessById, processIncomingMessage, tryMarkProcessed, deleteProcessedMessage }) {
  // Drop immediately if Baileys is stopping/stopped — socket is null, cannot respond.
  // Prevents: tryMarkProcessed marking message as done while response cannot be sent.
  if (_state === 'STOPPED') {
    logError('baileys-msg-dropped-stopped', {
      message: `msgId=${msg.key?.id} dropped — state=STOPPED, socket closed`,
      stack: '',
    });
    return;
  }

  // Pre-filters — these must not call tryMarkProcessed
  if (msg.key.fromMe)                                return;
  if (!msg.key.remoteJid)                            return;
  if (msg.key.remoteJid.endsWith('@g.us'))           return; // groups: explicit second-layer defense
  if (!msg.message)                                  return; // revoked/empty
  const msgId = msg.key.id;
  if (!msgId)                                        return;

  // Only process direct messages from @s.whatsapp.net JIDs.
  // @lid JIDs are WhatsApp Linked Account IDs — a privacy feature that hides
  // the real phone number. They are NOT phone numbers and must not be used as
  // customer identifiers. @broadcast and other non-peer JIDs are filtered above
  // or via shouldIgnoreJid. Being explicit here prevents silent data corruption.
  if (!msg.key.remoteJid.endsWith('@s.whatsapp.net')) {
    logError('baileys-jid-skip', {
      message: `msgId=${msgId} jid_type=${msg.key.remoteJid.split('@')[1] ?? 'unknown'} — only @s.whatsapp.net supported`,
      stack: '',
    });
    return;
  }

  // Replay guard — drop messages that pre-date _replayThreshold.
  // Threshold = previous SIGTERM time (read from SHUTDOWN_FILE on startup), or
  // process start time when no file exists (first boot / crash recovery).
  // 30s grace covers WA server / local clock skew.
  //
  // WHY NOT use _connectedAt: on every reconnect _connectedAt resets to now,
  // causing messages from the brief disconnect window to be dropped. _replayThreshold
  // is fixed for the lifetime of this process, so reconnect-window messages pass.
  const msgTimestampRaw = msg.messageTimestamp ? Number(msg.messageTimestamp) : null;
  if (msgTimestampRaw !== null && msgTimestampRaw < _replayThreshold - 30) {
    logError('baileys-replay-skip', {
      message: `msgId=${msgId} msg_ts=${msgTimestampRaw} threshold=${_replayThreshold} age=${_replayThreshold - msgTimestampRaw}s — pre-threshold replay dropped`,
      stack: '',
    });
    return;
  }

  // Dedup — same INSERT OR IGNORE mechanism as Meta/Kapso
  if (!tryMarkProcessed(BAILEYS_BUSINESS_ID, msgId)) {
    logError('baileys-dedup', { message: `msgId=${msgId} already_processed`, stack: '' });
    return;
  }

  const business = getBusinessById(BAILEYS_BUSINESS_ID);
  if (!business) {
    deleteProcessedMessage(BAILEYS_BUSINESS_ID, msgId); // rollback: message was marked but cannot be processed
    logError('baileys-no-business', { message: `business_id=${BAILEYS_BUSINESS_ID} not_found`, stack: '' });
    return;
  }

  // Safe: remoteJid is guaranteed @s.whatsapp.net at this point (filtered above)
  const customerPhone = msg.key.remoteJid.slice(0, -'@s.whatsapp.net'.length);
  const msgTimestamp  = msg.messageTimestamp ? Number(msg.messageTimestamp) : null;

  const waCredentials = { provider: 'baileys', socket: _socket, businessId: BAILEYS_BUSINESS_ID, remoteJid: msg.key.remoteJid };

  const msgContent = msg.message;
  const msgType    = Object.keys(msgContent)[0];

  // ── Text message ──────────────────────────────────────────────────────────
  if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
    const text = (msgContent.conversation || msgContent.extendedTextMessage?.text || '').trim();
    if (!text) {
      deleteProcessedMessage(BAILEYS_BUSINESS_ID, msgId);
      return;
    }
    try {
      await processIncomingMessage(business, waCredentials, {
        msgId, customerPhone, text,
        msgTimestamp, msgTimestampField: 'msg.messageTimestamp',
      });
    } catch (err) {
      // Rollback dedup so a retry can reprocess
      deleteProcessedMessage(BAILEYS_BUSINESS_ID, msgId);
      throw err;
    }
    return;
  }

  // ── Image — v1: caption as text if present, fallback reply if not ─────────
  if (msgType === 'imageMessage') {
    const caption = (msgContent.imageMessage?.caption || '').trim();
    if (caption) {
      try {
        await processIncomingMessage(business, waCredentials, {
          msgId, customerPhone, text: caption,
          msgTimestamp, msgTimestampField: 'msg.messageTimestamp',
        });
      } catch (err) {
        deleteProcessedMessage(BAILEYS_BUSINESS_ID, msgId);
        throw err;
      }
    } else {
      const { sendWhatsAppMessage } = require('./whatsapp');
      const fallback = 'No puedo ver fotos todavía. ¿Me lo describís en texto?';
      await sendWhatsAppMessage(customerPhone, fallback, waCredentials).catch(() => {});
      logError('baileys-image-fallback', { message: `business_id=${BAILEYS_BUSINESS_ID} from=${customerPhone}`, stack: '' });
    }
    return;
  }

  // ── Audio — v1: not transcribed, explicit fallback reply ─────────────────
  if (msgType === 'audioMessage') {
    const { sendWhatsAppMessage } = require('./whatsapp');
    const fallback = 'No puedo escuchar audios todavía. ¿Me lo escribís?';
    await sendWhatsAppMessage(customerPhone, fallback, waCredentials).catch(() => {});
    logError('baileys-audio-fallback', { message: `business_id=${BAILEYS_BUSINESS_ID} from=${customerPhone}`, stack: '' });
    return;
  }

  // ── All other types: log and delete dedup mark (no reply sent) ────────────
  logError('baileys-unsupported-type', {
    message: `type=${msgType} business_id=${BAILEYS_BUSINESS_ID} from=${customerPhone} msgId=${msgId}`,
    stack: '',
  });
  deleteProcessedMessage(BAILEYS_BUSINESS_ID, msgId);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function initBaileys({ processIncomingMessage, logError, getBusinessById, tryMarkProcessed, deleteProcessedMessage }) {
  if (_state === 'STOPPED') return;

  _deps = { processIncomingMessage, logError, getBusinessById, tryMarkProcessed, deleteProcessedMessage };

  if (!acquireLock()) {
    logError('baileys-lock-busy', {
      message: `Another process holds the lock — Baileys not initialized on this instance`,
      stack: '',
    });
    _deps = null; // clear: stopBaileys() guards on _deps === null; don't hold reference if no lock
    return;
  }

  // SIGTERM is handled by server.js, which calls stopBaileys() before closing
  // the HTTP server and exiting. This ensures the shutdown file is written and
  // the lock is released in the correct order within the full shutdown sequence.
  // SIGINT (Ctrl+C in local dev) is handled here as a fallback.
  process.once('SIGINT', stopBaileys);

  logError('baileys-init', { message: `business_id=${BAILEYS_BUSINESS_ID} session_dir=${SESSION_DIR}`, stack: '' });

  await _connect();
}

function getBaileysQR()          { return _qrB64; }
function getBaileysState()       { return (_qrTimedOut && _state === 'STOPPED') ? 'QR_TIMEOUT' : _state; }
function getBaileysConnectedAt() { return _connectedAt; }

// Exposed for unit tests only — never present in production.
const _forTest = IS_PROD ? null : {
  processStartedAt:  _processStartedAt,
  replayThreshold:   _replayThreshold,
  shutdownFile:      SHUTDOWN_FILE,
  sessionDir:        SESSION_DIR,
  lockFile:          LOCK_FILE,
  getConnectedAt:    () => _connectedAt,
  getState:          () => _state,
  setState:          (s) => { _state = s; },
  getLockToken:      () => _lockToken,
  getLockAcquired:   () => _lockAcquired,
  getHeartbeatTimer:  () => _heartbeatTimer,
  getQrTimedOut:      () => _qrTimedOut,
  getQrTimeoutTimer:  () => _qrTimeoutTimer,
  handleMessage:      _handleMessage,
  acquireLock,
  releaseLock,
  stopBaileys,
  classifyDisconnect,
};

module.exports = {
  initBaileys,
  stopBaileys,
  getBaileysQR,
  getBaileysState,
  getBaileysConnectedAt,
  isBaileysLockHeld,
  BAILEYS_BUSINESS_ID,
  _forTest,
};
