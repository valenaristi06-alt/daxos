'use strict';

/**
 * Per-customer price cap helpers.
 *
 * A "price" is a currency amount quoted to the customer. We count DISTINCT price
 * values a business has quoted to one customer number over a rolling window, and
 * hold that at or below business.max_prices_per_client. NULL cap = feature off.
 *
 * Uruguayan convention: "." groups thousands, "," is the decimal separator
 * (e.g. $1.500 = 1500, $1.500,50 = 1500.5).
 */

// An amount is either grouped thousands (1.200 / 1 200) or a plain integer, with an
// optional 2-digit decimal. Only counts as a price with a currency marker ($/USD) or
// the word "pesos" — bare quantities like "3 modelos" are ignored.
const AMOUNT = '(?:\\d{1,3}(?:[.\\s]\\d{3})+|\\d+)(?:,\\d{1,2})?';
const PRICE_RE = new RegExp(
  `(?:\\$|u\\$s|us\\$|usd)\\s?${AMOUNT}` + '|' + `${AMOUNT}\\s*pesos\\b`,
  'gi'
);

// Normalize a matched price string to a numeric value for de-duplication.
function normalizePrice(raw) {
  const digits = raw.replace(/[^\d.,]/g, '');       // keep digits + separators
  const noThousands = digits.replace(/[.\s]/g, '');  // "." / space = thousands → drop
  const normalized = noThousands.replace(',', '.');  // "," = decimal
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

// Ordered list of price occurrences: [{ raw, value, index }, ...]
function findPrices(text) {
  if (!text) return [];
  const out = [];
  let m;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text)) !== null) {
    const value = normalizePrice(m[0]);
    if (value != null) out.push({ raw: m[0], value, index: m.index });
  }
  return out;
}

// Distinct price values present in a text, as a Set of numbers.
function extractPrices(text) {
  return new Set(findPrices(text).map(p => p.value));
}

// Distinct prices across many texts (e.g. the last 30 days of outgoing messages).
function extractPricesFromMany(texts) {
  const set = new Set();
  for (const t of texts || []) for (const v of extractPrices(t)) set.add(v);
  return set;
}

const DEFERRAL =
  'El resto de los precios los consulto con el equipo y te confirmo a la brevedad.';

/**
 * Enforce the cap on a freshly generated reply.
 *
 * @param {string} reply        candidate client-visible text
 * @param {Set<number>} priorSet distinct prices already quoted to this customer
 * @param {number} remaining    how many NEW distinct prices are still allowed (>= 0)
 * @returns {{ text, dropped, allowedNew, disallowed }}
 *   text        corrected reply (trimmed + deferral appended when needed)
 *   dropped     count of distinct new prices removed
 *   allowedNew  distinct new prices kept
 *   disallowed  distinct new prices removed
 */
function enforcePriceCap(reply, priorSet, remaining) {
  const prior = priorSet instanceof Set ? priorSet : new Set(priorSet || []);
  const rem = Math.max(0, remaining | 0);

  // Distinct NEW prices in the reply, in order of first appearance.
  const newOrder = [];
  for (const p of findPrices(reply)) {
    if (!prior.has(p.value) && !newOrder.includes(p.value)) newOrder.push(p.value);
  }
  const allowedNew = new Set(newOrder.slice(0, rem));
  const disallowed = new Set(newOrder.slice(rem));
  if (disallowed.size === 0) {
    return { text: reply, dropped: 0, allowedNew: [...allowedNew], disallowed: [] };
  }

  // Drop the smallest text unit (line, else sentence) that carries a disallowed price.
  const hasDisallowed = chunk => findPrices(chunk).some(p => disallowed.has(p.value));
  const keptLines = [];
  for (const line of reply.split('\n')) {
    if (!hasDisallowed(line)) { keptLines.push(line); continue; }
    // Line mixes allowed and disallowed prices → keep only clean sentences.
    const sentences = line.split(/(?<=[.!?])\s+/);
    const keptSentences = sentences.filter(s => !hasDisallowed(s));
    if (keptSentences.length) keptLines.push(keptSentences.join(' '));
  }
  let text = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  text = (text ? text + '\n\n' : '') + DEFERRAL;

  return { text, dropped: disallowed.size, allowedNew: [...allowedNew], disallowed: [...disallowed] };
}

module.exports = { findPrices, extractPrices, extractPricesFromMany, enforcePriceCap, normalizePrice, DEFERRAL };
