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
const ESTADOS_VALIDOS = ['activo', 'vacio', 'desconectado', 'prueba', 'tope', 'agenda'];
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
  activo:       { phone_number_id: 'pid-local-test', planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: true,  seedAgenda: false },
  vacio:        { phone_number_id: 'pid-local-test', planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: false, seedAgenda: false },
  desconectado: { phone_number_id: null,             planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: false, seedAgenda: false },
  prueba:       { phone_number_id: 'pid-local-test', planPaid: false, trialDaysAgo: 30,   trialEnded: true,  subscriptionStatus: 'cancelled', seedConvs: false, seedAgenda: false },
  tope:         { phone_number_id: 'pid-local-test', planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: false, seedAgenda: false },
  agenda:       { phone_number_id: 'pid-local-test', planPaid: true,  trialDaysAgo: null, trialEnded: false, subscriptionStatus: 'active',    seedConvs: false, seedAgenda: true  },
};
const cfg = ESTADO_CFG[ESTADO];

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// UTC helpers (SQLite stores datetimes as UTC text without Z)
function utcMinsAgo(m)  { return new Date(Date.now() - m * 60000).toISOString().replace('T', ' ').slice(0, 19); }
function utcDaysAgo(d)  { return new Date(Date.now() - d * 86400000).toISOString().replace('T', ' ').slice(0, 19); }
// MVD (UTC-3) date+time → UTC ISO for agenda_appointments
function mvdToUtc(dateStr, hhmm) { return new Date(`${dateStr}T${hhmm}:00-03:00`).toISOString(); }

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

// ── 4. Estado "tope": cupo alcanzado + una conv sin responder ─────────────────
if (ESTADO === 'tope') {
  const todayMvd = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
  // Set anthropic_calls = 70 (arranque daily cap) for today
  db.prepare(`
    INSERT INTO spending_counters (business_id, date, anthropic_calls, elevenlabs_chars, preview_calls)
    VALUES (?, ?, 70, 0, 0)
    ON CONFLICT(business_id, date) DO UPDATE SET anthropic_calls = 70
  `).run(bizId, todayMvd);
  console.log('  [seed] spending_counters: anthropic_calls=70 (cap alcanzado) para ' + todayMvd);

  // One unanswered conversation — paused_reason='spending_cap', needs_attention=1
  const rT = db.prepare(`
    INSERT INTO conversations (business_id, customer_id, needs_attention, paused_at, paused_reason, created_at)
    VALUES (?, '59891230001', 1, unixepoch(), 'spending_cap', ?)
  `).run(bizId, utcMinsAgo(5));
  db.prepare(`INSERT INTO messages (conversation_id, role, content, silent, created_at) VALUES (?, 'user', ?, 0, ?)`)
    .run(rT.lastInsertRowid, '¿Tienen turno para mañana a las 11?', utcMinsAgo(5));
  console.log('  [seed] Conv T: +598 91 230 001 — sin respuesta (tope alcanzado)');

  db.close();
  console.log('  [seed] Listo. Estado=tope — alerta roja visible en Inicio.\n');
  process.exit(0);
}

