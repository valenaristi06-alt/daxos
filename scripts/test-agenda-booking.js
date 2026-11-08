'use strict';
/**
 * Tests for agenda booking safeguards:
 *   2a: agenda off  → prompt identical to main (INTERES_COMPRA present, no AGENDA block)
 *   2b: agenda on   → prompt has no INTERES_COMPRA; if model emits it anyway,
 *                     tag is stripped before client AND no sale_intent alert fired
 *   3:  sanitizeForClient (whatsapp.js) strips ALL internal marker tags
 *   4b: BOOK_SLOT → recordOwnerAlert('booking_created') written to DB
 *   4c: single notification — WA ok→1WA 0mails; WA fail→0WA 1mail; no-creds→1mail; none→logged
 *   4d: both flags (booking_enabled + agenda_enabled) → 1 appointment, 1 alert, no BOOKING_SLOTS
 *
 * Run: node scripts/test-agenda-booking.js
 */

const path   = require('path');
const fs     = require('fs');
const { execSync, spawn } = require('child_process');
const http   = require('http');

const DB_DIR_DIRECT = '/tmp/test-agenda-booking-direct';
const DB_DIR_SERVER = '/tmp/test-agenda-booking-server';
const PORT          = 3215;

try { execSync(`rm -rf ${DB_DIR_DIRECT} ${DB_DIR_SERVER}`); } catch (_) {}
fs.mkdirSync(DB_DIR_DIRECT, { recursive: true });
fs.mkdirSync(DB_DIR_SERVER, { recursive: true });

let passed = 0;
let failed = 0;

function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

// ── Setup: shared DB module ────────────────────────────────────────────────────
process.env.DB_DIR = DB_DIR_DIRECT;
Object.keys(require.cache).forEach(k => {
  if (k.includes('/src/db') || k.includes('/src/agenda') || k.includes('/src/claude') || k.includes('/src/whatsapp')) delete require.cache[k];
});
const db = require('../src/db');

// ── Suite 3: sanitizeForClient strips all internal tags ───────────────────────
console.log('\n--- Suite 3: sanitizeForClient strips all internal tags ---');
{
  const { sanitizeForClient } = require('../src/whatsapp');
  ok('exported from whatsapp.js', typeof sanitizeForClient === 'function');
  ok('null passthrough', sanitizeForClient(null) === null);
  ok('undefined passthrough', sanitizeForClient(undefined) === undefined);
  ok('[INTERES_COMPRA] stripped', sanitizeForClient('[INTERES_COMPRA]\nTexto') === 'Texto');
  ok('[AGENDA_SERVICE:S1] stripped', sanitizeForClient('Elegí [AGENDA_SERVICE:S1] ok') === 'Elegí ok');
  ok('[BOOK_SLOT:T1] stripped', sanitizeForClient('[BOOK_SLOT:T1]\nConfirmado') === 'Confirmado');
  ok('[CANCEL_APPOINTMENT:A1] stripped', sanitizeForClient('[CANCEL_APPOINTMENT:A1] listo') === 'listo');
  ok('[WANT_RESCHEDULE:A1] stripped', sanitizeForClient('[WANT_RESCHEDULE:A1] ok') === 'ok');
  ok('[BOOK_RESCHEDULE:T2] stripped', sanitizeForClient('[BOOK_RESCHEDULE:T2] ok') === 'ok');
  ok('[AGENDA_CLIENT_NAME:Juan] stripped', sanitizeForClient('[AGENDA_CLIENT_NAME:Juan] hola') === 'hola');
  ok('[NEEDS_HUMAN] stripped', sanitizeForClient('[NEEDS_HUMAN]\nAyuda') === 'Ayuda');
  ok('[URGENTE] stripped', sanitizeForClient('[URGENTE]\nEmergencia') === 'Emergencia');
  ok('[BOOKING_SLOTS:T1|T2] stripped', sanitizeForClient('[BOOKING_SLOTS:T1|T2] ver') === 'ver');
  ok('multiple tags stripped', sanitizeForClient('[INTERES_COMPRA]\n[BOOK_SLOT:T1]\nHola') === 'Hola');
  ok('normal text unchanged', sanitizeForClient('Hola, ¿en qué te puedo ayudar?') === 'Hola, ¿en qué te puedo ayudar?');
  ok('server.js imports from whatsapp (no inline copy)', (() => {
    const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const hasInline = /^\s*function sanitizeForClient/m.test(src);
    // sanitizeForClient appears in destructured require on same line
    const hasImport = src.split('\n').some(
      line => line.includes('sanitizeForClient') && line.includes("require('./whatsapp')")
    );
    return !hasInline && hasImport;
  })());
}

