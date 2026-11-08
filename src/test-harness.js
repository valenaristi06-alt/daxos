'use strict';
/**
 * Test harness endpoints — loaded ONLY when ALL THREE hold:
 *   NODE_ENV === 'test'
 *   DAXOS_TEST_HARNESS === '1'
 *   !RAILWAY_ENVIRONMENT
 *
 * Callers must pass the X-Test-Token header with the per-process token
 * printed to stdout at startup. Any mismatch → 404 (not 401, to avoid
 * leaking that the route exists in non-harness deployments).
 */

const crypto = require('crypto');

// Generated once per process — never persisted, never exposed via HTTP.
const TEST_TOKEN = crypto.randomBytes(32).toString('hex');

function register(app, processIncomingMessage, getBusinessById) {
  // Deliver token to the test runner via stdout only.
  process.stdout.write(`[test-harness] token=${TEST_TOKEN}\n`);

  function guardToken(req, res) {
    if (req.headers['x-test-token'] !== TEST_TOKEN) {
      res.status(404).json({ error: 'Not found' });
      return false;
    }
    return true;
  }

  // Queue a mock reply to be returned by the next generateReply() call.
  app.post('/test/mock-reply', (req, res) => {
    if (!guardToken(req, res)) return;
    const { _pushTestMockReply } = require('./claude');
    _pushTestMockReply(req.body.reply);
    res.json({ ok: true });
  });

  // Inject an incoming customer message directly into processIncomingMessage.
  // The fake credentials cause sendWhatsAppMessage to throw; that throw is
  // caught inside processIncomingMessage's send try-catch — it does NOT prevent
  // the booking (createAppointment + recordOwnerAlert) from completing first.
  app.post('/test/inject-message', async (req, res) => {
    if (!guardToken(req, res)) return;
    const { businessId, customerPhone, text } = req.body;
    const business = getBusinessById(Number(businessId));
    if (!business) return res.status(404).json({ error: 'business not found' });
    const fakeCreds = { provider: 'test-noop', phoneNumberId: 'test', accessToken: null };
    try {
      await processIncomingMessage(business, fakeCreds, {
        msgId:             `test-${Date.now()}`,
        customerPhone,
        text,
        msgTimestamp:      null,
        msgTimestampField: null,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
