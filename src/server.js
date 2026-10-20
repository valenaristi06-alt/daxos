// Capture BEFORE any require — even before dotenv — into a frozen global.
// If dotenv or any library mutates process.env later, this value is safe.
globalThis.__DAXOS_ENV = Object.freeze({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });

require('dotenv').config({ path: '.env.local' });

const _apiKey = process.env.ANTHROPIC_API_KEY;
console.log('[startup] PID=' + process.pid + ' ANTHROPIC_API_KEY present:', !!_apiKey, '| length:', _apiKey?.length ?? 0, '| prefix:', _apiKey ? _apiKey.slice(0, 8) : 'MISSING');
console.log('[startup] PID=' + process.pid + ' globalThis capture present:', !!globalThis.__DAXOS_ENV.ANTHROPIC_API_KEY, '| length:', globalThis.__DAXOS_ENV.ANTHROPIC_API_KEY?.length ?? 0);

const TRIAL_CONV_LIMIT  = 150;
const TRIAL_WARN_CONVS  = 120;
const TRIAL_GRACE_CONVS = 25;
const TRIAL_WARN_DAYS   = 11;
const TRIAL_GRACE_HOURS = 72;
const AUDIO_MAX_CHARS   = 600;

// Mercado Pago plan mapping — single source of truth
const MP_AMOUNT_TO_PLAN = { 2990: 'arranque', 5990: 'crecimiento', 12990: 'a_medida' };
const MP_REF_TO_PLAN    = { arranque: 'arranque', crecimiento: 'crecimiento', negocio: 'a_medida' };

// Spending cap defaults per plan (overridable via runtime_config)
const _CAP_ANTHROPIC = { arranque: 70,  crecimiento: 150, a_medida: 300  };
const _CAP_TTS_CHARS = { arranque: 20000, crecimiento: 100000, a_medida: 500000 };
const _CAP_CONV_HOURLY = 8;

function _getAnthropicDailyCap(plan) {
  const override = getRuntimeConfig ? (() => { try { return getRuntimeConfig(`cap_daily_anthropic_${plan}`); } catch { return null; } })() : null;
  return override ? parseInt(override, 10) : (_CAP_ANTHROPIC[plan] ?? 200);
}
function _getTtsDailyCap(plan) {
  const override = getRuntimeConfig ? (() => { try { return getRuntimeConfig(`cap_daily_tts_${plan}`); } catch { return null; } })() : null;
  return override ? parseInt(override, 10) : (_CAP_TTS_CHARS[plan] ?? 20000);
}
function _getConvHourlyCap() {
  const override = getRuntimeConfig ? (() => { try { return getRuntimeConfig('cap_conv_hourly'); } catch { return null; } })() : null;
  return override ? parseInt(override, 10) : _CAP_CONV_HOURLY;
}
// Matches the same rule as src/whatsapp.js: Railway always sets RAILWAY_ENVIRONMENT even when NODE_ENV is absent.
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

const crypto = require('crypto');
const dns    = require('dns').promises;
const net    = require('net');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const BetterSQLiteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const multer = require('multer');
const { createUser, getUserByEmail, changeUserEmail, setPlanCortesia, getUserById, getUserByBusinessId, upsertBusiness, getBusinessById, getBusinessByWhatsappNumber, getBusinessByPhoneNumberId, getBusinessByWabaId, getBusinessByUserId, setUserBusiness, setUserPhone, setStyleProfile, setWebsiteSummary, saveVoiceConsent, getConversationsByBusinessId, getConversationCountByBusinessId, getLastCustomerMessage, getConversationById, getOrCreateConversation, addMessage, getLastUserMessageAt, getConversationHistory, markConversationPaused, markConversationResumed, setNeedsHuman, setHumanPaused, clearHumanPause, getConversationsNeedingHumanResume, autoResumeExpiredConversations, getDailyConversationStats, getTodayStats, getDailyMessageStats, setConversationLabel, setBusinessDocument, clearBusinessDocument, upgradePlan, setSubscriptionStatus, savePayment, savePendingPayment, getPendingPayments, getAllBusinesses, getGlobalStats, getBusinessAdminMetrics, saveWabaCredentials, clearWabaCredentials, setWaPaymentConfirmed, getTrialMessageCount, getTrialConversationCount, setTrialWarnedAt, setTrialGraceStartedAt, setTrialGraceNotifiedAt, setTrialEndedNotifiedAt, markConversationPausedByTrial, getTrialBusinesses, setBillingData, setBillingNotifiedAt, createBooking, setBookingState, getBookingState, setBookingEnabled, setWeeklySummaryEnabled, setRuntimeConfig, getRuntimeConfig, logError, getRecentErrors, getErrorsFiltered, checkpoint, closeDb, setKapsoCustomerId, setKapsoSetupLinkId, getBusinessByKapsoCustomerId, setKapsoConnectStartedAt, setKapsoIncompleteAlertedAt, getBusinessesWithIncompleteKapso, addBusinessImage, getBusinessImages, deleteBusinessImage, getBusinessDocuments, getBusinessDocumentTexts, addBusinessDocument, deleteBusinessDocument, getTagsByBusiness, createTag, deleteTag, setConversationTags, getConversationTags, tryMarkProcessed, deleteProcessedMessage, purgeOldProcessedMessages, setSilentUntil, clearSilentUntil, setConversationSilent, setClaudeUsageTtsChars, getClaudeUsageDailySummary, getClaudeUsageByBusiness, markConversationPausedByKeyword, recordKeywordPauseReply, setPauseNotifiedAt, setPauseFollowupSent, setPause24hSent, getKeywordPausedNeedingFollowup, getKeywordPausedNeeding24h, getConnectedBusinesses, setWaSilenceAlertedAt, clearWaSilenceAlertedAt, setWaHealthAlertedAt, clearWaHealthAlertedAt, purgeOldErrorLog,
  incrementAnthropicCall, incrementElevenLabsChars, getSpendingToday,
  getConvAssistantCountLastHour, setSpendingCapNotified,
  createPasswordResetToken, getPasswordResetToken, markPasswordResetTokenUsed, changeUserPassword,
  insertEsPending, getActivePendingBusinesses, deleteEsPending, cleanExpiredEsPending,
  getLastWebhookInboundAt, getRecentWaStatusFailed,
  isPaymentProcessed,
  createDemo, getDemo, patchDemo, incrementDemoMsgCount,
  getDemoDailyCountByIp, getDemoDailyCountByPhone, getDemoDailyGlobalCount,
  logDemoCost, getDemoFlowSession, upsertDemoFlowSession, deleteDemoFlowSession,
  getDemosForFollowup, getUserByPhone } = require('./db');

// If startup process has the key but request-handler process doesn't,
// persist it to the shared SQLite DB so getClient() can retrieve it.
if (_apiKey) {
  try { setRuntimeConfig('ANTHROPIC_API_KEY', _apiKey); } catch (_) {}
  console.log('[startup] PID=' + process.pid + ' key saved to DB');
}
const { generateReply, analyzeStyle, summarizeWebsite, initAnthropicKey, getLastClaudeUsageId } = require('./claude');
initAnthropicKey(_apiKey);
const { handleOwnerBookingReply, checkBookingTimeouts, notifyOwnerOfBooking } = require('./bookings');
const { handleDemoFlow, processFollowups } = require('./demo-flow');
const { sendWeeklySummaries } = require('./weekly');
const { cloneVoice, generatePreview, deleteVoice } = require('./elevenlabs');
const { sendPauseEmail, sendUnmatchedPaymentAlert, sendAdminNotificationEmail, sendTrialWarningEmail, sendTrialGraceEmail, sendTrialEndedEmail, sendBillingDataEmail, sendPauseFollowupEmail, sendPause24hReminderEmail, sendWaSilenceAlertEmail, sendWaSilenceRecoveryEmail, sendWaHealthAlertEmail, sendWaHealthRecoveryEmail, sendPasswordResetEmail } = require('./email');
const { runBackup, maybeScheduledBackup, maybeSilenceAlert, startupBackupCheck, getLatestBackupMeta, listAllBackups } = require('./backup');

