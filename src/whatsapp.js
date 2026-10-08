'use strict';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
// KAPSO_API_BASE_URL and KAPSO_TEST_ALLOW_LOCALHOST are only honoured outside production.
const KAPSO_BASE = (!IS_PROD && process.env.KAPSO_API_BASE_URL) || 'https://api.kapso.ai/meta/whatsapp/v24.0';

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

async function sendWhatsAppImage(to, mediaId, caption, creds) {
  const { messagesUrl, jsonHeaders } = getApiConfig(creds);
  const res = await fetch(messagesUrl(creds.phoneNumberId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { id: mediaId, ...(caption ? { caption } : {}) },
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

// Host allowlist for incoming Kapso media URLs.
const KAPSO_HOST_RE = /^(?:[a-z0-9-]+\.)?kapso\.ai$/i;

function isAllowedKapsoHost(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!IS_PROD && process.env.KAPSO_TEST_ALLOW_LOCALHOST === '1' && u.hostname === 'localhost') return true;
    return u.protocol === 'https:' && KAPSO_HOST_RE.test(u.hostname);
  } catch { return false; }
}

async function readBodyCapped(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`too_large:streaming=${total}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

// Follows redirects manually: each hop must be https; X-API-Key only sent to Kapso hosts.
async function fetchManual(initialUrl, headers, maxHops) {
  let url = initialUrl;
  let hdrs = headers || {};
  for (let hops = 0; ; hops++) {
    const res = await fetch(url, {
      headers: hdrs,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hops >= maxHops) throw new Error(`too_many_redirects:hops=${hops + 1}`);
      const next = new URL(loc, url);
      if (next.protocol !== 'https:') throw new Error(`redirect_not_https:${next.protocol}`);
      url = next.href;
      hdrs = isAllowedKapsoHost(url) ? hdrs : {};
      continue;
    }
    return res;
  }
}

async function downloadKapsoMedia(mediaUrl, mediaId, phoneNumberId) {
  const MAX_BYTES = 5 * 1024 * 1024;
  const apiKey = process.env.KAPSO_API_KEY || '';

  if (mediaUrl) {
    if (!isAllowedKapsoHost(mediaUrl)) {
      const hostname = (() => { try { return new URL(mediaUrl).hostname; } catch { return 'invalid'; } })();
      const err = new Error('blocked:host_not_allowed');
      err.hostname = hostname;
      throw err;
    }
    let dlRes = await fetchManual(mediaUrl, {}, 3);
    if ((dlRes.status === 401 || dlRes.status === 403) && apiKey) {
      dlRes = await fetchManual(mediaUrl, { 'X-API-Key': apiKey }, 3);
    }
    if (dlRes.ok) {
      const contentType = (dlRes.headers.get('content-type') || '').split(';')[0].trim();
      const cl = parseInt(dlRes.headers.get('content-length') || '0', 10);
      if (cl > MAX_BYTES) throw new Error(`too_large:content_length=${cl}`);
      const buf = await readBodyCapped(dlRes, MAX_BYTES);
      return { buffer: buf, contentType };
    }
    if (!mediaId) throw new Error(`media_url_failed:status=${dlRes.status}`);
  }

  if (!mediaId) throw new Error('no_media_url_and_no_media_id');

  // Plan B: Kapso resolves download_url (token embedded, no auth needed for download)
  const resolveUrl = `${KAPSO_BASE}/${mediaId}?phone_number_id=${encodeURIComponent(phoneNumberId || '')}`;
  const resolveRes = await fetchManual(resolveUrl, { 'X-API-Key': apiKey }, 1);
  if (!resolveRes.ok) throw new Error(`resolve_failed:status=${resolveRes.status}`);
  const resolveData = await resolveRes.json();
  const downloadUrl = resolveData.download_url;
  if (!downloadUrl) throw new Error('resolve_no_download_url');
  if (!isAllowedKapsoHost(downloadUrl)) {
    const hostname = (() => { try { return new URL(downloadUrl).hostname; } catch { return 'invalid'; } })();
    const err = new Error('resolve_download_url_host_not_allowed');
    err.hostname = hostname;
    throw err;
  }
  const dlRes2 = await fetchManual(downloadUrl, {}, 3);
  if (!dlRes2.ok) throw new Error(`download_failed:status=${dlRes2.status}`);
  const contentType2 = (dlRes2.headers.get('content-type') || '').split(';')[0].trim();
  const buf2 = await readBodyCapped(dlRes2, MAX_BYTES);
  return { buffer: buf2, contentType: contentType2 };
}

module.exports = { sendWhatsAppMessage, uploadMedia, sendWhatsAppAudio, sendWhatsAppDocument, sendWhatsAppImage, markAsRead, sendTypingIndicator, downloadKapsoMedia, isAllowedKapsoHost };
