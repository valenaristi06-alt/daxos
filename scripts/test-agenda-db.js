'use strict';
/**
 * Unit tests: migration 017, createAppointment, double-booking,
 * overlap detection, adjacent slots, cancelAppointment, rescheduleAppointment
 *
 * Run: node scripts/test-agenda-db.js
 */

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const DB_DIR = '/tmp/test-agenda-db';
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;

const db = require('../src/db');

let passed = 0;
let failed = 0;

function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

function throws(label, fn, msgSubstr) {
  try { fn(); console.error(`  ✗ ${label} — expected throw, got none`); failed++; }
  catch (e) {
    if (msgSubstr && !e.message.includes(msgSubstr)) {
      console.error(`  ✗ ${label} — threw "${e.message}" not "${msgSubstr}"`); failed++;
    } else { console.log(`  ✓ ${label}`); passed++; }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function seedBiz(suffix = '') {
  const biz = db.upsertBusiness({
    whatsapp_number: `+5989900000${suffix || Math.floor(Math.random() * 9000 + 1000)}`,
    name: `Test Biz ${suffix}`,
  });
  return biz.id;
}

function apt(bizId, phone, startsAt, endsAt, opts = {}) {
  return db.createAppointment({
    businessId: bizId,
    customerPhone: phone,
    startsAt,
    endsAt,
    serviceId: opts.serviceId ?? null,
    conversationId: opts.conversationId ?? null,
    clientName: opts.clientName ?? 'Test Client',
    notes: opts.notes ?? null,
  });
}

// ── Test: migration idempotency ────────────────────────────────────────────────

console.log('\n--- migration 017 idempotency ---');

{
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DB_DIR, 'daxos.db'));

  const tables = raw.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('agenda_services','agenda_appointments')
  `).all().map(r => r.name);

  ok('agenda_services table exists',     tables.includes('agenda_services'));
  ok('agenda_appointments table exists', tables.includes('agenda_appointments'));

  const cols = raw.prepare(`PRAGMA table_info(businesses)`).all().map(c => c.name);
  ok('businesses.agenda_enabled column',           cols.includes('agenda_enabled'));
  ok('businesses.agenda_slot_min column',          cols.includes('agenda_slot_min'));
  ok('businesses.agenda_cancel_min_before column', cols.includes('agenda_cancel_min_before'));

  // Verify defaults on a fresh business row
  const newBizId = raw.prepare(`INSERT INTO businesses (name) VALUES ('default-check')`).run().lastInsertRowid;
  const newBiz   = raw.prepare('SELECT agenda_enabled, agenda_slot_min, agenda_cancel_min_before FROM businesses WHERE id = ?').get(newBizId);
  ok('agenda_enabled default is 0',           newBiz?.agenda_enabled === 0);
  ok('agenda_slot_min default is 30',         newBiz?.agenda_slot_min === 30);
  ok('agenda_cancel_min_before default is 120', newBiz?.agenda_cancel_min_before === 120);

  const idxs = raw.prepare(`
    SELECT name FROM sqlite_master WHERE type='index'
    AND name IN ('idx_apt_biz_start','idx_apt_phone')
  `).all().map(r => r.name);
  ok('idx_apt_biz_start index exists', idxs.includes('idx_apt_biz_start'));
  ok('idx_apt_phone index exists',     idxs.includes('idx_apt_phone'));

  const mig = raw.prepare(`SELECT version FROM schema_migrations WHERE version='021_agenda'`).get();
  ok('021_agenda recorded in schema_migrations', !!mig);

  raw.close();
}

// ── Test: partial migration recovery ─────────────────────────────────────────
// Simulates a crash after the first ALTER TABLE succeeded but before
// INSERT INTO schema_migrations. On next startup the column guards must
// skip the already-applied ALTER TABLE and finish the remaining work.

console.log('\n--- migration 017 partial recovery ---');

{
  const { execFileSync } = require('child_process');
  const os = require('os');
  const PARTIAL_DIR = '/tmp/test-agenda-db-partial';
  try { require('child_process').execSync(`rm -rf ${PARTIAL_DIR}`); } catch (_) {}
  fs.mkdirSync(PARTIAL_DIR, { recursive: true });

  const PROJ     = path.join(__dirname, '..');
  const DB_PATH  = path.join(PARTIAL_DIR, 'daxos.db');
  const PROJ_Q   = JSON.stringify(PROJ);
  const PDIR_Q   = JSON.stringify(PARTIAL_DIR);
  const DBPATH_Q = JSON.stringify(DB_PATH);

  // Step 1: create base schema (migrations 001-016) then manually add only
  // the first agenda column — simulating a crash mid-017 before schema_migrations insert.
  const setupFile = path.join(os.tmpdir(), 'test017-setup.js');
  const Database = require('better-sqlite3');

  // Step 1: build partial state directly with better-sqlite3 (bypass db.js)
  // — base businesses table + schema_migrations with 001-016 but NOT 017
  // — only agenda_enabled added, slot_min and cancel_min_before missing
  {
    const raw = new Database(DB_PATH);
    raw.pragma('journal_mode = WAL');
    raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS businesses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, whatsapp_number TEXT UNIQUE, plan TEXT DEFAULT 'arranque',
        plan_cortesia INTEGER NOT NULL DEFAULT 0,
        booking_enabled INTEGER NOT NULL DEFAULT 0,
        weekly_summary_enabled INTEGER NOT NULL DEFAULT 1,
        response_mode TEXT DEFAULT 'texto', response_delay INTEGER DEFAULT 5,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // Mark 001-016 as applied (skip 017)
    const versions = ['002_trial_starts_at','003_plan_cortesia_valentin','005_trial_grace',
      '007_pause_keyword','006_billing','008_wa_silence','009_wa_health','010_lote3',
      '011_lote3_password_reset','012_excluded_contacts','013_urgent_keywords',
      '014_business_hours','015_owner_rules','016_plan_cortesia_valentin_v2'];
    const ins = raw.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?)');
    versions.forEach(v => ins.run(v));
    // Partial 017: only first column
    raw.exec('ALTER TABLE businesses ADD COLUMN agenda_enabled INTEGER NOT NULL DEFAULT 0');
    raw.close();
  }

  // Step 2: fresh subprocess — db.js must detect partial state and finish migration
  const BSQ3 = JSON.stringify(path.join(PROJ, 'node_modules', 'better-sqlite3'));
  const recoverFile = path.join(os.tmpdir(), 'test017-recover.js');
  fs.writeFileSync(recoverFile,
    `process.env.DB_DIR = ${PDIR_Q};\n` +
    `require(require('path').join(${PROJ_Q}, 'src/db'));\n` +
    `const D = require(${BSQ3});\n` +
    `const r = new D(${DBPATH_Q});\n` +
    `const cols      = r.prepare("PRAGMA table_info(businesses)").all().map(c => c.name);\n` +
    `const tables    = r.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agenda_services','agenda_appointments')").all().map(x => x.name);\n` +
    `const mig       = !!r.prepare("SELECT version FROM schema_migrations WHERE version='021_agenda'").get();\n` +
    `const _colInfo  = r.prepare("PRAGMA table_info(businesses)").all();\n` +
    `const cancelDef = (_colInfo.find(c => c.name === "agenda_cancel_min_before") || {}).dflt_value;\n` +
    `r.close();\n` +
    `process.stdout.write(JSON.stringify({ cols, tables, mig, cancelDef }) + "\\n");\n`
  );

  const out = execFileSync('node', [recoverFile], { cwd: PROJ }).toString().trim().split('\n').pop();

  let result;
  try { result = JSON.parse(out); } catch { result = {}; }

  ok('partial recovery: agenda_enabled present',            result.cols?.includes('agenda_enabled'));
  ok('partial recovery: agenda_slot_min present',           result.cols?.includes('agenda_slot_min'));
  ok('partial recovery: agenda_cancel_min_before present',  result.cols?.includes('agenda_cancel_min_before'));
  ok('partial recovery: agenda_cancel_min_before default is 120', result.cancelDef === '120');
  ok('partial recovery: agenda_services table present',     result.tables?.includes('agenda_services'));
  ok('partial recovery: agenda_appointments table present', result.tables?.includes('agenda_appointments'));
  ok('partial recovery: 021_agenda recorded',               result.mig === true);
}

