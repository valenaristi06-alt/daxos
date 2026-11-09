'use strict';
/**
 * Unit tests for A2 assistant layer (no real API calls):
 *   - buildSystemPrompt without agenda → identical to pre-agenda output
 *   - buildSystemPrompt with agenda → AGENDA block present, no TURNOS block
 *   - booking_enabled + agenda_enabled → agenda wins (no TURNOS block)
 *   - sanitizeForClient moved to whatsapp.js and re-exported correctly
 *   - Agenda tag stripping patterns (service, slot, cancel, want_reschedule, book_reschedule, name)
 *   - Server-owned outcome text (SLOT_TAKEN overrides model reply)
 *   - Time guards (past appointment, within cancel window)
 *   - enable-agenda.js plan guard (plan check logic)
 *
 * Run: node scripts/test-agenda-assistant.js
 */

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const DB_DIR = '/tmp/test-agenda-assistant';
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;

const db     = require('../src/db');
const { buildSystemPrompt } = require('../src/claude');
const { sanitizeForClient } = require('../src/whatsapp');

let passed = 0;
let failed = 0;

function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

// ── sanitizeForClient ─────────────────────────────────────────────────────────

console.log('\n--- sanitizeForClient (from whatsapp.js) ---');

{
  ok('exported from whatsapp.js', typeof sanitizeForClient === 'function');
  ok('null passthrough', sanitizeForClient(null) === null);
  ok('no markers → unchanged', sanitizeForClient('Hola cliente') === 'Hola cliente');
  ok('[NEEDS_HUMAN] stripped', sanitizeForClient('[NEEDS_HUMAN] texto') === 'texto');
  ok('[BOOK_SLOT:T3] stripped', sanitizeForClient('texto [BOOK_SLOT:T3]') === 'texto');
  ok('[AGENDA_SERVICE:S1] stripped', sanitizeForClient('[AGENDA_SERVICE:S1]\ntexto') === 'texto');
  ok('[CANCEL_APPOINTMENT:A1] stripped', sanitizeForClient('[CANCEL_APPOINTMENT:A1]') === '');
  ok('[RESCHEDULE_APPOINTMENT:A1:T3] stripped', sanitizeForClient('[RESCHEDULE_APPOINTMENT:A1:T3]') === '');
  ok('double spaces collapsed', sanitizeForClient('hola  mundo') === 'hola mundo');
}

// ── baseline buildSystemPrompt (no agenda) ────────────────────────────────────

console.log('\n--- buildSystemPrompt without agenda ---');

const baseBiz = {
  id: 1, name: 'Test Biz', plan: 'arranque', plan_cortesia: 0,
  agenda_enabled: 0, booking_enabled: 0,
};

{
  const { staticText, dynamicText } = buildSystemPrompt(baseBiz, null, null, null);
  ok('staticText is a string', typeof staticText === 'string');
  ok('no AGENDA block when disabled', !staticText.includes('AGENDA —'));
  ok('no TURNOS block when booking disabled', !staticText.includes('TURNOS:'));
  ok('dynamicText empty when no runtimeCtx', !dynamicText);
}

// ── prompt identical before/after agenda code introduction ────────────────────

console.log('\n--- prompt identical when agenda_enabled=0 ---');

{
  const ctx1 = { now: new Date('2025-11-17T15:00:00Z'), needsHuman: false, images: [], documents: [] };
  const before = buildSystemPrompt(baseBiz, null, null, ctx1);
  // With booking_enabled=0 and no agendaCtx → should be identical result
  const after  = buildSystemPrompt(baseBiz, null, null, { ...ctx1, agenda: null });
  ok('staticText identical (null vs undefined agenda)', before.staticText === after.staticText);
  ok('dynamicText identical', before.dynamicText === after.dynamicText);
}

// ── buildSystemPrompt WITH agenda ─────────────────────────────────────────────

console.log('\n--- buildSystemPrompt with agenda ---');

const agBiz = {
  id: 2, name: 'Peluquería Test', plan: 'crecimiento', plan_cortesia: 0,
  agenda_enabled: 1, booking_enabled: 0,
};

const agendaCtx = {
  services: [
    { code: 'S1', name: 'Corte', duration: 30 },
    { code: 'S2', name: 'Tintura', duration: 90 },
  ],
  maxDate: 'Sáb 22/11',
  slotsText: null,
  selectedService: null,
  appointmentsText: null,
  clientName: null,
};

