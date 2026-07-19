const {
  upsertBusiness,
  getBusinessById,
  getOrCreateConversation,
  addMessage,
  getConversationHistory,
} = require('../src/db');

// 1. Create business
const biz = upsertBusiness({
  name: 'Panadería Test',
  whatsapp_number: '+59899000001',
  sales_examples: ['Vendemos medialunas', 'Tenemos pan integral'],
  survey_answers: { horario: '8-18', delivery: true },
  response_mode: 'texto',
});
console.log('Created business:', biz);

// 2. Read it back
const fetched = getBusinessById(biz.id);
console.log('Fetched business:', fetched);
console.assert(fetched.name === 'Panadería Test', 'name mismatch');
console.assert(Array.isArray(fetched.sales_examples), 'sales_examples not array');
console.assert(fetched.survey_answers.delivery === true, 'survey_answers.delivery mismatch');

// 3. Update via upsert
const updated = upsertBusiness({
  name: 'Panadería Test (actualizada)',
  whatsapp_number: '+59899000001',
  response_mode: 'audio',
});
console.log('Updated business:', updated);
console.assert(updated.name === 'Panadería Test (actualizada)', 'update failed');
console.assert(updated.id === biz.id, 'id changed on update');

// 4. Conversation + messages
const conv = getOrCreateConversation(biz.id, 'customer-abc');
console.log('Conversation:', conv);

addMessage(conv.id, 'user', 'Hola, ¿tienen pan integral?');
addMessage(conv.id, 'assistant', 'Sí, tenemos pan integral todos los días.');

const history = getConversationHistory(conv.id);
console.log('History:', history);
console.assert(history.length === 2, 'expected 2 messages');

// 5. getOrCreate returns same conv
const conv2 = getOrCreateConversation(biz.id, 'customer-abc');
console.assert(conv2.id === conv.id, 'getOrCreate returned different conv');

console.log('\nAll assertions passed.');