// ── Test: createAgendaService ──────────────────────────────────────────────────

console.log('\n--- createAgendaService ---');

{
  const bizId = seedBiz('svc');
  const r = db.createAgendaService(bizId, { name: 'Corte', durationMin: 30, sortOrder: 1 });
  ok('service inserted', r.changes === 1);

  const svcs = db.getAgendaServices(bizId);
  ok('getAgendaServices returns 1', svcs.length === 1);
  ok('service name correct', svcs[0].name === 'Corte');
  ok('service duration_min correct', svcs[0].duration_min === 30);

  // Upsert same name updates duration
  db.createAgendaService(bizId, { name: 'Corte', durationMin: 45, sortOrder: 1 });
  const svcs2 = db.getAgendaServices(bizId);
  ok('upsert updates duration_min', svcs2[0].duration_min === 45);
  ok('upsert does not duplicate', svcs2.length === 1);

  // Deactivate
  db.deactivateAgendaService(svcs2[0].id, bizId);
  const svcs3 = db.getAgendaServices(bizId);
  ok('deactivated service hidden from getAgendaServices', svcs3.length === 0);
}

// ── Test: createAppointment basic ─────────────────────────────────────────────

console.log('\n--- createAppointment basic ---');

{
  const bizId = seedBiz('apt1');
  const a = apt(bizId, '+598111', '2025-11-17T12:00:00.000Z', '2025-11-17T12:30:00.000Z');
  ok('createAppointment returns object',  typeof a === 'object' && a !== null);
  ok('appointment has id',                typeof a.id === 'number');
  ok('status is confirmed',               a.status === 'confirmed');
  ok('starts_at stored correctly',        a.starts_at === '2025-11-17T12:00:00.000Z');
  ok('ends_at stored correctly',          a.ends_at   === '2025-11-17T12:30:00.000Z');

  const fetched = db.getAppointmentById(a.id);
  ok('getAppointmentById returns same id', fetched?.id === a.id);
}

