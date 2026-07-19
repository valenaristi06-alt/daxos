const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/daxos.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL UNIQUE,
    sales_examples  TEXT,
    survey_answers  TEXT,
    response_mode   TEXT NOT NULL DEFAULT 'texto',
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

// --- businesses ---

const stmtUpsertBusiness = db.prepare(`
  INSERT INTO businesses (name, whatsapp_number, sales_examples, survey_answers, response_mode)
  VALUES (@name, @whatsapp_number, @sales_examples, @survey_answers, @response_mode)
  ON CONFLICT(whatsapp_number) DO UPDATE SET
    name            = excluded.name,
    sales_examples  = excluded.sales_examples,
    survey_answers  = excluded.survey_answers,
    response_mode   = excluded.response_mode
`);

function upsertBusiness({ name, whatsapp_number, sales_examples = null, survey_answers = null, response_mode = 'texto' }) {
  const row = {
    name,
    whatsapp_number,
    sales_examples: sales_examples != null ? JSON.stringify(sales_examples) : null,
    survey_answers: survey_answers != null ? JSON.stringify(survey_answers) : null,
    response_mode,
  };
  const result = stmtUpsertBusiness.run(row);
  return getBusinessById(result.lastInsertRowid || db.prepare('SELECT id FROM businesses WHERE whatsapp_number = ?').get(whatsapp_number).id);
}

const stmtGetBusinessById = db.prepare('SELECT * FROM businesses WHERE id = ?');

function getBusinessById(id) {
  const row = stmtGetBusinessById.get(id);
  if (!row) return null;
  return deserializeBusiness(row);
}

function deserializeBusiness(row) {
  return {
    ...row,
    sales_examples: row.sales_examples ? JSON.parse(row.sales_examples) : null,
    survey_answers: row.survey_answers ? JSON.parse(row.survey_answers) : null,
  };
}

// --- conversations ---

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

module.exports = {
  upsertBusiness,
  getBusinessById,
  getOrCreateConversation,
  addMessage,
  getConversationHistory,
};
