'use strict';

/**
 * Test suite: POST /admin/api/test-mails
 *
 * Suite A — HTTP: 401, 503 missing RESEND_API_KEY (no env vars set)
 * Suite B — HTTP: 503 missing ADMIN_EMAIL (only RESEND_API_KEY set)
 * Suite C — HTTP: rate limit 429, 200 with 9 results (both env vars set)
 * Suite D — Direct email function tests with mocked fetch:
 *             each template renders without errors,
 *             only sends to adminEmail,
 *             [PRUEBA] prefix in subject
 * Suite E — DB: audit log recorded after successful call
 */

const path    = require('path');
const http    = require('http');
const fs      = require('fs');
const { execSync, spawn } = require('child_process');

const BEARER  = 'test-bearer-mail';
const DB_A    = '/tmp/test-mailtest-a';
const DB_B    = '/tmp/test-mailtest-b';
const DB_C    = '/tmp/test-mailtest-c';
const PORT_A  = 3109;
const PORT_B  = 3110;
const PORT_C  = 3111;

let passed = 0;
let failed = 0;
const failLabels = [];

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.log(`  ✗ ${label}`); failed++; failLabels.push(label); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? JSON.stringify(opts.body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    const r = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch { json = data; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function spawnServer(port, dbDir, extraEnv = {}) {
  try { execSync(`rm -rf ${dbDir}`); } catch {}
  fs.mkdirSync(dbDir, { recursive: true });
  const proc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT:              String(port),
      DB_DIR:            dbDir,
      SESSION_SECRET:    'test-mail-secret',
      ADMIN_SET_WA_TOKEN: BEARER,
      ANTHROPIC_API_KEY: '',
      RESEND_API_KEY:    '',
      ADMIN_EMAIL:       '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

async function waitForServer(port) {
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise(resolve => {
      const r = http.request(
        { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
        res => resolve(res.statusCode === 200)
      );
      r.on('error', () => resolve(false));
      r.end();
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`Server on ${port} did not start in 20s`);
}

function killServer(proc) {
  try { proc.kill(); } catch {}
  return sleep(300);
}

// ─── Suite A — 401 and 503 missing RESEND_API_KEY ────────────────────────────

async function suiteA() {
  console.log('\nSuite A — 401 y 503 sin RESEND_API_KEY');
  const srv = spawnServer(PORT_A, DB_A);
  try {
    await waitForServer(PORT_A);

    // A1: no bearer → 401/403
    const r1 = await req(PORT_A, '/admin/api/test-mails');
    assert(r1.status === 401 || r1.status === 403, 'A1: sin token → 401/403');

    // A2: wrong bearer → 401/403
    const r2 = await req(PORT_A, '/admin/api/test-mails', { bearer: 'wrong-token' });
    assert(r2.status === 401 || r2.status === 403, 'A2: token erróneo → 401/403');

    // A3: correct bearer, no RESEND_API_KEY → 503 naming RESEND_API_KEY
    const r3 = await req(PORT_A, '/admin/api/test-mails', { bearer: BEARER });
    assert(r3.status === 503, `A3: sin RESEND_API_KEY → 503 (got ${r3.status})`);
    assert(typeof r3.body?.error === 'string' && r3.body.error.includes('RESEND_API_KEY'), 'A3: error menciona RESEND_API_KEY');
  } finally {
    await killServer(srv);
    try { execSync(`rm -rf ${DB_A}`); } catch {}
  }
}

// ─── Suite B — 503 missing ADMIN_EMAIL ───────────────────────────────────────

async function suiteB() {
  console.log('\nSuite B — 503 sin ADMIN_EMAIL');
  const srv = spawnServer(PORT_B, DB_B, { RESEND_API_KEY: 'fake-key' });
  try {
    await waitForServer(PORT_B);

    const r = await req(PORT_B, '/admin/api/test-mails', { bearer: BEARER });
    assert(r.status === 503, `B1: sin ADMIN_EMAIL → 503 (got ${r.status})`);
    assert(typeof r.body?.error === 'string' && r.body.error.includes('ADMIN_EMAIL'), 'B1: error menciona ADMIN_EMAIL');
  } finally {
    await killServer(srv);
    try { execSync(`rm -rf ${DB_B}`); } catch {}
  }
}

// ─── Suite C — 200 with results + rate limit 429 ─────────────────────────────

async function suiteC() {
  console.log('\nSuite C — 200 con resultados y rate limit 429');
  const srv = spawnServer(PORT_C, DB_C, {
    RESEND_API_KEY: 'fake-key-c',
    ADMIN_EMAIL:    'admin@testmailprueba.example',
  });
  try {
    await waitForServer(PORT_C);

    // C1: first call → 200, 9 keys in body (Resend will fail per template, but endpoint returns 200)
    const r1 = await req(PORT_C, '/admin/api/test-mails', { bearer: BEARER });
    assert(r1.status === 200, `C1: primera llamada → 200 (got ${r1.status})`);
    const keys = Object.keys(r1.body || {});
    assert(keys.length === 9, `C1: resultado tiene 9 claves (got ${keys.length})`);
    const expected = ['hourly_cap','api_error','wa_error','sale_intent','turno_nuevo','pausa','urgente','claude_sin_creditos','claude_5xx'];
    assert(expected.every(k => keys.includes(k)), 'C1: todas las claves esperadas presentes');
    assert(Object.values(r1.body || {}).every(v => typeof v === 'string'), 'C1: cada valor es string');

    // C2: second call within 10 min → 429
    const r2 = await req(PORT_C, '/admin/api/test-mails', { bearer: BEARER });
    assert(r2.status === 429, `C2: segunda llamada en < 10 min → 429 (got ${r2.status})`);
    assert(typeof r2.body?.error === 'string', 'C2: body tiene error string');
  } finally {
    // Don't delete DB_C — Suite E reads it
    await killServer(srv);
  }
}

// ─── Suite D — direct function tests, mocked fetch ───────────────────────────

async function suiteD() {
  console.log('\nSuite D — plantillas directas con fetch mockeado');

  // Clear require cache for email module so we get a fresh load
  Object.keys(require.cache).forEach(k => {
    if (k.includes('/src/email')) delete require.cache[k];
  });

  process.env.RESEND_API_KEY = 'fake-key-d';
  process.env.ADMIN_EMAIL    = 'admin@testmailprueba.example';

  const calls = [];
  global.fetch = async (_url, opts) => {
    const bodyObj = opts?.body ? JSON.parse(opts.body) : {};
    const to = Array.isArray(bodyObj.to)
      ? bodyObj.to
      : typeof bodyObj.to === 'string' ? [bodyObj.to] : [];
    calls.push({ to, subject: bodyObj.subject || '' });
    return { ok: true, text: async () => '' };
  };

  try {
    const {
      sendOwnerBotStoppedEmail, sendUrgentAlertEmail, sendSaleIntentEmail,
      sendBookingNotificationEmail, sendPauseEmail, sendClaudeErrorAdminEmail,
    } = require('../src/email');

    const admin   = 'admin@testmailprueba.example';
    const PREFIX  = '[PRUEBA] ';
    const biz     = 'Negocio de Prueba';
    const client  = 'Cliente Prueba';
    const phone   = '+59899000000';
    const convUrl = 'https://daxos.lat/conversations.html?conv=999';

    const templates = [
      { name: 'hourly_cap',          fn: () => sendOwnerBotStoppedEmail({ to: admin, businessName: biz, clientName: client, convUrl, kind: 'hourly_cap', subjectPrefix: PREFIX }) },
      { name: 'api_error',           fn: () => sendOwnerBotStoppedEmail({ to: admin, businessName: biz, clientName: client, convUrl, kind: 'api_error',  subjectPrefix: PREFIX }) },
      { name: 'wa_error',            fn: () => sendOwnerBotStoppedEmail({ to: admin, businessName: biz, clientName: client, convUrl, kind: 'wa_error',   subjectPrefix: PREFIX }) },
      { name: 'sale_intent',         fn: () => sendSaleIntentEmail({ to: admin, businessName: biz, clientName: client, clientPhone: phone, lastMessages: [{ role: 'user', content: 'quiero comprar' }], convUrl, subjectPrefix: PREFIX }) },
      { name: 'turno_nuevo',         fn: () => sendBookingNotificationEmail({ to: admin, businessName: biz, clientName: client, reason: 'Consulta', slots: ['Lunes 10:00'], slotCode: 'AB', businessPhone: phone, panelUrl: convUrl, subjectPrefix: PREFIX }) },
      { name: 'pausa',               fn: () => sendPauseEmail({ to: admin, businessName: biz, contactId: phone, messageText: 'necesito ayuda', conversationId: 1, convUrl, subject: `${PREFIX}Nueva conversación pausada — ${biz}` }) },
      { name: 'urgente',             fn: () => sendUrgentAlertEmail({ to: admin, businessName: biz, contactId: phone, messageText: 'emergencia', conversationId: 1, convUrl, now: new Date(), subjectPrefix: PREFIX }) },
      { name: 'claude_sin_creditos', fn: () => sendClaudeErrorAdminEmail({ errorType: 'no_credits',   businessId: 0, businessName: biz, errorMessage: 'Insufficient credits', subjectPrefix: PREFIX }) },
      { name: 'claude_5xx',          fn: () => sendClaudeErrorAdminEmail({ errorType: 'server_error', businessId: 0, businessName: biz, errorMessage: 'Error 500', subjectPrefix: PREFIX }) },
    ];

    for (const { name, fn } of templates) {
      try { await fn(); }
      catch (err) { assert(false, `D: ${name} no debe lanzar (got: ${err.message})`); }
    }

    assert(calls.length === 9, `D: 9 llamadas a Resend (got ${calls.length})`);

    const wrongTo = calls.filter(c => !(c.to.length === 1 && c.to[0] === admin));
    assert(wrongTo.length === 0, `D: todas las llamadas van solo a adminEmail (mal: ${wrongTo.map(c => c.to.join(',')).join('; ')})`);

    const withoutPrefix = calls.filter(c => !c.subject.startsWith(PREFIX));
    assert(withoutPrefix.length === 0, `D: todos los subjects tienen prefijo [PRUEBA] (sin prefijo: ${withoutPrefix.map(c => c.subject).join('; ')})`);
  } finally {
    global.fetch = undefined;
    delete process.env.RESEND_API_KEY;
    delete process.env.ADMIN_EMAIL;
    Object.keys(require.cache).forEach(k => {
      if (k.includes('/src/email')) delete require.cache[k];
    });
  }
}

// ─── Suite E — DB audit log ───────────────────────────────────────────────────

async function suiteE() {
  console.log('\nSuite E — audit log en DB');
  const Database = require('better-sqlite3');
  const dbPath   = path.join(DB_C, 'daxos.db');
  if (!fs.existsSync(dbPath)) {
    assert(false, 'E0: DB de Suite C no existe — omitiendo Suite E');
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT called_at, result FROM mail_test_log ORDER BY id DESC LIMIT 1').get();
    assert(!!row, 'E1: mail_test_log tiene al menos un registro después de Suite C');
    assert(typeof row?.called_at === 'number' && row.called_at > 0, 'E2: called_at es timestamp válido');
    let parsed;
    try { parsed = JSON.parse(row?.result || 'null'); } catch { parsed = null; }
    assert(parsed !== null && typeof parsed === 'object', 'E3: result es JSON objeto');
    const keys = Object.keys(parsed || {});
    assert(keys.length === 9, `E4: resultado tiene 9 claves (got ${keys.length})`);
  } finally {
    db.close();
    try { execSync(`rm -rf ${DB_C}`); } catch {}
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== test-mail-prueba ===');
  try {
    await suiteA();
    await suiteB();
    await suiteC();
    await suiteD();
    await suiteE();
  } catch (err) {
    console.error('Error inesperado:', err.stack || err.message);
    failed++;
  }

  const total = passed + failed;
  console.log(`\n${total} tests — ${passed} passed, ${failed} failed`);
  if (failLabels.length) {
    console.log('Failures:');
    failLabels.forEach(e => console.log(`  ✗ ${e}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

run();
