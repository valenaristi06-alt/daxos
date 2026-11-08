'use strict';
/**
 * Unit tests for src/agenda.js:
 *   getMvdDow, mvdToUtcIso, addDays, utcIsoToMvdHHMM, formatDayLabel,
 *   getFreeSlotsForDate (closed day, all taken, slot at closing boundary,
 *   90min service in 60min gap, past slots excluded),
 *   getFreeSlots (7-day window, unique codes across days),
 *   isSlotsMapFresh / TTL
 *
 * Run: node scripts/test-agenda-slots.js
 */

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const DB_DIR = '/tmp/test-agenda-slots';
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;

const db     = require('../src/db');
const agenda = require('../src/agenda');

const {
  getMvdDow, mvdToUtcIso, addDays, utcIsoToMvdHHMM, formatDayLabel,
  getBizHoursForDow, getFreeSlotsForDate, getFreeSlots,
  isSlotsMapFresh, DOW_LABELS, SLOT_TTL_MS,
} = agenda;

// upsertBusiness with whatsapp_number path omits business_hours — use id UPDATE path
function seedBizWithHours(suffix, hours) {
  const b = db.upsertBusiness({ whatsapp_number: `+59890000${suffix}`, name: `Test${suffix}` });
  return db.upsertBusiness({ id: b.id, name: `Test${suffix}`, business_hours: JSON.stringify(hours) });
}

let passed = 0;
let failed = 0;

function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

// ── getMvdDow ─────────────────────────────────────────────────────────────────

console.log('\n--- getMvdDow ---');

{
  // 2025-11-17 = Monday
  ok('2025-11-17 is Monday (1)',  getMvdDow('2025-11-17') === 1);
  ok('2025-11-16 is Sunday (0)',  getMvdDow('2025-11-16') === 0);
  ok('2025-11-22 is Saturday (6)', getMvdDow('2025-11-22') === 6);
  ok('2025-11-21 is Friday (5)',  getMvdDow('2025-11-21') === 5);
}

// ── mvdToUtcIso ───────────────────────────────────────────────────────────────

console.log('\n--- mvdToUtcIso ---');

{
  // MVD is UTC-3; 09:00 local = 12:00 UTC
  const utc = mvdToUtcIso('2025-11-17', '09:00');
  ok('09:00 MVD → 12:00 UTC', utc === '2025-11-17T12:00:00.000Z', utc);

  // 00:00 MVD = 03:00 UTC
  const midnight = mvdToUtcIso('2025-11-17', '00:00');
  ok('00:00 MVD → 03:00 UTC', midnight === '2025-11-17T03:00:00.000Z', midnight);

  // 21:00 MVD = next day 00:00 UTC
  const late = mvdToUtcIso('2025-11-17', '21:00');
  ok('21:00 MVD → 2025-11-18T00:00:00Z', late === '2025-11-18T00:00:00.000Z', late);
}

// ── utcIsoToMvdHHMM ───────────────────────────────────────────────────────────

console.log('\n--- utcIsoToMvdHHMM ---');

{
  ok('12:00 UTC → 09:00 MVD', utcIsoToMvdHHMM('2025-11-17T12:00:00.000Z') === '09:00');
  ok('03:00 UTC → 00:00 MVD', utcIsoToMvdHHMM('2025-11-17T03:00:00.000Z') === '00:00');
  ok('00:00 UTC → 21:00 MVD previous day', utcIsoToMvdHHMM('2025-11-18T00:00:00.000Z') === '21:00');
}

// ── addDays ───────────────────────────────────────────────────────────────────

console.log('\n--- addDays ---');

{
  ok('2025-11-17 + 1 = 2025-11-18', addDays('2025-11-17', 1) === '2025-11-18');
  ok('2025-11-30 + 1 = 2025-12-01', addDays('2025-11-30', 1) === '2025-12-01');
  ok('2025-12-31 + 1 = 2026-01-01', addDays('2025-12-31', 1) === '2026-01-01');
  ok('2025-11-17 + 6 = 2025-11-23', addDays('2025-11-17', 6) === '2025-11-23');
}

// ── formatDayLabel ────────────────────────────────────────────────────────────