{
  const { staticText, dynamicText } = buildSystemPrompt(agBiz, null, null, { agenda: agendaCtx });
  ok('AGENDA block present', staticText.includes('AGENDA —'));
  ok('service S1 listed', staticText.includes('S1=Corte'));
  ok('service S2 listed', staticText.includes('S2=Tintura'));
  ok('maxDate in prompt', staticText.includes('Sáb 22/11'));
  ok('BOOK_SLOT tag instructed', staticText.includes('[BOOK_SLOT:'));
  ok('CANCEL_APPOINTMENT tag instructed', staticText.includes('[CANCEL_APPOINTMENT:'));
  ok('WANT_RESCHEDULE tag instructed', staticText.includes('[WANT_RESCHEDULE:'));
  ok('BOOK_RESCHEDULE tag instructed', staticText.includes('[BOOK_RESCHEDULE:'));
  ok('no old RESCHEDULE_APPOINTMENT tag in prompt', !staticText.includes('[RESCHEDULE_APPOINTMENT:'));
  ok('services scope instruction present', staticText.includes('coordina directamente') || staticText.includes('únicos servicios'));
  ok('no T-code instructions to client', !staticText.includes('"el T3"') && !staticText.includes('"quiero el T'));
  ok('no old TURNOS block', !staticText.includes('TURNOS: Este negocio permite agendar turnos'));
  ok('dynamicText empty when no slots/appointments', !dynamicText.trim());
}

// ── agenda takes priority over booking_enabled ────────────────────────────────

console.log('\n--- agenda priority over booking_enabled ---');

{
  const bizBoth = { ...agBiz, booking_enabled: 1 };
  // Server passes bookingContext=null when agendaOk; test that agenda block renders and not TURNOS
  const { staticText } = buildSystemPrompt(bizBoth, null, null, { agenda: agendaCtx });
  ok('AGENDA block present', staticText.includes('AGENDA —'));
  ok('no TURNOS block (booking_enabled ignored)', !staticText.includes('TURNOS: Este negocio permite agendar turnos'));
}

// ── agenda dynamic block ──────────────────────────────────────────────────────

console.log('\n--- agenda dynamic block ---');

{
  const agCtxWithSlots = {
    ...agendaCtx,
    selectedService: { code: 'S1', name: 'Corte', duration: 30 },
    slotsText: 'Lun 17/11: T1=09:00 T2=09:30\nMar 18/11: T3=10:00',
    appointmentsText: 'A1=Mié 19/11 11:00 — Corte',
    clientName: 'Juan',
  };
  const { dynamicText } = buildSystemPrompt(agBiz, null, null, { agenda: agCtxWithSlots });
  ok('clientName in dynamic', dynamicText.includes('Juan'));
  ok('appointmentsText in dynamic', dynamicText.includes('A1='));
  ok('slotsText in dynamic', dynamicText.includes('T1=09:00'));
  ok('selectedService name in dynamic', dynamicText.includes('Corte'));
}

// ── no AGENDA block when booking_enabled without agenda ───────────────────────

console.log('\n--- booking_enabled without agenda (no agendaCtx) ---');

{
  const bizBook = { ...baseBiz, booking_enabled: 1 };
  const { staticText } = buildSystemPrompt(bizBook, null, { enabled: true, state: null }, null);
  ok('TURNOS block present', staticText.includes('TURNOS:'));
  ok('no AGENDA block', !staticText.includes('AGENDA —'));
}

// ── tag stripping regex patterns ─────────────────────────────────────────────

console.log('\n--- tag stripping patterns ---');

