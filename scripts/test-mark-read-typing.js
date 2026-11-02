/**
 * Tests for markReadAndTyping and updated splitAndSend behavior.
 * Run: node scripts/test-mark-read-typing.js
 */

const { splitAndSend, markReadAndTyping } = require('../src/whatsapp');

let passed = 0;
let failed = 0;

function ok(label, condition, extra = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
    failed++;
  }
}

// ── CALL ORDER: Meta 2-part split ────────────────────────────────────────────
// Simulates: server.js calls markReadAndTyping, then splitAndSend handles parts 2+.

console.log('\n--- call order: Meta split (2 parts) ---');

async function runOrderTest() {
  const log = [];
  const markFn = async (msgId) => {
    log.push({ type: 'markReadTyping', msgId, at: Date.now() });
  };
  const sendFn = async (phone, text) => {
    log.push({ type: 'send', text, at: Date.now() });
  };

  // Simulate server.js calling markReadAndTyping before splitAndSend (part 0).
  await markFn('wamid.test');

  const result = await splitAndSend(['Part 1', 'Part 2'], {
    customerPhone: '+1234',
    waCredentials: { provider: 'meta', phoneNumberId: 'test-pnid' },
    msgId: 'wamid.test',
    _sendFn: sendFn,
    _markReadTypingFn: markFn,
  });

  ok('fullySent', result.fullySent);
  ok('4 log entries: markRead, send1, markRead, send2', log.length === 4, `got ${log.length}`);
  ok('entry 0: markReadTyping (server.js call before send)', log[0]?.type === 'markReadTyping');
  ok('entry 1: send Part 1', log[1]?.type === 'send' && log[1]?.text === 'Part 1');
  ok('entry 2: markReadTyping (before Part 2)', log[2]?.type === 'markReadTyping');
  ok('entry 3: send Part 2', log[3]?.type === 'send' && log[3]?.text === 'Part 2');
  ok('markReadTyping uses correct msgId', log[0]?.msgId === 'wamid.test' && log[2]?.msgId === 'wamid.test');
  ok('markReadTyping before Part 2 fires before that send', log[2]?.at <= log[3]?.at);
}

// ── CALL ORDER: Meta 4-part split ────────────────────────────────────────────

console.log('\n--- call order: Meta split (4 parts) ---');

async function runOrderTest4() {
  const log = [];
  const markFn = async (msgId) => { log.push({ type: 'mark', msgId }); };
  const sendFn = async (phone, text) => { log.push({ type: 'send', text }); };

  // Simulate server.js pre-call.
  await markFn('wamid.test');

  await splitAndSend(['A', 'B', 'C', 'D'], {
    customerPhone: '+1234',
    waCredentials: { provider: 'meta', phoneNumberId: 'test-pnid' },
    msgId: 'wamid.test',
    _sendFn: sendFn,
    _markReadTypingFn: markFn,
  });

  // Expected: mark, sendA, mark, sendB, mark, sendC, mark, sendD
  ok('8 log entries for 4-part split', log.length === 8, `got ${log.length}`);
  const marks = log.filter(e => e.type === 'mark');
  const sends = log.filter(e => e.type === 'send');
  ok('4 markReadTyping calls (1 from server.js + 3 from splitAndSend)', marks.length === 4);
  ok('4 sends', sends.length === 4);
  ok('order starts with mark, ends with sendD', log[0].type === 'mark' && log[7].text === 'D');
}

// ── SINGLE PART: no internal markReadTyping ───────────────────────────────────

console.log('\n--- single part: no internal markReadTyping ---');

async function runSinglePartTest() {
  const marked = [];
  const result = await splitAndSend(['Solo parte'], {
    customerPhone: '+1234',
    waCredentials: { provider: 'meta', phoneNumberId: 'test-pnid' },
    msgId: 'wamid.test',
    _sendFn: async () => {},
    _markReadTypingFn: async () => { marked.push(1); },
  });
  ok('fullySent', result.fullySent);
  ok('no internal markReadTyping for single part (server.js handles part 0)', marked.length === 0,
    `called ${marked.length} times`);
}

// ── NOT CALLED WHEN msgId=null (needsHuman path) ──────────────────────────────
// server.js passes msgId=null to splitAndSend when needsHuman=true.

console.log('\n--- not called when msgId=null (needsHuman path) ---');

async function runNeedsHumanTest() {
  const marked = [];
  const result = await splitAndSend(['Part 1', 'Part 2'], {
    customerPhone: '+1234',
    waCredentials: { provider: 'meta', phoneNumberId: 'test-pnid' },
    msgId: null,
    _sendFn: async () => {},
    _markReadTypingFn: async () => { marked.push(1); },
    _typingFn: async () => {},
  });
  ok('fullySent', result.fullySent);
  ok('markReadAndTyping not called when msgId=null', marked.length === 0, `called ${marked.length} times`);
}

// ── KAPSO PROVIDER: uses sendTypingIndicator, not markReadAndTyping ───────────