if (!process.env.RESEND_API_KEY) {
  console.warn('[startup] RESEND_API_KEY not set — password reset emails will be silently skipped');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Accept any audio/* type — backend converts everything to MP3 before ElevenLabs
    if (!file.mimetype.startsWith('audio/')) return cb(new Error('El archivo debe ser de audio'));
    cb(null, true);
  },
});

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Solo se aceptan archivos PDF'));
    cb(null, true);
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(new Error('Solo se aceptan imágenes JPG o PNG'));
    cb(null, true);
  },
});

const SCRIPT_MIMES = [
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];
const scriptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = SCRIPT_MIMES.includes(file.mimetype) ||
               file.originalname.endsWith('.txt') ||
               file.originalname.endsWith('.md') ||
               file.originalname.endsWith('.pdf') ||
               file.originalname.endsWith('.docx');
    if (!ok) return cb(new Error('Solo se aceptan archivos .txt, .md, .pdf o .docx'));
    cb(null, true);
  },
});

async function extractTextFromFile(buffer, mimetype, originalname) {
  const mime = mimetype;
  const name = originalname.toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const pdfParseLib = require('pdf-parse');
    const pdfParse = pdfParseLib.default ?? pdfParseLib;
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword' ||
    name.endsWith('.docx')
  ) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return buffer.toString('utf8');
}

const fs = require('fs');
const { sendWhatsAppMessage, uploadMedia, sendWhatsAppAudio, sendWhatsAppDocument, sendWhatsAppImage, markAsRead, sendTypingIndicator, downloadKapsoMedia, downloadMetaMedia } = require('./whatsapp');
const { generateAudioBuffer, transcribeAudio } = require('./elevenlabs');
const { convertToOgg } = require('./audio');

fs.mkdirSync(path.join(__dirname, '../data/uploads'), { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
const MSG_MAX_AGE_MINUTES = parseInt(process.env.MSG_MAX_AGE_MINUTES) || 120;

// Stale-message daily summary counters (in-memory; reset on deploy — that's fine)
let _staleMsgCount = 0;
let _staleMsgDate  = null;
// Per-business-id date string (UY) of last msg-timestamp-field log — avoid log spam
const _timestampFieldLogDate = {};
// Image rate-limit counters: key = `${convId}:${hourKey}` → count
const _imgHourCount   = new Map();
// Fallback-send throttle: key = `${convId}:${hourKey}` → true (1 fallback/h/conv)
const _imgFallbackSent = new Map();

function pruneImgMaps(currentHourKey) {
  for (const k of _imgHourCount.keys()) {
    if (Number(k.slice(k.lastIndexOf(':') + 1)) < currentHourKey) _imgHourCount.delete(k);
  }
  for (const k of _imgFallbackSent.keys()) {
    if (Number(k.slice(k.lastIndexOf(':') + 1)) < currentHourKey) _imgFallbackSent.delete(k);
  }
}

function detectMimeFromBytes(buf) {
  if (!buf || buf.length < 4) return null;
  // Images
  if (buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF) return 'image/jpeg';
  if (buf.length>=8 && buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47 &&
      buf[4]===0x0D && buf[5]===0x0A && buf[6]===0x1A && buf[7]===0x0A) return 'image/png';
  if (buf.length>=12 && buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46 &&
      buf[8]===0x57 && buf[9]===0x45 && buf[10]===0x42 && buf[11]===0x50) return 'image/webp';
  // PDF
  if (buf[0]===0x25 && buf[1]===0x50 && buf[2]===0x44 && buf[3]===0x46) return 'application/pdf';
  // Audio: OGG
  if (buf[0]===0x4F && buf[1]===0x67 && buf[2]===0x67 && buf[3]===0x53) return 'audio/ogg';
  // Audio: RIFF/WAVE
  if (buf.length>=12 && buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46 &&
      buf[8]===0x57 && buf[9]===0x41 && buf[10]===0x56 && buf[11]===0x45) return 'audio/wav';
  // Audio: MP3 — ID3 tag
  if (buf[0]===0x49 && buf[1]===0x44 && buf[2]===0x33) return 'audio/mpeg';
  // Audio: MP3 — sync word
  if (buf[0]===0xFF && (buf[1]===0xFB || buf[1]===0xF3 || buf[1]===0xF2 || buf[1]===0xFA)) return 'audio/mpeg';
  // Audio: M4A/MP4 — ftyp at offset 4
  if (buf.length>=12 && buf[4]===0x66 && buf[5]===0x74 && buf[6]===0x79 && buf[7]===0x70) return 'audio/mp4';
  // ZIP-based (DOCX, XLSX, PPTX)
  if (buf[0]===0x50 && buf[1]===0x4B && buf[2]===0x03 && buf[3]===0x04) return 'application/zip';
  return null;
}

// Returns error string if magic bytes don't match expected prefixes; null if ok.
function validateUploadBytes(buffer, allowedPrefixes) {
  const detected = detectMimeFromBytes(buffer);
  if (!detected) return null; // unknown type — allow (text files, etc.)
  if (!allowedPrefixes.some(p => detected.startsWith(p))) {
    return `Tipo de archivo detectado como "${detected}", se esperaba ${allowedPrefixes.join(' o ')}.`;
  }
  return null;
}

// Railway sits behind a single reverse proxy — trust only that hop so req.ip is the real client IP.
app.set('trust proxy', 1);

app.use(helmet({
  // CSP desactivado: el dashboard tiene <script> inline y carga SDK de Facebook.
  // Activar CSP con nonces requiere refactor del frontend; se deja como mejora futura.
  contentSecurityPolicy: false,
}));

// CORS: esta app sirve su propio frontend desde la misma origin.
// No se exponen headers CORS por defecto; si se necesita un origen externo en el futuro
// configurar CORS_ALLOWED_ORIGIN en las env vars.
const _corsAllowedOrigin = process.env.CORS_ALLOWED_ORIGIN || false;
app.use(cors({ origin: _corsAllowedOrigin, credentials: !!_corsAllowedOrigin }));

app.use(express.json({
  verify: (req, _res, buf) => {
    if (req.path.startsWith('/webhook')) req.rawBody = buf;
  },
}));
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('[startup] FATAL: SESSION_SECRET not set in production. Set this env var and restart.');
  process.exit(1);
}

const sessionsDb = new Database(path.join(__dirname, '../data/sessions.db'));

app.use(session({
  store: new BetterSQLiteStore({ client: sessionsDb }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días, se renueva en cada request
  },
}));

// --- Rate limiter in-memory (5 intentos / 15 min por IP; y por email en login) ---
// Active when IS_PROD=true OR ENABLE_RATE_LIMIT=true.
// ENABLE_RATE_LIMIT allows integration tests to test the rate limiter without setting IS_PROD.
const RATE_LIMIT_ENABLED = IS_PROD || process.env.ENABLE_RATE_LIMIT === 'true';
const _rlStore = new Map();
const RL_MAX = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;

function _rlCheck(key, max = RL_MAX, windowMs = RL_WINDOW_MS) {
  const now = Date.now();
  let entry = _rlStore.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 0, windowStart: now };
    _rlStore.set(key, entry);
  }
  entry.count++;
  return entry.count > max;
}

function rateLimit(...keyFns) {
  return (req, res, next) => {
    if (!RATE_LIMIT_ENABLED) return next();
    const keys = keyFns.map(fn => fn(req)).filter(Boolean);
    for (const key of keys) {
      if (_rlCheck(key)) {
        return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos e intentá de nuevo.' });
      }
    }
    next();
  };
}

function rateLimitWith(max, windowMs, ...keyFns) {
  return (req, res, next) => {
    if (!RATE_LIMIT_ENABLED) return next();
    const keys = keyFns.map(fn => fn(req)).filter(Boolean);
    for (const key of keys) {
      if (_rlCheck(key, max, windowMs)) {
        return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' });
      }
    }
    next();
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});
app.get('/conversations', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/conversations.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/register.html'));
});

app.use(express.static(path.join(__dirname, '../public')));
app.get('/ayuda/conectar-whatsapp', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/ayuda/conectar-whatsapp.html'));
});
// Block direct access to document PDFs — served only via authenticated endpoint.
// Product images remain accessible (they have unpredictable names and are not sensitive).
app.use('/uploads', (req, res, next) => {
  if (/^\/doc-\d+\.pdf$/i.test(req.path)) return res.status(403).send('Forbidden');
  next();
}, express.static(path.join(__dirname, '../data/uploads'), { index: false }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Fields the owner's browser is allowed to see. Everything else is stripped.
// Keeps credentials (wa_access_token), internal tracking (kapso_*_at, kapso_setup_link_id),
// and server paths (document_path) off the wire.
const OWNER_BUSINESS_FIELDS = new Set([
  'id', 'name', 'whatsapp_number', 'created_at',
  'website_url', 'website_summary', 'business_context', 'pricing_info',
  'sales_examples', 'survey_answers', 'style_profile',
  'document_name',
  'response_mode', 'response_delay', 'pause_keywords', 'pause_reply_text',
  'business_hours_start', 'business_hours_end', 'human_resume_timeout',
  'voice_id', 'voice_consent_at',
  'plan', 'plan_cortesia', 'subscription_status',
  'plan_paid_at', 'plan_expires_at',
  'trial_starts_at', 'trial_ends_at',
  'trial_warned_at', 'trial_grace_started_at',
  'trial_conv_count', 'trial_conv_limit',
  'wa_provider', 'phone_number_id', 'waba_id', 'wa_payment_confirmed', 'wa_connected_at',
  'kapso_customer_id',
  'booking_enabled', 'weekly_summary_enabled',
  'billing_requires_invoice', 'billing_legal_name', 'billing_rut', 'billing_address', 'billing_email', 'billing_updated_at',
]);

function ownerView(biz) {
  if (!biz) return null;
  const out = {};
  for (const k of OWNER_BUSINESS_FIELDS) {
    if (k in biz) out[k] = biz[k];
  }
  return out;
}

// --- Auth routes ---

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'No autenticado' });
}

app.post('/auth/register',
  rateLimit(req => `reg:ip:${req.ip}`),
  async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    const existing = getUserByEmail(email);
    if (existing) {
      // No enumeration: return 200 without creating session — user must log in
      return res.json({ ok: true, email });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      const user = createUser(email, hash);
      req.session.userId = user.id;
      res.json({ ok: true, email: user.email });
      notifyAdmin('registration', { email }).catch(() => {});
    } catch (err) {
      logError('register-error', { message: err.message, stack: err.stack || '' });
      res.status(500).json({ error: 'Error al crear la cuenta. Intentá de nuevo.' });
    }
  });

app.post('/auth/login',
  rateLimit(req => `login:ip:${req.ip}`, req => `login:email:${(req.body?.email || '').toLowerCase().trim()}`),
  async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const user = getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

    try {
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'Credenciales incorrectas' });
      req.session.userId = user.id;
      res.json({ ok: true, email: user.email });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

const FORGOT_GENERIC = { ok: true, message: 'Si ese email está registrado, vas a recibir un enlace para restablecer tu contraseña.' };

app.post('/auth/forgot-password',
  rateLimit(req => `forgot:ip:${req.ip}`, req => `forgot:email:${(req.body?.email || '').toLowerCase().trim()}`),
  async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.json(FORGOT_GENERIC);
    const user = getUserByEmail(email.toLowerCase().trim());
    if (user) {
      try {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        createPasswordResetToken(user.id, tokenHash, expiresAt);
        const appUrl = process.env.APP_URL || 'https://daxos.lat';
        const resetUrl = `${appUrl}/reset-password.html?token=${token}`;
        await sendPasswordResetEmail({ to: user.email, resetUrl })
          .catch(err => logError('forgot-password-email', { message: err.message, stack: '' }));
      } catch (err) {
        logError('forgot-password', { message: err.message, stack: err.stack || '' });
      }
    }
    res.json(FORGOT_GENERIC);
  }
);

app.post('/auth/reset-password',
  rateLimit(req => `reset:ip:${req.ip}`),
  async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token y contraseña requeridos.' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokenRow = getPasswordResetToken(tokenHash);
    if (!tokenRow || tokenRow.used || new Date(tokenRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'El enlace es inválido o ya expiró.' });
    }
    try {
      const hash = await bcrypt.hash(password, 12);
      changeUserPassword(tokenRow.user_id, hash);
      markPasswordResetTokenUsed(tokenRow.id);
      res.json({ ok: true });
    } catch (err) {
      logError('reset-password', { message: err.message, stack: err.stack || '' });
      res.status(500).json({ error: 'Error al actualizar la contraseña.' });
    }
  }
);

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/reset-password.html'));
});

app.get('/auth/me', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Sesión inválida' });
  res.json({ id: user.id, email: user.email, phone: user.phone || null });
});

app.put('/auth/me', requireAuth, (req, res) => {
  const { phone } = req.body;
  setUserPhone(req.session.userId, phone ? phone.trim() : null);
  const user = getUserById(req.session.userId);
  res.json({ id: user.id, email: user.email, phone: user.phone || null });
});

// --- Panel API ---

app.get('/api/config', (req, res) => {
  res.json({
    metaAppId: process.env.META_APP_ID || null,
    // TODO: reemplazar cuando se apruebe la Verificación de acceso en Meta Business Manager
    whatsappConfigId: process.env.WHATSAPP_CONFIG_ID || null,
    metaEsConfigId: process.env.META_ES_CONFIG_ID || null,
  });
});

app.get('/api/business', requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  if (!business) return res.json(null);
  if (business.plan === 'arranque' && business.trial_starts_at && !business.plan_cortesia) {
    const trial_conv_count = getTrialConversationCount(business.id, business.trial_starts_at);
    return res.json(ownerView({ ...business, trial_conv_count, trial_conv_limit: TRIAL_CONV_LIMIT }));
  }
  res.json(ownerView(business));
});

app.patch('/api/business/wa-payment-confirmed', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'No business' });
  setWaPaymentConfirmed(user.business_id);
  res.json({ ok: true });
});

// SSRF guard — shared implementation in src/ssrf.js
const { blockedReason: _ssrfBlockedReason, validateUrl: _validateSsrfUrl,
        MAX_RESPONSE_BYTES: SSRF_MAX_RESPONSE_BYTES, MAX_REDIRECTS: SSRF_MAX_REDIRECTS,
        TIMEOUT_MS: SSRF_TIMEOUT_MS } = require('./ssrf');

async function fetchAndSummarizeWebsite(rawUrl) {
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= SSRF_MAX_REDIRECTS; redirect++) {
    await _validateSsrfUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SSRF_TIMEOUT_MS);
    try {
      const res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'DaxosBot/1.0' },
      });
      // Follow redirect manually so we can re-validate the new URL
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Redirect sin destino');
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      // Enforce response size limit
      if (!res.body) throw new Error('Respuesta vacía');
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > SSRF_MAX_RESPONSE_BYTES) throw new Error('Respuesta demasiado grande');
        chunks.push(chunk);
      }
      const html = Buffer.concat(chunks).toString('utf8');
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return await summarizeWebsite(text);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Demasiados redirects');
}

app.put('/api/business', requireAuth, async (req, res) => {
  const { name, whatsapp_number, sales_examples, survey_answers, business_context, website_url, response_mode, pause_keywords, pause_reply_text, response_delay, pricing_info } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre del negocio es requerido' });

  const prtClean = pause_reply_text != null ? String(pause_reply_text).trim() : null;
  if (prtClean && prtClean.length > 300) {
    return res.status(400).json({ error: 'El mensaje al cliente es muy largo (máx 300 caracteres).', field: 'pause_reply_text' });
  }

  try {
    const user = getUserById(req.session.userId);
    console.log('[PUT /api/business] sessionUserId:', req.session.userId, '| user:', user?.id ?? 'NOT FOUND', '| existing business_id:', user?.business_id ?? 'null');

    const prevWebsiteUrl = user.business_id ? (getBusinessById(user.business_id)?.website_url ?? null) : null;
    const newUrl = website_url ? website_url.trim() : null;

    const business = upsertBusiness({
      id: user.business_id || undefined,
      name: name.trim(),
      whatsapp_number: whatsapp_number ? whatsapp_number.trim() : null,
      sales_examples,
      survey_answers,
      business_context: business_context ? business_context.trim() : null,
      website_url: newUrl,
      response_mode,
      pause_keywords: pause_keywords ? pause_keywords.trim() : null,
      pause_reply_text: prtClean || null,
      response_delay: response_delay != null ? Math.min(20, Math.max(0, parseInt(response_delay, 10) || 5)) : 5,
      pricing_info: pricing_info ? pricing_info.trim() : null,
    });
    console.log('[PUT /api/business] upsertBusiness result id:', business?.id ?? 'null');
    if (!user.business_id) {
      setUserBusiness(user.id, business.id);
      console.log('[PUT /api/business] setUserBusiness called:', user.id, '->', business.id);
    }

    // Style analysis — non-blocking, failure never interrupts save
    if (Array.isArray(sales_examples) && sales_examples.length > 0) {
      analyzeStyle(sales_examples)
        .then(profile => setStyleProfile(business.id, profile))
        .catch(err => console.error('[style-analysis] failed:', err.message));
    }

    // Website summary — non-blocking, solo si la URL cambió
    if (newUrl !== prevWebsiteUrl) {
      if (newUrl) {
        fetchAndSummarizeWebsite(newUrl)
          .then(summary => setWebsiteSummary(business.id, summary))
          .catch(err => console.error('[website-summary] failed:', err.message));
      } else {
        setWebsiteSummary(business.id, null);
      }
    }

    res.json(ownerView(business));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/business/billing', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'No tenés un negocio configurado.' });

  let { billing_requires_invoice, billing_legal_name, billing_rut, billing_address, billing_email } = req.body;

  // Normalize RUT: strip spaces, dots, dashes; store cleaned digits only
  if (billing_rut != null) billing_rut = String(billing_rut).replace(/[\s.\-]/g, '');

  const requiresInvoice = !!billing_requires_invoice;

  // Validate only when invoice is required
  if (requiresInvoice) {
    if (!billing_legal_name?.trim()) {
      return res.status(400).json({ error: 'La razón social es obligatoria.', field: 'billing_legal_name' });
    }
    if (billing_legal_name.trim().length > 200) {
      return res.status(400).json({ error: 'La razón social es muy larga (máx 200 caracteres).', field: 'billing_legal_name' });
    }
    if (billing_rut && !/^\d{12}$/.test(billing_rut)) {
      return res.status(400).json({ error: 'El RUT debe tener exactamente 12 dígitos numéricos.', field: 'billing_rut' });
    }
    if (billing_address && billing_address.trim().length > 300) {
      return res.status(400).json({ error: 'El domicilio es muy largo (máx 300 caracteres).', field: 'billing_address' });
    }
    if (billing_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billing_email)) {
      return res.status(400).json({ error: 'El mail de facturación es inválido.', field: 'billing_email' });
    }
    if (billing_email && billing_email.length > 254) {
      return res.status(400).json({ error: 'El mail de facturación es muy largo.', field: 'billing_email' });
    }
  }

  setBillingData(user.business_id, {
    billing_requires_invoice: requiresInvoice ? 1 : 0,
    billing_legal_name: billing_legal_name?.trim() || null,
    billing_rut: billing_rut || null,
    billing_address: billing_address?.trim() || null,
    billing_email: billing_email?.trim() || null,
  });

  console.log('[billing-data-saved] business', user.business_id);

  // Admin email: max 1/day/business, throttle stored in DB
  if (requiresInvoice && billing_legal_name?.trim() && billing_rut && billing_address?.trim() && billing_email?.trim()) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const biz = getBusinessById(user.business_id);
      const now = Date.now();
      const lastNotMs = parseSqliteUtc(biz.billing_notified_at);
      if (!lastNotMs || toUYDateStr(lastNotMs) !== toUYDateStr(now)) {
        setBillingNotifiedAt(user.business_id, new Date(now).toISOString());
        sendBillingDataEmail({ adminEmail, businessName: biz.name, businessId: biz.id })
          .catch(e => logError('billing-data-email', { message: e.message, stack: '' }));
      }
    }
  }

  res.json(ownerView(getBusinessById(user.business_id)));
});

app.post('/api/business/analyze-style', requireAuth, async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'No tenés un negocio configurado' });

  const business = getBusinessById(user.business_id);
  if (!business?.sales_examples?.length) {
    return res.status(400).json({ error: 'Agregá ejemplos de venta primero' });
  }

  try {
    const profile = await analyzeStyle(business.sales_examples);
    setStyleProfile(business.id, profile);
    res.json(profile);
  } catch (err) {
    console.error('[style-analysis] failed:', err.message);
    res.status(500).json({ error: 'El análisis falló. Intentá de nuevo.' });
  }
});

app.patch('/api/business/booking-enabled', requireAuth, (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'No business' });
  setBookingEnabled(user.business_id, enabled);
  console.log(`[booking-enabled] business=${user.business_id} enabled=${enabled}`);
  res.json({ ok: true, booking_enabled: enabled });
});

app.patch('/api/business/weekly-summary-enabled', requireAuth, (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'No business' });
  setWeeklySummaryEnabled(user.business_id, enabled);
  res.json({ ok: true, weekly_summary_enabled: enabled });
});

// Exact consent text — stored verbatim for legal record
const CONSENT_TEXT = 'Confirmo que esta es mi voz (o tengo autorización explícita de su dueño) y autorizo usarla para generar respuestas automáticas de este negocio.';

app.post('/api/business/voice', requireAuth, upload.single('audio'), async (req, res) => {
  if (req.body.consent !== 'true') {
    return res.status(400).json({ error: 'Se requiere consentimiento explícito para clonar la voz.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Archivo de audio requerido.' });
  }
  // Reject files that are clearly not audio (images, PDF, etc.)
  const audioMagicErr = validateUploadBytes(req.file.buffer, ['audio/']);
  if (audioMagicErr) return res.status(400).json({ error: 'El archivo no parece ser de audio.' });

  const user = getUserById(req.session.userId);
  if (!user.business_id) {
    return res.status(400).json({ error: 'Guardá el negocio antes de subir la voz.' });
  }

  const business = getBusinessById(user.business_id);

  if (!['crecimiento', 'a_medida'].includes(business.plan)) {
    return res.status(403).json({ error: 'La clonación de voz es parte del plan Crecimiento. Actualizá tu plan para usar esta función.' });
  }

  const shouldDeleteOld = req.body.delete_old === 'true' && business.voice_id;

  try {
    if (shouldDeleteOld) {
      await deleteVoice(business.voice_id);
    }
    const voiceId = await cloneVoice(business.name, req.file.buffer);
    saveVoiceConsent(business.id, {
      voiceId,
      consentText: CONSENT_TEXT,
      consentBy: user.email,
    });
    res.json({ voice_id: voiceId });
  } catch (err) {
    console.error('[elevenlabs] voice error:', err.message);
    res.status(502).json({ error: 'Error al procesar la voz: ' + err.message });
  }
});

app.post('/api/business/voice/preview', requireAuth, async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'No tenés un negocio configurado.' });

  const business = getBusinessById(user.business_id);
  if (!business.voice_id) return res.status(400).json({ error: 'No hay voz clonada todavía.' });

  try {
    const upstream = await generatePreview(business.voice_id);
    res.setHeader('Content-Type', 'audio/mpeg');
    const reader = upstream.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(Buffer.from(value));
      await pump();
    };
    await pump();
  } catch (err) {
    console.error('[elevenlabs] preview error:', err.message);
    res.status(502).json({ error: 'Error al generar la preview: ' + err.message });
  }
});

app.get('/api/debug/seed-conversations', requireAdmin, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'No business_id' });
  const biz = user.business_id;

  const contacts = [
    { phone: '59891234567', msgs: [
      { role: 'user', content: 'Hola, ¿tienen disponible el producto X?' },
      { role: 'assistant', content: 'Sí, está disponible. ¿Querés que te dé más detalles?' },
      { role: 'user', content: 'Sí por favor, ¿cuánto cuesta?' },
      { role: 'assistant', content: 'El precio es $2.500. ¿Te gustaría hacer un pedido?' },
    ]},
    { phone: '59899887766', msgs: [
      { role: 'user', content: 'Buenos días, necesito información sobre sus servicios' },
      { role: 'assistant', content: 'Buenos días. Con gusto te ayudo. ¿Qué servicio te interesa?' },
      { role: 'user', content: 'El plan mensual' },
    ]},
    { phone: '59898112233', msgs: [
      { role: 'user', content: '¿Hacen envíos a Montevideo?' },
      { role: 'assistant', content: 'Sí, hacemos envíos a todo Montevideo. El envío demora 24-48hs.' },
    ]},
  ];

  const created = [];
  for (const c of contacts) {
    const conv = getOrCreateConversation(biz, c.phone);
    for (const m of c.msgs) addMessage(conv.id, m.role, m.content);
    created.push(conv.id);
  }
  res.json({ ok: true, businessId: biz, conversationIds: created });
});

app.get('/api/debug/me', requireAdmin, (req, res) => {
  const user = getUserById(req.session.userId);
  const convCount = user?.business_id
    ? getConversationsByBusinessId(user.business_id).length
    : 0;
  res.json({ sessionUserId: req.session.userId, userId: user?.id, email: user?.email, businessId: user?.business_id ?? null, convCount });
});

// Registers business as pending ES connection (20-min window) for server-side auto-connect.
app.post('/api/es-pending', requireAuth, rateLimitWith(10, 15 * 60 * 1000, req => `es-pending:${req.session.userId}`), (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (business.phone_number_id) return res.status(400).json({ error: 'Ya conectado' });
  cleanExpiredEsPending();
  insertEsPending(business.id);
  res.json({ ok: true });
});

app.post('/api/debug/es-log', requireAuth, rateLimitWith(5, 15 * 60 * 1000, req => `es-log:user:${req.session.userId}`), (req, res) => {
  const { msg } = req.body;
  if (!msg || typeof msg !== 'string') return res.status(400).json({ error: 'msg requerido' });
  const user = getUserById(req.session.userId);
  logError('es-debug', {
    message: `business_id=${user?.business_id ?? 'null'} user_id=${user?.id ?? 'null'} ${String(msg).slice(0, 200)}`,
    stack: '',
  });
  res.json({ ok: true });
});

app.get('/api/conversations', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.json([]);
  const convs = getConversationsByBusinessId(user.business_id);
  res.json(convs);
});

app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  const conv = getConversationById(Number(req.params.id));
  if (!conv || !user.business_id || conv.business_id !== user.business_id) {
    return res.status(404).json({ error: 'No encontramos esa conversación' });
  }
  const messages = getConversationHistory(conv.id, 200);
  const business = getBusinessById(user.business_id);
  res.json({ conversation: conv, messages, wa_connected: !!business?.phone_number_id });
});

app.get('/api/stats', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.json({ conversation_count: 0, last_message: null });
  const conversation_count = getConversationCountByBusinessId(user.business_id);
  const last_message = getLastCustomerMessage(user.business_id);
  res.json({ conversation_count, last_message });
});

app.get('/api/stats/daily', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.json([]);
  res.json(getDailyConversationStats(user.business_id));
});

app.get('/api/stats/today', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.json({ messages24h: 0, uniqueClientsToday: 0, pausedToday: 0, resolvedToday: 0 });
  res.json(getTodayStats(user.business_id));
});

app.get('/api/stats/messages-daily', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.json([]);
  res.json(getDailyMessageStats(user.business_id));
});

app.patch('/api/conversations/:id/label', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Sin negocio.' });

  const conv = getConversationById(parseInt(req.params.id));
  if (!conv || conv.business_id !== user.business_id) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const { label } = req.body;
  const allowed = ['cliente', 'prospecto', 'no_interesado', null, ''];
  if (!allowed.includes(label)) return res.status(400).json({ error: 'Etiqueta inválida.' });

  setConversationLabel(conv.id, label || null);
  res.json({ ok: true });
});

// --- Tags ---

app.get('/api/tags', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  res.json(getTagsByBusiness(user.business_id));
});

app.post('/api/tags', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name requerido.' });
  const ALLOWED_COLORS = ['#3b82f6','#eab308','#22c55e','#6b7280','#f97316','#ef4444','#a855f7','#06b6d4'];
  if (!ALLOWED_COLORS.includes(color)) return res.status(400).json({ error: 'Color no permitido.' });
  try {
    const tag = createTag(user.business_id, name.trim(), color);
    res.json(tag);
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Ya existe una etiqueta con ese nombre.' });
    throw e;
  }
});

app.delete('/api/tags/:id', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  const result = deleteTag(user.business_id, Number(req.params.id));
  if (result === false) return res.status(404).json({ error: 'Etiqueta no encontrada.' });
  if (result === 'default') return res.status(403).json({ error: 'Las etiquetas predeterminadas no se pueden eliminar.' });
  res.json({ ok: true });
});

app.put('/api/conversations/:id/tags', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  const conv = getConversationById(parseInt(req.params.id));
  if (!conv || conv.business_id !== user.business_id) return res.status(404).json({ error: 'Conversación no encontrada.' });
  const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds.map(Number) : [];
  const ownedTags = getTagsByBusiness(user.business_id);
  const ownedTagIds = new Set(ownedTags.map(t => t.id));
  const safeTagIds = tagIds.filter(id => ownedTagIds.has(id));
  setConversationTags(conv.id, safeTagIds);
  res.json({ ok: true, tags: getConversationTags(conv.id) });
});

app.patch('/api/conversations/:id/resume', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Sin negocio.' });

  const conv = getConversationById(parseInt(req.params.id));
  if (!conv || conv.business_id !== user.business_id) return res.status(404).json({ error: 'Conversación no encontrada.' });

  markConversationResumed(conv.id); // also clears needs_human, human_paused_at
  res.json({ ok: true });
});

app.patch('/api/conversations/:id/pause', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Sin negocio.' });

  const conv = getConversationById(parseInt(req.params.id));
  if (!conv || conv.business_id !== user.business_id) return res.status(404).json({ error: 'Conversación no encontrada.' });

  setHumanPaused(conv.id);
  res.json({ ok: true });
});

app.post('/api/conversations/:id/send', requireAuth, rateLimitWith(30, 15 * 60 * 1000, req => `panel-send:user:${req.session.userId}`), async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Sin negocio.' });

  const conv = getConversationById(parseInt(req.params.id));
  if (!conv || conv.business_id !== user.business_id) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text requerido.' });
  if (text.length > 4096) return res.status(400).json({ error: 'El mensaje no puede superar los 4096 caracteres.' });

  const business = getBusinessById(user.business_id);
  if (!business?.phone_number_id) return res.status(400).json({ error: 'WhatsApp no conectado.' });

  // Ventana de 23.5h — 30 min de margen antes del límite real de Meta (24h)
  const WINDOW_MS = 23.5 * 3600 * 1000;
  const lastUserMsgAt = getLastUserMessageAt(conv.id);
  const lastUserMs = lastUserMsgAt ? parseSqliteUtc(lastUserMsgAt) : null;
  if (!lastUserMs || Date.now() - lastUserMs > WINDOW_MS) {
    return res.status(403).json({
      error: 'Para enviar un mensaje libre, el cliente tiene que haber escrito en las últimas 24 horas. Esta conversación superó ese límite — esperá a que el cliente escriba primero.',
      error_code: 'window_expired',
    });
  }

  const waCredentials = {
    phoneNumberId: business.phone_number_id,
    accessToken:   business.wa_access_token,
    provider:      business.wa_provider || 'meta',
  };

  try {
    await sendWhatsAppMessage(conv.customer_id, text.trim(), waCredentials);
  } catch (err) {
    logError('panel-send-error', err);
    if (err.message?.includes('131047')) {
      return res.status(403).json({
        error: 'Meta rechazó el mensaje porque el cliente no escribió en las últimas 24 horas. Esperá a que escriba primero.',
        error_code: 'window_expired',
      });
    }
    return res.status(502).json({ error: 'No se pudo enviar el mensaje por WhatsApp.' });
  }

  addMessage(conv.id, 'assistant', text.trim());
  // Respetar ventana silenciosa — guardar el mensaje pero no pausar el bot
  const silentUntilMs = parseSqliteUtc(business.silent_until);
  if (!silentUntilMs || Date.now() >= silentUntilMs) {
    setHumanPaused(conv.id);
  }
  res.json({ ok: true });
});

app.post('/api/business/document', requireAuth, documentUpload.single('document'), async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Configurá tu negocio primero.' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  const magicErr = validateUploadBytes(req.file.buffer, ['application/pdf']);
  if (magicErr) return res.status(400).json({ error: magicErr });

  const destPath = path.join(__dirname, '../data/uploads', `doc-${user.business_id}.pdf`);

  const existing = getBusinessById(user.business_id);
  if (existing?.document_path && fs.existsSync(existing.document_path)) {
    fs.unlinkSync(existing.document_path);
  }

  fs.writeFileSync(destPath, req.file.buffer);
  setBusinessDocument(user.business_id, destPath, req.file.originalname);
  res.json({ ok: true, document_name: req.file.originalname });
});

app.delete('/api/business/document', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Sin negocio.' });

  const business = getBusinessById(user.business_id);
  if (business?.document_path && fs.existsSync(business.document_path)) {
    fs.unlinkSync(business.document_path);
  }
  clearBusinessDocument(user.business_id);
  res.json({ ok: true });
});

app.get('/api/business/document/download', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  const business = getBusinessById(user.business_id);
  if (!business?.document_path || !fs.existsSync(business.document_path)) {
    return res.status(404).json({ error: 'No hay documento guardado.' });
  }
  res.download(business.document_path, business.document_name || 'documento.pdf');
});

// --- Business images ---

const IMAGE_LIMIT = 20;

app.get('/api/business/images', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  res.json(getBusinessImages(user.business_id));
});

app.post('/api/business/images', requireAuth, imageUpload.single('image'), async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido.' });
  const detectedImg = detectMimeFromBytes(req.file.buffer);
  if (!['image/jpeg', 'image/png'].includes(detectedImg)) {
    return res.status(400).json({ error: 'Tipo de imagen inválido. Solo se aceptan JPG o PNG.' });
  }

  const label = (req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'El label es requerido.' });

  const existing = getBusinessImages(user.business_id);
  if (existing.length >= IMAGE_LIMIT) {
    return res.status(400).json({ error: `Límite de ${IMAGE_LIMIT} imágenes alcanzado.` });
  }

  const ext      = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  const filename = `img-${user.business_id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const filePath = path.join(__dirname, '../data/uploads', filename);
  fs.writeFileSync(filePath, req.file.buffer);

  const result = addBusinessImage(user.business_id, label, filePath);
  res.json({ id: result.lastInsertRowid, label, file_path: filePath, filename });
});

app.delete('/api/business/images/:id', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });

  const filePath = deleteBusinessImage(user.business_id, Number(req.params.id));
  if (!filePath) return res.status(404).json({ error: 'Imagen no encontrada.' });

  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

app.get('/api/business/documents', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  const docs = getBusinessDocuments(user.business_id);
  const total = docs.reduce((s, d) => s + d.charCount, 0);
  res.json({ docs, totalChars: total, capChars: 12000 });
});

app.post('/api/business/documents', requireAuth, scriptUpload.single('doc'), async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  if (!req.file) return res.status(400).json({ error: 'Sin archivo.' });
  // Reject files that are clearly not document types (images, audio, etc.)
  const scriptMagicErr = validateUploadBytes(req.file.buffer,
    ['application/pdf', 'application/zip', 'text/']);
  if (scriptMagicErr) return res.status(400).json({ error: scriptMagicErr });

  const docName = (req.body.name || '').trim();
  if (!docName) return res.status(400).json({ error: 'El nombre del documento es requerido.' });

  let rawText = '';
  try {
    rawText = await extractTextFromFile(req.file.buffer, req.file.mimetype, req.file.originalname);
  } catch (err) {
    console.error('[documents] extract error:', err.message);
    return res.status(422).json({ error: 'No se pudo leer el archivo.' });
  }

  const text = rawText.trim();
  if (!text) return res.status(422).json({ error: 'El archivo está vacío o no tiene texto legible.' });

  const result = addBusinessDocument(user.business_id, docName, text);
  if (result.error === 'cap_exceeded') {
    const DOC_PAGE_CHARS = 1500;
    const remainingPages = Math.floor(result.remaining / DOC_PAGE_CHARS);
    return res.status(422).json({
      error: `Superaste el límite de contexto. Te quedan ~${remainingPages} página${remainingPages !== 1 ? 's' : ''} disponibles. Eliminá un documento para hacer lugar.`,
      remaining: result.remaining,
    });
  }

  res.json({ ok: true, id: result.id, charCount: text.length });
});

app.delete('/api/business/documents/:id', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user?.business_id) return res.status(400).json({ error: 'Sin negocio.' });
  const deleted = deleteBusinessDocument(user.business_id, Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Documento no encontrado.' });
  res.json({ ok: true });
});

app.post('/api/business/preview-chat', requireAuth, async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Configurá tu negocio primero.' });

  const business = getBusinessById(user.business_id);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado.' });

  const { message, history = [] } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

  try {
    // Daily Anthropic cap check for preview
    if (!business.plan_cortesia) {
      const sp = getSpendingToday(business.id);
      if (sp.anthropic_calls >= _getAnthropicDailyCap(business.plan)) {
        return res.status(429).json({ error: 'Límite diario de llamadas alcanzado. El bot pausó automáticamente.' });
      }
    }
    const previewCtx = {
      now:       getMvdDate(),
      needsHuman: false,
      images:    getBusinessImages(user.business_id),
      documents: getBusinessDocumentTexts(user.business_id),
    };
    const rawReply = await generateReply(business, history, message.trim(), null, null, previewCtx);
    incrementAnthropicCall(business.id);
    let sent_doc = false;
    let needs_human = false;
    let reply = rawReply;
    if (reply.startsWith('[NEEDS_HUMAN]')) {
      needs_human = true;
      reply = reply.replace(/^\[NEEDS_HUMAN\]\n?/, '');
    }
    if (reply.startsWith('[SEND_DOC]')) {
      sent_doc = true;
      reply = reply.replace(/^\[SEND_DOC\]\s*/m, '');
    }
    reply = reply.trim();
    const planAllowsAudio = ['crecimiento', 'a_medida'].includes(business.plan);
    const replyFitsAudio = reply.length <= AUDIO_MAX_CHARS;
    const isFirstMessage = history.length === 0;
    const wantsAudio = business.response_mode === 'audio' ||
                       (business.response_mode === 'audio_key' && isFirstMessage);
    const sent_audio = wantsAudio && !!business.voice_id && planAllowsAudio && replyFitsAudio;

    let audio_b64 = null;
    if (sent_audio) {
      try {
        const mp3 = await generateAudioBuffer(business.voice_id, reply);
        audio_b64 = mp3.toString('base64');
      } catch (audioErr) {
        console.error('[preview-audio] ElevenLabs failed:', audioErr.message);
      }
    }

    res.json({ reply, sent_doc, sent_audio, needs_human, audio_b64 });
  } catch (err) {
    const root = err.cause ?? err;
    logError('preview-chat', root);
    res.status(500).json({ error: 'Error al generar respuesta. Los detalles fueron guardados en /debug/errores.' });
  }
});

