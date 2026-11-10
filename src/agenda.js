'use strict';

const { getConfirmedAppointmentsInRange } = require('./db');

const TZ            = 'America/Montevideo';
const SLOT_TTL_MS   = 10 * 60 * 1000;
const MIN_ADVANCE_MS = 30 * 60 * 1000;

const DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// ── Timezone utilities ─────────────────────────────────────────────────────────

function getMvdDateStr() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
}

// UTC ISO → MVD "HH:MM"
function utcIsoToMvdHHMM(utcIso) {
  const parts = new Intl.DateTimeFormat('default', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(utcIso));
  const h = (parts.find(p => p.type === 'hour')?.value   ?? '00').padStart(2, '0');
  const m = (parts.find(p => p.type === 'minute')?.value ?? '00').padStart(2, '0');
  return `${h}:${m}`;
}

// MVD date + time "HH:MM" → UTC ISO  (Uruguay UTC-3, no DST since 2015)
function mvdToUtcIso(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00-03:00`).toISOString();
}

// Day of week (0=Sun) for a MVD date string
function getMvdDow(dateStr) {
  return new Date(`${dateStr}T12:00:00-03:00`).getUTCDay();
}

// Add N days to MVD date string
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d);
}

// "Lun 17/11" label for a MVD date string
function formatDayLabel(dateStr) {
  const dow    = getMvdDow(dateStr);
  const [, mm, dd] = dateStr.split('-');
  return `${DOW_LABELS[dow]} ${dd}/${mm}`;
}

// Parse business_hours for a day-of-week → [[startHHMM, endHHMM], ...]
function getBizHoursForDow(business, dow) {
  if (!business.business_hours) return [];
  try {
    const bh = typeof business.business_hours === 'string'
      ? JSON.parse(business.business_hours)
      : business.business_hours;
    return bh[String(dow)] || [];
  } catch { return []; }
}

// ── Slot generation ────────────────────────────────────────────────────────────

// Free slots for a single MVD date → [{ code, time, startsAt, endsAt }, ...]
// codeStart: first numeric code (T1, T2...)
function getFreeSlotsForDate(business, dateStr, durationMin, nowMs, codeStart = 1) {
  const dow       = getMvdDow(dateStr);
  const intervals = getBizHoursForDow(business, dow);
  if (intervals.length === 0) return [];

  const dayStartUtc = mvdToUtcIso(dateStr, '00:00');
  const dayEndUtc   = mvdToUtcIso(addDays(dateStr, 1), '00:00');
  const existing    = getConfirmedAppointmentsInRange(business.id, dayStartUtc, dayEndUtc);
  const minStartMs  = nowMs + MIN_ADVANCE_MS;

  const slots  = [];
  let codeNum  = codeStart;
  for (const [startTime, endTime] of intervals) {
    const closeMs = new Date(mvdToUtcIso(dateStr, endTime)).getTime();
    let cursor    = new Date(mvdToUtcIso(dateStr, startTime)).getTime();

    while (cursor + durationMin * 60_000 <= closeMs) {
      const slotEndMs = cursor + durationMin * 60_000;
      if (cursor < minStartMs) { cursor = slotEndMs; continue; }

      const startsAt = new Date(cursor).toISOString();
      const endsAt   = new Date(slotEndMs).toISOString();
      const overlap  = existing.some(a => a.starts_at < endsAt && a.ends_at > startsAt);

      if (!overlap) slots.push({ code: `T${codeNum++}`, time: utcIsoToMvdHHMM(startsAt), startsAt, endsAt });
      cursor = slotEndMs;
    }
  }
  return slots;
}

/**
 * Get free slots for the next 7 days from today (MVD).
 * @returns {{ slotsByDay, slotsMap, generatedAt }}
 */
function getFreeSlots(business, durationMin) {
  const todayStr   = getMvdDateStr();
  const nowMs      = Date.now();
  const slotsByDay = [];
  const slotsMap   = {};
  let codeNum      = 1;

  for (let i = 0; i < 7; i++) {
    const dateStr  = i === 0 ? todayStr : addDays(todayStr, i);
    const rawSlots = getFreeSlotsForDate(business, dateStr, durationMin, nowMs, codeNum);
    codeNum += rawSlots.length;
    rawSlots.forEach(s => { slotsMap[s.code] = { startsAt: s.startsAt, endsAt: s.endsAt, time: s.time }; });
    slotsByDay.push({ date: dateStr, dayLabel: formatDayLabel(dateStr), slots: rawSlots });
  }

  return { slotsByDay, slotsMap, generatedAt: nowMs };
}

// All slots for a date (available + occupied), used by GET /api/agenda/slots panel UI
function getAllSlotsForDate(business, dateStr, durationMin) {
  const dow       = getMvdDow(dateStr);
  const intervals = getBizHoursForDow(business, dow);
  if (!intervals.length) return [];

  const dayStartUtc = mvdToUtcIso(dateStr, '00:00');
  const dayEndUtc   = mvdToUtcIso(addDays(dateStr, 1), '00:00');
  const existing    = getConfirmedAppointmentsInRange(business.id, dayStartUtc, dayEndUtc);
  const minStartMs  = Date.now() + MIN_ADVANCE_MS;

  const slots = [];
  for (const [startTime, endTime] of intervals) {
    const closeMs = new Date(mvdToUtcIso(dateStr, endTime)).getTime();
    let cursor    = new Date(mvdToUtcIso(dateStr, startTime)).getTime();
    while (cursor + durationMin * 60_000 <= closeMs) {
      const slotEndMs  = cursor + durationMin * 60_000;
      const startsAt   = new Date(cursor).toISOString();
      const endsAt     = new Date(slotEndMs).toISOString();
      const isPast     = cursor < minStartMs;
      const isOccupied = existing.some(a => a.starts_at < endsAt && a.ends_at > startsAt);
      slots.push({ time: utcIsoToMvdHHMM(startsAt), available: !isPast && !isOccupied });
      cursor = slotEndMs;
    }
  }
  return slots;
}

// ── Prompt formatting ──────────────────────────────────────────────────────────

function formatSlotsForPrompt(slotsByDay) {
  return slotsByDay.map(day => {
    if (day.slots.length === 0) return `${day.dayLabel}: (sin disponibilidad)`;
    return `${day.dayLabel}: ${day.slots.map(s => `${s.code}=${s.time}`).join(' ')}`;
  }).join('\n');
}

// Client-visible slot list — no T-codes, just readable times.
function formatSlotsForClient(slotsByDay) {
  return slotsByDay
    .filter(day => day.slots.length > 0)
    .map(day => `${day.dayLabel}: ${day.slots.map(s => s.time).join(', ')}`)
    .join('\n');
}

/**
 * Format upcoming appointments for cancel/reschedule context.
 * @returns {{ text: string, appointmentsMap: { A1: apt, A2: apt, ... } }}
 */
function formatAppointmentsBlock(appointments) {
  const appointmentsMap = {};
  const lines = appointments.map((a, i) => {
    const code    = `A${i + 1}`;
    appointmentsMap[code] = a;
    const time    = utcIsoToMvdHHMM(a.starts_at);
    const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(a.starts_at));
    const [, mm, dd] = dateStr.split('-');
    const label   = `${DOW_LABELS[getMvdDow(dateStr)]} ${dd}/${mm} ${time}`;
    return `${code}=${label}${a.service_name ? ' — ' + a.service_name : ''}`;
  });
  return { text: lines.join('\n'), appointmentsMap };
}

// Last bookable date label ("Sáb 22/11")
function getMaxBookingDate() {
  return formatDayLabel(addDays(getMvdDateStr(), 6));
}

// True if the slotsMap is still within TTL
function isSlotsMapFresh(generatedAt) {
  return Date.now() - generatedAt < SLOT_TTL_MS;
}

module.exports = {
  getFreeSlots,
  formatSlotsForPrompt,
  formatSlotsForClient,
  formatAppointmentsBlock,
  getMaxBookingDate,
  isSlotsMapFresh,
  // exported for testing
  getMvdDateStr,
  utcIsoToMvdHHMM,
  mvdToUtcIso,
  getMvdDow,
  addDays,
  formatDayLabel,
  getBizHoursForDow,
  getFreeSlotsForDate,
  getAllSlotsForDate,
  DOW_LABELS,
  SLOT_TTL_MS,
  MIN_ADVANCE_MS,
};
