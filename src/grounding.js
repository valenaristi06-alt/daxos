'use strict';

/**
 * Grounding check: the assistant may only state concrete data that exists in the
 * business configuration or in the conversation.
 *
 * Before a reply is sent we extract its concrete data (prices, amounts, hours, dates,
 * deadlines, phones, addresses, emails, links, product/brand names) and verify each one
 * against the sources. Anything not found is a violation.
 *
 * Flow (see groundReply): violation → regenerate once telling the model which data it
 * may not use → still violating → replace the reply with FALLBACK_REPLY and alert the owner.
 *
 * Deterministic on purpose: no extra model call, no extra cost per message.
 * Limit: it checks concrete data, not free-form yes/no claims ("sí, hacemos envíos") —
 * those are covered by the system prompt rule COHERENCIA CON LO CARGADO.
 */

const { findPrices } = require('./pricecap');

const FALLBACK_REPLY = 'Lo confirmo con el equipo y te aviso';

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const WORD_NUM = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30,
};
// Capitalised words that are never business data.
const NAME_WHITELIST = new Set([
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'sabados', 'domingo', 'domingos',
  ...Object.keys(MONTHS),
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  'whatsapp', 'hola', 'buen', 'buenas', 'buenos', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches',
  'gracias', 'dale', 'perfecto', 'genial', 'claro', 'listo', 'bienvenido', 'bienvenida',
  'usted', 'ustedes', 'vos', 'importante', 'atencion', 'nota', 'pesos', 'usd',
  'sra', 'srta', 'sres', 'don', 'dona', 'doctor', 'doctora', 'dra',
  'the', 'you', 'your', 'hello', 'thanks', 'english', 'espanol',
]);

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// A numeric token can be read several ways ("1.500" = 1500 in UY, 1.5 elsewhere).
// We accept any reading — the check stays strict on the value, lenient on the format.
function numVariants(tok) {
  const t = String(tok).replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
  const out = new Set();
  if (!t) return out;
  const add = v => { if (Number.isFinite(v)) out.add(v); };
  add(parseFloat(t.replace(/\./g, '').replace(',', '.')));
  add(parseFloat(t.replace(/,/g, '')));
  add(parseFloat(t.replace(/[.,]/g, '')));
  return out;
}

