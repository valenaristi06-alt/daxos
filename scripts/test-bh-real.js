#!/usr/bin/env node
'use strict';
// Prueba de integración completa para horario abierto/cerrado.
// Run: node scripts/test-bh-real.js

const path = require('path');
const fs   = require('fs');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ── helpers inline (mirror de server.js) ────────────────────────────────
function _HHMMtoMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function _minToHHMM(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
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
    } catch { return null; }
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
    if (e > s && nowMin >= s && nowMin < e) return { open: true, closesAt: _minToHHMM(e), nextOpen: null };
    if (e <= s && nowMin >= s) return { open: true, closesAt: _minToHHMM(e), nextOpen: null };
  }
  const prevDay = (dayIdx + 6) % 7;
  for (const [s, e] of (parsed[prevDay] || [])) {
    if (e <= s && nowMin < e) return { open: true, closesAt: _minToHHMM(e), nextOpen: null };
  }
  const laterToday = (parsed[dayIdx] || []).filter(([s, e]) => e > s && s > nowMin).sort((a,b) => a[0]-b[0]);
  if (laterToday.length > 0) return { open: false, closesAt: null, nextOpen: { day: dayIdx, time: _minToHHMM(laterToday[0][0]), today: true } };
  for (let offset = 1; offset <= 6; offset++) {
    const d = (dayIdx + offset) % 7;
    const slots = parsed[d] || [];
    if (slots.length > 0) {
      const earliest = slots.reduce((a,b) => a[0] <= b[0] ? a : b);
      return { open: false, closesAt: null, nextOpen: { day: d, time: _minToHHMM(earliest[0]), today: false } };
    }
  }
  return { open: false, closesAt: null, nextOpen: null };
}

