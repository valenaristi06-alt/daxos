console.log('[BOOT] pre-dotenv keys:', Object.keys(process.env).length, '| ANTHROPIC:', !!process.env.ANTHROPIC_API_KEY, '| META_APP_ID:', !!process.env.META_APP_ID);
require('dotenv').config({ path: '.env.local' });
console.log('[BOOT] post-dotenv keys:', Object.keys(process.env).length, '| ANTHROPIC:', !!process.env.ANTHROPIC_API_KEY, '| META_APP_ID:', !!process.env.META_APP_ID);

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const BetterSQLiteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const multer = require('multer');
const { createUser, getUserByEmail, getUserById, getUserByBusinessId, upsertBusiness, getBusinessById, getBusinessByWhatsappNumber, getBusinessByUserId, setUserBusiness, setUserPhone, setStyleProfile, setWebsiteSummary, saveVoiceConsent, getConversationsByBusinessId, getConversationCountByBusinessId, getLastCustomerMessage, getConversationById, getOrCreateConversation, addMessage, getConversationHistory, markConversationPaused, markConversationResumed, getDailyConversationStats, getTodayStats, getDailyMessageStats, setConversationLabel, setBusinessDocument, clearBusinessDocument, upgradePlan, setSubscriptionStatus, savePendingPayment, getPendingPayments, getAllBusinesses, getGlobalStats, getBusinessAdminMetrics, getPlanCounts, saveWabaCredentials } = require('./db');
const { generateReply, analyzeStyle, summarizeWebsite } = require('./claude');
const { cloneVoice, generatePreview, deleteVoice } = require('./elevenlabs');
const { sendPauseEmail, sendUnmatchedPaymentAlert } = require('./email');

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

const fs = require('fs');
const { sendWhatsAppMessage, uploadMedia, sendWhatsAppAudio, sendWhatsAppDocument, markAsRead, sendTypingIndicator } = require('./whatsapp');
const { generateAudioBuffer } = require('./elevenlabs');
const { convertToOgg } = require('./audio');

fs.mkdirSync(path.join(__dirname, '../data/uploads'), { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
const sessionsDb = new Database(path.join(__dirname, '../data/sessions.db'));

app.use(session({
  store: new BetterSQLiteStore({ client: sessionsDb }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  },
}));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Auth routes ---

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'No autenticado' });
}

app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

  const existing = getUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'Este email ya está registrado' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = createUser(email, hash);
    req.session.userId = user.id;
    res.json({ ok: true, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
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
  const metaVal = process.env.META_APP_ID;
  console.log('[api/config] META_APP_ID at request time:', metaVal, '| total keys:', Object.keys(process.env).length);
  res.json({
    metaAppId: metaVal || null,
    // TODO: reemplazar cuando se apruebe la Verificación de acceso en Meta Business Manager
    whatsappConfigId: process.env.WHATSAPP_CONFIG_ID || null,
    _debug_keys: Object.keys(process.env).filter(k => k.startsWith('META_') || k.startsWith('WHATSAPP_')),
    _debug_has_anthropic: !!process.env.ANTHROPIC_API_KEY,
    _debug_has_session: !!process.env.SESSION_SECRET,
    _debug_total_env_keys: Object.keys(process.env).length,
    _debug_pid: process.pid,
    _debug_uptime: Math.round(process.uptime()),
  });
});

app.get('/api/business', requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  res.json(business || null);
});

