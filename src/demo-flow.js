'use strict';

const crypto  = require('crypto');
const { validateUrl } = require('./ssrf');
const { scrapeWebsite } = require('./demo-scraper');
const { extractBusinessData } = require('./demo-generator');
const { MSG } = require('./demo-messages');
const { sendWhatsAppMessage } = require('./whatsapp');
const db = require('./db');

const GENERATION_TIMEOUT_MS  = 90_000;
const SESSION_EXPIRY_MINUTES = 30;
const FOLLOWUP_DELAY_MS      = 2 * 60 * 60 * 1000; // 2 hours
const DEMO_BASE_URL          = process.env.DEMO_BASE_URL || 'https://daxos.lat';

// Daily rate limits
const LIMIT_PER_IP    = 5;
const LIMIT_PER_PHONE = 3;
const LIMIT_GLOBAL    = 200;

// States that expire after SESSION_EXPIRY_MINUTES of inactivity
const EXPIRING_STATES = new Set([
  'esperando_link',
  'esperando_link_warned',
  'esperando_texto',
  'esperando_texto_warned',
]);

// Social media domains — user is prompted to share text instead
const SOCIAL_DOMAINS = [
  'instagram.com', 'facebook.com', 'fb.com', 'tiktok.com',
  'twitter.com', 'x.com', 'linkedin.com',
];

// Exact normalized triggers for "I don't have a website"
const NO_TIENE_TRIGGERS = new Set(['no tengo', 'no tengo web', 'no tengo sitio', 'no tengo pagina']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Normalize for activation check: lowercase, strip accents, strip non-alphanumeric.
// "DEMO", "démò", "¡demo!", "🎯 demo" all → "demo".
// "quiero una demo" → "quierounademo" (does NOT equal "demo").
function normalizeActivation(s) {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Thin wrapper — delegates to shared sendWhatsAppMessage (handles Meta and Kapso)
async function sendWA(waCredentials, to, text) {
  return sendWhatsAppMessage(to, text, waCredentials);
}

// Pure function — accepts optional nowMs for testing
function isSessionExpired(session, nowMs = Date.now()) {
  if (!session) return true;
  if (!EXPIRING_STATES.has(session.state)) return false;
  return nowMs - new Date(session.updated_at).getTime() > SESSION_EXPIRY_MINUTES * 60 * 1000;
}

function generateSlug() {
  return crypto.randomBytes(6).toString('base64url');
}

// Returns true if the string looks like a URL (no spaces, has dot-separated host)
function looksLikeUrl(s) {
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z]{2,}){1,}(\/|$)/i.test(s)) return true;
  return false;
}