app.get('/debug/errores', requireAdmin, (req, res) => {
  const errors = getRecentErrors(20);
  const usage  = getClaudeUsageDailySummary(7);

  const priceIn          = parseFloat(process.env.ANTHROPIC_PRICE_IN           || '3');
  const priceOut         = parseFloat(process.env.ANTHROPIC_PRICE_OUT          || '15');
  const priceCacheRead   = parseFloat(process.env.ANTHROPIC_PRICE_CACHE_READ   || '0.30');
  const priceCacheWrite  = parseFloat(process.env.ANTHROPIC_PRICE_CACHE_WRITE  || '3.75');
  const priceCacheWrite1h = parseFloat(process.env.ANTHROPIC_PRICE_CACHE_WRITE_1H || '6');

  function calcRowCost(r) {
    const w5m = r.cache_write_5m_tokens ?? 0;
    const w1h = r.cache_write_1h_tokens ?? 0;
    // If split unavailable (both 0) but total write > 0, use conservative 1h price
    const hasSplit = w5m > 0 || w1h > 0 || (r.cache_write_tokens ?? 0) === 0;
    const writeCost = hasSplit
      ? (w5m / 1e6) * priceCacheWrite + (w1h / 1e6) * priceCacheWrite1h
      : ((r.cache_write_tokens ?? 0) / 1e6) * priceCacheWrite1h;
    return (
      ((r.input_tokens ?? 0) / 1e6) * priceIn +
      ((r.output_tokens ?? 0) / 1e6) * priceOut +
      ((r.cache_read_tokens ?? 0) / 1e6) * priceCacheRead +
      writeCost
    );
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const errRows = errors.map(e => `
    <tr>
      <td style="white-space:nowrap;padding:4px 8px">${esc(e.created_at)}</td>
      <td style="padding:4px 8px">${esc(e.context)}</td>
      <td style="padding:4px 8px">${esc(e.message)}</td>
      <td style="padding:4px 8px;font-size:11px;max-width:600px;word-break:break-all">${esc(e.stack).replace(/\n/g, '<br>')}</td>
    </tr>`).join('');

  const usageRows = usage.map(r => {
    const cacheHit = r.cache_read_tokens ?? 0;
    const w5m = r.cache_write_5m_tokens ?? 0;
    const w1h = r.cache_write_1h_tokens ?? 0;
    const totalCacheable = cacheHit + w5m + w1h + (r.input_tokens ?? 0);
    const cachePct = totalCacheable > 0 ? ((cacheHit / totalCacheable) * 100).toFixed(1) + '%' : '—';
    return `
    <tr>
      <td style="padding:4px 8px">${r.day}</td>
      <td style="padding:4px 8px;text-align:right">${r.replies}</td>
      <td style="padding:4px 8px;text-align:right">${(r.input_tokens ?? 0).toLocaleString()}</td>
      <td style="padding:4px 8px;text-align:right">${(r.output_tokens ?? 0).toLocaleString()}</td>
      <td style="padding:4px 8px;text-align:right">${cacheHit.toLocaleString()}</td>
      <td style="padding:4px 8px;text-align:right">${w5m.toLocaleString()}</td>
      <td style="padding:4px 8px;text-align:right">${w1h.toLocaleString()}</td>
      <td style="padding:4px 8px;text-align:right">${cachePct}</td>
      <td style="padding:4px 8px;text-align:right">${r.audio_replies}</td>
      <td style="padding:4px 8px;text-align:right">${(r.total_tts_chars ?? 0).toLocaleString()}</td>
      <td style="padding:4px 8px;text-align:right">$${calcRowCost(r).toFixed(4)}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error Log</title>
    <style>body{font-family:monospace;padding:20px}table{border-collapse:collapse;width:100%;margin-bottom:30px}th,td{border:1px solid #ccc;text-align:left;vertical-align:top}th{background:#f0f0f0}</style>
    </head><body>
    <h2>Uso Claude — últimos 7 días</h2>
    <table><thead><tr><th>Día</th><th>Replies</th><th>Input</th><th>Output</th><th>Cache read</th><th>Write 5m</th><th>Write 1h</th><th>% caché</th><th>Audio</th><th>TTS chars</th><th>Costo USD</th></tr></thead>
    <tbody>${usageRows || '<tr><td colspan="11">Sin datos</td></tr>'}</tbody></table>
    <h2>Últimos errores (${errors.length})</h2>
    <table><thead><tr><th>Fecha</th><th>Contexto</th><th>Mensaje</th><th>Stack</th></tr></thead>
    <tbody>${errRows || '<tr><td colspan="4">Sin errores registrados</td></tr>'}</tbody></table>
    </body></html>`);
});

app.get('/admin/api/costos', requireAdmin, (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 90);

  const priceIn           = parseFloat(process.env.ANTHROPIC_PRICE_IN             || '3');
  const priceOut          = parseFloat(process.env.ANTHROPIC_PRICE_OUT            || '15');
  const priceCacheRead    = parseFloat(process.env.ANTHROPIC_PRICE_CACHE_READ     || '0.30');
  const priceCacheWrite   = parseFloat(process.env.ANTHROPIC_PRICE_CACHE_WRITE    || '3.75');
  const priceCacheWrite1h = parseFloat(process.env.ANTHROPIC_PRICE_CACHE_WRITE_1H || '6');

  function calcCost(r) {
    const w5m = r.cache_write_5m_tokens ?? 0;
    const w1h = r.cache_write_1h_tokens ?? 0;
    const hasSplit = w5m > 0 || w1h > 0 || (r.cache_write_tokens ?? 0) === 0;
    const writeCost = hasSplit
      ? (w5m / 1e6) * priceCacheWrite + (w1h / 1e6) * priceCacheWrite1h
      : ((r.cache_write_tokens ?? 0) / 1e6) * priceCacheWrite1h;
    return (
      ((r.input_tokens ?? 0) / 1e6) * priceIn +
      ((r.output_tokens ?? 0) / 1e6) * priceOut +
      ((r.cache_read_tokens ?? 0) / 1e6) * priceCacheRead +
      writeCost
    );
  }

  const rows = getClaudeUsageByBusiness(days).map(r => ({
    ...r,
    cost_usd: parseFloat(calcCost(r).toFixed(6)),
  }));

  const totals = rows.reduce((acc, r) => {
    acc.replies               += r.replies;
    acc.input_tokens          += r.input_tokens ?? 0;
    acc.output_tokens         += r.output_tokens ?? 0;
    acc.cache_read_tokens     += r.cache_read_tokens ?? 0;
    acc.cache_write_tokens    += r.cache_write_tokens ?? 0;
    acc.cache_write_5m_tokens += r.cache_write_5m_tokens ?? 0;
    acc.cache_write_1h_tokens += r.cache_write_1h_tokens ?? 0;
    acc.audio_replies         += r.audio_replies ?? 0;
    acc.total_tts_chars       += r.total_tts_chars ?? 0;
    acc.cost_usd              += r.cost_usd;
    return acc;
  }, { replies: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, audio_replies: 0, total_tts_chars: 0, cost_usd: 0 });
  totals.cost_usd = parseFloat(totals.cost_usd.toFixed(6));

  res.json({
    days,
    prices: { in: priceIn, out: priceOut, cache_read: priceCacheRead, cache_write: priceCacheWrite, cache_write_1h: priceCacheWrite1h },
    rows,
    totals,
  });
});

function isTrialExpired(business) {
  if (business.plan_cortesia) return false;
  // arranque without plan_paid_at = still in trial — trial gate handles it below
  if (business.plan === 'arranque' && !business.plan_paid_at) return false;

  const { plan, subscription_status, trial_ends_at } = business;

  if (plan !== 'arranque') {
    if (subscription_status === 'cancelled' || subscription_status === 'paused') {
      if (!trial_ends_at && !business.plan_expires_at) return true;
      const expiry = business.plan_expires_at || trial_ends_at;
      return parseSqliteUtc(expiry) < Date.now();
    }
    return false;
  }

  // arranque WITH plan_paid_at (paid arranque)
  if (subscription_status === 'cancelled' || subscription_status === 'paused') {
    if (!business.plan_expires_at) return true;
    return parseSqliteUtc(business.plan_expires_at) < Date.now();
  }
  return false;
}

async function notifyOwnerOfPause({ business, owner, contactId, messageText, conversationId, waCredentials }) {
  const convUrl = `${process.env.APP_URL || 'https://daxos.lat'}/conversations.html?conv=${conversationId}`;

  if (!owner) {
    logError('pause-notify-error', { message: `conv ${conversationId} biz=${business.id}: no owner — sending fallback to admin`, stack: '' });
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      await sendPauseEmail({ to: adminEmail, businessName: business.name, contactId, messageText, conversationId, convUrl })
        .catch(err => logError('pause-notify-error', { message: `conv ${conversationId} fallback-admin email failed: ${err.message}`, stack: '' }));
    }
    return;
  }

  const normPhone    = normalizeUruguayPhone(owner.phone);
  const normBizPhone = normalizeUruguayPhone(business.whatsapp_number);
  if (!normPhone) {
    logError('pause-notify-wa-error', { message: `conv ${conversationId}: skip — owner has no phone`, stack: '' });
  } else if (!waCredentials) {
    logError('pause-notify-wa-error', { message: `conv ${conversationId}: skip — no waCredentials`, stack: '' });
  } else if (normPhone === normBizPhone) {
    logError('pause-notify-wa-error', { message: `conv ${conversationId}: skip — owner phone ****${normPhone.slice(-4)} same as business WA (self-send prevented)`, stack: '' });
  } else {
    const waMsg = `⚠️ Conversación pausada — ${business.name}\nCliente: ${contactId}\nMensaje: ${messageText}\nAbrir la conversación: ${convUrl}`;
    sendWhatsAppMessage(normPhone, waMsg, waCredentials)
      .catch(err => logError('pause-notify-wa-error', { message: `conv ${conversationId} dest=****${normPhone.slice(-4)}: ${err.message}`, stack: '' }));
  }

  try {
    await sendPauseEmail({ to: owner.email, businessName: business.name, contactId, messageText, conversationId, convUrl });
  } catch (err) {
    logError('pause-notify-error', { message: `conv ${conversationId} owner email failed: ${err.message} — sending fallback to admin`, stack: '' });
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && adminEmail !== owner.email) {
      await sendPauseEmail({ to: adminEmail, businessName: business.name, contactId, messageText, conversationId, convUrl })
        .catch(e => logError('pause-notify-error', { message: `conv ${conversationId} fallback-admin email also failed: ${e.message}`, stack: '' }));
    }
  }
}

function normalizeUruguayPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!digits.startsWith('598')) digits = '598' + digits;
  return digits;
}

async function notifyAdmin(event, data) {
  const adminEmail        = process.env.ADMIN_EMAIL;
  const adminPhone        = process.env.ADMIN_PHONE;
  const adminPhoneNumberId = process.env.ADMIN_KAPSO_PHONE_NUMBER_ID;

  if (!adminEmail) return;

  sendAdminNotificationEmail({ adminEmail, event, data })
    .catch(err => logError('admin-notify', { message: `email failed event=${event}: ${err.message}`, stack: '' }));

  if (adminPhone && adminPhoneNumberId) {
    const waTexts = {
      registration:          `Nuevo registro en Daxos: ${data.email}`,
      wa_connected:          `WhatsApp conectado: ${data.businessName}`,
      incomplete_connection: `Conexión incompleta: ${data.businessName} lleva ${data.minutesElapsed} min sin completar WhatsApp`,
    };
    const text = waTexts[event] || `Admin event=${event}`;
    sendWhatsAppMessage(adminPhone, text, { phoneNumberId: adminPhoneNumberId, provider: 'kapso' })
      .catch(err => logError('admin-notify', { message: `WA failed event=${event}: ${err.message}`, stack: '' }));
  }
}

// No-op: disclosure message removed — first reply is generated by Claude directly.
async function maybeSendDisclosure(_business, _conversationId, _history, _recipientPhone, _waCredentials) {
}

// --- Shared incoming-message pipeline ---

// Uruguay is UTC-3, no DST.
function getMvdDate() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function isWithinBusinessHours(business) {
  if (!business.business_hours_start || !business.business_hours_end) return true;
  const mvd = getMvdDate();
  const nowMin = mvd.getUTCHours() * 60 + mvd.getUTCMinutes();
  const [sh, sm] = business.business_hours_start.split(':').map(Number);
  const [eh, em] = business.business_hours_end.split(':').map(Number);
  return !(nowMin < sh * 60 + sm || nowMin >= eh * 60 + em);
}

function getDefaultPauseReplyText(business) {
  if (business.pause_reply_text?.trim()) return business.pause_reply_text.trim();
  return isWithinBusinessHours(business)
    ? 'Te paso con una persona del equipo, te escribe en cuanto pueda 💗'
    : 'Te paso con una persona del equipo. Ahora estamos fuera de horario: te escribimos apenas podamos 💗';
}

// Normalize text for pause-keyword matching: strip accents, punctuation, collapse spaces, lowercase.
function normalizePauseText(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Parse a SQLite UTC datetime string (e.g. "2026-10-03 12:43:32") as UTC milliseconds.
// SQLite stores datetime('now') without timezone suffix; appending 'Z' ensures JS
// treats it as UTC rather than local time.
function parseSqliteUtc(s) {
  if (!s) return null;
  return new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z').getTime();
}

// Uruguay is UTC-3 year-round. Days elapsed are full 24-hour periods from trialStartsAt.
function trialDaysElapsed(trialStartsAt) {
  const ms = parseSqliteUtc(trialStartsAt);
  if (!ms) return 0;
  return Math.floor((Date.now() - ms) / 86_400_000);
}

// Returns UY date string (YYYY-MM-DD) for a UTC millisecond timestamp.
function toUYDateStr(ms) {
  return new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);
}

function isMsgStale(business, msgTimestamp) {
  if (msgTimestamp == null) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const connectedAtMs  = parseSqliteUtc(business.wa_connected_at);
  const connectedAtSec = connectedAtMs ? Math.floor(connectedAtMs / 1000) : null;
  if (connectedAtSec != null && msgTimestamp < connectedAtSec - 60) return 'before_connect';
  if (nowSec - msgTimestamp > MSG_MAX_AGE_MINUTES * 60) return 'too_old';
  return null;
}

async function processIncomingMessage(business, waCredentials, { msgId, customerPhone, text, msgTimestamp, msgTimestampField, imageData = null }) {
  if (!customerPhone) {
    logError('process-incoming', { message: `customerPhone missing — skipping outbound or malformed message msgId=${msgId} business=${business.id}`, stack: '' });
    return;
  }

  // ── Stale-message guard ──────────────────────────────────────────────────
  if (msgTimestamp != null) {
    const todayUY = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Log the timestamp field name + value once per business per day
    const logKey = String(business.id);
    if (_timestampFieldLogDate[logKey] !== todayUY) {
      _timestampFieldLogDate[logKey] = todayUY;
      logError('msg-timestamp-field', {
        message: `business_id=${business.id} field=${msgTimestampField || 'unknown'} value=${msgTimestamp}`,
        stack: '',
      });
    }

    const staleReason = isMsgStale(business, msgTimestamp);
    if (staleReason) {
      logError('msg-stale', {
        message: `msgId=${msgId} business_id=${business.id} age=${Math.floor(Date.now() / 1000) - msgTimestamp}s field=${msgTimestampField || 'unknown'} reason=${staleReason}`,
        stack: '',
      });
      _staleMsgCount++;
      _staleMsgDate = todayUY;
      return;
    }
  }
  // ── Silent window ────────────────────────────────────────────────────────
  if (business.silent_until) {
    const silentUntilMs = parseSqliteUtc(business.silent_until);
    if (silentUntilMs && Date.now() < silentUntilMs) {
      const conv = getOrCreateConversation(business.id, customerPhone);
      addMessage(conv.id, 'user', text, 1);
      setConversationSilent(conv.id, 1);
      logError('silent-window', {
        message: `business_id=${business.id} msgId=${msgId} msgTimestamp=${msgTimestamp} field=${msgTimestampField || 'unknown'} silent_until=${business.silent_until}`,
        stack: '',
      });
      return;
    }
  }
  // ────────────────────────────────────────────────────────────────────────
  // Demo flow — gated by env vars; only runs for Daxos's own number; prospects only
  if (process.env.DEMO_FLOW_ENABLED === '1' &&
      business.phone_number_id === process.env.DAXOS_PHONE_NUMBER_ID) {
    try {
      const handled = await handleDemoFlow(business, waCredentials, customerPhone, text);
      if (handled) return;
    } catch (demoErr) {
      logError('demo-flow-error', { message: demoErr.message, stack: demoErr.stack || '' });
    }
  }

  const sendCtxOk  = waCredentials.provider === 'kapso' ? 'kapso-send-ok'  : 'webhook-send-ok';
  const sendCtxErr = waCredentials.provider === 'kapso' ? 'kapso-send-err' : 'webhook-send-error';

  // Owner booking-reply detection — check before trial/limit gates so owner
  // responses always go through regardless of trial state.
  {
    const msgOwner = getUserByBusinessId(business.id);
    const ownerDigits = (msgOwner?.phone || '').replace(/\D/g, '');
    const senderDigits = customerPhone.replace(/\D/g, '');
    if (ownerDigits && senderDigits === ownerDigits) {
      const handled = await handleOwnerBookingReply({
        business, ownerPhone: customerPhone, text, waCredentials,
      });
      if (handled) {
        markAsRead(msgId, waCredentials).catch(() => {});
        return;
      }
    }
  }

  // ── Trial gate: arranque in trial (no payment, no cortesia) ────────────────
  if (business.plan === 'arranque' && !business.plan_cortesia && !business.plan_paid_at && business.trial_starts_at) {
    const now         = Date.now();
    const nowIso      = new Date(now).toISOString();
    const todayUY     = toUYDateStr(now);
    const convCount   = getTrialConversationCount(business.id, business.trial_starts_at);
    const daysElapsed = trialDaysElapsed(business.trial_starts_at);
    const lastNotMs   = parseSqliteUtc(business.trial_grace_notified_at);
    const canMail     = !lastNotMs || toUYDateStr(lastNotMs) !== todayUY;

    const sendTrialEndMsg = async (conv) => {
      const lastEndMs = parseSqliteUtc(conv.trial_ended_notified_at);
      if (lastEndMs && (now - lastEndMs) < 24 * 3_600_000) {
        addMessage(conv.id, 'user', text);
        markConversationPausedByTrial(conv.id);
        return false;
      }
      const endMsg = `En este momento no puedo responder, alguien del negocio te va a contestar a la brevedad.`;
      await sendWhatsAppMessage(customerPhone, endMsg, waCredentials).catch(() => {});
      addMessage(conv.id, 'user', text);
      addMessage(conv.id, 'assistant', endMsg);
      markConversationPausedByTrial(conv.id);
      setTrialEndedNotifiedAt(conv.id, nowIso);
      return true;
    };

    const notifyOwnerTrialEnded = (owner) => {
      if (!canMail || !owner) return;
      setTrialGraceNotifiedAt(business.id, nowIso);
      sendTrialEndedEmail({ to: owner.email, businessName: business.name })
        .catch(e => logError('trial-ended-email', { message: e.message, stack: '' }));
      if (owner.phone) {
        sendWhatsAppMessage(owner.phone, `🚫 La prueba de ${business.name} terminó. Activá tu plan: https://wa.me/59892052508?text=Quiero%20activar%20mi%20plan`, waCredentials).catch(() => {});
      }
    };

    if (business.trial_grace_started_at) {
      // ── Grace period active ──
      const graceStartMs  = parseSqliteUtc(business.trial_grace_started_at);
      const graceHours    = (now - graceStartMs) / 3_600_000;
      const graceConvs    = getTrialConversationCount(business.id, business.trial_grace_started_at);
      const graceConvsLeft = Math.max(0, TRIAL_GRACE_CONVS - graceConvs);
      const graceHoursLeft = Math.max(0, TRIAL_GRACE_HOURS - graceHours);

      if (graceHours > TRIAL_GRACE_HOURS || graceConvs >= TRIAL_GRACE_CONVS) {
        // Grace exhausted
        const conv = getOrCreateConversation(business.id, customerPhone);
        const sent = await sendTrialEndMsg(conv);
        if (sent) {
          const owner = getUserByBusinessId(business.id);
          notifyOwnerTrialEnded(owner);
          console.log(`[trial-ended] business ${business.id} grace over (${graceHours.toFixed(1)}h, ${graceConvs} convs)`);
        }
        return;
      }

      // Grace still valid — bot replies; daily reminder to owner
      if (canMail) {
        const owner = getUserByBusinessId(business.id);
        if (owner) {
          setTrialGraceNotifiedAt(business.id, nowIso);
          sendTrialGraceEmail({ to: owner.email, businessName: business.name, graceConvsLeft, graceHoursLeft })
            .catch(e => logError('trial-grace-email', { message: e.message, stack: '' }));
          if (owner.phone) {
            sendWhatsAppMessage(owner.phone, `⏳ La prueba de ${business.name} venció. El bot sigue en modo de gracia: ${Math.ceil(graceHoursLeft)} h o ${graceConvsLeft} conversaciones más. Activá tu plan: https://wa.me/59892052508?text=Quiero%20activar%20mi%20plan`, waCredentials).catch(() => {});
          }
        }
      }
      // fall through to normal bot processing

    } else {
      // ── No grace yet ──
      const trialEndsMs    = parseSqliteUtc(business.trial_ends_at);
      const hitConvLimit   = convCount >= TRIAL_CONV_LIMIT;
      const hitDayLimit    = trialEndsMs && trialEndsMs < now;

      if (hitConvLimit || hitDayLimit) {
        const expiredHoursAgo = trialEndsMs ? (now - trialEndsMs) / 3_600_000 : 0;

        if (expiredHoursAgo > TRIAL_GRACE_HOURS) {
          // Direct cut — too late for grace
          const conv = getOrCreateConversation(business.id, customerPhone);
          const sent = await sendTrialEndMsg(conv);
          if (sent) {
            const owner = getUserByBusinessId(business.id);
            notifyOwnerTrialEnded(owner);
            console.log(`[trial-ended] business ${business.id} direct cut, no grace (expired ${expiredHoursAgo.toFixed(0)}h ago)`);
          }
          return;
        }

        // Open grace
        setTrialGraceStartedAt(business.id, nowIso);
        business.trial_grace_started_at = nowIso; // update in-memory for this request
        const owner = getUserByBusinessId(business.id);
        if (canMail && owner) {
          setTrialGraceNotifiedAt(business.id, nowIso);
          sendTrialGraceEmail({ to: owner.email, businessName: business.name, graceConvsLeft: TRIAL_GRACE_CONVS, graceHoursLeft: TRIAL_GRACE_HOURS })
            .catch(e => logError('trial-grace-email', { message: e.message, stack: '' }));
          if (owner.phone) {
            sendWhatsAppMessage(owner.phone, `⏳ La prueba de ${business.name} venció. El bot sigue en modo de gracia: 72 h o 25 conversaciones más. Activá tu plan: https://wa.me/59892052508?text=Quiero%20activar%20mi%20plan`, waCredentials).catch(() => {});
          }
        }
        console.log(`[trial-grace] business ${business.id} grace opened (${convCount} convs, day ${daysElapsed})`);
        // fall through — this first grace message still gets a bot reply
      }

      // Warning zone (once only)
      if (!business.trial_warned_at && (convCount >= TRIAL_WARN_CONVS || daysElapsed >= TRIAL_WARN_DAYS)) {
        setTrialWarnedAt(business.id, nowIso);
        const owner = getUserByBusinessId(business.id);
        if (canMail && owner) {
          setTrialGraceNotifiedAt(business.id, nowIso);
          sendTrialWarningEmail({ to: owner.email, businessName: business.name, convCount, convLimit: TRIAL_CONV_LIMIT, dayNum: daysElapsed, dayLimit: 14 })
            .catch(e => logError('trial-warning-email', { message: e.message, stack: '' }));
          if (owner.phone) {
            sendWhatsAppMessage(owner.phone, `⚠️ La prueba de ${business.name} está llegando al final: día ${daysElapsed} de 14, ${convCount} de ${TRIAL_CONV_LIMIT} conversaciones. Activá tu plan: https://wa.me/59892052508?text=Quiero%20activar%20mi%20plan`, waCredentials).catch(() => {});
          }
        }
        console.log(`[trial-warning] business ${business.id} warned (day ${daysElapsed}, ${convCount} convs)`);
      }
    }
  }

  // Expired paid plans (non-trial arranque, crecimiento/a_medida cancelled or expired)
  if (isTrialExpired(business)) {
    await sendWhatsAppMessage(customerPhone,
      `Hola! El período de prueba de ${business.name} terminó. Para seguir recibiendo respuestas automáticas, el negocio necesita activar su plan.`,
      waCredentials
    );
    return;
  }

  const conversation = getOrCreateConversation(business.id, customerPhone);
  const history = getConversationHistory(conversation.id, 60);

  // Conversation paused — record message so owner sees it, but no AI reply
  if (conversation.needs_attention) {
    addMessage(conversation.id, 'user', text);
    markAsRead(msgId, waCredentials).catch(() => {});
    if (conversation.paused_reason === 'keyword' && conversation.pause_reply_count < 3) {
      const nowSec = Math.floor(Date.now() / 1000);
      const lastAt = conversation.pause_last_reply_at || 0;
      if (nowSec - lastAt >= 15 * 60) {
        const replyText = getDefaultPauseReplyText(business);
        recordKeywordPauseReply(conversation.id);
        sendWhatsAppMessage(customerPhone, replyText, waCredentials)
          .catch(err => logError('pause-reply-send', { message: err.message, stack: '' }));
        addMessage(conversation.id, 'assistant', replyText);
        logError('kapso-event', { message: `silenced:paused reason=keyword count=${conversation.pause_reply_count + 1} auto_reply_sent`, stack: '' });
      } else {
        logError('kapso-event', { message: `silenced:paused reason=keyword count=${conversation.pause_reply_count} throttled last_reply_ago=${Math.floor((nowSec - lastAt) / 60)}m`, stack: '' });
      }
    } else if (conversation.paused_reason === 'keyword') {
      logError('kapso-event', { message: `silenced:paused reason=keyword count=${conversation.pause_reply_count} limit_reached`, stack: '' });
    } else {
      logError('kapso-event', { message: `silenced:paused reason=${conversation.paused_reason || 'human'}`, stack: '' });
    }
    return;
  }

  // Pause keyword check — before any network call so WA errors can't skip it
  if (business.pause_keywords) {
    const keywords = business.pause_keywords
      .split(',')
      .map(k => normalizePauseText(k))
      .filter(Boolean);
    const normText = normalizePauseText(text);
    const matched = keywords.find(k => normText.includes(k));
    if (matched) {
      logError('pause-keyword', {
        message: `business_id=${business.id} conv_id=${conversation.id} keyword="${matched}"`,
        stack: '',
      });
      addMessage(conversation.id, 'user', text);
      markConversationPausedByKeyword(conversation.id);
      const replyText = getDefaultPauseReplyText(business);
      sendWhatsAppMessage(customerPhone, replyText, waCredentials)
        .catch(err => logError('pause-reply-send', { message: err.message, stack: '' }));
      addMessage(conversation.id, 'assistant', replyText);
      const owner = getUserByBusinessId(business.id);
      notifyOwnerOfPause({
        business, owner, contactId: customerPhone,
        messageText: text, conversationId: conversation.id, waCredentials,
      }).then(() => setPauseNotifiedAt(conversation.id))
        .catch(err => logError('pause-notify-error', { message: err.message, stack: '' }));
      markAsRead(msgId, waCredentials).catch(() => {});
      return;
    }
  }

  await maybeSendDisclosure(business, conversation.id, history, customerPhone, waCredentials);

  // Mark as read + show typing indicator immediately
  markAsRead(msgId, waCredentials).catch(() => {});
  sendTypingIndicator(customerPhone, waCredentials).catch(() => {});

  // Spending cap check (skip for plan_cortesia)
  if (!business.plan_cortesia) {
    const spending    = getSpendingToday(business.id);
    const dailyCap    = _getAnthropicDailyCap(business.plan);
    const hourlyCap   = _getConvHourlyCap();
    const hourlyCount = getConvAssistantCountLastHour(conversation.id);
    const hitDaily    = spending.anthropic_calls >= dailyCap;
    const hitHourly   = hourlyCount >= hourlyCap;
    if (hitDaily || hitHourly) {
      const reason = hitDaily ? 'daily_cap' : 'conv_hourly_cap';
      logError('spending-cap', {
        message: `biz=${business.id} plan=${business.plan} reason=${reason} calls=${spending.anthropic_calls}/${dailyCap} hourly=${hourlyCount}/${hourlyCap}`,
        stack: '',
      });
      const nowSec = Math.floor(Date.now() / 1000);
      const lastNotified = conversation.spending_cap_notified_at || 0;
      if (nowSec - lastNotified > 12 * 3600) {
        const capMsg = 'Nuestro asistente alcanzó el límite de respuestas de hoy. Alguien te va a contestar pronto.';
        sendWhatsAppMessage(customerPhone, capMsg, waCredentials).catch(() => {});
        addMessage(conversation.id, 'user', text);
        addMessage(conversation.id, 'assistant', capMsg);
        setSpendingCapNotified(conversation.id);
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
          sendAdminNotificationEmail({ adminEmail, event: 'spending-cap', data: {
            business_id: business.id, business_name: business.name, reason,
            calls_today: spending.anthropic_calls, daily_cap: dailyCap,
          }}).catch(() => {});
        }
      } else {
        addMessage(conversation.id, 'user', text);
      }
      markAsRead(msgId, waCredentials).catch(() => {});
      return;
    }
  }

  // Generate reply and enforce minimum delay in parallel
  const delayMs = (business.response_delay ?? 5) * 1000;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const currentBookingState = business.booking_enabled ? getBookingState(conversation.id) : null;
  const businessImages = getBusinessImages(business.id);
  const businessDocs   = getBusinessDocumentTexts(business.id);
  const runtimeCtx = { now: getMvdDate(), needsHuman: !!conversation.needs_human, images: businessImages, documents: businessDocs };
  logError('webhook-claude-call', {
    message: `business_id=${business.id} customer=****${customerPhone.slice(-4)}`,
    stack: '',
  });
  let rawReply;
  try {
    [rawReply] = await Promise.all([
      generateReply(business, history, text, conversation.label || null, {
        enabled: !!business.booking_enabled,
        state: currentBookingState,
      }, runtimeCtx, conversation.id, imageData),
      sleep(delayMs),
    ]);
    logError('webhook-claude-ok', { message: `business_id=${business.id} reply_length=${rawReply.length}`, stack: '' });
    incrementAnthropicCall(business.id);
  } catch (claudeErr) {
    logError('webhook-claude-error', claudeErr);
    // Send fallback message once (not if already needs_attention to avoid looping)
    if (!conversation.needs_attention) {
      const fallbackMsg = 'Dame un momento y te respondemos enseguida.';
      sendWhatsAppMessage(customerPhone, fallbackMsg, waCredentials).catch(() => {});
      addMessage(conversation.id, 'user', text);
      addMessage(conversation.id, 'assistant', fallbackMsg);
      markConversationPaused(conversation.id);
    } else {
      addMessage(conversation.id, 'user', text);
    }
    markAsRead(msgId, waCredentials).catch(() => {});
    return;
  }

  let sendDoc = false;
  let needsHuman = false;
  let reply = rawReply;
  if (/\[NEEDS_HUMAN\]/.test(reply)) {
    needsHuman = true;
    reply = reply.replace(/\[NEEDS_HUMAN\]\n?/g, '');
  }
  if (reply.startsWith('[SEND_DOC]')) {
    sendDoc = true;
    reply = reply.replace(/^\[SEND_DOC\]\n?/, '');
  }

  let imageToSend   = null;
  let imgTextBefore = null;
  let imgTextAfter  = null;
  const imageMatch = reply.match(/\[ENVIAR_IMAGEN:\s*(.+?)\]/);
  if (imageMatch) {
    const tagStart = imageMatch.index;
    const tagEnd   = tagStart + imageMatch[0].length;
    imgTextBefore  = reply.slice(0, tagStart).replace(/\n+$/, '').trim();
    imgTextAfter   = reply.slice(tagEnd).replace(/^\n+/, '').trim();
    reply = [imgTextBefore, imgTextAfter].filter(Boolean).join(' ').trim();
    const requestedLabel = imageMatch[1].trim();
    const found = businessImages.find(
      img => img.label.toLowerCase() === requestedLabel.toLowerCase()
    );
    if (found) {
      imageToSend = found;
    } else {
      logError('image-send-notfound', {
        message: `business_id=${business.id} requested="${requestedLabel}" available=${JSON.stringify(businessImages.map(i => i.label))}`,
        stack: '',
      });
    }
  }

  // Booking state machine — parse tags, update state, strip tags from reply
  if (business.booking_enabled) {
    let nextBookingState = currentBookingState;

    if (/\[WANTS_BOOKING\]/.test(reply)) {
      nextBookingState = { step: 'collecting_name' };
      console.log(`[booking-flow] WANTS_BOOKING conversation=${conversation.id}`);
    }
    if (/\[CANCEL_BOOKING\]/.test(reply)) {
      nextBookingState = null;
      console.log(`[booking-flow] CANCEL_BOOKING conversation=${conversation.id}`);
    }

    const nameMatch = reply.match(/\[BOOKING_NAME:\s*([^\]]+)\]/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      nextBookingState = { ...(currentBookingState || {}), step: 'collecting_reason', name };
      console.log(`[booking-flow] collected name="${name}" conversation=${conversation.id}`);
    }

    const reasonMatch = reply.match(/\[BOOKING_REASON:\s*([^\]]+)\]/);
    if (reasonMatch) {
      const reason = reasonMatch[1].trim();
      nextBookingState = { ...(currentBookingState || {}), step: 'collecting_slots', reason };
      console.log(`[booking-flow] collected reason="${reason}" conversation=${conversation.id}`);
    }

    const slotsMatch = reply.match(/\[BOOKING_SLOTS:\s*([^\]]+)\]/);
    if (slotsMatch) {
      const slots = slotsMatch[1].split('|').map(s => s.trim()).filter(Boolean);
      if (slots.length > 0 && currentBookingState?.name && currentBookingState?.reason) {
        try {
          const bookingOwner = getUserByBusinessId(business.id);
          const booking = createBooking({
            businessId: business.id,
            conversationId: conversation.id,
            customerPhone,
            clientName: currentBookingState.name,
            reason: currentBookingState.reason,
            slots,
          });
          nextBookingState = { step: 'waiting_owner', bookingId: booking.id, name: currentBookingState.name };
          notifyOwnerOfBooking({ business, owner: bookingOwner, booking, waCredentials })
            .catch(err => console.error(`[booking-flow] notifyOwnerOfBooking failed booking=${booking.id}: ${err.message}`));
          console.log(`[booking-flow] booking created id=${booking.id} code=${booking.slot_code} conversation=${conversation.id}`);
        } catch (bookingErr) {
          nextBookingState = null;
          console.error(`[booking-flow] createBooking failed conversation=${conversation.id}: ${bookingErr.message}`);
        }
      } else {
        console.error(`[booking-flow] BOOKING_SLOTS found but state missing name/reason — state=${JSON.stringify(currentBookingState)}`);
        nextBookingState = null;
      }
    }

    // Strip all booking tags from the reply the client will see
    reply = reply
      .replace(/\[WANTS_BOOKING\]\n?/g, '')
      .replace(/\[CANCEL_BOOKING\]\n?/g, '')
      .replace(/\[BOOKING_NAME:[^\]]*\]\n?/g, '')
      .replace(/\[BOOKING_REASON:[^\]]*\]\n?/g, '')
      .replace(/\[BOOKING_SLOTS:[^\]]*\]\n?/g, '');

    // Persist state only if it changed
    if (JSON.stringify(nextBookingState) !== JSON.stringify(currentBookingState)) {
      setBookingState(conversation.id, nextBookingState);
    }
  }

  reply = reply.trim();

  // Safety net: strip any unprocessed internal markers before touching WhatsApp
  function sanitizeForClient(txt) {
    if (!txt) return txt;
    const cleaned = txt.replace(/\[[A-Z][A-Z_0-9]*(?::[^\]]+)?\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
    if (cleaned !== txt) {
      logError('marker-leak', { message: `stripped from client text: ${JSON.stringify(txt.slice(0, 300))}`, stack: '' });
    }
    return cleaned;
  }
  reply        = sanitizeForClient(reply);
  imgTextBefore = sanitizeForClient(imgTextBefore);
  imgTextAfter  = sanitizeForClient(imgTextAfter);

  if (conversation.silent) setConversationSilent(conversation.id, 0);
  addMessage(conversation.id, 'user', text);
  addMessage(conversation.id, 'assistant', reply);

  if (sendDoc && business.document_path && fs.existsSync(business.document_path)) {
    try {
      const docBuffer = fs.readFileSync(business.document_path);
      const docMediaId = await uploadMedia(docBuffer, business.document_name, 'application/pdf', waCredentials);
      await sendWhatsAppDocument(customerPhone, docMediaId, business.document_name, waCredentials);
    } catch (docErr) {
      console.error('[doc-send] failed:', docErr.message);
    }
  }

  let imageSent = false;
  async function sendImageNow() {
    if (!imageToSend || !fs.existsSync(imageToSend.file_path)) return;
    try {
      const imgBuffer  = fs.readFileSync(imageToSend.file_path);
      const mimeType   = imageToSend.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const imgMediaId = await uploadMedia(imgBuffer, path.basename(imageToSend.file_path), mimeType, waCredentials);
      await sendWhatsAppImage(customerPhone, imgMediaId, null, waCredentials);
      logError('image-send-ok', { message: `business_id=${business.id} label="${imageToSend.label}"`, stack: '' });
      imageSent = true;
    } catch (imgErr) {
      logError('image-send-error', { message: imgErr.message, stack: imgErr.stack || '' });
    }
  }

  const planAllowsAudio = ['crecimiento', 'a_medida'].includes(business.plan);
  const replyFitsAudio = reply.length <= AUDIO_MAX_CHARS;
  const isFirstMessage = history.length === 0;
  const wantsAudio = business.response_mode === 'audio' ||
                     (business.response_mode === 'audio_key' && isFirstMessage);
  // TTS daily chars cap check
  const ttsDailyCap = !business.plan_cortesia ? _getTtsDailyCap(business.plan) : Infinity;
  const ttsSpending = getSpendingToday(business.id);
  const ttsCapHit   = ttsDailyCap !== Infinity && (ttsSpending.elevenlabs_chars + reply.length > ttsDailyCap);
  try {
    if (wantsAudio && business.voice_id && planAllowsAudio && replyFitsAudio && !ttsCapHit) {
      try {
        logError('tts-text', { message: `business_id=${business.id} chars=${reply.length}`, stack: '' });
        const mp3 = await generateAudioBuffer(business.voice_id, reply);
        try { setClaudeUsageTtsChars(getLastClaudeUsageId(conversation.id), reply.length); } catch (_) {}
        try { incrementElevenLabsChars(business.id, reply.length); } catch (_) {}
        logError('tts-buffers', { message: `mp3=${mp3.length}b`, stack: '' });
        const ogg = await convertToOgg(mp3);
        logError('tts-buffers', { message: `ogg=${ogg.length}b mime=audio/ogg; codecs=opus`, stack: '' });
        const mediaId = await uploadMedia(ogg, 'reply.ogg', 'audio/ogg; codecs=opus', waCredentials);
        await sendWhatsAppAudio(customerPhone, mediaId, waCredentials);
        logError(sendCtxOk, { message: `mode=audio business_id=${business.id} to=****${customerPhone.slice(-4)}`, stack: '' });
      } catch (audioErr) {
        logError('webhook-audio-fallback', { message: audioErr.message, stack: audioErr.stack || '' });
        const sendResult = await sendWhatsAppMessage(customerPhone, reply, waCredentials);
        logError('webhook-send-result', { message: `mode=text(audio-fallback) body=${JSON.stringify(sendResult).slice(0, 300)}`, stack: '' });
      }
    } else {
      if (wantsAudio && !replyFitsAudio) {
        logError('webhook-audio-skip', { message: `reply too long (${reply.length} chars)`, stack: '' });
      }
      if (imageToSend) {
        if (imgTextBefore) await sendWhatsAppMessage(customerPhone, imgTextBefore, waCredentials);
        await sendImageNow();
        // After escalation the bot must not send anything extra — skip imgTextAfter
        if (imgTextAfter && !needsHuman) await sendWhatsAppMessage(customerPhone, imgTextAfter, waCredentials);
        logError('webhook-send-result', { message: `mode=text+image split before=${!!imgTextBefore} after=${!!imgTextAfter} skipped_after=${needsHuman && !!imgTextAfter}`, stack: '' });
      } else {
        const sendResult = await sendWhatsAppMessage(customerPhone, reply, waCredentials);
        logError('webhook-send-result', { message: `mode=text body=${JSON.stringify(sendResult).slice(0, 300)}`, stack: '' });
      }
    }
  } catch (sendErr) {
    logError(sendCtxErr, sendErr);
  }

  if (!imageSent) await sendImageNow();

  // Derivación: notificar al dueño pero NO pausar el bot — sigue respondiendo
  if (needsHuman && !conversation.needs_human) {
    setNeedsHuman(conversation.id, 1);
    const owner = getUserByBusinessId(business.id);
    notifyOwnerOfPause({
      business, owner, channel: 'whatsapp', contactId: customerPhone,
      messageText: text, conversationId: conversation.id, waCredentials,
    }).catch(err => console.error('[notify-human]', err.message));
  }
}