// ── Test: double-booking (exact same slot) ────────────────────────────────────

console.log('\n--- double-booking: exact same slot ---');

{
  const bizId = seedBiz('dbl');
  apt(bizId, '+598111', '2025-11-18T09:00:00.000Z', '2025-11-18T09:30:00.000Z');
  throws(
    'second booking same slot throws SLOT_TAKEN',
    () => apt(bizId, '+598222', '2025-11-18T09:00:00.000Z', '2025-11-18T09:30:00.000Z'),
    'SLOT_TAKEN',
  );
}

// ── Test: overlap detection ───────────────────────────────────────────────────

console.log('\n--- overlap detection ---');

{
  const bizId = seedBiz('ovl');
  // 10:00-11:00 confirmed
  apt(bizId, '+598111', '2025-11-19T13:00:00.000Z', '2025-11-19T14:00:00.000Z');

  // Overlapping cases
  throws('start inside existing throws SLOT_TAKEN',
    () => apt(bizId, '+598222', '2025-11-19T13:30:00.000Z', '2025-11-19T14:30:00.000Z'),
    'SLOT_TAKEN');
  throws('end inside existing throws SLOT_TAKEN',
    () => apt(bizId, '+598222', '2025-11-19T12:30:00.000Z', '2025-11-19T13:30:00.000Z'),
    'SLOT_TAKEN');
  throws('fully containing existing throws SLOT_TAKEN',
    () => apt(bizId, '+598222', '2025-11-19T12:00:00.000Z', '2025-11-19T15:00:00.000Z'),
    'SLOT_TAKEN');
}

// ── Test: adjacent slots allowed ──────────────────────────────────────────────

console.log('\n--- adjacent slots: allowed ---');

{
  const bizId = seedBiz('adj');
  apt(bizId, '+598111', '2025-11-20T10:00:00.000Z', '2025-11-20T10:30:00.000Z');

  // Immediately before
  let ok1;
  try {
    apt(bizId, '+598222', '2025-11-20T09:30:00.000Z', '2025-11-20T10:00:00.000Z');
    ok1 = true;
  } catch { ok1 = false; }
  ok('adjacent before (ends == starts) allowed', ok1);

  // Immediately after
  let ok2;
  try {
    apt(bizId, '+598333', '2025-11-20T10:30:00.000Z', '2025-11-20T11:00:00.000Z');
    ok2 = true;
  } catch { ok2 = false; }
  ok('adjacent after (starts == ends) allowed', ok2);
}