console.log('\n--- Kapso provider: typing not replaced ---');

async function runKapsoTest() {
  const marked = [];
  const typingCalls = [];
  const result = await splitAndSend(['Part 1', 'Part 2'], {
    customerPhone: '+1234',
    waCredentials: { provider: 'kapso', phoneNumberId: 'test-pnid' },
    msgId: 'wamid.test',
    _sendFn: async () => {},
    _markReadTypingFn: async () => { marked.push(1); },
    _typingFn: async () => { typingCalls.push(1); },
  });
  ok('fullySent', result.fullySent);
  ok('markReadAndTyping not called for Kapso', marked.length === 0, `called ${marked.length} times`);
  ok('sendTypingIndicator called for both Kapso parts', typingCalls.length === 2, `got ${typingCalls.length}`);
}

// ── markReadAndTyping: error logging ─────────────────────────────────────────

console.log('\n--- markReadAndTyping: error logging ---');

async function runErrorTest() {
  // 400 response → log with status and body
  const logged = [];
  await markReadAndTyping(
    'wamid.test',
    { provider: 'meta', phoneNumberId: 'test-pnid', accessToken: 'tok' },
    {
      _doFetch: async () => ({
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"Invalid message ID","code":100}}',
      }),
      _logFn: (ctx, err) => logged.push({ ctx, msg: err.message }),
    }
  );
  ok('error logged on 400', logged.length === 1, `got ${logged.length}`);
  ok('context is markReadAndTyping-error', logged[0]?.ctx === 'markReadAndTyping-error');
  ok('message includes status=400', !!logged[0]?.msg?.includes('status=400'), logged[0]?.msg);
  ok('message includes response body', !!logged[0]?.msg?.includes('Invalid message ID'), logged[0]?.msg);

  // 200 → no log
  const logged2 = [];
  await markReadAndTyping(
    'wamid.test',
    { provider: 'meta', phoneNumberId: 'test-pnid', accessToken: 'tok' },
    {
      _doFetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
      _logFn: (ctx, err) => logged2.push(1),
    }
  );
  ok('no log on 200', logged2.length === 0);

  // Network error → log with network error prefix
  const logged3 = [];
  await markReadAndTyping(
    'wamid.test',
    { provider: 'meta', phoneNumberId: 'test-pnid', accessToken: 'tok' },
    {
      _doFetch: async () => { throw new Error('ECONNREFUSED'); },
      _logFn: (ctx, err) => logged3.push({ ctx, msg: err.message }),
    }
  );
  ok('network error logged', logged3.length === 1, `got ${logged3.length}`);
  ok('network error message included', !!logged3[0]?.msg?.includes('ECONNREFUSED'), logged3[0]?.msg);

  // Non-meta → no-op, no log, no fetch
  const logged4 = [];
  await markReadAndTyping(
    'wamid.test',
    { provider: 'kapso' },
    {
      _doFetch: async () => { throw new Error('should not be called'); },
      _logFn: (ctx, err) => logged4.push(1),
    }
  );
  ok('non-meta: no fetch, no log', logged4.length === 0);

  // No msgId → no-op
  const logged5 = [];
  await markReadAndTyping(
    null,
    { provider: 'meta', phoneNumberId: 'test-pnid', accessToken: 'tok' },
    {
      _doFetch: async () => { throw new Error('should not be called'); },
      _logFn: (ctx, err) => logged5.push(1),
    }
  );
  ok('null msgId: no-op', logged5.length === 0);

  // Meta API hangs → times out after _timeoutMs and logs error.
  // _doFetch keeps a ref'd timer (200ms fallback) so the event loop doesn't drain before
  // AbortSignal.timeout(50) fires (AbortSignal uses an unref'd timer internally).
  const loggedTimeout = [];
  await markReadAndTyping(
    'wamid.test',
    { provider: 'meta', phoneNumberId: 'test-pnid', accessToken: 'tok' },
    {
      _doFetch: (url, opts) => new Promise((_, rej) => {
        const fallback = setTimeout(() => rej(new Error('test-fallback')), 200);
        opts.signal?.addEventListener('abort', () => { clearTimeout(fallback); rej(opts.signal.reason); });
      }),
      _logFn: (ctx, err) => loggedTimeout.push({ ctx, msg: err.message }),
      _timeoutMs: 50,
    }
  );
  ok('timeout: error logged', loggedTimeout.length === 1, `got ${loggedTimeout.length}`);
  ok('timeout: context is markReadAndTyping-error', loggedTimeout[0]?.ctx === 'markReadAndTyping-error');
}

// Run all
Promise.resolve()
  .then(() => runOrderTest())
  .then(() => runOrderTest4())
  .then(() => runSinglePartTest())
  .then(() => runNeedsHumanTest())
  .then(() => runKapsoTest())
  .then(() => runErrorTest())
  .then(() => {
    console.log(`\ntests — ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