// --- WhatsApp webhook ---

// WEBHOOK_SIG_MODE: 'off' | 'log' (default) | 'enforce'
// Validates X-Hub-Signature-256 with META_APP_SECRET.
// 'log' → mismatch logged but request accepted; 'enforce' → 401.
function _checkMetaSig(req, logTag) {
  const mode = (process.env.WEBHOOK_SIG_MODE || 'log').toLowerCase();
  if (mode === 'off') return true;

  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    logError('sig-mismatch', { message: `${logTag} META_APP_SECRET not set — skipping sig check mode=${mode}`, stack: '' });
    return true;
  }

  const rawBody   = req.rawBody;
  const sigHeader = req.headers['x-hub-signature-256'] || '';

  if (!rawBody) {
    logError('sig-mismatch', { message: `${logTag} rawBody missing mode=${mode}`, stack: '' });
    return mode !== 'enforce';
  }
  if (!sigHeader) {
    logError('sig-mismatch', { message: `${logTag} no x-hub-signature-256 header mode=${mode}`, stack: '' });
    return mode !== 'enforce';
  }

  const expected    = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const headerBuf   = Buffer.from(sigHeader);
  const match = expectedBuf.length === headerBuf.length
    && crypto.timingSafeEqual(expectedBuf, headerBuf);

  if (match) return true;

  logError('sig-mismatch', {
    message: `${logTag} sig_mismatch mode=${mode} raw_len=${rawBody.length} header_prefix=${sigHeader.slice(0, 12)}…`,
    stack: '',
  });
  return mode !== 'enforce';
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logError('webhook-GET', {
    message: `mode=${mode} token_match=${token === process.env.WHATSAPP_VERIFY_TOKEN} challenge=${challenge} VERIFY_TOKEN_set=${!!process.env.WHATSAPP_VERIFY_TOKEN}`,
    stack: '',
  });

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook', async (req, res) => {
  if (!_checkMetaSig(req, 'webhook')) return res.status(401).send('Unauthorized');
  // Respond 200 immediately so Meta doesn't retry
  res.status(200).send('OK');

  logError('webhook-POST', {
    message: `object=${req.body?.object} entries=${req.body?.entry?.length ?? 0} raw=${JSON.stringify(req.body).slice(0, 500)}`,
    stack: '',
  });

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;

        for (const st of value.statuses || []) {
          if (st.status !== 'failed') continue;
          const e = st.errors?.[0];
          logError('wa-status-failed', {
            message: `phone_number_id=${phoneNumberId} code=${e?.code ?? 'n/a'} title=${String(e?.title ?? '').slice(0, 100)} msg=${String(e?.message ?? '').slice(0, 150)} details=${String(e?.error_data?.details ?? '').slice(0, 150)}`,
            stack: '',
          });
        }

        const messages = value.messages || [];
        if (!messages.length) continue;

        const business = getBusinessByPhoneNumberId(phoneNumberId);
        logError('webhook-lookup', {
          message: `phone_number_id=${phoneNumberId} found=${!!business} business_id=${business?.id ?? 'null'}`,
          stack: '',
        });
        if (!business) {
          continue;
        }

        const waCredentials = { phoneNumberId: business.phone_number_id, accessToken: business.wa_access_token, provider: business.wa_provider || 'meta' };

        for (const msg of messages) {
          if (msg.type !== 'text' && msg.type !== 'audio') continue;
          const customerPhone = msg.from;
          if (!customerPhone) continue;

          // Dedup: INSERT OR IGNORE — if already processed, skip
          if (msg.id) {
            if (!tryMarkProcessed(business.id, msg.id)) {
              logError('msg-duplicate', { message: `source=meta business_id=${business.id} msg_id=${msg.id}`, stack: '' });
              continue;
            }
          }

          // Meta sends timestamp as a Unix epoch string
          const msgTimestamp = msg.timestamp ? parseInt(msg.timestamp, 10) || null : null;

          let text;
          if (msg.type === 'text') {
            text = msg.text?.body;
            if (!text) {
              if (msg.id) deleteProcessedMessage(business.id, msg.id);
              continue;
            }
          } else {
            // audio — download from Meta then transcribe with ElevenLabs Scribe
            const mediaId = msg.audio?.id;
            if (!mediaId) {
              logError('audio-skip', { message: `business_id=${business.id} from=${customerPhone} no_media_id`, stack: '' });
              continue;
            }
            let audioBuffer, audioContentType;
            try {
              ({ buffer: audioBuffer, contentType: audioContentType } = await downloadMetaMedia(mediaId, business.wa_access_token));
              logError('audio-download', { message: `business_id=${business.id} from=${customerPhone} bytes=${audioBuffer.length} mime=${audioContentType}`, stack: '' });
            } catch (dlErr) {
              logError('audio-download', { message: `business_id=${business.id} from=${customerPhone} err=${dlErr.message}`, stack: '' });
              sendWhatsAppMessage(customerPhone, 'No pude escuchar el audio, ¿me lo escribís?', waCredentials).catch(() => {});
              continue;
            }
            try {
              text = await transcribeAudio(audioBuffer, audioContentType);
              logError('audio-transcribe', { message: `business_id=${business.id} from=${customerPhone} chars=${text.length}`, stack: '' });
            } catch (sttErr) {
              logError('audio-transcribe', { message: `business_id=${business.id} from=${customerPhone} err=${sttErr.message}`, stack: '' });
              sendWhatsAppMessage(customerPhone, 'No pude escuchar el audio, ¿me lo escribís?', waCredentials).catch(() => {});
              continue;
            }
            if (!text.trim()) {
              logError('audio-skip', { message: `business_id=${business.id} from=${customerPhone} empty_transcript`, stack: '' });
              sendWhatsAppMessage(customerPhone, 'No pude escuchar el audio, ¿me lo escribís?', waCredentials).catch(() => {});
              continue;
            }
          }

          try {
            await processIncomingMessage(business, waCredentials, {
              msgId: msg.id, customerPhone, text,
              msgTimestamp, msgTimestampField: 'msg.timestamp',
            });
          } catch (err) {
            // Rollback dedup mark so Meta retry can reprocess
            if (msg.id) deleteProcessedMessage(business.id, msg.id);
            logError('webhook-process-error', err);
          }
        }
      }
    }

    // PARTNER_APP_INSTALLED — server-side auto-connect for ES flows where postMessage FINISH is missing
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'account_update') continue;
        if (change.value?.event !== 'PARTNER_APP_INSTALLED') continue;
        const wabaId = String(change.value?.waba_info?.waba_id || '');
        if (!wabaId) continue;
        // Ignore events for other apps sharing this WABA
        const partnerAppId = change.value?.waba_info?.partner_app_id;
        if (partnerAppId && String(partnerAppId) !== String(process.env.META_APP_ID)) continue;

        cleanExpiredEsPending();
        const pending = getActivePendingBusinesses();

        if (pending.length !== 1) {
          logError('es-connect', {
            message: `auto-ambiguo PARTNER_APP_INSTALLED waba_id=${wabaId} pending_count=${pending.length}`,
            stack: '',
          });
          continue;
        }

        const businessId = pending[0].business_id;
        const business   = getBusinessById(businessId);
        if (!business) { deleteEsPending(businessId); continue; }

        if (business.phone_number_id) {
          logError('es-connect', {
            message: `auto-skip waba_id=${wabaId} business_id=${businessId} already_connected`,
            stack: '',
          });
          deleteEsPending(businessId);
          continue;
        }

        const existingWaba = getBusinessByWabaId(wabaId);
        if (existingWaba && existingWaba.id !== businessId) {
          logError('es-connect', {
            message: `auto-blocked waba_id=${wabaId} already_owned_by=${existingWaba.id}`,
            stack: '',
          });
          continue;
        }

        if (!process.env.META_SYSTEM_TOKEN) {
          logError('es-connect', {
            message: `auto-skip waba_id=${wabaId} META_SYSTEM_TOKEN not set`,
            stack: '',
          });
          continue;
        }

        const pnRes  = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(wabaId)}/phone_numbers`, {
          headers: { 'Authorization': `Bearer ${process.env.META_SYSTEM_TOKEN}` },
        });
        const pnData = await pnRes.json();

        if (!pnRes.ok) {
          logError('es-connect', {
            message: `auto-pn-fetch-failed waba_id=${wabaId} status=${pnRes.status}`,
            stack: '',
          });
          continue;
        }

        const phones = pnData.data || [];
        if (phones.length !== 1) {
          logError('es-connect', {
            message: `auto-ambiguo waba_id=${wabaId} business_id=${businessId} phone_count=${phones.length}`,
            stack: '',
          });
          continue;
        }

        const phoneNumberId = String(phones[0].id);
        const pnOwner = getBusinessByPhoneNumberId(phoneNumberId);
        if (pnOwner && pnOwner.id !== businessId) {
          logError('es-connect', {
            message: `auto-pn-taken waba_id=${wabaId} pnid_last4=${phoneNumberId.slice(-4)} owned_by=${pnOwner.id}`,
            stack: '',
          });
          continue;
        }

        const subRes  = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${process.env.META_SYSTEM_TOKEN}` },
        });
        const subData = await subRes.json();
        if (!subRes.ok) {
          logError('whatsapp-sub-failed', {
            message: `auto business_id=${businessId} waba_id=${wabaId} status=${subRes.status}`,
            stack: '',
          });
        }

        saveWabaCredentials(businessId, { wabaId, phoneNumberId, accessToken: null, provider: 'meta' });
        deleteEsPending(businessId);

        const saved = getBusinessById(businessId);
        if (saved) notifyAdmin('wa_connected', { businessName: saved.name, phoneNumber: phoneNumberId, provider: 'meta', source: 'auto' }).catch(() => {});

        logError('es-connect', {
          message: `auto ok business_id=${businessId} waba_id=${wabaId} pnid_last4=${phoneNumberId.slice(-4)} sub_ok=${subRes.ok}`,
          stack: '',
        });
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// Creates the message webhook for a Kapso phone number if it doesn't exist yet.
// Fire-and-forget: call without await. Logs failures to errors table.
async function ensureKapsoWebhook(phoneNumberId) {
  const apiKey       = process.env.KAPSO_API_KEY;
  const webhookSecret = process.env.KAPSO_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret) {
    logError('kapso-ensure-webhook', { message: `missing env: apiKey=${!!apiKey} webhookSecret=${!!webhookSecret} — cannot create webhook for phone_number_id=${phoneNumberId}`, stack: '' });
    return;
  }
  try {
    // Check if active webhook already points to this server
    const listRes = await fetch(
      `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks?url_contains=daxos.lat`,
      { headers: { 'X-API-Key': apiKey } },
    );
    if (!listRes.ok) {
      logError('kapso-ensure-webhook', { message: `list FAILED phone_number_id=${phoneNumberId} status=${listRes.status}`, stack: '' });
      return;
    }
    const listBody = await listRes.json();
    const existing = (listBody?.data || []).find(
      w => w.active &&
           w.url === 'https://daxos.lat/webhook/kapso' &&
           Array.isArray(w.events) && w.events.includes('whatsapp.message.received'),
    );
    if (existing) {
      if (existing.events.includes('whatsapp.message.sent')) return;

      // Webhook exists but lacks message.sent — patch it in
      const patchRes = await fetch(
        `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks/${existing.id}`,
        {
          method: 'PATCH',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            whatsapp_webhook: { events: ['whatsapp.message.received', 'whatsapp.message.sent'] },
          }),
        },
      );
      const patchBody = await patchRes.json().catch(() => ({}));
      if (!patchRes.ok) {
        logError('kapso-ensure-webhook', { message: `patch FAILED phone_number_id=${phoneNumberId} webhook_id=${existing.id} status=${patchRes.status} body=${JSON.stringify(patchBody)}`, stack: '' });
        return;
      }
      logError('kapso-ensure-webhook', { message: `patched phone_number_id=${phoneNumberId} webhook_id=${existing.id} added message.sent`, stack: '' });
      return;
    }

    // No active webhook — create it
    const createRes = await fetch(
      `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks`,
      {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whatsapp_webhook: {
            url:             'https://daxos.lat/webhook/kapso',
            secret_key:      webhookSecret,
            active:          true,
            events:          ['whatsapp.message.received', 'whatsapp.message.sent'],
            payload_version: 'v2',
          },
        }),
      },
    );
    const createBody = await createRes.json().catch(() => ({}));
    if (!createRes.ok) {
      logError('kapso-ensure-webhook', { message: `create FAILED phone_number_id=${phoneNumberId} status=${createRes.status} body=${JSON.stringify(createBody)}`, stack: '' });
      return;
    }
    const webhookId = createBody?.data?.id;
    logError('kapso-ensure-webhook', { message: `created phone_number_id=${phoneNumberId} webhook_id=${webhookId}`, stack: '' });
  } catch (err) {
    logError('kapso-ensure-webhook', { message: `error phone_number_id=${phoneNumberId}: ${err.message}`, stack: err.stack || '' });
  }
}

// Confirms a phone_number_id for a Kapso customer by querying the platform API.
// Returns { phoneNumberId, wabaId, displayPhoneNumber } or null.
// This is the same call the rescue endpoint uses — the API is the source of truth.
async function confirmKapsoPhoneNumber(kapsoCustomerId) {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.kapso.ai/platform/v1/whatsapp/phone_numbers?per_page=100', {
      headers: { 'X-API-Key': apiKey },
    });
    if (!res.ok) {
      logError('kapso-confirm', { message: `API returned ${res.status} querying phone_numbers`, stack: '' });
      return null;
    }
    const body = await res.json();
    const numbers = body?.data || [];
    const matches = numbers.filter(n => String(n.customer_id) === String(kapsoCustomerId));
    if (matches.length === 0) {
      logError('kapso-confirm', { message: `customer_id=${kapsoCustomerId} no match in ${numbers.length} numbers`, stack: '' });
      return null;
    }
    if (matches.length > 1) {
      logError('kapso-confirm', { message: `customer_id=${kapsoCustomerId} AMBIGUOUS: ${matches.length} matches — not saving to avoid wrong number`, stack: '' });
      return null;
    }
    const match = matches[0];
    logError('kapso-confirm', {
      message: `customer_id=${kapsoCustomerId} total_numbers=${numbers.length} match=${JSON.stringify({ phone_number_id: match.phone_number_id, business_account_id: match.business_account_id, display_phone_number: match.display_phone_number, status: match.status })}`,
      stack: '',
    });
    if (!match?.phone_number_id) return null;
    return {
      phoneNumberId:      String(match.phone_number_id),
      wabaId:             match.business_account_id || null,
      displayPhoneNumber: match.display_phone_number || null,
    };
  } catch (err) {
    logError('kapso-confirm', { message: `fetch error: ${err.message}`, stack: err.stack || '' });
    return null;
  }
}

// --- Meta Cloud API webhook ---

app.get('/webhook/meta', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook/meta', (req, res) => {
  if (!_checkMetaSig(req, 'webhook/meta')) return res.status(401).send('Unauthorized');
  res.status(200).send('OK');
  const b    = req.body;
  const wabaId  = b?.entry?.[0]?.id ?? null;
  const pnid    = b?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null;
  logError('meta-event', {
    message: `object=${b?.object} entries=${b?.entry?.length ?? 0} waba_id=${wabaId} phone_number_id=${pnid}`,
    stack: '',
  });
});

