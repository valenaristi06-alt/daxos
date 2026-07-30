const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/daxos.db'));

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

const bizCols = db.prepare("PRAGMA table_info(businesses)").all().map(c => c.name);
if (!bizCols.includes('document_path'))         db.exec('ALTER TABLE businesses ADD COLUMN document_path TEXT');
if (!bizCols.includes('document_name'))         db.exec('ALTER TABLE businesses ADD COLUMN document_name TEXT');
if (!bizCols.includes('plan_expires_at'))        db.exec('ALTER TABLE businesses ADD COLUMN plan_expires_at TEXT');
if (!bizCols.includes('plan_paid_at'))           db.exec('ALTER TABLE businesses ADD COLUMN plan_paid_at TEXT');
if (!bizCols.includes('subscription_status'))    db.exec("ALTER TABLE businesses ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'active'");
if (!bizCols.includes('business_context'))       db.exec('ALTER TABLE businesses ADD COLUMN business_context TEXT');
if (!bizCols.includes('website_url'))            db.exec('ALTER TABLE businesses ADD COLUMN website_url TEXT');
if (!bizCols.includes('website_summary'))        db.exec('ALTER TABLE businesses ADD COLUMN website_summary TEXT');

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

// --- businesses ---

function deserializeBusiness(row) {
  return {
    ...row,
    sales_examples: row.sales_examples ? JSON.parse(row.sales_examples) : null,
    survey_answers: row.survey_answers ? JSON.parse(row.survey_answers) : null,
    style_profile: row.style_profile ? JSON.parse(row.style_profile) : null,
  };
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

function upsertBusiness({ id, name, whatsapp_number = null, sales_examples = null, survey_answers = null, business_context = null, website_url = null, response_mode = 'texto', pause_keywords = null, response_delay = 5 }) {
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
  };

  if (id) {
    db.prepare(`
      UPDATE businesses SET name=@name, whatsapp_number=@whatsapp_number,
        sales_examples=@sales_examples, survey_answers=@survey_answers,
        business_context=@business_context, website_url=@website_url,
        response_mode=@response_mode, pause_keywords=@pause_keywords,
        response_delay=@response_delay
      WHERE id=@id
    `).run({ ...serialized, id });
    return getBusinessById(id);
  }

  if (whatsapp_number) {
    const result = db.prepare(`
      INSERT INTO businesses (name, whatsapp_number, sales_examples, survey_answers, business_context, website_url, response_mode, response_delay, trial_ends_at)
      VALUES (@name, @whatsapp_number, @sales_examples, @survey_answers, @business_context, @website_url, @response_mode, @response_delay, datetime('now', '+14 days'))
      ON CONFLICT(whatsapp_number) DO UPDATE SET
        name=excluded.name, sales_examples=excluded.sales_examples,
        survey_answers=excluded.survey_answers, business_context=excluded.business_context,
        website_url=excluded.website_url, response_mode=excluded.response_mode,
        response_delay=excluded.response_delay
    `).run(serialized);
    const rowId = result.lastInsertRowid || db.prepare('SELECT id FROM businesses WHERE whatsapp_number = ?').get(whatsapp_number).id;
    return getBusinessById(rowId);
  }

  const result = db.prepare(`
    INSERT INTO businesses (name, sales_examples, survey_answers, business_context, website_url, response_mode, response_delay, trial_ends_at)
    VALUES (@name, @sales_examples, @survey_answers, @business_context, @website_url, @response_mode, @response_delay, datetime('now', '+14 days'))
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
  getDailyConversationStats,
  setConversationLabel,
  setBusinessDocument,
  clearBusinessDocument,
  upgradePlan,
  setSubscriptionStatus,
  savePendingPayment,
  getPendingPayments,
};