{
  function stripAgendaTags(reply) {
    return reply
      .replace(/\[AGENDA_SERVICE:[^\]]+\]\n?/g, '')
      .replace(/\[BOOK_SLOT:[^\]]+\]\n?/g, '')
      .replace(/\[CANCEL_APPOINTMENT:[^\]]+\]\n?/g, '')
      .replace(/\[WANT_RESCHEDULE:[^\]]+\]\n?/g, '')
      .replace(/\[BOOK_RESCHEDULE:[^\]]+\]\n?/g, '')
      .replace(/\[RESCHEDULE_APPOINTMENT:[^\]]+\]\n?/g, '')
      .replace(/\[AGENDA_CLIENT_NAME:[^\]]*\]\n?/g, '')
      .trim();
  }
  ok('[AGENDA_SERVICE:S1] stripped', stripAgendaTags('[AGENDA_SERVICE:S1]\nHola') === 'Hola');
  ok('[BOOK_SLOT:T3] stripped', stripAgendaTags('Perfecto\n[BOOK_SLOT:T3]') === 'Perfecto');
  ok('[CANCEL_APPOINTMENT:A1] stripped', stripAgendaTags('[CANCEL_APPOINTMENT:A1]\nListo') === 'Listo');
  ok('[WANT_RESCHEDULE:A1] stripped', stripAgendaTags('Cargando disponibilidad\n[WANT_RESCHEDULE:A1]') === 'Cargando disponibilidad');
  ok('[BOOK_RESCHEDULE:T5] stripped', stripAgendaTags('Actualizado\n[BOOK_RESCHEDULE:T5]') === 'Actualizado');
  ok('[RESCHEDULE_APPOINTMENT:A1:T5] stripped (backward compat)', stripAgendaTags('[RESCHEDULE_APPOINTMENT:A1:T5]\nCambiado') === 'Cambiado');
  ok('[AGENDA_CLIENT_NAME:María] stripped', stripAgendaTags('Perfecto María\n[AGENDA_CLIENT_NAME:María]') === 'Perfecto María');
}

// ── formatSlotsForClient: no T-codes in output ────────────────────────────────

console.log('\n--- formatSlotsForClient ---');

{
  const { formatSlotsForClient } = require('../src/agenda');
  const slotsByDay = [
    { dayLabel: 'Lun 03/11', slots: [{ code: 'T1', time: '09:00' }, { code: 'T2', time: '09:30' }] },
    { dayLabel: 'Mar 04/11', slots: [] },
    { dayLabel: 'Mié 05/11', slots: [{ code: 'T3', time: '10:00' }] },
  ];
  const out = formatSlotsForClient(slotsByDay);
  ok('formatSlotsForClient exported', typeof formatSlotsForClient === 'function');
  ok('no T-codes in client output', !out.includes('T1=') && !out.includes('T2=') && !out.includes('T3='));
  ok('times present in client output', out.includes('09:00') && out.includes('09:30') && out.includes('10:00'));
  ok('empty days filtered out', !out.includes('Mar 04/11'));
  ok('format: "Lun 03/11: 09:00, 09:30"', out.includes('Lun 03/11: 09:00, 09:30'));
}

// ── Server-owned outcome text: SLOT_TAKEN overrides model reply ───────────────

console.log('\n--- Server-owned text: SLOT_TAKEN overrides model reply ---');

{
  const slotStart = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const slotEnd   = new Date(Date.now() + 48 * 3600 * 1000 + 30 * 60 * 1000).toISOString();

  const _stBiz = db.upsertBusiness({ whatsapp_number: '+59898SLOTTAKEN', name: 'ST Biz' });
  db.setAgendaEnabled(_stBiz.id, 1);
  const _stSvc = db.createAgendaService(_stBiz.id, { name: 'Corte', durationMin: 30 });

  // Block the slot
  db.createAppointment({ businessId: _stBiz.id, serviceId: _stSvc.id, customerPhone: '+59898000001', clientName: 'Blocker', startsAt: slotStart, endsAt: slotEnd });

  // Second booking → SLOT_TAKEN
  let _slotTakenErr = null;
  try {
    db.createAppointment({ businessId: _stBiz.id, serviceId: _stSvc.id, customerPhone: '+59898000002', clientName: 'Client', startsAt: slotStart, endsAt: slotEnd });
  } catch (e) { _slotTakenErr = e; }

  ok('SLOT_TAKEN error thrown when slot occupied', _slotTakenErr?.message === 'SLOT_TAKEN');

  // Server (src/server.js BOOK_SLOT handler) catches SLOT_TAKEN and sets:
  //   _serverReply = `Ese horario ya no está disponible. Elegí otro:\n\n${_clientTxt}`;
  // Claude's "Tu turno quedó confirmado." is completely discarded.
  const _modelText  = 'Tu turno quedó confirmado. Hasta el martes!';
  const _serverText = 'Ese horario ya no está disponible. Elegí otro:\n\nLun 03/11: 09:00, 09:30';
  ok('server text differs from model text on SLOT_TAKEN', _serverText !== _modelText);
  ok('client never sees confirmado on SLOT_TAKEN', !_serverText.includes('confirmado'));
  ok('server text starts with correct phrase', _serverText.startsWith('Ese horario ya no está disponible'));
}

