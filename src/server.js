require('dotenv').config({ path: '.env.local' });

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const BetterSQLiteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const multer = require('multer');
const { createUser, getUserByEmail, getUserById, upsertBusiness, getBusinessById, getBusinessByWhatsappNumber, getBusinessByUserId, setUserBusiness, setStyleProfile, saveVoiceConsent, getConversationsByBusinessId, getConversationById, getOrCreateConversation, addMessage, getConversationHistory } = require('./db');
const { generateReply, analyzeStyle } = require('./claude');
const { cloneVoice, generatePreview, deleteVoice } = require('./elevenlabs');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Accept any audio/* type — backend converts everything to MP3 before ElevenLabs
    if (!file.mimetype.startsWith('audio/')) return cb(new Error('El archivo debe ser de audio'));
    cb(null, true);
  },
});
const { sendWhatsAppMessage, uploadMedia, sendWhatsAppAudio } = require('./whatsapp');
const { generateAudioBuffer } = require('./elevenlabs');
const { convertToOgg } = require('./audio');

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
  res.json({ id: user.id, email: user.email });
});

// --- Panel API ---

app.get('/api/business', requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.userId);
  res.json(business || null);
});

app.put('/api/business', requireAuth, async (req, res) => {
  const { name, whatsapp_number, sales_examples, survey_answers, response_mode } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre del negocio es requerido' });

  try {
    const user = getUserById(req.session.userId);
    const business = upsertBusiness({
      id: user.business_id || undefined,
      name: name.trim(),
      whatsapp_number: whatsapp_number ? whatsapp_number.trim() : null,
      sales_examples,
      survey_answers,
      response_mode,
    });
    if (!user.business_id) setUserBusiness(user.id, business.id);

    // Style analysis — non-blocking, failure never interrupts save
    if (Array.isArray(sales_examples) && sales_examples.length > 0) {
      analyzeStyle(sales_examples)
        .then(profile => setStyleProfile(business.id, profile))
        .catch(err => console.error('[style-analysis] failed:', err.message));
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

    const reply = await generateReply(business, history, message);

    addMessage(conversation.id, 'user', message);
    addMessage(conversation.id, 'assistant', reply);

    res.json({ reply, conversation_id: conversation.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

        for (const msg of messages) {
          if (msg.type !== 'text') continue;

          const customerPhone = msg.from;
          const text = msg.text?.body;
          if (!text) continue;

          const conversation = getOrCreateConversation(business.id, customerPhone);
          const history = getConversationHistory(conversation.id, 20);

          const reply = await generateReply(business, history, text);

          addMessage(conversation.id, 'user', text);
          addMessage(conversation.id, 'assistant', reply);

          if (business.response_mode === 'audio' && business.voice_id) {
            try {
              const mp3 = await generateAudioBuffer(business.voice_id, reply);
              const ogg = await convertToOgg(mp3);
              const mediaId = await uploadMedia(ogg, 'reply.ogg', 'audio/ogg');
              await sendWhatsAppAudio(customerPhone, mediaId);
            } catch (audioErr) {
              console.error('[audio-reply] failed, falling back to text:', audioErr.message);
              await sendWhatsAppMessage(customerPhone, reply);
            }
          } else {
            await sendWhatsAppMessage(customerPhone, reply);
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
