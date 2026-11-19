/**
 * Tests for the per-customer price cap.
 *
 * - 5 products quoted in ONE message with cap 2 → only 2 prices survive, rest deferred.
 * - Prices spread across SEVERAL messages → the 30-day distinct count accumulates and
 *   later messages get trimmed once the cap is reached.
 * - A business with cap NULL is never modified (feature off).
 *
 * Run: node scripts/test-price-cap.js
 */

'use strict';

process.env.DB_DIR = `/tmp/test-price-cap-${Date.now()}`;

const { extractPrices, extractPricesFromMany, enforcePriceCap, normalizePrice } = require('../src/pricecap');
const {
  upsertBusiness, getBusinessById, getOrCreateConversation, addMessage,
  getAssistantMessagesSince, setMaxPricesPerClient,
} = require('../src/db');

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}
const countPrices = t => extractPrices(t).size;

// ── Price parsing ─────────────────────────────────────────────────────────────
ok('parses $1.500 as 1500', normalizePrice('$1.500') === 1500);
ok('$1.500 and $1500 dedupe', extractPrices('$1.500 o $1500').size === 1);
ok('detects "800 pesos"', extractPrices('sale 800 pesos').has(800));
ok('ignores plain small numbers', extractPrices('tengo 3 modelos nuevos').size === 0);
ok('repeated price counts once', extractPrices('$500 ... y otra vez $500').size === 1);

// ── 5 products in ONE message, cap 2 ─────────────────────────────────────────
const five = 'Collar: $500\nAros: $800\nPulsera: $1.200\nAnillo: $300\nLlavero: $150';
ok('reply has 5 distinct prices', countPrices(five) === 5);
const r1 = enforcePriceCap(five, new Set(), 2);
ok('one message: dropped 3', r1.dropped === 3, `got ${r1.dropped}`);
ok('one message: keeps exactly 2 prices', countPrices(r1.text) === 2, `got ${countPrices(r1.text)}`);
ok('one message: keeps first 2 ($500,$800)', /\$500/.test(r1.text) && /\$800/.test(r1.text));
ok('one message: drops the rest', !/\$1\.200/.test(r1.text) && !/\$300/.test(r1.text) && !/\$150/.test(r1.text));
ok('one message: appends deferral', /consulto con el equipo/i.test(r1.text));

// Exactly at the cap → nothing dropped
ok('exactly 2 with cap 2 → no drop', enforcePriceCap('Collar $500 y aros $800', new Set(), 2).dropped === 0);

// ── Prices spread across SEVERAL messages (cap 2) ─────────────────────────────
const biz  = upsertBusiness({ name: 'MYV', response_mode: 'texto' });
setMaxPricesPerClient(biz.id, 2);
const conv = getOrCreateConversation(biz.id, 'cust-prices');

function sendCapped(text) {
  const prior = extractPricesFromMany(getAssistantMessagesSince(conv.id, 30));
  const remaining = Math.max(0, getBusinessById(biz.id).max_prices_per_client - prior.size);
  const res = enforcePriceCap(text, prior, remaining);
  addMessage(conv.id, 'assistant', res.text); // persist what the client actually gets
  return res;
}

const m1 = sendCapped('El collar sale $500 y los aros $800.');
ok('msg1: within cap, no drop', m1.dropped === 0, `got ${m1.dropped}`);

const m2 = sendCapped('La pulsera cuesta $1.200.');
ok('msg2: cap reached, dropped 1', m2.dropped === 1, `got ${m2.dropped}`);
ok('msg2: no new price sent', countPrices(m2.text) === 0, `got ${countPrices(m2.text)}`);
ok('msg2: defers to team', /consulto con el equipo/i.test(m2.text));

const m3 = sendCapped('El anillo está $300.');
ok('msg3: still capped, dropped 1', m3.dropped === 1);

// Re-quoting an ALREADY given price is allowed (not a new distinct price)
const m4 = sendCapped('Te confirmo: el collar sigue $500.');
ok('msg4: re-quoting prior price is allowed', m4.dropped === 0, `got ${m4.dropped}`);

// ── NULL cap = feature off ────────────────────────────────────────────────────
const biz2 = upsertBusiness({ name: 'No Cap Biz', response_mode: 'texto' });
ok('new business has NULL cap', getBusinessById(biz2.id).max_prices_per_client == null);
// With the feature off the server never calls enforce; the pure function is a no-op
// when remaining covers everything.
const off = enforcePriceCap(five, new Set(), 999);
ok('null-cap path: nothing dropped', off.dropped === 0 && off.text === five);

console.log(`\nprice-cap: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