async function fetchAndSummarizeWebsite(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const html = await res.text();
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

app.put('/api/business', requireAuth, async (req, res) => {
  const { name, whatsapp_number, sales_examples, survey_answers, business_context, website_url, response_mode, pause_keywords, response_delay, pricing_info } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre del negocio es requerido' });

  try {
    const user = getUserById(req.session.userId);

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
      response_delay: response_delay != null ? Math.min(20, Math.max(0, parseInt(response_delay, 10) || 5)) : 5,
      pricing_info: pricing_info ? pricing_info.trim() : null,
    });
    if (!user.business_id) setUserBusiness(user.id, business.id);

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

    res.json(business);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Exact consent text — stored verbatim for legal record
const CONSENT_TEXT = 'Confirmo que esta es mi voz (o tengo autorización explícita de su dueño) y autorizo usarla para generar respuestas automáticas de este negocio.';

app.post('/api/business/voice', requireAuth, upload.single('audio'), async (req, res) => {
  if (req.body.consent !== 'true') {
    return res.status(400).json({ error: 'Se requiere consentimiento explícito para clonar la voz.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Archivo de audio requerido.' });
  }

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

app.get('/api/conversations', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.json([]);
  const convs = getConversationsByBusinessId(user.business_id);
  res.json(convs);
});

app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  const conv = getConversationById(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: 'Not found' });
  if (!user.business_id || conv.business_id !== user.business_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const messages = getConversationHistory(conv.id, 200);
  res.json({ conversation: conv, messages });
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

app.post('/businesses', (req, res) => {
  const { name, whatsapp_number, sales_examples, survey_answers, response_mode } = req.body;
  if (!name || !whatsapp_number) {
    return res.status(400).json({ error: 'name and whatsapp_number are required' });
  }
  try {
    const business = upsertBusiness({ name, whatsapp_number, sales_examples, survey_answers, response_mode });
    res.json(business);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.patch('/api/conversations/:id/resume', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Sin negocio.' });

  const conv = getConversationById(parseInt(req.params.id));
  if (!conv || conv.business_id !== user.business_id) return res.status(404).json({ error: 'Conversación no encontrada.' });

  markConversationResumed(conv.id);
  res.json({ ok: true });
});

app.post('/api/business/document', requireAuth, documentUpload.single('document'), async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Configurá tu negocio primero.' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

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

app.post('/api/business/preview-chat', requireAuth, async (req, res) => {
  const user = getUserById(req.session.userId);
  if (!user.business_id) return res.status(400).json({ error: 'Configurá tu negocio primero.' });

  const business = getBusinessById(user.business_id);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado.' });

  const { message, history = [] } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

  try {
    const rawReply = await generateReply(business, history, message.trim());
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
    const sent_audio = business.response_mode === 'audio' && !!business.voice_id && planAllowsAudio;

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
    res.status(500).json({ error: err.message });
  }
});

app.post('/test/simulate', async (req, res) => {
  const { business_id, customer_id, message } = req.body;
  if (!business_id || !customer_id || !message) {
    return res.status(400).json({ error: 'business_id, customer_id and message are required' });
  }

  const business = getBusinessById(business_id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  try {
    const conversation = getOrCreateConversation(business_id, customer_id);
    const history = getConversationHistory(conversation.id, 20);

    await maybeSendDisclosure(business, conversation.id, history, null);

    const reply = await generateReply(business, history, message);

    addMessage(conversation.id, 'user', message);
    addMessage(conversation.id, 'assistant', reply);

    res.json({ reply, conversation_id: conversation.id, first_contact: history.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isTrialExpired(business) {
  if (business.plan !== 'arranque') return false;
  if (!business.trial_ends_at) return false;
  return new Date(business.trial_ends_at) < new Date();
}

// Pauses a conversation and notifies the business owner via email.
// channel: 'whatsapp' | 'instagram' — only 'whatsapp' triggers notification for now.
// contactId: customer identifier in the given channel (phone for WA, IG user ID for Instagram).
async function notifyOwnerOfPause({ business, owner, channel, contactId, messageText, conversationId, waCredentials }) {
  if (channel === 'instagram') return;
  if (!owner) return;

  const ownerPhone = owner.phone;
  if (ownerPhone && waCredentials) {
    try {
      const waMsg = `⚠️ Conversación pausada — ${business.name}\nContacto: ${contactId}\nMensaje: ${messageText}\nVer conversación #${conversationId} en tu panel de Daxos.`;
      await sendWhatsAppMessage(ownerPhone, waMsg, waCredentials);
      return;
    } catch (waErr) {
      console.error('[notify-pause] WhatsApp failed, falling back to email:', waErr.message);
    }
  }

  return sendPauseEmail({
    to: owner.email,
    businessName: business.name,
    contactId,
    messageText,
    conversationId,
  });
}

// Sends the first-contact disclosure required by Meta policy.
// Always plain text, always saved to history. No-op if history already exists.
async function maybeSendDisclosure(business, conversationId, history, recipientPhone, waCredentials) {
  if (history.length > 0) return;
  const notice = `Hola! Soy el asistente automático de ${business.name} 🤖. Te ayudo con consultas, precios y turnos.`;
  if (recipientPhone && waCredentials) {
    try { await sendWhatsAppMessage(recipientPhone, notice, waCredentials); }
    catch (err) { console.error('[disclosure] WA send failed:', err.message); }
  }
  addMessage(conversationId, 'assistant', notice);
}

// --- WhatsApp webhook ---

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook', async (req, res) => {
  // Respond 200 immediately so Meta doesn't retry
  res.status(200).send('OK');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;
        const messages = value.messages || [];

        if (!messages.length) continue;

        const business = getBusinessByWhatsappNumber(phoneNumberId);
        if (!business) {
          console.warn(`No business found for phone_number_id: ${phoneNumberId}`);
          continue;
        }

        const waCredentials = { phoneNumberId: business.phone_number_id, accessToken: business.wa_access_token };

        for (const msg of messages) {
          if (msg.type !== 'text') continue;

          const customerPhone = msg.from;
          const text = msg.text?.body;
          if (!text) continue;

          if (isTrialExpired(business)) {
            await sendWhatsAppMessage(customerPhone,
              `Hola! El período de prueba de ${business.name} terminó. Para seguir recibiendo respuestas automáticas, el negocio necesita activar su plan.`,
              waCredentials
            );
            continue;
          }

          const conversation = getOrCreateConversation(business.id, customerPhone);
          const history = getConversationHistory(conversation.id, 20);

          // Conversation paused — record message so owner sees it, but no AI reply
          if (conversation.needs_attention) {
            addMessage(conversation.id, 'user', text);
            markAsRead(msg.id, waCredentials).catch(() => {});
            continue;
          }

          // Pause keyword check — before any network call so WA errors can't skip it
          if (business.pause_keywords) {
            const keywords = business.pause_keywords
              .split(',')
              .map(k => k.trim().toLowerCase())
              .filter(Boolean);
            const lowerText = text.toLowerCase();
            const matched = keywords.find(k => lowerText.includes(k));
            if (matched) {
              addMessage(conversation.id, 'user', text);
              markConversationPaused(conversation.id);
              const owner = getUserByBusinessId(business.id);
              notifyOwnerOfPause({
                business, owner, channel: 'whatsapp', contactId: customerPhone,
                messageText: text, conversationId: conversation.id, waCredentials,
              }).catch(err => console.error('[notify-pause]', err.message));
              continue;
            }
          }

          await maybeSendDisclosure(business, conversation.id, history, customerPhone, waCredentials);

          // Mark as read + show typing indicator immediately
          markAsRead(msg.id, waCredentials).catch(() => {});
          sendTypingIndicator(customerPhone, waCredentials).catch(() => {});

          // Generate reply and enforce minimum delay in parallel
          const delayMs = (business.response_delay ?? 5) * 1000;
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const [rawReply] = await Promise.all([
            generateReply(business, history, text, conversation.label || null),
            sleep(delayMs),
          ]);

          let sendDoc = false;
          let needsHuman = false;
          let reply = rawReply;
          if (reply.startsWith('[NEEDS_HUMAN]')) {
            needsHuman = true;
            reply = reply.replace(/^\[NEEDS_HUMAN\]\n?/, '');
          }
          if (reply.startsWith('[SEND_DOC]')) {
            sendDoc = true;
            reply = reply.replace(/^\[SEND_DOC\]\n?/, '');
          }
          reply = reply.trim();

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

          const planAllowsAudio = ['crecimiento', 'a_medida'].includes(business.plan);
          try {
            if (business.response_mode === 'audio' && business.voice_id && planAllowsAudio) {
              try {
                const mp3 = await generateAudioBuffer(business.voice_id, reply);
                const ogg = await convertToOgg(mp3);
                const mediaId = await uploadMedia(ogg, 'reply.ogg', 'audio/ogg', waCredentials);
                await sendWhatsAppAudio(customerPhone, mediaId, waCredentials);
              } catch (audioErr) {
                console.error('[audio-reply] failed, falling back to text:', audioErr.message);
                await sendWhatsAppMessage(customerPhone, reply, waCredentials);
              }
            } else {
              await sendWhatsAppMessage(customerPhone, reply, waCredentials);
            }
          } catch (sendErr) {
            console.error('[reply-send] failed:', sendErr.message);
          }

          // Derivación por incertidumbre — no dispara si la conversación ya estaba pausada
          if (needsHuman && !conversation.needs_attention) {
            markConversationPaused(conversation.id);
            const owner = getUserByBusinessId(business.id);
            notifyOwnerOfPause({
              business, owner, channel: 'whatsapp', contactId: customerPhone,
              messageText: text, conversationId: conversation.id, waCredentials,
            }).catch(err => console.error('[notify-pause]', err.message));
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// --- Mercado Pago webhook ---

app.post('/webhook/mercadopago', async (req, res) => {
  // Validate HMAC signature before processing anything
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const xSignature = req.headers['x-signature'] || '';
    const xRequestId = req.headers['x-request-id'] || '';
    const paymentId  = req.query?.['data.id'] || req.body?.data?.id || '';

    const tsMatch = xSignature.match(/ts=([^,]+)/);
    const v1Match = xSignature.match(/v1=([^,]+)/);

    if (!tsMatch || !v1Match) {
      console.warn('[mp-webhook] Missing or malformed x-signature header — rejected');
      return res.status(200).send('OK'); // 200 so MP doesn't retry; we reject silently
    }

    const ts       = tsMatch[1];
    const received = v1Match[1];
    const manifest = `id:${paymentId};request-id:${xRequestId};ts:${ts};`;
    const expected = crypto.createHmac('sha256', webhookSecret).update(manifest).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
      console.warn('[mp-webhook] Invalid HMAC signature — rejected');
      return res.status(200).send('OK');
    }
  } else {
    console.warn('[mp-webhook] MERCADOPAGO_WEBHOOK_SECRET not set — skipping signature check');
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
          console.log(`[mp-webhook] Subscription ${data.id} ${subStatus} — business ${user.business_id} marked, access until plan_expires_at`);
        } else {
          console.warn(`[mp-webhook] Subscription ${subStatus} but no business for ${payerEmail}`);
        }
      }
      return;
    }

    // ── Payment (alta + renovaciones mensuales) ──
    if (type !== 'payment') return;

    // Verify payment directly with MP API — never trust notification body alone
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${mpToken}` },
    });

    if (!mpRes.ok) {
      console.error(`[mp-webhook] MP API returned ${mpRes.status} for payment ${data.id}`);
      return;
    }

    const payment = await mpRes.json();

    if (payment.status !== 'approved') {
      console.log(`[mp-webhook] Payment ${data.id} status=${payment.status}, ignoring`);
      return;
    }

    const payerEmail = payment.payer?.email?.toLowerCase().trim();
    if (!payerEmail) {
      console.warn(`[mp-webhook] No payer email in payment ${data.id}`);
      return;
    }

    const paidAt = payment.date_approved || payment.date_created || new Date().toISOString();
    const expiresAt = new Date(new Date(paidAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Match payer email to a registered user
    const user = getUserByEmail(payerEmail);
    if (user && user.business_id) {
      upgradePlan(user.business_id, 'crecimiento', paidAt, expiresAt);
      console.log(`[mp-webhook] Upgraded business ${user.business_id} to crecimiento (payment ${data.id})`);
      return;
    }

    // No match — save for manual review and alert admin
    savePendingPayment({
      mpPaymentId: String(data.id),
      payerEmail,
      amount: payment.transaction_amount,
      currency: payment.currency_id,
      paidAt,
      rawJson: JSON.stringify(payment),
    });

    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      sendUnmatchedPaymentAlert({
        adminEmail,
        payerEmail,
        amount: payment.transaction_amount,
        currency: payment.currency_id,
        mpPaymentId: data.id,
      }).catch(err => console.error('[mp-webhook] alert email failed:', err.message));
    }

    console.warn(`[mp-webhook] No business found for payer ${payerEmail}, payment ${data.id} saved as pending`);
  } catch (err) {
    console.error('[mp-webhook] Error processing payment:', err.message);
  }
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

app.post('/admin/auth/login', async (req, res) => {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL no configurado' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (email.toLowerCase().trim() !== adminEmail.toLowerCase()) {
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

app.get('/admin/api/costs', requireAdmin, (req, res) => {
  const stats = getGlobalStats();
  const planCounts = getPlanCounts();

  // Claude Sonnet 4.6 pricing: $3/MTok input, $15/MTok output
  // Estimate per AI reply: 2000 tok input + 300 tok output
  const claudeUSD = stats.aiRepliesThisMonth * (
    (2000 * 3 / 1_000_000) + (300 * 15 / 1_000_000)
  );

  // ElevenLabs: ~$0.30/1000 chars, ~200 chars/voice reply
  const elevenlabsUSD = stats.voiceRepliesThisMonth * 200 * (0.30 / 1000);

  // Revenue by plan (USD/month)
  const PLAN_PRICES = { arranque: 0, crecimiento: 39, a_medida: 99 };
  const revenueUSD = planCounts.reduce((sum, row) => sum + (PLAN_PRICES[row.plan] || 0) * row.count, 0);

  res.json({
    claude: { replies: stats.aiRepliesThisMonth, estimatedUSD: parseFloat(claudeUSD.toFixed(2)) },
    elevenlabs: { voiceReplies: stats.voiceRepliesThisMonth, estimatedUSD: parseFloat(elevenlabsUSD.toFixed(2)) },
    revenue: { planCounts, estimatedUSD: parseFloat(revenueUSD.toFixed(2)) },
    margin: parseFloat((revenueUSD - claudeUSD - elevenlabsUSD).toFixed(2)),
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Embedded Signup — OAuth callback
// POST /auth/whatsapp/callback
// Body: { code, waba_id, phone_number_id, business_id }
// The frontend sends these after the Meta JS SDK Embedded Signup flow completes.
app.post('/auth/whatsapp/callback', requireAuth, async (req, res) => {
  const { code, waba_id, phone_number_id, business_id } = req.body;

  if (!code || !waba_id || !phone_number_id || !business_id) {
    return res.status(400).json({ error: 'code, waba_id, phone_number_id, business_id requeridos' });
  }

  const userBusiness = getBusinessByUserId(req.session.userId);
  if (!userBusiness || userBusiness.id !== Number(business_id)) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;

  if (!appId || !appSecret) {
    return res.status(500).json({ error: 'META_APP_ID y META_APP_SECRET no configurados en el servidor' });
  }

  try {
    // 1. Exchange code for user access token
    const tokenUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('code', code);
    if (redirectUri) tokenUrl.searchParams.set('redirect_uri', redirectUri);

    const tokenRes = await fetch(tokenUrl.toString());
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[whatsapp-callback] token exchange failed:', tokenData);
      return res.status(400).json({ error: 'Token exchange falló', detail: tokenData });
    }

    const accessToken = tokenData.access_token;

    // 2. Subscribe WABA to Daxos webhook
    const subRes = await fetch(`https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const subData = await subRes.json();

    if (!subRes.ok) {
      console.error('[whatsapp-callback] subscribed_apps failed:', subData);
    }

    // 3. Persist credentials (access token encrypted at rest)
    saveWabaCredentials(Number(business_id), { wabaId: waba_id, phoneNumberId: phone_number_id, accessToken });

    res.json({ ok: true, waba_id, phone_number_id, subscribed: subRes.ok });
  } catch (err) {
    console.error('[whatsapp-callback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
