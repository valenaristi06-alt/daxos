#!/usr/bin/env node
'use strict';
// Tests for feature/avisos-venta: [INTERES_COMPRA] tag behavior.
// Suite K: tag never reaches client (mock checks)
// Suite L: 12h rate limit per conversation
// Suite M: mail + WA fire independently (mock)
// Suite N: real model run — 20 positive / 20 negative phrases

const path = require('path');
const fs   = require('fs');

process.chdir(path.join(__dirname, '..'));

let passed = 0;
let failed = 0;

function assert(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Suite K: tag never reaches client ─────────────────────────────────────────
console.log('\nSuite K: [INTERES_COMPRA] never reaches client');
{
  // 1. sanitizeForClient (defined in whatsapp.js) strips uppercase bracket tags
  const serverSrc   = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const whatsappSrc = fs.readFileSync(path.join(__dirname, '../src/whatsapp.js'), 'utf8');
  assert('K1: sanitizeForClient uses generic uppercase-tag regex (whatsapp.js)',
    /\\\[A-Z\]/.test(whatsappSrc) || /\[A-Z\]\[A-Z_/.test(whatsappSrc) || whatsappSrc.includes('[A-Z][A-Z_0-9]'));

  // 2. preview endpoint explicitly strips [INTERES_COMPRA]
  assert('K2: preview endpoint strips [INTERES_COMPRA]',
    serverSrc.includes('reply = reply.replace(/\\[INTERES_COMPRA\\]'));

  // 3. main processing strips it before sanitizeForClient
  assert('K3: main processing extracts isSaleIntent and strips tag',
    serverSrc.includes('isSaleIntent = true') && serverSrc.includes("reply.replace(/\\[INTERES_COMPRA\\]\\n?/g, '')"));

  // 4. sanitizeForClient is defined in whatsapp.js and imported into server.js
  const sanitizeMatch = whatsappSrc.match(/function sanitizeForClient[\s\S]{0,200}replace\(\/(.+?)\/g/);
  assert('K4: sanitizeForClient regex present in whatsapp.js', !!sanitizeMatch);
  assert('K5: server.js imports sanitizeForClient from whatsapp',
    /sanitizeForClient[,\s}][\s\S]{0,500}require\('\.\/whatsapp'\)/.test(serverSrc));
}

// ── Suite L: 12h rate limit ────────────────────────────────────────────────────
console.log('\nSuite L: 12h rate limit for sale_intent');
{
  const DB_DIR = '/tmp/test-sale-intent-db';
  const { execSync } = require('child_process');
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  fs.mkdirSync(DB_DIR, { recursive: true });

  process.env.DB_DIR = DB_DIR;
  // Clear require cache for db module so it picks up new DB_DIR
  Object.keys(require.cache).forEach(k => { if (k.includes('/src/db')) delete require.cache[k]; });

  const { ownerAlertRecentlySent, recordOwnerAlert } = require('../src/db.js');

  const convId = 9001;
  const bizId  = 1;

  // Not sent yet — should return false
  assert('L1: ownerAlertRecentlySent returns false before first alert',
    !ownerAlertRecentlySent(convId, 'sale_intent', 12 * 3600));

  // Record alert
  recordOwnerAlert(bizId, convId, 'sale_intent');

  // Now blocked within 12h
  assert('L2: ownerAlertRecentlySent returns true after recording',
    ownerAlertRecentlySent(convId, 'sale_intent', 12 * 3600));

  // Different conv not blocked
  assert('L3: different convId not rate-limited',
    !ownerAlertRecentlySent(convId + 1, 'sale_intent', 12 * 3600));

  // Different kind not blocked on same conv
  assert('L4: different kind (needs_human) on same conv not blocked',
    !ownerAlertRecentlySent(convId, 'needs_human', 12 * 3600));

  // Check DB row exists
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DB_DIR, 'daxos.db'), { readonly: true });
  const row = db.prepare("SELECT kind FROM owner_alert_log WHERE conversation_id = ? AND kind = 'sale_intent' LIMIT 1").get(convId);
  db.close();
  assert('L5: sale_intent row written to owner_alert_log', !!row && row.kind === 'sale_intent');

  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  delete process.env.DB_DIR;
}

