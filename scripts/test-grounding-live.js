'use strict';
/**
 * LIVE grounding test — real model, 3 test businesses × 15 trap questions (things the
 * business has NOT loaded) + control questions that ARE answerable from the config.
 *
 * Not part of run-all-suites (needs ANTHROPIC_API_KEY, costs ~60 model calls).
 * Run from a directory that has the key available (env or .env.local):
 *   node scripts/test-grounding-live.js
 *
 * Passes when (1) no reply that would be sent to a client contains ungrounded data and
 * (2) every control answer CONTAINS the loaded data it was asked for.
 * Also reports how often the raw model invented (before the check) and how many
 * control answers were wrongly blocked (false positives).
 */

process.env.DB_DIR = process.env.DB_DIR || `/tmp/test-grounding-live-${Date.now()}`;
try { require('dotenv').config({ path: '.env.local', quiet: true }); } catch (_) {}

const { generateReply } = require('../src/claude');
const { buildSources, findUngrounded, groundReply, FALLBACK_REPLY } = require('../src/grounding');
const { BUSINESSES } = require('./fixtures/grounding-businesses');

// Control questions: the answer IS loaded. `expect` = what the reply must contain
// (every pattern), so a reply that merely "does not invent" but withholds loaded data fails.
const CONTROLS = {
  peluqueria: [
    { q: '¿Cuánto sale el corte de dama?', expect: [/\$\s?800/] },
    { q: '¿Qué horario tienen los sábados?', expect: [/10(:00)?/, /14(:00)?/] },
    { q: '¿Cuánto cuesta el color y el brushing?', expect: [/2\.?500/, /550/] },
    { q: '¿Abren los domingos?', expect: [/cerrad|no abr|no atend/i] },
  ],
  tienda: [
    { q: '¿Cuánto sale el jean recto?', expect: [/1\.?890/] },
    { q: '¿Cuánto cuesta el envío en Montevideo y cuánto demora?', expect: [/180/, /48\s?(hs|horas)|2 d[ií]as/i] },
    { q: '¿Cómo puedo pagar?', expect: [/transferencia/i, /efectivo/i] },
  ],
  veterinaria: [
    { q: '¿Cuánto sale la consulta?', expect: [/1\.?200/] },
    { q: '¿Dónde están ubicados?', expect: [/Artigas\s+1420/i] },
    { q: '¿A qué número llamo por una urgencia de noche?', expect: [/099\s?888\s?777/] },
    { q: '¿Qué hago si mi perro se enferma un domingo?', expect: [/099\s?888\s?777/] },
    { q: '¿Hasta qué hora atienden los viernes?', expect: [/18(:00)?/] },
  ],
};

const _log = console.log;
console.log = (...a) => { if (!String(a[0]).startsWith('[claude:') && !String(a[0]).startsWith('[migration')) _log(...a); };

function nowUY() { return new Date(Date.now() - 3 * 3_600_000); }

async function ask(b, q) {
  const ctx = { now: nowUY(), hoursText: b.hoursText, needsHuman: false };
  const sources = buildSources({ business: b.business, runtimeCtx: ctx, history: [], userTexts: [q] });
  const raw = await generateReply(b.business, [], q, null, null, ctx);
  const res = await groundReply({
    reply: raw, sources,
    regenerate: note => generateReply(b.business, [], q, null, null, { ...ctx, groundingNote: note }),
  });
  const final = res.reply.replace(/\[[A-Z_]+\]\n?/g, '').trim();
  return { q, raw, res, final, leak: findUngrounded(res.reply, sources) };
}

(async () => {
  let traps = 0, rawInvented = 0, regenerated = 0, replaced = 0, leaks = 0, controls = 0, falsePos = 0, missing = 0;
  for (const b of BUSINESSES) {
    _log(`\n══ ${b.business.name} ══`);
    for (const trap of b.traps) {
      const r = await ask(b, trap.q);
      traps++;
      if (r.res.first.length) rawInvented++;
      if (r.res.action === 'regenerated') regenerated++;
      if (r.res.action === 'replaced') replaced++;
      if (r.leak.length) leaks++;
      _log(`\n[trampa] ${trap.q}\n  acción=${r.res.action}${r.res.first.length ? ' inventó=' + JSON.stringify(r.res.first) : ''}${r.leak.length ? ' ✗ FUGA=' + JSON.stringify(r.leak) : ''}\n  → ${r.final.replace(/\n+/g, ' / ')}`);
    }
    for (const c of CONTROLS[b.key]) {
      const r = await ask(b, c.q);
      controls++;
      const blocked = r.res.action !== 'ok';
      if (blocked) falsePos++;
      if (r.leak.length) leaks++;
      const absent = c.expect.filter(re => !re.test(r.final));
      if (absent.length) missing++;
      _log(`\n[control] ${c.q}\n  acción=${r.res.action}${blocked ? ' marcado=' + JSON.stringify(r.res.first) : ''}${absent.length ? ' ✗ FALTA EL DATO CARGADO=' + absent.map(String).join(' ') : ' ✓ contiene el dato'}\n  → ${r.final.replace(/\n+/g, ' / ')}`);
    }
  }
  _log('\n================================================================');
  _log(`Preguntas trampa: ${traps} — el modelo inventó (antes del control) en ${rawInvented}; corregidas al regenerar ${regenerated}; reemplazadas por "${FALLBACK_REPLY}" ${replaced}`);
  _log(`Controles (dato cargado): ${controls} — sin el dato esperado ${missing}; marcadas de más ${falsePos}`);
  _log(`Datos inventados que llegarían al cliente: ${leaks}`);
  const bad = leaks + missing;
  _log(`${traps + controls} tests — ${traps + controls - bad} passed, ${bad} failed`);
  process.exit(bad > 0 ? 1 : 0);
})().catch(err => { console.error('LIVE TEST ERROR:', err.message); process.exit(2); });