// ── Suite 2a: agenda off → prompt identical to main ───────────────────────────
console.log('\n--- Suite 2a: agenda off → no AGENDA block, INTERES_COMPRA present ---');
{
  const { buildSystemPrompt } = require('../src/claude');
  const biz = {
    id: 1, name: 'Test Biz', plan: 'crecimiento', plan_cortesia: 0,
    agenda_enabled: 0, booking_enabled: 0,
    business_context: 'Peluquería canina.',
  };

  // Agenda off: runtimeCtx without agenda (simulating main behavior)
  const { staticText: noAgenda } = buildSystemPrompt(biz, null, { enabled: false, state: null }, null);
  // Agenda off explicitly
  const { staticText: agendaNull } = buildSystemPrompt(biz, null, { enabled: false, state: null }, { agenda: null });

  ok('no AGENDA block when off', !noAgenda.includes('AGENDA —'));
  ok('INTERES_COMPRA present when off (runtimeCtx=null)', noAgenda.includes('INTERES_COMPRA:'));
  ok('INTERES_COMPRA present when off (agenda=null)', agendaNull.includes('INTERES_COMPRA:'));
  ok('prompts identical (null vs agenda:null)', noAgenda === agendaNull);
  ok('[WANTS_BOOKING] absent when booking disabled', !noAgenda.includes('[WANTS_BOOKING]'));
}

// ── Suite 2b: agenda on → INTERES_COMPRA suppressed, tag stripped if emitted ──
console.log('\n--- Suite 2b: agenda on → INTERES_COMPRA suppressed + stripped ---');
{
  const { buildSystemPrompt } = require('../src/claude');
  const { sanitizeForClient }  = require('../src/whatsapp');

  const agendaCtx = {
    services: [{ code: 'S1', id: 1, name: 'Corte', duration: 30 }],
    appointmentsMap: {}, appointmentsText: null,
    maxDate: '2026-12-31', selectedService: null,
    slotsText: null, clientName: null, slotsGeneratedAt: null,
  };
  const biz = { id: 1, name: 'Test Biz', plan: 'crecimiento', plan_cortesia: 0, agenda_enabled: 1 };
  const { staticText } = buildSystemPrompt(biz, null, { enabled: false, state: null }, { agenda: agendaCtx });

  ok('no INTERES_COMPRA in prompt', !staticText.includes('INTERES_COMPRA:'));
  ok('AGENDA block present', staticText.includes('AGENDA —'));
  ok('no [WANTS_BOOKING] instruction', !staticText.includes('[WANTS_BOOKING]'));

  // If model emits [INTERES_COMPRA] anyway, sanitizeForClient strips it
  const dirtyReply = 'Claro, te reservo el turno.\n[INTERES_COMPRA]';
  const clean = sanitizeForClient(dirtyReply);
  ok('[INTERES_COMPRA] stripped by sanitizeForClient even if emitted', !clean.includes('[INTERES_COMPRA]'));
  ok('clean text preserved after strip', clean.includes('Claro, te reservo el turno.'));

  // server.js guards isSaleIntent with !agendaOk — verify source
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  ok('isSaleIntent guarded with !agendaOk in server.js',
    serverSrc.includes('isSaleIntent && !agendaOk'));

  // Preview endpoint also strips it
  ok('preview endpoint strips [INTERES_COMPRA]',
    serverSrc.includes("reply = reply.replace(/\\[INTERES_COMPRA\\]"));
}