console.log('\n--- formatDayLabel ---');

{
  ok('2025-11-17 Mon → "Lun 17/11"', formatDayLabel('2025-11-17') === 'Lun 17/11');
  ok('2025-11-16 Sun → "Dom 16/11"', formatDayLabel('2025-11-16') === 'Dom 16/11');
  ok('2025-11-22 Sat → "Sáb 22/11"', formatDayLabel('2025-11-22') === 'Sáb 22/11');
}

// ── getBizHoursForDow ─────────────────────────────────────────────────────────

console.log('\n--- getBizHoursForDow ---');

{
  const biz = { business_hours: JSON.stringify({ '1': [['09:00','18:00']], '6': [['09:00','13:00']] }) };
  ok('Monday returns interval',   getBizHoursForDow(biz, 1).length === 1);
  ok('Saturday returns interval', getBizHoursForDow(biz, 6).length === 1);
  ok('Sunday returns empty',      getBizHoursForDow(biz, 0).length === 0);
  ok('Wednesday returns empty',   getBizHoursForDow(biz, 3).length === 0);

  // Null business_hours
  const bizNull = { business_hours: null };
  ok('null business_hours returns empty', getBizHoursForDow(bizNull, 1).length === 0);
}

// ── getFreeSlotsForDate ───────────────────────────────────────────────────────

console.log('\n--- getFreeSlotsForDate: closed day ---');

{
  const biz = seedBizWithHours('001', { '1': [['09:00', '18:00']] });

  // 2025-11-16 is a Sunday (dow=0), closed
  const nowMs = new Date('2025-11-16T00:00:00.000Z').getTime();
  const slots = getFreeSlotsForDate(biz, '2025-11-16', 30, nowMs);
  ok('closed day returns 0 slots', slots.length === 0);
}

console.log('\n--- getFreeSlotsForDate: 09:00-18:00, 30min, all free ---');

{
  const biz = seedBizWithHours('002', { '1': [['09:00', '18:00']] });

  // Use a past "now" far before 2025-11-17 so all slots pass the 30min advance check
  const nowMs = new Date('2025-11-17T00:00:00.000Z').getTime();
  const slots = getFreeSlotsForDate(biz, '2025-11-17', 30, nowMs);
  // 09:00-18:00 → 18 slots of 30min
  ok('09:00-18:00, 30min → 18 slots', slots.length === 18, `got ${slots.length}`);
  ok('first slot time is 09:00', slots[0].time === '09:00');
  ok('last slot time is 17:30', slots[slots.length - 1].time === '17:30');
  ok('codes start at T1', slots[0].code === 'T1');
  ok('each slot has startsAt and endsAt', slots.every(s => s.startsAt && s.endsAt));
  ok('slot duration is 30min',
    new Date(slots[0].endsAt).getTime() - new Date(slots[0].startsAt).getTime() === 30 * 60_000);
}

console.log('\n--- getFreeSlotsForDate: slot at closing boundary excluded ---');

{
  // 09:00-09:30 window → exactly 1 slot (09:00-09:30 ends at close, allowed)
  // 09:00-09:20 window with 30min service → no slots fit
  const biz = seedBizWithHours('003', { '1': [['09:00', '09:20']] });
  const nowMs = new Date('2025-11-17T00:00:00.000Z').getTime();
  const slots = getFreeSlotsForDate(biz, '2025-11-17', 30, nowMs);
  ok('30min service in 20min window → 0 slots', slots.length === 0);

  // Exactly 30min window → exactly 1 slot
  const biz2 = seedBizWithHours('004', { '1': [['09:00', '09:30']] });
  const slots2 = getFreeSlotsForDate(biz2, '2025-11-17', 30, nowMs);
  ok('30min service in exactly 30min window → 1 slot', slots2.length === 1);
}

console.log('\n--- getFreeSlotsForDate: 90min service in 60min gap ---');

{
  const biz = seedBizWithHours('005', { '1': [['09:00', '10:00']] });
  const nowMs = new Date('2025-11-17T00:00:00.000Z').getTime();
  const slots = getFreeSlotsForDate(biz, '2025-11-17', 90, nowMs);
  ok('90min service in 60min window → 0 slots', slots.length === 0);
}

