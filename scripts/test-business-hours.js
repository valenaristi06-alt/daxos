#!/usr/bin/env node
'use strict';
// Tests for business hours logic (isOpenNow) and prompt injection.
// Run: node scripts/test-business-hours.js
// Run with real model: node scripts/test-business-hours.js --real

// ── Inline helpers (same logic as server.js) ─────────────────────────────

function _HHMMtoMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function _minToHHMM(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function _resolveBusinessHours(business) {
  if (business.business_hours) {
    try {
      const raw = typeof business.business_hours === 'string'
        ? JSON.parse(business.business_hours)
        : business.business_hours;
      const result = {};
      for (const [dayStr, slots] of Object.entries(raw)) {
        const day = parseInt(dayStr, 10);
        if (day < 0 || day > 6) continue;
        result[day] = slots.map(([s, e]) => [_HHMMtoMin(s), _HHMMtoMin(e)]);
      }
      return result;
    } catch {
      return null;
    }
  }
  if (business.business_hours_start && business.business_hours_end) {
    const s = _HHMMtoMin(business.business_hours_start);
    const e = _HHMMtoMin(business.business_hours_end);
    const result = {};
    for (let d = 0; d <= 6; d++) result[d] = [[s, e]];
    return result;
  }
  return null;
}

function isOpenNow(business, date) {
  const mvd = date || new Date();
  const dayIdx = mvd.getUTCDay();
  const nowMin = mvd.getUTCHours() * 60 + mvd.getUTCMinutes();

  const parsed = _resolveBusinessHours(business);
  if (!parsed) return { open: null, closesAt: null, nextOpen: null };

  for (const [s, e] of (parsed[dayIdx] || [])) {
    if (e > s && nowMin >= s && nowMin < e) {
      return { open: true, closesAt: _minToHHMM(e), nextOpen: null };
    }
    if (e <= s && nowMin >= s) {
      return { open: true, closesAt: _minToHHMM(e), nextOpen: null };
    }
  }
  const prevDay = (dayIdx + 6) % 7;
  for (const [s, e] of (parsed[prevDay] || [])) {
    if (e <= s && nowMin < e) {
      return { open: true, closesAt: _minToHHMM(e), nextOpen: null };
    }
  }

  const laterToday = (parsed[dayIdx] || [])
    .filter(([s, e]) => e > s && s > nowMin)
    .sort((a, b) => a[0] - b[0]);
  if (laterToday.length > 0) {
    return { open: false, closesAt: null, nextOpen: { day: dayIdx, time: _minToHHMM(laterToday[0][0]), today: true } };
  }
  for (let offset = 1; offset <= 6; offset++) {
    const d = (dayIdx + offset) % 7;
    const slots = parsed[d] || [];
    if (slots.length > 0) {
      const earliest = slots.reduce((a, b) => a[0] <= b[0] ? a : b);
      return { open: false, closesAt: null, nextOpen: { day: d, time: _minToHHMM(earliest[0]), today: false } };
    }
  }
  return { open: false, closesAt: null, nextOpen: null };
}

// ── Test helpers ──────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ ${desc}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// Build a UTC Date where getUTCDay()===day, getUTCHours()===hour, getUTCMinutes()===min
// Base anchor: 2026-10-25 = Sunday (UTC day 0)
function mvdAt(day, hour, min) {
  // 2026-10-25 00:00 UTC is Sunday
  const base = new Date('2026-10-25T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + day); // day 0=Sun,1=Mon,...6=Sat
  base.setUTCHours(hour, min, 0, 0);
  return base;
}

// ── Basic open/closed ─────────────────────────────────────────────────────

const monSat9to19 = {
  business_hours: JSON.stringify({
    1: [['09:00','19:00']],
    2: [['09:00','19:00']],
    3: [['09:00','19:00']],
    4: [['09:00','19:00']],
    5: [['09:00','19:00']],
    6: [['09:00','19:00']],
  }),
};

console.log('\n── Abierto / cerrado básico ──');
assert('lunes 11:00 — ABIERTO', isOpenNow(monSat9to19, mvdAt(1, 11, 0)).open, true);
assert('lunes 11:00 — cierra a 19:00', isOpenNow(monSat9to19, mvdAt(1, 11, 0)).closesAt, '19:00');
assert('lunes 19:00 — CERRADO (borde exacto cierre)', isOpenNow(monSat9to19, mvdAt(1, 19, 0)).open, false);
assert('lunes 09:00 — ABIERTO (borde exacto apertura)', isOpenNow(monSat9to19, mvdAt(1, 9, 0)).open, true);
assert('lunes 08:59 — CERRADO', isOpenNow(monSat9to19, mvdAt(1, 8, 59)).open, false);
assert('lunes 18:59 — ABIERTO', isOpenNow(monSat9to19, mvdAt(1, 18, 59)).open, true);
assert('domingo — CERRADO (sin slot)', isOpenNow(monSat9to19, mvdAt(0, 12, 0)).open, false);
assert('sábado 10:00 — ABIERTO', isOpenNow(monSat9to19, mvdAt(6, 10, 0)).open, true);

// ── nextOpen ──────────────────────────────────────────────────────────────

console.log('\n── nextOpen ──');
{
  const r = isOpenNow(monSat9to19, mvdAt(1, 20, 0)); // lunes cerrado
  assert('nextOpen today=false (mañana)', r.nextOpen?.today, false);
  assert('nextOpen day=martes (2)', r.nextOpen?.day, 2);
  assert('nextOpen time=09:00', r.nextOpen?.time, '09:00');
}
{
  const r = isOpenNow(monSat9to19, mvdAt(0, 12, 0)); // domingo cerrado
  assert('domingo nextOpen = lunes(1)', r.nextOpen?.day, 1);
  assert('domingo nextOpen time=09:00', r.nextOpen?.time, '09:00');
}

// ── Split slots ───────────────────────────────────────────────────────────

const splitSlots = {
  business_hours: JSON.stringify({
    2: [['09:00','13:00'],['16:00','19:00']],
  }),
};

console.log('\n── Turnos dobles (split slots) ──');
assert('martes 11:00 — ABIERTO slot1', isOpenNow(splitSlots, mvdAt(2, 11, 0)).open, true);
assert('martes 11:00 — cierra 13:00', isOpenNow(splitSlots, mvdAt(2, 11, 0)).closesAt, '13:00');
assert('martes 13:00 — CERRADO entre slots', isOpenNow(splitSlots, mvdAt(2, 13, 0)).open, false);
assert('martes 13:00 — nextOpen today=true', isOpenNow(splitSlots, mvdAt(2, 13, 0)).nextOpen?.today, true);
assert('martes 13:00 — nextOpen time=16:00', isOpenNow(splitSlots, mvdAt(2, 13, 0)).nextOpen?.time, '16:00');
assert('martes 17:00 — ABIERTO slot2', isOpenNow(splitSlots, mvdAt(2, 17, 0)).open, true);
assert('martes 17:00 — cierra 19:00', isOpenNow(splitSlots, mvdAt(2, 17, 0)).closesAt, '19:00');

// ── Midnight-crossing ─────────────────────────────────────────────────────

const midnight = {
  business_hours: JSON.stringify({
    2: [['22:00','02:00']], // martes 22:00 → miércoles 02:00
  }),
};

console.log('\n── Slot que cruza medianoche ──');
assert('martes 22:30 — ABIERTO (primera mitad)', isOpenNow(midnight, mvdAt(2, 22, 30)).open, true);
assert('martes 23:59 — ABIERTO', isOpenNow(midnight, mvdAt(2, 23, 59)).open, true);
assert('miércoles 01:30 — ABIERTO (segunda mitad, prevDay)', isOpenNow(midnight, mvdAt(3, 1, 30)).open, true);
assert('miércoles 02:00 — CERRADO (borde exacto)', isOpenNow(midnight, mvdAt(3, 2, 0)).open, false);
assert('miércoles 01:59 — ABIERTO', isOpenNow(midnight, mvdAt(3, 1, 59)).open, true);
assert('martes 21:59 — CERRADO (antes de abrir)', isOpenNow(midnight, mvdAt(2, 21, 59)).open, false);
assert('martes 10:00 — CERRADO (fuera de slot)', isOpenNow(midnight, mvdAt(2, 10, 0)).open, false);

// ── Sin horario configurado ───────────────────────────────────────────────

console.log('\n── Sin horarios configurados ──');
assert('open=null cuando no hay config', isOpenNow({}, mvdAt(1, 12, 0)).open, null);
assert('open=null cuando business_hours vacío', isOpenNow({ business_hours: null }, mvdAt(1, 12, 0)).open, null);

// ── Fallback a business_hours_start/end ───────────────────────────────────

console.log('\n── Fallback a business_hours_start/end ──');
const fallback = { business_hours_start: '09:00', business_hours_end: '18:00' };
assert('fallback: lunes 10:00 — ABIERTO', isOpenNow(fallback, mvdAt(1, 10, 0)).open, true);
assert('fallback: domingo 10:00 — ABIERTO (todos los días)', isOpenNow(fallback, mvdAt(0, 10, 0)).open, true);
assert('fallback: lunes 19:00 — CERRADO', isOpenNow(fallback, mvdAt(1, 19, 0)).open, false);
assert('fallback: business_hours tiene precedencia', isOpenNow({ ...fallback, ...monSat9to19 }, mvdAt(0, 12, 0)).open, false);

// ── isWithinBusinessHours ─────────────────────────────────────────────────

console.log('\n── isWithinBusinessHours (null=true, false=false, true=true) ──');
function isWithinBusinessHours(business, date) {
  return isOpenNow(business, date).open !== false;
}
assert('sin config → true (default abierto)', isWithinBusinessHours({}, mvdAt(1, 12, 0)), true);
assert('abierto → true', isWithinBusinessHours(monSat9to19, mvdAt(1, 12, 0)), true);
assert('cerrado → false', isWithinBusinessHours(monSat9to19, mvdAt(0, 12, 0)), false);

// ── runtimeCtx: afterHoursInstructions solo cuando cerrado ───────────────

console.log('\n── runtimeCtx injection rules ──');
function buildRuntimeCtx(business, date) {
  const hoursResult = isOpenNow(business, date);
  return {
    isOpenResult: hoursResult,
    afterHoursInstructions: hoursResult.open === false ? (business.after_hours_instructions || null) : null,
    urgentPhone: hoursResult.open === false ? (business.urgent_phone || null) : null,
  };
}
const bizWithHours = {
  ...monSat9to19,
  after_hours_instructions: 'Mandá un mail a info@vet.com',
  urgent_phone: '099 000 000',
};
const ctxOpen   = buildRuntimeCtx(bizWithHours, mvdAt(1, 12, 0)); // lunes abierto
const ctxClosed = buildRuntimeCtx(bizWithHours, mvdAt(0, 12, 0)); // domingo cerrado

assert('abierto: afterHoursInstructions=null', ctxOpen.afterHoursInstructions, null);
assert('abierto: urgentPhone=null', ctxOpen.urgentPhone, null);
assert('cerrado: afterHoursInstructions present', ctxClosed.afterHoursInstructions, 'Mandá un mail a info@vet.com');
assert('cerrado: urgentPhone present', ctxClosed.urgentPhone, '099 000 000');
assert('sin config: isOpenResult.open=null', buildRuntimeCtx({}, mvdAt(1, 12, 0)).isOpenResult.open, null);

// ── resumeHumanTimedOut logic ─────────────────────────────────────────────

console.log('\n── resumeHumanTimedOut: outsideHours via isOpenNow ──');
function shouldResume(conv, nowSec) {
  const timeout = typeof conv.human_resume_timeout === 'number' ? conv.human_resume_timeout : 7200;
  const timeoutExpired = nowSec - conv.human_paused_at >= timeout;
  const hoursResult = isOpenNow({
    business_hours: conv.business_hours,
    business_hours_start: conv.business_hours_start,
    business_hours_end: conv.business_hours_end,
  });
  const outsideHours = hoursResult.open === false;
  return timeoutExpired || outsideHours;
}
const nowSec = Math.floor(Date.now() / 1000);
const pausedRecently = nowSec - 60;
const pausedLongAgo  = nowSec - 7300;

assert('timeout expirado → resume', shouldResume({ human_paused_at: pausedLongAgo, business_hours: null }, nowSec), true);
assert('timeout no expirado, sin horarios → no resume', shouldResume({ human_paused_at: pausedRecently, business_hours: null }, nowSec), false);
{
  const bh = JSON.stringify({ 1:[ ['09:00','19:00'] ], 2:[['09:00','19:00']], 3:[['09:00','19:00']], 4:[['09:00','19:00']], 5:[['09:00','19:00']], 6:[['09:00','19:00']] });
  // Sunday at noon: closed
  const sundayNoon = mvdAt(0, 12, 0);
  const convSunday = { human_paused_at: pausedRecently, business_hours: bh };
  // We can't use a custom date in shouldResume without patching isOpenNow here
  // Instead assert the logic directly:
  assert('domingo cerrado → outsideHours=true', isOpenNow({ business_hours: bh }, sundayNoon).open === false, true);
}

// ── Resultado final ───────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// ── Real model test ───────────────────────────────────────────────────────

if (!process.argv.includes('--real')) {
  console.log('\n(Omitiendo test de modelo real. Usá --real para ejecutarlo.)');
  process.exit(0);
}

console.log('\n── Real model test ──');

const path = require('path');
const fs = require('fs');

// Load env
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const { buildSystemPrompt } = require('../src/claude.js');

const vetBusiness = {
  id: 9999,
  name: 'Veterinaria Test',
  language: null,
  business_context: 'Somos una veterinaria en Montevideo. Atendemos perros y gatos.',
  pricing_info: null,
  website_url: null,
  sales_examples: null,
  survey_answers: null,
  response_mode: 'texto',
  booking_enabled: false,
  urgent_keywords: null,
  urgent_alert_enabled: 0,
  business_hours: JSON.stringify({
    1: [['09:00','19:00']],
    2: [['09:00','19:00']],
    3: [['09:00','19:00']],
    4: [['09:00','19:00']],
    5: [['09:00','19:00']],
    6: [['09:00','19:00']],
  }),
  after_hours_instructions: 'Para consultas urgentes mandá un mail a urgencias@vet.com.',
  urgent_phone: '099 111 222',
};

// Scenario A: martes 23:40 → cerrado
const dateA = mvdAt(2, 23, 40); // martes 23:40 (UTC)
const hoursResultA = isOpenNow(vetBusiness, dateA);
const runtimeCtxA = {
  now: dateA,
  needsHuman: false,
  images: [],
  documents: [],
  isOpenResult: hoursResultA,
  afterHoursInstructions: hoursResultA.open === false ? vetBusiness.after_hours_instructions : null,
  urgentPhone: hoursResultA.open === false ? vetBusiness.urgent_phone : null,
};

// Scenario B: martes 11:00 → abierto
const dateB = mvdAt(2, 11, 0);
const hoursResultB = isOpenNow(vetBusiness, dateB);
const runtimeCtxB = {
  now: dateB,
  needsHuman: false,
  images: [],
  documents: [],
  isOpenResult: hoursResultB,
  afterHoursInstructions: null,
  urgentPhone: null,
};

const { staticText: stA, dynamicText: dtA } = buildSystemPrompt(vetBusiness, null, null, runtimeCtxA);
const { staticText: stB, dynamicText: dtB } = buildSystemPrompt(vetBusiness, null, null, runtimeCtxB);

console.log('\n[Scenario A — martes 23:40, CERRADO]');
console.log('hoursResult:', hoursResultA);
console.log('dynamicText snippet:\n', dtA.slice(0, 600));

console.log('\n[Scenario B — martes 11:00, ABIERTO]');
console.log('hoursResult:', hoursResultB);
console.log('dynamicText snippet:\n', dtB.slice(0, 200));

// Verify AHORA appears in dynamic text
const aOk  = dtA.includes('AHORA: CERRADO') && dtA.includes('099 111 222');
const bOk  = dtB.includes('AHORA: ABIERTO') && !dtB.includes('CERRADO');

console.log('\nA: CERRADO + urgentPhone in dynamicText:', aOk ? '✓' : '✗ FAILED');
console.log('B: ABIERTO in dynamicText, no CERRADO:', bOk ? '✓' : '✗ FAILED');

if (!aOk || !bOk) process.exit(1);
console.log('\nReal model prompt test passed.');
