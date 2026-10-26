'use strict';
/**
 * Seed de datos de prueba para el entorno local (data-local-test/).
 * Idempotente: borra y recrea las conversaciones del negocio de prueba en cada ejecución.
 * Uso: node scripts/seed-local.js  (llamado desde start-local.sh)
 * Env: SEED_ESTADO = activo | vacio | desconectado | prueba  (default: activo)
 */
const path    = require('path');
const bcrypt  = require('bcryptjs');
const Database = require('better-sqlite3');

const DB_DIR  = process.env.DB_DIR || path.join(__dirname, '..', 'data-local-test');
const DB_PATH = path.join(DB_DIR, 'daxos.db');
const TEST_EMAIL = 'test@local.dev';
const TEST_PASS  = 'prueba1234';

// Validate --estado
const ESTADO = process.env.SEED_ESTADO || 'activo';
const ESTADOS_VALIDOS = ['activo', 'vacio', 'desconectado', 'prueba'];
if (!ESTADOS_VALIDOS.includes(ESTADO)) {
  console.error('  [seed] ERROR: SEED_ESTADO="' + ESTADO + '" no válido. Opciones: ' + ESTADOS_VALIDOS.join(', '));
  process.exit(1);
}

// Config per estado:
//   phone_number_id: non-null = WA "conectado" (fake ID, no toca Meta)
//   planPaid: si poner plan_paid_at (true = sin banner de prueba)
//   trialDaysAgo: cuándo empezó el trial (null = sin trial)
//   trialEnded: si poner trial_ends_at 3 días atrás
//   subscriptionStatus: valor de subscription_status
//   seedConvs: si cargar las 4 conversaciones de ejemplo
const ESTADO_CFG = {
  activo:       { phone_number_id: 'pid-local-test', planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: true  },
  vacio:        { phone_number_id: 'pid-local-test', planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: false },
  desconectado: { phone_number_id: null,             planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: false },
  prueba:       { phone_number_id: 'pid-local-test', planPaid: false, trialDaysAgo: 30,   trialEnded: true,  subscriptionStatus: 'cancelled', seedConvs: false },
};
const cfg = ESTADO_CFG[ESTADO];

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// UTC helpers (SQLite stores datetimes as UTC text without Z)
function utcMinsAgo(m)  { return new Date(Date.now() - m * 60000).toISOString().replace('T', ' ').slice(0, 19); }
function utcDaysAgo(d)  { return new Date(Date.now() - d * 86400000).toISOString().replace('T', ' ').slice(0, 19); }