console.log('\n--- getFreeSlotsForDate: all taken ---');

{
  const biz = seedBizWithHours('006', { '1': [['09:00', '10:00']] });

  // Block 09:00-10:00 entirely
  db.createAppointment({
    businessId: biz.id, customerPhone: '+598222',
    startsAt: '2025-11-17T12:00:00.000Z',  // 09:00 MVD
    endsAt:   '2025-11-17T13:00:00.000Z',  // 10:00 MVD
    clientName: 'Blocker',
  });

  const nowMs = new Date('2025-11-17T00:00:00.000Z').getTime();
  const slots = getFreeSlotsForDate(biz, '2025-11-17', 30, nowMs);
  ok('all slots taken → 0 free slots', slots.length === 0);
}

console.log('\n--- getFreeSlotsForDate: past slots excluded ---');

{
  const biz = seedBizWithHours('007', { '1': [['09:00', '18:00']] });

  // "now" is 14:00 MVD = 17:00 UTC; slots before 14:30 (30min advance) are excluded
  const nowMs = new Date('2025-11-17T17:00:00.000Z').getTime();
  const slots = getFreeSlotsForDate(biz, '2025-11-17', 30, nowMs);

  // 09:00-14:00 = 10 past slots excluded; 14:30-17:30 = 7 slots
  ok('past slots excluded (now=14:00, advance=30min, first slot=14:30)',
    slots.length === 7, `got ${slots.length}`);
  ok('first slot is 14:30', slots[0]?.time === '14:30', slots[0]?.time);
}

// ── getFreeSlots: 7-day window + unique codes ─────────────────────────────────

console.log('\n--- getFreeSlots: 7-day window, unique codes ---');

{
  const biz = seedBizWithHours('010', {
    '1': [['09:00','10:00']],
    '2': [['09:00','10:00']],
    '3': [['09:00','10:00']],
    '4': [['09:00','10:00']],
    '5': [['09:00','10:00']],
  });

  // Patch getMvdDateStr to return a known Monday: 2025-11-17
  const origGetMvdDateStr = agenda.getMvdDateStr;
  // We can't easily patch module exports; instead we use a far-past nowMs
  // so all 7 days' slots are available, and verify the result structure.

  const nowMs = new Date('2025-11-17T00:00:00.000Z').getTime();
  // Temporarily monkey-patch Date.now
  const origNow = Date.now;
  Date.now = () => nowMs;

  // Re-require won't work; use getFreeSlotsForDate for each day manually to test codes
  // For getFreeSlots, call it with the biz and check returned structure
  const result = getFreeSlots(biz, 30);
  Date.now = origNow;

  ok('slotsByDay has 7 entries', result.slotsByDay.length === 7);
  ok('slotsMap is an object', typeof result.slotsMap === 'object');
  ok('generatedAt is set', typeof result.generatedAt === 'number');

  // All codes in slotsMap are unique
  const codes = Object.keys(result.slotsMap);
  ok('all codes are unique', codes.length === new Set(codes).size);

  // Codes are contiguous T1, T2, ..., TN
  const nums = codes.map(c => parseInt(c.slice(1))).sort((a, b) => a - b);
  ok('codes start at T1', nums[0] === 1);
  ok('codes are contiguous', nums.every((n, i) => n === i + 1));

  // Each slotsMap entry has startsAt and endsAt
  ok('slotsMap entries have startsAt', codes.every(c => result.slotsMap[c].startsAt));
  ok('slotsMap entries have endsAt',   codes.every(c => result.slotsMap[c].endsAt));
}

// ── isSlotsMapFresh ───────────────────────────────────────────────────────────

console.log('\n--- isSlotsMapFresh / TTL ---');

{
  const now = Date.now();
  ok('fresh (just generated)',       isSlotsMapFresh(now));
  ok('fresh (5 min ago)',            isSlotsMapFresh(now - 5 * 60_000));
  ok('stale (10 min exactly)',       !isSlotsMapFresh(now - SLOT_TTL_MS));
  ok('stale (11 min ago)',           !isSlotsMapFresh(now - 11 * 60_000));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\ntests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
