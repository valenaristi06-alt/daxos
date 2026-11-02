/**
 * Tests for per-client serialization queue (_enqueueForClient).
 * Extracted and tested in isolation — no server needed.
 *
 * Run: node scripts/test-client-queue.js
 */

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

// ── Inline replica of _enqueueForClient ────────────────────────────────────
// (Identical logic to server.js; kept here so the test has no server dep.)

const _clientQueue = new Map();
const TIMEOUT_MS = 90_000; // use full value; override per-test via _timeoutMs

function makeEnqueue(timeoutMs = TIMEOUT_MS) {
  const queue = new Map();
  const loggedErrors = [];
  function logError(ctx, err) { loggedErrors.push({ ctx, msg: err.message }); }

  function enqueue(key, fn) {
    const prev = queue.get(key) ?? Promise.resolve();
    const next = prev.then(() => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('client-queue-timeout')), timeoutMs)
      );
      return Promise.race([fn(), timeout]).catch(err => {
        logError('client-queue-error', err);
      });
    });
    queue.set(key, next);
    next.finally(() => {
      if (queue.get(key) === next) queue.delete(key);
    });
    return next;
  }

  return { enqueue, queue, loggedErrors };
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function runTests() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 1. Same client: two messages processed in order
  console.log('\n--- Same client: sequential order ---');
  {
    const { enqueue } = makeEnqueue();
    const order = [];
    const p1 = enqueue('biz1:+111', async () => {
      await sleep(30);
      order.push('msg1');
    });
    const p2 = enqueue('biz1:+111', async () => {
      order.push('msg2');
    });
    await Promise.all([p1, p2]);
    ok('msg1 before msg2', order[0] === 'msg1' && order[1] === 'msg2',
      JSON.stringify(order));
    ok('both processed', order.length === 2);
  }

  // 2. Different clients: do NOT block each other
  console.log('\n--- Different clients: parallel ---');
  {
    const { enqueue } = makeEnqueue();
    const order = [];
    const t0 = Date.now();
    const p1 = enqueue('biz1:+111', async () => {
      await sleep(50);
      order.push({ key: 'A', elapsed: Date.now() - t0 });
    });
    const p2 = enqueue('biz1:+222', async () => {
      await sleep(10);
      order.push({ key: 'B', elapsed: Date.now() - t0 });
    });
    await Promise.all([p1, p2]);
    // B should finish before A (parallel: B is 10ms, A is 50ms)
    ok('different clients run in parallel (B finishes before A)',
      order[0].key === 'B' && order[1].key === 'A',
      JSON.stringify(order.map(o => o.key)));
    ok('total time < 80ms (not sequential 60ms+50ms)',
      Date.now() - t0 < 80);
  }

  // 3. Failure in one message doesn't block the next
  console.log('\n--- Failure does not block next message ---');
  {
    const { enqueue, loggedErrors } = makeEnqueue();
    const order = [];
    const p1 = enqueue('biz1:+111', async () => {
      throw new Error('simulated send failure');
    });
    const p2 = enqueue('biz1:+111', async () => {
      order.push('msg2-after-failure');
    });
    await Promise.all([p1, p2]);
    ok('msg2 processed after msg1 failure', order[0] === 'msg2-after-failure');
    ok('failure logged', loggedErrors.length === 1 && loggedErrors[0].msg === 'simulated send failure');
  }

  // 4. Timeout: hung processing doesn't block next message
  console.log('\n--- Timeout: hung message unblocks queue ---');
  {
    const { enqueue, loggedErrors } = makeEnqueue(80); // 80ms timeout
    const order = [];
    const t0 = Date.now();
    const p1 = enqueue('biz1:+111', async () => {
      await sleep(300); // longer than timeout
      order.push('hung-completed'); // should not happen
    });
    const p2 = enqueue('biz1:+111', async () => {
      order.push('after-timeout');
    });
    await Promise.all([p1, p2]);
    const elapsed = Date.now() - t0;
    ok('hung message timed out and released queue', order.includes('after-timeout'));
    ok('hung message body did not complete before timeout',
      !order.includes('hung-completed') || elapsed < 250); // either didn't run or ran after timeout
    ok('timeout error logged', loggedErrors.some(e => e.msg === 'client-queue-timeout'));
    ok('queue unblocked quickly (< 200ms)', elapsed < 200);
  }

  // 5. Map cleaned up after processing
  console.log('\n--- Map cleanup ---');
  {
    const { enqueue, queue } = makeEnqueue();
    const p = enqueue('biz1:+111', async () => { await sleep(10); });
    ok('entry exists while processing', queue.has('biz1:+111'));
    await p;
    await sleep(5); // let finally() run
    ok('entry removed after processing', !queue.has('biz1:+111'));
  }

  // 6. Three messages same client: strict order
  console.log('\n--- Three messages: strict order ---');
  {
    const { enqueue } = makeEnqueue();
    const order = [];
    const delays = [40, 10, 20];
    const promises = delays.map((d, i) =>
      enqueue('biz1:+111', async () => { await sleep(d); order.push(i + 1); })
    );
    await Promise.all(promises);
    ok('order is 1,2,3 regardless of individual delays',
      order.join(',') === '1,2,3', order.join(','));
  }

  // 7. Different businesses with same phone: separate queues
  console.log('\n--- Different businesses same phone: independent ---');
  {
    const { enqueue } = makeEnqueue();
    const order = [];
    const p1 = enqueue('biz1:+111', async () => { await sleep(40); order.push('biz1'); });
    const p2 = enqueue('biz2:+111', async () => { await sleep(5);  order.push('biz2'); });
    await Promise.all([p1, p2]);
    ok('biz2 finishes before biz1 (parallel queues)', order[0] === 'biz2');
  }

  console.log(`\ntests — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
