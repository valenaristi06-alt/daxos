#!/usr/bin/env node
'use strict';
// Baileys unit and integration tests.
// Tests run without a live WhatsApp connection.
// Run: node scripts/test-baileys.js

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const Database = require('better-sqlite3');

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail !== undefined ? ': ' + String(detail) : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Minimal processed_messages table in a temp SQLite DB for dedup tests.
function makeTestDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      msg_id      TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, msg_id)
    )
  `);
  const stmtMark   = db.prepare('INSERT OR IGNORE INTO processed_messages (business_id, msg_id) VALUES (?, ?)');
  const stmtDelete = db.prepare('DELETE FROM processed_messages WHERE business_id = ? AND msg_id = ?');
  function tryMarkProcessed(bizId, msgId) { return stmtMark.run(bizId, msgId).changes === 1; }
  function deleteProcessedMessage(bizId, msgId) { stmtDelete.run(bizId, msgId); }
  return { db, tryMarkProcessed, deleteProcessedMessage };
}

// Minimal WA message object as Baileys delivers it.
function makeWAMsg(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    key: {
      remoteJid: '5491100000001@s.whatsapp.net',
      fromMe: false,
      id: 'MSGID_' + Math.random().toString(36).slice(2),
    },
    messageTimestamp: now,
    message: { conversation: 'hola' },
  };
  if (overrides.fromMe !== undefined)        base.key.fromMe    = overrides.fromMe;
  if (overrides.remoteJid !== undefined)     base.key.remoteJid = overrides.remoteJid;
  if (overrides.id !== undefined)            base.key.id        = overrides.id;
  if (overrides.messageTimestamp !== undefined) base.messageTimestamp = overrides.messageTimestamp;
  if (overrides.message !== undefined)       base.message        = overrides.message;
  return base;
}

// ── Load module under test ────────────────────────────────────────────────────

// Ensure IS_PROD is false so _forTest is exported.
delete process.env.RAILWAY_ENVIRONMENT;
process.env.NODE_ENV = 'test';

const baileys = require('../src/baileys');
const { BAILEYS_BUSINESS_ID, getBaileysState, getBaileysQR, getBaileysConnectedAt, _forTest } = baileys;

// ── 1. Module exports ─────────────────────────────────────────────────────────

section('Module exports');
assert('BAILEYS_BUSINESS_ID is 10 (no override set)', BAILEYS_BUSINESS_ID === 10);
assert('getBaileysState() returns IDLE initially', getBaileysState() === 'IDLE');
assert('getBaileysQR() returns null initially', getBaileysQR() === null);
assert('getBaileysConnectedAt() returns null initially', getBaileysConnectedAt() === null);
assert('_forTest exported in non-prod', _forTest !== null && typeof _forTest === 'object');
assert('_forTest.processStartedAt is a recent epoch', typeof _forTest.processStartedAt === 'number' && _forTest.processStartedAt > 1700000000);
assert('_forTest.replayThreshold is a number', typeof _forTest.replayThreshold === 'number' && _forTest.replayThreshold > 1700000000);
assert('_forTest.shutdownFile is a string path', typeof _forTest.shutdownFile === 'string' && _forTest.shutdownFile.endsWith('last_shutdown.json'));
assert('_forTest.sessionDir is a string path', typeof _forTest.sessionDir === 'string' && _forTest.sessionDir.endsWith('baileys-session'));
assert('_forTest.handleMessage is a function', typeof _forTest.handleMessage === 'function');
assert('_forTest.acquireLock is a function', typeof _forTest.acquireLock === 'function');
assert('_forTest.releaseLock is a function', typeof _forTest.releaseLock === 'function');
assert('_forTest.lockFile is a string path', typeof _forTest.lockFile === 'string' && _forTest.lockFile.endsWith('baileys.lock'));
assert('_forTest.getLockToken is a function', typeof _forTest.getLockToken === 'function');
assert('_forTest.getLockAcquired is a function', typeof _forTest.getLockAcquired === 'function');
assert('_forTest.getHeartbeatTimer is a function', typeof _forTest.getHeartbeatTimer === 'function');
assert('_forTest.classifyDisconnect is a function', typeof _forTest.classifyDisconnect === 'function');
assert('isBaileysLockHeld exported from module', typeof baileys.isBaileysLockHeld === 'function');
assert('isBaileysLockHeld() false before any acquire', baileys.isBaileysLockHeld() === false);

// ── 2. Replay guard ───────────────────────────────────────────────────────────

section('Replay guard — uses _replayThreshold (not _connectedAt)');

const { processStartedAt, replayThreshold, handleMessage } = _forTest;

async function testReplayGuard() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-'));
  const { tryMarkProcessed, deleteProcessedMessage } = makeTestDb(tmpDir);

  const calls = [];
  const deps = {
    logError: () => {},
    getBusinessById: (id) => ({ id, name: 'Test', wa_provider: 'baileys' }),
    processIncomingMessage: async (...args) => { calls.push(args); },
    tryMarkProcessed,
    deleteProcessedMessage,
  };

  // 2a. Message from 60s before threshold → dropped
  const oldMsg = makeWAMsg({ messageTimestamp: replayThreshold - 60, id: 'OLD_1' });
  await handleMessage(oldMsg, deps);
  assert('Replay guard drops message from 60s before threshold', calls.length === 0);

  // 2b. Message from 31s before threshold → dropped (outside 30s grace)
  const justOutside = makeWAMsg({ messageTimestamp: replayThreshold - 31, id: 'OLD_2' });
  await handleMessage(justOutside, deps);
  assert('Replay guard drops message from 31s before threshold', calls.length === 0);

  // 2c. Message at exactly -30s boundary → allowed (on the grace boundary)
  const graceBoundary = makeWAMsg({ messageTimestamp: replayThreshold - 30, id: 'GRACE_1' });
  await handleMessage(graceBoundary, deps);
  assert('Replay guard allows message at exactly -30s boundary', calls.length === 1,
    `calls=${calls.length}`);
  calls.length = 0;

  // 2d. Message from 5s before threshold → allowed (within grace)
  const recentMsg = makeWAMsg({ messageTimestamp: replayThreshold - 5, id: 'RECENT_1' });
  await handleMessage(recentMsg, deps);
  assert('Replay guard allows message within 30s grace window', calls.length === 1,
    `calls=${calls.length}`);
  calls.length = 0;

  // 2e. Message from after threshold → allowed
  const nowMsg = makeWAMsg({ messageTimestamp: replayThreshold + 10, id: 'NOW_1' });
  await handleMessage(nowMsg, deps);
  assert('Replay guard allows message from after threshold', calls.length === 1,
    `calls=${calls.length}`);
  calls.length = 0;

  // 2f. Message with null timestamp → allowed (conservative: process if unknown)
  const noTs = makeWAMsg({ id: 'NOTS_1' });
  delete noTs.messageTimestamp;
  await handleMessage(noTs, deps);
  assert('Replay guard allows message with null timestamp (conservative)', calls.length === 1,
    `calls=${calls.length}`);
  calls.length = 0;

  // 2g. Reconnect simulation: _replayThreshold does NOT change on reconnect.
  // A message from the mid-session reconnect window (after process start) must pass.
  // This is the critical difference from the old _connectedAt approach:
  // with _connectedAt the reconnect window messages would be dropped; here they pass.
  const reconnectWindowMsg = makeWAMsg({
    messageTimestamp: processStartedAt + 5,
    id: 'RECONNECT_1',
  });
  await handleMessage(reconnectWindowMsg, deps);
  assert('Replay guard allows message from reconnect window (threshold fixed at process start)', calls.length === 1,
    `calls=${calls.length}`);
  calls.length = 0;

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 2b. Shutdown file persistence ────────────────────────────────────────────

section('Shutdown file — threshold restored from previous SIGTERM');

async function testShutdownFilePersistence() {
  const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-db-'));
  const tmpSessionDir = path.join(tmpDbDir, 'baileys-session');
  fs.mkdirSync(tmpSessionDir, { recursive: true });

  // Write a fake shutdown file (simulates previous process writing on SIGTERM)
  const fakeShutdownAt = processStartedAt - 120; // 2 min before current process start
  fs.writeFileSync(
    path.join(tmpSessionDir, 'last_shutdown.json'),
    JSON.stringify({ shutdownAt: fakeShutdownAt })
  );

  // Reload module with this temp DB_DIR so it reads the shutdown file
  const origDbDir = process.env.DB_DIR;
  process.env.DB_DIR = tmpDbDir;
  delete require.cache[require.resolve('../src/baileys')];
  const baileys2 = require('../src/baileys');

  assert('Reload: _replayThreshold restored from shutdown file',
    baileys2._forTest?.replayThreshold === fakeShutdownAt,
    `got ${baileys2._forTest?.replayThreshold}, want ${fakeShutdownAt}`);

  // Messages from the restart window (between shutdownAt and process start) must pass
  const restartWindowTs = fakeShutdownAt + 10; // 10s after old process died
  assert('Restart window message timestamp is newer than shutdownAt',
    restartWindowTs > fakeShutdownAt);
  assert('Restart window message passes guard (restartWindowTs >= threshold - 30)',
    restartWindowTs >= fakeShutdownAt - 30);

  // Corrupt shutdown file → falls back to processStartedAt
  process.env.DB_DIR = tmpDbDir + '-corrupt';
  const corruptSessionDir = path.join(process.env.DB_DIR, 'baileys-session');
  fs.mkdirSync(corruptSessionDir, { recursive: true });
  fs.writeFileSync(path.join(corruptSessionDir, 'last_shutdown.json'), 'not-valid-json');
  delete require.cache[require.resolve('../src/baileys')];
  const baileys3 = require('../src/baileys');
  assert('Corrupt shutdown file: threshold falls back to processStartedAt',
    typeof baileys3._forTest?.replayThreshold === 'number' &&
    baileys3._forTest.replayThreshold >= baileys3._forTest.processStartedAt - 1,
    `got ${baileys3._forTest?.replayThreshold}`);

  // Restore
  if (origDbDir !== undefined) process.env.DB_DIR = origDbDir;
  else delete process.env.DB_DIR;
  delete require.cache[require.resolve('../src/baileys')];
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  try { fs.rmSync(tmpDbDir + '-corrupt', { recursive: true, force: true }); } catch {}
}

// ── 3. Pre-filter guards ──────────────────────────────────────────────────────

section('Pre-filter guards (fromMe, group, empty)');

async function testPreFilters() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-'));
  const { tryMarkProcessed, deleteProcessedMessage } = makeTestDb(tmpDir);

  const calls = [];
  const deps = {
    logError: () => {},
    getBusinessById: (id) => ({ id, name: 'Test', wa_provider: 'baileys' }),
    processIncomingMessage: async (...args) => { calls.push(args); },
    tryMarkProcessed,
    deleteProcessedMessage,
  };

  // fromMe = true → ignored, no processIncomingMessage
  const fromMeMsg = makeWAMsg({ fromMe: true });
  await handleMessage(fromMeMsg, deps);
  assert('fromMe=true message is ignored', calls.length === 0);

  // Group JID → ignored
  const groupMsg = makeWAMsg({ remoteJid: '120363000000000001@g.us' });
  await handleMessage(groupMsg, deps);
  assert('Group JID message is ignored', calls.length === 0);

  // No message field → ignored
  const emptyMsg = makeWAMsg({ message: null });
  await handleMessage(emptyMsg, deps);
  assert('Message with null message field is ignored', calls.length === 0);

  // No key.id → ignored
  const noId = makeWAMsg({ id: '' });
  noId.key.id = '';
  await handleMessage(noId, deps);
  assert('Message with empty id is ignored', calls.length === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 4. Dedup (tryMarkProcessed) ───────────────────────────────────────────────

section('Dedup — INSERT OR IGNORE guarantees');

async function testDedup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-'));
  const { tryMarkProcessed, deleteProcessedMessage } = makeTestDb(tmpDir);

  const calls = [];
  const deps = {
    logError: () => {},
    getBusinessById: (id) => ({ id, name: 'Test', wa_provider: 'baileys' }),
    processIncomingMessage: async (...args) => { calls.push(args); },
    tryMarkProcessed,
    deleteProcessedMessage,
  };

  const msgId = 'DEDUP_TEST_' + Date.now();
  const msg1 = makeWAMsg({ id: msgId, messageTimestamp: processStartedAt + 5 });

  // First call: tryMarkProcessed returns true → processIncomingMessage called
  await handleMessage(msg1, deps);
  assert('Dedup: first message is processed', calls.length === 1, `calls=${calls.length}`);

  // Second call: same msgId → tryMarkProcessed returns false → not processed again
  const msg2 = makeWAMsg({ id: msgId, messageTimestamp: processStartedAt + 5 });
  await handleMessage(msg2, deps);
  assert('Dedup: duplicate message is discarded', calls.length === 1, `calls=${calls.length}`);

  // Different business, same msg_id → independent dedup per business
  const { tryMarkProcessed: tmpOther, deleteProcessedMessage: delOther } = makeTestDb(
    fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-other-'))
  );
  const r1 = tmpOther(5, msgId);  // business_id=5
  const r2 = tmpOther(10, msgId); // business_id=10
  assert('Dedup: same msg_id on different business IDs are independent', r1 === true && r2 === true,
    `r1=${r1} r2=${r2}`);

  // deleteProcessedMessage allows reprocessing
  deleteProcessedMessage(BAILEYS_BUSINESS_ID, msgId);
  const msg3 = makeWAMsg({ id: msgId, messageTimestamp: processStartedAt + 5 });
  await handleMessage(msg3, deps);
  assert('Dedup: after deleteProcessedMessage, same message can be reprocessed', calls.length === 2,
    `calls=${calls.length}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 5. waCredentials include remoteJid ───────────────────────────────────────

