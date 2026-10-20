'use strict';

const crypto  = require('crypto');
const { validateUrl } = require('./ssrf');
const { scrapeWebsite } = require('./demo-scraper');
const { extractBusinessData } = require('./demo-generator');
const { MSG } = require('./demo-messages');
const db = require('./db');

const GENERATION_TIMEOUT_MS  = 90_000;
const SESSION_EXPIRY_MINUTES = 30;
const FOLLOWUP_DELAY_MS      = 2 * 60 * 60 * 1000; // 2 hours
const DEMO_BASE_URL          = process.env.DEMO_BASE_URL || 'https://daxos.lat';

// Daily rate limits
const LIMIT_PER_IP    = 3;
const LIMIT_PER_PHONE = 2;
const LIMIT_GLOBAL    = 200;

function generateSlug() {
  return crypto.randomBytes(6).toString('base64url');
}

async function sendWhatsApp(waCredentials, to, text) {
  // waCredentials: { accessToken, phoneNumberId }
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${waCredentials.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waCredentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WhatsApp send failed: ${err}`);
  }
}

function isSessionExpired(session) {
  if (!session) return true;
  if (session.state !== 'esperando_link') return false;
  const updated = new Date(session.updated_at).getTime();
  return Date.now() - updated > SESSION_EXPIRY_MINUTES * 60 * 1000;
}

/**
 * Main entry point called from server.js processIncomingMessage.
 * Returns true if the message was fully handled (suppress normal assistant).
 */
async function handleDemoFlow(business, waCredentials, customerPhone, text) {
  const normalizedText = text.trim().toLowerCase();
  const session = db.getDemoFlowSession(customerPhone);

  // ── Activation: exact "demo" with no active session ──────────────────────
  if (normalizedText === 'demo' && (!session || isSessionExpired(session))) {
    if (session) db.deleteDemoFlowSession(customerPhone);

    // Check if existing client (registered business owner) → skip
    const existingUser = db.getUserByPhone(customerPhone);
    if (existingUser) return false; // let normal assistant handle

    db.upsertDemoFlowSession(customerPhone, 'esperando_link', null);
    await sendWhatsApp(waCredentials, customerPhone, MSG.askForUrl);
    return true;
  }

  // ── No active session → not our concern ──────────────────────────────────
  if (!session || isSessionExpired(session)) {
    if (session) db.deleteDemoFlowSession(customerPhone);
    return false;
  }

  // ── State: esperando_link ────────────────────────────────────────────────
  if (session.state === 'esperando_link') {
    const rawUrl = text.trim();

    // Validate URL shape
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    } catch {
      await sendWhatsApp(waCredentials, customerPhone, MSG.invalidUrl);
      return true;
    }
    const cleanUrl = parsedUrl.href;

    try {
      await validateUrl(cleanUrl, { allowHttp: false });
    } catch {
      await sendWhatsApp(waCredentials, customerPhone, MSG.blockedUrl);
      return true;
    }

    // Rate limits
    const ip = null; // IP not available from WhatsApp flow
    if (db.getDemoDailyCountByPhone(customerPhone) >= LIMIT_PER_PHONE) {
      await sendWhatsApp(waCredentials, customerPhone, MSG.rateLimitPhone);
      db.deleteDemoFlowSession(customerPhone);
      return true;
    }
    if (db.getDemoDailyGlobalCount() >= LIMIT_GLOBAL) {
      await sendWhatsApp(waCredentials, customerPhone, MSG.rateLimitGlobal);
      db.deleteDemoFlowSession(customerPhone);
      return true;
    }

    // Move to procesando
    db.upsertDemoFlowSession(customerPhone, 'procesando', null);
    await sendWhatsApp(waCredentials, customerPhone, MSG.generating);

    // Generate demo with timeout
    const start = Date.now();
    let demoRow;
    try {
      const result = await Promise.race([
        (async () => {
          const { pages, jsOnly } = await scrapeWebsite(cleanUrl);
          if (jsOnly) throw Object.assign(new Error('js-only'), { code: 'JS_ONLY' });

          const data = await extractBusinessData(pages, ({ event, inTokens, outTokens }) => {
            db.logDemoCost({ demoId: null, event, inTokens, outTokens });
          });

          const slug = generateSlug();
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const durationMs = Date.now() - start;

          const row = db.createDemo({
            slug,
            dataJson: JSON.stringify(data),
            sourceUrl: cleanUrl,
            whatsappContacto: customerPhone,
            ip,
            durationMs,
            expiresAt,
          });
          return row;
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), GENERATION_TIMEOUT_MS)
        ),
      ]);
      demoRow = result;
    } catch (err) {
      db.deleteDemoFlowSession(customerPhone);
      if (err.code === 'JS_ONLY') {
        await sendWhatsApp(waCredentials, customerPhone, MSG.jsOnly);
      } else if (err.code === 'TIMEOUT') {
        await sendWhatsApp(waCredentials, customerPhone, MSG.generationTimeout);
      } else {
        await sendWhatsApp(waCredentials, customerPhone, MSG.generationError);
      }
      return true;
    }

    const demoUrl = `${DEMO_BASE_URL}/d/${demoRow.slug}`;
    const followupEligibleAt = new Date(Date.now() + FOLLOWUP_DELAY_MS).toISOString();

    db.upsertDemoFlowSession(customerPhone, 'listo', demoRow.slug, { followupEligibleAt });
    await sendWhatsApp(waCredentials, customerPhone, MSG.demoReady(demoUrl));
    return true;
  }

  // ── State: procesando — ignore (duplicate message while generating) ───────
  if (session.state === 'procesando') {
    return true;
  }

  // ── State: listo — user wrote back, mark as replied (disable follow-up) ──
  if (session.state === 'listo') {
    db.upsertDemoFlowSession(customerPhone, 'listo', session.demo_slug, { followup_sent: 1 });
    return false; // let normal assistant respond
  }

  return false;
}

/**
 * Called by setInterval in server.js to send follow-up messages.
 */
async function processFollowups(waCredentials) {
  const sessions = db.getDemosForFollowup();
  for (const s of sessions) {
    try {
      await sendWhatsApp(waCredentials, s.phone, MSG.followUp);
      db.upsertDemoFlowSession(s.phone, 'listo', s.demo_slug, { followup_sent: 1 });
    } catch (err) {
      // Non-fatal: will retry next interval until window closes
    }
  }
}

module.exports = { handleDemoFlow, processFollowups };
