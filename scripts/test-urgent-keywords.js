#!/usr/bin/env node
'use strict';
// Tests for urgent keyword alert logic.
// Run: node scripts/test-urgent-keywords.js

let passed = 0;
let failed = 0;

function assert(desc, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ ${desc}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── normalizePauseText (copied from server.js) ────────────────────────────
function normalizePauseText(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// ── matchUrgentKeyword (same logic as webhook) ────────────────────────────
const NEGATION_RE = /\b(no|sin|nada|ningun|ninguna)\b/;

function matchUrgentKeyword(text, keywordsStr) {
  const kws = keywordsStr.split(',').map(k => normalizePauseText(k)).filter(Boolean);
  const normText = normalizePauseText(text);
  return kws.find(kw => {
    const re = new RegExp(`\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}\\b`);
    const m = re.exec(normText);
    if (!m) return false;
    const wordsBefore = normText.slice(0, m.index).trim().split(/\s+/).slice(-3).join(' ');
    return !NEGATION_RE.test(wordsBefore);
  }) ?? null;
}

// ── in-memory throttle ────────────────────────────────────────────────────
function makeThrottle(ms) {
  const map = new Map();
  return {
    check(id) {
      const last = map.get(id);
      if (!last || Date.now() - last > ms) { map.set(id, Date.now()); return true; }
      return false;
    },
    forceExpire(id) { map.set(id, Date.now() - ms - 1); },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

console.log('\n── Match básico ──');
assert('exacto sin acentos',  matchUrgentKeyword('esto es urgente', 'urgente'), 'urgente');
assert('con acento en kw',    matchUrgentKeyword('esto es urgente', 'urgénte'), 'urgente');
assert('con acento en texto', matchUrgentKeyword('esto es urgénte', 'urgente'), 'urgente');
assert('ambos con acento',    matchUrgentKeyword('emergência total', 'emergencia'), 'emergencia');

console.log('\n── Word boundary ──');
assert('no coincide substring', matchUrgentKeyword('inurgente cosa', 'urgente'), null);
assert('no coincide prefijo',   matchUrgentKeyword('urgentemente aquí', 'urgente'), null);
assert('sí al principio',       matchUrgentKeyword('urgente necesito ayuda', 'urgente'), 'urgente');
assert('sí al final',           matchUrgentKeyword('esto es muy urgente', 'urgente'), 'urgente');

console.log('\n── Negaciones ──');
assert('"no urgente" no dispara',      matchUrgentKeyword('no es urgente para nada', 'urgente'), null);
assert('"sin emergencia" no dispara',  matchUrgentKeyword('sin emergencia aqui', 'emergencia'), null);
assert('"nada urgente" no dispara',    matchUrgentKeyword('nada urgente', 'urgente'), null);
assert('"ningun urgente" no dispara',  matchUrgentKeyword('es ningun urgente', 'urgente'), null);
assert('negación lejos no bloquea',    matchUrgentKeyword('no me gusta pero esto es urgente', 'urgente'), 'urgente');

console.log('\n── Múltiples keywords ──');
assert('primera kw',   matchUrgentKeyword('emergencia total', 'emergencia, urgente'), 'emergencia');
assert('segunda kw',   matchUrgentKeyword('esto es urgente', 'emergencia, urgente'), 'urgente');
assert('ninguna kw',   matchUrgentKeyword('tengo una consulta', 'emergencia, urgente'), null);

console.log('\n── Throttle 30 min ──');
{
  const throttle = makeThrottle(30 * 60 * 1000);
  assert('primera vez dispara',    throttle.check('conv1'), true);
  assert('inmediatamente bloqueado', throttle.check('conv1'), false);
  assert('otro conv no bloqueado', throttle.check('conv2'), true);
  throttle.forceExpire('conv1');
  assert('después de 30m dispara', throttle.check('conv1'), true);
}

console.log('\n── Aislamiento por negocio ──');
{
  const throttle = makeThrottle(30 * 60 * 1000);
  assert('biz1-conv1 dispara', throttle.check('biz1-conv1'), true);
  assert('biz2-conv1 dispara', throttle.check('biz2-conv1'), true);
  assert('biz1-conv1 bloqueado', throttle.check('biz1-conv1'), false);
  assert('biz2-conv1 bloqueado', throttle.check('biz2-conv1'), false);
}

console.log('\n── urgent_alert_enabled = 0 ──');
{
  function shouldAlert(business, text) {
    if (!business.urgent_alert_enabled || !business.urgent_keywords) return false;
    return matchUrgentKeyword(text, business.urgent_keywords) !== null;
  }
  assert('toggle off no alerta', shouldAlert({ urgent_alert_enabled: 0, urgent_keywords: 'urgente' }, 'urgente'), false);
  assert('toggle on alerta',     shouldAlert({ urgent_alert_enabled: 1, urgent_keywords: 'urgente' }, 'urgente'), true);
  assert('sin keywords no alerta', shouldAlert({ urgent_alert_enabled: 1, urgent_keywords: null }, 'urgente'), false);
}

console.log('\n── [URGENTE] stripping (simulado) ──');
{
  function stripUrgente(rawReply) {
    let isUrgente = false;
    let reply = rawReply;
    if (/\[URGENTE\]/.test(reply)) {
      isUrgente = true;
      reply = reply.replace(/\[URGENTE\]\n?/g, '');
    }
    return { isUrgente, reply };
  }

  function shouldDispatch(isUrgente, urgentAlertEnabled) {
    return isUrgente && urgentAlertEnabled;
  }

  const raw = '[URGENTE]\nEntiendo que es urgente, te ayudo ahora.';
  const { isUrgente, reply } = stripUrgente(raw);
  assert('[URGENTE] detectado en reply',          isUrgente, true);
  assert('[URGENTE] eliminado del texto',         reply, 'Entiendo que es urgente, te ayudo ahora.');
  assert('no queda [URGENTE] en texto',           reply.includes('[URGENTE]'), false);
  assert('dispatch con toggle ON',                shouldDispatch(isUrgente, true), true);
  assert('no dispatch con toggle OFF',            shouldDispatch(isUrgente, false), false);
  assert('sin marker: no urgente, no dispatch',   shouldDispatch(false, true), false);

  // toggle off: strip igual, no dispatch
  const { isUrgente: iU2, reply: r2 } = stripUrgente('[URGENTE]\nOtro mensaje.');
  assert('strip siempre aunque toggle off',      r2, 'Otro mensaje.');
  assert('toggle off no dispara aviso',          shouldDispatch(iU2, false), false);
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
