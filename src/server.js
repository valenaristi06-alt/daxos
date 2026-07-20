require('dotenv').config({ path: '.env.local' });

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const BetterSQLiteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const { createUser, getUserByEmail, getUserById, upsertBusiness, getBusinessById, getBusinessByWhatsappNumber, getBusinessByUserId, setUserBusiness, getOrCreateConversation, addMessage, getConversationHistory } = require('./db');
const { generateReply } = require('./claude');
const { sendWhatsAppMessage } = require('./whatsapp');

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

app.put('/api/business', requireAuth, (req, res) => {
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
    res.json(business);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

          await sendWhatsAppMessage(customerPhone, reply);
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