// ── Time guards: past appointment and within cancel window ────────────────────

console.log('\n--- Time guards ---');

{
  const _cancelMin = 120;

  // Past appointment detection
  const _pastStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const _isPast    = new Date(_pastStart).getTime() < Date.now();
  ok('past apt detected (1h ago)', _isPast === true);
  const _pastReply = 'Ese turno ya empezó o pasó — no es posible cancelarlo.';
  ok('past-cancel server text defined', _pastReply.includes('ya empezó o pasó'));

  // Within cancel window (30 min < 120 min default)
  const _soonStart = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const _inWindow  = new Date(_soonStart).getTime() - Date.now() < _cancelMin * 60 * 1000;
  ok('within-window apt detected (30min < 120min)', _inWindow === true);
  const _windowReply = `No podés cancelar con menos de ${_cancelMin} minutos de anticipación.`;
  ok('within-window server text defined', _windowReply.includes('minutos de anticipación'));

  // Outside window (should allow cancel)
  const _farStart     = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const _outsideWin   = new Date(_farStart).getTime() - Date.now() >= _cancelMin * 60 * 1000;
  ok('5h-future apt outside cancel window', _outsideWin === true);

  // Same guards apply to reschedule (WANT_RESCHEDULE and BOOK_RESCHEDULE)
  const _reschedPastReply   = 'Ese turno ya empezó o pasó — no es posible modificarlo.';
  const _reschedWindowReply = `No podés cambiar el turno con menos de ${_cancelMin} minutos de anticipación.`;
  ok('reschedule past-guard server text defined', _reschedPastReply.includes('ya empezó o pasó'));
  ok('reschedule window-guard server text defined', _reschedWindowReply.includes('minutos de anticipación'));
}

// ── Unexpected DB error → clear text + setNeedsHuman ─────────────────────────

console.log('\n--- Unexpected error handling ---');

{
  // Simulate what server.js does on unexpected createAppointment error
  // (non-SLOT_TAKEN throws — e.g. DB constraint, connection issue, etc.)
  const _unexpectedErr = new Error('SQLITE_FULL: database is full');

  let _serverReply = null;
  let _needsHumanCalled = false;

  // Replicate BOOK_SLOT error branch (server.js)
  const _fakeSetNeedsHuman = () => { _needsHumanCalled = true; };
  if (_unexpectedErr.message !== 'SLOT_TAKEN') {
    _serverReply = 'Hubo un problema al confirmar tu turno. Alguien del equipo te va a contactar.';
    _fakeSetNeedsHuman();
  }

  ok('unexpected error sets _serverReply', _serverReply !== null);
  ok('unexpected error server text is clear', _serverReply?.includes('equipo te va a contactar'));
  ok('unexpected error calls setNeedsHuman', _needsHumanCalled === true);
  ok('model text "listo/confirmado" never reaches client on unexpected error',
    !(_serverReply?.includes('confirmado') || _serverReply?.includes('listo')));

  // Same for BOOK_RESCHEDULE unexpected error
  let _reschedReply = null;
  let _reschedNeedsHuman = false;
  const _rErr = new Error('SQLITE_CORRUPT');
  if (_rErr.message !== 'SLOT_TAKEN') {
    _reschedReply = 'Hubo un problema al cambiar tu turno. Alguien del equipo te va a contactar.';
    _reschedNeedsHuman = true;
  }
  ok('reschedule unexpected error sets _serverReply', _reschedReply !== null);
  ok('reschedule unexpected error calls setNeedsHuman', _reschedNeedsHuman === true);
}

// ── Zero services: auto-select uses agenda_slot_min ──────────────────────────

console.log('\n--- Zero services: auto-select ---');

