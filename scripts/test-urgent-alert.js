#!/usr/bin/env node
'use strict';
// Integration test for urgent alert notifications with stubbed sends.
// Verifies: correct call args, email failure doesn't block client response,
// 30-minute throttle per conversation.
// Run: node scripts/test-urgent-alert.js

(async () => {
  let passed = 0, failed = 0;

  function assert(desc, actual, expected) {
    if (actual === expected) {
      console.log(`  ✓ ${desc}`);
      passed++;
    } else {
      console.error(`  ✗ ${desc}`);
      console.error(`    expected: ${JSON.stringify(expected)}`);
      console.error(`    actual:   ${JSON.stringify(actual)}`);
      failed++;
    }
  }

  function assertOk(desc, value) {
    if (value) { console.log(`  ✓ ${desc}`); passed++; }
    else { console.error(`  ✗ ${desc}: got ${JSON.stringify(value)}`); failed++; }
  }

  // ── Mirror of server.js helpers ───────────────────────────────────────────

  function normalizePauseText(s) {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim();
  }

  function normalizeUruguayPhone(phone) {
    if (!phone) return null;
    let digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!digits.startsWith('598')) digits = '598' + digits;
    return digits;
  }

  const NEGATION_RE = /\b(no|sin|nada|ningun|ninguna)\b/;

  function matchUrgentKeyword(text, keywordsStr) {
    const kws = keywordsStr.split(',').map(k => normalizePauseText(k)).filter(Boolean);
    const normText = normalizePauseText(text);
    return kws.find(kw => {
      const re = new RegExp(`\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}\\b`);
      const m = re.exec(normText);
      if (!m) return false;
      const wordsBefore = normText.slice(0, m.index).trim().split(/\s+/).slice(-3).join(' ');
      return !NEGATION_RE.test(wordsBefore);
    }) ?? null;
  }

  // ── notifyOwnerUrgent with injectable stubs ───────────────────────────────
  // Mirrors src/server.js lines 1573-1611 exactly, but sendEmail/sendWA injected.

  async function notifyOwnerUrgent({ business, owner, contactId, messageText, conversationId, waCredentials, now, sendEmail, sendWA }) {
    const convUrl = `https://daxos.lat/conversations.html?conv=${conversationId}`;
    if (!owner) return false;

    let emailOk = false;
    try {
      await Promise.race([
        sendEmail({ to: owner.email, businessName: business.name, contactId, messageText, conversationId, convUrl, now }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('email timeout 5000ms')), 5000)),
      ]);
      emailOk = true;
    } catch (_err) {
      // email failed — intentionally not re-thrown; client response unaffected
    }

    const normPhone    = normalizeUruguayPhone(owner.phone);
    const normBizPhone = normalizeUruguayPhone(business.whatsapp_number);
    if (normPhone && waCredentials && normPhone !== normBizPhone) {
      const waMsg = `🚨 URGENTE — ${business.name}\nCliente: ${contactId}\nMensaje: ${messageText}\nAbrir: ${convUrl}`;
      // fire-and-forget, same as server.js
      sendWA(normPhone, waMsg, waCredentials).catch(() => {});
    }

    return emailOk;
  }

  // ── Webhook handler excerpt with injectable throttle + stubs ──────────────
  // Mirrors server.js lines 2039-2074. `now` param lets tests control time.

  function makeFlow() {
    const urgentAlertThrottle = new Map();
    const THROTTLE_MS = 30 * 60 * 1000;

    async function handleIncoming({ business, owner, contactId, messageText, conversationId, waCredentials, nowMs, sendEmail, sendWA }) {
      // Simulate AI response generation — always returns regardless of alert
      const clientResponse = `Respuesta AI para: ${messageText}`;

      if (business.urgent_alert_enabled && business.urgent_keywords) {
        const matchedKw = matchUrgentKeyword(messageText, business.urgent_keywords);
        if (matchedKw) {
          const lastAlert = urgentAlertThrottle.get(conversationId);
          if (lastAlert && nowMs - lastAlert <= THROTTLE_MS) {
            // throttled — no alert, but client response still sent
          } else {
            urgentAlertThrottle.set(conversationId, nowMs);
            // fire-and-forget, same as server.js — does NOT await
            notifyOwnerUrgent({
              business, owner, contactId, messageText, conversationId,
              waCredentials, now: new Date(nowMs), sendEmail, sendWA,
            }).then(emailOk => {
              if (!emailOk) urgentAlertThrottle.delete(conversationId);
            }).catch(() => {
              urgentAlertThrottle.delete(conversationId);
            });
          }
        }
      }

      return clientResponse;
    }

    function getThrottleEntry(conversationId) {
      return urgentAlertThrottle.get(conversationId);
    }

    return { handleIncoming, getThrottleEntry };
  }

  // ── Stub factory ──────────────────────────────────────────────────────────

  function makeStubs({ emailShouldFail = false } = {}) {
    const emailCalls = [];
    const waCalls = [];
    async function stubEmail(args) {
      emailCalls.push({ ...args });
      if (emailShouldFail) throw new Error('Resend 500: simulated failure');
    }
    async function stubWA(to, message, credentials) {
      waCalls.push({ to, message, credentials });
    }
    return { emailCalls, waCalls, stubEmail, stubWA };
  }

  // ── Test fixtures ─────────────────────────────────────────────────────────

  const biz = {
    id: 'biz-test',
    name: 'Clínica Test',
    urgent_alert_enabled: 1,
    urgent_keywords: 'urgente, emergencia',
    whatsapp_number: '59899000000', // different from owner phone
  };
  const owner = { email: 'dueno@test.com', phone: '099111222' };
  const waCreds = { phoneNumberId: 'pid123', provider: 'meta' };
  const BASE_NOW = Date.now();

  // ── Suite 1: args correctos al detectar keyword ───────────────────────────

  console.log('\n── Suite 1: sendUrgentAlertEmail y sendWhatsAppMessage reciben args correctos ──');
  {
    const { emailCalls, waCalls, stubEmail, stubWA } = makeStubs();
    const flow = makeFlow();

    const clientReply = await flow.handleIncoming({
      business: biz, owner,
      contactId: '59891234567',
      messageText: 'necesito ayuda urgente por favor',
      conversationId: 'conv-suite1',
      waCredentials: waCreds,
      nowMs: BASE_NOW,
      sendEmail: stubEmail,
      sendWA: stubWA,
    });

    // wait for fire-and-forget promises to settle
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert('email llamado 1 vez',                 emailCalls.length, 1);
    assert('email.to correcto',                   emailCalls[0]?.to, 'dueno@test.com');
    assert('email.businessName correcto',         emailCalls[0]?.businessName, 'Clínica Test');
    assert('email.contactId correcto',            emailCalls[0]?.contactId, '59891234567');
    assert('email.messageText correcto',          emailCalls[0]?.messageText, 'necesito ayuda urgente por favor');
    assertOk('email.convUrl contiene conv id',    emailCalls[0]?.convUrl?.includes('conv-suite1'));

    assert('WA llamado 1 vez',                    waCalls.length, 1);
    assert('WA.to normalizado',                   waCalls[0]?.to, '59899111222');
    assertOk('WA mensaje empieza con 🚨 URGENTE', waCalls[0]?.message?.startsWith('🚨 URGENTE'));
    assertOk('WA mensaje contiene nombre negocio',waCalls[0]?.message?.includes('Clínica Test'));
    assertOk('WA mensaje contiene contactId',     waCalls[0]?.message?.includes('59891234567'));
    assertOk('WA mensaje contiene messageText',   waCalls[0]?.message?.includes('necesito ayuda urgente por favor'));
    assertOk('cliente recibe respuesta AI',       typeof clientReply === 'string' && clientReply.length > 0);
  }

  // ── Suite 2: fallo de email no bloquea respuesta al cliente ──────────────

  console.log('\n── Suite 2: fallo de email no bloquea respuesta al cliente ──');
  {
    const { emailCalls, waCalls, stubEmail, stubWA } = makeStubs({ emailShouldFail: true });
    const flow = makeFlow();

    const t0 = Date.now();
    const clientReply = await flow.handleIncoming({
      business: biz, owner,
      contactId: '59891234567',
      messageText: 'tengo una emergencia',
      conversationId: 'conv-suite2',
      waCredentials: waCreds,
      nowMs: BASE_NOW,
      sendEmail: stubEmail,
      sendWA: stubWA,
    });
    const elapsed = Date.now() - t0;

    // wait for fire-and-forget to settle
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assertOk('handleIncoming resuelve sin await el notify', elapsed < 50);
    assertOk('cliente recibe respuesta AI aunque email falle', typeof clientReply === 'string' && clientReply.length > 0);
    assert('email intentado (stub llamado)',      emailCalls.length, 1);
    // throttle entry deleted on email failure → allows retry next message
    assertOk('throttle borrado tras fallo (permite retry)', flow.getThrottleEntry('conv-suite2') === undefined);
    // WA is fire-and-forget, may or may not have resolved yet; assert it was attempted
    await new Promise(r => setTimeout(r, 50));
    assert('WA igualmente intentado aunque email falle', waCalls.length, 1);
  }

  // ── Suite 3: throttle 30 min — no más de un aviso por conversación ────────

  console.log('\n── Suite 3: throttle 30 min — no segundo aviso en misma ventana ──');
  {
    const { emailCalls, waCalls, stubEmail, stubWA } = makeStubs();
    const flow = makeFlow();

    const T0 = BASE_NOW;
    const T1 = BASE_NOW + 10 * 60 * 1000; // +10 min (dentro de ventana)
    const T2 = BASE_NOW + 31 * 60 * 1000; // +31 min (fuera de ventana)

    // Primer mensaje — dispara aviso
    await flow.handleIncoming({
      business: biz, owner,
      contactId: '59891234567',
      messageText: 'esto es urgente',
      conversationId: 'conv-suite3',
      waCredentials: waCreds,
      nowMs: T0,
      sendEmail: stubEmail,
      sendWA: stubWA,
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert('primer mensaje: email enviado',   emailCalls.length, 1);
    assert('primer mensaje: WA enviado',      waCalls.length,    1);

    // Segundo mensaje dentro de 30 min — throttled
    await flow.handleIncoming({
      business: biz, owner,
      contactId: '59891234567',
      messageText: 'urgente sigo esperando',
      conversationId: 'conv-suite3',
      waCredentials: waCreds,
      nowMs: T1,
      sendEmail: stubEmail,
      sendWA: stubWA,
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert('segundo mensaje (10 min): email NO enviado', emailCalls.length, 1);
    assert('segundo mensaje (10 min): WA NO enviado',    waCalls.length,    1);

    // Tercer mensaje después de 31 min — ventana expiró, dispara de nuevo
    await flow.handleIncoming({
      business: biz, owner,
      contactId: '59891234567',
      messageText: 'necesito ayuda urgente',
      conversationId: 'conv-suite3',
      waCredentials: waCreds,
      nowMs: T2,
      sendEmail: stubEmail,
      sendWA: stubWA,
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert('tercer mensaje (31 min): email enviado',  emailCalls.length, 2);
    assert('tercer mensaje (31 min): WA enviado',     waCalls.length,    2);

    // Distinta conversación — su propio contador
    const { emailCalls: ec2, waCalls: wc2, stubEmail: se2, stubWA: sw2 } = makeStubs();
    await flow.handleIncoming({
      business: biz, owner,
      contactId: '59897654321',
      messageText: 'urgente',
      conversationId: 'conv-suite3-other',
      waCredentials: waCreds,
      nowMs: T1, // mismo momento que el segundo mensaje de la otra conv
      sendEmail: se2,
      sendWA: sw2,
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert('conv diferente no bloqueada por throttle de suite3', ec2.length, 1);
  }

  // ── Suite 4: keyword negada no dispara ────────────────────────────────────

  console.log('\n── Suite 4: keyword negada no dispara aviso ──');
  {
    const { emailCalls, waCalls, stubEmail, stubWA } = makeStubs();
    const flow = makeFlow();

    await flow.handleIncoming({
      business: biz, owner,
      contactId: '59891234567',
      messageText: 'no es urgente tranquilo',
      conversationId: 'conv-suite4',
      waCredentials: waCreds,
      nowMs: BASE_NOW,
      sendEmail: stubEmail,
      sendWA: stubWA,
    });
    await new Promise(r => setImmediate(r));

    assert('keyword negada: email NO enviado', emailCalls.length, 0);
    assert('keyword negada: WA NO enviado',    waCalls.length,    0);
  }

  // ── Suite 5: negación bloquea solo la keyword que sigue, no otras ─────────
  // "no es urgente pero sangra" → "urgente" negado, "sangra" match → dispara
  // "no es nada grave, solo quiero vacunar" → ninguna keyword → no dispara

  console.log('\n── Suite 5: negación parcial — otra keyword en mismo mensaje dispara ──');
  {
    const bizSangra = { ...biz, urgent_keywords: 'urgente, sangra' };

    // caso 1: "urgente" negado pero "sangra" presente → debe disparar
    {
      const { emailCalls, waCalls, stubEmail, stubWA } = makeStubs();
      const flow = makeFlow();

      await flow.handleIncoming({
        business: bizSangra, owner,
        contactId: '59891234567',
        messageText: 'no es urgente pero sangra mucho',
        conversationId: 'conv-suite5a',
        waCredentials: waCreds,
        nowMs: BASE_NOW,
        sendEmail: stubEmail,
        sendWA: stubWA,
      });
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      assert('"no es urgente pero sangra": email enviado',  emailCalls.length, 1);
      assert('"no es urgente pero sangra": WA enviado',     waCalls.length,    1);
    }

    // caso 2: ninguna keyword presente → no debe disparar
    {
      const { emailCalls, waCalls, stubEmail, stubWA } = makeStubs();
      const flow = makeFlow();

      await flow.handleIncoming({
        business: bizSangra, owner,
        contactId: '59891234567',
        messageText: 'no es nada grave, solo quiero vacunar',
        conversationId: 'conv-suite5b',
        waCredentials: waCreds,
        nowMs: BASE_NOW,
        sendEmail: stubEmail,
        sendWA: stubWA,
      });
      await new Promise(r => setImmediate(r));

      assert('"solo quiero vacunar": email NO enviado',  emailCalls.length, 0);
      assert('"solo quiero vacunar": WA NO enviado',     waCalls.length,    0);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
