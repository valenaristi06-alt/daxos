const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// AES-256-GCM helpers — key must be 32-byte hex in ENCRYPTION_KEY env var
const ENC_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : null;

function encrypt(plaintext) {
  if (!plaintext) return null;
  if (!ENC_KEY) throw new Error('ENCRYPTION_KEY not set');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  if (!ENC_KEY) throw new Error('ENCRYPTION_KEY not set');
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}

const DB_DIR = path.join(__dirname, '../data');
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'daxos.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Non-businesses tables (no migration needed)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id   INTEGER REFERENCES businesses(id),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    customer_id TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Businesses table: create or migrate to latest schema
const wnCol = db.prepare("PRAGMA table_info(businesses)").all().find(c => c.name === 'whatsapp_number');
if (!wnCol) {
  db.exec(`
    CREATE TABLE businesses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      whatsapp_number TEXT UNIQUE,
      sales_examples  TEXT,
      survey_answers  TEXT,
      style_profile   TEXT,
      response_mode   TEXT NOT NULL DEFAULT 'texto',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
} else if (wnCol.notnull === 1) {
  // Multi-statement exec doesn't work reliably for DDL — use separate calls.
  // Must also recreate FK-dependent tables since SQLite doesn't update FK refs on rename.
  db.pragma('foreign_keys = OFF');
  db.exec('ALTER TABLE conversations RENAME TO _conversations_tmp');
  db.exec('ALTER TABLE businesses RENAME TO _businesses_tmp');
  db.exec(`CREATE TABLE businesses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    whatsapp_number TEXT UNIQUE,
    sales_examples  TEXT,
    survey_answers  TEXT,
    response_mode   TEXT NOT NULL DEFAULT 'texto',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('INSERT INTO businesses SELECT * FROM _businesses_tmp');
  db.exec('DROP TABLE _businesses_tmp');
  db.exec(`CREATE TABLE conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    customer_id TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('INSERT INTO conversations SELECT * FROM _conversations_tmp');
  db.exec('DROP TABLE _conversations_tmp');
  db.pragma('foreign_keys = ON');
}

// Add new nullable columns if missing — safe ALTER TABLE
const businessCols = db.prepare("PRAGMA table_info(businesses)").all().map(c => c.name);
if (!businessCols.includes('style_profile'))    db.exec('ALTER TABLE businesses ADD COLUMN style_profile TEXT');
if (!businessCols.includes('voice_id'))         db.exec('ALTER TABLE businesses ADD COLUMN voice_id TEXT');
if (!businessCols.includes('voice_consent_at')) db.exec('ALTER TABLE businesses ADD COLUMN voice_consent_at TEXT');
if (!businessCols.includes('consent_text'))     db.exec('ALTER TABLE businesses ADD COLUMN consent_text TEXT');
if (!businessCols.includes('consent_by'))       db.exec('ALTER TABLE businesses ADD COLUMN consent_by TEXT');
if (!businessCols.includes('plan'))             db.exec("ALTER TABLE businesses ADD COLUMN plan TEXT NOT NULL DEFAULT 'arranque'");
if (!businessCols.includes('trial_ends_at'))    db.exec('ALTER TABLE businesses ADD COLUMN trial_ends_at TEXT');
if (!businessCols.includes('pause_keywords'))    db.exec('ALTER TABLE businesses ADD COLUMN pause_keywords TEXT');
if (!businessCols.includes('response_delay'))    db.exec('ALTER TABLE businesses ADD COLUMN response_delay INTEGER NOT NULL DEFAULT 5');

const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');

const convCols = db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name);
if (!convCols.includes('needs_attention'))      db.exec('ALTER TABLE conversations ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0');
if (!convCols.includes('label'))                db.exec('ALTER TABLE conversations ADD COLUMN label TEXT');
if (!convCols.includes('booking_state'))        db.exec('ALTER TABLE conversations ADD COLUMN booking_state TEXT');

const bizCols = db.prepare("PRAGMA table_info(businesses)").all().map(c => c.name);
if (!bizCols.includes('document_path'))         db.exec('ALTER TABLE businesses ADD COLUMN document_path TEXT');
if (!bizCols.includes('document_name'))         db.exec('ALTER TABLE businesses ADD COLUMN document_name TEXT');
if (!bizCols.includes('plan_expires_at'))        db.exec('ALTER TABLE businesses ADD COLUMN plan_expires_at TEXT');
if (!bizCols.includes('plan_paid_at'))           db.exec('ALTER TABLE businesses ADD COLUMN plan_paid_at TEXT');
if (!bizCols.includes('subscription_status'))    db.exec("ALTER TABLE businesses ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'active'");
if (!bizCols.includes('business_context'))       db.exec('ALTER TABLE businesses ADD COLUMN business_context TEXT');
if (!bizCols.includes('website_url'))            db.exec('ALTER TABLE businesses ADD COLUMN website_url TEXT');
if (!bizCols.includes('website_summary'))        db.exec('ALTER TABLE businesses ADD COLUMN website_summary TEXT');
if (!bizCols.includes('pricing_info'))           db.exec('ALTER TABLE businesses ADD COLUMN pricing_info TEXT');
if (!bizCols.includes('waba_id'))                db.exec('ALTER TABLE businesses ADD COLUMN waba_id TEXT');
if (!bizCols.includes('phone_number_id'))         db.exec('ALTER TABLE businesses ADD COLUMN phone_number_id TEXT');
if (!bizCols.includes('wa_access_token'))         db.exec('ALTER TABLE businesses ADD COLUMN wa_access_token TEXT');
if (!bizCols.includes('wa_payment_confirmed'))    db.exec('ALTER TABLE businesses ADD COLUMN wa_payment_confirmed INTEGER NOT NULL DEFAULT 0');

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_bookings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER NOT NULL REFERENCES businesses(id),
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    customer_phone  TEXT NOT NULL,
    client_name     TEXT NOT NULL,
    reason          TEXT NOT NULL,
    slots           TEXT NOT NULL,
    slot_code       TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','confirmed','rejected','expired')),
    confirmed_slot  TEXT,
    notified_at     TEXT,
    reminder_sent_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mp_payment_id   TEXT NOT NULL UNIQUE,
    payer_email     TEXT NOT NULL,
    amount          REAL,
    currency        TEXT,
    paid_at         TEXT,
    raw_json        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Schema migrations (run-once) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

(function runMigrations() {
  const applied = version => !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);

  if (!applied('002_trial_starts_at')) {
    const cols = db.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
    if (!cols.includes('trial_starts_at')) {
      db.exec('ALTER TABLE businesses ADD COLUMN trial_starts_at TEXT');
    }

    // Exclude review@daxos.lat — COALESCE(-1) so subquery null doesn't break WHERE
    const reviewId = db.prepare(`
      SELECT b.id FROM businesses b
      JOIN users u ON u.business_id = b.id
      WHERE u.email = 'review@daxos.lat'
    `).get()?.id ?? -1;

    // Businesses WITH phone_number_id: approximate trial_starts_at from existing trial_ends_at
    const withPhone = db.prepare(`
      UPDATE businesses
      SET trial_starts_at = datetime(trial_ends_at, '-14 days')
      WHERE phone_number_id IS NOT NULL
        AND trial_ends_at IS NOT NULL
        AND id != ?
    `).run(reviewId);

    // Businesses WITHOUT phone_number_id: clock hasn't started — clear both dates
    const withoutPhone = db.prepare(`
      UPDATE businesses
      SET trial_starts_at = NULL, trial_ends_at = NULL
      WHERE phone_number_id IS NULL
        AND id != ?
    `).run(reviewId);

    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('002_trial_starts_at');
    console.log(`[migration 002] trial_starts_at added. With phone: ${withPhone.changes} rows. Without phone: ${withoutPhone.changes} rows. Excluded review id: ${reviewId === -1 ? 'not found (none excluded)' : reviewId}`);
  }
})();

// --- businesses ---

function deserializeBusiness(row) {
  return {
    ...row,
    sales_examples: row.sales_examples ? JSON.parse(row.sales_examples) : null,
    survey_answers: row.survey_answers ? JSON.parse(row.survey_answers) : null,
    style_profile: row.style_profile ? JSON.parse(row.style_profile) : null,
    wa_access_token: ENC_KEY ? decrypt(row.wa_access_token) : row.wa_access_token,
  };
}

function saveWabaCredentials(businessId, { wabaId, phoneNumberId, accessToken }) {
  // Only start the trial clock on first connection — don't reset if already connected
  const existing = db.prepare('SELECT trial_starts_at FROM businesses WHERE id = ?').get(businessId);
  if (existing && !existing.trial_starts_at) {
    db.prepare(`
      UPDATE businesses
      SET waba_id = ?, phone_number_id = ?, wa_access_token = ?,
          trial_starts_at = datetime('now'),
          trial_ends_at   = datetime('now', '+14 days')
      WHERE id = ?
    `).run(wabaId, phoneNumberId, encrypt(accessToken), businessId);
  } else {
    db.prepare(`
      UPDATE businesses SET waba_id = ?, phone_number_id = ?, wa_access_token = ? WHERE id = ?
    `).run(wabaId, phoneNumberId, encrypt(accessToken), businessId);
  }
}

function setUserPhone(userId, phone) {
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone || null, userId);
}

function setStyleProfile(businessId, profile) {
  db.prepare('UPDATE businesses SET style_profile = ? WHERE id = ?')
    .run(JSON.stringify(profile), businessId);
}

function setWebsiteSummary(businessId, summary) {
  db.prepare('UPDATE businesses SET website_summary = ? WHERE id = ?').run(summary, businessId);
}

function saveVoiceConsent(businessId, { voiceId, consentText, consentBy }) {
  db.prepare(`
    UPDATE businesses
    SET voice_id = ?, voice_consent_at = datetime('now'), consent_text = ?, consent_by = ?
    WHERE id = ?
  `).run(voiceId, consentText, consentBy, businessId);
}

const stmtGetBusinessById = db.prepare('SELECT * FROM businesses WHERE id = ?');

function getBusinessById(id) {
  const row = stmtGetBusinessById.get(id);
  if (!row) return null;
  return deserializeBusiness(row);
}

function markConversationPaused(conversationId) {
  db.prepare('UPDATE conversations SET needs_attention = 1 WHERE id = ?').run(conversationId);
}

function markConversationResumed(conversationId) {
  db.prepare('UPDATE conversations SET needs_attention = 0 WHERE id = ?').run(conversationId);
}

function upsertBusiness({ id, name, whatsapp_number = null, sales_examples = null, survey_answers = null, business_context = null, website_url = null, response_mode = 'texto', pause_keywords = null, response_delay = 5, pricing_info = null }) {
  const serialized = {
    name,
    whatsapp_number: whatsapp_number || null,
    sales_examples: sales_examples != null ? JSON.stringify(sales_examples) : null,
    survey_answers: survey_answers != null ? JSON.stringify(survey_answers) : null,
    business_context: business_context || null,
    website_url: website_url || null,
    response_mode,
    pause_keywords: pause_keywords || null,
    response_delay: Number(response_delay) || 5,
    pricing_info: pricing_info || null,
  };

  if (id) {
    db.prepare(`
      UPDATE businesses SET name=@name, whatsapp_number=@whatsapp_number,
        sales_examples=@sales_examples, survey_answers=@survey_answers,
        business_context=@business_context, website_url=@website_url,
        response_mode=@response_mode, pause_keywords=@pause_keywords,
        response_delay=@response_delay, pricing_info=@pricing_info
      WHERE id=@id
    `).run({ ...serialized, id });
    return getBusinessById(id);
  }

  if (whatsapp_number) {
    const result = db.prepare(`
      INSERT INTO businesses (name, whatsapp_number, sales_examples, survey_answers, business_context, website_url, response_mode, response_delay, pricing_info)
      VALUES (@name, @whatsapp_number, @sales_examples, @survey_answers, @business_context, @website_url, @response_mode, @response_delay, @pricing_info)
      ON CONFLICT(whatsapp_number) DO UPDATE SET
        name=excluded.name, sales_examples=excluded.sales_examples,
        survey_answers=excluded.survey_answers, business_context=excluded.business_context,
        website_url=excluded.website_url, response_mode=excluded.response_mode,
        response_delay=excluded.response_delay, pricing_info=excluded.pricing_info
    `).run(serialized);
    const rowId = result.lastInsertRowid || db.prepare('SELECT id FROM businesses WHERE whatsapp_number = ?').get(whatsapp_number).id;
    return getBusinessById(rowId);
  }

  const result = db.prepare(`
    INSERT INTO businesses (name, sales_examples, survey_answers, business_context, website_url, response_mode, response_delay, pricing_info)
    VALUES (@name, @sales_examples, @survey_answers, @business_context, @website_url, @response_mode, @response_delay, @pricing_info)
  `).run(serialized);
  return getBusinessById(result.lastInsertRowid);
}

const stmtGetBusinessByPhone = db.prepare('SELECT * FROM businesses WHERE whatsapp_number = ?');

function getBusinessByWhatsappNumber(number) {
  const row = stmtGetBusinessByPhone.get(String(number));
  if (!row) return null;
  return deserializeBusiness(row);
}

function getBusinessByUserId(userId) {
  const row = db.prepare(`
    SELECT b.* FROM businesses b
    INNER JOIN users u ON u.business_id = b.id
    WHERE u.id = ?
  `).get(userId);
  if (!row) return null;
  return deserializeBusiness(row);
}

function setUserBusiness(userId, businessId) {
  db.prepare('UPDATE users SET business_id = ? WHERE id = ?').run(businessId, userId);
}

function getUserByBusinessId(businessId) {
  return db.prepare('SELECT * FROM users WHERE business_id = ?').get(businessId) || null;
}

// --- conversations ---

const stmtGetConversationsByBusiness = db.prepare(`
  SELECT * FROM conversations WHERE business_id = ? ORDER BY created_at DESC
`);

function getConversationsByBusinessId(businessId) {
  return stmtGetConversationsByBusiness.all(businessId);
}

const stmtGetConversationById = db.prepare('SELECT * FROM conversations WHERE id = ?');

function getConversationById(id) {
  return stmtGetConversationById.get(id) || null;
}

const stmtGetConversation = db.prepare(`
  SELECT * FROM conversations WHERE business_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 1
`);
const stmtCreateConversation = db.prepare(`
  INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)
`);

function getOrCreateConversation(business_id, customer_id) {
  let row = stmtGetConversation.get(business_id, customer_id);
  if (row) return row;
  const result = stmtCreateConversation.run(business_id, customer_id);
  return { id: result.lastInsertRowid, business_id, customer_id };
}

function getConversationCountByBusinessId(businessId) {
  return db.prepare('SELECT COUNT(*) as count FROM conversations WHERE business_id = ?').get(businessId).count;
}

const stmtLastCustomerMsg = db.prepare(`
  SELECT c.customer_id, m.content, m.created_at as msg_at
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.business_id = ? AND m.role = 'user'
  ORDER BY m.created_at DESC
  LIMIT 1
`);

function getLastCustomerMessage(businessId) {
  return stmtLastCustomerMsg.get(businessId) || null;
}

// --- messages ---

const stmtAddMessage = db.prepare(`
  INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)
`);

function addMessage(conversation_id, role, content) {
  const result = stmtAddMessage.run(conversation_id, role, content);
  return result.lastInsertRowid;
}

const stmtGetHistory = db.prepare(`
  SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?
`);

function getConversationHistory(conversation_id, limit = 50) {
  return stmtGetHistory.all(conversation_id, limit);
}

function setConversationLabel(conversationId, label) {
  db.prepare('UPDATE conversations SET label = ? WHERE id = ?').run(label || null, conversationId);
}

function setBusinessDocument(businessId, documentPath, documentName) {
  db.prepare('UPDATE businesses SET document_path = ?, document_name = ? WHERE id = ?')
    .run(documentPath, documentName, businessId);
}

function clearBusinessDocument(businessId) {
  db.prepare('UPDATE businesses SET document_path = NULL, document_name = NULL WHERE id = ?')
    .run(businessId);
}

function getDailyConversationStats(businessId) {
  const rows = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM conversations
    WHERE business_id = ?
      AND created_at >= date('now', '-6 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(businessId);

  const map = {};
  rows.forEach(r => { map[r.day] = r.count; });

  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    result.push({ day, count: map[day] || 0 });
  }
  return result;
}

function getTodayStats(businessId) {
  const messages24h = db.prepare(`
    SELECT COUNT(*) as count FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.business_id = ? AND m.created_at >= datetime('now', '-1 day')
  `).get(businessId).count;

  const uniqueClientsToday = db.prepare(`
    SELECT COUNT(DISTINCT c.customer_id) as count FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.business_id = ? AND date(m.created_at, '-3 hours') = date('now', '-3 hours')
  `).get(businessId).count;

  const pausedToday = db.prepare(`
    SELECT COUNT(*) as count FROM conversations c
    WHERE c.business_id = ? AND c.needs_attention = 1
    AND EXISTS (
      SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND date(m.created_at, '-3 hours') = date('now', '-3 hours')
    )
  `).get(businessId).count;

  const resolvedToday = db.prepare(`
    SELECT COUNT(*) as count FROM conversations c
    WHERE c.business_id = ? AND c.needs_attention = 0
    AND EXISTS (
      SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND date(m.created_at, '-3 hours') = date('now', '-3 hours')
    )
  `).get(businessId).count;

  return { messages24h, uniqueClientsToday, pausedToday, resolvedToday };
}

function getDailyMessageStats(businessId) {
  const rows = db.prepare(`
    SELECT date(m.created_at, '-3 hours') as day, COUNT(*) as count
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.business_id = ? AND m.created_at >= date('now', '-3 hours', '-6 days')
    GROUP BY date(m.created_at, '-3 hours')
    ORDER BY day ASC
  `).all(businessId);

  const map = {};
  rows.forEach(r => { map[r.day] = r.count; });

  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    result.push({ day, count: map[day] || 0 });
  }
  return result;
}

// --- users ---

const stmtCreateUser = db.prepare(`
  INSERT INTO users (email, password_hash) VALUES (?, ?)
`);
const stmtGetUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const stmtGetUserById = db.prepare('SELECT * FROM users WHERE id = ?');

function createUser(email, passwordHash) {
  const result = stmtCreateUser.run(email, passwordHash);
  return stmtGetUserById.get(result.lastInsertRowid);
}

function getUserByEmail(email) {
  return stmtGetUserByEmail.get(email) || null;
}

function getUserById(id) {
  return stmtGetUserById.get(id) || null;
}

function upgradePlan(businessId, plan, paidAt, expiresAt) {
  db.prepare(`
    UPDATE businesses SET plan = ?, plan_paid_at = ?, plan_expires_at = ?, subscription_status = 'active' WHERE id = ?
  `).run(plan, paidAt, expiresAt, businessId);
}

function setSubscriptionStatus(businessId, status) {
  db.prepare('UPDATE businesses SET subscription_status = ? WHERE id = ?').run(status, businessId);
}

function savePendingPayment({ mpPaymentId, payerEmail, amount, currency, paidAt, rawJson }) {
  db.prepare(`
    INSERT OR IGNORE INTO pending_payments
      (mp_payment_id, payer_email, amount, currency, paid_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(mpPaymentId, payerEmail, amount ?? null, currency ?? null, paidAt ?? null, rawJson ?? null);
}

function getPendingPayments() {
  return db.prepare('SELECT * FROM pending_payments ORDER BY created_at DESC').all();
}

function setWaPaymentConfirmed(businessId) {
  db.prepare('UPDATE businesses SET wa_payment_confirmed = 1 WHERE id = ?').run(businessId);
}

function getTrialMessageCount(businessId, trialStartsAt) {
  return db.prepare(`
    SELECT COUNT(*) as n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.business_id = ? AND m.role = 'user' AND m.created_at >= ?
  `).get(businessId, trialStartsAt).n;
}

// --- admin queries (read-only) ---

function getAllBusinesses() {
  return db.prepare(`
    SELECT
      b.id, b.name, b.plan, b.trial_ends_at, b.plan_expires_at, b.subscription_status,
      b.created_at, b.whatsapp_number, b.response_mode, b.voice_id, b.website_url,
      u.email as owner_email,
      (SELECT COUNT(*) FROM conversations c WHERE c.business_id = b.id) as conv_count,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = b.id) as msg_count,
      (SELECT m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = b.id ORDER BY m.created_at DESC LIMIT 1) as last_msg_at
    FROM businesses b
    LEFT JOIN users u ON u.business_id = b.id
    ORDER BY b.created_at DESC
  `).all();
}

function getGlobalStats() {
  const totalBusinesses = db.prepare('SELECT COUNT(*) as n FROM businesses').get().n;
  const trialCount      = db.prepare(`SELECT COUNT(*) as n FROM businesses WHERE plan = 'arranque'`).get().n;
  const payingCount     = db.prepare(`SELECT COUNT(*) as n FROM businesses WHERE plan != 'arranque'`).get().n;
  const totalMessages   = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
  const messagesThisMonth = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE created_at >= date('now','start of month')`).get().n;
  const aiRepliesThisMonth = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE role='assistant' AND created_at >= date('now','start of month')`).get().n;
  const voiceRepliesThisMonth = db.prepare(`
    SELECT COUNT(*) as n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN businesses b ON b.id = c.business_id
    WHERE m.role = 'assistant' AND b.voice_id IS NOT NULL
      AND m.created_at >= date('now','start of month')
  `).get().n;
  return { totalBusinesses, trialCount, payingCount, totalMessages, messagesThisMonth, aiRepliesThisMonth, voiceRepliesThisMonth };
}