// ── Test: cancelAppointment ───────────────────────────────────────────────────

console.log('\n--- cancelAppointment ---');

{
  const bizId = seedBiz('can');
  const a = apt(bizId, '+598111', '2025-11-21T09:00:00.000Z', '2025-11-21T09:30:00.000Z');

  const r1 = db.cancelAppointment(a.id, 'client', 'no pude');
  ok('cancelAppointment returns true on success', r1 === true);

  const fetched = db.getAppointmentById(a.id);
  ok('status is cancelled', fetched?.status === 'cancelled');
  ok('cancelled_by is client', fetched?.cancelled_by === 'client');
  ok('cancel_reason stored', fetched?.cancel_reason === 'no pude');

  // Idempotent: cancel again returns false
  const r2 = db.cancelAppointment(a.id, 'owner', null);
  ok('cancelAppointment returns false on already-cancelled', r2 === false);

  // Slot is now free for new booking
  let rebooked;
  try {
    apt(bizId, '+598222', '2025-11-21T09:00:00.000Z', '2025-11-21T09:30:00.000Z');
    rebooked = true;
  } catch { rebooked = false; }
  ok('cancelled slot is free for rebooking', rebooked);
}

// ── Test: rescheduleAppointment atomic ────────────────────────────────────────

console.log('\n--- rescheduleAppointment ---');

{
  const bizId = seedBiz('rsc');
  const phone = '+598111';
  const old = apt(bizId, phone, '2025-11-22T09:00:00.000Z', '2025-11-22T09:30:00.000Z');

  // Normal reschedule to a free slot
  const newApt = db.rescheduleAppointment({
    oldId: old.id, businessId: bizId, customerPhone: phone,
    startsAt: '2025-11-22T11:00:00.000Z', endsAt: '2025-11-22T11:30:00.000Z',
    clientName: 'Test Client',
  });
  ok('reschedule returns new appointment', typeof newApt === 'object');
  ok('new appointment status confirmed', newApt?.status === 'confirmed');
  ok('old appointment now cancelled', db.getAppointmentById(old.id)?.status === 'cancelled');
  ok('old cancel_reason is rescheduled', db.getAppointmentById(old.id)?.cancel_reason === 'rescheduled');

  // Reschedule to a taken slot: old should stay confirmed
  const blocker = apt(bizId, '+598999', '2025-11-22T14:00:00.000Z', '2025-11-22T14:30:00.000Z');
  throws(
    'reschedule to taken slot throws SLOT_TAKEN',
    () => db.rescheduleAppointment({
      oldId: newApt.id, businessId: bizId, customerPhone: phone,
      startsAt: '2025-11-22T14:00:00.000Z', endsAt: '2025-11-22T14:30:00.000Z',
      clientName: 'Test Client',
    }),
    'SLOT_TAKEN',
  );
  ok('new apt stays confirmed after failed reschedule', db.getAppointmentById(newApt.id)?.status === 'confirmed');
}

// ── Test: rescheduleAppointment — overlap with self allowed ───────────────────
// A 90-min booking at 10:00-11:30 moved forward 30min to 10:30-12:00 overlaps
// with itself. The overlap check must exclude oldId — this must succeed.

console.log('\n--- rescheduleAppointment: overlap with self (shift forward) ---');

{
  const bizId = seedBiz('selfovl');
  const phone  = '+598444';
  // 10:00-11:30 UTC (= 07:00-08:30 MVD, irrelevant for UTC-stored dates)
  const old90 = apt(bizId, phone, '2025-11-25T13:00:00.000Z', '2025-11-25T14:30:00.000Z');

  // Move to 10:30-12:00 UTC — new slot (13:30-15:00) overlaps old (13:00-14:30) by 60min
  let shifted;
  try {
    shifted = db.rescheduleAppointment({
      oldId: old90.id, businessId: bizId, customerPhone: phone,
      startsAt: '2025-11-25T13:30:00.000Z', endsAt: '2025-11-25T15:00:00.000Z',
      clientName: 'Self Overlap',
    });
  } catch (e) {
    shifted = null;
  }
  ok('90min booking shifted 30min forward (self-overlap) succeeds', shifted !== null);
  ok('shifted appointment is confirmed', shifted?.status === 'confirmed');
  ok('old appointment is cancelled after self-overlap shift', db.getAppointmentById(old90.id)?.status === 'cancelled');
}