const NUM_TOKEN_RE = /\d+(?:[.,]\d+)*/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|uy|ar|br|lat|io|app|co|me|shop|store|tienda|online|site)(?:\.[a-z]{2})?(?:\/[^\s<>"')\]]*)?/g;
const HANDLE_RE = /(?<![a-z0-9._])@[a-z0-9_.]{3,}/g;
const ADDRESS_RE = /\b(?:calle|av\.?|avda\.?|avenida|bv\.?|bvar\.?|bulevar|boulevard|rambla|ruta|camino|pasaje|peatonal)\s+((?:[a-z0-9.]+\s+){0,4}?)(\d{2,5})\b/g;
const DATE_NUM_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const DATE_TXT_RE = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${Object.keys(MONTHS).join('|')})\\b`, 'g');
const TIME_COLON_RE = /\b([01]?\d|2[0-3])(?::([0-5]\d)|\.([0-5]\d)(?=\s*(?:hs|hrs|h|horas)\b))\s*(am|pm|a\.m\.|p\.m\.)?/g;
const TIME_AMPM_RE = /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/g;
const TIME_ALAS_RE = /\ba las? (\d{1,2})\b(?![:.,]\d)/g;
const TIME_RANGE_RE = /\bde (\d{1,2}) a (\d{1,2})\b(?![:.,]\d)(?!\s*(?:dias?|semanas?|mes(?:es)?|anos?|minutos?|min\b))/g;
const HOUR_UNIT_RE = /\b(\d{1,3})\s*(hs|hrs|h|horas?)\b/g;
const UNIT = '(minutos?|min|dias?|semanas?|mes(?:es)?|anos?)';
const DUR_RE = new RegExp(`\\b(\\d+|${Object.keys(WORD_NUM).join('|')})(?:\\s*(?:a|o|-)\\s*(\\d+))?\\s*${UNIT}\\b`, 'g');
const DUR_WORD_HOUR_RE = new RegExp(`\\b(${Object.keys(WORD_NUM).join('|')})\\s+horas?\\b`, 'g');
const PHONE_RE = /\+?\d(?:[ \t()-]{0,2}\d){6,14}/g;
const PERCENT_RE = /\b(\d{1,3}(?:[.,]\d+)?)\s?(?:%|por ciento)/g;

function toMinutes(h, m, ampm) {
  let hh = parseInt(h, 10);
  const mm = m ? parseInt(m, 10) : 0;
  if (ampm) {
    const pm = ampm.startsWith('p');
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  return hh * 60 + mm;
}

// Canonical key for a duration so "48 hs" and "2 días" compare equal.
function durKey(n, unit) {
  if (/^min/.test(unit)) return `m${n}`;
  if (/^h/.test(unit)) return `m${n * 60}`;
  if (/^dia/.test(unit)) return `m${n * 1440}`;
  if (/^semana/.test(unit)) return `m${n * 10080}`;
  if (/^mes/.test(unit)) return `M${n}`;
  return `M${n * 12}`; // años
}

function collect(re, text, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    fn(m);
  }
}

function cleanUrl(u) {
  return u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,;:!?)\]]+$/, '').replace(/\/+$/, '');
}

// A total the assistant may work out from loaded prices. Deliberately narrow, because an
// invented price is often a round multiple of a real one:
//   - N units of a loaded price, only when that quantity N (2–12, as a digit or a word)
//     is written in the reply or in the client's message: "3 remeras" at $690 → $2.070.
//   - a subtotal already validated in this reply plus a loaded price or another subtotal.
// Anything else must be loaded as is.
const MAX_QTY = 12;
function quantitiesIn(ntext) {
  const out = new Set();
  collect(/\b(\d{1,2})\b(?![.,:/]\d)/g, ntext, m => { const n = parseInt(m[1], 10); if (n >= 2 && n <= MAX_QTY) out.add(n); });
  for (const [word, n] of Object.entries(WORD_NUM)) if (n >= 2 && n <= MAX_QTY && new RegExp(`\\b${word}\\b`).test(ntext)) out.add(n);
  return out;
}
function isDerivedAmount(value, loaded, accepted, quantities) {
  if (!(value > 0)) return false;
  const cents = n => Math.round(n * 100);
  const v = cents(value);
  for (const p of [...loaded, ...accepted]) {
    if (p <= 0) continue;
    const k = v / cents(p);
    if (Number.isInteger(k) && quantities.has(k)) return true;
  }
  const rest = new Set([...loaded, ...accepted].map(cents));
  for (const a of accepted) { const c = cents(a); if (c > 0 && c < v && rest.has(v - c)) return true; }
  return false;
}

function phoneMatches(digits, srcPhones) {
  const tail = digits.slice(-8);
  return srcPhones.some(s => s.endsWith(tail) || digits.endsWith(s.slice(-8)));
}

/**
 * Builds the searchable source set: everything the business loaded plus the conversation.
 * Mirrors the fields buildSystemPrompt shows the model — but NOT the prompt text itself,
 * whose examples ("$1.500", "T1=09:00") would wrongly legitimise invented data.
 */
function buildSources({ business = {}, runtimeCtx = null, bookingState = null, history = [], userTexts = [], customerPhone = null, extraTexts = [] } = {}) {
  const parts = [];
  const push = v => { if (v != null && v !== '') parts.push(typeof v === 'string' ? v : String(v)); };

  push(business.name); push(business.business_context); push(business.pricing_info);
  push(business.website_summary); push(business.website_url); push(business.owner_rules);
  push(business.document_name); push(business.after_hours_instructions); push(business.urgent_phone);
  push(business.whatsapp_number);
  for (const ex of business.sales_examples || []) push(ex);
  if (business.survey_answers && typeof business.survey_answers === 'object') {
    for (const [k, v] of Object.entries(business.survey_answers)) { push(k); push(typeof v === 'object' ? JSON.stringify(v) : v); }
  }

  const rc = runtimeCtx || {};
  for (const d of rc.documents || []) { push(d.name); push(d.text); }
  for (const img of rc.images || []) push(img.label);
  push(rc.hoursText); push(rc.afterHoursInstructions); push(rc.urgentPhone);
  if (rc.isOpenResult) { push(rc.isOpenResult.closesAt); push(rc.isOpenResult.nextOpen?.time); }
  if (rc.agenda) {
    const ag = rc.agenda;
    for (const s of ag.services || []) push(`${s.name} ${s.duration} min`);
    push(ag.maxDate); push(ag.appointmentsText); push(ag.slotsText); push(ag.clientName); push(ag.cancelText);
    if (ag.selectedService) push(ag.selectedService.name);
  }
  if (bookingState) { push(bookingState.name); push(bookingState.reason); push(JSON.stringify(bookingState.slots || '')); }

  for (const m of history || []) push(m.content);
  for (const t of userTexts || []) push(t);
  for (const t of extraTexts || []) push(t);
  push(customerPhone);

  const ntext = norm(parts.join('\n'));
  const src = {
    ntext,
    urlText: ntext.replace(/https?:\/\//g, '').replace(/www\./g, ''),
    numbers: new Set(), calendar: new Set(), amounts: new Set(), times: new Set(), dates: new Set(), durations: new Set(),
    phones: [], words: new Set(ntext.split(/[^a-z0-9]+/).filter(Boolean)),
    userQuantities: quantitiesIn(norm((userTexts || []).filter(Boolean).join('\n'))),
  };

  collect(NUM_TOKEN_RE, ntext, m => { for (const v of numVariants(m[0])) src.numbers.add(v); });
  // Amounts written as prices in the sources — the only base for derived totals.
  for (const p of findPrices(ntext)) { if (src.amounts.size < 400) src.amounts.add(p.value); }
  collect(TIME_COLON_RE, ntext, m => src.times.add(toMinutes(m[1], m[2] || m[3], m[4])));
  collect(TIME_AMPM_RE, ntext, m => src.times.add(toMinutes(m[1], null, m[2])));
  collect(TIME_ALAS_RE, ntext, m => src.times.add(parseInt(m[1], 10) * 60));
  collect(HOUR_UNIT_RE, ntext, m => {
    const n = parseInt(m[1], 10);
    if (n <= 23) src.times.add(n * 60);
    src.durations.add(durKey(n, 'h'));
  });
  collect(DATE_NUM_RE, ntext, m => src.dates.add(`${+m[1]}/${+m[2]}`));
  collect(DATE_TXT_RE, ntext, m => src.dates.add(`${+m[1]}/${MONTHS[m[2]]}`));
  collect(DUR_RE, ntext, m => {
    const n = WORD_NUM[m[1]] ?? parseInt(m[1], 10);
    src.durations.add(durKey(n, m[3]));
    if (m[2]) src.durations.add(durKey(parseInt(m[2], 10), m[3]));
  });
  collect(DUR_WORD_HOUR_RE, ntext, m => src.durations.add(durKey(WORD_NUM[m[1]], 'h')));
  if (ntext.includes('media hora')) src.durations.add('m30');
  collect(PHONE_RE, ntext, m => {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 7 && d.length <= 15) src.phones.push(d);
  });

  // Calendar facts the assistant can derive from "today": the next 7 days and the year.
  if (rc.now instanceof Date && !isNaN(rc.now)) {
    // Kept apart from src.numbers so a day of the month can never back a price.
    for (let i = 0; i <= 7; i++) {
      const d = new Date(rc.now.getTime() + i * 86_400_000);
      src.dates.add(`${d.getUTCDate()}/${d.getUTCMonth() + 1}`);
      src.calendar.add(d.getUTCDate());
    }
    src.calendar.add(rc.now.getUTCFullYear());
    src.calendar.add(rc.now.getUTCFullYear() + 1);
  }
  return src;
}

function stripMarkers(text) {
  return String(text || '').replace(/\[[A-Z][A-Z_0-9]*(?::[^\]]*)?\]/g, ' ').replace(/\|\|\|/g, '\n');
}

// Capitalised words that are not at the start of a sentence — product/brand/place names.
function findNameViolations(original, src) {
  const out = [];
  const seen = new Set();
  const text = original.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+/gi, m => ' '.repeat(m.length));
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok.length < 3 || /^I['’]/.test(tok)) continue; // "I'll", "I'm"…
    const first = tok[0];
    if (first === first.toLowerCase() || !/\p{L}/u.test(first)) continue; // not capitalised
    // Sentence-initial? Walk back over whitespace and opening punctuation.
    let i = m.index - 1;
    let initial = true;
    for (; i >= 0; i--) {
      const ch = text[i];
      if (ch === '\n') break;
      if (/\s/.test(ch) || /[¿¡"'“”«(*_\-–—•]/.test(ch)) continue;
      initial = !/[\p{L}\p{N},;)%$]/u.test(ch);
      break;
    }
    if (initial) continue;
    const n = norm(tok).replace(/[^a-z0-9]/g, '');
    if (!n || NAME_WHITELIST.has(n) || seen.has(n)) continue;
    const known = src.words.has(n) || src.words.has(n + 's') || src.words.has(n + 'es') ||
      (n.endsWith('es') && src.words.has(n.slice(0, -2))) || (n.endsWith('s') && src.words.has(n.slice(0, -1)));
    if (!known) { seen.add(n); out.push({ type: 'nombre', value: tok }); }
  }
  return out;
}

/**
 * Returns the concrete data in `reply` that is NOT backed by the sources.
 * @returns {Array<{type: string, value: string}>}
 * opts.hasImage: the customer sent an image whose content we cannot read here, so only
 *   prices and contact data are checked (the model may legitimately quote the image).
 * opts.names === false: skip the product/brand name heuristic.
 */
function findUngrounded(reply, src, opts = {}) {
  const original = stripMarkers(reply);
  let w = norm(original);
  const out = [];
  const seen = new Set();
  const bad = (type, value) => {
    const key = `${type}:${value}`;
    if (!seen.has(key)) { seen.add(key); out.push({ type, value: String(value).trim() }); }
  };
  const mask = m => { w = w.slice(0, m.index) + ' '.repeat(m[0].length) + w.slice(m.index + m[0].length); };
  // Each pass matches on a snapshot, then masks its spans so later passes don't re-read them.
  const pass = (re, fn) => {
    const hits = [];
    collect(re, w, m => hits.push(m));
    for (const m of hits) { fn(m); mask(m); }
  };
  const full = !opts.hasImage;

  pass(EMAIL_RE, m => { if (!src.ntext.includes(m[0])) bad('email', m[0]); });
  pass(URL_RE, m => { const u = cleanUrl(m[0]); if (u && !src.urlText.includes(u)) bad('link', m[0]); });
  pass(HANDLE_RE, m => { if (!src.ntext.includes(m[0])) bad('link', m[0]); });

  {
    const prices = findPrices(w);
    const accepted = new Set(); // amounts validated so far in this reply
    const quantities = new Set([...quantitiesIn(w), ...src.userQuantities]);
    let pending = [];
    for (const p of prices) {
      // The reply's price is read one way only (UY: "." groups thousands), so "$30.000"
      // cannot match a loaded "30". Sources stay lenient about how they were typed.
      const vs = new Set([p.value, parseFloat(p.raw.replace(/\D/g, ''))]);
      if ([...vs].some(v => src.numbers.has(v))) accepted.add(p.value); else pending.push(p);
    }
    // Totals can build on each other (subtotal, then total): repeat until nothing new validates.
    for (let progress = true; progress && pending.length;) {
      progress = false;
      const still = [];
      for (const p of pending) {
        if (isDerivedAmount(p.value, src.amounts, accepted, quantities)) { accepted.add(p.value); progress = true; } else still.push(p);
      }
      pending = still;
    }
    for (const p of pending) bad('precio', p.raw);
    for (const p of prices) mask({ index: p.index, 0: p.raw });
  }

  pass(ADDRESS_RE, m => {
    if (src.ntext.includes(m[0])) return;
    const nameWords = m[1].split(/\s+/).filter(x => x.replace(/\W/g, '').length >= 4);
    const numOk = src.numbers.has(parseInt(m[2], 10));
    if (!numOk || !nameWords.every(x => src.words.has(x.replace(/\W/g, '')))) bad('direccion', m[0]);
  });

  if (full) {
    pass(DATE_NUM_RE, m => { if (!src.dates.has(`${+m[1]}/${+m[2]}`)) bad('fecha', m[0]); });
    pass(DATE_TXT_RE, m => { if (!src.dates.has(`${+m[1]}/${MONTHS[m[2]]}`)) bad('fecha', m[0]); });

    const timeOk = min => src.times.has(min) || (min < 720 && src.times.has(min + 720));
    pass(TIME_COLON_RE, m => { if (!timeOk(toMinutes(m[1], m[2] || m[3], m[4]))) bad('horario', m[0]); });
    pass(TIME_AMPM_RE, m => { if (!timeOk(toMinutes(m[1], null, m[2]))) bad('horario', m[0]); });
    pass(TIME_ALAS_RE, m => { if (!timeOk(parseInt(m[1], 10) * 60)) bad('horario', m[0]); });
    pass(TIME_RANGE_RE, m => {
      for (const h of [m[1], m[2]]) {
        const n = parseInt(h, 10);
        if (!(n <= 23 && timeOk(n * 60)) && !src.numbers.has(n)) bad('horario', m[0]);
      }
    });
    // "18 hs" / "las 18 horas" is a clock time; "48 hs" / "2 horas" is a deadline.
    // A clock reading needs that exact hour loaded; otherwise the duration must be loaded.
    pass(HOUR_UNIT_RE, m => {
      const n = parseInt(m[1], 10);
      const clock = n <= 23 && (!m[2].startsWith('hora') || /\blas\s*$/.test(w.slice(0, m.index)));
      if (!(clock && src.times.has(n * 60)) && !src.durations.has(durKey(n, 'h'))) bad('plazo', m[0]);
    });
    pass(DUR_RE, m => {
      const n = WORD_NUM[m[1]] ?? parseInt(m[1], 10);
      if (n === 1 && /^min/.test(m[3]) && WORD_NUM[m[1]]) return; // "un minuto" — figure of speech
      const keys = [durKey(n, m[3])];
      if (m[2]) keys.push(durKey(parseInt(m[2], 10), m[3]));
      if (!keys.every(k => src.durations.has(k))) bad('plazo', m[0]);
    });
    pass(DUR_WORD_HOUR_RE, m => { if (!src.durations.has(durKey(WORD_NUM[m[1]], 'h'))) bad('plazo', m[0]); });
    pass(/\bmedia hora\b/g, m => { if (!src.durations.has('m30')) bad('plazo', m[0]); });
  }

  pass(PHONE_RE, m => {
    const d = m[0].replace(/\D/g, '');
    if (d.length < 7 || d.length > 15) return;
    if (!phoneMatches(d, src.phones)) bad('telefono', m[0]);
  });

  if (full) {
    pass(PERCENT_RE, m => { if (![...numVariants(m[1])].some(v => src.numbers.has(v))) bad('porcentaje', m[0]); });
    // Any other number with 2+ digits (quantities, sizes, instalments, capacities).
    pass(NUM_TOKEN_RE, m => {
      if (m[0].replace(/\D/g, '').length < 2) return;
      if (![...numVariants(m[0])].some(v => src.numbers.has(v) || src.calendar.has(v))) bad('numero', m[0]);
    });
    if (opts.names !== false) out.push(...findNameViolations(original, src));
  }
  return out;
}

function buildCorrectionNote(violations) {
  const list = violations.map(v => `"${v.value}" (${v.type})`).join(', ');
  return `CORRECCIÓN OBLIGATORIA: tu respuesta anterior incluía datos que NO están en la información cargada del negocio ni en la conversación: ${list}. No podés usarlos ni reemplazarlos por otros parecidos. Respondé de nuevo al último mensaje del cliente usando solo datos que estén cargados o que el cliente haya dicho; para lo que falte, decí que el equipo lo confirma.`;
}

// Log-safe summary: no personal data. Phones and emails are reduced to their type.
function summarizeViolations(violations) {
  return violations.map(v => (v.type === 'telefono' || v.type === 'email') ? `${v.type}:[oculto]` : `${v.type}:${v.value}`).join(' | ').slice(0, 400);
}

/**
 * Enforces grounding on a generated reply.
 * @param {object} p
 * @param {string} p.reply       first model reply (raw, markers allowed)
 * @param {object} p.sources     from buildSources()
 * @param {(note: string) => Promise<string>} p.regenerate  asks the model again with a correction note
 * @param {'enforce'|'log'|'off'} [p.mode]
 * @returns {Promise<{reply, action, first, second, regenerated}>}
 *   action: 'ok' | 'regenerated' | 'replaced' | 'logged' | 'off'
 */
async function groundReply({ reply, sources, regenerate, mode = 'enforce', hasImage = false, names = true }) {
  if (mode === 'off') return { reply, action: 'off', first: [], second: [], regenerated: false };
  const opts = { hasImage, names };
  const first = findUngrounded(reply, sources, opts);
  if (first.length === 0) return { reply, action: 'ok', first, second: [], regenerated: false };
  if (mode === 'log') return { reply, action: 'logged', first, second: [], regenerated: false };

  let retry = null;
  try { retry = await regenerate(buildCorrectionNote(first)); } catch (_) { retry = null; }
  if (retry != null) {
    const second = findUngrounded(retry, sources, opts);
    if (second.length === 0) return { reply: retry, action: 'regenerated', first, second, regenerated: true };
    return { reply: `[NEEDS_HUMAN]\n${FALLBACK_REPLY}`, action: 'replaced', first, second, regenerated: true };
  }
  return { reply: `[NEEDS_HUMAN]\n${FALLBACK_REPLY}`, action: 'replaced', first, second: [], regenerated: false };
}

// True when a reply tells the client that the team (not the assistant) will get back with
// something: "eso te lo confirma alguien del equipo", "lo consulto con el equipo"…
// Used to flag the conversation and tell the owner what the client asked.
const _DEFER_VERB = '(?:confirm|avis|consult|respond|contact|comunic|escrib|llam)\\w*';
const _DEFER_WHO = '(?:equipo|alguien del negocio|una persona del negocio)';
const TEAM_DEFERRAL_RE = new RegExp(
  `${_DEFER_VERB}[^.!?\\n]{0,60}\\b${_DEFER_WHO}\\b|\\b${_DEFER_WHO}\\b[^.!?\\n]{0,60}${_DEFER_VERB}|\\bte los? paso[^.!?\\n]{0,40}en breve`
);
function isTeamDeferral(text) {
  return TEAM_DEFERRAL_RE.test(norm(stripMarkers(text)));
}

function groundingMode() {
  const m = (process.env.GROUNDING_MODE || 'enforce').toLowerCase();
  return ['enforce', 'log', 'off'].includes(m) ? m : 'enforce';
}

module.exports = {
  FALLBACK_REPLY, buildSources, findUngrounded, groundReply, buildCorrectionNote,
  summarizeViolations, groundingMode, norm, isTeamDeferral,
};