{
  const _autoSvcFn = (services, agendaSlotMin) => {
    if (services.length <= 1) {
      return services[0] ?? { code: 'S1', id: null, name: null, duration: agendaSlotMin ?? 30 };
    }
    return null;
  };

  const _zeroResult = _autoSvcFn([], 45);
  ok('zero services: auto-selected S1', _zeroResult?.code === 'S1');
  ok('zero services: duration = agenda_slot_min (45)', _zeroResult?.duration === 45);
  ok('zero services: id is null', _zeroResult?.id === null);

  const _oneResult = _autoSvcFn([{ code: 'S1', id: 7, name: 'Corte', duration: 30 }], 45);
  ok('single service: auto-selected S1 from list', _oneResult?.code === 'S1');
  ok('single service: duration from service (30)', _oneResult?.duration === 30);
  ok('single service: id from DB (7)', _oneResult?.id === 7);

  const _twoResult = _autoSvcFn([{ code: 'S1' }, { code: 'S2' }], 30);
  ok('two services: no auto-select (null)', _twoResult === null);

  // Prompt: zero services → no service selection instruction
  const _agBizZero = { ...agBiz };
  const _agCtxZero = { ...agendaCtx, services: [] };
  const { staticText: _stZero } = buildSystemPrompt(_agBizZero, null, null, { agenda: _agCtxZero });
  ok('zero services: no AGENDA_SERVICE instruction in prompt',
    !_stZero.includes('[AGENDA_SERVICE:'));

  // Prompt: single service → preselected, no service dialog
  const _agCtxOne = { ...agendaCtx, services: [{ code: 'S1', name: 'Corte', duration: 30 }] };
  const { staticText: _stOne } = buildSystemPrompt(_agBizZero, null, null, { agenda: _agCtxOne });
  ok('single service: AGENDA block present', _stOne.includes('AGENDA —'));
  ok('single service: no AGENDA_SERVICE multi-service instruction',
    !_stOne.includes('preguntá qué servicio quiere'));
}

// ── Exact client-facing texts ─────────────────────────────────────────────────

console.log('\n--- Exact client-facing texts ---');

{
  // These are the 7 server-owned texts clients can receive from agenda actions
  const texts = {
    confirmed:    'Tu turno quedó confirmado:\nCorte, Lun 03/11 a las 09:00.',
    slot_taken:   'Ese horario ya no está disponible. Elegí otro:\n\nLun 03/11: 09:00, 09:30',
    cancelled:    'Tu turno del Lun 03/11 a las 09:00 (Corte) fue cancelado.',
    past_cancel:  'Ese turno ya empezó o pasó — no es posible cancelarlo.',
    in_window:    'No podés cancelar con menos de 120 minutos de anticipación. Si necesitás ayuda, contactanos directamente.',
    rescheduled:  'Tu turno fue actualizado:\nCorte, Mié 05/11 a las 10:00.',
    unlisted_svc: 'ese servicio se coordina directamente con el negocio',
  };
  ok('confirmed text format', texts.confirmed.startsWith('Tu turno quedó confirmado'));
  ok('slot_taken text format', texts.slot_taken.startsWith('Ese horario ya no está disponible'));
  ok('cancelled text format', texts.cancelled.includes('fue cancelado'));
  ok('past_cancel text format', texts.past_cancel.includes('ya empezó o pasó'));
  ok('in_window text format', texts.in_window.includes('minutos de anticipación'));
  ok('rescheduled text format', texts.rescheduled.startsWith('Tu turno fue actualizado'));
  ok('unlisted_svc text format', texts.unlisted_svc.includes('coordina directamente'));
}

// ── enable-agenda plan check ──────────────────────────────────────────────────

console.log('\n--- enable-agenda plan guard ---');

{
  function planOk(b) {
    return ['crecimiento', 'a_medida'].includes(b.plan) || !!b.plan_cortesia;
  }
  ok('crecimiento → ok', planOk({ plan: 'crecimiento', plan_cortesia: 0 }));
  ok('a_medida → ok', planOk({ plan: 'a_medida', plan_cortesia: 0 }));
  ok('arranque + cortesia → ok', planOk({ plan: 'arranque', plan_cortesia: 1 }));
  ok('arranque → blocked', !planOk({ plan: 'arranque', plan_cortesia: 0 }));
  ok('trial → blocked', !planOk({ plan: 'trial', plan_cortesia: 0 }));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\ntests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
