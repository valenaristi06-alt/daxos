/**
 * Tests for the cancel-booking bug fix.
 *
 * Bug: when [CANCEL_BOOKING] fires in waiting_owner state, booking_state is cleared but the
 * pending_bookings record stays status='pending'. checkBookingTimeouts() then sends the owner a
 * 4-hour reminder and the client an expiry notification for a booking that was already cancelled.
 *
 * Fix: cancelBooking(bookingId) sets status='rejected' (only if still pending),
 * called from server.js state machine when [CANCEL_BOOKING] fires with a bookingId.
 *
 * Run: node scripts/test-cancel-booking.js
 */

'use strict';

process.env.DB_DIR = `/tmp/test-cancel-booking-${Date.now()}`;

const {
  upsertBusiness,
  getOrCreateConversation,
  createBooking,
  cancelBooking,
  confirmBooking,
  getBookingById,
  getBookingsNeedingTimeout,
  markBookingNotified,
} = require('../src/db');

let passed = 0;
let failed = 0;

function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const biz  = upsertBusiness({ name: 'Test Biz', response_mode: 'texto' });
const conv = getOrCreateConversation(biz.id, 'customer-cancel-test');

function makeBooking() {
  return createBooking({
    businessId:    biz.id,
    conversationId: conv.id,
    customerPhone:  '+59812345678',
    clientName:     'Juan Test',
    reason:         'Consulta',
    slots:          ['Lunes 10h', 'Martes 11h'],
  });
}

// ── Suite: cancelBooking function ──────────────────────────────────────────────

console.log('\n--- cancelBooking function ---');

ok('cancelBooking is a function', typeof cancelBooking === 'function');

{
  const booking = makeBooking();
  ok('new booking starts as pending', booking.status === 'pending', booking.status);
  cancelBooking(booking.id);
  const after = getBookingById(booking.id);
  ok('cancelBooking sets status to rejected', after.status === 'rejected', after.status);
}

// ── Suite: cancelBooking is a no-op on non-pending bookings ────────────────────

console.log('\n--- cancelBooking is no-op on non-pending ---');

{
  const booking = makeBooking();
  confirmBooking(booking.id, 'Lunes 10h');
  const confirmed = getBookingById(booking.id);
  ok('booking confirmed', confirmed.status === 'confirmed', confirmed.status);
  cancelBooking(booking.id);
  const after = getBookingById(booking.id);
  ok('cancelBooking does not overwrite confirmed', after.status === 'confirmed', after.status);
}

// ── Suite: getBookingsNeedingTimeout excludes rejected ─────────────────────────

console.log('\n--- getBookingsNeedingTimeout excludes rejected ---');

{
  const booking = makeBooking();
  markBookingNotified(booking.id);
  const before = getBookingsNeedingTimeout({ firstTimeoutMinutes: 0, expireMinutes: 0 });
  const includedBefore = before.some(b => b.id === booking.id);
  ok('notified pending booking IS included in timeout query (confirms bug scenario)', includedBefore,
    `found ${before.length} booking(s), ids: ${before.map(b => b.id).join(',')}`);

  cancelBooking(booking.id);
  const after = getBookingsNeedingTimeout({ firstTimeoutMinutes: 0, expireMinutes: 0 });
  const includedAfter = after.some(b => b.id === booking.id);
  ok('cancelled booking NOT included in timeout query after fix', !includedAfter,
    `found ${after.length} booking(s), ids: ${after.map(b => b.id).join(',')}`);
}

// ── Suite: booking with no bookingId (collection steps) is unaffected ──────────

console.log('\n--- cancel during collection steps (no bookingId) ---');

{
  // Server calls cancelBooking(undefined) when state has no bookingId — should not throw
  ok('cancelBooking(undefined) does not throw', (() => {
    try { cancelBooking(undefined); return true; } catch { return false; }
  })());
  ok('cancelBooking(null) does not throw', (() => {
    try { cancelBooking(null); return true; } catch { return false; }
  })());
}

// ── Result ─────────────────────────────────────────────────────────────────────

console.log(`\ntests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