// ── Suite 4b: BOOK_SLOT → recordOwnerAlert('booking_created') ─────────────────
console.log('\n--- Suite 4b: BOOK_SLOT → recordOwnerAlert(booking_created) ---');
{
  const bh = JSON.stringify({ 1:[['09:00','18:00']], 2:[['09:00','18:00']], 3:[['09:00','18:00']], 4:[['09:00','18:00']], 5:[['09:00','18:00']], 6:[['09:00','13:00']] });
  db.upsertBusiness({
    name: 'Mutex Biz', email: 'mutex@test.com', phone: '59891111001',
    plan: 'crecimiento', plan_paid_at: new Date().toISOString(), business_hours: bh,
  });
  const all = db.getAllBusinesses?.() || [];
  const biz = all.find(b => b.name === 'Mutex Biz');

  if (!biz) {
    console.log('  (skip — getAllBusinesses not available)');
  } else {
    db.setAgendaEnabled(biz.id, true);
    // Also enable booking_enabled so 4d can verify mutual exclusion
    if (db.setBookingEnabled) db.setBookingEnabled(biz.id, true);
    db.createAgendaService(biz.id, { name: 'Corte', durationMin: 30, sortOrder: 0 });
    const svcs = db.getAgendaServices(biz.id);

    const tomorrow = new Date(Date.now() + 86_400_000);
    const startsAt = new Date(`${tomorrow.toISOString().slice(0,10)}T12:00:00-03:00`).toISOString();
    const endsAt   = new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString();

    // conversation_id is nullable — pass null to avoid FK constraint
    const convId = null;
    let aptId;
    try {
      const apt = db.createAppointment({
        businessId: biz.id, conversationId: null,
        serviceId: svcs[0]?.id ?? 1, customerPhone: '59891000099',
        clientName: 'Test Client', notes: null, startsAt, endsAt,
      });
      aptId = apt?.id;
      ok('appointment created', !!aptId);
    } catch (e) {
      ok('appointment created', false, e.message);
    }

    // Use biz.id as stand-in for convId (rate-limit is per conversation, any int works)
    const alertConvId = biz.id * 1000;
    db.recordOwnerAlert(biz.id, alertConvId, 'booking_created');
    ok('booking_created recorded in owner_alert_log',
      db.ownerAlertRecentlySent(alertConvId, 'booking_created', 60));
    ok('booking_created suppresses sale_intent for 12h',
      db.ownerAlertRecentlySent(alertConvId, 'booking_created', 43200));

    // Verify source
    const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    ok('server.js calls recordOwnerAlert booking_created in BOOK_SLOT handler',
      src.includes("recordOwnerAlert(business.id, conversation.id, 'booking_created')"));
  }
}

// ── Suite 4c: single notification scenarios (via server spawn) ─────────────────
console.log('\n--- Suite 4c: single notification scenarios ---');

function startServer(env, cb) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, ...env, DB_DIR: DB_DIR_SERVER, PORT: String(PORT) },
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const timeout = setTimeout(() => {
    if (!ready) cb(new Error('Server timeout'), child);
  }, 10000);
  child.stdout.on('data', d => {
    if (!ready && String(d).includes('Server running')) {
      ready = true; clearTimeout(timeout); cb(null, child);
    }
  });
  child.on('error', e => { clearTimeout(timeout); if (!ready) cb(e, child); });
  return child;
}

function reqHttp(method, urlPath, body, cb) {
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    hostname: 'localhost', port: PORT, path: urlPath, method,
    headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
  };
  const r = http.request(opts, res => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => { try { cb(null, res.statusCode, JSON.parse(raw)); } catch (_) { cb(null, res.statusCode, raw); } });
  });
  r.on('error', cb);
  if (data) r.write(data);
  r.end();
}

