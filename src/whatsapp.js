const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

function apiUrl(phoneNumberId) {
  return `${GRAPH_BASE}/${phoneNumberId}/messages`;
}

async function sendWhatsAppMessage(to, text, { phoneNumberId, accessToken }) {
  const res = await fetch(apiUrl(phoneNumberId), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function uploadMedia(buffer, filename, mimeType, { phoneNumberId, accessToken }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: form,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp media upload error ${res.status}: ${JSON.stringify(data)}`);
  if (!data.id) throw new Error('WhatsApp media upload did not return an id');
  return data.id;
}

async function sendWhatsAppAudio(to, mediaId, { phoneNumberId, accessToken }) {
  const res = await fetch(apiUrl(phoneNumberId), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'audio',
      audio: { id: mediaId },
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function sendWhatsAppDocument(to, mediaId, filename, { phoneNumberId, accessToken }) {
  const res = await fetch(apiUrl(phoneNumberId), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: { id: mediaId, filename },
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function markAsRead(messageId, { phoneNumberId, accessToken }) {
  await fetch(apiUrl(phoneNumberId), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  }).catch(() => {});
}

async function sendTypingIndicator(to, { phoneNumberId, accessToken }) {
  await fetch(apiUrl(phoneNumberId), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'action',
      action: { action_type: 'SHOW_TYPING' },
    }),
  }).catch(() => {});
}

module.exports = { sendWhatsAppMessage, uploadMedia, sendWhatsAppAudio, sendWhatsAppDocument, markAsRead, sendTypingIndicator };
