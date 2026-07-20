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

// Add style_profile column if missing (safe ALTER TABLE for new nullable column)
const hasStyleProfile = db.prepare("PRAGMA table_info(businesses)").all().some(c => c.name === 'style_profile');
if (!hasStyleProfile) {
  db.exec('ALTER TABLE businesses ADD COLUMN style_profile TEXT');
}

// --- businesses ---

function deserializeBusiness(row) {
  return {
    ...row,
    sales_examples: row.sales_examples ? JSON.parse(row.sales_examples) : null,
    survey_answers: row.survey_answers ? JSON.parse(row.survey_answers) : null,
    style_profile: row.style_profile ? JSON.parse(row.style_profile) : null,
  };
}

function setStyleProfile(businessId, profile) {
  db.prepare('UPDATE businesses SET style_profile = ? WHERE id = ?')
    .run(JSON.stringify(profile), businessId);
}

const stmtGetBusinessById = db.prepare('SELECT * FROM businesses WHERE id = ?');

function getBusinessById(id) {
  const row = stmtGetBusinessById.get(id);
  if (!row) return null;
  return deserializeBusiness(row);
}

function upsertBusiness({ id, name, whatsapp_number = null, sales_examples = null, survey_answers = null, response_mode = 'texto' }) {
  const serialized = {
    name,
    whatsapp_number: whatsapp_number || null,
    sales_examples: sales_examples != null ? JSON.stringify(sales_examples) : null,
    survey_answers: survey_answers != null ? JSON.stringify(survey_answers) : null,
    response_mode,
  };

  if (id) {
    db.prepare(`
      UPDATE businesses SET name=@name, whatsapp_number=@whatsapp_number,
        sales_examples=@sales_examples, survey_answers=@survey_answers, response_mode=@response_mode
      WHERE id=@id
    `).run({ ...serialized, id });
    return getBusinessById(id);
  }

  if (whatsapp_number) {
    const result = db.prepare(`
      INSERT INTO businesses (name, whatsapp_number, sales_examples, survey_answers, response_mode)
      VALUES (@name, @whatsapp_number, @sales_examples, @survey_answers, @response_mode)
      ON CONFLICT(whatsapp_number) DO UPDATE SET
        name=excluded.name, sales_examples=excluded.sales_examples,
        survey_answers=excluded.survey_answers, response_mode=excluded.response_mode
    `).run(serialized);
    const rowId = result.lastInsertRowid || db.prepare('SELECT id FROM businesses WHERE whatsapp_number = ?').get(whatsapp_number).id;
    return getBusinessById(rowId);
  }

  const result = db.prepare(`
    INSERT INTO businesses (name, sales_examples, survey_answers, response_mode)
    VALUES (@name, @sales_examples, @survey_answers, @response_mode)
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

module.exports = {
  setStyleProfile,
  createUser,
  getUserByEmail,
  getUserById,
  upsertBusiness,
  getBusinessById,
  getBusinessByWhatsappNumber,
  getBusinessByUserId,
  setUserBusiness,
  getConversationsByBusinessId,
  getConversationById,
  getOrCreateConversation,
  addMessage,
  getConversationHistory,
};