// --- Kapso webhook ---

app.get('/webhook/kapso', (_req, res) => res.status(200).send('OK'));

app.post('/webhook/kapso', async (req, res) => {
  res.status(200).send('OK');

  // Track dedup state so catch block can roll back on unexpected failure
  let _dedupBizId = null, _dedupMsgId = null;

  // Structured per-event disposition log — one line per incoming event.
  // Captured from parsed body (express.json runs before handler).
  const _pnid  = String(req.body?.phone_number_id || 'unknown');
  const _event = String(req.body?.event || (req.body?.message?.type ? `msg.${req.body.message.type}` : 'unknown'));
  function logKapsoEvent(disposition) {
    logError('kapso-event', {
      message: `event=${_event} phone_number_id=${_pnid} disposition=${disposition}`,
      stack: '',
    });
  }

  const rawBody = req.rawBody;
  const sig     = req.headers['x-webhook-signature'] || '';
  const secret  = process.env.KAPSO_WEBHOOK_SECRET;

  const _isImageMsg = req.body?.message?.type === 'image';
  logError('kapso-webhook', {
    message: `sig_present=${!!sig} secret_set=${!!secret} raw_len=${rawBody?.length ?? 0}` +
      (_isImageMsg ? ' preview=[image_suppressed]' : ` preview=${rawBody?.toString().slice(0, 200) ?? ''}`),
    stack: '',
  });

  if (secret) {
    if (!rawBody) {
      logKapsoEvent('discarded:rawbody_missing');
      logError('kapso-webhook', { message: 'rawBody missing — verify middleware order', stack: '' });
      return;
    }
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const expBuf   = Buffer.from(expected, 'utf8');
    const sigBuf   = Buffer.from(sig.length === expected.length ? sig : '', 'utf8');
    if (sigBuf.length === 0 || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logKapsoEvent('discarded:invalid_hmac');
      logError('kapso-webhook', { message: 'invalid HMAC signature — rejected', stack: '' });
      return;
    }
  } else {
    if (IS_PROD) {
      logKapsoEvent('discarded:no_secret_configured');
      logError('kapso-webhook', { message: 'KAPSO_WEBHOOK_SECRET not set in production — rejecting request', stack: '' });
      return;
    }
    logError('kapso-webhook', { message: 'KAPSO_WEBHOOK_SECRET not set — skipping signature check (non-production)', stack: '' });
  }

  try {
    const payload = req.body;
    const msg     = payload?.message;
    if (!msg) {
      logKapsoEvent(`discarded:no_message_field`);
      return;
    }

    const phoneNumberId = String(payload.phone_number_id || '');
    const business      = getBusinessByPhoneNumberId(phoneNumberId);
    logError('kapso-webhook', {
      message: `phone_number_id=${phoneNumberId} found=${!!business} business_id=${business?.id ?? 'null'}`,
      stack: '',
    });

    if (!business) {
      logKapsoEvent(`discarded:business_not_found`);
      return;
    }

    // Dedup: before any processing (covers owner reply and customer paths)
    if (msg.id) {
      if (!tryMarkProcessed(business.id, msg.id)) {
        logKapsoEvent(`discarded:duplicate msg_id=${msg.id} business_id=${business.id}`);
        logError('msg-duplicate', { message: `source=kapso business_id=${business.id} msg_id=${msg.id}`, stack: '' });
        return;
      }
      _dedupBizId = business.id;
      _dedupMsgId = msg.id;
    }

    // 1. Owner replied from WA Business App — check origin first, regardless of from/to
    const kapsoOrigin = msg.kapso?.origin;
    if (kapsoOrigin === 'business_app') {
      const customerPhone = msg.to
        || payload.conversation?.contact?.phone_number
        || payload.conversation?.contact?.wa_id
        || null;
      logError('kapso-webhook-echo', {
        message: `business_app origin=${kapsoOrigin} from=${msg.from} to=${msg.to} full=${JSON.stringify(payload).slice(0, 2000)}`,
        stack: '',
      });
      if (customerPhone) {
        const conv = getOrCreateConversation(business.id, customerPhone);
        const ownerText = msg.type === 'text'
          ? (msg.text?.body || '[mensaje vacío]')
          : `[${msg.type || 'mensaje'}]`;
        addMessage(conv.id, 'assistant', ownerText);
        // During silent window: save owner reply but don't pause bot or notify
        const silentUntilMs = parseSqliteUtc(business.silent_until);
        if (!silentUntilMs || Date.now() >= silentUntilMs) {
          setHumanPaused(conv.id);
        }
        logError('kapso-webhook-echo', {
          message: `business_app saved conv=${conv.id} customer=${customerPhone} text="${ownerText.slice(0, 80)}" silent_skipped=${!!(silentUntilMs && Date.now() < silentUntilMs)}`,
          stack: '',
        });
        logKapsoEvent(`processed:owner_echo_saved conv=${conv.id} customer=${customerPhone}`);
      } else {
        logError('kapso-webhook-echo', {
          message: `business_app no customer phone payload=${JSON.stringify(payload).slice(0, 500)}`,
          stack: '',
        });
        logKapsoEvent(`discarded:owner_echo_no_customer_phone`);
      }
      return;
    }

    // 2. Outbound: bot echo (no from), business's own number, or explicit sent event — ignore silently
    const bizPhone = (business.whatsapp_number || '').replace(/\D/g, '');
    const fromPhone = (msg.from || '').replace(/\D/g, '');
    const isFromOwnNumber = bizPhone && fromPhone && (fromPhone === bizPhone || fromPhone.endsWith(bizPhone) || bizPhone.endsWith(fromPhone));
    if (!msg.from || isFromOwnNumber || payload.event === 'whatsapp.message.sent') {
      const reason = !msg.from ? 'no_from' : isFromOwnNumber ? 'own_number' : 'sent_event';
      logKapsoEvent(`discarded:outbound reason=${reason}`);
      return;
    }

    const waCredentials = {
      phoneNumberId: business.phone_number_id,
      accessToken:   business.wa_access_token,
      provider:      business.wa_provider || 'meta',
    };

    let text;
    if (msg.type === 'text') {
      text = msg.text?.body;
    } else if (msg.type === 'audio' && msg.kapso?.transcript?.text) {
      text = msg.kapso.transcript.text;
    }

    if (msg.type === 'image') {
      const IMG_FALLBACK    = 'No pude ver la imagen. ¿Me lo contás por texto?';
      const ALLOWED_MIMES   = new Set(['image/jpeg', 'image/png', 'image/webp']);
      const imgHourKey      = Math.floor(Date.now() / 3_600_000);
      pruneImgMaps(imgHourKey);
      const imgConv         = getOrCreateConversation(business.id, msg.from);
      const imgCntKey       = `${imgConv.id}:${imgHourKey}`;
      const imgFbKey        = `${imgConv.id}:${imgHourKey}`;
      const imgCaption      = msg.image?.caption || '';
      const imgStoredText   = imgCaption
        ? `[el cliente envió una imagen] "${imgCaption}"`
        : '[el cliente envió una imagen]';

      async function sendImgFallback(reason) {
        const staleReason = isMsgStale(business, imgTimestamp);
        if (staleReason) {
          logKapsoEvent(`image_fallback_skipped reason=stale:${staleReason}`);
          return;
        }
        if (_imgFallbackSent.get(imgFbKey)) {
          logKapsoEvent(`discarded:image_fallback_throttled reason=${reason}`);
          return;
        }
        _imgFallbackSent.set(imgFbKey, true);
        logKapsoEvent(`image_fallback_sent reason=${reason}`);
        if (business.silent_until) {
          const silentUntilMs = parseSqliteUtc(business.silent_until);
          if (silentUntilMs && Date.now() < silentUntilMs) {
            addMessage(imgConv.id, 'user', imgStoredText, 1);
            logKapsoEvent(`image_fallback_suppressed reason=silent_until`);
            return;
          }
        }
        addMessage(imgConv.id, 'user', imgStoredText);
        if (imgConv.needs_attention || isTrialExpired(business)) {
          logKapsoEvent(`image_fallback_suppressed reason=${imgConv.needs_attention ? 'paused' : 'trial_expired'}`);
          return;
        }
        addMessage(imgConv.id, 'assistant', IMG_FALLBACK);
        sendWhatsAppMessage(msg.from, IMG_FALLBACK, waCredentials)
          .catch(fbErr => logError('image-fallback-send', { message: fbErr.message, stack: '' }));
      }

      // Resolve timestamp (same logic as text path)
      const imgTimestamp = msg.timestamp != null ? Number(msg.timestamp) || null
        : msg.created_at != null ? Math.floor(new Date(msg.created_at).getTime() / 1000) || null
        : null;
      const imgTimestampField = msg.timestamp != null ? 'msg.timestamp'
        : msg.created_at != null ? 'msg.created_at'
        : null;

      // Rate limit: 10 images/hour per conversation
      const imgCount = _imgHourCount.get(imgCntKey) || 0;
      if (imgCount >= 10) {
        await sendImgFallback('rate_limit');
        return;
      }

      // Pre-download: reject only definitively wrong image types (sticker, gif, etc.).
      // Unknown types (application/octet-stream, empty) proceed to magic-byte check.
      const declaredMime = (msg.image?.mime_type || '').split(';')[0].trim();
      if (declaredMime && declaredMime.startsWith('image/') && !ALLOWED_MIMES.has(declaredMime)) {
        await sendImgFallback(`unsupported_mime:${declaredMime}`);
        return;
      }

      // Download image in memory
      const mediaUrl = msg.kapso?.media_url || null;
      const mediaId  = msg.image?.id || null;
      let imgBuffer, contentType;
      try {
        ({ buffer: imgBuffer, contentType } = await downloadKapsoMedia(mediaUrl, mediaId, waCredentials.phoneNumberId));
      } catch (dlErr) {
        logError('image-download-error', { message: dlErr.message, stack: '' });
        await sendImgFallback('download_error');
        return;
      }

      // Validate format via magic bytes — bytes win over declared Content-Type
      const detectedMime = detectMimeFromBytes(imgBuffer);
      if (!detectedMime) {
        await sendImgFallback(`unsupported_content_type:bytes_invalid`);
        return;
      }
      const actualMime = detectedMime;

      // Increment counter only once the image is validated
      _imgHourCount.set(imgCntKey, imgCount + 1);

      const imageData = { base64: imgBuffer.toString('base64'), mimeType: actualMime, caption: imgCaption };

      logKapsoEvent(`processing:image business_id=${business.id} from=${msg.from} mime=${actualMime} bytes=${imgBuffer.length}`);

      await processIncomingMessage(business, waCredentials, {
        msgId:             msg.id,
        customerPhone:     msg.from,
        text:              imgStoredText,
        msgTimestamp:      imgTimestamp,
        msgTimestampField: imgTimestampField,
        imageData,
      });
      return;
    }

    if (!text?.trim()) {
      logKapsoEvent(`discarded:no_text type=${msg.type}`);
      return;
    }

    // Resolve timestamp — field name unknown until first real payload; log it once/day
    const msgTimestamp = msg.timestamp != null ? Number(msg.timestamp) || null
      : msg.created_at != null ? Math.floor(new Date(msg.created_at).getTime() / 1000) || null
      : null;
    const msgTimestampField = msg.timestamp != null ? 'msg.timestamp'
      : msg.created_at != null ? 'msg.created_at'
      : null;

    if (msgTimestamp == null) {
      const todayUY = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const noTsKey = `${business.id}-no-ts`;
      if (_timestampFieldLogDate[noTsKey] !== todayUY) {
        _timestampFieldLogDate[noTsKey] = todayUY;
        logError('msg-no-timestamp', {
          message: `msgId=${msg.id} business_id=${business.id} available_keys=${JSON.stringify(Object.keys(msg))}`,
          stack: '',
        });
      }
    }

    logKapsoEvent(`processing business_id=${business.id} from=${msg.from} type=${msg.type} msg_id=${msg.id}`);
    await processIncomingMessage(business, waCredentials, {
      msgId:            msg.id,
      customerPhone:    msg.from,
      text:             text.trim(),
      msgTimestamp,
      msgTimestampField,
    });
  } catch (err) {
    logKapsoEvent(`error:${err.message.slice(0, 100)}`);
    // Rollback dedup mark so the next Kapso retry can reprocess
    if (_dedupBizId && _dedupMsgId) deleteProcessedMessage(_dedupBizId, _dedupMsgId);
    logError('kapso-webhook', err);
  }
});

// --- Kapso platform webhook (onboarding events: phone_number.created) ---