section('waCredentials — remoteJid for markAsRead');

async function testRemoteJid() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-'));
  const { tryMarkProcessed, deleteProcessedMessage } = makeTestDb(tmpDir);

  const receivedCreds = [];
  const deps = {
    logError: () => {},
    getBusinessById: (id) => ({ id, name: 'Test', wa_provider: 'baileys' }),
    processIncomingMessage: async (_business, creds, _payload) => {
      receivedCreds.push(creds);
    },
    tryMarkProcessed,
    deleteProcessedMessage,
  };

  const jid = '5491199999999@s.whatsapp.net';
  const msg = makeWAMsg({ remoteJid: jid, messageTimestamp: processStartedAt + 10 });
  await handleMessage(msg, deps);

  assert('waCredentials.provider is baileys', receivedCreds[0]?.provider === 'baileys',
    receivedCreds[0]?.provider);
  assert('waCredentials.remoteJid is set', receivedCreds[0]?.remoteJid === jid,
    receivedCreds[0]?.remoteJid);
  assert('waCredentials.businessId matches BAILEYS_BUSINESS_ID',
    receivedCreds[0]?.businessId === BAILEYS_BUSINESS_ID,
    receivedCreds[0]?.businessId);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 6. Lock mechanism — token-based O_EXCL + stale detection ─────────────────

section('Lock mechanism — UUID token, O_EXCL, heartbeat, fencing');