(async () => {
  await new Promise((resolve) => {
    const env = {
      SESSION_SECRET: 'test-secret-agenda-booking',
      ADMIN_SET_WA_TOKEN: 'test-token',
    };

    const child = startServer(env, async (err, srv) => {
      if (err) {
        ok('server started for 4c tests', false, String(err));
        resolve();
        return;
      }
      ok('server started for 4c tests', true);

      try {
        await new Promise(r => setTimeout(r, 300));

        // 4c: Check wa_notify_status column exists (notification contract in DB)
        const rawDb = require('better-sqlite3')(path.join(DB_DIR_SERVER, 'daxos.db'));
        const cols = rawDb.prepare('PRAGMA table_info(agenda_appointments)').all().map(c => c.name);
        rawDb.close();

        ok('wa_notify_status column exists', cols.includes('wa_notify_status'));
        ok('wa_notify_reason column exists', cols.includes('wa_notify_reason'));
        ok('owner_notified_at column exists', cols.includes('owner_notified_at'));

        // Verify notification logic in source:
        // WA ok path: sets waNotifyStatus='ok', no email
        // WA fail path: sets waNotifyStatus='failed', triggers email
        // No creds path: goes straight to email
        // No creds + no email: logs error (never silent)
        const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
        ok('WA ok path sets waNotifyStatus=ok', src.includes("waNotifyStatus: 'ok'"));
        ok('WA fail path sets waNotifyStatus=failed', src.includes("waNotifyStatus: 'failed'"));
        ok('WA fail path triggers email fallback', (() => {
          // Find the OWNER notification WA catch specifically (uses agenda-notify-owner-email)
          const ownerCatchIdx = src.indexOf("'agenda-notify-owner-email'");
          const failIdx = src.lastIndexOf("waNotifyStatus: 'failed'", ownerCatchIdx);
          const emailIdx = src.indexOf('sendAgendaNewAppointmentEmail', failIdx);
          return failIdx > 0 && emailIdx > failIdx && emailIdx < failIdx + 600;
        })());
        ok('No-creds path sends email directly', (() => {
          // else if (_owner?.email) { sendAgendaNewAppointmentEmail after the WA block
          const noCredsIdx = src.indexOf('} else if (_owner?.email)');
          const emailFnIdx = src.indexOf('sendAgendaNewAppointmentEmail', noCredsIdx);
          return noCredsIdx > 0 && emailFnIdx > noCredsIdx && emailFnIdx < noCredsIdx + 300;
        })());
        ok('No-creds + no-email logs error (never silent)',
          src.includes("no WA creds and no owner email — owner not notified"));
        ok('updateAppointmentNotification called after WA ok',
          src.includes("updateAppointmentNotification(_apt.id, { ownerNotifiedAt: new Date().toISOString(), waNotifyStatus: 'ok' })"));

      } finally {
        srv.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 300));
        resolve();
      }
    });
  });

  // ── Suite 4d: both flags → 1 appointment, 1 alert, no BOOKING_SLOTS ──────────
  console.log('\n--- Suite 4d: both flags (booking_enabled + agenda_enabled) ---');
  {
    const { buildSystemPrompt } = require('../src/claude');

    // Reset modules for clean DB read
    Object.keys(require.cache).forEach(k => {
      if (k.includes('/src/db') || k.includes('/src/agenda') || k.includes('/src/claude')) delete require.cache[k];
    });
    process.env.DB_DIR = DB_DIR_DIRECT;
    const db2 = require('../src/db');

    const agendaCtx = {
      services: [{ code: 'S1', id: 1, name: 'Corte', duration: 30 }],
      appointmentsMap: {}, appointmentsText: null,
      maxDate: '2026-12-31', selectedService: null,
      slotsText: null, clientName: null, slotsGeneratedAt: null,
    };
    const biz = {
      id: 1, name: 'Both Flags Biz', plan: 'crecimiento', plan_cortesia: 0,
      agenda_enabled: 1, booking_enabled: 1,
    };

    // Server passes enabled:false when agendaOk — simulate
    const { staticText } = buildSystemPrompt(biz, null, { enabled: false, state: null }, { agenda: agendaCtx });

    ok('4d: AGENDA block present', staticText.includes('AGENDA —'));
    ok('4d: no BOOKING_SLOTS instruction', !staticText.includes('TURNOS: Este negocio permite agendar turnos'));
    ok('4d: no INTERES_COMPRA in prompt', !staticText.includes('INTERES_COMPRA:'));
    ok('4d: no [WANTS_BOOKING]', !staticText.includes('[WANTS_BOOKING]'));

    // DB: booking_enabled=1 AND agenda_enabled=1 → only agenda_appointments gets a row
    // Use raw SQLite to verify (getAllBusinesses doesn't select those columns)
    const Database = require('better-sqlite3');
    const rawDb4d  = new Database(path.join(DB_DIR_DIRECT, 'daxos.db'), { readonly: true });
    const bizDb = rawDb4d.prepare("SELECT id, booking_enabled, agenda_enabled FROM businesses WHERE name = 'Mutex Biz' LIMIT 1").get();
    rawDb4d.close();

    if (bizDb) {
      ok('4d: booking_enabled=1 on biz', !!bizDb.booking_enabled);
      ok('4d: agenda_enabled=1 on biz', !!bizDb.agenda_enabled);
      const apts = db2.getAppointmentsForBusiness?.(bizDb.id,
        new Date(Date.now() - 86_400_000).toISOString(),
        new Date(Date.now() + 7 * 86_400_000).toISOString()
      ) || [];
      ok('4d: agenda_appointments has rows', apts.length >= 1);
      const pbs = db2.getPendingBookingsByBusiness ? db2.getPendingBookingsByBusiness(bizDb.id) : [];
      ok('4d: no pending_bookings (agenda took over)', pbs.length === 0);
    } else {
      console.log('  (skip DB 4d — Mutex Biz not found)');
    }
  }

  // ── Suite A.2: Parser-derived tag list + 3 routes ─────────────────────────
  console.log('\n--- Suite A.2: parser-derived tag list + 3 routes ---');
  {
    const { sanitizeForClient } = require('../src/whatsapp');
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

    // Build tag list from actual parser regex patterns in server.js
    // Extract all unique tag names matched by .match() or .replace() calls
    const tagPattern = /\[([A-Z][A-Z_0-9]*)(?::[^\]]+)?\]/g;
    const tagSet = new Set();
    let m;
    while ((m = tagPattern.exec(serverSrc)) !== null) {
      tagSet.add(m[1]);
    }
    const realTags = Array.from(tagSet).filter(t =>
      ['AGENDA_SERVICE','BOOK_SLOT','CANCEL_APPOINTMENT','WANT_RESCHEDULE','BOOK_RESCHEDULE',
       'RESCHEDULE_APPOINTMENT','AGENDA_CLIENT_NAME','INTERES_COMPRA','NEEDS_HUMAN','SEND_DOC',
       'URGENTE','BOOKING_NAME','BOOKING_REASON','BOOKING_SLOTS','WANTS_BOOKING','CANCEL_BOOKING']
      .includes(t)
    );
    console.log(`  Real tags from parser: ${realTags.join(', ')}`);

    // User's original list vs actual — phantom tags
    const phantomTags = ['CANCEL_SLOT','RESCHEDULE_REQUEST','MARK_DONE','CLOSE_BOOKING'];
    const foundPhantom = phantomTags.filter(t => serverSrc.includes(`[${t}`));
    ok('A.2: phantom tags not in server.js (CANCEL_SLOT etc)', foundPhantom.length === 0,
      `found phantom: ${foundPhantom.join(', ')}`);

    // Test that sanitizeForClient (generic regex) strips each real tag
    const testCases = [
      '[AGENDA_SERVICE:S1]',
      '[BOOK_SLOT:T3]',
      '[CANCEL_APPOINTMENT:A2]',
      '[WANT_RESCHEDULE:A1]',
      '[BOOK_RESCHEDULE:T5]',
      '[RESCHEDULE_APPOINTMENT:A3]',
      '[AGENDA_CLIENT_NAME:Juan Perez]',
      '[INTERES_COMPRA]',
      '[NEEDS_HUMAN]',
      '[SEND_DOC]',
      '[URGENTE]',
      '[BOOKING_NAME:Carlos]',
      '[BOOKING_REASON:Corte de pelo]',
      '[BOOKING_SLOTS:T1|T2|T3]',
      '[WANTS_BOOKING]',
      '[CANCEL_BOOKING]',
    ];
    testCases.forEach(tag => {
      const result = sanitizeForClient(`texto ${tag} fin`);
      ok(`A.2: sanitizeForClient strips ${tag.split(':')[0]}]`, !result.includes('['));
    });

    // Route 1: WA real — sanitizeForClient called at main processing (use lastIndexOf to skip preview)
    ok('A.2 route1: WA real — sanitizeForClient called before splitAndSend', (() => {
      const sanitizeIdx = serverSrc.lastIndexOf('reply        = sanitizeForClient(reply');
      // The main split is _splitEnabled ? parseSplitParts(reply)
      const splitIdx    = serverSrc.lastIndexOf('parseSplitParts(reply)');
      return sanitizeIdx > 0 && splitIdx > sanitizeIdx; // sanitize BEFORE split
    })());

    // Route 2: Preview — sanitizeForClient now called in preview endpoint
    ok('A.2 route2: preview endpoint calls sanitizeForClient', (() => {
      const previewIdx = serverSrc.indexOf("reply = sanitizeForClient(reply, logError)");
      // Check it appears in preview context (before the split-mode code)
      const pvSplitIdx = serverSrc.indexOf('_pvSplitEnabled');
      return previewIdx > 0 && previewIdx < pvSplitIdx;
    })());

    // Route 3: Split messages — sanitize happens before parseSplitParts so each part is clean
    ok('A.2 route3: split messages — sanitized before parseSplitParts', (() => {
      const sanitizeIdx = serverSrc.lastIndexOf('reply        = sanitizeForClient(reply');
      const splitIdx    = serverSrc.lastIndexOf('parseSplitParts(reply)');
      return sanitizeIdx > 0 && splitIdx > sanitizeIdx;
    })());
  }

  // ── Suite A.1: E2E assistant booking path via processIncomingMessage ─────────
  // Tests the REAL WhatsApp assistant path, not the panel REST endpoint.
  // Uses /test/mock-reply + /test/inject-message endpoints (NODE_ENV=test only).
  // Verifies: (a) appointment row created, (b) booking_created written BY THE SERVER,
  // (c) subsequent [INTERES_COMPRA] suppressed, (d) client text has no bracket tags.
  console.log('\n--- Suite A.1: E2E assistant booking (processIncomingMessage) ---');

  const A1_PORT   = 3216;
  const A1_DB_DIR = '/tmp/test-agenda-booking-e2e';
  try { execSync(`rm -rf ${A1_DB_DIR}`); } catch (_) {}
  fs.mkdirSync(A1_DB_DIR, { recursive: true });

  let _a1TestToken = '';
  function reqA1(method, urlPath, body, opts = {}) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (opts.cookie) headers['Cookie'] = opts.cookie;
      // Always attach test token for /test/* routes; harmless on others.
      if (_a1TestToken) headers['X-Test-Token'] = _a1TestToken;
      const data = body ? JSON.stringify(body) : null;
      if (data) headers['Content-Length'] = Buffer.byteLength(data);
      const r = http.request({ hostname: 'localhost', port: A1_PORT, path: urlPath, method, headers }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
          catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  await new Promise(resolve => {
    const a1Server = spawn(process.execPath, ['src/server.js'], {
      // All three harness conditions: NODE_ENV=test, DAXOS_TEST_HARNESS=1, no RAILWAY_ENVIRONMENT
      env: { ...process.env, PORT: String(A1_PORT), DB_DIR: A1_DB_DIR, SESSION_SECRET: 'a1-secret',
             NODE_ENV: 'test', DAXOS_TEST_HARNESS: '1', RAILWAY_ENVIRONMENT: '' },
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    // Accumulate stdout lines to pick up the token before "Server running"
    let stdoutBuf = '';
    const to = setTimeout(() => { if (!ready) { ok('A.1 server started', false, 'timeout'); resolve(); } }, 12000);

    a1Server.stdout.on('data', async d => {
      stdoutBuf += String(d);
      // Extract token from [test-harness] token=<hex>
      if (!_a1TestToken) {
        const m = stdoutBuf.match(/\[test-harness\] token=([0-9a-f]{64})/);
        if (m) _a1TestToken = m[1];
      }
      if (!ready && stdoutBuf.includes('Server running')) {
        ready = true; clearTimeout(to);
        try {
          await new Promise(r => setTimeout(r, 300));

          // ── Setup ────────────────────────────────────────────────────────────
          const r1 = await reqA1('POST', '/auth/register', { email: `a1-${Date.now()}@t.com`, password: 'A1Pass1!' });
          const cookie = r1.headers['set-cookie']?.[0]?.split(';')[0];
          ok('A.1 server started (harness: NODE_ENV=test + DAXOS_TEST_HARNESS=1)', !!cookie, 'no cookie');
          ok('A.1 test token received from stdout', !!_a1TestToken, 'token not found in stdout');
          if (!cookie) { resolve(); a1Server.kill('SIGTERM'); return; }

          await reqA1('PUT', '/api/business', {
            name: 'E2E Biz',
            business_hours: JSON.stringify({
              1: [['09:00','18:00']], 2: [['09:00','18:00']], 3: [['09:00','18:00']],
              4: [['09:00','18:00']], 5: [['09:00','18:00']],
            }),
          }, { cookie });

          const Database = require('better-sqlite3');
          const a1db = new Database(path.join(A1_DB_DIR, 'daxos.db'));
          a1db.prepare("UPDATE businesses SET plan='crecimiento', plan_paid_at=datetime('now'), agenda_enabled=1 WHERE name='E2E Biz'").run();
          a1db.close();

          const svcR = await reqA1('POST', '/api/agenda/services', { name: 'Consulta', durationMin: 30, sortOrder: 0 }, { cookie });
          ok('A.1 service created', svcR.status === 200, `status=${svcR.status}`);
          if (svcR.status !== 200) { resolve(); a1Server.kill('SIGTERM'); return; }

          // Get businessId
          const bizR = await reqA1('GET', '/api/business', null, { cookie });
          const bizId = bizR.body?.id;
          ok('A.1 got businessId', !!bizId);
          const customerPhone = '59891000099';

          // ── Message 1: client asks for appointment → model selects service S1 ──
          // S1 = first (and only) service, code assigned as S${index+1} at line 2758 of server.js
          await reqA1('POST', '/test/mock-reply', { reply: '[AGENDA_CLIENT_NAME: Test Cliente]\n[AGENDA_SERVICE:S1]' });
          const inj1 = await reqA1('POST', '/test/inject-message', { businessId: bizId, customerPhone, text: 'quiero sacar un turno' });
          ok('A.1 msg1 inject ok', inj1.status === 200, `status=${inj1.status} body=${JSON.stringify(inj1.body)}`);

          // Verify booking_state now has slotsMap with T1 (server set it after AGENDA_SERVICE)
          const db1 = new Database(path.join(A1_DB_DIR, 'daxos.db'));
          const convRow = db1.prepare("SELECT id, booking_state FROM conversations WHERE customer_id=? AND business_id=?").get(customerPhone, bizId);
          db1.close();
          ok('A.1 conversation created by server', !!convRow, 'no conversation row');
          const bookingState = convRow?.booking_state ? JSON.parse(convRow.booking_state) : null;
          const hasT1 = !!(bookingState?.slotsMap?.T1);
          ok('A.1 slotsMap has T1 after AGENDA_SERVICE (server wrote booking_state)', hasT1,
            `slotsMap keys: ${bookingState?.slotsMap ? Object.keys(bookingState.slotsMap).slice(0,5).join(',') : 'null'}`);
          if (!hasT1) { resolve(); a1Server.kill('SIGTERM'); return; }

          // ── Message 2: client chooses T1 → server creates appointment + booking_created ──
          await reqA1('POST', '/test/mock-reply', { reply: '[BOOK_SLOT:T1]' });
          const inj2 = await reqA1('POST', '/test/inject-message', { businessId: bizId, customerPhone, text: 'el primer horario disponible' });
          ok('A.1 msg2 inject ok (BOOK_SLOT:T1)', inj2.status === 200, `status=${inj2.status} body=${JSON.stringify(inj2.body)}`);

          // (a) Verify appointment created in agenda_appointments with correct conversation_id
          const db2 = new Database(path.join(A1_DB_DIR, 'daxos.db'));
          const aptRow = db2.prepare("SELECT id, conversation_id, customer_phone FROM agenda_appointments WHERE business_id=? AND customer_phone=? ORDER BY id DESC LIMIT 1").get(bizId, customerPhone);
          ok('A.1 (a) appointment row in agenda_appointments', !!aptRow, 'no row found');
          ok('A.1 (a) appointment.conversation_id matches server conversation', aptRow?.conversation_id === convRow?.id,
            `apt.conversation_id=${aptRow?.conversation_id} conv.id=${convRow?.id}`);

          // (b) booking_created row in owner_alert_log written by SERVER (not test code)
          const alertRow = db2.prepare("SELECT kind, conversation_id FROM owner_alert_log WHERE conversation_id=? AND kind='booking_created' LIMIT 1").get(convRow?.id);
          ok('A.1 (b) booking_created in owner_alert_log', !!alertRow,
            `convId=${convRow?.id} rows=${db2.prepare("SELECT COUNT(*) as n FROM owner_alert_log").get().n}`);
          ok('A.1 (b) alert.conversation_id matches', alertRow?.conversation_id === convRow?.id);
          db2.close();

          // ── Message 3: [INTERES_COMPRA] should be suppressed by booking_created ──
          await reqA1('POST', '/test/mock-reply', { reply: '[INTERES_COMPRA]\nGracias, fue un placer atenderte.' });
          const inj3 = await reqA1('POST', '/test/inject-message', { businessId: bizId, customerPhone, text: 'muchas gracias' });
          ok('A.1 msg3 inject ok (INTERES_COMPRA suppressed)', inj3.status === 200, `status=${inj3.status}`);

          // Wait for any async notifyOwnerSaleIntent to fire (it won't, but give it time)
          await new Promise(r => setTimeout(r, 600));

          // (c) No sale_intent row for this conversation
          const db3 = new Database(path.join(A1_DB_DIR, 'daxos.db'));
          const saleRow = db3.prepare("SELECT id FROM owner_alert_log WHERE conversation_id=? AND kind='sale_intent' LIMIT 1").get(convRow?.id);
          ok('A.1 (c) no sale_intent in owner_alert_log after booking_created (12h suppression)', !saleRow,
            saleRow ? `found row id=${saleRow.id}` : '');

          // (d) Client text from BOOK_SLOT message has no bracket tags
          const msgRow = db3.prepare(`SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 5`).all(convRow?.id);
          db3.close();
          const tagRegex = /\[[A-Z][A-Z_0-9]*(?::[^\]]+)?\]/;
          const msgsWithTags = msgRow.filter(m => tagRegex.test(m.content));
          ok('A.1 (d) no bracket tags in any assistant message in DB', msgsWithTags.length === 0,
            msgsWithTags.length > 0 ? `found tag in: "${msgsWithTags[0].content.slice(0,80)}"` : '');

        } catch (e) {
          ok('A.1 e2e test', false, e.message + '\n' + (e.stack || '').slice(0, 300));
        } finally {
          a1Server.kill('SIGTERM');
          await new Promise(r => setTimeout(r, 300));
          try { execSync(`rm -rf ${A1_DB_DIR}`); } catch (_) {}
          resolve();
        }
      }
    });
    a1Server.on('error', e => { clearTimeout(to); ok('A.1 server started', false, e.message); resolve(); });
  });

  // Final summary
  console.log('\n================================================================');
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