app.post('/webhook/kapso-platform', async (req, res) => {
  res.status(200).send('OK');

  const rawBody = req.rawBody;
  const sig     = req.headers['x-webhook-signature'] || '';
  const secret  = process.env.KAPSO_PLATFORM_WEBHOOK_SECRET;

  logError('kapso-onboarding-webhook', {
    message: `sig_present=${!!sig} secret_set=${!!secret} raw_len=${rawBody?.length ?? 0} preview=${rawBody?.toString().slice(0, 400) ?? ''}`,
    stack: '',
  });

  if (!secret) {
    logError('kapso-onboarding-webhook', { message: 'KAPSO_PLATFORM_WEBHOOK_SECRET not set — rejecting request', stack: '' });
    return;
  }
  if (!rawBody) {
    logError('kapso-onboarding-webhook', { message: 'rawBody missing', stack: '' });
    return;
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expBuf   = Buffer.from(expected, 'utf8');
  const sigBuf   = Buffer.from(sig.length === expected.length ? sig : '', 'utf8');
  if (sigBuf.length === 0 || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    logError('kapso-onboarding-webhook', { message: 'invalid HMAC — rejected', stack: '' });
    return;
  }

  try {
    const payload = req.body;
    logError('kapso-onboarding-webhook', { message: `full_payload=${JSON.stringify(payload)}`, stack: '' });

    // Accept both: direct payload { phone_number_id, customer: {id} }
    // and envelope { event: "...", data: { phone_number_id, customer: {id} } }
    const data            = payload?.data || payload;
    const eventType       = payload?.event || payload?.type;
    const kapsoCustomerId = data?.customer?.id || payload?.customer?.id;

    logError('kapso-onboarding-webhook', {
      message: `resolved_event_type=${JSON.stringify(eventType)} top_level_keys=${JSON.stringify(Object.keys(payload ?? {}))} kapso_customer_id=${kapsoCustomerId}`,
      stack: '',
    });

    // Accept explicit phone_number.created events, or a payload with no event field
    // but with a customer.id (the docs show the raw payload without an event wrapper).
    const isConnectionEvent =
      eventType === 'phone_number.created' ||
      eventType === 'whatsapp.phone_number.created' ||
      (!eventType && !!kapsoCustomerId);

    if (!isConnectionEvent) {
      logError('kapso-onboarding-webhook', { message: `event_type=${JSON.stringify(eventType)} not a connection event — skipping`, stack: '' });
      return;
    }

    if (!kapsoCustomerId) {
      logError('kapso-onboarding-webhook', { message: 'missing customer.id — skipping', stack: '' });
      return;
    }

    const business = getBusinessByKapsoCustomerId(kapsoCustomerId);
    if (!business) {
      logError('kapso-onboarding-webhook', { message: `business not found for kapso_customer_id=${kapsoCustomerId}`, stack: '' });
      return;
    }

    // Confirm via Kapso API — do not trust payload values alone
    const confirmed = await confirmKapsoPhoneNumber(kapsoCustomerId);
    if (!confirmed) {
      logError('kapso-onboarding-webhook', {
        message: `API did not confirm phone_number for customer_id=${kapsoCustomerId} business_id=${business.id} — skipping save, polling will handle it`,
        stack: '',
      });
      return;
    }

    saveWabaCredentials(business.id, {
      wabaId:       confirmed.wabaId,
      phoneNumberId: confirmed.phoneNumberId,
      accessToken:   null,
      provider:      'kapso',
    });

    logError('kapso-onboarding-webhook', {
      message: `saved business_id=${business.id} phone_number_id=${confirmed.phoneNumberId} display=${confirmed.displayPhoneNumber} provider=kapso`,
      stack: '',
    });

    ensureKapsoWebhook(confirmed.phoneNumberId);
    notifyAdmin('wa_connected', { businessName: business.name, phoneNumber: confirmed.displayPhoneNumber || confirmed.phoneNumberId, provider: 'kapso', source: 'webhook' }).catch(() => {});
  } catch (err) {
    logError('kapso-onboarding-webhook', err);
  }
});

// --- Mercado Pago webhook ---

app.post('/webhook/mercadopago', async (req, res) => {
  // Reject immediately if secret is not configured — do not process unsigned webhooks
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[mp-webhook] MERCADOPAGO_WEBHOOK_SECRET not set — rejecting request');
    return res.status(200).send('OK'); // 200 so MP doesn't keep retrying an unconfigured server
  }

  // Validate HMAC-SHA256 signature
  const xSignature = req.headers['x-signature'] || '';
  const xRequestId = req.headers['x-request-id'] || '';
  const paymentId  = req.query?.['data.id'] || req.body?.data?.id || '';
  const tsMatch    = xSignature.match(/ts=([^,]+)/);
  const v1Match    = xSignature.match(/v1=([^,]+)/);

  if (!tsMatch || !v1Match) {
    console.warn('[mp-webhook] Missing or malformed x-signature — rejected');
    return res.status(200).send('OK');
  }

  const manifest = `id:${paymentId};request-id:${xRequestId};ts:${tsMatch[1]};`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(manifest).digest('hex');
  const received = v1Match[1];

  if (received.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    console.warn('[mp-webhook] Invalid HMAC signature — rejected');
    return res.status(200).send('OK');
  }

  // Respond 200 immediately — MP retries on non-2xx
  res.status(200).send('OK');

  try {
    const { type, data } = req.body || {};
    if (!type || !data?.id) return;

    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!mpToken) {
      console.error('[mp-webhook] MERCADOPAGO_ACCESS_TOKEN not set');
      return;
    }

    const adminEmail = process.env.ADMIN_EMAIL;

    // ── Subscription cancelled / paused ──
    if (type === 'subscription_preapproval') {
      const subRes = await fetch(`https://api.mercadopago.com/preapproval/${data.id}`, {
        headers: { 'Authorization': `Bearer ${mpToken}` },
      });
      if (!subRes.ok) {
        console.error(`[mp-webhook] MP preapproval API ${subRes.status} for ${data.id}`);
        return;
      }
      const sub = await subRes.json();
      const subStatus = sub.status; // 'authorized' | 'paused' | 'cancelled' | 'pending'

      if (subStatus === 'cancelled' || subStatus === 'paused') {
        const payerEmail = sub.payer_email?.toLowerCase().trim();
        if (!payerEmail) return;
        const user = getUserByEmail(payerEmail);
        if (user?.business_id) {
          setSubscriptionStatus(user.business_id, subStatus);
          console.log(`[mp-webhook] Subscription ${data.id} ${subStatus} — business ${user.business_id} marked`);
        } else {
          console.warn(`[mp-webhook] Subscription ${subStatus} but no business for ${payerEmail}`);
        }
      }
      return;
    }

    // ── Payment (alta + renovaciones mensuales) ──
    if (type !== 'payment') return;

    // Dedup: skip if already processed (MP can send the same notification more than once)
    if (isPaymentProcessed(String(data.id))) {
      console.log(`[mp-webhook] Payment ${data.id} already processed — skipping`);
      return;
    }

    // Verify payment directly with MP API — never trust the notification body alone
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${mpToken}` },
    });
    if (!mpRes.ok) {
      console.error(`[mp-webhook] MP API returned ${mpRes.status} for payment ${data.id}`);
      return;
    }

    const payment = await mpRes.json();

    if (payment.status !== 'approved') {
      console.log(`[mp-webhook] Payment ${data.id} status=${payment.status} — ignoring`);
      return;
    }

    const payerEmail = payment.payer?.email?.toLowerCase().trim();
    if (!payerEmail) {
      console.warn(`[mp-webhook] No payer email in payment ${data.id}`);
      return;
    }

    const amount    = payment.transaction_amount;
    const currency  = payment.currency_id;
    const paidAt    = payment.date_approved || payment.date_created || new Date().toISOString();
    const expiresAt = new Date(new Date(paidAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const rawRef    = (payment.external_reference || '').toLowerCase().trim();

    // Resolve plan from amount (source of truth) and external_reference (validation)
    const planByAmount = MP_AMOUNT_TO_PLAN[Math.round(amount)];
    const planByRef    = rawRef ? MP_REF_TO_PLAN[rawRef] : undefined;

    // Guard: unknown amount or mismatch between amount and reference → manual review
    const mismatch = planByRef !== undefined && planByRef !== planByAmount;
    if (!planByAmount || mismatch) {
      const reason = !planByAmount ? 'unknown_amount' : 'amount_ref_mismatch';
      savePendingPayment({ mpPaymentId: String(data.id), payerEmail, amount, currency, paidAt, rawJson: JSON.stringify(payment) });
      logError('mp-webhook-pending', {
        message: `payment=${data.id} reason=${reason} amount=${amount} planByAmount=${planByAmount ?? 'none'} planByRef=${planByRef ?? 'none'} ref=${rawRef || 'empty'} payer=${payerEmail}`,
        stack: '',
      });
      if (adminEmail) {
        sendAdminNotificationEmail({ adminEmail, event: 'mp_payment_manual_review', data: {
          reason, payment_id: data.id, payer_email: payerEmail,
          amount: `${amount} ${currency}`, plan_by_amount: planByAmount ?? 'desconocido',
          plan_by_ref: planByRef ?? 'no especificado', external_reference: rawRef || '(vacío)',
        }}).catch(err => console.error('[mp-webhook] alert email failed:', err.message));
      }
      console.warn(`[mp-webhook] Payment ${data.id} held for manual review — reason=${reason}`);
      return;
    }

    const plan = planByAmount;

    // Match payer email to a registered user
    const user = getUserByEmail(payerEmail);
    if (user?.business_id) {
      upgradePlan(user.business_id, plan, paidAt, expiresAt);
      savePayment({ businessId: user.business_id, mpPaymentId: String(data.id), amount, currency, paidAt, rawJson: JSON.stringify(payment) });
      console.log(`[mp-webhook] Upgraded business ${user.business_id} to ${plan} (payment ${data.id} amount=${amount})`);
      return;
    }

    // No user found — save for manual review
    savePendingPayment({ mpPaymentId: String(data.id), payerEmail, amount, currency, paidAt, rawJson: JSON.stringify(payment) });
    if (adminEmail) {
      sendUnmatchedPaymentAlert({ adminEmail, payerEmail, amount, currency, mpPaymentId: data.id })
        .catch(err => console.error('[mp-webhook] alert email failed:', err.message));
    }
    console.warn(`[mp-webhook] No business for ${payerEmail}, payment ${data.id} saved as pending`);
  } catch (err) {
    console.error('[mp-webhook] Error processing payment:', err.message);
  }
});

// ─── Demo generator ───────────────────────────────────────────────────────────

const { generateDemoChatReply, extractBusinessData: _extractBizData, MAX_CHAT_MSGS } = require('./demo-generator');
const { scrapeWebsite } = require('./demo-scraper');

// POST /api/demos  — create demo from URL (web-triggered, IP-rate-limited)
app.post('/api/demos', rateLimitWith(3, 24 * 60 * 60 * 1000, req => `demo-ip:${req.ip}`), async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url requerida' });

  const ip = req.ip;

  if (getDemoDailyCountByIp(ip) >= 3)
    return res.status(429).json({ error: 'Límite diario por IP alcanzado' });
  if (getDemoDailyGlobalCount() >= 200)
    return res.status(429).json({ error: 'Límite global diario alcanzado' });

  let cleanUrl;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    cleanUrl = parsed.href;
  } catch {
    return res.status(400).json({ error: 'URL inválida' });
  }

  try {
    await _validateSsrfUrl(cleanUrl, { allowHttp: false });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const TIMEOUT = 90_000;
    const start = Date.now();
    const result = await Promise.race([
      (async () => {
        const { pages, jsOnly } = await scrapeWebsite(cleanUrl);
        if (jsOnly) throw Object.assign(new Error('El sitio requiere JavaScript'), { code: 'JS_ONLY' });
        const data = await _extractBizData(pages, ({ event, inTokens, outTokens }) => {
          logDemoCost({ demoId: null, event, inTokens, outTokens });
        });
        const slug = crypto.randomBytes(6).toString('base64url');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        return createDemo({ slug, dataJson: JSON.stringify(data), sourceUrl: cleanUrl, ip, durationMs: Date.now() - start, expiresAt });
      })(),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), TIMEOUT)),
    ]);
    res.json({ slug: result.slug, url: `/d/${result.slug}` });
  } catch (err) {
    if (err.code === 'JS_ONLY') return res.status(422).json({ error: err.message });
    if (err.code === 'TIMEOUT') return res.status(504).json({ error: 'Timeout generando demo' });
    console.error('[demo] create error:', err.message);
    res.status(500).json({ error: 'Error generando demo' });
  }
});

// GET /api/demos/:slug
app.get('/api/demos/:slug', (req, res) => {
  const row = getDemo(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Demo no encontrada' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Demo expirada' });
  let data = {};
  try { data = JSON.parse(row.data_json); } catch {}
  res.json({ slug: row.slug, data, sourceUrl: row.source_url, msgCount: row.msg_count, createdAt: row.created_at });
});

// PATCH /api/demos/:slug  — update extracted data (editable fields)
app.patch('/api/demos/:slug', (req, res) => {
  const row = getDemo(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Demo no encontrada' });
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data requerida' });
  let existing = {};
  try { existing = JSON.parse(row.data_json); } catch {}
  const merged = Object.assign({}, existing, data);
  patchDemo(req.params.slug, JSON.stringify(merged));
  res.json({ ok: true });
});

// POST /api/demos/:slug/chat
app.post('/api/demos/:slug/chat', rateLimitWith(30, 60 * 60 * 1000, req => `demo-chat:${req.ip}`), async (req, res) => {
  const row = getDemo(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Demo no encontrada' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Demo expirada' });
  if (row.msg_count >= MAX_CHAT_MSGS) return res.status(429).json({ error: 'Límite de mensajes alcanzado', limitReached: true });

  const { message, history } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message requerido' });

  let data = {};
  try { data = JSON.parse(row.data_json); } catch {}

  const conversationHistory = Array.isArray(history) ? history.slice(-20) : [];

  try {
    const reply = await generateDemoChatReply(data, conversationHistory, message.slice(0, 1000), ({ event, inTokens, outTokens }) => {
      logDemoCost({ demoId: row.id, event, inTokens, outTokens });
    });
    incrementDemoMsgCount(req.params.slug);
    res.json({ reply, msgCount: row.msg_count + 1 });
  } catch (err) {
    console.error('[demo] chat error:', err.message);
    res.status(500).json({ error: 'Error generando respuesta' });
  }
});

// GET /d/:slug — serve demo page
app.get('/d/:slug', (req, res) => {
  const row = getDemo(req.params.slug);
  if (!row) return res.status(404).send('Demo no encontrada');
  if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).send('Esta demo expiró');
  res.sendFile(path.join(__dirname, '..', 'public', 'demo.html'));
});

// ─── Admin panel ──────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(403).json({ error: 'Acceso denegado' });
}

app.get('/admin', (req, res) => {
  if (!req.session?.isAdmin) return res.redirect('/admin/login');
  res.redirect('/admin/inicio');
});

app.get('/admin/login', (req, res) => {
  if (req.session?.isAdmin) return res.redirect('/admin/inicio');
  res.sendFile(path.join(__dirname, 'views/admin/login.html'));
});

app.get('/admin/inicio', (req, res) => {
  if (!req.session?.isAdmin) return res.redirect('/admin/login');
  res.sendFile(path.join(__dirname, 'views/admin/inicio.html'));
});

app.get('/admin/negocio/:id', (req, res) => {
  if (!req.session?.isAdmin) return res.redirect('/admin/login');
  res.sendFile(path.join(__dirname, 'views/admin/negocio.html'));
});

app.post('/admin/auth/login',
  rateLimit(req => `admin-login:ip:${req.ip}`),
  async (req, res) => {
  const rawAdminEmail = process.env.ADMIN_EMAIL;
  if (!rawAdminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL no configurado' });
  // Strip surrounding quotes and whitespace that Raw Editor in Railway may inject
  const adminEmail = rawAdminEmail.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (email.toLowerCase().trim() !== adminEmail) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  const user = getUserByEmail(email.toLowerCase().trim());
  if (!user) return res.status(403).json({ error: 'Acceso denegado' });

  try {
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Credenciales incorrectas' });
    req.session.isAdmin = true;
    req.session.adminUserId = user.id;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
  });

app.post('/admin/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/admin/auth/me', (req, res) => {
  if (!req.session?.isAdmin) return res.status(403).json({ error: 'No autorizado' });
  res.json({ ok: true });
});

app.get('/admin/api/stats', requireAdmin, (req, res) => {
  res.json(getGlobalStats());
});

app.get('/admin/api/businesses', requireAdmin, (req, res) => {
  res.json(getAllBusinesses());
});

app.get('/admin/api/business/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  const business = getBusinessById(id);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });

  const metrics = getBusinessAdminMetrics(id);
  const owner = getUserByBusinessId(id);

  // Strip sensitive/large fields — never expose conversation content or internal keys
  const { sales_examples, survey_answers, style_profile, document_path, ...safeFields } = business;
  res.json({ ...safeFields, metrics, owner_email: owner?.email || null });
});

app.post('/admin/api/silent/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  const minutes = parseInt(req.body.minutes, 10);
  if (isNaN(minutes) || minutes < 1 || minutes > 1440) {
    return res.status(400).json({ error: 'minutos debe ser un entero entre 1 y 1440' });
  }
  const until   = new Date(Date.now() + minutes * 60 * 1000);
  const isoUtc  = until.toISOString().slice(0, 19).replace('T', ' ');
  setSilentUntil(id, isoUtc);
  res.json({ ok: true, silent_until: isoUtc });
});

app.delete('/admin/api/silent/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  clearSilentUntil(id);
  res.json({ ok: true });
});

app.post('/admin/api/wa-disconnect/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  const prev = clearWabaCredentials(id);
  const last4 = prev?.phone_number_id ? String(prev.phone_number_id).slice(-4) : 'null';
  logError('wa-admin-disconnect', {
    message: `business_id=${id} phone_number_id_last4=${last4} wa_provider=${prev?.wa_provider ?? 'null'} wa_connected_at=${prev?.wa_connected_at ?? 'null'}`,
    stack: '',
  });
  res.json({ ok: true, cleared: prev });
});

app.get('/admin/api/costs', requireAdmin, (req, res) => {
  const stats = getGlobalStats();

  // Claude Sonnet 4.6: $3/MTok input, $15/MTok output — ~2000 input + 300 output per reply
  const claudeUSD = stats.aiRepliesThisMonth * (
    (2000 * 3 / 1_000_000) + (300 * 15 / 1_000_000)
  );

  // ElevenLabs: turbo/flash models = $0.15/1K chars, multilingual = $0.30/1K chars
  const elModel = process.env.ELEVENLABS_MODEL_ID || '';
  const elPricePerChar = (elModel.includes('turbo') || elModel.includes('flash')) ? 0.15 / 1000 : 0.30 / 1000;
  const elevenlabsUSD = stats.voiceRepliesThisMonth * 200 * elPricePerChar;

  res.json({
    claude: { replies: stats.aiRepliesThisMonth, estimatedUSD: parseFloat(claudeUSD.toFixed(2)) },
    elevenlabs: { voiceReplies: stats.voiceRepliesThisMonth, estimatedUSD: parseFloat(elevenlabsUSD.toFixed(2)), model: elModel || 'no configurado' },
    revenue: stats.revenueThisMonth,
    totalCostUSD: parseFloat((claudeUSD + elevenlabsUSD).toFixed(2)),
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Admin — error_log viewer
// GET /admin/api/errors?context=xxx&limit=50
const _SENSITIVE_RE = [
  /EAA[A-Za-z0-9+/]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{10,}/gi,
  /access_token=[^&\s"']{10,}/gi,
  /sk-ant-[A-Za-z0-9\-]{10,}/g,
  /APP_USR-[A-Za-z0-9\-]{10,}/g,
  /re_[A-Za-z0-9]{20,}/g,
];
function _redactMessage(msg) {
  if (typeof msg !== 'string') return msg;
  let s = msg;
  for (const re of _SENSITIVE_RE) s = s.replace(re, '[REDACTED]');
  return s;
}
app.get('/admin/api/errors', requireAdmin, (req, res) => {
  const context = typeof req.query.context === 'string' && req.query.context ? req.query.context : null;
  const limit   = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const rows    = getErrorsFiltered(context, limit);
  res.json({
    total:   rows.length,
    context: context || null,
    limit,
    errors:  rows.map(r => ({ ...r, message: _redactMessage(r.message) })),
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Embedded Signup — OAuth callback
// POST /auth/whatsapp/callback
// Body: { code?, waba_id, phone_number_id, business_id }
// code es opcional: si no viene, se verifica PARTNER_APP_INSTALLED en error_log.
app.post('/auth/whatsapp/callback', requireAuth, async (req, res) => {
  const { code, waba_id, phone_number_id, business_id } = req.body;

  if (!waba_id || !phone_number_id || !business_id) {
    return res.status(400).json({ error: 'waba_id, phone_number_id, business_id requeridos' });
  }

  const userBusiness = getBusinessByUserId(req.session.userId);
  if (!userBusiness || userBusiness.id !== Number(business_id)) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  // Verificar que la WABA no esté ya asignada a otro negocio
  const existingBiz = getBusinessByWabaId(waba_id);
  if (existingBiz && existingBiz.id !== Number(business_id)) {
    logError('es-connect', {
      message: `blocked waba_id=${waba_id} already assigned to business_id=${existingBiz.id}`,
      stack: '',
    });
    return res.status(403).json({ error: 'Esta WABA ya está asociada a otro negocio.' });
  }

  try {
    let accessToken = null;

    if (code) {
      // Flujo con code: intercambiar por access token del usuario
      const appId     = process.env.META_APP_ID;
      const appSecret = process.env.META_APP_SECRET;
      if (!appId || !appSecret) {
        return res.status(500).json({ error: 'META_APP_ID y META_APP_SECRET no configurados en el servidor' });
      }
      const tokenUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
      tokenUrl.searchParams.set('client_id', appId);
      tokenUrl.searchParams.set('client_secret', appSecret);
      tokenUrl.searchParams.set('code', code);
      const redirectUri = process.env.META_REDIRECT_URI;
      if (redirectUri) tokenUrl.searchParams.set('redirect_uri', redirectUri);

      const tokenRes  = await fetch(tokenUrl.toString());
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        logError('es-connect', {
          message: `token_exchange_failed business_id=${business_id} waba_id=${waba_id} status=${tokenRes.status}`,
          stack: '',
        });
        return res.status(400).json({ error: 'Token exchange falló', detail: tokenData });
      }
      accessToken = tokenData.access_token;
    } else {
      // Flujo sin code: verificar PARTNER_APP_INSTALLED en webhook-POST logs de /webhook (hasta 3 reintentos, 2s entre cada uno)
      if (!process.env.META_SYSTEM_TOKEN) {
        return res.status(500).json({ error: 'META_SYSTEM_TOKEN no configurado — requerido sin code' });
      }
      const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let verified = false;
      let rowsChecked = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await _sleep(2000);
        const rows = getErrorsFiltered('webhook-POST', 200);
        rowsChecked = rows.length;
        const cutoff = Date.now() - 60 * 60 * 1000;
        verified = rows.some(r => {
          const ts = parseSqliteUtc(r.created_at);
          if (!ts || ts < cutoff) return false;
          try {
            const m = r.message.match(/raw=(\{.*)/s);
            if (!m) return false;
            const body = JSON.parse(m[1]);
            return (body.entry || []).some(e =>
              (e.changes || []).some(c =>
                c.field === 'account_update' &&
                c.value?.event === 'PARTNER_APP_INSTALLED' &&
                String(c.value?.waba_info?.waba_id) === String(waba_id)
              )
            );
          } catch { return false; }
        });
        if (verified) break;
      }
      if (!verified) {
        logError('es-connect', {
          message: `no_webhook_event business_id=${business_id} waba_id=${waba_id} rows_checked=${rowsChecked} — no PARTNER_APP_INSTALLED row with matching waba_id in last 60min`,
          stack: '',
        });
        return res.status(403).json({
          error: 'No se recibió confirmación de Meta de que la app fue instalada en esta WABA. Esperá unos segundos e intentá de nuevo.',
          error_code: 'partner_app_not_confirmed',
        });
      }
      // Sin code: accessToken queda null → metaFetch usa META_SYSTEM_TOKEN automáticamente
    }

    // Verificar que phone_number_id pertenece a la WABA y no está asignado a otro negocio
    const pnListRes  = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(waba_id)}/phone_numbers`, {
      headers: { 'Authorization': `Bearer ${process.env.META_SYSTEM_TOKEN}` },
    });
    const pnListData = await pnListRes.json();
    if (!pnListRes.ok) {
      logError('es-connect', {
        message: `phone_numbers_fetch_failed business_id=${business_id} waba_id=${waba_id} status=${pnListRes.status}`,
        stack: '',
      });
      return res.status(502).json({ error: 'No se pudo verificar el número en Meta.', detail: pnListData });
    }
    const knownPnIds = (pnListData.data || []).map(p => String(p.id));
    if (!knownPnIds.includes(String(phone_number_id))) {
      logError('es-connect', {
        message: `phone_number_id_not_in_waba business_id=${business_id} waba_id=${waba_id} pnid_last4=${String(phone_number_id).slice(-4)} available_count=${knownPnIds.length}`,
        stack: '',
      });
      return res.status(403).json({ error: 'El número no pertenece a esta WABA.' });
    }
    const pnOwner = getBusinessByPhoneNumberId(phone_number_id);
    if (pnOwner && pnOwner.id !== Number(business_id)) {
      logError('es-connect', {
        message: `phone_number_id_taken business_id=${business_id} phone_number_id_last4=${String(phone_number_id).slice(-4)} owned_by=${pnOwner.id}`,
        stack: '',
      });
      return res.status(403).json({ error: 'Este número ya está asociado a otro negocio.' });
    }

    const subToken = accessToken || process.env.META_SYSTEM_TOKEN;
    const subRes   = await fetch(`https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${subToken}` },
    });
    const subData = await subRes.json();

    if (!subRes.ok) {
      logError('whatsapp-sub-failed', {
        message: `business_id=${business_id} waba_id=${waba_id} status=${subRes.status} detail=${JSON.stringify(subData).slice(0, 200)}`,
        stack: '',
      });
    }

    saveWabaCredentials(Number(business_id), {
      wabaId:        waba_id,
      phoneNumberId: phone_number_id,
      accessToken,   // null en flujo sin code → metaFetch usa META_SYSTEM_TOKEN
      provider:      'meta',
    });

    const savedBusiness = getBusinessById(Number(business_id));
    if (savedBusiness) notifyAdmin('wa_connected', { businessName: savedBusiness.name, phoneNumber: phone_number_id, provider: 'meta', source: 'callback' }).catch(() => {});

    logError('es-connect', {
      message: `ok business_id=${business_id} waba_id=${waba_id} phone_number_id_last4=${String(phone_number_id).slice(-4)} had_code=${!!code} sub_ok=${subRes.ok}`,
      stack: '',
    });
    res.json({ ok: true, waba_id, phone_number_id, subscribed: subRes.ok });
  } catch (err) {
    logError('es-connect', { message: `exception business_id=${business_id} err=${err.message}`, stack: '' });
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Kapso onboarding — connect WhatsApp in one click
// POST /api/whatsapp/connect
app.post('/api/whatsapp/connect', requireAuth, async (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  if (!business) return res.status(400).json({ error: 'Negocio no encontrado' });

  if (business.phone_number_id) {
    return res.status(409).json({ error: 'ya_conectado', message: 'Tu WhatsApp ya figura conectado. Si querés cambiar de número, escribinos al 092 052 508.' });
  }

  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'KAPSO_API_KEY no configurada' });

  try {
    let kapsoCustomerId = business.kapso_customer_id;

    if (!kapsoCustomerId) {
      const createRes = await fetch('https://api.kapso.ai/platform/v1/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ customer: { name: business.name, external_customer_id: String(business.id) } }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) {
        logError('kapso-onboarding-created', { message: `HTTP ${createRes.status}: ${JSON.stringify(createData)}`, stack: '' });
        return res.status(502).json({ error: 'No se pudo crear el cliente en Kapso', detail: createData });
      }
      kapsoCustomerId = createData?.data?.id || createData?.id;
      if (!kapsoCustomerId) {
        logError('kapso-onboarding-created', { message: `id missing in response: ${JSON.stringify(createData)}`, stack: '' });
        return res.status(502).json({ error: 'Kapso no devolvió un id de cliente', detail: createData });
      }
      setKapsoCustomerId(business.id, kapsoCustomerId);
      setKapsoConnectStartedAt(business.id);
      logError('kapso-onboarding-created', { message: `business_id=${business.id} kapso_customer_id=${kapsoCustomerId}`, stack: '' });
    }

    const linkRes = await fetch(`https://api.kapso.ai/platform/v1/customers/${kapsoCustomerId}/setup_links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({
        setup_link: {
          language: 'es',
          allowed_connection_types: ['coexistence'],
          meta_billing_mode: 'customer_managed',
          success_redirect_url: 'https://daxos.lat/dashboard?wa=ok',
          failure_redirect_url: `${process.env.APP_URL || 'https://daxos.lat'}/ayuda/conectar-whatsapp?desde=kapso`,
        },
      }),
    });
    const linkData = await linkRes.json();
    if (!linkRes.ok) {
      logError('kapso-onboarding-link', { message: `HTTP ${linkRes.status}: ${JSON.stringify(linkData)}`, stack: '' });
      return res.status(502).json({ error: 'No se pudo generar el link de configuración', detail: linkData });
    }

    // Log full response once so we can verify id/url field names with a real call
    logError('kapso-onboarding-link', { message: `full_response=${JSON.stringify(linkData)}`, stack: '' });

    const url          = linkData?.data?.url  || linkData?.url;
    const setupLinkId  = linkData?.data?.id   || linkData?.id;

    if (!url) {
      logError('kapso-onboarding-link', { message: `url missing in response: ${JSON.stringify(linkData)}`, stack: '' });
      return res.status(502).json({ error: 'Kapso no devolvió una URL', detail: linkData });
    }

    if (setupLinkId) setKapsoSetupLinkId(business.id, String(setupLinkId));

    logError('kapso-onboarding-link', {
      message: `business_id=${business.id} kapso_customer_id=${kapsoCustomerId} setup_link_id=${setupLinkId ?? 'NOT_FOUND'} url_ok=true`,
      stack: '',
    });
    res.json({ url });
  } catch (err) {
    logError('kapso-onboarding-link', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Kapso onboarding — save credentials from Kapso redirect params
// POST /api/whatsapp/save-kapso-redirect
app.post('/api/whatsapp/save-kapso-redirect', requireAuth, async (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  if (!business) return res.status(400).json({ error: 'Negocio no encontrado' });

  // Log full body before processing — lets us verify exact field names Kapso sends
  // Kapso docs say redirect includes: phone_number_id, business_account_id, provisioned_phone_number_id, etc.
  logError('kapso-onboarding-redirect', {
    message: `incoming body=${JSON.stringify(req.body)} business_id=${business.id}`,
    stack: '',
  });

  if (!business.kapso_customer_id) {
    logError('kapso-onboarding-redirect', { message: `business_id=${business.id} has no kapso_customer_id — cannot confirm via API, falling back to polling`, stack: '' });
    return res.json({ ok: false, polling: true });
  }

  // Confirm via Kapso API — do not trust URL params alone
  const confirmed = await confirmKapsoPhoneNumber(business.kapso_customer_id);
  if (!confirmed) {
    logError('kapso-onboarding-redirect', {
      message: `API did not confirm phone_number for customer_id=${business.kapso_customer_id} business_id=${business.id} — falling back to polling`,
      stack: '',
    });
    return res.json({ ok: false, polling: true });
  }

  saveWabaCredentials(business.id, {
    wabaId:        confirmed.wabaId,
    phoneNumberId: confirmed.phoneNumberId,
    accessToken:   null,
    provider:      'kapso',
  });

  logError('kapso-onboarding-redirect', {
    message: `saved business_id=${business.id} phone_number_id=${confirmed.phoneNumberId} display=${confirmed.displayPhoneNumber} provider=kapso`,
    stack: '',
  });

  ensureKapsoWebhook(confirmed.phoneNumberId);
  notifyAdmin('wa_connected', { businessName: business.name, phoneNumber: confirmed.displayPhoneNumber || confirmed.phoneNumberId, provider: 'kapso', source: 'redirect' }).catch(() => {});
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Kapso onboarding — poll setup link status after redirect
// GET /api/whatsapp/status
app.get('/api/whatsapp/status', requireAuth, async (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  if (!business) return res.status(400).json({ error: 'Negocio no encontrado' });

  // Already connected (any provider)
  if (business.phone_number_id) {
    return res.json({ connected: true });
  }

  const { kapso_customer_id: kapsoCustomerId, kapso_setup_link_id: setupLinkId } = business;
  if (!kapsoCustomerId) {
    return res.json({ connected: false, reason: 'no_kapso' });
  }

  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'KAPSO_API_KEY no configurada' });

  try {
    // Try setup link if we have one (Kapso rarely populates phone_number_id here, but check anyway)
    if (setupLinkId) {
      let linkData = null;

      const singleRes = await fetch(
        `https://api.kapso.ai/platform/v1/customers/${kapsoCustomerId}/setup_links/${setupLinkId}`,
        { headers: { 'X-API-Key': apiKey } },
      );

      if (singleRes.ok) {
        const raw = await singleRes.json();
        logError('kapso-onboarding-status', { message: `single_response=${JSON.stringify(raw)}`, stack: '' });
        linkData = raw?.data || raw;
      } else {
        const listRes = await fetch(
          `https://api.kapso.ai/platform/v1/customers/${kapsoCustomerId}/setup_links`,
          { headers: { 'X-API-Key': apiKey } },
        );
        if (listRes.ok) {
          const listRaw = await listRes.json();
          logError('kapso-onboarding-status', { message: `list_response=${JSON.stringify(listRaw)}`, stack: '' });
          const items = listRaw?.data || listRaw;
          const arr   = Array.isArray(items) ? items : [];
          linkData = arr.find(l => String(l.id) === String(setupLinkId)) || arr[0] || null;
        }
      }

      if (linkData) {
        const rawStatus     = linkData.status;
        const phoneNumberId = linkData.phone_number_id || linkData.phoneNumberId;
        const wabaId        = linkData.waba_id         || linkData.wabaId;

        logError('kapso-onboarding-status', {
          message: `setup_link raw_status=${JSON.stringify(rawStatus)} all_keys=${JSON.stringify(Object.keys(linkData))} phone_number_id=${phoneNumberId} waba_id=${wabaId}`,
          stack: '',
        });

        if (phoneNumberId) {
          saveWabaCredentials(business.id, {
            wabaId:        wabaId || null,
            phoneNumberId: String(phoneNumberId),
            accessToken:   null,
            provider:      'kapso',
          });
          logError('kapso-onboarding-status', {
            message: `saved via setup_link business_id=${business.id} phone_number_id=${phoneNumberId} provider=kapso`,
            stack: '',
          });
          ensureKapsoWebhook(String(phoneNumberId));
                notifyAdmin('wa_connected', { businessName: business.name, phoneNumber: String(phoneNumberId), provider: 'kapso', source: 'polling_setup_link' }).catch(() => {});
          return res.json({ connected: true });
        }
      } else {
        logError('kapso-onboarding-status', { message: `setup_link not found customer=${kapsoCustomerId} link=${setupLinkId}`, stack: '' });
      }
    }

    // Setup link had no phone_number_id (or no setup link) — confirm via phone_numbers API
    const confirmed = await confirmKapsoPhoneNumber(kapsoCustomerId);
    if (confirmed) {
      saveWabaCredentials(business.id, {
        wabaId:        confirmed.wabaId || null,
        phoneNumberId: confirmed.phoneNumberId,
        accessToken:   null,
        provider:      'kapso',
      });
      logError('kapso-onboarding-status', {
        message: `confirmed via API business_id=${business.id} phone_number_id=${confirmed.phoneNumberId} provider=kapso`,
        stack: '',
      });
      ensureKapsoWebhook(confirmed.phoneNumberId);
        notifyAdmin('wa_connected', { businessName: business.name, phoneNumber: confirmed.displayPhoneNumber || confirmed.phoneNumberId, provider: 'kapso', source: 'polling_confirm' }).catch(() => {});
      return res.json({ connected: true });
    }

    res.json({ connected: false, reason: 'not_ready' });
  } catch (err) {
    logError('kapso-onboarding-status', err);
    res.status(500).json({ error: err.message });
  }
});

