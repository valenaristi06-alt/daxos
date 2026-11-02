/**
 * Tests for split-message feature: parseSplitParts and splitAndSend.
 * Run: node scripts/test-split-messages.js
 */

const { parseSplitParts, splitAndSend } = require('../src/whatsapp');

let passed = 0;
let failed = 0;

function ok(label, condition, extra = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
    failed++;
  }
}

// ── parseSplitParts ──────────────────────────────────────────────────────────

console.log('\n--- parseSplitParts ---');

// No separator → null
ok('no separator → null',
  parseSplitParts('Hola, te puedo ayudar con tu pedido.') === null);

// One non-empty part after split → null
ok('single part after split → null',
  parseSplitParts('Solo texto') === null);

// Two parts
const two = parseSplitParts('Parte uno ||| Parte dos');
ok('two parts returns array of 2', Array.isArray(two) && two.length === 2);
ok('parts are trimmed', two?.[0] === 'Parte uno' && two?.[1] === 'Parte dos');

// Empty part discarded
const withEmpty = parseSplitParts('Parte uno |||  ||| Parte tres');
ok('empty middle part discarded → 2 parts', withEmpty?.length === 2);

// All empty parts → null
ok('all empty parts → null',
  parseSplitParts(' |||  ||| ') === null);

// Four parts → array of 4
const four = parseSplitParts('A ||| B ||| C ||| D');
ok('exactly 4 parts', four?.length === 4);

// Five parts → array of 4, 5th merged into 4th
const five = parseSplitParts('A ||| B ||| C ||| D ||| E');
ok('5 parts capped to 4', five?.length === 4);
ok('overflow merged into 4th with \\n\\n', five?.[3] === 'D\n\nE');

// Six parts → 4th contains parts 4+5+6 joined
const six = parseSplitParts('A ||| B ||| C ||| D ||| E ||| F');
ok('6 parts capped to 4', six?.length === 4);
ok('6→4 last part is D\\n\\nE\\n\\nF', six?.[3] === 'D\n\nE\n\nF');

// Price not split mid-number (single part)
const price = parseSplitParts('El precio es $1.500 por unidad.');
ok('price without separator → null', price === null);

// Price as part of a clean split (not mid-word)
const priceOk = parseSplitParts('Te ofrecemos una variedad de productos. ||| Los precios van desde $500 a $2.000. ||| Enviamos a todo el país.');
ok('price in its own part stays intact', priceOk?.[1] === 'Los precios van desde $500 a $2.000.');

// URL not split
const urlPart = parseSplitParts('Podés ver más info en https://mitienda.com/productos/especiales. ||| ¿Te ayudo con algo más?');
ok('URL stays whole in its part', urlPart?.[0] === 'Podés ver más info en https://mitienda.com/productos/especiales.');

// Address in its own part
const addr = parseSplitParts('Estamos en Av. 18 de Julio 1234, piso 3, of. 5. ||| Atendemos de lunes a viernes.');
ok('address intact in its part', addr?.[0] === 'Estamos en Av. 18 de Julio 1234, piso 3, of. 5.');

// Phone in its own part
const phone = parseSplitParts('Podés llamarnos al 099 123 456. ||| También por email a info@local.com.');
ok('phone intact in its part', phone?.[0] === 'Podés llamarnos al 099 123 456.');

// Long message without separator → null
const long = parseSplitParts('Este es un mensaje muy largo que contiene mucha información sobre el negocio. Vendemos productos de calidad y ofrecemos el mejor servicio de atención al cliente. Si necesitás más información no dudes en consultarnos.');
ok('long message without separator → null', long === null);

// ── Safety net: paragraph expansion ──────────────────────────────────────────

console.log('\n--- paragraph safety net ---');

// (a) 3 paragraphs without ||| → 3 parts
const threeParas = parseSplitParts(
  'Hola, gracias por tu consulta.\n\nTenemos remeras desde $650 y pantalones desde $1.200.\n\n¿Te puedo ayudar con algo más?'
);
ok('3 paragraphs without ||| → 3 parts', threeParas?.length === 3);
ok('3 paragraphs: first para correct', threeParas?.[0] === 'Hola, gracias por tu consulta.');
ok('3 paragraphs: second para correct', threeParas?.[1] === 'Tenemos remeras desde $650 y pantalones desde $1.200.');
ok('3 paragraphs: third para correct', threeParas?.[2] === '¿Te puedo ayudar con algo más?');

// (b) Price list stays intact (not split by paragraph net)
const priceList = parseSplitParts(
  'Nuestros precios:\n- Remeras: $650\n- Pantalones: $1.200\n- Buzos: $1.800'
);
ok('price list without ||| → null (list kept intact)', priceList === null);

