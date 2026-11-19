/**
 * Tests for the instruction hierarchy + owner-rules contradiction detector (feature 5).
 *
 * - The system prompt states the priority order explicitly and softens absolute
 *   wording ("salvo que las reglas del dueño…").
 * - When the owner saves a rule like "no des más de 2 precios" while the config holds
 *   a list of 10 prices, the detector produces a warning. The model call is injectable
 *   so the test is deterministic (no live API).
 *
 * Run: node scripts/test-owner-rules-conflict.js
 */

'use strict';

process.env.DB_DIR = `/tmp/test-owner-rules-conflict-${Date.now()}`;

const { buildSystemPrompt, buildOwnerRulesConflictPrompt, checkOwnerRulesConflict } = require('../src/claude');
const { extractPrices } = require('../src/pricecap');
const { upsertBusiness, getBusinessById, setOwnerRulesWarning } = require('../src/db');

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const TEN_PRICES = [
  'Collar $500', 'Aros $800', 'Pulsera $1.200', 'Anillo $300', 'Llavero $150',
  'Cuadro $2.000', 'Maceta $650', 'Mate $900', 'Taza $450', 'Posavasos $250',
].join('\n');

const RULE = 'No des más de 2 precios por conversación.';

// ── Hierarchy in the system prompt ────────────────────────────────────────────
const biz = upsertBusiness({
  name: 'MYV', response_mode: 'texto', pricing_info: TEN_PRICES, owner_rules: RULE,
});
const { staticText } = buildSystemPrompt(getBusinessById(biz.id), null, null, null);
ok('prompt states explicit priority order', /JERARQUÍA DE PRIORIDADES/.test(staticText));
ok('prompt lists owner rules above config', /REGLAS DEL NEGOCIO.*prioridad sobre el resto/s.test(staticText));
ok('pricing wording softened', /salvo que las REGLAS DEL NEGOCIO/.test(staticText));
ok('security rules named as top level', /seguridad.*No se pueden anular/s.test(staticText));

// ── Conflict-check prompt carries the data a model needs ──────────────────────
const conflictPrompt = buildOwnerRulesConflictPrompt(getBusinessById(biz.id), RULE);
ok('conflict prompt includes the owner rule', conflictPrompt.includes('no des más de 2 precios') || conflictPrompt.includes(RULE));
ok('conflict prompt includes the 10 prices', extractPrices(conflictPrompt).size === 10, `got ${extractPrices(conflictPrompt).size}`);

// ── Detector with an injected "model" that mimics the real judgment ───────────
// Model stub: flags a conflict when the rule caps prices below the number configured.
const modelStub = async (prompt) => {
  const rulesSection = (prompt.split('REGLAS DEL DUEÑO:')[1] || '').split('CONFIGURACIÓN:')[0];
  const capMatch = rulesSection.match(/no des más de (\d+) precios/i);
  const priceCount = extractPrices(prompt).size;
  if (capMatch && priceCount > Number(capMatch[1])) {
    return JSON.stringify({ conflict: true, message: `Tu regla limita a ${capMatch[1]} precios, pero cargaste ${priceCount} precios en la configuración.` });
  }
  return JSON.stringify({ conflict: false, message: '' });
};

(async () => {
  const r = await checkOwnerRulesConflict(getBusinessById(biz.id), RULE, { call: modelStub });
  ok('detector flags the conflict', r.conflict === true);
  ok('detector returns a clear message', /limita a 2 precios/.test(r.message), r.message);

  // Persist + surface (what the panel reads)
  setOwnerRulesWarning(biz.id, r.conflict ? r.message : null);
  ok('warning stored and readable', !!getBusinessById(biz.id).owner_rules_warning);

  // Benign rule → no conflict, warning cleared
  const benign = 'Saludá siempre con el nombre del negocio.';
  const r2 = await checkOwnerRulesConflict({ ...getBusinessById(biz.id), owner_rules: benign }, benign, { call: modelStub });
  ok('benign rule: no conflict', r2.conflict === false && r2.message === '');
  setOwnerRulesWarning(biz.id, r2.conflict ? r2.message : null);
  ok('warning cleared when no conflict', getBusinessById(biz.id).owner_rules_warning == null);

  // Empty rules → short-circuit, no model call
  let called = false;
  const r3 = await checkOwnerRulesConflict(getBusinessById(biz.id), '', { call: async () => { called = true; return '{}'; } });
  ok('empty rules: no conflict, no model call', r3.conflict === false && called === false);

  // Model FAILS / TIMES OUT → instructions still saved, no warning (never throws)
  setOwnerRulesWarning(biz.id, null);
  const throwStub = async () => { throw new Error('model timeout'); };
  let threw = false, r4;
  try { r4 = await checkOwnerRulesConflict(getBusinessById(biz.id), RULE, { call: throwStub }); }
  catch (_) { threw = true; }
  ok('model failure does not throw', threw === false);
  ok('model failure → no conflict, no warning', r4 && r4.conflict === false && r4.message === '');
  // Server flow: rules already saved by upsert; the failed check sets no warning.
  setOwnerRulesWarning(biz.id, r4 && r4.conflict ? r4.message : null);
  ok('owner_rules preserved after model failure', getBusinessById(biz.id).owner_rules === RULE);
  ok('no warning stored after model failure', getBusinessById(biz.id).owner_rules_warning == null);

  // Bad JSON from model → also safe (no conflict)
  const r5 = await checkOwnerRulesConflict(getBusinessById(biz.id), RULE, { call: async () => 'no puedo responder en JSON' });
  ok('malformed model output → no conflict', r5.conflict === false && r5.message === '');

  console.log(`\nowner-rules-conflict: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