// Kapso onboarding — ensure message webhook exists for the connected number
// GET /api/whatsapp/ensure-webhook
// Called from the dashboard on panel load for Kapso-connected businesses.
app.get('/api/whatsapp/ensure-webhook', requireAuth, async (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  if (!business) return res.status(400).json({ error: 'Negocio no encontrado' });
  if (!business.phone_number_id || business.wa_provider !== 'kapso') {
    return res.json({ ok: false, reason: 'not_kapso' });
  }
  await ensureKapsoWebhook(business.phone_number_id);
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────

// Booking timeout job — resolves business credentials for a given businessId
async function getBookingCredentials(businessId) {
  const business = getBusinessById(businessId);
  const owner = business ? getUserByBusinessId(businessId) : null;
  const waCredentials = business?.phone_number_id
    ? { phoneNumberId: business.phone_number_id, accessToken: business.wa_access_token, provider: business.wa_provider || 'meta' }
    : null;
  return { business, owner, waCredentials };
}

function resumeHumanTimedOut() {
  const convs = getConversationsNeedingHumanResume();
  if (!convs.length) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const mvd    = getMvdDate();
  const nowMin = mvd.getUTCHours() * 60 + mvd.getUTCMinutes(); // minutes since midnight in Montevideo
  let resumed  = 0;

  for (const conv of convs) {
    const timeout = typeof conv.human_resume_timeout === 'number' ? conv.human_resume_timeout : 7200;
    const timeoutExpired = nowSec - conv.human_paused_at >= timeout;

    let outsideHours = false;
    if (conv.business_hours_start && conv.business_hours_end) {
      const [sh, sm] = conv.business_hours_start.split(':').map(Number);
      const [eh, em] = conv.business_hours_end.split(':').map(Number);
      outsideHours = nowMin < sh * 60 + sm || nowMin >= eh * 60 + em;
    }

    if (timeoutExpired || outsideHours) {
      clearHumanPause(conv.id);
      resumed++;
    }
  }

  if (resumed > 0) console.log(`[human-resume-job] resumed=${resumed} conversations after timeout/hours`);
}

// Run once at startup (catches any expired bookings from before last restart),
// then every 30 minutes.
checkBookingTimeouts({ getCredentialsForBusiness: getBookingCredentials })
  .catch(err => console.error('[booking-timeout-startup]', err.message));

resumeHumanTimedOut();

let _lastWeeklySummaryDate = null;
let _lastTrialCheckDate    = null;

// dryRun=true (default via TRIAL_CHECK_DRY_RUN env): only logs what it would do, no DB writes or sends.
// Set TRIAL_CHECK_DRY_RUN=0 in env to enable real sends.
async function runDailyTrialCheck(overrideDryRun) {
  const dryRun = overrideDryRun !== undefined ? overrideDryRun : process.env.TRIAL_CHECK_DRY_RUN !== '0';
  const businesses = getTrialBusinesses();
  for (const biz of businesses) {
    if (!biz.owner_email) continue; // no owner contact — nothing to notify
    try {
      const now      = Date.now();
      const nowIso   = new Date(now).toISOString();
      const todayUY  = toUYDateStr(now);
      const lastNotMs  = parseSqliteUtc(biz.trial_grace_notified_at);
      const canMail    = !lastNotMs || toUYDateStr(lastNotMs) !== todayUY;
      const convCount  = getTrialConversationCount(biz.id, biz.trial_starts_at);
      const daysElapsed = trialDaysElapsed(biz.trial_starts_at);

      let state  = 'ok';
      let action = 'none';

      if (biz.trial_grace_started_at) {
        const graceStartMs   = parseSqliteUtc(biz.trial_grace_started_at);
        const graceHours     = (now - graceStartMs) / 3_600_000;
        const graceConvs     = getTrialConversationCount(biz.id, biz.trial_grace_started_at);
        const graceConvsLeft = Math.max(0, TRIAL_GRACE_CONVS - graceConvs);
        const graceHoursLeft = Math.max(0, TRIAL_GRACE_HOURS - graceHours);

        if (graceHours > TRIAL_GRACE_HOURS || graceConvs >= TRIAL_GRACE_CONVS) {
          state  = 'grace-ended';
          action = 'sendTrialEndedEmail';
          if (!dryRun && canMail) {
            setTrialGraceNotifiedAt(biz.id, nowIso);
            sendTrialEndedEmail({ to: biz.owner_email, businessName: biz.name })
              .catch(e => logError('trial-ended-daily', { message: e.message, stack: '' }));
            console.log(`[trial-daily] business ${biz.id} grace ended — owner notified`);
          }
        } else {
          state  = 'grace-active';
          action = `sendTrialGraceEmail(${graceHoursLeft.toFixed(0)}h/${graceConvsLeft}convs)`;
          if (!dryRun && canMail) {
            setTrialGraceNotifiedAt(biz.id, nowIso);
            sendTrialGraceEmail({ to: biz.owner_email, businessName: biz.name, graceConvsLeft, graceHoursLeft })
              .catch(e => logError('trial-grace-daily', { message: e.message, stack: '' }));
            console.log(`[trial-daily] business ${biz.id} in grace, ${graceHoursLeft.toFixed(0)}h / ${graceConvsLeft} convs left — owner reminded`);
          }
        }
      } else {
        const trialEndsMs  = parseSqliteUtc(biz.trial_ends_at);
        const hitConvLimit = convCount >= TRIAL_CONV_LIMIT;
        const hitDayLimit  = trialEndsMs && trialEndsMs < now;

        if (hitConvLimit || hitDayLimit) {
          const expiredHoursAgo = trialEndsMs ? (now - trialEndsMs) / 3_600_000 : 0;
          if (expiredHoursAgo > TRIAL_GRACE_HOURS) {
            state  = 'trial-ended-direct';
            action = 'sendTrialEndedEmail';
            if (!dryRun && canMail) {
              setTrialGraceNotifiedAt(biz.id, nowIso);
              sendTrialEndedEmail({ to: biz.owner_email, businessName: biz.name })
                .catch(e => logError('trial-ended-daily', { message: e.message, stack: '' }));
              console.log(`[trial-daily] business ${biz.id} trial ended, no grace (${expiredHoursAgo.toFixed(0)}h) — owner notified`);
            }
          } else {
            state  = 'grace-open';
            action = 'setTrialGrace+sendTrialGraceEmail';
            if (!dryRun) {
              setTrialGraceStartedAt(biz.id, nowIso);
              if (canMail) {
                setTrialGraceNotifiedAt(biz.id, nowIso);
                sendTrialGraceEmail({ to: biz.owner_email, businessName: biz.name, graceConvsLeft: TRIAL_GRACE_CONVS, graceHoursLeft: TRIAL_GRACE_HOURS })
                  .catch(e => logError('trial-grace-daily', { message: e.message, stack: '' }));
                console.log(`[trial-daily] business ${biz.id} grace opened — owner notified`);
              }
            }
          }
        } else if (!biz.trial_warned_at && (convCount >= TRIAL_WARN_CONVS || daysElapsed >= TRIAL_WARN_DAYS)) {
          state  = 'warning';
          action = `sendTrialWarningEmail(day=${daysElapsed},convs=${convCount})`;
          if (!dryRun) {
            setTrialWarnedAt(biz.id, nowIso);
            if (canMail) {
              setTrialGraceNotifiedAt(biz.id, nowIso);
              sendTrialWarningEmail({ to: biz.owner_email, businessName: biz.name, convCount, convLimit: TRIAL_CONV_LIMIT, dayNum: daysElapsed, dayLimit: 14 })
                .catch(e => logError('trial-warning-daily', { message: e.message, stack: '' }));
              console.log(`[trial-daily] business ${biz.id} trial warning (day ${daysElapsed}, ${convCount} convs) — owner notified`);
            }
          }
        }
      }

      if (dryRun) {
        console.log(`[trial-daily-dry] biz=${biz.id} email=${biz.owner_email} state=${state} would-send=${action}`);
      }
    } catch (err) {
      logError('trial-daily-biz', { message: `biz ${biz.id}: ${err.message}`, stack: err.stack || '' });
    }
  }
}

async function runKeywordPauseFollowupJobs() {
  const base = process.env.APP_URL || 'https://daxos.lat';
  for (const conv of getKeywordPausedNeedingFollowup()) {
    try {
      const convUrl = `${base}/conversations.html?conv=${conv.id}`;
      await sendPauseFollowupEmail({ to: conv.owner_email, businessName: conv.business_name, conversationId: conv.id, customerPhone: conv.customer_id, convUrl });
      setPauseFollowupSent(conv.id);
    } catch (err) {
      logError('pause-notify-error', { message: `followup conv ${conv.id}: ${err.message}`, stack: '' });
    }
  }
  for (const conv of getKeywordPausedNeeding24h()) {
    try {
      const convUrl = `${base}/conversations.html?conv=${conv.id}`;
      await sendPause24hReminderEmail({ to: conv.owner_email, businessName: conv.business_name, conversationId: conv.id, customerPhone: conv.customer_id, convUrl });
      setPause24hSent(conv.id);
    } catch (err) {
      logError('pause-notify-error', { message: `24h conv ${conv.id}: ${err.message}`, stack: '' });
    }
  }
}

async function runWaSilenceCheck() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const silenceHours = parseFloat(process.env.WA_SILENCE_HOURS || '6');
  const thresholdSec = Math.round(silenceHours * 3600);
  const nowSec = Math.floor(Date.now() / 1000);

  // Only run between 9:00 and 23:00 UY (UTC-3, no DST)
  const mvd = getMvdDate();
  const nowMin = mvd.getUTCHours() * 60 + mvd.getUTCMinutes();
  if (nowMin < 9 * 60 || nowMin >= 23 * 60) {
    logError('wa-silence-check', { message: `skip — outside window nowMin=${nowMin}`, stack: '' });
    return;
  }

  const businesses = getConnectedBusinesses();
  let alerted = 0, recovered = 0, ok = 0;

  for (const biz of businesses) {
    const lastMsg = getLastCustomerMessage(biz.id); // { customer_id, content, msg_at } | null

    // Baseline: last incoming message, or wa_connected_at if no messages yet
    let baselineSec = lastMsg ? lastMsg.msg_at : null;
    if (!baselineSec && biz.wa_connected_at) {
      const connMs = parseSqliteUtc(biz.wa_connected_at);
      baselineSec = connMs ? Math.floor(connMs / 1000) : null;
    }

    const isSilent = !baselineSec || (nowSec - baselineSec >= thresholdSec);

    if (isSilent && !biz.wa_silence_alerted_at) {
      const lastMsgAt = lastMsg ? new Date(lastMsg.msg_at * 1000).toISOString() : null;
      await sendWaSilenceAlertEmail({
        adminEmail,
        businessName: biz.name,
        phoneNumber:  biz.whatsapp_number || biz.phone_number_id,
        lastMessageAt: lastMsgAt,
        silenceHours,
      }).catch(err => logError('wa-silence-alert', { message: `email failed biz=${biz.id}: ${err.message}`, stack: '' }));
      setWaSilenceAlertedAt(biz.id, nowSec);
      logError('wa-silence-check', { message: `alerted biz=${biz.id} name="${biz.name}" last_msg_epoch=${lastMsg?.msg_at ?? 'never'} threshold_h=${silenceHours}`, stack: '' });
      alerted++;
    } else if (!isSilent && biz.wa_silence_alerted_at) {
      const lastMsgAt = lastMsg ? new Date(lastMsg.msg_at * 1000).toISOString() : null;
      await sendWaSilenceRecoveryEmail({
        adminEmail,
        businessName: biz.name,
        phoneNumber:  biz.whatsapp_number || biz.phone_number_id,
        lastMessageAt: lastMsgAt,
      }).catch(err => logError('wa-silence-alert', { message: `recovery email failed biz=${biz.id}: ${err.message}`, stack: '' }));
      clearWaSilenceAlertedAt(biz.id);
      logError('wa-silence-check', { message: `recovered biz=${biz.id} name="${biz.name}" last_msg_epoch=${lastMsg?.msg_at}`, stack: '' });
      recovered++;
    } else {
      ok++;
    }
  }

  logError('wa-silence-check', {
    message: `cycle done businesses=${businesses.length} alerted=${alerted} recovered=${recovered} ok=${ok} window_min=${nowMin}`,
    stack: '',
  });
}

// In-memory state per phone_number_id / business id (resets on restart — acceptable)
const _waHealthRetryAfter   = new Map(); // pnid → epoch sec when ok to query again
const _waHealthLastChecked  = new Map(); // pnid → epoch sec of last actual request (3-min Kapso cache)
const _waHealthConsecutive  = new Map(); // bizId → consecutive unhealthy count

async function runWaHealthCheck({ dryRun = (process.env.WA_HEALTH_ALERTS !== 'on') } = {}) {
  const adminEmail = process.env.ADMIN_EMAIL;
  const apiKey     = process.env.KAPSO_API_KEY;
  if (!adminEmail || !apiKey) return [];

  const businesses = getConnectedBusinesses().filter(b => b.id !== 1);
  const nowSec = Math.floor(Date.now() / 1000);
  const results = [];

  for (const biz of businesses) {
    const pnid = biz.phone_number_id;
    const entry = {
      id: biz.id, name: biz.name, phone_number_id: pnid,
      status: null, consecutiveUnhealthy: _waHealthConsecutive.get(biz.id) || 0,
      wouldAlert: false, skippedReason: null,
    };

    // Respect retry_after from rate-limiting
    const retryAfterSec = _waHealthRetryAfter.get(pnid);
    if (retryAfterSec && nowSec < retryAfterSec) {
      logError('wa-health-check', { message: `skip biz=${biz.id} pnid=${pnid} retry_after=${retryAfterSec - nowSec}s remaining`, stack: '' });
      entry.skippedReason = 'retry_after';
      results.push(entry);
      continue;
    }

    // Respect 3-minute Kapso cache
    const lastCheckedSec = _waHealthLastChecked.get(pnid);
    if (lastCheckedSec && (nowSec - lastCheckedSec) < 180) {
      logError('wa-health-check', { message: `skip biz=${biz.id} pnid=${pnid} kapso-cache age=${nowSec - lastCheckedSec}s`, stack: '' });
      entry.skippedReason = 'cache';
      results.push(entry);
      continue;
    }

    let data;
    try {
      const res = await fetch(
        `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${pnid}/health`,
        { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10000) }
      );
      _waHealthLastChecked.set(pnid, nowSec);

      const retryHeader = res.headers.get('retry-after');
      if (retryHeader || res.status === 429) {
        const retrySec = retryHeader ? parseInt(retryHeader, 10) : 60;
        _waHealthRetryAfter.set(pnid, nowSec + (isNaN(retrySec) ? 60 : retrySec));
        logError('wa-health-check', { message: `rate-limited biz=${biz.id} pnid=${pnid} retry_after=${retrySec}s`, stack: '' });
        entry.skippedReason = 'rate_limited';
        results.push(entry);
        continue;
      }

      const raw = await res.text();
      try {
        data = JSON.parse(raw);
      } catch {
        logError('wa-health-check', { message: `non-JSON biz=${biz.id} pnid=${pnid} http=${res.status} body=${raw.slice(0, 200)}`, stack: '' });
        entry.skippedReason = 'non_json';
        results.push(entry);
        continue;
      }
    } catch (err) {
      logError('wa-health-check', { message: `network error biz=${biz.id} pnid=${pnid}: ${err.message}`, stack: '' });
      entry.skippedReason = 'network_error';
      results.push(entry);
      continue;
    }

    // Respect retry_after embedded in body
    const bodyRetry = data?.retry_after ?? data?.data?.retry_after;
    if (bodyRetry) {
      const retrySec = typeof bodyRetry === 'number' ? bodyRetry : parseInt(bodyRetry, 10);
      if (!isNaN(retrySec) && retrySec > 0) _waHealthRetryAfter.set(pnid, nowSec + retrySec);
    }

    const status     = data?.data?.status     ?? data?.status;
    const components = data?.data?.components ?? data?.components ?? {};
    const isUnhealthy = status === 'unhealthy';

    if (isUnhealthy) {
      const prev = _waHealthConsecutive.get(biz.id) || 0;
      _waHealthConsecutive.set(biz.id, prev + 1);
      logError('wa-health-check', { message: `checked biz=${biz.id} pnid=${pnid} status=${status} consecutive=${prev + 1} components=${JSON.stringify(components)}`, stack: '' });
    } else {
      _waHealthConsecutive.set(biz.id, 0);
      logError('wa-health-check', { message: `checked biz=${biz.id} pnid=${pnid} status=${status} components=${JSON.stringify(components)}`, stack: '' });
    }

    const consecutiveUnhealthy = _waHealthConsecutive.get(biz.id) || 0;
    entry.status = status ?? null;
    entry.consecutiveUnhealthy = consecutiveUnhealthy;
    entry.wouldAlert = isUnhealthy && consecutiveUnhealthy >= 2 && !biz.wa_health_alerted_at;

    if (isUnhealthy && consecutiveUnhealthy >= 2 && !biz.wa_health_alerted_at) {
      if (dryRun) {
        logError('wa-health-check', { message: `dry-run: would alert biz=${biz.id} name="${biz.name}" consecutive=${consecutiveUnhealthy}`, stack: '' });
      } else {
        const owner    = getUserByBusinessId(biz.id);
        const ownerEmail = owner?.email || null;
        await sendWaHealthAlertEmail({ adminEmail, ownerEmail, businessName: biz.name, phoneNumber: biz.whatsapp_number || pnid, status, components })
          .catch(err => logError('wa-health-alert', { message: `email failed biz=${biz.id}: ${err.message}`, stack: '' }));

        // WA notification to owner best-effort (24h rule: only if owner !== biz phone)
        if (owner?.phone) {
          const bizFull    = getBusinessById(biz.id);
          const waCredentials = bizFull?.wa_access_token
            ? { phoneNumberId: pnid, accessToken: bizFull.wa_access_token, wabaId: bizFull.waba_id, provider: bizFull.wa_provider || 'meta' }
            : null;
          const normOwner  = normalizeUruguayPhone(owner.phone);
          const normBiz    = normalizeUruguayPhone(biz.whatsapp_number);
          if (normOwner && waCredentials && normOwner !== normBiz) {
            const waMsg = bizFull?.wa_provider === 'kapso'
              ? `⚠️ Tu WhatsApp de ${biz.name} está desconectado. Entrá a Kapso y reconectá el número para que el bot vuelva a funcionar.`
              : `⚠️ Tu WhatsApp de ${biz.name} está desconectado. Entrá al panel de Daxos y reconectá el número para que el bot vuelva a funcionar.`;
            sendWhatsAppMessage(normOwner, waMsg, waCredentials)
              .catch(err => logError('wa-health-alert', { message: `wa notify failed biz=${biz.id}: ${err.message}`, stack: '' }));
          }
        }

        setWaHealthAlertedAt(biz.id, nowSec);
        logError('wa-health-check', { message: `alerted biz=${biz.id} name="${biz.name}" consecutive=${consecutiveUnhealthy}`, stack: '' });
      }
    } else if (!isUnhealthy && biz.wa_health_alerted_at) {
      if (dryRun) {
        logError('wa-health-check', { message: `dry-run: would send recovery biz=${biz.id} name="${biz.name}"`, stack: '' });
      } else {
        const owner      = getUserByBusinessId(biz.id);
        const ownerEmail = owner?.email || null;
        await sendWaHealthRecoveryEmail({ adminEmail, ownerEmail, businessName: biz.name, phoneNumber: biz.whatsapp_number || pnid })
          .catch(err => logError('wa-health-alert', { message: `recovery email failed biz=${biz.id}: ${err.message}`, stack: '' }));
        clearWaHealthAlertedAt(biz.id);
        logError('wa-health-check', { message: `recovered biz=${biz.id} name="${biz.name}"`, stack: '' });
      }
    }

    results.push(entry);
  }

  logError('wa-health-check', { message: `cycle done businesses=${businesses.length} dryRun=${dryRun}`, stack: '' });
  return results;
}

// Human-pause timeout check — every 5 minutes
setInterval(resumeHumanTimedOut, 5 * 60 * 1000);
setInterval(() => {
  runKeywordPauseFollowupJobs().catch(err => logError('pause-followup-job', { message: err.message, stack: '' }));
}, 5 * 60 * 1000);
setInterval(() => {
  runWaSilenceCheck().catch(err => logError('wa-silence-check', { message: `job error: ${err.message}`, stack: '' }));
}, 30 * 60 * 1000);
setInterval(() => {
  runWaHealthCheck().catch(err => logError('wa-health-check', { message: `job error: ${err.message}`, stack: '' }));
}, 10 * 60 * 1000);

setInterval(() => {
  checkBookingTimeouts({ getCredentialsForBusiness: getBookingCredentials })
    .catch(err => console.error('[booking-timeout-job]', err.message));

  const resumed = autoResumeExpiredConversations();
  if (resumed > 0) console.log(`[auto-resume-job] reactivated=${resumed} conversations after 24h pause`);

  // Alert admin on incomplete Kapso connections after 30 minutes (DB-backed, survives restarts)
  for (const biz of getBusinessesWithIncompleteKapso()) {
    setKapsoIncompleteAlertedAt(biz.id);
    notifyAdmin('incomplete_connection', { businessName: biz.name, businessId: biz.id, startedAt: biz.kapso_connect_started_at }).catch(() => {});
  }

  // Purge processed_messages older than 7 days
  purgeOldProcessedMessages();

  // Daily backup at 04:xx Uruguay time — source of truth is R2, not memory
  maybeScheduledBackup().catch(err => logError('backup-schedule', err));
  // Silence alert at 08:00-08:29 Uruguay time — only if no backup in last 30h
  maybeSilenceAlert().catch(err => logError('backup-silence-check', err));

  // Send weekly summary once per week. Fires Monday 09:00-09:30 Uruguay time (UTC-3 year-round).
  const now = new Date();
  const uyHour = (now.getUTCHours() - 3 + 24) % 24;
  const uyDay  = new Date(now.getTime() - 3 * 60 * 60 * 1000).getUTCDay();
  const todayStr = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Daily stale-message summary at 08:00-08:29 Uruguay time
  if (uyHour === 8 && _staleMsgDate && _staleMsgDate !== todayStr) {
    logError('msg-stale-summary', {
      message: `date=${_staleMsgDate} ignored=${_staleMsgCount}`,
      stack: '',
    });
    _staleMsgCount = 0;
    _staleMsgDate  = null;
  }

  if (uyDay === 1 && uyHour === 9 && _lastWeeklySummaryDate !== todayStr) {
    _lastWeeklySummaryDate = todayStr;
    sendWeeklySummaries().catch(err => console.error('[weekly-summary-job]', err.message));
  }

  // Daily trial state check at 09:00 Uruguay time — independent of incoming messages
  if (uyHour === 9 && _lastTrialCheckDate !== todayStr) {
    _lastTrialCheckDate = todayStr;
    runDailyTrialCheck().catch(err => logError('trial-daily-check', { message: err.message, stack: err.stack || '' }));
  }
}, 30 * 60 * 1000);

// Demo follow-up scheduler — every 10 minutes
setInterval(() => {
  if (process.env.DEMO_FLOW_ENABLED !== '1') return;
  const daxosBiz = getAllBusinesses().find(b => b.phone_number_id === process.env.DAXOS_PHONE_NUMBER_ID);
  if (!daxosBiz) return;
  getBookingCredentials(daxosBiz.id).then(creds => {
    if (!creds) return;
    return processFollowups(creds);
  }).catch(err => logError('demo-followup-job', { message: err.message, stack: err.stack || '' }));
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const ckResult = checkpoint();
  console.log('WAL checkpoint on startup:', JSON.stringify(ckResult));
  setTimeout(() => startupBackupCheck().catch(err => logError('backup-startup', err)), 15_000);
  purgeOldErrorLog();
  setInterval(() => purgeOldErrorLog(), 24 * 60 * 60 * 1000);
});

// ─── Backup endpoints ─────────────────────────────────────────────────────────

function requireBearerToken(req, res, next) {
  const secret = process.env.ADMIN_SET_WA_TOKEN;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SET_WA_TOKEN no configurado' });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(403).json({ error: 'Token inválido' });
  next();
}

