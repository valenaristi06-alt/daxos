require('dotenv').config({ path: '.env.local' });

const express = require('express');
const path = require('path');
const { upsertBusiness, getBusinessById, getBusinessByWhatsappNumber, getOrCreateConversation, addMessage, getConversationHistory } = require('./db');
const { generateReply } = require('./claude');
const { sendWhatsAppMessage } = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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