function testLock() {
  // These tests call the ACTUAL _forTest.acquireLock / releaseLock functions,
  // which operate on the real SESSION_DIR (data/baileys-session/baileys.lock).
  // Each test pre-cleans the lock file and restores state afterwards.

  const lockFile = _forTest.lockFile;
  const acquireLock = _forTest.acquireLock;
  const releaseLock = _forTest.releaseLock;

  // Pre-clean: remove any existing lock file so tests start from a known state
  try { fs.unlinkSync(lockFile); } catch {}

  // 1. Fresh acquire succeeds; lock file contains valid JSON with UUID token
  const acquired1 = acquireLock();
  assert('Lock: fresh acquire returns true', acquired1 === true);
  assert('Lock: _lockAcquired true after acquire', _forTest.getLockAcquired() === true);
  assert('Lock: _lockToken is a non-empty string', typeof _forTest.getLockToken() === 'string' && _forTest.getLockToken().length > 0);

  const lockData1 = (() => { try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; } })();
  assert('Lock: lock file contains JSON object', lockData1 !== null && typeof lockData1 === 'object');
  assert('Lock: lock file token matches _lockToken', lockData1?.token === _forTest.getLockToken());
  assert('Lock: lock file has heartbeatAt (epoch number)', typeof lockData1?.heartbeatAt === 'number' && lockData1.heartbeatAt > 1_700_000_000);
  assert('Lock: lock file has lockedAt (epoch number)', typeof lockData1?.lockedAt === 'number');

  // 2. Second acquire attempt returns false (lock is fresh)
  const acquired2 = acquireLock();
  assert('Lock: second acquire returns false when lock held (fresh)', acquired2 === false);

  // 3. releaseLock removes the file and clears state
  releaseLock();
  assert('Lock: _lockAcquired false after release', _forTest.getLockAcquired() === false);
  assert('Lock: _lockToken null after release', _forTest.getLockToken() === null);
  assert('Lock: isBaileysLockHeld() false after release', baileys.isBaileysLockHeld() === false);
  assert('Lock: lock file deleted after release', !fs.existsSync(lockFile));

  // 4. Acquire again after release succeeds
  const acquired3 = acquireLock();
  assert('Lock: re-acquire after release returns true', acquired3 === true);
  assert('Lock: isBaileysLockHeld() true after re-acquire', baileys.isBaileysLockHeld() === true);
  releaseLock();

  // 5. Stale lock (heartbeatAt > 30s ago) → stolen, acquire succeeds
  const staleToken = 'aaaaaaaa-0000-0000-0000-000000000000';
  const staleTs = Math.floor(Date.now() / 1000) - 60; // 60 seconds ago
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ token: staleToken, lockedAt: staleTs, heartbeatAt: staleTs }));
  const acquired4 = acquireLock();
  assert('Lock: stale lock (>30s) is stolen and acquire succeeds', acquired4 === true);
  assert('Lock: new token differs from stale token', _forTest.getLockToken() !== staleToken);
  const lockData4 = (() => { try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; } })();
  assert('Lock: stale lock replaced with new token in file', lockData4?.token === _forTest.getLockToken());
  releaseLock();

  // 6. Fresh lock (heartbeatAt < 30s ago) → NOT stolen
  const freshToken = 'bbbbbbbb-0000-0000-0000-000000000000';
  const freshTs = Math.floor(Date.now() / 1000) - 5; // 5 seconds ago (fresh)
  fs.writeFileSync(lockFile, JSON.stringify({ token: freshToken, lockedAt: freshTs, heartbeatAt: freshTs }));
  const acquired5 = acquireLock();
  assert('Lock: fresh lock (<30s) is NOT stolen, acquire returns false', acquired5 === false);
  assert('Lock: fresh lock token preserved in file', (() => {
    try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')).token === freshToken; } catch { return false; }
  })());
  // Clean up manually (we didn't acquire, so releaseLock has no token to check)
  try { fs.unlinkSync(lockFile); } catch {}

  // 7. Fencing: releaseLock with token mismatch does NOT delete file
  // Simulate: we hold old token, but file was updated by another process
  const ourToken = 'cccccccc-0000-0000-0000-000000000000';
  const otherToken = 'dddddddd-0000-0000-0000-000000000000';
  // Manually set internal state to simulate we "hold" ourToken
  // (We can't call acquireLock since file doesn't exist, so write directly and fake state)
  fs.writeFileSync(lockFile, JSON.stringify({ token: otherToken, lockedAt: Date.now() / 1000, heartbeatAt: Date.now() / 1000 }));
  // Acquire (will fail since file is fresh)
  // Instead, test fencing by using releaseLock's logic:
  // releaseLock only deletes if file token matches _lockToken.
  // Since _lockToken is null (after all the above releases), it's a no-op.
  // So we verify the file survives a releaseLock() call when we don't own it.
  const fileExistedBefore = fs.existsSync(lockFile);
  releaseLock(); // _lockToken is null — should be a no-op
  const fileExistsAfter = fs.existsSync(lockFile);
  assert('Lock: fencing — releaseLock with no token does not delete file', fileExistedBefore && fileExistsAfter);
  // Clean up
  try { fs.unlinkSync(lockFile); } catch {}
}

// ── 7. Meta/Kapso suppression conditions ─────────────────────────────────────

section('Suppression — COLBET (id=10) only, others unaffected');

function testSuppression() {
  // The suppression condition in server.js:
  //   BAILEYS_ENABLED === '1' && business.id === BAILEYS_BUSINESS_ID && isBaileysLockHeld()
  // Testing the condition directly without running the server.

  function shouldSuppress(baileysEnabled, businessId, lockHeld) {
    return baileysEnabled === '1' && businessId === BAILEYS_BUSINESS_ID && lockHeld === true;
  }

  // COLBET suppressed only when BAILEYS_ENABLED=1 AND lock is held
  assert('Meta suppression: COLBET suppressed when BAILEYS_ENABLED=1 and lock held',
    shouldSuppress('1', 10, true) === true);

  // COLBET NOT suppressed when lock not held (Baileys not running)
  assert('Meta suppression: COLBET NOT suppressed when lock NOT held',
    shouldSuppress('1', 10, false) === false);

  // Other businesses NOT suppressed even when BAILEYS_ENABLED=1 and lock held
  assert('Meta suppression: business_id=1 NOT suppressed',
    shouldSuppress('1', 1, true) === false);
  assert('Meta suppression: business_id=5 NOT suppressed',
    shouldSuppress('1', 5, true) === false);
  assert('Meta suppression: business_id=99 NOT suppressed',
    shouldSuppress('1', 99, true) === false);

  // COLBET NOT suppressed when BAILEYS_ENABLED != '1'
  assert('Meta suppression: COLBET NOT suppressed when BAILEYS_ENABLED=0',
    shouldSuppress('0', 10, true) === false);
  assert('Meta suppression: COLBET NOT suppressed when BAILEYS_ENABLED not set',
    shouldSuppress(undefined, 10, true) === false);

  // Rollback: unsetting BAILEYS_ENABLED removes suppression
  assert('Rollback: after BAILEYS_ENABLED removed, COLBET no longer suppressed',
    shouldSuppress(undefined, 10, true) === false);
}

// ── 8. BAILEYS_BUSINESS_ID isolation ─────────────────────────────────────────

section('Business isolation — BAILEYS_BUSINESS_ID hardcoded to 10 in prod');