// ── 1. Usuario ────────────────────────────────────────────────────────────────
let user = db.prepare('SELECT * FROM users WHERE email = ?').get(TEST_EMAIL);
if (!user) {
  const hash = bcrypt.hashSync(TEST_PASS, 10);
  const r = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(TEST_EMAIL, hash);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  console.log('  [seed] Usuario creado:', TEST_EMAIL);
} else {
  // Siempre resetear password para que coincida con el script
  const hash = bcrypt.hashSync(TEST_PASS, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  console.log('  [seed] Usuario ok, password reseteado:', TEST_EMAIL);
}

// ── 2. Negocio ────────────────────────────────────────────────────────────────
let biz = user.business_id
  ? db.prepare('SELECT * FROM businesses WHERE id = ?').get(user.business_id)
  : null;

if (!biz) {
  const r = db.prepare(`
    INSERT INTO businesses (name, whatsapp_number, response_mode, response_delay)
    VALUES (?, ?, 'texto', 5)
  `).run('Peluquería Demo Local', '59891000000');
  biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(r.lastInsertRowid);
  db.prepare('UPDATE users SET business_id = ? WHERE id = ?').run(biz.id, user.id);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  console.log('  [seed] Negocio creado: Peluquería Demo Local');
} else {
  console.log('  [seed] Negocio existente:', biz.name || biz.id);
}

// Aplicar config de estado al negocio
db.prepare(`
  UPDATE businesses
  SET phone_number_id       = ?,
      plan_paid_at          = ?,
      trial_starts_at       = ?,
      trial_ends_at         = ?,
      trial_grace_started_at = NULL,
      trial_warned_at       = NULL,
      subscription_status   = ?
  WHERE id = ?
`).run(
  cfg.phone_number_id,
  cfg.planPaid ? utcMinsAgo(0) : null,
  cfg.trialDaysAgo ? utcDaysAgo(cfg.trialDaysAgo) : null,
  cfg.trialEnded   ? utcDaysAgo(3)                : null,
  cfg.subscriptionStatus,
  biz.id
);
console.log('  [seed] Estado: ' + ESTADO + ' | WA=' + (cfg.phone_number_id || 'null') + ' | plan_paid=' + cfg.planPaid + ' | trial_ends=' + (cfg.trialEnded ? '3d atrás' : 'null') + ' | sub=' + cfg.subscriptionStatus);

const bizId = biz.id;

// ── 3. Limpiar convs y datos relacionados (idempotente) ───────────────────────
const existingIds = db.prepare('SELECT id FROM conversations WHERE business_id = ?').all(bizId).map(c => c.id);
if (existingIds.length > 0) {
  const ph = existingIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM messages WHERE conversation_id IN (${ph})`).run(...existingIds);
  db.prepare(`DELETE FROM conversation_tags WHERE conversation_id IN (${ph})`).run(...existingIds);
  db.prepare(`DELETE FROM conversations WHERE id IN (${ph})`).run(...existingIds);
}
db.prepare('DELETE FROM excluded_contacts WHERE business_id = ?').run(bizId);
console.log('  [seed] Datos anteriores limpiados');

// ── 4. Conversaciones ─────────────────────────────────────────────────────────
if (!cfg.seedConvs) {
  db.close();
  console.log('  [seed] Listo. 0 conversaciones (estado=' + ESTADO + ')\n');
  process.exit(0);
}

// Conv A — 3 mensajes hoy, cliente+bot+cliente (la que aparece en la tarjeta de Inicio)
const rA = db.prepare(`
  INSERT INTO conversations (business_id, customer_id, needs_attention, created_at)
  VALUES (?, '59891234567', 0, ?)
`).run(bizId, utcMinsAgo(65));
db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'user',      ?, 0, ?)`).run(rA.lastInsertRowid, 'Hola, ¿cuánto sale el corte de pelo?',                                    utcMinsAgo(65));
db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'assistant', ?, 0, ?)`).run(rA.lastInsertRowid, 'Hola! El corte simple sale $350 y con lavado $450. ¿Te agendo un turno?', utcMinsAgo(60));
db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'user',      ?, 0, ?)`).run(rA.lastInsertRowid, '¿Tienen el martes a las 10?',                                           utcMinsAgo(55));
console.log('  [seed] Conv A: +598 91 234 567 — 3 mensajes hoy (cliente+bot+cliente)');

// Conv B — excluida ("Atiendo yo"), mensaje de ayer
const rB = db.prepare(`
  INSERT INTO conversations (business_id, customer_id, needs_attention, created_at)
  VALUES (?, '59899876543', 0, ?)
`).run(bizId, utcDaysAgo(1));
db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'user', ?, 0, ?)`).run(rB.lastInsertRowid, 'Soy el proveedor, paso a las 3.', utcDaysAgo(1));
try {
  db.prepare('INSERT INTO excluded_contacts (business_id, phone, source) VALUES (?, ?, ?)').run(bizId, '59899876543', 'manual');
} catch (_) { /* migration 012 may not exist */ }
console.log('  [seed] Conv B: +598 99 876 543 — excluida (Atiendo yo)');

// Conv C — needs_attention=1 (paused), mensaje de hoy
const rC = db.prepare(`
  INSERT INTO conversations (business_id, customer_id, needs_attention, created_at)
  VALUES (?, '59894561234', 1, ?)
`).run(bizId, utcMinsAgo(30));
db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'user', ?, 0, ?)`).run(rC.lastInsertRowid, 'Necesito hablar con alguien del equipo, por favor.', utcMinsAgo(30));
console.log('  [seed] Conv C: +598 94 561 234 — needs_attention=1');

// Conv D — mensaje de imagen + respuesta bot, de hoy
const rD = db.prepare(`
  INSERT INTO conversations (business_id, customer_id, needs_attention, created_at)
  VALUES (?, '59897654321', 0, ?)
`).run(bizId, utcMinsAgo(15));
db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'user',      ?, 0, ?)`).run(rD.lastInsertRowid, '[imagen] foto de referencia del corte',               utcMinsAgo(15));
db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'assistant', ?, 0, ?)`).run(rD.lastInsertRowid, 'Muy lindo estilo. ¿Para cuándo querés el turno?', utcMinsAgo(10));
console.log('  [seed] Conv D: +598 97 654 321 — imagen + respuesta bot');

db.close();
console.log('  [seed] Listo. 4 conversaciones en data-local-test/daxos.db\n');