// (b2) Price list as part of a split keeps it together
const priceListInSplit = parseSplitParts(
  'Tenemos varios productos. ||| Nuestros precios:\n- Remeras: $650\n- Pantalones: $1.200\n- Buzos: $1.800 ||| ¿Te interesa alguno?'
);
ok('price list part stays as one part', priceListInSplit?.length === 3);
ok('price list content intact', priceListInSplit?.[1].includes('- Remeras: $650'));

// (c) More than 4 paragraphs → 4 parts, overflow merged into 4th
const fiveParas = parseSplitParts(
  'Párrafo 1.\n\nPárrafo 2.\n\nPárrafo 3.\n\nPárrafo 4.\n\nPárrafo 5.'
);
ok('5 paragraphs capped to 4 parts', fiveParas?.length === 4);
ok('5 paragraphs: overflow merged into 4th', fiveParas?.[3] === 'Párrafo 4.\n\nPárrafo 5.');

// Single paragraph (no blank lines, no |||) → null
ok('single para no blank lines → null',
  parseSplitParts('Hola, ¿en qué te puedo ayudar hoy?') === null);

// Paragraph + ||| combo: ||| split expanded further by blank lines
const mixedSplit = parseSplitParts(
  'Primera parte. ||| Segunda parte.\n\nTercera parte.'
);
ok('||| then blank-line expansion → 3 parts', mixedSplit?.length === 3);
ok('mixed: first part correct', mixedSplit?.[0] === 'Primera parte.');
ok('mixed: second part correct', mixedSplit?.[1] === 'Segunda parte.');
ok('mixed: third part correct', mixedSplit?.[2] === 'Tercera parte.');

// ── splitAndSend ─────────────────────────────────────────────────────────────

console.log('\n--- splitAndSend ---');

async function runSendTests() {
  // Mock helpers
  const calls = [];
  const typingCalls = [];
  const sleepLog = [];

  const mockSend = async (phone, text) => {
    calls.push({ phone, text, at: Date.now() });
  };
  const mockTyping = async (phone) => {
    typingCalls.push({ phone, at: Date.now() });
  };

  // Typing behavior tested with Kapso provider (Meta path covered in test-mark-read-typing.js).
  const creds = { provider: 'kapso', phoneNumberId: 'test' };
  const phone = '+59899000001';

  // Test: two parts sent in order
  calls.length = 0; typingCalls.length = 0;
  const r2 = await splitAndSend(['Parte 1', 'Parte 2'], {
    customerPhone: phone,
    waCredentials: creds,
    _sendFn: mockSend,
    _typingFn: mockTyping,
  });
  ok('2 parts: fullySent=true', r2.fullySent);
  ok('2 parts: sentParts has 2', r2.sentParts.length === 2);
  ok('2 parts: sent in order', r2.sentParts[0] === 'Parte 1' && r2.sentParts[1] === 'Parte 2');
  ok('2 parts: typing called before each', typingCalls.length === 2);
  ok('2 parts: send called twice', calls.length === 2);
  ok('2 parts: correct phone', calls.every(c => c.phone === phone));

  // Test: typing before first part (no delay before first)
  const t0 = typingCalls[0]?.at ?? 0;
  const s0 = calls[0]?.at ?? 0;
  ok('typing fires before first send', t0 <= s0);

  // Test: 4 parts all sent
  calls.length = 0; typingCalls.length = 0;
  const r4 = await splitAndSend(['A', 'B', 'C', 'D'], {
    customerPhone: phone,
    waCredentials: creds,
    _sendFn: mockSend,
    _typingFn: mockTyping,
  });
  ok('4 parts: fullySent=true', r4.fullySent);
  ok('4 parts: sentParts has 4', r4.sentParts.length === 4);

  // Test: send fails on part 2 → partial result
  calls.length = 0;
  let sendCount = 0;
  const failOnPart2 = async (phone, text) => {
    sendCount++;
    if (sendCount === 2) throw new Error('WhatsApp API error');
    calls.push(text);
  };
  const rFail = await splitAndSend(['Parte 1', 'Parte 2 falla', 'Parte 3'], {
    customerPhone: phone,
    waCredentials: creds,
    _sendFn: failOnPart2,
    _typingFn: async () => {},
  });
  ok('fail on part 2: fullySent=false', !rFail.fullySent);
  ok('fail on part 2: sentParts has only part 1', rFail.sentParts.length === 1);
  ok('fail on part 2: sentParts[0] is Parte 1', rFail.sentParts[0] === 'Parte 1');

  // Test: single part → no inter-part delay
  calls.length = 0; typingCalls.length = 0;
  const r1 = await splitAndSend(['Un solo mensaje'], {
    customerPhone: phone,
    waCredentials: creds,
    _sendFn: mockSend,
    _typingFn: mockTyping,
  });
  ok('single part: fullySent=true', r1.fullySent);
  ok('single part: 1 sent', r1.sentParts.length === 1);
  ok('single part: typing called once', typingCalls.length === 1);
}

runSendTests().then(() => {
  console.log(`\ntests — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