// ── Test: rescheduleAppointment — overlap with another client fails, old intact ─

console.log('\n--- rescheduleAppointment: collision with other client ---');

{
  const bizId  = seedBiz('othercol');
  const phone  = '+598555';
  const other  = '+598666';

  // Client A has 10:00-10:30
  const clientA = apt(bizId, phone, '2025-11-26T13:00:00.000Z', '2025-11-26T13:30:00.000Z');
  // Client B blocks 11:00-11:30
  apt(bizId, other, '2025-11-26T14:00:00.000Z', '2025-11-26T14:30:00.000Z');

  // Client A tries to move into client B's slot
  throws(
    'reschedule into another client slot throws SLOT_TAKEN',
    () => db.rescheduleAppointment({
      oldId: clientA.id, businessId: bizId, customerPhone: phone,
      startsAt: '2025-11-26T14:00:00.000Z', endsAt: '2025-11-26T14:30:00.000Z',
      clientName: 'Client A',
    }),
    'SLOT_TAKEN',
  );
  ok('old appointment intact after collision', db.getAppointmentById(clientA.id)?.status === 'confirmed');
  ok('old appointment starts_at unchanged', db.getAppointmentById(clientA.id)?.starts_at === '2025-11-26T13:00:00.000Z');
}

// ── Test: rescheduleAppointment ownership check ───────────────────────────────

console.log('\n--- rescheduleAppointment ownership ---');

{
  const bizId  = seedBiz('own');
  const phone1 = '+598111';
  const phone2 = '+598222';
  const a = apt(bizId, phone1, '2025-11-23T09:00:00.000Z', '2025-11-23T09:30:00.000Z');

  throws(
    'reschedule by wrong phone throws APPOINTMENT_NOT_FOUND',
    () => db.rescheduleAppointment({
      oldId: a.id, businessId: bizId, customerPhone: phone2,
      startsAt: '2025-11-23T11:00:00.000Z', endsAt: '2025-11-23T11:30:00.000Z',
      clientName: 'Other',
    }),
    'APPOINTMENT_NOT_FOUND',
  );
  ok('appointment stays confirmed after unauthorized reschedule', db.getAppointmentById(a.id)?.status === 'confirmed');
}

// ── Test: getUpcomingAppointmentsForPhone ─────────────────────────────────────

console.log('\n--- getUpcomingAppointmentsForPhone ---');

{
  const bizId = seedBiz('upc');
  const phone = '+598555';
  // Past (won't appear)
  apt(bizId, phone, '2020-01-01T10:00:00.000Z', '2020-01-01T10:30:00.000Z');
  // Future (will appear)
  apt(bizId, phone, '2099-12-01T10:00:00.000Z', '2099-12-01T10:30:00.000Z');
  apt(bizId, phone, '2099-12-02T10:00:00.000Z', '2099-12-02T10:30:00.000Z');

  const upcoming = db.getUpcomingAppointmentsForPhone(bizId, phone);
  ok('getUpcomingAppointmentsForPhone returns only future', upcoming.length === 2);
  ok('ordered by starts_at', upcoming[0].starts_at < upcoming[1].starts_at);
}

// ── Test: setAgendaEnabled ────────────────────────────────────────────────────

console.log('\n--- setAgendaEnabled ---');

{
  const bizId = seedBiz('enb');
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DB_DIR, 'daxos.db'));

  db.setAgendaEnabled(bizId, true);
  const r1 = raw.prepare('SELECT agenda_enabled FROM businesses WHERE id = ?').get(bizId);
  ok('setAgendaEnabled true writes 1', r1?.agenda_enabled === 1);

  db.setAgendaEnabled(bizId, false);
  const r2 = raw.prepare('SELECT agenda_enabled FROM businesses WHERE id = ?').get(bizId);
  ok('setAgendaEnabled false writes 0', r2?.agenda_enabled === 0);

  raw.close();
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\ntests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