// ── 4b. Estado "agenda": plan Crecimiento, agenda activa, servicios y turnos ──
if (cfg.seedAgenda) {
  db.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run('crecimiento', bizId);
  const bh = JSON.stringify({ 1:[['09:00','18:00']], 2:[['09:00','18:00']], 3:[['09:00','18:00']], 4:[['09:00','18:00']], 5:[['09:00','18:00']], 6:[['09:00','13:00']] });
  db.prepare('UPDATE businesses SET business_hours = ?, agenda_enabled = 1, agenda_slot_min = 30, agenda_cancel_min_before = 120 WHERE id = ?').run(bh, bizId);

  const svcs = [
    { name: 'Corte de pelo', duration_min: 30 },
    { name: 'Corte + lavado', duration_min: 45 },
    { name: 'Coloración', duration_min: 120 },
  ];
  db.prepare('DELETE FROM agenda_appointments WHERE business_id = ?').run(bizId);
  db.prepare('DELETE FROM agenda_services WHERE business_id = ?').run(bizId);
  svcs.forEach((s, i) => {
    db.prepare('INSERT INTO agenda_services (business_id, name, duration_min, sort_order) VALUES (?, ?, ?, ?)').run(bizId, s.name, s.duration_min, i);
  });
  const svcRows = db.prepare('SELECT id, name, duration_min FROM agenda_services WHERE business_id = ? AND active = 1 ORDER BY sort_order').all(bizId);

  function mvdDay(offset) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Montevideo' }).format(d);
  }
  const D = n => mvdDay(n);

  const allApts = [
    { date: D(-1),  phone: '59891000001', name: 'Roberto Silva',    svc: svcRows[2], time: '11:00' },
    { date: D(-1),  phone: '59891000002', name: 'Elena Fernández',  svc: svcRows[0], time: '16:00' },
    { date: D(0),   phone: '59891234567', name: 'María González',   svc: svcRows[0], time: '09:00' },
    { date: D(0),   phone: '59892345678', name: 'Carlos López',     svc: svcRows[1], time: '10:00' },
    { date: D(0),   phone: '59893456789', name: 'Ana Martínez',     svc: svcRows[2], time: '11:00' },
    { date: D(0),   phone: '59891000003', name: 'Pedro Ramírez',    svc: svcRows[0], time: '14:30' },
    { date: D(0),   phone: '59891000004', name: 'Laura Díaz',       svc: svcRows[1], time: '15:00', cancelled: true },
    { date: D(1),   phone: '59894567890', name: 'Luis García',      svc: svcRows[0], time: '09:30' },
    { date: D(1),   phone: '59895678901', name: 'Sofía Rodríguez',  svc: svcRows[1], time: '11:00' },
    { date: D(1),   phone: '59891000005', name: 'Diego Herrera',    svc: svcRows[2], time: '14:00' },
    { date: D(2),   phone: '59891000006', name: 'Valentina Castro', svc: svcRows[0], time: '10:00' },
    { date: D(2),   phone: '59891000007', name: 'Martín Flores',    svc: svcRows[1], time: '16:00' },
    { date: D(3),   phone: '59891000008', name: 'Camila Torres',    svc: svcRows[0], time: '09:00' },
    { date: D(3),   phone: '59891000009', name: 'Nicolás Morales',  svc: svcRows[2], time: '15:30' },
    { date: D(6),   phone: '59891000010', name: 'Fernanda Pereira', svc: svcRows[1], time: '10:00' },
    { date: D(6),   phone: '59891000011', name: 'Sergio Álvarez',   svc: svcRows[0], time: '14:00' },
    { date: D(8),   phone: '59891000012', name: 'Julia Ramos',      svc: svcRows[2], time: '09:00' },
    { date: D(8),   phone: '59891000013', name: 'Gustavo Méndez',   svc: svcRows[0], time: '16:00' },
    { date: D(11),  phone: '59891000014', name: 'Patricia Vidal',   svc: svcRows[1], time: '11:00' },
    { date: D(11),  phone: '59891000015', name: 'Emilio Suárez',    svc: svcRows[0], time: '15:00' },
    { date: D(14),  phone: '59891000016', name: 'Santiago Ruiz',    svc: svcRows[2], time: '10:00' },
    { date: D(14),  phone: '59891000017', name: 'Carmen Ibáñez',    svc: svcRows[1], time: '13:00' },
    { date: D(17),  phone: '59891000018', name: 'Beatriz Sosa',     svc: svcRows[0], time: '09:30' },
    { date: D(21),  phone: '59891000019', name: 'Ramón Cabrera',    svc: svcRows[2], time: '11:00' },
    { date: D(24),  phone: '59891000020', name: 'Luisa Benítez',    svc: svcRows[1], time: '10:30' },
  ];

  allApts.forEach(a => {
    const dur      = a.svc?.duration_min ?? 30;
    const startsAt = mvdToUtc(a.date, a.time);
    const endsAt   = new Date(new Date(startsAt).getTime() + dur * 60_000).toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO agenda_appointments (business_id, service_id, customer_phone, client_name, starts_at, ends_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(bizId, a.svc?.id ?? null, a.phone, a.name, startsAt, endsAt, a.cancelled ? 'cancelled' : 'confirmed');
    console.log(`  [seed] Turno ${a.cancelled ? '(cancelado) ' : ''}${a.name || a.phone} ${a.date} ${a.time}`);
  });

  db.close();
  console.log(`  [seed] Listo. Plan=Crecimiento, agenda activa, 3 servicios, ${allApts.length} turnos.\n`);
  process.exit(0);
}

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
