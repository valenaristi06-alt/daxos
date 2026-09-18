'use strict';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const KAPSO_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';

function getApiConfig({ provider, accessToken }) {
  if (provider === 'kapso') {
    const key = process.env.KAPSO_API_KEY || '';
    return {
      messagesUrl: (phoneNumberId) => `${KAPSO_BASE}/${phoneNumberId}/messages`,
      mediaUrl:    (phoneNumberId) => `${KAPSO_BASE}/${phoneNumberId}/media`,
      jsonHeaders: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      formHeaders: { 'X-API-Key': key },
    };
  }
  return {
    messagesUrl: (phoneNumberId) => `${GRAPH_BASE}/${phoneNumberId}/messages`,
    mediaUrl:    (phoneNumberId) => `${GRAPH_BASE}/${phoneNumberId}/media`,
    jsonHeaders: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    formHeaders: { 'Authorization': `Bearer ${accessToken}` },
  };
}

async function sendWhatsAppMessage(to, text, creds) {
  const { messagesUrl, jsonHeaders } = getApiConfig(creds);
  const res = await fetch(messagesUrl(creds.phoneNumberId), {
    method: 'POST',
    headers: jsonHeaders,
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

async function uploadMedia(buffer, filename, mimeType, creds) {
  const { mediaUrl, formHeaders } = getApiConfig(creds);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(mediaUrl(creds.phoneNumberId), {
    method: 'POST',
    headers: formHeaders,
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp media upload error ${res.status}: ${JSON.stringify(data)}`);
  if (!data.id) throw new Error('WhatsApp media upload did not return an id');
  return data.id;
}

async function sendWhatsAppAudio(to, mediaId, creds) {
  const { messagesUrl, jsonHeaders } = getApiConfig(creds);
  const res = await fetch(messagesUrl(creds.phoneNumberId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'audio',
      audio: { id: mediaId, voice: true },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function sendWhatsAppDocument(to, mediaId, filename, creds) {
  const { messagesUrl, jsonHeaders } = getApiConfig(creds);
  const res = await fetch(messagesUrl(creds.phoneNumberId), {
    method: 'POST',
    headers: jsonHeaders,
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

async function markAsRead(messageId, creds) {
  const { messagesUrl, jsonHeaders } = getApiConfig(creds);
  await fetch(messagesUrl(creds.phoneNumberId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  }).catch(() => {});
}

async function sendTypingIndicator(to, creds) {
  const { messagesUrl, jsonHeaders } = getApiConfig(creds);
  await fetch(messagesUrl(creds.phoneNumberId), {
    method: 'POST',
    headers: jsonHeaders,
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
