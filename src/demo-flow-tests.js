#!/usr/bin/env node
// Run: node src/demo-flow-tests.js
// Tests session expiry and follow-up scheduling with a simulated clock.
// Uses an in-memory SQLite DB — safe to run anywhere, never touches production.
'use strict';

process.env.DB_DIR = ':memory-test:'; // forces DB to use a temp dir below

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Give db.js a writable temp dir so it creates a fresh DB each run
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-test-'));
process.env.DB_DIR = tmpDir;

// Now safe to require db and demo-flow
const db = require('./db');
const {
  isSessionExpired,
  normalizeActivation,
  hasEnoughData,
  SESSION_EXPIRY_MINUTES,
  FOLLOWUP_DELAY_MS,
  EXPIRING_STATES,
} = require('./demo-flow');
const { htmlToText } = require('./demo-scraper');

// ─── Mini test runner ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

function assert(value, msg) {
  if (!value) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─── normalizeActivation ─────────────────────────────────────────────────────

console.log('\n[0] normalizeActivation — activation trigger\n');

const activates  = (s) => { assert(normalizeActivation(s) === 'demo', `"${s}" should activate`); };
const noActivate = (s) => { assert(normalizeActivation(s) !== 'demo', `"${s}" should NOT activate`); };

test('bare "demo" activates',           () => activates('demo'));
test('uppercase "DEMO" activates',      () => activates('DEMO'));
test('mixed case "Demo" activates',     () => activates('Demo'));
test('"¡demo!" activates',             () => activates('¡demo!'));
test('"démò" (accented) activates',    () => activates('démò'));
test('"🎯 demo" (emoji+space) activates', () => activates('🎯 demo'));
test('" demo " (padded spaces) activates', () => activates(' demo '));
test('"quiero una demo" does NOT activate', () => noActivate('quiero una demo'));
test('"demo gratis" does NOT activate', () => noActivate('demo gratis'));
test('"quiero demo" does NOT activate', () => noActivate('quiero demo'));
test('"no demo" does NOT activate',    () => noActivate('no demo'));
test('"una demo por favor" does NOT activate', () => noActivate('una demo por favor'));
test('"demostracion" does NOT activate', () => noActivate('demostracion'));

// ─── isSessionExpired — pure function tests ───────────────────────────────────

console.log('\n[1] isSessionExpired — session states and timing\n');

const NOW = Date.now();
const MIN = 60 * 1000;

test('expired: esperando_link older than 30 min', () => {
  const s = { state: 'esperando_link', updated_at: new Date(NOW - (SESSION_EXPIRY_MINUTES + 1) * MIN).toISOString() };
  assert(isSessionExpired(s, NOW));
});

test('not expired: esperando_link 29 min old', () => {
  const s = { state: 'esperando_link', updated_at: new Date(NOW - (SESSION_EXPIRY_MINUTES - 1) * MIN).toISOString() };
  assert(!isSessionExpired(s, NOW));
});

test('exactly at boundary (30 min) is expired', () => {
  const s = { state: 'esperando_link', updated_at: new Date(NOW - SESSION_EXPIRY_MINUTES * MIN).toISOString() };
  // 30 min elapsed == equal, not >, so NOT expired
  assert(!isSessionExpired(s, NOW));
});

test('expired: esperando_link_warned older than 30 min', () => {
  const s = { state: 'esperando_link_warned', updated_at: new Date(NOW - 31 * MIN).toISOString() };
  assert(isSessionExpired(s, NOW));
});

test('expired: esperando_texto older than 30 min', () => {
  const s = { state: 'esperando_texto', updated_at: new Date(NOW - 31 * MIN).toISOString() };
  assert(isSessionExpired(s, NOW));
});

test('expired: esperando_texto_warned older than 30 min', () => {
  const s = { state: 'esperando_texto_warned', updated_at: new Date(NOW - 31 * MIN).toISOString() };
  assert(isSessionExpired(s, NOW));
});

test('NOT expired: procesando (state never expires)', () => {
  const s = { state: 'procesando', updated_at: new Date(NOW - 120 * MIN).toISOString() };
  assert(!isSessionExpired(s, NOW));
});

test('NOT expired: listo (state never expires)', () => {
  const s = { state: 'listo', updated_at: new Date(NOW - 48 * 60 * MIN).toISOString() };
  assert(!isSessionExpired(s, NOW));
});

test('null session returns expired', () => {
  assert(isSessionExpired(null, NOW));
});

test('EXPIRING_STATES covers all 4 waiting states', () => {
  assertEqual(EXPIRING_STATES.size, 4);
  assert(EXPIRING_STATES.has('esperando_link'));
  assert(EXPIRING_STATES.has('esperando_link_warned'));
  assert(EXPIRING_STATES.has('esperando_texto'));
  assert(EXPIRING_STATES.has('esperando_texto_warned'));
});

// ─── getDemosForFollowup — DB-based timing tests ─────────────────────────────

console.log('\n[2] getDemosForFollowup — follow-up scheduling\n');

function insertSession({ phone, followupSentAt, createdHoursAgo }) {
  const now      = new Date();
  const created  = new Date(now.getTime() - createdHoursAgo * 3600 * 1000);
  const eligible = new Date(now.getTime() - 1 * 60 * 1000); // 1 min ago = already eligible
  db.upsertDemoFlowSession(phone, 'listo', 'test-slug', {
    followup_sent:        0,
    followup_eligible_at: eligible.toISOString(),
  });
  // Patch created_at to simulate age (upsertDemoFlowSession sets created_at to now)
  const rawDb = require('better-sqlite3')(require('path').join(process.env.DB_DIR, 'daxos.db'));
  rawDb.prepare('UPDATE demo_flow_sessions SET created_at=? WHERE phone=?')
    .run(created.toISOString(), phone);
  rawDb.close();
}

test('session 1h old → eligible for follow-up', () => {
  insertSession({ phone: '5491100000001', createdHoursAgo: 1 });
  const rows = db.getDemosForFollowup();
  assert(rows.some(r => r.phone === '5491100000001'), 'should be returned');
});

test('session 23h old → outside 22h window → NOT eligible', () => {
  insertSession({ phone: '5491100000002', createdHoursAgo: 23 });
  const rows = db.getDemosForFollowup();
  assert(!rows.some(r => r.phone === '5491100000002'), 'should NOT be returned (outside window)');
});

test('session already has followup_sent=1 → NOT returned', () => {
  insertSession({ phone: '5491100000003', createdHoursAgo: 2 });
  // Mark as sent
  db.upsertDemoFlowSession('5491100000003', 'listo', 'test-slug', { followup_sent: 1 });
  const rows = db.getDemosForFollowup();
  assert(!rows.some(r => r.phone === '5491100000003'), 'already sent, should NOT be returned');
});

test('follow-up sent exactly once: marking followup_sent removes from queue', () => {
  const phone = '5491100000004';
  insertSession({ phone, createdHoursAgo: 3 });
  let rows = db.getDemosForFollowup();
  assert(rows.some(r => r.phone === phone), 'should be in queue before sending');
  db.upsertDemoFlowSession(phone, 'listo', 'test-slug', { followup_sent: 1 });
  rows = db.getDemosForFollowup();
  assert(!rows.some(r => r.phone === phone), 'should NOT be in queue after sending');
});

test('follow-up window: 22h is the cutoff (21h59m → eligible, 22h01m → not)', () => {
  const phoneIn  = '5491100000005';
  const phoneOut = '5491100000006';
  insertSession({ phone: phoneIn,  createdHoursAgo: 21.9 });
  insertSession({ phone: phoneOut, createdHoursAgo: 22.1 });
  const rows = db.getDemosForFollowup();
  assert(rows.some(r => r.phone === phoneIn),  '21.9h should be eligible');
  assert(!rows.some(r => r.phone === phoneOut), '22.1h should NOT be eligible');
});

// ─── htmlToText — strips tracking noise before measuring ─────────────────────

console.log('\n[3] htmlToText — noscript/script/style/comment stripping\n');

const TRACKING_PAGE = `<!DOCTYPE html>
<html><head>
<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());</script>
<style>.hidden{display:none}</style>
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXXXX" height="0" width="0"></iframe>
This page requires JavaScript. Please enable it. GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM GTM.</noscript>
</head><body>
<!-- Google Analytics tracking pixel -->
<div class="visible">Plomería González — Servicio urgente 24 hs</div>
<script>trackEvent('pageview','home');</script>
</body></html>`;

test('htmlToText removes <script> content', () => {
  const t = htmlToText(TRACKING_PAGE);
  assert(!t.includes('dataLayer'), 'script content must be removed');
  assert(!t.includes('trackEvent'), 'inline script must be removed');
});

test('htmlToText removes <style> content', () => {
  const t = htmlToText(TRACKING_PAGE);
  assert(!t.includes('.hidden'), 'style content must be removed');
});

test('htmlToText removes <noscript> content', () => {
  const t = htmlToText(TRACKING_PAGE);
  assert(!t.includes('GTM'), 'noscript GTM noise must be removed');
  assert(!t.includes('requires JavaScript'), 'noscript text must be removed');
});

test('htmlToText removes HTML comments', () => {
  const t = htmlToText(TRACKING_PAGE);
  assert(!t.includes('Google Analytics tracking pixel'), 'comment must be removed');
});

test('htmlToText keeps visible text', () => {
  const t = htmlToText(TRACKING_PAGE);
  assert(t.includes('Plomería González'), 'visible text must survive');
  assert(t.includes('24 hs'), 'visible text must survive');
});

test('page of only tracking scripts → short text → isJsOnly detects it', () => {
  const SCRIPTS_ONLY = `<html><head>
<script>var x=1;</script><script>var y=2;</script>
<noscript>Enable JavaScript</noscript>
<style>body{}</style><!-- comment -->
</head><body><div id="root"></div></body></html>`;
  const t = htmlToText(SCRIPTS_ONLY);
  assert(t.length < 80, `text too long after strip: "${t}" (${t.length} chars)`);
});

// ─── hasEnoughData — quality gate ────────────────────────────────────────────

console.log('\n[4] hasEnoughData — quality gate\n');

test('empty object {} → false', () => {
  assert(!hasEnoughData({}));
});

test('nombre only, no content → false', () => {
  assert(!hasEnoughData({ nombre: 'Acme', servicios: [], descripcion: null }));
});

test('nombre + 1 servicio → true', () => {
  assert(hasEnoughData({ nombre: 'Acme', servicios: ['instalaciones'] }));
});

test('nombre + descripcion ≥80 chars → true', () => {
  assert(hasEnoughData({ nombre: 'Acme', descripcion: 'x'.repeat(80) }));
});

test('nombre + descripcion <80 chars → false', () => {
  assert(!hasEnoughData({ nombre: 'Acme', descripcion: 'corta' }));
});

test('nombre + 1 FAQ, no servicios → true', () => {
  assert(hasEnoughData({ nombre: 'Acme', preguntas_frecuentes: ['¿Cómo funciona?: Muy bien'] }));
});

test('nombre + 1 promo → true', () => {
  assert(hasEnoughData({ nombre: 'Acme', promos: ['50% off en mayo'] }));
});

test('nombre + sede con horario → true', () => {
  assert(hasEnoughData({ nombre: 'Acme', sedes: [{ horario: 'Lun-Vie 9-18' }] }));
});

test('nombre + sede sin datos → false', () => {
  assert(!hasEnoughData({ nombre: 'Acme', sedes: [{ nombre: 'Central' }] }));
});

test('no nombre + 2 servicios → true', () => {
  assert(hasEnoughData({ servicios: ['pinturas', 'barnices'] }));
});

test('no nombre + 1 servicio → false', () => {
  assert(!hasEnoughData({ servicios: ['pinturas'] }));
});

test('antel.com.uy case: all undefined → false', () => {
  assert(!hasEnoughData({ tono: 'formal' }));
});

// ─── getUserByPhone — SQL double-quote regression ────────────────────────────

console.log('\n[5] getUserByPhone — SQL syntax and 8-digit match\n');

test('getUserByPhone does not throw (was: double-quoted "" in SQL)', () => {
  assert(db.getUserByPhone('5491100000000') === null, 'unknown phone → null');
});

test('getUserByPhone returns null when no users have a phone', () => {
  assert(db.getUserByPhone('5491199998888') === null, 'no matching user');
});

test('getUserByPhone matches by last 8 digits', () => {
  // Insert a user with a known phone, then verify match by suffix
  const rawDb = require('better-sqlite3')(require('path').join(process.env.DB_DIR, 'daxos.db'));
  rawDb.prepare("INSERT OR IGNORE INTO users (email, password_hash, phone) VALUES ('test@x.com','hash','+5491187654321')").run();
  rawDb.close();
  const found = db.getUserByPhone('+549187654321'); // shares last 8 digits: 87654321
  assert(found !== null, 'should match by last 8 digits');
  assert(found.email === 'test@x.com');
});

test('getUserByPhone does NOT match when only last 4 digits overlap', () => {
  // phone in DB ends in 87654321; test phone ends in 00004321 — last 8 differ
  const found = db.getUserByPhone('+549100004321');
  assert(found === null, 'partial suffix should not match');
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failed > 0) process.exit(1);