app.post('/admin/api/run-trial-check', requireBearerToken, async (req, res) => {
  try {
    const overrideDryRun = req.query.dry_run !== undefined ? req.query.dry_run !== '0' : undefined;
    await runDailyTrialCheck(overrideDryRun);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/api/run-pause-jobs', requireBearerToken, async (req, res) => {
  try { await runKeywordPauseFollowupJobs(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/run-silence-check', requireBearerToken, async (_req, res) => {
  try {
    const businesses = getConnectedBusinesses();
    await runWaSilenceCheck();
    const after = getConnectedBusinesses();
    const summary = after.map(b => ({
      id: b.id,
      name: b.name,
      phone_number_id: b.phone_number_id,
      wa_silence_alerted_at: b.wa_silence_alerted_at,
      last_msg: getLastCustomerMessage(b.id)?.msg_at ?? null,
    }));
    res.json({ ok: true, checked: businesses.length, businesses: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/run-health-check', requireBearerToken, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1' || (req.query.dryRun === undefined && process.env.WA_HEALTH_ALERTS !== 'on');
    const results = await runWaHealthCheck({ dryRun });
    res.json({ ok: true, dryRun, checked: results.length, businesses: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/run-auto-resume', requireBearerToken, (_req, res) => {
  const n = autoResumeExpiredConversations();
  res.json({ ok: true, resumed: n });
});

app.post('/admin/backup-now', requireBearerToken, async (req, res) => {
  try {
    const result = await runBackup();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/api/backup-now', requireAdmin, async (req, res) => {
  try {
    const result = await runBackup();
    res.json({ ok: true, ...result });
  } catch (err) {
    // Strip internal paths and R2 account ID before sending to browser
    const safe = (err.message || 'Error desconocido')
      .replace(/\/tmp\/\S+/g, '/tmp/...')
      .replace(/\/app\/\S+/g, '/app/...')
      .replace(new RegExp(process.env.R2_ACCOUNT_ID || '\x00', 'g'), '[R2_ACCOUNT]');
    res.status(500).json({ ok: false, error: safe });
  }
});

app.get('/admin/backups', requireBearerToken, async (req, res) => {
  try {
    const list = await listAllBackups();
    res.json(list.map(o => ({ name: o.Key, sizeBytes: o.Size, lastModified: o.LastModified })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/backup-status', requireAdmin, async (req, res) => {
  try {
    const latest = await getLatestBackupMeta();
    res.json(latest
      ? { name: latest.Key, sizeBytes: latest.Size, lastModified: latest.LastModified }
      : null
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/checkpoint', requireAdmin, (req, res) => {
  const result = checkpoint();
  res.json({ ok: true, result });
});

// ──────────────────────────────────────────────────────────────────────────────
// Rescue: query Kapso phone numbers and save credentials for any business
// that completed Kapso onboarding but never got its phone_number_id saved.
// GET /admin/api/kapso-rescue  — dry run (shows what would be fixed)
// POST /admin/api/kapso-rescue — applies the fix
app.all('/admin/api/kapso-rescue', requireAdmin, async (req, res) => {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'KAPSO_API_KEY no configurada' });

  try {
    const numbersRes = await fetch('https://api.kapso.ai/platform/v1/whatsapp/phone_numbers?per_page=100', {
      headers: { 'X-API-Key': apiKey },
    });
    if (!numbersRes.ok) {
      const body = await numbersRes.text();
      return res.status(502).json({ error: `Kapso responded ${numbersRes.status}`, body });
    }
    const numbersData = await numbersRes.json();
    const phoneNumbers = numbersData?.data || [];

    const results = [];
    for (const pn of phoneNumbers) {
      const { phone_number_id, business_account_id, customer_id, display_phone_number, status } = pn;
      if (!phone_number_id || !customer_id) {
        results.push({ phone_number_id, customer_id, status: 'skipped_no_ids' });
        continue;
      }

      const business = getBusinessByKapsoCustomerId(customer_id);
      if (!business) {
        results.push({ phone_number_id, customer_id, display_phone_number, status: 'no_business_match' });
        continue;
      }

      if (business.phone_number_id) {
        results.push({ phone_number_id, customer_id, business_id: business.id, display_phone_number, status: 'already_saved' });
        continue;
      }

      if (req.method === 'POST') {
        saveWabaCredentials(business.id, {
          wabaId:        business_account_id || null,
          phoneNumberId: String(phone_number_id),
          accessToken:   null,
          provider:      'kapso',
        });
        logError('kapso-rescue', {
          message: `rescued business_id=${business.id} phone_number_id=${phone_number_id} display=${display_phone_number}`,
          stack: '',
        });
        ensureKapsoWebhook(String(phone_number_id));
        results.push({ phone_number_id, customer_id, business_id: business.id, display_phone_number, status: 'rescued' });
      } else {
        results.push({ phone_number_id, customer_id, business_id: business.id, display_phone_number, status: 'would_rescue' });
      }
    }

    res.json({ dry_run: req.method === 'GET', total_kapso_numbers: phoneNumbers.length, results });
  } catch (err) {
    logError('kapso-rescue', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Meta WABA rescue — lista WABAs accesibles via META_SYSTEM_TOKEN (solo lectura)
// GET /admin/api/meta-wabas
app.get('/admin/api/meta-wabas', requireAdmin, async (req, res) => {
  const systemToken  = process.env.META_SYSTEM_TOKEN;
  const appId        = process.env.META_APP_ID;
  const portfolioId  = process.env.META_BUSINESS_PORTFOLIO_ID;
  if (!systemToken) return res.status(500).json({ error: 'META_SYSTEM_TOKEN no configurado' });

  const authHdr = { 'Authorization': `Bearer ${systemToken}` };

  async function fetchWabas(url) {
    const r = await fetch(url, { headers: authHdr });
    const d = await r.json();
    return { ok: r.ok, data: d?.data || [], raw: d };
  }

  async function phoneNumbersForWaba(wabaId) {
    try {
      const r = await fetch(
        `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status`,
        { headers: authHdr },
      );
      const d = await r.json();
      return r.ok ? (d.data || []).map(p => ({
        id: p.id, display_phone_number: p.display_phone_number,
        verified_name: p.verified_name, status: p.status,
      })) : [];
    } catch { return []; }
  }

  async function buildResult(wabas, source) {
    const rows = await Promise.all(wabas.map(async w => ({
      waba_id: w.id, waba_name: w.name,
      phone_numbers: await phoneNumbersForWaba(w.id),
    })));
    return { source, total: rows.length, wabas: rows };
  }

  try {
    // Plan A: app subscribed_businesses
    if (appId) {
      const a = await fetchWabas(`https://graph.facebook.com/v21.0/${appId}/subscribed_businesses?fields=id,name`);
      if (a.ok && a.data.length > 0) {
        return res.json(await buildResult(a.data, 'subscribed_businesses'));
      }
    }

    // Plan B: client + owned WABAs via Business Portfolio ID
    if (!portfolioId) {
      return res.status(500).json({
        error: 'subscribed_businesses devolvió vacío y META_BUSINESS_PORTFOLIO_ID no configurado — sin plan B',
        hint: 'Configurá META_BUSINESS_PORTFOLIO_ID en las variables de entorno.',
      });
    }

    const [clientRes, ownedRes] = await Promise.all([
      fetchWabas(`https://graph.facebook.com/v21.0/${portfolioId}/client_whatsapp_business_accounts?fields=id,name`),
      fetchWabas(`https://graph.facebook.com/v21.0/${portfolioId}/owned_whatsapp_business_accounts?fields=id,name`),
    ]);

    const combined = [
      ...clientRes.data.map(w => ({ ...w, _src: 'client' })),
      ...ownedRes.data.map(w => ({ ...w, _src: 'owned' })),
    ];

    if (combined.length > 0) {
      const rows = await Promise.all(combined.map(async w => ({
        waba_id: w.id, waba_name: w.name, waba_source: w._src,
        phone_numbers: await phoneNumbersForWaba(w.id),
      })));
      return res.json({
        source:       'portfolio_fallback',
        client_ok:    clientRes.ok,
        owned_ok:     ownedRes.ok,
        total:        rows.length,
        wabas:        rows,
      });
    }

    // Ninguno devolvió datos — reportar todo
    res.status(502).json({
      error:       'Ninguna fuente devolvió WABAs',
      subscribed_businesses: appId ? 'vacío o error' : 'META_APP_ID no configurado',
      client_accounts: { ok: clientRes.ok, raw: clientRes.raw },
      owned_accounts:  { ok: ownedRes.ok,  raw: ownedRes.raw  },
    });
  } catch (err) {
    logError('meta-wabas', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Meta WABA rescue — guarda credenciales y suscribe app para un negocio
// POST /admin/api/meta-waba-connect
// Body: { business_id, waba_id, phone_number_id? }
// Si phone_number_id no viene, lo resuelve consultando la WABA en Meta.
app.post('/admin/api/meta-waba-connect', requireAdmin, async (req, res) => {
  const systemToken = process.env.META_SYSTEM_TOKEN;
  if (!systemToken) return res.status(500).json({ error: 'META_SYSTEM_TOKEN no configurado' });

  const { business_id, waba_id, phone_number_id: phoneNumberIdParam } = req.body;
  if (!business_id || !waba_id) {
    return res.status(400).json({ error: 'business_id y waba_id requeridos' });
  }
  const id = parseInt(business_id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'business_id inválido' });

  const business = getBusinessById(id);
  if (!business) return res.status(404).json({ error: `Negocio ${id} no encontrado` });
  if (business.phone_number_id) {
    return res.status(409).json({
      error: `El negocio ${id} ya tiene phone_number_id guardado. Desconectalo primero con POST /admin/api/wa-disconnect/${id}.`,
    });
  }

  // Resolver phone_number_id si no vino en el body
  let phone_number_id      = phoneNumberIdParam ? String(phoneNumberIdParam) : null;
  let display_phone_number = null;
  let verified_name        = null;

  if (!phone_number_id) {
    const pnRes  = await fetch(
      `https://graph.facebook.com/v21.0/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,status`,
      { headers: { 'Authorization': `Bearer ${systemToken}` } },
    );
    const pnData = await pnRes.json();

    if (!pnRes.ok) {
      logError('meta-waba-connect', {
        message: `phone_numbers_failed waba_id=${waba_id} status=${pnRes.status} error=${pnData?.error?.message ?? JSON.stringify(pnData).slice(0, 150)}`,
        stack: '',
      });
      return res.status(400).json({
        error: 'Meta no devolvió los números de la WABA',
        detail: pnData?.error ?? pnData,
      });
    }

    const numbers = pnData.data || [];
    if (numbers.length === 0) {
      logError('meta-waba-connect', { message: `phone_numbers_empty waba_id=${waba_id}`, stack: '' });
      return res.status(400).json({ error: 'La WABA no tiene números asociados en Meta.' });
    }
    if (numbers.length > 1) {
      return res.status(400).json({
        error: 'La WABA tiene más de un número. Enviá phone_number_id explícitamente.',
        phone_numbers: numbers.map(p => ({
          id:                   p.id,
          display_phone_number: p.display_phone_number,
          verified_name:        p.verified_name,
        })),
      });
    }

    phone_number_id      = String(numbers[0].id);
    display_phone_number = numbers[0].display_phone_number ?? null;
    verified_name        = numbers[0].verified_name        ?? null;
  }

  // Suscribir la app a la WABA para recibir webhooks
  const subRes  = await fetch(`https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${systemToken}` },
  });
  const subData = await subRes.json();

  if (!subRes.ok) {
    logError('meta-waba-connect', {
      message: `sub_failed business_id=${id} waba_id=${waba_id} status=${subRes.status} detail=${JSON.stringify(subData).slice(0, 200)}`,
      stack: '',
    });
  }

  // accessToken null → metaFetch cae en META_SYSTEM_TOKEN automáticamente
  saveWabaCredentials(id, {
    wabaId:        String(waba_id),
    phoneNumberId: phone_number_id,
    accessToken:   null,
    provider:      'meta',
  });

  const last4 = phone_number_id.slice(-4);
  logError('meta-waba-connect', {
    message: `saved business_id=${id} waba_id=${waba_id} phone_number_id_last4=${last4} display=${display_phone_number ?? 'provided'} sub_ok=${subRes.ok}`,
    stack: '',
  });

  res.json({
    ok: true,
    business_id:          id,
    waba_id,
    phone_number_id,
    display_phone_number,
    verified_name,
    subscribed:           subRes.ok,
    subscription_detail:  subData,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Meta phone number status — solo lectura, no modifica nada
// GET /admin/api/meta-phone-status/:business_id
app.get('/admin/api/meta-phone-status/:business_id', requireAdmin, async (req, res) => {
  const systemToken = process.env.META_SYSTEM_TOKEN;
  if (!systemToken) return res.status(500).json({ error: 'META_SYSTEM_TOKEN no configurado' });

  const id = parseInt(req.params.business_id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'business_id inválido' });

  const business = getBusinessById(id);
  if (!business?.phone_number_id) {
    return res.status(404).json({ error: `Negocio ${id} no encontrado o sin phone_number_id` });
  }

  const pnid = business.phone_number_id;

  // Meta rechaza campos inexistentes con error code 100 — no los ignora silenciosamente.
  // Consultamos cada campo por separado en paralelo y acumulamos los que responden.
  const FIELDS = [
    'display_phone_number', 'verified_name', 'status', 'name_status',
    'quality_rating', 'platform_type', 'account_mode',
    'is_on_biz_app', 'code_verification_status', 'messaging_limit_tier',
  ];

  const authHdr = { 'Authorization': `Bearer ${systemToken}` };

  async function fetchField(field) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${pnid}?fields=${field}`, { headers: authHdr });
    const d = await r.json();
    return { field, ok: r.ok, data: d };
  }

  try {
    const results = await Promise.all(FIELDS.map(fetchField));

    // Si todos fallaron con un error duro (auth, not found, etc.) reportar el primero
    const hardFail = results.find(r => !r.ok && r.data?.error?.code !== 100);
    if (hardFail && results.every(r => !r.ok)) {
      return res.status(502).json({
        error: hardFail.data?.error?.message ?? 'Error desconocido de Meta',
        meta_error: hardFail.data?.error ?? hardFail.data,
      });
    }

    const combined = {};
    const unavailable = [];
    for (const r of results) {
      if (r.ok && r.data[r.field] !== undefined) {
        combined[r.field] = r.data[r.field];
      } else {
        unavailable.push(r.field);
      }
    }
    const anyOk = results.find(r => r.ok && r.data.id);
    if (anyOk) combined.id = anyOk.data.id;

    res.json({ ...combined, _campos_no_disponibles: unavailable });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /admin/api/wa-verify/:business_id  (?fix=1 para re-suscribir si falta)
app.get('/admin/api/wa-verify/:business_id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.business_id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'business_id inválido' });

  const business = getBusinessById(id);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });

  const fix         = req.query.fix === '1';
  const systemToken = process.env.META_SYSTEM_TOKEN;
  const metaAppId   = process.env.META_APP_ID;
  const authHdr     = systemToken ? { 'Authorization': `Bearer ${systemToken}` } : null;
  const pnid        = business.phone_number_id || null;
  const wabaId      = business.waba_id || null;

  const result = {
    business: {
      id:              business.id,
      name:            business.name,
      wa_provider:     business.wa_provider || 'meta',
      phone_number_id: pnid,
      waba_id:         wabaId,
    },
    phone_status:  null,
    health_status: null,
    subscription:  null,
    activity:      null,
    fix_applied:   null,
    verdict:       'ok',
    reasons:       [],
  };

  if (!pnid) {
    result.verdict = 'fail';
    result.reasons.push('No conectado: falta phone_number_id');
    return res.json(result);
  }

  if (!systemToken) {
    result.verdict = 'fail';
    result.reasons.push('META_SYSTEM_TOKEN no configurado en el servidor');
    return res.json(result);
  }

  // 2. Estado del número
  try {
    const fields = 'status,platform_type,is_on_biz_app,quality_rating,messaging_limit_tier';
    const r = await fetch(`https://graph.facebook.com/v21.0/${pnid}?fields=${fields}`, { headers: authHdr });
    const d = await r.json();
    if (r.ok) {
      result.phone_status = {
        status:               d.status               ?? null,
        platform_type:        d.platform_type        ?? null,
        is_on_biz_app:        d.is_on_biz_app        ?? null,
        quality_rating:       d.quality_rating       ?? null,
        messaging_limit_tier: d.messaging_limit_tier ?? null,
      };
      if (d.status && d.status !== 'CONNECTED') {
        result.verdict = 'fail';
        result.reasons.push(`Estado del número: ${d.status}`);
      }
      if (d.is_on_biz_app === false) {
        if (result.verdict === 'ok') result.verdict = 'warn';
        result.reasons.push('Número no está en la Business App (is_on_biz_app=false)');
      }
    } else {
      result.phone_status = { error: d?.error?.message ?? `HTTP ${r.status}` };
    }
  } catch (e) {
    result.phone_status = { error: e.message };
  }

  // 3. health_status — detecta bloqueos (ej. error 131031)
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${pnid}?fields=health_status`, { headers: authHdr });
    const d = await r.json();
    if (r.ok) {
      const hs      = d.health_status ?? {};
      const canSend = hs.can_send_message ?? null;
      const errors  = (hs.entities ?? [])
        .flatMap(e => e.errors ?? [])
        .map(e => ({ code: e.error_code, description: e.error_description }));
      result.health_status = { can_send_message: canSend, errors };
      if (canSend === 'BLOCKED') {
        result.verdict = 'fail';
        result.reasons.push('can_send_message: BLOCKED');
      } else if (canSend && canSend !== 'AVAILABLE') {
        // LIMITED (SIP errors, etc.) — informational warn only
        if (result.verdict === 'ok') result.verdict = 'warn';
        result.reasons.push(`can_send_message: ${canSend}`);
      }
    } else {
      result.health_status = { error: d?.error?.message ?? `HTTP ${r.status}` };
    }
  } catch (e) {
    result.health_status = { error: e.message };
  }

  // 4. Suscripción al WABA
  if (wabaId) {
    try {
      const appsUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(wabaId)}/subscribed_apps`;
      const r = await fetch(appsUrl, { headers: authHdr });
      const d = await r.json();
      if (r.ok) {
        // Meta anida el nombre/id dentro de whatsapp_business_api_data
        const apps = (d.data || []).map(a => {
          const wba = a.whatsapp_business_api_data || {};
          return { id: String(wba.id || a.id || ''), name: wba.name || a.name || '' };
        });
        const daxosSubscribed = metaAppId
          ? apps.some(a => a.id && a.id === String(metaAppId))
          : null;
        const otherApps = metaAppId
          ? apps.filter(a => a.id !== String(metaAppId)).map(a => a.name || a.id)
          : apps.map(a => a.name || a.id);
        result.subscription = { daxos_subscribed: daxosSubscribed, other_apps: otherApps, total_apps: apps.length };

        if (daxosSubscribed === false) {
          result.verdict = 'fail';
          result.reasons.push('Daxos no está suscrito al WABA');

          if (fix) {
            try {
              const fixRes  = await fetch(appsUrl, { method: 'POST', headers: authHdr });
              const fixData = await fixRes.json();
              if (fixRes.ok && fixData.success) {
                result.fix_applied = 'subscribed';
                result.subscription.daxos_subscribed = true;
                result.reasons = result.reasons.filter(r => r !== 'Daxos no está suscrito al WABA');
                if (result.verdict === 'fail' && result.reasons.length === 0) result.verdict = 'ok';
              } else {
                result.fix_applied = `failed: ${fixData?.error?.message ?? `HTTP ${fixRes.status}`}`;
              }
            } catch (fixErr) {
              result.fix_applied = `error: ${fixErr.message}`;
            }
          }
        }
      } else {
        result.subscription = { error: d?.error?.message ?? `HTTP ${r.status}` };
        if (result.verdict === 'ok') result.verdict = 'warn';
        result.reasons.push('No se pudo consultar suscripción WABA');
      }
    } catch (e) {
      result.subscription = { error: e.message };
    }
  } else {
    result.subscription = { error: 'waba_id no configurado' };
    if (result.verdict === 'ok') result.verdict = 'warn';
    result.reasons.push('waba_id no configurado en el negocio');
  }

  // 5. Actividad en error_log
  const lastInbound = getLastWebhookInboundAt(business.id);
  const recentFailed = getRecentWaStatusFailed(pnid);
  result.activity = { last_inbound_at: lastInbound, recent_failed_deliveries: recentFailed };

  // Cuenta bloqueada (131031) en entregas fallidas últimas 24 h → fail
  if (recentFailed.some(f => String(f.code) === '131031')) {
    result.verdict = 'fail';
    result.reasons.push('Cuenta bloqueada detectada (código 131031 en últimas 24 h)');
  }

  const ms48h = 48 * 3600 * 1000;
  const inboundAge = lastInbound ? Date.now() - new Date(lastInbound + 'Z').getTime() : Infinity;
  if (inboundAge > ms48h) {
    if (result.verdict === 'ok') result.verdict = 'warn';
    result.reasons.push(lastInbound
      ? `Sin mensajes entrantes desde ${lastInbound} (más de 48 h)`
      : 'Sin mensajes entrantes registrados');
  }

  res.json(result);
});

// ──────────────────────────────────────────────────────────────────────────────
// Registrar número en WhatsApp Cloud API
// POST /admin/api/meta-phone-register
// Body: { business_id, pin }
app.post('/admin/api/meta-phone-register', requireAdmin, async (req, res) => {
  const systemToken = process.env.META_SYSTEM_TOKEN;
  if (!systemToken) return res.status(500).json({ error: 'META_SYSTEM_TOKEN no configurado' });

  const { business_id, pin } = req.body;
  const id = parseInt(business_id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'business_id inválido' });
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return res.status(400).json({ error: 'pin debe ser exactamente 6 dígitos numéricos' });
  }

  const business = getBusinessById(id);
  if (!business?.phone_number_id) {
    return res.status(404).json({ error: `Negocio ${id} no encontrado o sin phone_number_id` });
  }

  const pnid = business.phone_number_id;

  try {
    const metaRes  = await fetch(`https://graph.facebook.com/v21.0/${pnid}/register`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${systemToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      const errCode      = metaData?.error?.code             ?? null;
      const errSubcode   = metaData?.error?.error_subcode    ?? null;
      const errMsg       = metaData?.error?.message          ?? 'Error desconocido de Meta';
      const errData      = metaData?.error?.error_data       ?? null;
      const errUserTitle = metaData?.error?.error_user_title ?? null;
      const errUserMsg   = metaData?.error?.error_user_msg   ?? null;
      const errType      = metaData?.error?.type             ?? null;
      const errTrace     = metaData?.error?.fbtrace_id       ?? null;
      logError('meta-phone-register', {
        message: `failed business_id=${id} phone_number_id_last4=${String(pnid).slice(-4)} http=${metaRes.status} code=${errCode} subcode=${errSubcode} type=${errType} trace=${errTrace} user_title=${errUserTitle} user_msg=${String(errUserMsg ?? '').slice(0, 120)} error_data=${JSON.stringify(errData).slice(0, 150)}`,
        stack: '',
      });
      return res.status(502).json({
        error:                 errMsg,
        meta_code:             errCode,
        meta_error_subcode:    errSubcode,
        meta_error_data:       errData,
        meta_error_user_title: errUserTitle,
        meta_error_user_msg:   errUserMsg,
        meta_type:             errType,
        meta_fbtrace_id:       errTrace,
      });
    }

    logError('meta-phone-register', {
      message: `ok business_id=${id} phone_number_id_last4=${String(pnid).slice(-4)}`,
      stack: '',
    });
    res.json({ ok: true, phone_number_id: pnid, meta: metaData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/meta-resubscribe/:business_id
app.post('/admin/api/meta-resubscribe/:business_id', requireAdmin, async (req, res) => {
  const id       = Number(req.params.business_id);
  const business = getBusinessById(id);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });
  const waba_id = business.waba_id;
  if (!waba_id) return res.status(400).json({ error: 'El negocio no tiene waba_id' });

  const token = process.env.META_SYSTEM_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_SYSTEM_TOKEN no configurado' });

  const appsUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(waba_id)}/subscribed_apps`;

  function extractApps(data) {
    return (data?.data || []).map(a => {
      const wba = a.whatsapp_business_api_data || {};
      return { id: String(wba.id || a.id || ''), name: wba.name || a.name || '' };
    });
  }

  try {
    // 1. GET before
    const beforeRes  = await fetch(appsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const beforeData = await beforeRes.json();
    const antes      = beforeRes.ok ? extractApps(beforeData) : { error: beforeData?.error?.message, status: beforeRes.status };

    // 2. POST subscribed_apps
    const postRes  = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(waba_id)}/subscribed_apps`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const postData  = await postRes.json();
    const post_ok   = postRes.ok && !!postData.success;
    const post_error = postRes.ok ? null : (postData?.error?.message ?? `status ${postRes.status}`);

    // 3. GET after
    const afterRes  = await fetch(appsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const afterData = await afterRes.json();
    const despues   = afterRes.ok ? extractApps(afterData) : { error: afterData?.error?.message, status: afterRes.status };

    logError('meta-resubscribe', {
      message: `business_id=${id} waba_id=${waba_id} post_ok=${post_ok} post_error=${post_error ?? 'none'} antes_count=${Array.isArray(antes) ? antes.length : 'err'} despues_count=${Array.isArray(despues) ? despues.length : 'err'}`,
      stack: '',
    });

    res.json({ waba_id, antes, post_ok, post_error, despues });
  } catch (err) {
    logError('meta-resubscribe', { message: `exception business_id=${id} err=${err.message}`, stack: '' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/test-embedded-signup', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views/admin/test-embedded-signup.html'));
});

app.post('/admin/api/es-test-log', requireAdmin, (req, res) => {
  const { context, message } = req.body || {};
  if (typeof context === 'string' && typeof message === 'string') {
    logError(context.slice(0, 64), { message: message.slice(0, 500), stack: '' });
  }
  res.json({ ok: true });
});

// Temporary one-shot route to load WhatsApp credentials for a business by owner email.
// Protected by ADMIN_SET_WA_TOKEN env var (Bearer token). Remove once credentials are loaded.
app.post('/admin/set-wa-credentials', (req, res) => {
  const secret = process.env.ADMIN_SET_WA_TOKEN;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SET_WA_TOKEN no configurado en el servidor' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(403).json({ error: 'Token inválido' });

  const { email, waba_id, phone_number_id, access_token, wa_provider } = req.body;
  const provider = wa_provider || 'meta';

  if (!email || !phone_number_id) {
    return res.status(400).json({ error: 'email y phone_number_id requeridos' });
  }
  if (provider === 'meta' && !access_token) {
    return res.status(400).json({ error: 'access_token requerido para provider=meta' });
  }

  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: `No existe usuario con email: ${email}` });
  if (!user.business_id) return res.status(404).json({ error: `El usuario ${email} no tiene negocio asociado` });

  saveWabaCredentials(user.business_id, {
    wabaId: waba_id || null,
    phoneNumberId: phone_number_id,
    accessToken: access_token || null,
    provider,
  });
  res.json({ ok: true, business_id: user.business_id, waba_id, phone_number_id, provider });
});

// Protected by ADMIN_SET_WA_TOKEN env var (Bearer token). Temporary route to set plan/status.
app.post('/admin/set-plan', (req, res) => {
  const secret = process.env.ADMIN_SET_WA_TOKEN;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SET_WA_TOKEN no configurado en el servidor' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(403).json({ error: 'Token inválido' });

  const { email, plan, subscription_status } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'email y plan requeridos' });

  const VALID_PLANS = ['arranque', 'crecimiento', 'a_medida'];
  if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: `plan debe ser uno de: ${VALID_PLANS.join(', ')}` });

  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: `No existe usuario con email: ${email}` });
  if (!user.business_id) return res.status(404).json({ error: `El usuario ${email} no tiene negocio asociado` });

  upgradePlan(user.business_id, plan, new Date().toISOString(), null);
  if (subscription_status) setSubscriptionStatus(user.business_id, subscription_status);

  res.json({ ok: true, business_id: user.business_id, plan, subscription_status: subscription_status || 'active' });
});

// Clears WA credentials so the next Kapso reconnect can write fresh ones.
// Use after deregistering a number from the Meta API.
app.post('/admin/disconnect-wa', (req, res) => {
  const secret = process.env.ADMIN_SET_WA_TOKEN;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SET_WA_TOKEN no configurado' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(403).json({ error: 'Token inválido' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email requerido' });

  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: `No existe usuario con email: ${email}` });
  if (!user.business_id) return res.status(404).json({ error: `El usuario ${email} no tiene negocio asociado` });

  const prev = clearWabaCredentials(user.business_id);
  logError('admin-disconnect-wa', {
    message: `business_id=${user.business_id} email=${email} cleared: phone_number_id=${prev?.phone_number_id ?? 'null'} waba_id=${prev?.waba_id ?? 'null'} wa_provider=${prev?.wa_provider ?? 'null'}`,
    stack: '',
  });

  res.json({ ok: true, business_id: user.business_id, cleared: prev });
});

app.post('/admin/change-email', (req, res) => {
  const secret = process.env.ADMIN_SET_WA_TOKEN;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SET_WA_TOKEN no configurado' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(403).json({ error: 'Token inválido' });

  const { old_email, new_email } = req.body;
  if (!old_email || !new_email) return res.status(400).json({ error: 'old_email y new_email requeridos' });

  const target = getUserByEmail(old_email);
  if (!target) return res.status(404).json({ error: `No existe usuario con email: ${old_email}` });

  const conflict = getUserByEmail(new_email);
  if (conflict) return res.status(409).json({ error: `El email ${new_email} ya está en uso por otra cuenta` });

  changeUserEmail(old_email, new_email);
  res.json({ ok: true, old_email, new_email, user_id: target.id });
});

app.post('/admin/set-plan-cortesia', (req, res) => {
  const secret = process.env.ADMIN_SET_WA_TOKEN;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SET_WA_TOKEN no configurado' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(403).json({ error: 'Token inválido' });

  const { email, plan_cortesia } = req.body;
  if (!email || plan_cortesia === undefined) return res.status(400).json({ error: 'email y plan_cortesia requeridos' });

  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: `No existe usuario con email: ${email}` });
  if (!user.business_id) return res.status(404).json({ error: `El usuario ${email} no tiene negocio asociado` });

  setPlanCortesia(user.business_id, plan_cortesia);
  res.json({ ok: true, email, business_id: user.business_id, plan_cortesia: plan_cortesia ? 1 : 0 });
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — checkpointing WAL and closing DB...');
  try {
    checkpoint();
    closeDb();
    console.log('DB closed cleanly.');
  } catch (err) {
    console.error('Error during shutdown:', err.message);
  }
  process.exit(0);
});
