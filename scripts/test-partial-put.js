#!/usr/bin/env node
'use strict';
// Verifica que PUT /api/business con campos ausentes NO pisa
// urgent_keywords, urgent_alert_enabled, business_hours, after_hours_instructions, urgent_phone.
// Run: node scripts/test-partial-put.js

const path = require('path');
const fs   = require('fs');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const { upsertBusiness, getBusinessById } = require('../src/db.js');

let passed = 0, failed = 0;
function assert(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${desc}`); passed++; }
  else { console.error(`  ✗ ${desc}`); console.error(`    expected: ${JSON.stringify(expected)}`); console.error(`    actual:   ${JSON.stringify(actual)}`); failed++; }
}

// ── Create a test business with all fields set ────────────────────────────
const BH_JSON = JSON.stringify({ 1: [['09:00','19:00']] });

const created = upsertBusiness({
  name: '__test_partial_put__',
  business_hours: BH_JSON,
  after_hours_instructions: 'Estamos cerrados.',
  urgent_phone: '099 111 222',
  urgent_keywords: 'urgente,emergencia',
  urgent_alert_enabled: 1,
});
const bizId = created.id;
console.log(`\nTest biz created: id=${bizId}`);

// Verify initial values
const initial = getBusinessById(bizId);
assert('initial: business_hours set',          initial.business_hours, BH_JSON);
assert('initial: after_hours_instructions set', initial.after_hours_instructions, 'Estamos cerrados.');
assert('initial: urgent_phone set',             initial.urgent_phone, '099 111 222');
assert('initial: urgent_keywords set',          initial.urgent_keywords, 'urgente,emergencia');
assert('initial: urgent_alert_enabled=1',       initial.urgent_alert_enabled, 1);

// ── Simulate PUT /api/business body that does NOT include those 5 fields ──
// This mirrors the patch logic in the PUT handler:
// for each field: 'field' in body ? newVal : currentBiz[field]

function simulatePut(reqBody, currentBiz) {
  return {
    id: currentBiz.id,
    name: (reqBody.name || '').trim(),
    urgent_keywords:          'urgent_keywords'          in reqBody ? (reqBody.urgent_keywords ? reqBody.urgent_keywords.trim() : null)                    : (currentBiz.urgent_keywords       ?? null),
    urgent_alert_enabled:     'urgent_alert_enabled'     in reqBody ? (reqBody.urgent_alert_enabled ? 1 : 0)                                               : (currentBiz.urgent_alert_enabled  ?? 0),
    business_hours:           'business_hours'           in reqBody ? (reqBody.business_hours || null)                                                     : (currentBiz.business_hours        ?? null),
    after_hours_instructions: 'after_hours_instructions' in reqBody ? (reqBody.after_hours_instructions ? String(reqBody.after_hours_instructions).trim() : null) : (currentBiz.after_hours_instructions ?? null),
    urgent_phone:             'urgent_phone'             in reqBody ? (reqBody.urgent_phone ? String(reqBody.urgent_phone).trim() : null)                  : (currentBiz.urgent_phone          ?? null),
  };
}

// Partial PUT: only name in body
console.log('\n── Partial PUT (only name) — must preserve all 5 fields ──');
const partialBody = { name: 'Nombre actualizado' };
const partialPayload = simulatePut(partialBody, initial);
upsertBusiness({ ...partialPayload });

const afterPartial = getBusinessById(bizId);
assert('partial PUT: business_hours preserved',          afterPartial.business_hours, BH_JSON);
assert('partial PUT: after_hours_instructions preserved', afterPartial.after_hours_instructions, 'Estamos cerrados.');
assert('partial PUT: urgent_phone preserved',             afterPartial.urgent_phone, '099 111 222');
assert('partial PUT: urgent_keywords preserved',          afterPartial.urgent_keywords, 'urgente,emergencia');
assert('partial PUT: urgent_alert_enabled preserved',     afterPartial.urgent_alert_enabled, 1);

// Full PUT: all fields in body (normal dashboard save)
console.log('\n── Full PUT (all fields) — must update all 5 fields ──');
const fullBody = {
  name: 'Nombre full',
  urgent_keywords: 'nuevo',
  urgent_alert_enabled: 0,
  business_hours: JSON.stringify({ 2: [['10:00','18:00']] }),
  after_hours_instructions: 'Cerrado ahora.',
  urgent_phone: '099 999 888',
};
const fullPayload = simulatePut(fullBody, afterPartial);
upsertBusiness({ ...fullPayload });

const afterFull = getBusinessById(bizId);
assert('full PUT: business_hours updated',          afterFull.business_hours, JSON.stringify({ 2: [['10:00','18:00']] }));
assert('full PUT: after_hours_instructions updated', afterFull.after_hours_instructions, 'Cerrado ahora.');
assert('full PUT: urgent_phone updated',             afterFull.urgent_phone, '099 999 888');
assert('full PUT: urgent_keywords updated',          afterFull.urgent_keywords, 'nuevo');
assert('full PUT: urgent_alert_enabled updated',     afterFull.urgent_alert_enabled, 0);

// Explicit null in body (clear the fields)
console.log('\n── Explicit null in body — must clear fields ──');
const nullBody = {
  name: 'Nombre null',
  urgent_keywords: null,
  urgent_alert_enabled: 0,
  business_hours: null,
  after_hours_instructions: null,
  urgent_phone: null,
};
const nullPayload = simulatePut(nullBody, afterFull);
upsertBusiness({ ...nullPayload });

const afterNull = getBusinessById(bizId);
assert('null PUT: business_hours cleared',          afterNull.business_hours, null);
assert('null PUT: after_hours_instructions cleared', afterNull.after_hours_instructions, null);
assert('null PUT: urgent_phone cleared',             afterNull.urgent_phone, null);

// ── Cleanup ───────────────────────────────────────────────────────────────
// Delete test biz via raw DB (no public fn for this)
const Database = require('better-sqlite3');
const dbPath = path.join(__dirname, '..', process.env.DB_PATH || 'data/app.db');
if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(bizId);
  db.close();
  console.log(`\nTest biz deleted: id=${bizId}`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
