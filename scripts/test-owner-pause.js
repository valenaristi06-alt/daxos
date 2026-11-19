/**
 * Tests for owner auto-pause (coexistence): when the owner writes from the WhatsApp app,
 * the chat pauses with paused_reason='owner' and auto-resumes after N hours of owner silence
 * (per-business owner_pause_hours, default 24). Manual resume clears it immediately.
 *
 * Run: node scripts/test-owner-pause.js
 */

'use strict';

process.env.DB_DIR = `/tmp/test-owner-pause-${Date.now()}`;

const {
  upsertBusiness,
  getBusinessById,
  getOrCreateConversation,
  getConversationById,
  setOwnerPaused,
  autoResumeOwnerPaused,
  setOwnerPauseHours,
  markConversationResumed,
} = require('../src/db');

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);

// ── Default window (24h) ──────────────────────────────────────────────────────
const biz  = upsertBusiness({ name: 'Owner Pause Biz', response_mode: 'texto' });
const conv = getOrCreateConversation(biz.id, 'cust-1');

setOwnerPaused(conv.id);
let c = getConversationById(conv.id);
ok('setOwnerPaused sets reason=owner', c.paused_reason === 'owner', `got ${c.paused_reason}`);
ok('setOwnerPaused sets needs_attention=1', c.needs_attention === 1);
ok('setOwnerPaused sets owner_paused_at', c.owner_paused_at != null);
ok('setOwnerPaused does not use human_paused_at', c.human_paused_at == null);

// Not yet elapsed → no resume
ok('no resume right away', autoResumeOwnerPaused(now) === 0);
ok('still paused after 23h', autoResumeOwnerPaused(now + 23 * HOUR) === 0);
c = getConversationById(conv.id);
ok('still reason=owner at 23h', c.paused_reason === 'owner');

// 24h elapsed → resume
ok('resumes at 25h (default 24)', autoResumeOwnerPaused(now + 25 * HOUR) === 1);
c = getConversationById(conv.id);
ok('resumed clears needs_attention', c.needs_attention === 0);
ok('resumed clears paused_reason', c.paused_reason == null);
ok('resumed clears owner_paused_at', c.owner_paused_at == null);

// ── Custom window (2h) ────────────────────────────────────────────────────────
setOwnerPauseHours(biz.id, 2);
ok('owner_pause_hours persisted', getBusinessById(biz.id).owner_pause_hours === 2);

const conv2 = getOrCreateConversation(biz.id, 'cust-2');
setOwnerPaused(conv2.id);
ok('custom: no resume at 1h', autoResumeOwnerPaused(now + 1 * HOUR) === 0);
ok('custom: resumes at 3h', autoResumeOwnerPaused(now + 3 * HOUR) === 1);

// ── Clock resets on each owner message ────────────────────────────────────────
setOwnerPauseHours(biz.id, null); // back to default 24
const conv3 = getOrCreateConversation(biz.id, 'cust-3');
setOwnerPaused(conv3.id);
// owner writes again later → owner_paused_at moves forward (we just call setOwnerPaused again)
setOwnerPaused(conv3.id);
const c3 = getConversationById(conv3.id);
ok('reset: still paused after re-write', c3.paused_reason === 'owner');

// ── Manual resume (Reanudar bot button) ───────────────────────────────────────
const conv4 = getOrCreateConversation(biz.id, 'cust-4');
setOwnerPaused(conv4.id);
markConversationResumed(conv4.id);
const c4 = getConversationById(conv4.id);
ok('manual resume clears owner pause', c4.needs_attention === 0 && c4.paused_reason == null && c4.owner_paused_at == null);

// ── Other paused_reason untouched ─────────────────────────────────────────────
const conv5 = getOrCreateConversation(biz.id, 'cust-5');
const db = require('../src/db');
// simulate a keyword pause via markConversationPausedByKeyword if available
if (typeof db.markConversationPausedByKeyword === 'function') {
  db.markConversationPausedByKeyword(conv5.id);
  // Owner job runs far in the future; it must never touch a keyword-paused chat
  // (keyword pauses have no owner_paused_at), regardless of other rows it resumes.
  autoResumeOwnerPaused(now + 1000 * HOUR);
  const c5 = getConversationById(conv5.id);
  ok('keyword pause untouched by owner job', c5.paused_reason === 'keyword' && c5.needs_attention === 1);
}

console.log(`\nowner-pause: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