function getBusinessAdminMetrics(businessId) {
  const conversations    = db.prepare('SELECT COUNT(*) as n FROM conversations WHERE business_id = ?').get(businessId).n;
  const totalMessages    = db.prepare(`SELECT COUNT(*) as n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = ?`).get(businessId).n;
  const aiReplies        = db.prepare(`SELECT COUNT(*) as n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = ? AND m.role = 'assistant'`).get(businessId).n;
  const paused           = db.prepare('SELECT COUNT(*) as n FROM conversations WHERE business_id = ? AND needs_attention = 1').get(businessId).n;
  const messagesThisMonth = db.prepare(`SELECT COUNT(*) as n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = ? AND m.created_at >= date('now','start of month')`).get(businessId).n;
  return { conversations, totalMessages, aiReplies, paused, messagesThisMonth };
}

function getPlanCounts() {
  return db.prepare('SELECT plan, COUNT(*) as count FROM businesses GROUP BY plan').all();
}

// --- pending_bookings ---

function generateBookingCode() {
  // Two uppercase letters, e.g. "AB". 676 combinations — sufficient for one business's open bookings.
  return Array.from({ length: 2 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26))
  ).join('');
}

function createBooking({ businessId, conversationId, customerPhone, clientName, reason, slots }) {
  // slots: string[] — up to 3 free-text options the client proposed
  let code;
  let attempts = 0;
  do {
    code = generateBookingCode();
    attempts++;
    if (attempts > 50) throw new Error('Could not generate unique booking code after 50 attempts');
  } while (db.prepare("SELECT 1 FROM pending_bookings WHERE slot_code = ? AND status = 'pending'").get(code));

  const result = db.prepare(`
    INSERT INTO pending_bookings
      (business_id, conversation_id, customer_phone, client_name, reason, slots, slot_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(businessId, conversationId, customerPhone, clientName, reason, JSON.stringify(slots), code);

  console.log(`[booking] created id=${result.lastInsertRowid} code=${code} business=${businessId} customer=${customerPhone}`);
  return getBookingById(result.lastInsertRowid);
}

function getBookingById(id) {
  const row = db.prepare('SELECT * FROM pending_bookings WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, slots: JSON.parse(row.slots) };
}

function getBookingByCode(code) {
  const row = db.prepare("SELECT * FROM pending_bookings WHERE slot_code = ? AND status = 'pending'").get(code.toUpperCase());
  if (!row) return null;
  return { ...row, slots: JSON.parse(row.slots) };
}

function getPendingBookingsByBusiness(businessId) {
  return db.prepare(`
    SELECT * FROM pending_bookings WHERE business_id = ? AND status = 'pending' ORDER BY created_at ASC
  `).all(businessId).map(r => ({ ...r, slots: JSON.parse(r.slots) }));
}

function confirmBooking(bookingId, confirmedSlot) {
  db.prepare(`
    UPDATE pending_bookings
    SET status = 'confirmed', confirmed_slot = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(confirmedSlot, bookingId);
  console.log(`[booking] confirmed id=${bookingId} slot="${confirmedSlot}"`);
}

function rejectBooking(bookingId) {
  db.prepare(`
    UPDATE pending_bookings
    SET status = 'rejected', updated_at = datetime('now')
    WHERE id = ?
  `).run(bookingId);
  console.log(`[booking] rejected id=${bookingId}`);
}

function expireBooking(bookingId) {
  db.prepare(`
    UPDATE pending_bookings
    SET status = 'expired', updated_at = datetime('now')
    WHERE id = ?
  `).run(bookingId);
  console.log(`[booking] expired id=${bookingId}`);
}

function markBookingNotified(bookingId) {
  db.prepare(`
    UPDATE pending_bookings SET notified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).run(bookingId);
}

function markBookingReminderSent(bookingId) {
  db.prepare(`
    UPDATE pending_bookings SET reminder_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).run(bookingId);
}

// Returns bookings that should trigger a timeout action.
// firstTimeoutMinutes: minutes before sending reminder (default 240 = 4h)
// expireMinutes: minutes before expiring after reminder (default 120 = 2h)
function getBookingsNeedingTimeout({ firstTimeoutMinutes = 240, expireMinutes = 120 } = {}) {
  return db.prepare(`
    SELECT * FROM pending_bookings
    WHERE status = 'pending'
      AND (
        (notified_at IS NOT NULL AND reminder_sent_at IS NULL
          AND notified_at <= datetime('now', ? || ' minutes'))
        OR
        (reminder_sent_at IS NOT NULL
          AND reminder_sent_at <= datetime('now', ? || ' minutes'))
      )
    ORDER BY created_at ASC
  `).all(`-${firstTimeoutMinutes}`, `-${expireMinutes}`)
    .map(r => ({ ...r, slots: JSON.parse(r.slots) }));
}

// --- booking_state on conversations ---

function setBookingState(conversationId, state) {
  db.prepare('UPDATE conversations SET booking_state = ? WHERE id = ?')
    .run(state ? JSON.stringify(state) : null, conversationId);
}

function getBookingState(conversationId) {
  const row = db.prepare('SELECT booking_state FROM conversations WHERE id = ?').get(conversationId);
  if (!row?.booking_state) return null;
  return JSON.parse(row.booking_state);
}

module.exports = {
  setUserPhone,
  setStyleProfile,
  setWebsiteSummary,
  saveVoiceConsent,
  createUser,
  getUserByEmail,
  getUserById,
  getUserByBusinessId,
  upsertBusiness,
  getBusinessById,
  getBusinessByWhatsappNumber,
  getBusinessByUserId,
  setUserBusiness,
  getConversationsByBusinessId,
  getConversationCountByBusinessId,
  getLastCustomerMessage,
  getConversationById,
  getOrCreateConversation,
  addMessage,
  getConversationHistory,
  markConversationPaused,
  markConversationResumed,
  getDailyConversationStats,
  getTodayStats,
  getDailyMessageStats,
  setConversationLabel,
  setBusinessDocument,
  clearBusinessDocument,
  upgradePlan,
  setSubscriptionStatus,
  savePendingPayment,
  getPendingPayments,
  getAllBusinesses,
  getGlobalStats,
  getBusinessAdminMetrics,
  getPlanCounts,
  saveWabaCredentials,
  setWaPaymentConfirmed,
  getTrialMessageCount,
  createBooking,
  getBookingById,
  getBookingByCode,
  getPendingBookingsByBusiness,
  confirmBooking,
  rejectBooking,
  expireBooking,
  markBookingNotified,
  markBookingReminderSent,
  getBookingsNeedingTimeout,
  setBookingState,
  getBookingState,
  checkpoint,
  closeDb,
};

function checkpoint() {
  return db.pragma('wal_checkpoint(FULL)');
}

function closeDb() {
  db.close();
}