function isSocialMedia(hostname) {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  return SOCIAL_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

// ─── Data quality gate ───────────────────────────────────────────────────────

// Returns true if extracted data has enough content to build a useful demo.
// Rule: (nombre AND ≥1 real content block) OR (≥2 servicios without nombre).
// Content blocks: servicios≥1, preguntas_frecuentes≥1, promos≥1,
//                 sede with horario/direccion/telefono, or descripcion≥80 chars.
function hasEnoughData(data) {
  const nombre = !!data.nombre;
  const hasContent = (
    (data.servicios || []).length >= 1 ||
    (data.preguntas_frecuentes || []).length >= 1 ||
    (data.promos || []).length >= 1 ||
    (data.sedes || []).some(s => s && (s.horario || s.direccion || s.telefono)) ||
    (data.descripcion || '').length >= 80
  );
  if (nombre && hasContent) return true;
  if ((data.servicios || []).length >= 2) return true;
  return false;
}

// ─── Demo generation (shared by URL and text paths) ──────────────────────────

async function runGeneration(pages, sourceUrl, customerPhone, ip, waCredentials) {
  // Rate limits
  if (db.getDemoDailyCountByPhone(customerPhone) >= LIMIT_PER_PHONE) {
    await sendWA(waCredentials, customerPhone, MSG.rateLimitPhone);
    db.deleteDemoFlowSession(customerPhone);
    return { ok: false };
  }
  if (db.getDemoDailyGlobalCount() >= LIMIT_GLOBAL) {
    await sendWA(waCredentials, customerPhone, MSG.rateLimitGlobal);
    db.deleteDemoFlowSession(customerPhone);
    return { ok: false };
  }

  db.upsertDemoFlowSession(customerPhone, 'procesando', null);
  await sendWA(waCredentials, customerPhone, MSG.generating);

  const start = Date.now();
  try {
    const result = await Promise.race([
      (async () => {
        const data = await extractBusinessData(pages, ({ event, inTokens, outTokens }) => {
          db.logDemoCost({ demoId: null, event, inTokens, outTokens });
        });
        if (!hasEnoughData(data)) {
          throw Object.assign(new Error('insufficient data'), { code: 'INSUFFICIENT_DATA' });
        }
        const slug      = generateSlug();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const row = db.createDemo({
          slug,
          dataJson: JSON.stringify(data),
          sourceUrl,
          whatsappContacto: customerPhone,
          ip,
          durationMs: Date.now() - start,
          expiresAt,
        });
        return { row, data };
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), GENERATION_TIMEOUT_MS)
      ),
    ]);

    const { row, data } = result;
    const demoUrl  = `${DEMO_BASE_URL}/d/${row.slug}`;
    const nombre   = data.nombre || null;
    const followupEligibleAt = new Date(Date.now() + FOLLOWUP_DELAY_MS).toISOString();

    db.upsertDemoFlowSession(customerPhone, 'listo', row.slug, { followup_eligible_at: followupEligibleAt });
    await sendWA(waCredentials, customerPhone, MSG.delivery(nombre, demoUrl));
    return { ok: true };

  } catch (err) {
    if (err.code === 'TIMEOUT') {
      db.upsertDemoFlowSession(customerPhone, 'esperando_texto', null);
      await sendWA(waCredentials, customerPhone, MSG.generationTimeout);
    } else if (err.code === 'INSUFFICIENT_DATA') {
      db.upsertDemoFlowSession(customerPhone, 'esperando_texto', null);
      await sendWA(waCredentials, customerPhone, MSG.needsText);
    } else {
      db.upsertDemoFlowSession(customerPhone, 'esperando_texto', null);
      await sendWA(waCredentials, customerPhone, MSG.generationError);
    }
    return { ok: false };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Returns true if the message was fully handled (suppress normal assistant).
 */
async function handleDemoFlow(business, waCredentials, customerPhone, text) {
  const normalizedText = text.trim().toLowerCase();
  const session        = db.getDemoFlowSession(customerPhone);

  // ── Activation: "demo" after normalization (strips accents/punctuation/emoji)
  //    "¡Demo!" and "DEMO" activate; "quiero una demo" does NOT
  if (normalizeActivation(text) === 'demo' && (!session || isSessionExpired(session))) {
    if (session) db.deleteDemoFlowSession(customerPhone);

    const existingUser = db.getUserByPhone(customerPhone);
    if (existingUser) return false; // registered owner → normal assistant

    db.upsertDemoFlowSession(customerPhone, 'esperando_link', null);
    await sendWA(waCredentials, customerPhone, MSG.askForUrl);
    return true;
  }

  // ── No active session (or expired) → not demo flow ───────────────────────
  if (!session || isSessionExpired(session)) {
    if (session) db.deleteDemoFlowSession(customerPhone);
    return false;
  }

  // ── State: esperando_link / esperando_link_warned ─────────────────────────
  if (session.state === 'esperando_link' || session.state === 'esperando_link_warned') {
    const rawInput = text.trim();

    // (b) "no tengo" variants → switch to text mode
    if (NO_TIENE_TRIGGERS.has(normalizedText)) {
      db.upsertDemoFlowSession(customerPhone, 'esperando_texto', null);
      await sendWA(waCredentials, customerPhone, MSG.needsText);
      return true;
    }

    // (a) URL-like input
    if (looksLikeUrl(rawInput)) {
      let parsedUrl;
      try {
        parsedUrl = new URL(/^https?:\/\//i.test(rawInput) ? rawInput : `https://${rawInput}`);
      } catch {
        // Falls through to (d)
      }
      if (parsedUrl) {
        const hostname = parsedUrl.hostname;

        // Social media → keep session, prompt for text
        if (isSocialMedia(hostname)) {
          await sendWA(waCredentials, customerPhone, MSG.socialMedia);
          return true;
        }

        // SSRF check
        try {
          await validateUrl(parsedUrl.href, { allowHttp: false });
        } catch {
          await sendWA(waCredentials, customerPhone, MSG.blockedUrl);
          return true; // keep session — they can try another URL
        }

        // Scrape + generate
        let pages;
        try {
          const result = await scrapeWebsite(parsedUrl.href);
          if (result.jsOnly) {
            db.upsertDemoFlowSession(customerPhone, 'esperando_texto', null);
            await sendWA(waCredentials, customerPhone, MSG.needsText);
            return true;
          }
          pages = result.pages;
        } catch {
          db.upsertDemoFlowSession(customerPhone, 'esperando_texto', null);
          await sendWA(waCredentials, customerPhone, MSG.needsText);
          return true;
        }

        await runGeneration(pages, parsedUrl.href, customerPhone, null, waCredentials);
        return true;
      }
    }

    // (c) Long message without URL → treat as pasted text
    if (rawInput.length >= 60) {
      const pastedText = rawInput.slice(0, 10_000);
      await runGeneration(
        [{ url: 'info-directa', text: pastedText }],
        'info-directa',
        customerPhone, null, waCredentials
      );
      return true;
    }

    // (d) Short / unrecognized → warn once, then release
    if (session.state === 'esperando_link_warned') {
      db.deleteDemoFlowSession(customerPhone);
      return true; // silent release
    }
    db.upsertDemoFlowSession(customerPhone, 'esperando_link_warned', null);
    await sendWA(waCredentials, customerPhone, MSG.invalidUrl);
    return true;
  }

  // ── State: esperando_texto / esperando_texto_warned ───────────────────────
  if (session.state === 'esperando_texto' || session.state === 'esperando_texto_warned') {
    const rawInput = text.trim();

    if (rawInput.length >= 40) {
      const pastedText = rawInput.slice(0, 10_000);
      await runGeneration(
        [{ url: 'info-directa', text: pastedText }],
        'info-directa',
        customerPhone, null, waCredentials
      );
      return true;
    }

    // Too short → warn once, then release
    if (session.state === 'esperando_texto_warned') {
      db.deleteDemoFlowSession(customerPhone);
      return true; // silent release
    }
    db.upsertDemoFlowSession(customerPhone, 'esperando_texto_warned', null);
    await sendWA(waCredentials, customerPhone, MSG.textTooShort);
    return true;
  }

  // ── State: procesando — ignore duplicates while generating ────────────────
  if (session.state === 'procesando') {
    return true;
  }

  // ── State: listo — user wrote back; cancel follow-up, let assistant reply ─
  if (session.state === 'listo') {
    db.upsertDemoFlowSession(customerPhone, 'listo', session.demo_slug, { followup_sent: 1 });
    return false;
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
      await sendWA(waCredentials, s.phone, MSG.followUp);
      db.upsertDemoFlowSession(s.phone, 'listo', s.demo_slug, { followup_sent: 1 });
    } catch {
      // Non-fatal — will retry next interval until 22h window closes
    }
  }
}

module.exports = {
  handleDemoFlow,
  processFollowups,
  // Exported for testing only
  isSessionExpired,
  normalizeActivation,
  hasEnoughData,
  SESSION_EXPIRY_MINUTES,
  FOLLOWUP_DELAY_MS,
  EXPIRING_STATES,
};
