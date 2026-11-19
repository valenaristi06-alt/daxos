/**
 * Tests for panel soft-delete of conversations.
 *
 * Requirement: deleting a chat from the panel removes it from the list (Daxos only,
 * not WhatsApp) but must NOT lower the trial / grace / spend-cap / billing counters.
 * These counters are all derived from the messages table, so soft-delete keeps the
 * messages (and the conversation row) and the counts stay identical.
 *
 * Run: node scripts/test-conv-soft-delete.js
 */

'use strict';

process.env.DB_DIR = `/tmp/test-conv-soft-delete-${Date.now()}`;

const {
  upsertBusiness,
  getOrCreateConversation,
  addMessage,
  softDeleteConversation,
  getConversationsByBusinessId,
  getConversationCountByBusinessId,
  getTrialMessageCount,
  getTrialConversationCount,
} = require('../src/db');

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const TRIAL_START = '2000-01-01 00:00:00'; // include every message

const biz  = upsertBusiness({ name: 'Soft Delete Biz', response_mode: 'texto' });
const conv = getOrCreateConversation(biz.id, 'cust-del');
addMessage(conv.id, 'user', 'hola');
addMessage(conv.id, 'assistant', 'buenas, ¿qué buscás?');
addMessage(conv.id, 'user', 'una artesanía');

// A second conversation that stays, so we can tell list-hiding from counter changes.
const conv2 = getOrCreateConversation(biz.id, 'cust-keep');
addMessage(conv2.id, 'user', 'precio?');

// Snapshot counters before delete
const before = {
  convRows:   getConversationCountByBusinessId(biz.id),
  trialMsgs:  getTrialMessageCount(biz.id, TRIAL_START),
  trialConvs: getTrialConversationCount(biz.id, TRIAL_START),
  listed:     getConversationsByBusinessId(biz.id).length,
};
ok('listed shows both before delete', before.listed === 2, `got ${before.listed}`);

// Delete the first conversation
ok('softDeleteConversation returns true', softDeleteConversation(conv.id, biz.id) === true);

const after = {
  convRows:   getConversationCountByBusinessId(biz.id),
  trialMsgs:  getTrialMessageCount(biz.id, TRIAL_START),
  trialConvs: getTrialConversationCount(biz.id, TRIAL_START),
  listed:     getConversationsByBusinessId(biz.id).length,
};

// Counters must NOT drop
ok('conversation-row count unchanged', after.convRows === before.convRows, `${before.convRows} -> ${after.convRows}`);
ok('trial message count unchanged',    after.trialMsgs === before.trialMsgs, `${before.trialMsgs} -> ${after.trialMsgs}`);
ok('trial conversation count unchanged', after.trialConvs === before.trialConvs, `${before.trialConvs} -> ${after.trialConvs}`);

// But the chat is hidden from the panel list
ok('deleted chat hidden from list', after.listed === 1, `got ${after.listed}`);
ok('remaining chat still listed', getConversationsByBusinessId(biz.id)[0].customer_id === 'cust-keep');

// Idempotent: deleting again is a no-op
ok('second delete is no-op', softDeleteConversation(conv.id, biz.id) === false);

// A new message from the same customer resurrects the chat (same row → counters intact)
const resurrected = getOrCreateConversation(biz.id, 'cust-del');
ok('resurrected is same row', resurrected.id === conv.id);
ok('resurrected reappears in list', getConversationsByBusinessId(biz.id).some(c => c.id === conv.id));
ok('resurrection did not inflate counters', getTrialMessageCount(biz.id, TRIAL_START) === before.trialMsgs);

console.log(`\nconv-soft-delete: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