// 2026-10-25 00:00 UTC = domingo (0). Anchor para simular días.
function mvdAt(day, hour, min) {
  const base = new Date('2026-10-25T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + day);
  base.setUTCHours(hour, min, 0, 0);
  return base;
}

const { buildSystemPrompt, generateReply } = require('../src/claude.js');

const vetBusiness = {
  id: 9999,
  name: 'Veterinaria Los Pinos',
  language: null,
  business_context: 'Somos una veterinaria en Montevideo. Atendemos perros y gatos. Hacemos consultas, cirugías y vacunación.',
  pricing_info: null,
  website_url: null,
  sales_examples: null,
  survey_answers: null,
  style_profile: null,
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
  after_hours_instructions: 'Fuera de horario no hay atención inmediata. Si es una urgencia grave, llevá el animal a Clínica Veterinaria de Urgencias (Av. Italia 3456).',
  urgent_phone: '099 555 123',
  business_hours_start: null,
  business_hours_end: null,
};

// Historia mínima: solo el mensaje del cliente
const historia = [];
const mensajeCliente = 'mi perro sangra';

async function runScenario(label, date) {
  const hoursResult = isOpenNow(vetBusiness, date);
  const runtimeCtx = {
    now: date,
    needsHuman: false,
    images: [],
    documents: [],
    isOpenResult: hoursResult,
    afterHoursInstructions: hoursResult.open === false ? (vetBusiness.after_hours_instructions || null) : null,
    urgentPhone: hoursResult.open === false ? (vetBusiness.urgent_phone || null) : null,
  };

  const { dynamicText } = buildSystemPrompt(vetBusiness, null, null, runtimeCtx);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ESCENARIO: ${label}`);
  console.log(`hoursResult: open=${hoursResult.open}, closesAt=${hoursResult.closesAt}, nextOpen=${JSON.stringify(hoursResult.nextOpen)}`);
  console.log('\n--- dynamicText inyectado ---');
  console.log(dynamicText);
  console.log('--- fin dynamicText ---\n');

  const reply = await generateReply(
    vetBusiness,
    historia,
    mensajeCliente,
    null,            // label
    null,            // bookingContext
    runtimeCtx,
    null,            // conversationId
    null,            // imageData
  );

  console.log(`--- RESPUESTA DEL BOT ---`);
  console.log(reply);
  console.log(`--- fin respuesta ---`);
  return reply;
}

// ── Verificación isWithinBusinessHours backward compat ───────────────────

function isWithinBusinessHours(business) {
  return isOpenNow(business).open !== false;
}

console.log('\n── Backward compat: isWithinBusinessHours ──');

// 1. Sin horarios: antes devolvía true, ahora debe seguir siendo true
const sinHorarios = {};
const resultSinHorarios = isWithinBusinessHours(sinHorarios);
console.log(`  sin horarios → ${resultSinHorarios} (esperado: true) ${resultSinHorarios === true ? '✓' : '✗ FALLA'}`);

// 2. Con start/end viejos, dentro de horario
const conStartEnd = { business_hours_start: '09:00', business_hours_end: '18:00' };
// Lunes 12:00 → dentro de horario
const dentroOld = isOpenNow(conStartEnd, mvdAt(1, 12, 0)).open !== false;
console.log(`  start/end viejos, lunes 12:00 → ${dentroOld} (esperado: true) ${dentroOld === true ? '✓' : '✗ FALLA'}`);

// 3. Con start/end viejos, fuera de horario
const fueraOld = isOpenNow(conStartEnd, mvdAt(1, 20, 0)).open !== false;
console.log(`  start/end viejos, lunes 20:00 → ${fueraOld} (esperado: false) ${fueraOld === false ? '✓' : '✗ FALLA'}`);

// 4. Auto-resume: outsideHours con start/end viejos
function outsideHoursOldFields(convStartEnd, convStartEndEnd, date) {
  // OLD logic
  if (!convStartEnd || !convStartEndEnd) return false;
  const mvd = date;
  const nowMin = mvd.getUTCHours() * 60 + mvd.getUTCMinutes();
  const [sh, sm] = convStartEnd.split(':').map(Number);
  const [eh, em] = convStartEndEnd.split(':').map(Number);
  return nowMin < sh * 60 + sm || nowMin >= eh * 60 + em;
}
function outsideHoursNewLogic(conv, date) {
  const r = isOpenNow({
    business_hours: conv.business_hours,
    business_hours_start: conv.business_hours_start,
    business_hours_end: conv.business_hours_end,
  }, date);
  return r.open === false;
}
console.log('\n── Auto-resume: old vs new logic ──');
const cases = [
  { label: 'start/end viejos, lunes 12:00 (dentro)',  start: '09:00', end: '18:00', date: mvdAt(1, 12, 0), expectedOutside: false },
  { label: 'start/end viejos, lunes 20:00 (fuera)',   start: '09:00', end: '18:00', date: mvdAt(1, 20, 0), expectedOutside: true  },
  { label: 'sin start/end, lunes 12:00 (sin config)', start: null,    end: null,    date: mvdAt(1, 12, 0), expectedOutside: false },
];
for (const c of cases) {
  const oldResult = outsideHoursOldFields(c.start, c.end, c.date);
  const conv = { business_hours: null, business_hours_start: c.start, business_hours_end: c.end };
  const newResult = outsideHoursNewLogic(conv, c.date);
  const match = oldResult === newResult;
  console.log(`  ${c.label}`);
  console.log(`    old=${oldResult} new=${newResult} match=${match ? '✓' : '✗ DIVERGENCIA'}`);
}

// ── Escenarios de modelo real ─────────────────────────────────────────────

(async () => {
  const dateA = mvdAt(2, 23, 40); // martes 23:40 → CERRADO
  const dateB = mvdAt(2, 11, 0);  // martes 11:00 → ABIERTO

  const replyA = await runScenario('martes 23:40 — CERRADO', dateA);
  const replyB = await runScenario('martes 11:00 — ABIERTO', dateB);

  console.log('\n── Verificaciones ──');
  const aNoVeniYa = !/vení ya|ven[ií] ahora|te atiendo ahora|atendemos ahora/i.test(replyA);
  console.log(`  23:40: no dice "vení ya" ni equivalente: ${aNoVeniYa ? '✓' : '✗ FALLA'}`);
  console.log(`  11:00: respuesta generada (longitud ${replyB.length}): ${replyB.length > 20 ? '✓' : '✗ FALLA'}`);
})().catch(err => { console.error(err); process.exit(1); });