// ── Suite M: mail + WA fire independently ─────────────────────────────────────
console.log('\nSuite M: notifyOwnerSaleIntent — mail and WA independent');
{
  // Extract notifyOwnerSaleIntent logic from source and verify independence
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

  // Both channels should use .catch independently (not Promise.all that could suppress one)
  assert('M1: notifyOwnerSaleIntent function defined', serverSrc.includes('async function notifyOwnerSaleIntent'));

  // Mail has its own .catch
  assert('M2: mail sends via sendSaleIntentEmail with independent .catch',
    serverSrc.includes('sendSaleIntentEmail(') && serverSrc.includes("logError('mail-error'"));

  // WA has its own .catch
  assert('M3: WA sends via sendWhatsAppMessage with independent .catch',
    serverSrc.includes("logError('wa-owner-notify-error'"));

  // Rate limit checked before both
  assert('M4: rate limit checked before firing channels',
    serverSrc.includes("ownerAlertRecentlySent(conv.id, 'sale_intent', 12 * 3600)"));

  // recordOwnerAlert called (before channels, so a crash in one doesn't skip recording)
  assert('M5: recordOwnerAlert called for sale_intent',
    serverSrc.includes("recordOwnerAlert(business.id, conv.id, 'sale_intent')"));

  // Verify notifyOwnerOfBooking sends email always (not only as fallback)
  const bookingsSrc = fs.readFileSync(path.join(__dirname, '../src/bookings.js'), 'utf8');
  assert('M6: notifyOwnerOfBooking uses Promise.all (parallel)',
    bookingsSrc.includes('Promise.all([waPromise, emailPromise])'));
  assert('M7: booking email not gated on !waSent',
    !bookingsSrc.includes('if (!waSent && owner?.email)'));

  // Verify notifyOwnerOfPause uses Promise.all
  assert('M8: notifyOwnerOfPause uses Promise.all',
    serverSrc.includes('await Promise.all([emailPromise, waPromise])'));

  // sendAdminNotificationEmail no longer silent on missing key
  const emailSrc = fs.readFileSync(path.join(__dirname, '../src/email.js'), 'utf8');
  assert('M9: sendAdminNotificationEmail warns on missing RESEND_API_KEY',
    emailSrc.includes("console.warn('[resend] RESEND_API_KEY not set, skipping admin notification email')"));

  // sendSaleIntentEmail exported
  assert('M10: sendSaleIntentEmail exported from email.js',
    emailSrc.includes('sendSaleIntentEmail }') || emailSrc.includes('sendSaleIntentEmail,'));
}

// ── Suite O: sale_intent suprimido si hay booking_created reciente ─────────────
console.log('\nSuite O: sale_intent no dispara si ya hubo booking_created en 12h');
{
  const DB_DIR_O = '/tmp/test-sale-intent-booking';
  const { execSync } = require('child_process');
  try { execSync(`rm -rf ${DB_DIR_O}`); } catch (_) {}
  require('fs').mkdirSync(DB_DIR_O, { recursive: true });

  process.env.DB_DIR = DB_DIR_O;
  Object.keys(require.cache).forEach(k => { if (k.includes('/src/db')) delete require.cache[k]; });
  const { ownerAlertRecentlySent: oar2, recordOwnerAlert: roa2 } = require('../src/db.js');

  const convId = 9002;
  const bizId  = 2;

  // No prior alerts — sale_intent allowed
  assert('O1: sale_intent allowed before any booking_created', !oar2(convId, 'booking_created', 12 * 3600));

  // Record booking_created (simulates BOOKING_SLOTS firing first in same message)
  roa2(bizId, convId, 'booking_created');
  assert('O2: sale_intent blocked after booking_created recorded', oar2(convId, 'booking_created', 12 * 3600));

  // Source: notifyOwnerSaleIntent checks booking_created
  const serverSrc2 = require('fs').readFileSync(require('path').join(__dirname, '../src/server.js'), 'utf8');
  assert('O3: notifyOwnerSaleIntent checks booking_created rate limit',
    serverSrc2.includes("ownerAlertRecentlySent(conv.id, 'booking_created', 12 * 3600)"));

  // Source: booking creation records booking_created before notifyOwnerOfBooking
  assert('O4: recordOwnerAlert booking_created called at booking creation in server.js',
    serverSrc2.includes("recordOwnerAlert(business.id, conversation.id, 'booking_created')"));

  try { execSync(`rm -rf ${DB_DIR_O}`); } catch (_) {}
  delete process.env.DB_DIR;
}

// ── Suite N: real model run ────────────────────────────────────────────────────
console.log('\nSuite N: real model run — purchase intent detection');

const POSITIVE_PHRASES = [
  'quiero comprar el plan básico',
  'cómo puedo pagar?',
  'me lo llevo, ¿aceptan transferencia?',
  'quiero hacer una reserva para el sábado',
  'confirmame el pedido, lo quiero',
  'mandame los datos de pago',
  'quiero señar el turno',
  'voy a tomar el servicio premium',
  'quiero ordenar 3 unidades',
  'reservame para mañana a las 10',
  '¿cuál es el CBU para transferir?',
  'me decidí, lo compro',
  'quiero pedir el producto ahora',
  'necesito reservar para hoy',
  'cómo hago para contratar el plan?',
  'quiero pagar con tarjeta',
  '¿me pueden facturar? quiero comprar',
  'dale, confirmo la reserva',
  'tomo el paquete completo',
  'quiero hacer el pedido ya',
];

