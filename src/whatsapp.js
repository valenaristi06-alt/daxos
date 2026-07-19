require('dotenv').config({ path: '.env.local' });

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const API_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, text) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must be set in .env.local');
  }

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

module.exports = { sendWhatsAppMessage };