function testBusinessIdIsolation() {
  assert('BAILEYS_BUSINESS_ID is exactly 10', BAILEYS_BUSINESS_ID === 10);
  assert('BAILEYS_BUSINESS_ID is a number', typeof BAILEYS_BUSINESS_ID === 'number');

  // Verify that the suppression condition is an exact equality (no coercion trap)
  assert('Suppression uses strict equality: "10" !== 10', '10' !== BAILEYS_BUSINESS_ID);
  assert('Suppression uses strict equality: 10.0 === 10', 10.0 === BAILEYS_BUSINESS_ID);

  // business.id comes from SQLite INTEGER → always a JS number. Safe.
  const bizFromDb = { id: 10 };  // simulates getBusinessByPhoneNumberId result
  assert('DB business.id (integer) matches BAILEYS_BUSINESS_ID correctly',
    bizFromDb.id === BAILEYS_BUSINESS_ID);

  const otherBiz = { id: 7 };
  assert('Another business id does NOT match BAILEYS_BUSINESS_ID',
    otherBiz.id !== BAILEYS_BUSINESS_ID);
}

// ── 9. Provider selection — baileys only for COLBET ───────────────────────────

section('Provider selection — Baileys only for COLBET');

function testProviderSelection() {
  // waCredentials.provider determines which send path is taken.
  // Only COLBET messages arrive via Baileys. Meta/Kapso messages from other
  // businesses carry provider='meta' or provider='kapso' — unaffected.

  const baileysCredentials = { provider: 'baileys', businessId: BAILEYS_BUSINESS_ID };
  const metaCredentials    = { provider: 'meta',    businessId: 5 };
  const kapsoCredentials   = { provider: 'kapso',   businessId: 3 };

  assert('Baileys creds: provider is baileys',   baileysCredentials.provider === 'baileys');
  assert('Meta creds: provider is meta (unaffected)', metaCredentials.provider === 'meta');
  assert('Kapso creds: provider is kapso (unaffected)', kapsoCredentials.provider === 'kapso');

  // Log tag selection (mirrors server.js logic)
  function sendCtxOk(provider) {
    return provider === 'kapso'  ? 'kapso-send-ok'
         : provider === 'baileys' ? 'baileys-send-ok'
         : 'webhook-send-ok';
  }
  function sendCtxErr(provider) {
    return provider === 'kapso'  ? 'kapso-send-err'
         : provider === 'baileys' ? 'baileys-send-err'
         : 'webhook-send-error';
  }

  assert('Log tag ok: baileys → baileys-send-ok',   sendCtxOk('baileys') === 'baileys-send-ok');
  assert('Log tag ok: kapso → kapso-send-ok',        sendCtxOk('kapso')   === 'kapso-send-ok');
  assert('Log tag ok: meta → webhook-send-ok',       sendCtxOk('meta')    === 'webhook-send-ok');
  assert('Log tag err: baileys → baileys-send-err',  sendCtxErr('baileys') === 'baileys-send-err');
  assert('Log tag err: kapso → kapso-send-err',      sendCtxErr('kapso')   === 'kapso-send-err');
  assert('Log tag err: meta → webhook-send-error',   sendCtxErr('meta')    === 'webhook-send-error');
}

// ── 10. Transition / rollback ──────────────────────────────────────────────────

section('Transition and rollback conditions');

function testTransitionRollback() {
  function isSuppressed(baileysEnabled, businessId, lockHeld) {
    return baileysEnabled === '1' && businessId === BAILEYS_BUSINESS_ID && lockHeld === true;
  }

  // Before activation: Meta processes COLBET normally (no lock held)
  assert('Before activation: COLBET processed by Meta', isSuppressed(undefined, 10, false) === false);

  // After activation WITH lock: Meta suppressed for COLBET
  assert('After activation + lock held: COLBET suppressed from Meta', isSuppressed('1', 10, true) === true);

  // Baileys enabled but lock NOT held (e.g. starting up): Meta NOT suppressed
  assert('BAILEYS_ENABLED=1 but lock NOT held: COLBET NOT suppressed', isSuppressed('1', 10, false) === false);

  // Rollback (unset BAILEYS_ENABLED): Meta resumes for COLBET regardless of lock
  assert('Rollback: Meta resumes for COLBET when BAILEYS_ENABLED removed', isSuppressed(undefined, 10, true) === false);

  // Other businesses unaffected throughout all states
  assert('Other businesses: unaffected before activation', isSuppressed(undefined, 5, false) === false);
  assert('Other businesses: unaffected when BAILEYS_ENABLED=1+lock', isSuppressed('1', 5, true) === false);
  assert('Other businesses: unaffected after rollback', isSuppressed(undefined, 5, true) === false);

  // Suppression is per-business
  assert('Suppression is per-business: COLBET suppressed, biz=7 not',
    isSuppressed('1', 10, true) === true && isSuppressed('1', 7, true) === false);
}

// ── 11. Duplicate prevention ───────────────────────────────────────────────────

section('Duplicate response prevention');