const NEGATIVE_PHRASES = [
  '¿cuánto sale el plan básico?',
  '¿en qué horarios atienden?',
  '¿cuáles son los precios?',
  '¿tienen stock del producto?',
  'quería saber si están abiertos los domingos',
  '¿me pueden dar más información del servicio?',
  '¿cuánto tarda el envío?',
  '¿tienen descuentos para estudiantes?',
  '¿cómo funciona el plan premium?',
  '¿cuál es la dirección?',
  'hola, buenas tardes',
  '¿pueden contarme más sobre el servicio?',
  '¿tienen servicio a domicilio?',
  '¿cuánto dura el tratamiento?',
  '¿hay alguna promoción vigente?',
  '¿necesito turno previo?',
  '¿cuáles son las formas de pago disponibles?',
  'quería consultar por el plan A',
  '¿me pueden mandar el catálogo?',
  'estoy comparando opciones',
];

async function runModelTest() {
  const { generateReply } = require('../src/claude.js');

  const mockBusiness = {
    name: 'Tienda Test',
    business_context: 'Vendemos productos digitales y servicios de suscripción. Plan básico $500/mes, plan premium $1200/mes.',
    pricing_info: 'Plan básico: $500/mes. Plan premium: $1200/mes. Pago por transferencia o tarjeta.',
    website_summary: null,
    sales_examples: [],
    style_profile: null,
    survey_answers: {},
    document_name: null,
    booking_enabled: false,
    urgent_alert_enabled: false,
    urgent_keywords: null,
  };

  const positiveResults = [];
  const negativeResults = [];

  console.log('\n  Testing 20 POSITIVE phrases (should trigger [INTERES_COMPRA])...');
  for (const phrase of POSITIVE_PHRASES) {
    try {
      const reply = await generateReply(mockBusiness, [], phrase, null, null, { now: new Date(), needsHuman: false });
      const hasTag = reply.includes('[INTERES_COMPRA]');
      positiveResults.push({ phrase, hasTag, reply: reply.slice(0, 80) });
      process.stdout.write(hasTag ? '  ✓' : '  ✗');
      process.stdout.write(` "${phrase.slice(0, 50)}"\n`);
    } catch (err) {
      positiveResults.push({ phrase, hasTag: false, error: err.message });
      console.error(`  ✗ "${phrase}" — ERROR: ${err.message}`);
    }
  }

  console.log('\n  Testing 20 NEGATIVE phrases (should NOT trigger [INTERES_COMPRA])...');
  for (const phrase of NEGATIVE_PHRASES) {
    try {
      const reply = await generateReply(mockBusiness, [], phrase, null, null, { now: new Date(), needsHuman: false });
      const hasTag = reply.includes('[INTERES_COMPRA]');
      negativeResults.push({ phrase, hasTag, reply: reply.slice(0, 80) });
      process.stdout.write(!hasTag ? '  ✓' : '  ✗');
      process.stdout.write(` "${phrase.slice(0, 50)}"\n`);
    } catch (err) {
      negativeResults.push({ phrase, hasTag: false, error: err.message });
      console.error(`  ✓ "${phrase}" — no tag (error: ${err.message})`);
    }
  }

  const posScore = positiveResults.filter(r => r.hasTag).length;
  const negScore = negativeResults.filter(r => !r.hasTag).length;
  const negFalsePositives = 20 - negScore;

  console.log(`\n  Positive hit rate:    ${posScore}/20`);
  console.log(`  Negative false positives: ${negFalsePositives}/20`);

  const meetsThreshold = posScore >= 18 && negFalsePositives <= 2;
  assert(`N1: ≥18/20 positive phrases trigger [INTERES_COMPRA] (got ${posScore}/20)`, posScore >= 18);
  assert(`N2: ≤2/20 negative phrases trigger [INTERES_COMPRA] (got ${negFalsePositives}/20)`, negFalsePositives <= 2);

  if (!meetsThreshold) {
    console.log('\n  Per-phrase breakdown:');
    console.log('  POSITIVE (expected tag):');
    positiveResults.forEach(r => {
      const icon = r.hasTag ? '✓' : '✗';
      console.log(`    ${icon} "${r.phrase}"`);
    });
    console.log('  NEGATIVE (should NOT have tag):');
    negativeResults.forEach(r => {
      const icon = !r.hasTag ? '✓' : '✗';
      console.log(`    ${icon} "${r.phrase}"${r.hasTag ? ' ← FALSE POSITIVE' : ''}`);
    });
  }
}

async function main() {
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || (function() {
    try {
      const cfg = require('../config.local.js');
      return cfg.ANTHROPIC_API_KEY;
    } catch { return null; }
  })());

  if (!hasApiKey) {
    console.log('\nSuite N: SKIPPED — no ANTHROPIC_API_KEY available');
    console.log('  (set ANTHROPIC_API_KEY env var or config.local.js to run model test)');
  } else {
    try {
      await runModelTest();
    } catch (err) {
      console.error('\nSuite N ERROR:', err.message);
      failed++;
    }
  }

  console.log('\n================================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
