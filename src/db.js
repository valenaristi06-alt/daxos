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

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '../data');
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'daxos.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Non-businesses tables (no migration needed)
db.exec(`
  CREATE TABLE IF NOT EXISTS error_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    context    TEXT NOT NULL,
    message    TEXT NOT NULL,
    stack      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runtime_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

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

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    msg_id      TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(business_id, msg_id)
  )
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

// silent=1: message was saved during a business's silent window.
// Excluded from the history sent to Claude; still visible in the owner's panel.
const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
if (!msgCols.includes('silent')) db.exec('ALTER TABLE messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0');

const convCols = db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name);
if (!convCols.includes('needs_attention'))      db.exec('ALTER TABLE conversations ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0');
if (!convCols.includes('label'))                db.exec('ALTER TABLE conversations ADD COLUMN label TEXT');
if (!convCols.includes('booking_state'))        db.exec('ALTER TABLE conversations ADD COLUMN booking_state TEXT');
if (!convCols.includes('paused_at'))            db.exec('ALTER TABLE conversations ADD COLUMN paused_at INTEGER');
if (!convCols.includes('auto_resumed_at'))      db.exec('ALTER TABLE conversations ADD COLUMN auto_resumed_at INTEGER');
if (!convCols.includes('needs_human'))          db.exec('ALTER TABLE conversations ADD COLUMN needs_human INTEGER NOT NULL DEFAULT 0');
if (!convCols.includes('human_paused_at'))      db.exec('ALTER TABLE conversations ADD COLUMN human_paused_at INTEGER');
// silent=1: conversation was created/updated during a business's silent window.
// Excluded from trial conversation count. Cleared when the bot actually replies after the window.
if (!convCols.includes('silent'))               db.exec('ALTER TABLE conversations ADD COLUMN silent INTEGER NOT NULL DEFAULT 0');

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
if (!bizCols.includes('booking_enabled'))         db.exec('ALTER TABLE businesses ADD COLUMN booking_enabled INTEGER NOT NULL DEFAULT 0');
if (!bizCols.includes('weekly_summary_enabled'))  db.exec('ALTER TABLE businesses ADD COLUMN weekly_summary_enabled INTEGER NOT NULL DEFAULT 1');
if (!bizCols.includes('wa_provider'))             db.exec("ALTER TABLE businesses ADD COLUMN wa_provider TEXT NOT NULL DEFAULT 'meta'");
if (!bizCols.includes('human_resume_timeout'))    db.exec('ALTER TABLE businesses ADD COLUMN human_resume_timeout INTEGER NOT NULL DEFAULT 7200');
if (!bizCols.includes('business_hours_start'))    db.exec('ALTER TABLE businesses ADD COLUMN business_hours_start TEXT');
if (!bizCols.includes('business_hours_end'))      db.exec('ALTER TABLE businesses ADD COLUMN business_hours_end TEXT');
if (!bizCols.includes('kapso_customer_id'))       db.exec('ALTER TABLE businesses ADD COLUMN kapso_customer_id TEXT');
if (!bizCols.includes('sales_script'))            db.exec('ALTER TABLE businesses ADD COLUMN sales_script TEXT');
if (!bizCols.includes('kapso_setup_link_id'))     db.exec('ALTER TABLE businesses ADD COLUMN kapso_setup_link_id TEXT');
// plan_cortesia: permanent free access granted outside of MercadoPago — client pays by other means.
// When set, the account is never blocked by trial expiry or message limits.
if (!bizCols.includes('plan_cortesia'))              db.exec('ALTER TABLE businesses ADD COLUMN plan_cortesia INTEGER NOT NULL DEFAULT 0');
if (!bizCols.includes('kapso_connect_started_at'))   db.exec('ALTER TABLE businesses ADD COLUMN kapso_connect_started_at TEXT');
if (!bizCols.includes('kapso_incomplete_alerted_at')) db.exec('ALTER TABLE businesses ADD COLUMN kapso_incomplete_alerted_at TEXT');
if (!bizCols.includes('wa_connected_at'))             db.exec('ALTER TABLE businesses ADD COLUMN wa_connected_at TEXT');
// silent_until: UTC datetime; while now < silent_until the bot saves messages but does not reply.
// Set by admin via POST /admin/api/silent/:id. Calculated in JS, stored as UTC ISO string.
if (!bizCols.includes('silent_until'))               db.exec('ALTER TABLE businesses ADD COLUMN silent_until TEXT');

db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages (conversation_id, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_conv_business ON conversations (business_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_conv_biz_cust  ON conversations (business_id, customer_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_biz_phone_id   ON businesses    (phone_number_id)');

db.exec(`
  CREATE TABLE IF NOT EXISTS business_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    label       TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS business_documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    name        TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate sales_script → business_documents (idempotent: only runs while sales_script IS NOT NULL)
{
  const bizWithScript = db.prepare('SELECT id, sales_script FROM businesses WHERE sales_script IS NOT NULL').all();
  const insertDoc = db.prepare('INSERT INTO business_documents (business_id, name, text) VALUES (?, ?, ?)');
  const clearScript = db.prepare('UPDATE businesses SET sales_script = NULL WHERE id = ?');
  for (const biz of bizWithScript) {
    insertDoc.run(biz.id, 'Guion de ventas', biz.sales_script);
    clearScript.run(biz.id);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#6b7280',
    is_default  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(business_id, name)
  );
  CREATE TABLE IF NOT EXISTS conversation_tags (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag_id          INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, tag_id)
  );
`);

const DEFAULT_TAGS = [
  { name: 'Nuevo',            color: '#3b82f6' },
  { name: 'En conversación',  color: '#eab308' },
  { name: 'Compró',           color: '#22c55e' },
  { name: 'Perdido',          color: '#6b7280' },
];

function ensureDefaultTags(businessId) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO tags (business_id, name, color, is_default) VALUES (?, ?, ?, 1)'
  );
  for (const t of DEFAULT_TAGS) stmt.run(businessId, t.name, t.color);
}

// Seed existing businesses on startup
db.prepare('SELECT id FROM businesses').all().forEach(b => ensureDefaultTags(b.id));

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

db.exec(`
  CREATE TABLE IF NOT EXISTS claude_usage (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id           INTEGER NOT NULL REFERENCES businesses(id),
    conversation_id       INTEGER REFERENCES conversations(id),
    model                 TEXT NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    tts_chars             INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER NOT NULL REFERENCES businesses(id),
    mp_payment_id   TEXT NOT NULL UNIQUE,
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

  if (!applied('003_plan_cortesia_valentin')) {
    // Grant permanent free Arranque access to valentin@daxos.lat — pays outside the system.
    const result = db.prepare(`
      UPDATE businesses SET plan_cortesia = 1
      WHERE id = (
        SELECT b.id FROM businesses b
        JOIN users u ON u.business_id = b.id
        WHERE u.email = 'valentin@daxos.lat'
        LIMIT 1
      )
    `).run();
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('003_plan_cortesia_valentin');
    console.log(`[migration 003] plan_cortesia set for valentin@daxos.lat: ${result.changes} row(s) updated`);
  }

  if (!applied('004_claude_usage_split_cache')) {
    const usageCols = db.prepare('PRAGMA table_info(claude_usage)').all().map(c => c.name);
    const needed5m = !usageCols.includes('cache_write_5m_tokens');
    const needed1h = !usageCols.includes('cache_write_1h_tokens');
    if (needed5m) db.exec('ALTER TABLE claude_usage ADD COLUMN cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0');
    if (needed1h) db.exec('ALTER TABLE claude_usage ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0');
    // Copy historical cache_write_tokens → cache_write_5m_tokens so old cost stays correct
    if (needed5m || needed1h) {
      const migrated = db.prepare(
        'UPDATE claude_usage SET cache_write_5m_tokens = cache_write_tokens WHERE cache_write_5m_tokens = 0 AND cache_write_1h_tokens = 0 AND cache_write_tokens > 0'
      ).run();
      console.log(`[migration 004] claude_usage split cache columns added. Migrated ${migrated.changes} rows.`);
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('004_claude_usage_split_cache');
  }

  if (!applied('005_trial_grace')) {
    const bizC  = db.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
    const convC = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
    if (!bizC.includes('trial_warned_at'))          db.exec('ALTER TABLE businesses ADD COLUMN trial_warned_at TEXT');
    if (!bizC.includes('trial_grace_started_at'))   db.exec('ALTER TABLE businesses ADD COLUMN trial_grace_started_at TEXT');
    // trial_grace_notified_at: ISO UTC of last trial-related email sent to owner (1/day throttle)
    if (!bizC.includes('trial_grace_notified_at'))  db.exec('ALTER TABLE businesses ADD COLUMN trial_grace_notified_at TEXT');
    if (!convC.includes('trial_ended_notified_at')) db.exec('ALTER TABLE conversations ADD COLUMN trial_ended_notified_at TEXT');
    // paused_reason: 'trial' for trial-end pauses; NULL for manual/human pauses
    if (!convC.includes('paused_reason'))           db.exec('ALTER TABLE conversations ADD COLUMN paused_reason TEXT');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('005_trial_grace');
    console.log('[migration 005] trial grace columns added');
  }

  if (!applied('007_pause_keyword')) {
    const bizC7  = db.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
    const convC7 = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
    if (!bizC7.includes('pause_reply_text'))      db.exec('ALTER TABLE businesses ADD COLUMN pause_reply_text TEXT');
    if (!convC7.includes('pause_reply_count'))    db.exec('ALTER TABLE conversations ADD COLUMN pause_reply_count INTEGER NOT NULL DEFAULT 0');
    if (!convC7.includes('pause_last_reply_at'))  db.exec('ALTER TABLE conversations ADD COLUMN pause_last_reply_at INTEGER');
    if (!convC7.includes('pause_notified_at'))    db.exec('ALTER TABLE conversations ADD COLUMN pause_notified_at INTEGER');
    if (!convC7.includes('pause_followup_sent'))  db.exec('ALTER TABLE conversations ADD COLUMN pause_followup_sent INTEGER');
    if (!convC7.includes('pause_24h_sent'))       db.exec('ALTER TABLE conversations ADD COLUMN pause_24h_sent INTEGER');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('007_pause_keyword');
    console.log('[migration 007] pause_keyword columns added');
  }

  if (!applied('006_billing')) {
    const bizC6 = db.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
    if (!bizC6.includes('billing_requires_invoice')) db.exec('ALTER TABLE businesses ADD COLUMN billing_requires_invoice INTEGER NOT NULL DEFAULT 0');
    if (!bizC6.includes('billing_legal_name'))       db.exec('ALTER TABLE businesses ADD COLUMN billing_legal_name TEXT');
    if (!bizC6.includes('billing_rut'))              db.exec('ALTER TABLE businesses ADD COLUMN billing_rut TEXT');
    if (!bizC6.includes('billing_address'))          db.exec('ALTER TABLE businesses ADD COLUMN billing_address TEXT');
    if (!bizC6.includes('billing_email'))            db.exec('ALTER TABLE businesses ADD COLUMN billing_email TEXT');
    if (!bizC6.includes('billing_updated_at'))       db.exec('ALTER TABLE businesses ADD COLUMN billing_updated_at TEXT');
    // billing_notified_at: last time admin was emailed about this business's billing data (1/day throttle, DB-persisted)
    if (!bizC6.includes('billing_notified_at'))      db.exec('ALTER TABLE businesses ADD COLUMN billing_notified_at TEXT');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('006_billing');
    console.log('[migration 006] billing columns added');
  }

  if (!applied('008_wa_silence')) {
    const bizC8 = db.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
    if (!bizC8.includes('wa_silence_alerted_at')) db.exec('ALTER TABLE businesses ADD COLUMN wa_silence_alerted_at INTEGER');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('008_wa_silence');
    console.log('[migration 008] wa_silence_alerted_at added');
  }

  if (!applied('009_wa_health')) {
    const bizC9 = db.prepare('PRAGMA table_info(businesses)').all().map(c => c.name);
    if (!bizC9.includes('wa_health_alerted_at')) db.exec('ALTER TABLE businesses ADD COLUMN wa_health_alerted_at INTEGER');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('009_wa_health');
    console.log('[migration 009] wa_health_alerted_at added');
  }

  if (!applied('010_lote3')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spending_counters (
        business_id      INTEGER NOT NULL,
        date             TEXT    NOT NULL,
        anthropic_calls  INTEGER NOT NULL DEFAULT 0,
        elevenlabs_chars INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (business_id, date)
      )
    `);
    const convC10 = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
    if (!convC10.includes('spending_cap_notified_at'))
      db.exec('ALTER TABLE conversations ADD COLUMN spending_cap_notified_at INTEGER');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('010_lote3');
    console.log('[migration 010] spending_counters + spending_cap_notified_at');
  }

  if (!applied('011_lote3_password_reset')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT    NOT NULL UNIQUE,
        expires_at TEXT    NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('011_lote3_password_reset');
    console.log('[migration 011] password_reset_tokens');
  }

  if (!applied('012_excluded_contacts')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS excluded_contacts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        phone       TEXT NOT NULL,
        source      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(business_id, phone)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS excluded_contacts_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        phone       TEXT NOT NULL,
        action      TEXT NOT NULL CHECK(action IN ('add', 'remove')),
        source      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_excluded_biz_phone ON excluded_contacts (business_id, phone)');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('012_excluded_contacts');
    console.log('[migration 012] excluded_contacts tables created');
  }

  if (!applied('013_urgent_keywords')) {
    db.exec(`ALTER TABLE businesses ADD COLUMN urgent_keywords TEXT`);
    db.exec(`ALTER TABLE businesses ADD COLUMN urgent_alert_enabled INTEGER NOT NULL DEFAULT 0`);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('013_urgent_keywords');
    console.log('[migration 013] urgent_keywords + urgent_alert_enabled added to businesses');
  }

  if (!applied('014_business_hours')) {
    db.exec(`ALTER TABLE businesses ADD COLUMN business_hours TEXT`);
    db.exec(`ALTER TABLE businesses ADD COLUMN after_hours_instructions TEXT`);
    db.exec(`ALTER TABLE businesses ADD COLUMN urgent_phone TEXT`);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('014_business_hours');
    console.log('[migration 014] business_hours + after_hours_instructions + urgent_phone added to businesses');
  }

  if (!applied('015_owner_rules')) {
    db.exec(`ALTER TABLE businesses ADD COLUMN owner_rules TEXT`);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run('015_owner_rules');
    console.log('[migration 015] owner_rules added to businesses');
  }

})();

db.exec(`CREATE TABLE IF NOT EXISTS es_pending (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL UNIQUE REFERENCES businesses(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// --- demo generator tables ---

db.exec(`CREATE TABLE IF NOT EXISTS demos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  data_json         TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  whatsapp_contacto TEXT,
  ip                TEXT,
  msg_count         INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS demo_costs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  demo_id    INTEGER REFERENCES demos(id),
  event      TEXT NOT NULL,
  in_tokens  INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS demo_flow_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  phone               TEXT NOT NULL UNIQUE,
  state               TEXT NOT NULL,
  demo_slug           TEXT,
  followup_sent       INTEGER NOT NULL DEFAULT 0,
  followup_eligible_at TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// --- spending caps ---

function incrementAnthropicCall(businessId) {
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO spending_counters (business_id, date, anthropic_calls) VALUES (?, ?, 1)
    ON CONFLICT(business_id, date) DO UPDATE SET anthropic_calls = anthropic_calls + 1
  `).run(businessId, date);
}

function incrementElevenLabsChars(businessId, chars) {
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO spending_counters (business_id, date, elevenlabs_chars) VALUES (?, ?, ?)
    ON CONFLICT(business_id, date) DO UPDATE SET elevenlabs_chars = elevenlabs_chars + ?
  `).run(businessId, date, chars, chars);
}

function getSpendingToday(businessId) {
  const date = new Date().toISOString().slice(0, 10);
  return db.prepare(
    'SELECT anthropic_calls, elevenlabs_chars FROM spending_counters WHERE business_id = ? AND date = ?'
  ).get(businessId, date) || { anthropic_calls: 0, elevenlabs_chars: 0 };
}

function getConvAssistantCountLastHour(convId) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return (db.prepare(
    `SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?`
  ).get(convId, since) || { cnt: 0 }).cnt;
}

function setSpendingCapNotified(convId) {
  db.prepare('UPDATE conversations SET spending_cap_notified_at = unixepoch() WHERE id = ?').run(convId);
}

// --- password reset ---

function createPasswordResetToken(userId, tokenHash, expiresAt) {
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND used = 0').run(userId);
  db.prepare(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, tokenHash, expiresAt);
}

function getPasswordResetToken(tokenHash) {
  return db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash) || null;
}

function markPasswordResetTokenUsed(id) {
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(id);
}

function changeUserPassword(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

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

function saveWabaCredentials(businessId, { wabaId, phoneNumberId, accessToken = null, provider = 'meta' }) {
  // Only start the trial clock on first connection — don't reset if already connected
  const existing = db.prepare('SELECT trial_starts_at, phone_number_id FROM businesses WHERE id = ?').get(businessId);

  // Guard: never overwrite an already-connected number — use clearWabaCredentials first
  if (existing?.phone_number_id) {
    logError('saveWabaCredentials-blocked', {
      message: `biz ${businessId} already has phone_number_id=${existing.phone_number_id} — skipping overwrite with ${phoneNumberId}`,
      stack: '',
    });
    return;
  }

  const encToken = accessToken ? encrypt(accessToken) : null;
  if (existing && !existing.trial_starts_at) {
    db.prepare(`
      UPDATE businesses
      SET waba_id = ?, phone_number_id = ?, wa_access_token = ?, wa_provider = ?,
          trial_starts_at = datetime('now'),
          trial_ends_at   = datetime('now', '+14 days'),
          wa_connected_at = datetime('now')
      WHERE id = ?
    `).run(wabaId, phoneNumberId, encToken, provider, businessId);
  } else {
    db.prepare(`
      UPDATE businesses
      SET waba_id = ?, phone_number_id = ?, wa_access_token = ?, wa_provider = ?,
          wa_connected_at = datetime('now')
      WHERE id = ?
    `).run(wabaId, phoneNumberId, encToken, provider, businessId);
  }
}

function clearWabaCredentials(businessId) {
  const prev = db.prepare('SELECT phone_number_id, waba_id, wa_provider, wa_connected_at, kapso_customer_id, kapso_setup_link_id FROM businesses WHERE id = ?').get(businessId);
  db.prepare(`
    UPDATE businesses
    SET phone_number_id = NULL, waba_id = NULL, wa_access_token = NULL, wa_provider = 'meta',
        wa_connected_at = NULL,
        kapso_customer_id = NULL, kapso_setup_link_id = NULL,
        kapso_connect_started_at = NULL, kapso_incomplete_alerted_at = NULL
    WHERE id = ?
  `).run(businessId);
  return prev || null;
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
  db.prepare('UPDATE conversations SET needs_attention = 1, paused_at = unixepoch() WHERE id = ?').run(conversationId);
}

function markConversationPausedByKeyword(conversationId) {
  db.prepare(`
    UPDATE conversations SET
      needs_attention = 1, paused_at = unixepoch(), paused_reason = 'keyword',
      pause_reply_count = 1, pause_last_reply_at = unixepoch()
    WHERE id = ?
  `).run(conversationId);
}

function recordKeywordPauseReply(conversationId) {
  db.prepare(`
    UPDATE conversations SET
      pause_reply_count = pause_reply_count + 1,
      pause_last_reply_at = unixepoch()
    WHERE id = ?
  `).run(conversationId);
}

function setPauseNotifiedAt(conversationId) {
  db.prepare('UPDATE conversations SET pause_notified_at = unixepoch() WHERE id = ?').run(conversationId);
}

function setPauseFollowupSent(conversationId) {
  db.prepare('UPDATE conversations SET pause_followup_sent = unixepoch() WHERE id = ?').run(conversationId);
}

function setPause24hSent(conversationId) {
  db.prepare('UPDATE conversations SET pause_24h_sent = unixepoch() WHERE id = ?').run(conversationId);
}

function markConversationResumed(conversationId) {
  db.prepare(`
    UPDATE conversations SET
      needs_attention = 0, paused_at = NULL, needs_human = 0, human_paused_at = NULL,
      paused_reason = NULL,
      pause_notified_at = NULL, pause_followup_sent = NULL, pause_24h_sent = NULL,
      pause_reply_count = 0, pause_last_reply_at = NULL
    WHERE id = ?
  `).run(conversationId);
}

function resetConversation(convId, businessId, userId) {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND business_id = ?').get(convId, businessId);
  if (!conv) throw new Error(`reset_not_found:conv=${convId} biz=${businessId}`);
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId);
    db.prepare(`UPDATE conversations SET
      needs_attention = 0, needs_human = 0,
      paused_reason = NULL, paused_at = NULL, auto_resumed_at = NULL,
      human_paused_at = NULL, silent = 0,
      pause_reply_count = 0, pause_last_reply_at = NULL,
      pause_notified_at = NULL, pause_followup_sent = NULL, pause_24h_sent = NULL,
      spending_cap_notified_at = NULL, trial_ended_notified_at = NULL,
      booking_state = NULL, label = NULL
    WHERE id = ?`).run(convId);
    db.prepare('INSERT INTO error_log (context, message, stack) VALUES (?, ?, ?)').run(
      'conv-reset',
      `conv_id=${convId} business_id=${businessId} user_id=${userId}`,
      ''
    );
  })();
}

function setNeedsHuman(conversationId, val) {
  db.prepare('UPDATE conversations SET needs_human = ? WHERE id = ?').run(val ? 1 : 0, conversationId);
}

// Called when a human actively takes over from the panel — pauses bot, starts human-timeout clock.
// Clears paused_at so the 24h auto-resume job doesn't interfere.
function setHumanPaused(conversationId) {
  db.prepare('UPDATE conversations SET needs_attention = 1, paused_at = NULL, human_paused_at = unixepoch(), needs_human = 0 WHERE id = ?').run(conversationId);
}

// Resumes a human-paused conversation (timeout or business-hours triggered).
function clearHumanPause(conversationId) {
  db.prepare('UPDATE conversations SET needs_attention = 0, paused_at = NULL, human_paused_at = NULL, needs_human = 0, auto_resumed_at = unixepoch() WHERE id = ?').run(conversationId);
}

function getConversationsNeedingHumanResume() {
  return db.prepare(`
    SELECT c.id, c.human_paused_at, b.human_resume_timeout, b.business_hours_start, b.business_hours_end, b.business_hours
    FROM conversations c
    JOIN businesses b ON b.id = c.business_id
    WHERE c.needs_attention = 1 AND c.human_paused_at IS NOT NULL
  `).all();
}

function getKeywordPausedNeedingFollowup() {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;
  return db.prepare(`
    SELECT c.id, c.pause_notified_at, c.customer_id,
           b.name AS business_name, u.email AS owner_email
    FROM conversations c
    JOIN businesses b ON b.id = c.business_id
    JOIN users u ON u.business_id = b.id
    WHERE c.needs_attention = 1
      AND c.paused_reason = 'keyword'
      AND c.pause_notified_at IS NOT NULL
      AND c.pause_followup_sent IS NULL
      AND c.pause_notified_at <= ?
  `).all(cutoff);
}

function getKeywordPausedNeeding24h() {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  return db.prepare(`
    SELECT c.id, c.pause_notified_at, c.customer_id,
           b.name AS business_name, u.email AS owner_email
    FROM conversations c
    JOIN businesses b ON b.id = c.business_id
    JOIN users u ON u.business_id = b.id
    WHERE c.needs_attention = 1
      AND c.paused_reason = 'keyword'
      AND c.pause_notified_at IS NOT NULL
      AND c.pause_24h_sent IS NULL
      AND c.pause_notified_at <= ?
  `).all(cutoff);
}

function autoResumeExpiredConversations() {
  const cutoff = Math.floor(Date.now() / 1000) - 12 * 60 * 60;
  const result = db.prepare(
    "UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL, auto_resumed_at = unixepoch() WHERE needs_attention = 1 AND paused_at IS NOT NULL AND paused_at < ? AND (paused_reason IS NULL OR paused_reason NOT IN ('trial'))"
  ).run(cutoff);
  return result.changes;
}

function upsertBusiness({ id, name, whatsapp_number = null, sales_examples = null, survey_answers = null, business_context = null, website_url = null, response_mode = 'texto', pause_keywords = null, pause_reply_text = null, response_delay = 5, pricing_info = null, urgent_keywords = null, urgent_alert_enabled = 0, business_hours = null, after_hours_instructions = null, urgent_phone = null, owner_rules = null }) {
  const serialized = {
    name,
    whatsapp_number: whatsapp_number || null,
    sales_examples: sales_examples != null ? JSON.stringify(sales_examples) : null,
    survey_answers: survey_answers != null ? JSON.stringify(survey_answers) : null,
    business_context: business_context || null,
    website_url: website_url || null,
    response_mode,
    pause_keywords: pause_keywords || null,
    pause_reply_text: pause_reply_text || null,
    response_delay: Number(response_delay) || 5,
    pricing_info: pricing_info || null,
    urgent_keywords: urgent_keywords || null,
    urgent_alert_enabled: urgent_alert_enabled ? 1 : 0,
    business_hours: business_hours || null,
    after_hours_instructions: after_hours_instructions || null,
    urgent_phone: urgent_phone || null,
    owner_rules: owner_rules || null,
  };

  if (id) {
    db.prepare(`
      UPDATE businesses SET name=@name, whatsapp_number=@whatsapp_number,
        sales_examples=@sales_examples, survey_answers=@survey_answers,
        business_context=@business_context, website_url=@website_url,
        response_mode=@response_mode, pause_keywords=@pause_keywords,
        pause_reply_text=@pause_reply_text,
        response_delay=@response_delay, pricing_info=@pricing_info,
        urgent_keywords=@urgent_keywords, urgent_alert_enabled=@urgent_alert_enabled,
        business_hours=@business_hours, after_hours_instructions=@after_hours_instructions,
        urgent_phone=@urgent_phone, owner_rules=@owner_rules
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
    INSERT INTO businesses (name, sales_examples, survey_answers, business_context, website_url, response_mode, pause_keywords, pause_reply_text, response_delay, pricing_info, urgent_keywords, urgent_alert_enabled, business_hours, after_hours_instructions, urgent_phone, owner_rules)
    VALUES (@name, @sales_examples, @survey_answers, @business_context, @website_url, @response_mode, @pause_keywords, @pause_reply_text, @response_delay, @pricing_info, @urgent_keywords, @urgent_alert_enabled, @business_hours, @after_hours_instructions, @urgent_phone, @owner_rules)
  `).run(serialized);
  ensureDefaultTags(result.lastInsertRowid);
  return getBusinessById(result.lastInsertRowid);
}

const stmtGetBusinessByPhone = db.prepare('SELECT * FROM businesses WHERE whatsapp_number = ?');
const stmtGetBusinessByPhoneNumberId = db.prepare('SELECT * FROM businesses WHERE phone_number_id = ?');

function getBusinessByWhatsappNumber(number) {
  const row = stmtGetBusinessByPhone.get(String(number));
  if (!row) return null;
  return deserializeBusiness(row);
}

function getBusinessByPhoneNumberId(phoneNumberId) {
  const row = stmtGetBusinessByPhoneNumberId.get(String(phoneNumberId));
  if (!row) return null;
  return deserializeBusiness(row);
}

const stmtGetBusinessByWabaId = db.prepare('SELECT * FROM businesses WHERE waba_id = ? LIMIT 1');
function getBusinessByWabaId(wabaId) {
  const row = stmtGetBusinessByWabaId.get(String(wabaId));
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
  SELECT c.*,
    (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_msg_at,
    (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
  FROM conversations c
  WHERE c.business_id = ?
  ORDER BY last_msg_at DESC, c.created_at DESC
`);
const stmtGetTagsForConversation = db.prepare(`
  SELECT t.id, t.name, t.color FROM tags t
  JOIN conversation_tags ct ON ct.tag_id = t.id
  WHERE ct.conversation_id = ?
`);

function getConversationsByBusinessId(businessId) {
  const convs = stmtGetConversationsByBusiness.all(businessId);
  if (convs.length === 0) return [];
  const placeholders = convs.map(() => '?').join(',');
  const allTags = db.prepare(
    `SELECT ct.conversation_id, t.id, t.name, t.color
     FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.conversation_id IN (${placeholders})`
  ).all(...convs.map(c => c.id));
  const byConv = new Map();
  for (const r of allTags) {
    if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []);
    byConv.get(r.conversation_id).push({ id: r.id, name: r.name, color: r.color });
  }
  return convs.map(c => ({ ...c, tags: byConv.get(c.id) || [] }));
}

function getTagsByBusiness(businessId) {
  return db.prepare('SELECT * FROM tags WHERE business_id = ? ORDER BY is_default DESC, id ASC').all(businessId);
}

function createTag(businessId, name, color) {
  const result = db.prepare(
    'INSERT INTO tags (business_id, name, color, is_default) VALUES (?, ?, ?, 0)'
  ).run(businessId, name, color);
  return { id: result.lastInsertRowid, business_id: businessId, name, color, is_default: 0 };
}

function deleteTag(businessId, tagId) {
  const tag = db.prepare('SELECT * FROM tags WHERE id = ? AND business_id = ?').get(tagId, businessId);
  if (!tag) return false;
  if (tag.is_default) return 'default';
  db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
  return true;
}

function setConversationTags(conversationId, tagIds) {
  db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ?').run(conversationId);
  const ins = db.prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)');
  for (const tid of tagIds) ins.run(conversationId, tid);
}

function getConversationTags(conversationId) {
  return stmtGetTagsForConversation.all(conversationId);
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
  INSERT INTO messages (conversation_id, role, content, silent) VALUES (?, ?, ?, ?)
`);

function addMessage(conversation_id, role, content, silent = 0) {
  const result = stmtAddMessage.run(conversation_id, role, content, silent ? 1 : 0);
  return result.lastInsertRowid;
}

const stmtLastUserMsgAt = db.prepare(
  `SELECT created_at FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`
);
function getLastUserMessageAt(conversationId) {
  return stmtLastUserMsgAt.get(conversationId)?.created_at ?? null;
}

const stmtGetHistory = db.prepare(`
  SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?
`);
const stmtGetHistoryExcludeSilent = db.prepare(`
  SELECT * FROM messages WHERE conversation_id = ? AND silent = 0 ORDER BY created_at ASC LIMIT ?
`);

function getConversationHistory(conversation_id, limit = 50, { excludeSilent = false } = {}) {
  if (excludeSilent) return stmtGetHistoryExcludeSilent.all(conversation_id, limit);
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

function changeUserEmail(oldEmail, newEmail) {
  return db.prepare('UPDATE users SET email = ? WHERE email = ?').run(newEmail, oldEmail);
}

function setPlanCortesia(businessId, value) {
  db.prepare('UPDATE businesses SET plan_cortesia = ? WHERE id = ?').run(value ? 1 : 0, businessId);
}

function getUserById(id) {
  return stmtGetUserById.get(id) || null;
}

function upgradePlan(businessId, plan, paidAt, expiresAt) {
  db.prepare(`
    UPDATE businesses SET plan = ?, plan_paid_at = ?, plan_expires_at = ?, subscription_status = 'active' WHERE id = ?
  `).run(plan, paidAt, expiresAt, businessId);
  const resumed = resumeTrialPausedConversations(businessId);
  if (resumed > 0) console.log(`[upgradePlan] reactivated ${resumed} trial-paused conversation(s) for business ${businessId}`);
}

function setSubscriptionStatus(businessId, status) {
  db.prepare('UPDATE businesses SET subscription_status = ? WHERE id = ?').run(status, businessId);
}

function savePayment({ businessId, mpPaymentId, amount, currency, paidAt, rawJson }) {
  db.prepare(`
    INSERT OR IGNORE INTO payments
      (business_id, mp_payment_id, amount, currency, paid_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(businessId, mpPaymentId, amount ?? null, currency ?? null, paidAt ?? null, rawJson ?? null);
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

function isPaymentProcessed(mpPaymentId) {
  return !!db.prepare('SELECT 1 FROM payments WHERE mp_payment_id = ? LIMIT 1').get(String(mpPaymentId));
}

function setWaPaymentConfirmed(businessId) {
  db.prepare('UPDATE businesses SET wa_payment_confirmed = 1 WHERE id = ?').run(businessId);
}

function setBookingEnabled(businessId, enabled) {
  db.prepare('UPDATE businesses SET booking_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, businessId);
}

function getTrialMessageCount(businessId, trialStartsAt) {
  return db.prepare(`
    SELECT COUNT(*) as n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.business_id = ? AND m.role = 'user' AND m.created_at >= ?
  `).get(businessId, trialStartsAt).n;
}

function getTrialConversationCount(businessId, trialStartsAt) {
  return db.prepare(`
    SELECT COUNT(DISTINCT m.conversation_id) as n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.business_id = ? AND m.role = 'user' AND m.created_at >= ? AND c.silent = 0
  `).get(businessId, trialStartsAt).n;
}

function setTrialWarnedAt(businessId, isoUtc) {
  db.prepare('UPDATE businesses SET trial_warned_at = ? WHERE id = ?').run(isoUtc, businessId);
}

function setTrialGraceStartedAt(businessId, isoUtc) {
  db.prepare('UPDATE businesses SET trial_grace_started_at = ? WHERE id = ?').run(isoUtc, businessId);
}

function setTrialGraceNotifiedAt(businessId, isoUtc) {
  db.prepare('UPDATE businesses SET trial_grace_notified_at = ? WHERE id = ?').run(isoUtc, businessId);
}

function setTrialEndedNotifiedAt(convId, isoUtc) {
  db.prepare('UPDATE conversations SET trial_ended_notified_at = ? WHERE id = ?').run(isoUtc, convId);
}

function markConversationPausedByTrial(convId) {
  db.prepare("UPDATE conversations SET needs_attention = 1, paused_at = unixepoch(), paused_reason = 'trial' WHERE id = ?").run(convId);
}

function resumeTrialPausedConversations(businessId) {
  return db.prepare(
    "UPDATE conversations SET needs_attention = 0, paused_at = NULL, paused_reason = NULL WHERE business_id = ? AND paused_reason = 'trial'"
  ).run(businessId).changes;
}

function setBillingData(businessId, { billing_requires_invoice, billing_legal_name, billing_rut, billing_address, billing_email }) {
  db.prepare(`
    UPDATE businesses SET
      billing_requires_invoice = ?,
      billing_legal_name = ?,
      billing_rut = ?,
      billing_address = ?,
      billing_email = ?,
      billing_updated_at = datetime('now')
    WHERE id = ?
  `).run(
    billing_requires_invoice ? 1 : 0,
    billing_legal_name || null,
    billing_rut || null,
    billing_address || null,
    billing_email || null,
    businessId
  );
}

function setBillingNotifiedAt(businessId, isoUtc) {
  db.prepare('UPDATE businesses SET billing_notified_at = ? WHERE id = ?').run(isoUtc, businessId);
}

// Returns all arranque businesses in trial (no plan_paid_at, no plan_cortesia) with owner contact info.
function getTrialBusinesses() {
  return db.prepare(`
    SELECT b.*, u.email AS owner_email, u.phone AS owner_phone
    FROM businesses b
    LEFT JOIN users u ON u.business_id = b.id
    WHERE b.plan = 'arranque' AND b.plan_cortesia = 0 AND b.plan_paid_at IS NULL AND b.trial_starts_at IS NOT NULL
  `).all().map(row => ({ ...deserializeBusiness(row), owner_email: row.owner_email, owner_phone: row.owner_phone }));
}

// --- admin queries (read-only) ---

function getAllBusinesses() {
  return db.prepare(`
    SELECT
      b.id, b.name, b.plan, b.plan_cortesia, b.trial_ends_at, b.plan_expires_at, b.subscription_status,
      b.created_at, b.whatsapp_number, b.response_mode, b.voice_id, b.website_url,
      b.billing_requires_invoice,
      CASE WHEN b.billing_legal_name IS NOT NULL AND b.billing_rut IS NOT NULL AND b.billing_address IS NOT NULL AND b.billing_email IS NOT NULL THEN 1 ELSE 0 END AS billing_complete,
      u.email as owner_email,
      (SELECT COUNT(*) FROM conversations c WHERE c.business_id = b.id) as conv_count,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = b.id) as msg_count,
      (SELECT m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = b.id ORDER BY m.created_at DESC LIMIT 1) as last_msg_at,
      (SELECT COUNT(*) FROM payments p WHERE p.business_id = b.id AND p.paid_at >= datetime('now', '-35 days')) as has_recent_payment
    FROM businesses b
    LEFT JOIN users u ON u.business_id = b.id
    ORDER BY b.created_at DESC
  `).all();
}

function getGlobalStats() {
  const totalBusinesses    = db.prepare('SELECT COUNT(*) as n FROM businesses').get().n;
  const cortesiaCount      = db.prepare(`SELECT COUNT(*) as n FROM businesses WHERE plan_cortesia = 1`).get().n;
  const trialCount         = db.prepare(`SELECT COUNT(*) as n FROM businesses WHERE plan = 'arranque' AND plan_cortesia = 0`).get().n;
  const payingCount        = db.prepare(`SELECT COUNT(DISTINCT business_id) as n FROM payments WHERE paid_at >= datetime('now', '-35 days')`).get().n;
  const totalMessages      = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
  const messagesThisMonth  = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE created_at >= date('now','start of month')`).get().n;
  const aiRepliesThisMonth = db.prepare(`SELECT COUNT(*) as n FROM messages WHERE role='assistant' AND created_at >= date('now','start of month')`).get().n;
  const voiceRepliesThisMonth = db.prepare(`
    SELECT COUNT(*) as n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN businesses b ON b.id = c.business_id
    WHERE m.role = 'assistant' AND b.voice_id IS NOT NULL
      AND m.created_at >= date('now','start of month')
  `).get().n;
  const revenueRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total, currency
    FROM payments
    WHERE created_at >= date('now','start of month')
    GROUP BY currency ORDER BY total DESC LIMIT 1
  `).get();
  const revenueThisMonth = revenueRow
    ? { amount: Math.round(revenueRow.total), currency: revenueRow.currency || 'UYU' }
    : { amount: 0, currency: 'UYU' };
  return { totalBusinesses, cortesiaCount, trialCount, payingCount, totalMessages, messagesThisMonth, aiRepliesThisMonth, voiceRepliesThisMonth, revenueThisMonth };
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

// --- silent window ---

function setSilentUntil(businessId, isoUtc) {
  db.prepare('UPDATE businesses SET silent_until = ? WHERE id = ?').run(isoUtc, businessId);
}

function clearSilentUntil(businessId) {
  db.prepare('UPDATE businesses SET silent_until = NULL WHERE id = ?').run(businessId);
}

function setConversationSilent(conversationId, val) {
  db.prepare('UPDATE conversations SET silent = ? WHERE id = ?').run(val ? 1 : 0, conversationId);
}

// --- excluded contacts ---

const EXCLUDED_CONTACTS_LIMIT = 500;

function normalizeContactPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  // Uruguay local format: starts with 0, 9 digits total (e.g. 098323308 → 59898323308)
  if (digits.startsWith('0') && digits.length === 9) {
    digits = '598' + digits.slice(1);
  }
  return digits || null;
}

function isPhoneExcluded(businessId, normalizedPhone) {
  return !!db.prepare(
    'SELECT 1 FROM excluded_contacts WHERE business_id = ? AND phone = ? LIMIT 1'
  ).get(businessId, normalizedPhone);
}

function addExcludedContact(businessId, rawPhone, source) {
  const phone = normalizeContactPhone(rawPhone);
  if (!phone) return { ok: false, error: 'phone_invalid' };
  const existing = db.prepare(
    'SELECT 1 FROM excluded_contacts WHERE business_id = ? AND phone = ? LIMIT 1'
  ).get(businessId, phone);
  if (existing) return { ok: true, duplicate: true };
  const count = db.prepare(
    'SELECT COUNT(*) as n FROM excluded_contacts WHERE business_id = ?'
  ).get(businessId).n;
  if (count >= EXCLUDED_CONTACTS_LIMIT) return { ok: false, error: 'limit_reached' };
  db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO excluded_contacts (business_id, phone, source) VALUES (?, ?, ?)'
    ).run(businessId, phone, source || null);
    db.prepare(
      'INSERT INTO excluded_contacts_audit (business_id, phone, action, source) VALUES (?, ?, ?, ?)'
    ).run(businessId, phone, 'add', source || null);
  })();
  return { ok: true };
}

function removeExcludedContact(businessId, rawPhone, source) {
  const phone = normalizeContactPhone(rawPhone);
  if (!phone) return { ok: false, error: 'phone_invalid' };
  const row = db.prepare(
    'SELECT 1 FROM excluded_contacts WHERE business_id = ? AND phone = ?'
  ).get(businessId, phone);
  if (!row) return { ok: false, error: 'not_found' };
  db.transaction(() => {
    db.prepare(
      'DELETE FROM excluded_contacts WHERE business_id = ? AND phone = ?'
    ).run(businessId, phone);
    db.prepare(
      'INSERT INTO excluded_contacts_audit (business_id, phone, action, source) VALUES (?, ?, ?, ?)'
    ).run(businessId, phone, 'remove', source || null);
  })();
  return { ok: true };
}

function getExcludedContacts(businessId) {
  return db.prepare(
    'SELECT id, phone, source, created_at FROM excluded_contacts WHERE business_id = ? ORDER BY created_at DESC'
  ).all(businessId);
}

function bulkAddExcludedContacts(businessId, rawPhones, source) {
  let added = 0, duplicates = 0, invalid = 0, limitReached = false;
  const currentCount = db.prepare(
    'SELECT COUNT(*) as n FROM excluded_contacts WHERE business_id = ?'
  ).get(businessId).n;
  let available = EXCLUDED_CONTACTS_LIMIT - currentCount;
  for (const raw of rawPhones) {
    if (available <= 0) { limitReached = true; break; }
    const phone = normalizeContactPhone(raw);
    if (!phone) { invalid++; continue; }
    const existing = db.prepare(
      'SELECT 1 FROM excluded_contacts WHERE business_id = ? AND phone = ? LIMIT 1'
    ).get(businessId, phone);
    if (existing) { duplicates++; continue; }
    db.transaction(() => {
      db.prepare(
        'INSERT OR IGNORE INTO excluded_contacts (business_id, phone, source) VALUES (?, ?, ?)'
      ).run(businessId, phone, source || null);
      db.prepare(
        'INSERT INTO excluded_contacts_audit (business_id, phone, action, source) VALUES (?, ?, ?, ?)'
      ).run(businessId, phone, 'add', source || null);
    })();
    added++;
    available--;
  }
  return { added, duplicates, invalid, limitReached };
}

module.exports = {
  setUserPhone,
  setStyleProfile,
  setWebsiteSummary,
  saveVoiceConsent,
  createUser,
  getUserByEmail,
  changeUserEmail,
  setPlanCortesia,
  getUserById,
  getUserByBusinessId,
  upsertBusiness,
  getBusinessById,
  getBusinessByWhatsappNumber,
  getBusinessByPhoneNumberId, getBusinessByWabaId,
  getBusinessByUserId,
  setUserBusiness,
  getConversationsByBusinessId,
  getConversationCountByBusinessId,
  getLastCustomerMessage,
  getConversationById,
  getOrCreateConversation,
  addMessage,
  getLastUserMessageAt,
  getConversationHistory,
  markConversationPaused,
  markConversationResumed,
  resetConversation,
  setNeedsHuman,
  setHumanPaused,
  clearHumanPause,
  getConversationsNeedingHumanResume,
  autoResumeExpiredConversations,
  getDailyConversationStats,
  getTodayStats,
  getDailyMessageStats,
  setConversationLabel,
  setBusinessDocument,
  clearBusinessDocument,
  upgradePlan,
  setSubscriptionStatus,
  savePayment,
  savePendingPayment,
  isPaymentProcessed,
  getPendingPayments,
  getAllBusinesses,
  getGlobalStats,
  getBusinessAdminMetrics,
  getPlanCounts,
  saveWabaCredentials,
  clearWabaCredentials,
  setWaPaymentConfirmed,
  setBookingEnabled,
  getTrialMessageCount,
  getTrialConversationCount,
  setTrialWarnedAt,
  setTrialGraceStartedAt,
  setTrialGraceNotifiedAt,
  setTrialEndedNotifiedAt,
  markConversationPausedByTrial,
  resumeTrialPausedConversations,
  getTrialBusinesses,
  setBillingData,
  setBillingNotifiedAt,
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
  setWeeklySummaryEnabled,
  getWeeklyStats,
  getBusinessesWithWeeklySummary,
  setRuntimeConfig,
  getRuntimeConfig,
  logError,
  getRecentErrors, getErrorsFiltered,
  checkpoint,
  backupToFile,
  closeDb,
  setKapsoCustomerId,
  setKapsoSetupLinkId,
  setKapsoConnectStartedAt,
  setKapsoIncompleteAlertedAt,
  getBusinessesWithIncompleteKapso,
  getBusinessByKapsoCustomerId,
  getBusinessDocuments,
  getBusinessDocumentTexts,
  addBusinessDocument,
  deleteBusinessDocument,
  addBusinessImage,
  getBusinessImages,
  deleteBusinessImage,
  getTagsByBusiness,
  createTag,
  deleteTag,
  setConversationTags,
  getConversationTags,
  ensureDefaultTags,
  tryMarkProcessed,
  deleteProcessedMessage,
  purgeOldProcessedMessages,
  setSilentUntil,
  clearSilentUntil,
  setConversationSilent,
  normalizeContactPhone,
  isPhoneExcluded,
  addExcludedContact,
  removeExcludedContact,
  getExcludedContacts,
  bulkAddExcludedContacts,
  logClaudeUsage,
  setClaudeUsageTtsChars,
  getClaudeUsageDailySummary,
  getClaudeUsageByBusiness,
  markConversationPausedByKeyword,
  recordKeywordPauseReply,
  setPauseNotifiedAt,
  setPauseFollowupSent,
  setPause24hSent,
  getKeywordPausedNeedingFollowup,
  getKeywordPausedNeeding24h,
  getConnectedBusinesses,
  setWaSilenceAlertedAt,
  clearWaSilenceAlertedAt,
  setWaHealthAlertedAt,
  clearWaHealthAlertedAt,
  purgeOldErrorLog,
  getLastWebhookInboundAt,
  getRecentWaStatusFailed,
  insertEsPending, getActivePendingBusinesses, deleteEsPending, cleanExpiredEsPending,
  incrementAnthropicCall,
  incrementElevenLabsChars,
  getSpendingToday,
  getConvAssistantCountLastHour,
  setSpendingCapNotified,
  createPasswordResetToken,
  getPasswordResetToken,
  markPasswordResetTokenUsed,
  changeUserPassword,
  // demo generator
  createDemo,
  getDemo,
  patchDemo,
  incrementDemoMsgCount,
  getDemoDailyCountByIp,
  getDemoDailyCountByPhone,
  getDemoDailyGlobalCount,
  logDemoCost,
  getDemoFlowSession,
  upsertDemoFlowSession,
  deleteDemoFlowSession,
  getDemosForFollowup,
  getUserByPhone,
};

function setWeeklySummaryEnabled(businessId, enabled) {
  db.prepare('UPDATE businesses SET weekly_summary_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, businessId);
}

function addBusinessImage(businessId, label, filePath) {
  return db.prepare(
    'INSERT INTO business_images (business_id, label, file_path) VALUES (?, ?, ?)'
  ).run(businessId, label, filePath);
}

function getBusinessImages(businessId) {
  return db.prepare(
    'SELECT id, label, file_path, created_at FROM business_images WHERE business_id = ? ORDER BY created_at ASC'
  ).all(businessId);
}

function deleteBusinessImage(businessId, imageId) {
  const row = db.prepare(
    'SELECT file_path FROM business_images WHERE id = ? AND business_id = ?'
  ).get(imageId, businessId);
  if (!row) return null;
  db.prepare('DELETE FROM business_images WHERE id = ? AND business_id = ?').run(imageId, businessId);
  return row.file_path;
}

const DOC_CAP_CHARS = 12000;

function getBusinessDocuments(businessId) {
  return db.prepare(
    'SELECT id, name, length(text) AS charCount, created_at FROM business_documents WHERE business_id = ? ORDER BY created_at ASC'
  ).all(businessId);
}

function getBusinessDocumentTexts(businessId) {
  return db.prepare(
    'SELECT name, text FROM business_documents WHERE business_id = ? ORDER BY created_at ASC'
  ).all(businessId);
}

function addBusinessDocument(businessId, name, text) {
  const { total } = db.prepare(
    'SELECT COALESCE(SUM(length(text)), 0) AS total FROM business_documents WHERE business_id = ?'
  ).get(businessId);
  if (total + text.length > DOC_CAP_CHARS) {
    return { error: 'cap_exceeded', remaining: DOC_CAP_CHARS - total };
  }
  const result = db.prepare(
    'INSERT INTO business_documents (business_id, name, text) VALUES (?, ?, ?)'
  ).run(businessId, name, text);
  return { id: result.lastInsertRowid };
}

function deleteBusinessDocument(businessId, docId) {
  const row = db.prepare(
    'SELECT id FROM business_documents WHERE id = ? AND business_id = ?'
  ).get(docId, businessId);
  if (!row) return false;
  db.prepare('DELETE FROM business_documents WHERE id = ? AND business_id = ?').run(docId, businessId);
  return true;
}

function setKapsoCustomerId(businessId, kapsoCustomerId) {
  db.prepare('UPDATE businesses SET kapso_customer_id = ? WHERE id = ?').run(kapsoCustomerId, businessId);
}

function setKapsoSetupLinkId(businessId, setupLinkId) {
  db.prepare('UPDATE businesses SET kapso_setup_link_id = ? WHERE id = ?').run(setupLinkId, businessId);
}

function getBusinessByKapsoCustomerId(kapsoCustomerId) {
  return db.prepare('SELECT * FROM businesses WHERE kapso_customer_id = ?').get(kapsoCustomerId);
}

function setKapsoConnectStartedAt(businessId) {
  db.prepare('UPDATE businesses SET kapso_connect_started_at = datetime(\'now\') WHERE id = ? AND kapso_connect_started_at IS NULL').run(businessId);
}

function setKapsoIncompleteAlertedAt(businessId) {
  db.prepare('UPDATE businesses SET kapso_incomplete_alerted_at = datetime(\'now\') WHERE id = ?').run(businessId);
}

function getBusinessesWithIncompleteKapso() {
  return db.prepare(`
    SELECT b.* FROM businesses b
    WHERE b.kapso_customer_id IS NOT NULL
      AND b.phone_number_id IS NULL
      AND b.kapso_connect_started_at IS NOT NULL
      AND b.kapso_connect_started_at <= datetime('now', '-30 minutes')
      AND b.kapso_incomplete_alerted_at IS NULL
  `).all();
}

function getWeeklyStats(businessId) {
  const since = "datetime('now', '-7 days')";
  const aiReplies = db.prepare(`
    SELECT COUNT(*) as n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.business_id = ? AND m.role = 'assistant' AND m.created_at >= ${since}
  `).get(businessId).n;

  const escalated = db.prepare(`
    SELECT COUNT(DISTINCT c.id) as n FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE c.business_id = ? AND c.needs_attention = 1 AND m.created_at >= ${since}
  `).get(businessId).n;

  // Average seconds between consecutive user→assistant message pairs in the same conversation
  const avgSeconds = db.prepare(`
    SELECT AVG(diff) as avg FROM (
      SELECT (julianday(a.created_at) - julianday(u.created_at)) * 86400 as diff
      FROM messages u
      JOIN messages a ON a.conversation_id = u.conversation_id AND a.id = (
        SELECT id FROM messages
        WHERE conversation_id = u.conversation_id AND role = 'assistant' AND id > u.id
        ORDER BY id ASC LIMIT 1
      )
      JOIN conversations c ON c.id = u.conversation_id
      WHERE c.business_id = ? AND u.role = 'user' AND u.created_at >= ${since}
        AND (julianday(a.created_at) - julianday(u.created_at)) * 86400 < 120
    )
  `).get(businessId).avg;

  const autoResumed = db.prepare(`
    SELECT COUNT(*) as n FROM conversations
    WHERE business_id = ? AND auto_resumed_at >= unixepoch('now', '-7 days')
  `).get(businessId).n;

  return { aiReplies, escalated, avgSeconds: avgSeconds ? Math.round(avgSeconds) : null, autoResumed };
}

function getBusinessesWithWeeklySummary() {
  return db.prepare('SELECT * FROM businesses WHERE weekly_summary_enabled = 1 AND phone_number_id IS NOT NULL').all().map(b => ({
    ...b,
    wa_access_token: b.wa_access_token && ENC_KEY ? decrypt(b.wa_access_token) : b.wa_access_token,
  }));
}

function setRuntimeConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO runtime_config (key, value) VALUES (?, ?)').run(key, value);
}

function getRuntimeConfig(key) {
  const row = db.prepare('SELECT value FROM runtime_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function logError(context, err) {
  try {
    db.prepare('INSERT INTO error_log (context, message, stack) VALUES (?, ?, ?)').run(
      context,
      String(err?.message ?? err),
      String(err?.stack ?? '')
    );
  } catch (_) {}
}

function getRecentErrors(limit = 20) {
  return db.prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT ?').all(limit);
}

const stmtErrorsAll     = db.prepare('SELECT id, context, message, created_at FROM error_log ORDER BY id DESC LIMIT ?');
const stmtErrorsByCtx   = db.prepare('SELECT id, context, message, created_at FROM error_log WHERE context = ? ORDER BY id DESC LIMIT ?');
function getErrorsFiltered(context, limit) {
  return context
    ? stmtErrorsByCtx.all(context, limit)
    : stmtErrorsAll.all(limit);
}

function checkpoint() {
  return db.pragma('wal_checkpoint(FULL)');
}

function backupToFile(destPath) {
  return db.backup(destPath);
}

function closeDb() {
  db.close();
}

// ── Webhook deduplication ────────────────────────────────────────────────────

const stmtMarkProcessed   = db.prepare('INSERT OR IGNORE INTO processed_messages (business_id, msg_id) VALUES (?, ?)');
const stmtDeleteProcessed = db.prepare('DELETE FROM processed_messages WHERE business_id = ? AND msg_id = ?');

function tryMarkProcessed(businessId, msgId) {
  return stmtMarkProcessed.run(businessId, msgId).changes === 1;
}

function deleteProcessedMessage(businessId, msgId) {
  stmtDeleteProcessed.run(businessId, msgId);
}

function purgeOldProcessedMessages() {
  db.prepare("DELETE FROM processed_messages WHERE created_at < datetime('now', '-7 days')").run();
}

// ── Claude usage logging ─────────────────────────────────────────────────────

function logClaudeUsage(businessId, conversationId, model, usage, write5m = 0, write1h = 0) {
  return db.prepare(`
    INSERT INTO claude_usage
      (business_id, conversation_id, model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    businessId,
    conversationId ?? null,
    model,
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0,
    write5m,
    write1h
  ).lastInsertRowid;
}

function setClaudeUsageTtsChars(usageId, chars) {
  if (!usageId) return;
  db.prepare('UPDATE claude_usage SET tts_chars = ? WHERE id = ?').run(chars, usageId);
}

function getClaudeUsageDailySummary(days = 7) {
  return db.prepare(`
    SELECT
      date(created_at)                                          AS day,
      COUNT(*)                                                  AS replies,
      SUM(input_tokens)                                         AS input_tokens,
      SUM(output_tokens)                                        AS output_tokens,
      SUM(cache_read_tokens)                                    AS cache_read_tokens,
      SUM(cache_write_tokens)                                   AS cache_write_tokens,
      SUM(cache_write_5m_tokens)                               AS cache_write_5m_tokens,
      SUM(cache_write_1h_tokens)                               AS cache_write_1h_tokens,
      SUM(CASE WHEN tts_chars IS NOT NULL THEN 1 ELSE 0 END)   AS audio_replies,
      SUM(COALESCE(tts_chars, 0))                              AS total_tts_chars
    FROM claude_usage
    WHERE created_at >= datetime('now', ?)
    GROUP BY date(created_at)
    ORDER BY day DESC
  `).all(`-${days} days`);
}

function getClaudeUsageByBusiness(days = 30) {
  return db.prepare(`
    SELECT
      date(u.created_at)                                          AS day,
      u.business_id,
      b.name                                                      AS business_name,
      COUNT(*)                                                    AS replies,
      SUM(u.input_tokens)                                         AS input_tokens,
      SUM(u.output_tokens)                                        AS output_tokens,
      SUM(u.cache_read_tokens)                                    AS cache_read_tokens,
      SUM(u.cache_write_tokens)                                   AS cache_write_tokens,
      SUM(u.cache_write_5m_tokens)                               AS cache_write_5m_tokens,
      SUM(u.cache_write_1h_tokens)                               AS cache_write_1h_tokens,
      SUM(CASE WHEN u.tts_chars IS NOT NULL THEN 1 ELSE 0 END)   AS audio_replies,
      SUM(COALESCE(u.tts_chars, 0))                              AS total_tts_chars
    FROM claude_usage u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.created_at >= datetime('now', ?)
    GROUP BY date(u.created_at), u.business_id
    ORDER BY day DESC, u.business_id
  `).all(`-${days} days`);
}

function getConnectedBusinesses() {
  return db.prepare(
    'SELECT id, name, whatsapp_number, phone_number_id, wa_connected_at, wa_silence_alerted_at, wa_health_alerted_at FROM businesses WHERE phone_number_id IS NOT NULL'
  ).all();
}

function setWaSilenceAlertedAt(businessId, epochSec) {
  db.prepare('UPDATE businesses SET wa_silence_alerted_at = ? WHERE id = ?').run(epochSec, businessId);
}

function clearWaSilenceAlertedAt(businessId) {
  db.prepare('UPDATE businesses SET wa_silence_alerted_at = NULL WHERE id = ?').run(businessId);
}

function setWaHealthAlertedAt(businessId, epochSec) {
  db.prepare('UPDATE businesses SET wa_health_alerted_at = ? WHERE id = ?').run(epochSec, businessId);
}

function clearWaHealthAlertedAt(businessId) {
  db.prepare('UPDATE businesses SET wa_health_alerted_at = NULL WHERE id = ?').run(businessId);
}

function purgeOldErrorLog() {
  return db.prepare(`DELETE FROM error_log WHERE created_at < datetime('now', '-30 days')`).run();
}

function getLastWebhookInboundAt(businessId) {
  const row = db.prepare(
    `SELECT created_at FROM error_log WHERE context = 'webhook-lookup' AND message LIKE ? AND message LIKE '%found=true%' ORDER BY id DESC LIMIT 1`
  ).get(`%business_id=${businessId}%`);
  return row?.created_at ?? null;
}

function getRecentWaStatusFailed(phoneNumberId) {
  const rows = db.prepare(
    `SELECT message, created_at FROM error_log WHERE context = 'wa-status-failed' AND message LIKE ? AND created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 10`
  ).all(`%phone_number_id=${phoneNumberId}%`);
  return rows.map(r => {
    const code  = (r.message.match(/code=(\S+)/)          || [])[1] ?? null;
    const title = (r.message.match(/title=(.*?)(?:\s+msg=|\s+details=|$)/) || [])[1]?.trim() ?? null;
    return { code, title, at: r.created_at };
  });
}

const stmtInsertEsPending  = db.prepare('INSERT OR REPLACE INTO es_pending (business_id) VALUES (?)');
const stmtGetActivePending = db.prepare("SELECT business_id FROM es_pending WHERE created_at >= datetime('now', '-20 minutes')");
const stmtDeleteEsPending  = db.prepare('DELETE FROM es_pending WHERE business_id = ?');
const stmtCleanEsPending   = db.prepare("DELETE FROM es_pending WHERE created_at < datetime('now', '-20 minutes')");

function insertEsPending(businessId)  { stmtInsertEsPending.run(Number(businessId)); }
function getActivePendingBusinesses() { return stmtGetActivePending.all(); }
function deleteEsPending(businessId)  { stmtDeleteEsPending.run(Number(businessId)); }
function cleanExpiredEsPending()      { stmtCleanEsPending.run(); }

// ─── Demo generator ──────────────────────────────────────────────────────────

function createDemo({ slug, dataJson, sourceUrl, whatsappContacto, ip, durationMs, expiresAt }) {
  db.prepare(`
    INSERT INTO demos (slug, data_json, source_url, whatsapp_contacto, ip, duration_ms, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(slug, dataJson, sourceUrl, whatsappContacto ?? null, ip ?? null, durationMs ?? null, expiresAt);
  return db.prepare('SELECT * FROM demos WHERE slug = ?').get(slug);
}

function getDemo(slug) {
  return db.prepare('SELECT * FROM demos WHERE slug = ?').get(slug) || null;
}

function patchDemo(slug, dataJson) {
  db.prepare('UPDATE demos SET data_json = ? WHERE slug = ?').run(dataJson, slug);
}

function incrementDemoMsgCount(slug) {
  db.prepare('UPDATE demos SET msg_count = msg_count + 1 WHERE slug = ?').run(slug);
}

function getDemoDailyCountByIp(ip) {
  return db.prepare(
    "SELECT COUNT(*) as n FROM demos WHERE ip = ? AND datetime(created_at) >= datetime('now', '-1 day')"
  ).get(ip)?.n ?? 0;
}

function getDemoDailyCountByPhone(phone) {
  return db.prepare(
    "SELECT COUNT(*) as n FROM demos WHERE whatsapp_contacto = ? AND datetime(created_at) >= datetime('now', '-1 day')"
  ).get(phone)?.n ?? 0;
}

function getDemoDailyGlobalCount() {
  return db.prepare(
    "SELECT COUNT(*) as n FROM demos WHERE datetime(created_at) >= datetime('now', '-1 day')"
  ).get()?.n ?? 0;
}

function logDemoCost({ demoId, event, inTokens, outTokens }) {
  db.prepare('INSERT INTO demo_costs (demo_id, event, in_tokens, out_tokens) VALUES (?, ?, ?, ?)')
    .run(demoId ?? null, event, inTokens ?? 0, outTokens ?? 0);
}

function getDemoFlowSession(phone) {
  return db.prepare('SELECT * FROM demo_flow_sessions WHERE phone = ?').get(phone) || null;
}

function upsertDemoFlowSession(phone, state, demoSlug, extra = {}) {
  const now = new Date().toISOString();
  const existing = getDemoFlowSession(phone);
  if (existing) {
    db.prepare(`
      UPDATE demo_flow_sessions SET state = ?, demo_slug = ?, followup_sent = ?,
      followup_eligible_at = ?, updated_at = ? WHERE phone = ?
    `).run(
      state,
      demoSlug ?? existing.demo_slug,
      extra.followup_sent ?? existing.followup_sent,
      extra.followup_eligible_at ?? existing.followup_eligible_at,
      now, phone
    );
  } else {
    db.prepare(`
      INSERT INTO demo_flow_sessions (phone, state, demo_slug, followup_eligible_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(phone, state, demoSlug ?? null, extra.followup_eligible_at ?? null, now, now);
  }
  return getDemoFlowSession(phone);
}

function deleteDemoFlowSession(phone) {
  db.prepare('DELETE FROM demo_flow_sessions WHERE phone = ?').run(phone);
}

// Returns sessions eligible for follow-up: state=listo, not sent, 2h elapsed, still within 22h
function getDemosForFollowup() {
  return db.prepare(`
    SELECT * FROM demo_flow_sessions
    WHERE state = 'listo'
      AND followup_sent = 0
      AND followup_eligible_at IS NOT NULL
      AND datetime(followup_eligible_at) <= datetime('now')
      AND datetime(created_at) >= datetime('now', '-22 hours')
  `).all();
}

// Match sender phone to a registered business owner (last 8 digits, tolerates local/intl formats)
function getUserByPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return null;
  const suffix = digits.slice(-8);
  const users = db.prepare("SELECT * FROM users WHERE phone IS NOT NULL AND phone != ''").all();
  return users.find(u => u.phone && u.phone.replace(/\D/g, '').endsWith(suffix)) || null;
}