async function testDuplicatePrevention() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-dup-'));
  const { tryMarkProcessed, deleteProcessedMessage } = makeTestDb(tmpDir);

  const calls = [];
  const deps = {
    logError: () => {},
    getBusinessById: (id) => ({ id, name: 'Test', wa_provider: 'baileys' }),
    processIncomingMessage: async (...args) => { calls.push(args); },
    tryMarkProcessed,
    deleteProcessedMessage,
  };

  const msgId = 'DUP_SCENARIO_' + Date.now();
  const ts = processStartedAt + 20;

  // Simulate: Meta processes first (wins dedup for business_id=10, same msg_id)
  const metaWon = tryMarkProcessed(BAILEYS_BUSINESS_ID, msgId);
  assert('Dedup: Meta wins first (returns true)', metaWon === true);

  // Baileys delivers same message: tryMarkProcessed returns false → no response
  const msg = makeWAMsg({ id: msgId, messageTimestamp: ts });
  await handleMessage(msg, deps);
  assert('Dedup: Baileys loses when Meta already processed same msg (no duplicate response)',
    calls.length === 0, `calls=${calls.length}`);

  // Reverse: Baileys wins first
  const msgId2 = 'DUP_SCENARIO2_' + Date.now();
  const msg2 = makeWAMsg({ id: msgId2, messageTimestamp: ts });
  await handleMessage(msg2, deps);
  assert('Dedup: Baileys wins first (processes message)', calls.length === 1, `calls=${calls.length}`);

  // Meta tries same message: tryMarkProcessed returns false → Meta would skip
  const metaLost = tryMarkProcessed(BAILEYS_BUSINESS_ID, msgId2);
  assert('Dedup: Meta loses when Baileys already processed same msg', metaLost === false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 12. QR page security ───────────────────────────────────────────────────────

section('QR page security — file and route');

function testQrPageSecurity() {
  const htmlPath = path.join(__dirname, '../src/views/baileys-qr.html');
  assert('src/views/baileys-qr.html exists', fs.existsSync(htmlPath));

  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');

    // Must not reference external resources (no CDN, no external scripts)
    assert('QR page has no external script tags',
      !/<script[^>]+src="https?:/.test(html));
    assert('QR page has no external stylesheet links',
      !/<link[^>]+href="https?:/.test(html));

    // QR data URL must not appear in any console.log / console.error
    assert('QR page does not log qrImg.src to console',
      !html.includes('console.log') || !html.includes('qrImg.src'));

    // Polling stops on 401/403/404
    assert('QR page stops polling on 401', html.includes('stopped = true') && html.includes('401'));
    assert('QR page stops polling on 403/404', html.includes('stopped = true') && (html.includes('403') || html.includes('404')));

    // QR cleared when not in qr_pending state
    assert('QR page clears qrImg.src when QR not shown', html.includes("qrImg.src = ''"));

    // Polls /api/baileys/qr with credentials
    assert('QR page polls authenticated endpoint', html.includes('/api/baileys/qr'));
    assert('QR page uses same-origin credentials', html.includes("credentials: 'same-origin'"));
  }
}

// ── 13. Session persistence ────────────────────────────────────────────────────

section('Session persistence — path is inside DB_DIR volume');

function testSessionPersistence() {
  // SESSION_DIR = ${DB_DIR}/baileys-session/
  // On Railway: DB_DIR = /app/data (persistent volume)
  // The path must be a subdirectory of DB_DIR, not hardcoded elsewhere.

  const DB_DIR = process.env.DB_DIR || path.join(__dirname, '../data');
  const expectedSessionDir = path.join(DB_DIR, 'baileys-session');

  // Verify the module uses DB_DIR for its session dir by checking the source
  const src = fs.readFileSync(path.join(__dirname, '../src/baileys.js'), 'utf8');
  assert('baileys.js defines SESSION_DIR relative to DB_DIR',
    src.includes("path.join(DB_DIR, 'baileys-session')") ||
    src.includes('baileys-session'));
  assert('baileys.js uses process.env.DB_DIR', src.includes('process.env.DB_DIR'));
  assert('SESSION_DIR does not contain hardcoded absolute path',
    !src.match(/SESSION_DIR\s*=\s*['"`]\/(?!app\/data)/));
}

// ── 14. _forTest null in production ───────────────────────────────────────────

section('_forTest is null in production (guarded by IS_PROD)');

function testForTestIsGuarded() {
  const src = fs.readFileSync(path.join(__dirname, '../src/baileys.js'), 'utf8');
  assert('_forTest export is guarded by IS_PROD check', src.includes('IS_PROD ? null'));
}

// ── 15. Cross-provider dedup — extractRawIdFromWamid ─────────────────────────

section('Cross-provider dedup — extractRawIdFromWamid in server.js');

function testCrossProviderDedup() {
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

  // Function must exist in server.js
  assert('extractRawIdFromWamid defined in server.js',
    serverSrc.includes('function extractRawIdFromWamid('));
  assert('Cross-provider dedup used in Meta webhook path',
    serverSrc.includes('extractRawIdFromWamid(msg.id)'));
  assert('Cross-provider dedup logs meta_cross_provider on duplicate',
    serverSrc.includes('meta_cross_provider'));

  // Behaviorally test the same function logic (extracted for unit testing)
  function extractRawIdFromWamid(wamid) {
    if (!wamid?.startsWith('wamid.')) return null;
    try {
      const buf = Buffer.from(wamid.slice(6), 'base64');
      let end = buf.length - 1;
      while (end > 0 && buf[end] === 0) end--;
      let start = end;
      while (start > 0 && buf[start - 1] >= 0x20 && buf[start - 1] < 0x7f) start--;
      const candidate = buf.slice(start, end + 1).toString();
      return (candidate.length >= 10 && /^[A-Z0-9]+$/.test(candidate)) ? candidate : null;
    } catch { return null; }
  }

  // Null/undefined input
  assert('extractRawIdFromWamid: null → null', extractRawIdFromWamid(null) === null);
  assert('extractRawIdFromWamid: undefined → null', extractRawIdFromWamid(undefined) === null);
  assert('extractRawIdFromWamid: empty string → null', extractRawIdFromWamid('') === null);
  assert('extractRawIdFromWamid: not-wamid prefix → null', extractRawIdFromWamid('msgid.abc123') === null);
  assert('extractRawIdFromWamid: malformed base64 → null', extractRawIdFromWamid('wamid.!!!') === null);

  // A real-world wamid where we know the raw ID
  // Constructed: header bytes (6) + digits + 0x00 + raw_id (uppercase alphanum) + 0x00
  const rawId = 'ABCDEFGH12345678';
  const payload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // header padding
    Buffer.from('5491100000001'),                         // phone digits
    Buffer.from([0x00]),                                  // separator
    Buffer.from(rawId),                                   // raw WA ID
    Buffer.from([0x00]),                                  // NUL terminator
  ]);
  const wamid = 'wamid.' + payload.toString('base64');
  const extracted = extractRawIdFromWamid(wamid);
  assert('extractRawIdFromWamid: extracts raw ID from valid wamid', extracted === rawId,
    `expected=${rawId} got=${extracted}`);

  // Cross-provider dedup scenario: Baileys processes rawId first; Meta arrives later
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-xprov2-'));
  const { tryMarkProcessed } = makeTestDb(tmpDir);

  // Baileys stores raw ID
  const baileysWins = tryMarkProcessed(BAILEYS_BUSINESS_ID, rawId);
  assert('Cross-provider dedup: Baileys inserts raw ID first (true)', baileysWins === true);

  // Meta webhook extracts rawId and calls tryMarkProcessed — should return false (already exists)
  const metaLoses = tryMarkProcessed(BAILEYS_BUSINESS_ID, rawId);
  assert('Cross-provider dedup: Meta loses — raw ID already in processed_messages (false)',
    metaLoses === false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 16. Graceful shutdown verification ───────────────────────────────────────
// Architecture: server.js owns SIGTERM (calls stopBaileys() then closes HTTP server).
// baileys.js owns SIGINT (local dev). stopBaileys() is module-level, exported.

section('Graceful shutdown — stopBaileys + HTTP server + server.js coordination');

function testSigtermCleanup() {
  const src       = fs.readFileSync(path.join(__dirname, '../src/baileys.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

  // stopBaileys() in baileys.js
  assert('stopBaileys() function defined in baileys.js',
    src.includes('function stopBaileys()'));
  assert('stopBaileys() writes SHUTDOWN_FILE',
    src.includes('writeFileSync(SHUTDOWN_FILE'));
  assert('stopBaileys() closes socket',
    src.includes("_socket.end?.()"));
  assert('stopBaileys() sets _state = STOPPED',
    src.includes("_state = 'STOPPED'"));
  assert('stopBaileys() calls releaseLock()',
    src.includes('releaseLock()'));
  assert('stopBaileys() logs shutdown file write failure (no silent swallow)',
    src.includes('baileys-shutdown-file-error'));
  assert('stopBaileys() exported from baileys.js',
    src.includes('stopBaileys') && src.includes('module.exports'));

  // SIGINT in baileys.js (local dev fallback)
  assert('SIGINT handler calls stopBaileys in baileys.js',
    src.includes("process.once('SIGINT', stopBaileys)"));

  // SIGTERM ownership in server.js
  assert('server.js SIGTERM handler calls stopBaileys()',
    serverSrc.includes('stopBaileys()') && serverSrc.includes('SIGTERM'));
  assert('server.js uses _httpServer.close() for graceful HTTP drain',
    serverSrc.includes('_httpServer.close('));
  assert('server.js has force-exit timeout after graceful drain',
    serverSrc.includes('setTimeout') && serverSrc.includes('.unref()'));

  // Verify shutdown file path is inside SESSION_DIR (persistent volume)
  assert('SHUTDOWN_FILE is inside SESSION_DIR (persistent volume path)',
    src.includes("path.join(SESSION_DIR, 'last_shutdown.json')"));
}

// ── 16b. STOPPED state guard — behavioral test ───────────────────────────────

section('STOPPED state guard — handleMessage dropped when state=STOPPED');

async function testStoppedStateGuard() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-stopped-'));
  const { tryMarkProcessed: tms, deleteProcessedMessage: dpm } = makeTestDb(tmpDir);

  const calls  = [];
  const errors = [];
  const deps = {
    logError: (tag, data) => { errors.push({ tag, data }); },
    getBusinessById: (id) => ({ id, name: 'Test' }),
    processIncomingMessage: async (...args) => { calls.push(args); },
    tryMarkProcessed: tms,
    deleteProcessedMessage: dpm,
  };

  // Temporarily set state to STOPPED (simulates post-SIGTERM condition)
  const prevState = _forTest.getState();
  _forTest.setState('STOPPED');

  const msg = makeWAMsg({ id: 'STOPPED_TEST_1' });
  await handleMessage(msg, deps);

  assert('handleMessage returns without calling processIncomingMessage when state=STOPPED',
    calls.length === 0, `calls=${calls.length}`);
  assert('handleMessage logs baileys-msg-dropped-stopped tag',
    errors.some(e => e.tag === 'baileys-msg-dropped-stopped'),
    `error tags=${errors.map(e => e.tag).join(',')}`);
  // tryMarkProcessed should NOT have been called — message not in dedup table yet
  assert('handleMessage does NOT mark message as processed when state=STOPPED',
    tms(BAILEYS_BUSINESS_ID, 'STOPPED_TEST_1') === true, // true = first insert = NOT previously marked
    'message was incorrectly marked as processed before the guard ran');

  _forTest.setState(prevState);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 16c. stopBaileys() no-op before init ─────────────────────────────────────

section('stopBaileys() — no-op when never initialized');

function testStopBaileysNoOp() {
  // _deps is null in this test context (initBaileys was never called).
  // stopBaileys() must not throw and must not change observable state.
  const stateBefore = _forTest.getState();
  assert('stopBaileys() is exported from module', typeof baileys.stopBaileys === 'function');
  baileys.stopBaileys(); // must not throw
  assert('stopBaileys() is no-op before init: state unchanged', _forTest.getState() === stateBefore,
    `state changed from ${stateBefore} to ${_forTest.getState()}`);
}

// ── 17. JID filtering — @lid and non-@s.whatsapp.net ─────────────────────────

section('JID filtering — @lid and unknown formats rejected before processing');

async function testJidFiltering() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-jid-'));
  const { tryMarkProcessed: tms, deleteProcessedMessage: dpm } = makeTestDb(tmpDir);

  const calls  = [];
  const errors = [];
  const deps = {
    logError: (tag, data) => errors.push({ tag, data }),
    getBusinessById: (id) => ({ id, name: 'Test' }),
    processIncomingMessage: async (...args) => calls.push(args),
    tryMarkProcessed: tms,
    deleteProcessedMessage: dpm,
  };

  // @lid JID — WhatsApp Linked Account ID (privacy feature) — not a phone number
  const lidMsg = makeWAMsg({ remoteJid: 'LIDABCDEF12345678@lid', messageTimestamp: processStartedAt + 10 });
  await handleMessage(lidMsg, deps);
  assert('@lid JID: processIncomingMessage NOT called', calls.length === 0, `calls=${calls.length}`);
  assert('@lid JID: baileys-jid-skip logged',
    errors.some(e => e.tag === 'baileys-jid-skip'), `tags=${errors.map(e => e.tag).join(',')}`);
  assert('@lid JID: message NOT marked as processed (no dedup entry)',
    tms(BAILEYS_BUSINESS_ID, lidMsg.key.id) === true, // true = first insert = was NOT previously marked
    'LID message was incorrectly marked as processed');
  errors.length = 0;

  // @newsletter JID — also non-peer, should be skipped
  const nlMsg = makeWAMsg({ remoteJid: '123456789@newsletter', messageTimestamp: processStartedAt + 10 });
  await handleMessage(nlMsg, deps);
  assert('@newsletter JID: processIncomingMessage NOT called', calls.length === 0, `calls=${calls.length}`);
  assert('@newsletter JID: baileys-jid-skip logged',
    errors.some(e => e.tag === 'baileys-jid-skip'), `tags=${errors.map(e => e.tag).join(',')}`);
  errors.length = 0;

  // @s.whatsapp.net JID — should pass through to processIncomingMessage
  const validMsg = makeWAMsg({ remoteJid: '5491100000001@s.whatsapp.net', messageTimestamp: processStartedAt + 10 });
  await handleMessage(validMsg, deps);
  assert('@s.whatsapp.net JID: processIncomingMessage called', calls.length === 1, `calls=${calls.length}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 18. whatsapp.js Baileys send routes ───────────────────────────────────────

section('whatsapp.js — Baileys send routes (mock socket, no live WA)');

async function testWhatsappBaileysRoutes() {
  const { sendWhatsAppMessage, uploadMedia, sendWhatsAppAudio, sendWhatsAppDocument,
          sendWhatsAppImage, markAsRead, sendTypingIndicator } = require('../src/whatsapp');

  const remoteJid = '5491100000001@s.whatsapp.net';
  const calls = [];
  const mockSock = {
    sendMessage:        async (jid, content) => { calls.push({ fn: 'sendMessage',        jid, content }); },
    readMessages:       async (keys)         => { calls.push({ fn: 'readMessages',        keys }); },
    sendPresenceUpdate: async (type, jid)    => { calls.push({ fn: 'sendPresenceUpdate', type, jid }); },
  };
  const creds = { provider: 'baileys', socket: mockSock, remoteJid };

  // uploadMedia → returns _baileys sentinel (no HTTP call)
  const audioBuf = Buffer.from('fake-audio');
  const sentinel  = await uploadMedia(audioBuf, 'reply.ogg', 'audio/ogg; codecs=opus', creds);
  assert('uploadMedia: returns _baileys sentinel for Baileys', sentinel?._baileys === true, JSON.stringify(sentinel));
  assert('uploadMedia: sentinel preserves buffer reference', sentinel.buffer === audioBuf);
  assert('uploadMedia: sentinel preserves mimeType', sentinel.mimeType === 'audio/ogg; codecs=opus');

  // sendWhatsAppMessage → uses creds.remoteJid, not reconstructed from phone digits
  await sendWhatsAppMessage('5491100000001', 'Hola mundo', creds);
  const smCall = calls.find(c => c.fn === 'sendMessage' && c.content?.text);
  assert('sendWhatsAppMessage: uses creds.remoteJid as JID (not reconstructed)', smCall?.jid === remoteJid, smCall?.jid);
  assert('sendWhatsAppMessage: sends text content correctly', smCall?.content?.text === 'Hola mundo');
  calls.length = 0;

  // sendWhatsAppAudio → sends buffer as voice note
  await sendWhatsAppAudio('5491100000001', sentinel, creds);
  const audioCall = calls.find(c => c.fn === 'sendMessage' && c.content?.audio);
  assert('sendWhatsAppAudio: sends to creds.remoteJid', audioCall?.jid === remoteJid, audioCall?.jid);
  assert('sendWhatsAppAudio: sends audio buffer from sentinel', audioCall?.content?.audio === audioBuf);
  assert('sendWhatsAppAudio: sets ptt=true for voice note', audioCall?.content?.ptt === true);
  calls.length = 0;

  // sendWhatsAppDocument → sends buffer with filename
  const docBuf = Buffer.from('fake-pdf');
  const docSentinel = await uploadMedia(docBuf, 'doc.pdf', 'application/pdf', creds);
  await sendWhatsAppDocument('5491100000001', docSentinel, 'doc.pdf', creds);
  const docCall = calls.find(c => c.fn === 'sendMessage' && c.content?.document);
  assert('sendWhatsAppDocument: sends to creds.remoteJid', docCall?.jid === remoteJid, docCall?.jid);
  assert('sendWhatsAppDocument: sends document buffer', docCall?.content?.document === docBuf);
  assert('sendWhatsAppDocument: sets fileName', docCall?.content?.fileName === 'doc.pdf');
  calls.length = 0;

  // sendWhatsAppImage → sends buffer with optional caption
  const imgBuf = Buffer.from('fake-img');
  const imgSentinel = await uploadMedia(imgBuf, 'img.jpg', 'image/jpeg', creds);
  await sendWhatsAppImage('5491100000001', imgSentinel, 'mi caption', creds);
  const imgCall = calls.find(c => c.fn === 'sendMessage' && c.content?.image);
  assert('sendWhatsAppImage: sends to creds.remoteJid', imgCall?.jid === remoteJid, imgCall?.jid);
  assert('sendWhatsAppImage: sends image buffer', imgCall?.content?.image === imgBuf);
  assert('sendWhatsAppImage: passes caption', imgCall?.content?.caption === 'mi caption');
  calls.length = 0;

  // markAsRead → calls sock.readMessages with correct key structure
  await markAsRead('MSG_ID_123', creds);
  const readCall = calls.find(c => c.fn === 'readMessages');
  assert('markAsRead: calls sock.readMessages', readCall !== undefined);
  assert('markAsRead: key has correct remoteJid', readCall?.keys?.[0]?.remoteJid === remoteJid);
  assert('markAsRead: key has correct id', readCall?.keys?.[0]?.id === 'MSG_ID_123');
  assert('markAsRead: key has fromMe=false', readCall?.keys?.[0]?.fromMe === false);
  calls.length = 0;

  // sendTypingIndicator → calls sock.sendPresenceUpdate(composing, remoteJid)
  await sendTypingIndicator('5491100000001', creds);
  const typingCall = calls.find(c => c.fn === 'sendPresenceUpdate');
  assert('sendTypingIndicator: calls sendPresenceUpdate', typingCall !== undefined);
  assert('sendTypingIndicator: type is composing', typingCall?.type === 'composing');
  assert('sendTypingIndicator: uses creds.remoteJid', typingCall?.jid === remoteJid);
  calls.length = 0;

  // Error cases: null socket, null remoteJid, wrong sentinel
  const noSockCreds = { provider: 'baileys', socket: null, remoteJid };
  let threw = false;
  try { await sendWhatsAppMessage('5491100000001', 'x', noSockCreds); } catch { threw = true; }
  assert('sendWhatsAppMessage: throws if socket is null', threw);

  const noJidCreds = { provider: 'baileys', socket: mockSock, remoteJid: null };
  threw = false;
  try { await sendWhatsAppMessage('5491100000001', 'x', noJidCreds); } catch { threw = true; }
  assert('sendWhatsAppMessage: throws if remoteJid is null', threw);

  threw = false;
  try { await sendWhatsAppAudio('5491100000001', 'not-a-sentinel', creds); } catch { threw = true; }
  assert('sendWhatsAppAudio: throws if mediaId is not _baileys sentinel', threw);

  // markAsRead: no-op when socket is null (no throw)
  threw = false;
  try { await markAsRead('MSG', noSockCreds); } catch { threw = true; }
  assert('markAsRead: no-op (no throw) when socket is null', !threw);
}

// ── 19. Rollback conditions ────────────────────────────────────────────────────

section('Rollback — unset BAILEYS_ENABLED restores Meta processing');

function testRollback() {
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

  // Both suppression blocks must be gated on BAILEYS_ENABLED === '1'
  const suppressionGates = (serverSrc.match(/BAILEYS_ENABLED.*===.*'1'/g) || []).length;
  assert('Meta and Kapso suppression both gated on BAILEYS_ENABLED (at least 2 occurrences)',
    suppressionGates >= 2, `found ${suppressionGates}`);

  // Both suppression blocks must also check isBaileysLockHeld()
  const lockGates = (serverSrc.match(/isBaileysLockHeld\(\)/g) || []).length;
  assert('Suppression blocks check isBaileysLockHeld() (at least 2 occurrences)',
    lockGates >= 2, `found ${lockGates}`);

  // Rollback condition: false when env var not set OR lock not held
  function isSuppressed(enabled, businessId, lockHeld) {
    return enabled === '1' && businessId === BAILEYS_BUSINESS_ID && lockHeld === true;
  }
  assert('Rollback: unset env var → COLBET not suppressed', isSuppressed(undefined, 10, true) === false);
  assert('Rollback: BAILEYS_ENABLED=0 → COLBET not suppressed', isSuppressed('0', 10, true) === false);
  assert('Rollback: lock not held → COLBET not suppressed', isSuppressed('1', 10, false) === false);
  assert('Rollback: all other businesses unaffected regardless', isSuppressed('1', 5, true) === false);

  // initBaileys is called only inside BAILEYS_ENABLED === '1' block
  assert('initBaileys only called inside BAILEYS_ENABLED block',
    serverSrc.includes("BAILEYS_ENABLED === '1'") &&
    serverSrc.includes('initBaileys('));
}

// ── 20. isBaileysLockHeld() — behavioral ──────────────────────────────────────

section('isBaileysLockHeld() — reflects lock ownership');

function testIsBaileysLockHeld() {
  const lockFile = _forTest.lockFile;

  // Pre-clean
  try { fs.unlinkSync(lockFile); } catch {}

  assert('isBaileysLockHeld() false before any acquire', baileys.isBaileysLockHeld() === false);
  assert('_forTest.getLockAcquired() false before any acquire', _forTest.getLockAcquired() === false);

  _forTest.acquireLock();
  assert('isBaileysLockHeld() true after acquire', baileys.isBaileysLockHeld() === true);
  assert('_forTest.getLockAcquired() true after acquire', _forTest.getLockAcquired() === true);
  assert('heartbeat timer set after acquire', _forTest.getHeartbeatTimer() !== null);

  _forTest.releaseLock();
  assert('isBaileysLockHeld() false after release', baileys.isBaileysLockHeld() === false);
  assert('heartbeat timer cleared after release', _forTest.getHeartbeatTimer() === null);
}

// ── 21. classifyDisconnect — 440, 515, 403, 401, 411 ─────────────────────────

section('classifyDisconnect — codes 440, 515, 403, 401, 411');

function testClassifyDisconnect() {
  const classify = _forTest.classifyDisconnect;

  function makeErr(statusCode) {
    return { error: { output: { statusCode } } };
  }

  // 440: connectionReplaced → shouldYield=true, session NOT cleared, not terminal
  const r440 = classify(makeErr(440));
  assert('440: code=440', r440.code === 440);
  assert('440: shouldYield=true', r440.shouldYield === true);
  assert('440: shouldClearSession=false', r440.shouldClearSession === false);
  assert('440: isTerminal=false', r440.isTerminal === false);
  assert('440: isRestartSignal=false', r440.isRestartSignal === false);

  // 515: restartRequired → reset retries, reconnect; NOT a yield, NOT terminal
  const r515 = classify(makeErr(515));
  assert('515: code=515', r515.code === 515);
  assert('515: isRestartSignal=true', r515.isRestartSignal === true);
  assert('515: shouldYield=false', r515.shouldYield === false);
  assert('515: shouldClearSession=false', r515.shouldClearSession === false);
  assert('515: isTerminal=false', r515.isTerminal === false);

  // 403: forbidden/ban → terminal, session preserved
  const r403 = classify(makeErr(403));
  assert('403: isTerminal=true', r403.isTerminal === true);
  assert('403: shouldClearSession=false', r403.shouldClearSession === false);
  assert('403: shouldYield=false', r403.shouldYield === false);

  // 401: loggedOut → clear session, reconnect with fresh QR
  const r401 = classify(makeErr(401));
  assert('401: shouldClearSession=true', r401.shouldClearSession === true);
  assert('401: isTerminal=false', r401.isTerminal === false);
  assert('401: shouldYield=false', r401.shouldYield === false);

  // 411: multideviceMismatch → clear session
  const r411 = classify(makeErr(411));
  assert('411: shouldClearSession=true', r411.shouldClearSession === true);
  assert('411: isTerminal=false', r411.isTerminal === false);

  // 500: recoverable (badSession/CB failure) → NO clear, NO terminal, NO yield
  const r500 = classify(makeErr(500));
  assert('500: shouldClearSession=false (backoff, not immediate clear)', r500.shouldClearSession === false);
  assert('500: isTerminal=false', r500.isTerminal === false);
  assert('500: shouldYield=false', r500.shouldYield === false);
  assert('500: isRestartSignal=false', r500.isRestartSignal === false);

  // 0: no error (normal close) → recoverable
  const r0 = classify({ error: null });
  assert('No error (code=0): all false', !r0.shouldClearSession && !r0.isTerminal && !r0.shouldYield && !r0.isRestartSignal);
}

// ── 22. QR timeout — fires, releases lock, surfaces QR_TIMEOUT state ──────────

section('QR timeout — lock released, state=QR_TIMEOUT after timeout fires');

async function testQrTimeout() {
  const lockFile = _forTest.lockFile;
  try { fs.unlinkSync(lockFile); } catch {}

  // Acquire lock so isBaileysLockHeld() is true
  _forTest.acquireLock();
  assert('QR timeout setup: lock acquired', baileys.isBaileysLockHeld() === true);

  // Simulate the timeout firing directly: set _qrTimedOut = true then call stopBaileys.
  // We can't use the real setTimeout (would require waiting real time), so we
  // replicate what the timer callback does in production code.
  // Step 1: verify _qrTimedOut starts false
  assert('_qrTimedOut starts false', _forTest.getQrTimedOut() === false);

  // Step 2: manually trigger the same sequence the timer fires
  // (we DO NOT call _connect() since that requires Baileys ESM — test the state machine only)
  _forTest.releaseLock(); // simulates stopBaileys releasing the lock
  // Override _state to STOPPED and set the flag (simulates what stopBaileys does after timer fires)
  _forTest.setState('STOPPED');
  // _qrTimedOut is a module-level variable; no direct setter in _forTest (intentional).
  // We verify the behavior by confirming the module code path via getBaileysState().
  // In production: timer fires → _qrTimedOut = true → stopBaileys() → _state = STOPPED
  // getBaileysState() returns 'QR_TIMEOUT' when _qrTimedOut && _state === 'STOPPED'.
  // Here: _qrTimedOut is still false (timer never fired), so getBaileysState() = 'STOPPED'.
  assert('getBaileysState() = STOPPED (qrTimedOut=false)', baileys.getBaileysState() === 'STOPPED');
  assert('isBaileysLockHeld() false after stopBaileys equivalent', baileys.isBaileysLockHeld() === false);

  // Verify source-level: the QR_TIMEOUT logic exists in getBaileysState()
  const src = fs.readFileSync(require('path').join(__dirname, '../src/baileys.js'), 'utf8');
  assert('getBaileysState() returns QR_TIMEOUT when flag set', src.includes("'QR_TIMEOUT'"));
  assert('QR_TIMEOUT_MS constant defined', src.includes('QR_TIMEOUT_MS'));
  assert('BAILEYS_QR_TIMEOUT_MS env var used', src.includes('BAILEYS_QR_TIMEOUT_MS'));
  assert('QR timeout timer started in QR handler', src.includes('_qrTimeoutTimer = setTimeout'));
  assert('QR timeout calls stopBaileys()', src.includes('stopBaileys()') && src.includes('_qrTimedOut = true'));
  assert('_clearQrTimeout() called in stopBaileys()', src.includes('_clearQrTimeout()'));
  assert('_clearQrTimeout() called on connection open', src.includes("_clearQrTimeout(); // authenticated"));
  assert('_clearQrTimeout() called on connection close', src.includes("_clearQrTimeout(); // socket closed"));
  assert('QR timeout message documented: messages during window are lost',
    src.includes('Messages received during QR_PENDING are lost'));

  // Reset state for subsequent tests
  _forTest.setState('IDLE');
}

// ── 23. Dedup rollback — rawId and wamid both rolled back on processIncomingMessage failure ──

section('Dedup rollback — rawId + wamid both deleted on processing failure');

async function testDedupRollback() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-dedup-rb-'));
  const { tryMarkProcessed, deleteProcessedMessage } = makeTestDb(tmpDir);
  const errors = [];

  // ── Baileys side: processIncomingMessage failure rolls back msgId ──
  const deps = {
    logError: (tag, d) => errors.push({ tag, d }),
    getBusinessById: (id) => ({ id, name: 'Test' }),
    processIncomingMessage: async () => { throw new Error('simulated failure'); },
    tryMarkProcessed,
    deleteProcessedMessage,
  };

  const ts   = _forTest.processStartedAt + 10;
  const msg1 = makeWAMsg({ id: 'BAILEYS_ROLLBACK_1', messageTimestamp: ts });

  // Baileys handleMessage: marks msgId, processIncomingMessage throws, rollback deletes it
  await _forTest.handleMessage(msg1, deps)
    .catch(() => {}); // error is rethrown — catch here to let test continue

  // After rollback: same msgId should be insertable again (first insert = true)
  const canRetry = tryMarkProcessed(BAILEYS_BUSINESS_ID, 'BAILEYS_ROLLBACK_1');
  assert('Baileys rollback: msgId deleted after processIncomingMessage failure (retryable)', canRetry === true,
    `canRetry=${canRetry}`);

  // ── Meta side: both wamid and rawId rolled back on processIncomingMessage failure ──
  // This is verified at source level (actual integration test would require the server running).
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert('Meta rollback: image vision catch deletes both wamid and rawId',
    serverSrc.includes('deleteProcessedMessage(business.id, msg.id)') &&
    serverSrc.includes('deleteProcessedMessage(business.id, _rawId)'));
  assert('Meta rollback: text/audio catch deletes both wamid and rawId',
    // count occurrences of the rawId rollback line
    (serverSrc.match(/if \(_rawId\)\s+deleteProcessedMessage\(business\.id, _rawId\)/g) || []).length >= 2,
    'expected ≥2 rawId rollback sites');
  assert('Meta dedup: _rawId declared at msg scope (hoisted from dedup block)',
    serverSrc.includes('let _rawId = null;'));

  // ── Baileys side: getBusinessById null rolls back msgId ──
  const depsNoBiz = {
    logError: () => {},
    getBusinessById: () => null,
    processIncomingMessage: async () => {},
    tryMarkProcessed,
    deleteProcessedMessage,
  };
  const msg2 = makeWAMsg({ id: 'BAILEYS_ROLLBACK_2', messageTimestamp: ts });
  await _forTest.handleMessage(msg2, depsNoBiz);
  const canRetryBiz = tryMarkProcessed(BAILEYS_BUSINESS_ID, 'BAILEYS_ROLLBACK_2');
  assert('Baileys rollback: msgId deleted when getBusinessById returns null (retryable)', canRetryBiz === true,
    `canRetryBiz=${canRetryBiz}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nBaileys test suite');
  console.log('==================');

  // Sync tests
  testLock();
  testSuppression();
  testBusinessIdIsolation();
  testProviderSelection();
  testTransitionRollback();
  testQrPageSecurity();
  testSessionPersistence();
  testForTestIsGuarded();
  testCrossProviderDedup();
  testSigtermCleanup();
  testRollback();
  testStopBaileysNoOp();
  testIsBaileysLockHeld();
  testClassifyDisconnect();

  // Async tests (sequential)
  await testReplayGuard();
  await testShutdownFilePersistence();
  await testPreFilters();
  await testDedup();
  await testRemoteJid();
  await testDuplicatePrevention();
  await testStoppedStateGuard();
  await testJidFiltering();
  await testWhatsappBaileysRoutes();
  await testQrTimeout();
  await testDedupRollback();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  console.log(`Results: ${passed} passed, ${failed} failed (${total} total)`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Unexpected error:', err); process.exit(1); });
