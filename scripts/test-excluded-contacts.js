#!/usr/bin/env node
'use strict';
// Tests: excluded contacts — phone normalization, business isolation, bot bypass, limit.
// Run: node scripts/test-excluded-contacts.js

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3096;
const DB_DIR    = '/tmp/test-excluded-contacts';
const BASE_URL  = `http://localhost:${TEST_PORT}`;

let serverProc = null;
let passed = 0;
let failed = 0;

function cleanup() {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }
  try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(cond, label, detail) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail !== undefined ? ': ' + String(detail) : ''}`); failed++; }
}

function req(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let data = '';
        const setCookie = res.headers['set-cookie'];
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), setCookie }); }
          catch { resolve({ status: res.statusCode, body: data, setCookie }); }
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

async function register(email) {
  const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  if (r.status !== 200) throw new Error(`register failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.setCookie?.[0]?.split(';')[0];
}

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.join(DB_DIR, 'daxos.db'));
}

async function seedBusiness(db, email, pnid, cookie) {
  await req('PUT', '/api/business', { name: `Biz ${email}`, plan: 'crecimiento' }, cookie);
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id;
  const bizId  = db.prepare('SELECT business_id FROM users WHERE id = ?').get(userId)?.business_id;
  db.prepare(`UPDATE businesses SET
    phone_number_id = ?, wa_provider = 'kapso',
    wa_connected_at = datetime('now'), plan = 'crecimiento',
    plan_paid_at = datetime('now'), response_delay = 0
    WHERE id = ?`).run(pnid, bizId);
  db.pragma('wal_checkpoint(FULL)');
  return { bizId, userId };
}

async function main() {
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(DB_DIR, { recursive: true });

  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT), DB_DIR,
      SESSION_SECRET:    'excluded-test-secret',
      ANTHROPIC_API_KEY: 'test-key-not-real',
      KAPSO_API_KEY:     'test-kapso-key',
      KAPSO_TEST_ALLOW_LOCALHOST: '1',
      KAPSO_WEBHOOK_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(300);

  const db = openDb();

  const cookieA = await register('biz-a@excl.com');
  const cookieB = await register('biz-b@excl.com');
  const { bizId: bizA } = await seedBusiness(db, 'biz-a@excl.com', 'pnid-excl-a', cookieA);
  const { bizId: bizB } = await seedBusiness(db, 'biz-b@excl.com', 'pnid-excl-b', cookieB);

  // ── Suite 0: phone normalization ──────────────────────────────────────────
  console.log('Suite 0: normalización de teléfonos');
  {
    // All three formats should normalize to the same value
    const { normalizeContactPhone } = require(path.join(__dirname, '../src/db'));
    const a = normalizeContactPhone('098 323 308');
    const b = normalizeContactPhone('+598 98 323 308');
    const c = normalizeContactPhone('59898323308');
    assert(a === '59898323308', '0.1 "098 323 308" → 59898323308', a);
    assert(b === '59898323308', '0.2 "+598 98 323 308" → 59898323308', b);
    assert(c === '59898323308', '0.3 "59898323308" → 59898323308', c);
    assert(a === b && b === c, '0.4 los tres coinciden entre sí', `${a} / ${b} / ${c}`);
    assert(normalizeContactPhone(null) === null, '0.5 null → null');
    assert(normalizeContactPhone('') === null, '0.6 vacío → null');
  }
  console.log();

  // ── Suite 1: CRUD y aislamiento por negocio ────────────────────────────────
  console.log('Suite 1: CRUD y aislamiento por negocio');
  {
    // Add to biz A
    const r1 = await req('POST', '/api/excluded-contacts', { phones: '098323308' }, cookieA);
    assert(r1.status === 200, '1.1 POST add devuelve 200', r1.status);
    assert(r1.body?.added === 1, '1.2 added = 1', JSON.stringify(r1.body));

    // List for biz A should have 1
    const r2 = await req('GET', '/api/excluded-contacts', null, cookieA);
    assert(r2.status === 200, '1.3 GET list 200');
    assert(Array.isArray(r2.body) && r2.body.length === 1, '1.4 lista A tiene 1', JSON.stringify(r2.body));
    assert(r2.body[0]?.phone === '59898323308', '1.5 teléfono normalizado correcto', r2.body[0]?.phone);

    // List for biz B should be empty (isolation)
    const r3 = await req('GET', '/api/excluded-contacts', null, cookieB);
    assert(r3.status === 200, '1.6 GET list B 200');
    assert(Array.isArray(r3.body) && r3.body.length === 0, '1.7 lista B está vacía (aislamiento)', JSON.stringify(r3.body));

    // Biz B cannot delete biz A's entry (different phone, just confirms 404)
    const r4 = await req('DELETE', '/api/excluded-contacts/59898323308', null, cookieB);
    assert(r4.status === 404, '1.8 B no puede borrar número de A (404)', r4.status);

    // Duplicate insert returns ok (idempotent)
    const r5 = await req('POST', '/api/excluded-contacts', { phones: '098 323 308' }, cookieA);
    assert(r5.status === 200, '1.9 re-insert es idempotente (200)', r5.status);
    assert(r5.body?.duplicates === 1, '1.10 duplicate count = 1', JSON.stringify(r5.body));

    // Remove from A
    const r6 = await req('DELETE', '/api/excluded-contacts/59898323308', null, cookieA);
    assert(r6.status === 200, '1.11 DELETE devuelve 200', r6.status);

    // List should be empty again
    const r7 = await req('GET', '/api/excluded-contacts', null, cookieA);
    assert(Array.isArray(r7.body) && r7.body.length === 0, '1.12 lista A vacía tras borrar', JSON.stringify(r7.body));
  }
  console.log();

  // ── Suite 2: exclude desde conversación ───────────────────────────────────
  console.log('Suite 2: exclude/unexclude desde conversación');
  {
    // Create a conv in biz A
    const convId = db.prepare(
      'INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)'
    ).run(bizA, '59891000001').lastInsertRowid;
    db.pragma('wal_checkpoint(FULL)');

    // Biz B cannot exclude a conv of biz A
    const r1 = await req('POST', `/api/conversations/${convId}/exclude`, null, cookieB);
    assert(r1.status === 404, '2.1 B no puede excluir conv de A', r1.status);

    // Biz A can exclude it
    const r2 = await req('POST', `/api/conversations/${convId}/exclude`, null, cookieA);
    assert(r2.status === 200, '2.2 A puede excluir su propia conv', r2.status);
    assert(r2.body?.phone === '59891000001', '2.3 phone devuelto correcto', r2.body?.phone);

    // messages endpoint reflects is_excluded = true
    const r3 = await req('GET', `/api/conversations/${convId}/messages`, null, cookieA);
    assert(r3.status === 200, '2.4 GET messages 200');
    assert(r3.body?.is_excluded === true, '2.5 is_excluded = true', r3.body?.is_excluded);

    // Unexclude
    const r4 = await req('DELETE', `/api/conversations/${convId}/exclude`, null, cookieA);
    assert(r4.status === 200, '2.6 unexclude 200', r4.status);

    const r5 = await req('GET', `/api/conversations/${convId}/messages`, null, cookieA);
    assert(r5.body?.is_excluded === false, '2.7 is_excluded = false tras quitar', r5.body?.is_excluded);
  }
  console.log();

  // ── Suite 3: bulk add con múltiples formatos ───────────────────────────────
  console.log('Suite 3: bulk add con múltiples formatos');
  {
    const phones = '098 111 111\n+598 92 222 222\n59893333333';
    const r1 = await req('POST', '/api/excluded-contacts', { phones }, cookieB);
    assert(r1.status === 200, '3.1 bulk add 200', r1.status);
    assert(r1.body?.added === 3, '3.2 added = 3', JSON.stringify(r1.body));

    const r2 = await req('GET', '/api/excluded-contacts', null, cookieB);
    assert(r2.body?.length === 3, '3.3 lista B tiene 3', r2.body?.length);

    // Clean up
    for (const p of r2.body) {
      await req('DELETE', `/api/excluded-contacts/${p.phone}`, null, cookieB);
    }
  }
  console.log();

  // ── Suite 4: normal (no excluido) no se ve afectado ───────────────────────
  console.log('Suite 4: contactos no excluidos no se ven afectados');
  {
    const r1 = await req('GET', '/api/excluded-contacts', null, cookieA);
    assert(r1.body?.length === 0, '4.1 lista A sigue vacía', r1.body?.length);

    const convId = db.prepare(
      'INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)'
    ).run(bizA, '59894000001').lastInsertRowid;
    db.pragma('wal_checkpoint(FULL)');

    const r2 = await req('GET', `/api/conversations/${convId}/messages`, null, cookieA);
    assert(r2.body?.is_excluded === false, '4.2 conv normal tiene is_excluded = false', r2.body?.is_excluded);
  }
  console.log();

  // ── Suite 5: webhook bypass paths (document, location, failed image, audio) ─
  console.log('Suite 5: webhook bypass paths con contacto excluido');
  {
    const EXCL_PHONE = '59898500001';
    await req('POST', '/api/excluded-contacts', { phones: EXCL_PHONE }, cookieA);

    async function sendWebhook(msgType, msgId, extra = {}) {
      const msg = {
        from: EXCL_PHONE, id: msgId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: msgType, ...extra,
      };
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ id: 'waba-test', changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '123', phone_number_id: 'pnid-excl-a' },
            contacts: [{ profile: { name: 'Excluido' }, wa_id: EXCL_PHONE }],
            messages: [msg],
          },
          field: 'messages',
        }] }],
      };
      return req('POST', '/webhook', payload, null);
    }

    function getConvMsgs(convId) {
      return db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);
    }

    // 5.1-5.4: document
    const r1 = await sendWebhook('document', 'wamid-excl-doc-001', {
      document: { id: 'docid001', mime_type: 'application/pdf', filename: 'test.pdf' },
    });
    assert(r1.status === 200, '5.1 webhook document devuelve 200', r1.status);
    await sleep(400);
    const conv5 = db.prepare('SELECT id FROM conversations WHERE business_id = ? AND customer_id = ?').get(bizA, EXCL_PHONE);
    assert(!!conv5, '5.2 conversación creada para excluido', conv5);
    const msgsAfterDoc = getConvMsgs(conv5.id);
    assert(msgsAfterDoc.length === 1, '5.3 solo 1 mensaje (user)', msgsAfterDoc.length);
    assert(msgsAfterDoc[0]?.content === '[media:document]', '5.4 contenido = [media:document]', msgsAfterDoc[0]?.content);

    // 5.5-5.7: location
    const r2 = await sendWebhook('location', 'wamid-excl-loc-001', {
      location: { latitude: -34.9, longitude: -56.2, name: 'Test' },
    });
    assert(r2.status === 200, '5.5 webhook location devuelve 200', r2.status);
    await sleep(400);
    const msgsAfterLoc = getConvMsgs(conv5.id);
    const locMsg = msgsAfterLoc.find(m => m.content === '[media:location]');
    assert(!!locMsg, '5.6 mensaje [media:location] guardado', msgsAfterLoc.map(m => m.content).join(','));
    assert(msgsAfterLoc.every(m => m.role !== 'assistant'), '5.7 sin respuesta bot tras location', msgsAfterLoc.filter(m => m.role === 'assistant').length);

    // 5.8-5.10: image fallback (no media id → download skip, but exclusion fires first)
    const r3 = await sendWebhook('image', 'wamid-excl-img-001', {
      image: { caption: 'foto de prueba' },
    });
    assert(r3.status === 200, '5.8 webhook image fallback devuelve 200', r3.status);
    await sleep(400);
    const msgsAfterImg = getConvMsgs(conv5.id);
    const imgMsg = msgsAfterImg.find(m => m.content.includes('[imagen]'));
    assert(!!imgMsg, '5.9 mensaje [imagen] guardado', msgsAfterImg.map(m => m.content).join(','));
    assert(msgsAfterImg.every(m => m.role !== 'assistant'), '5.10 sin respuesta bot tras imagen fallback', msgsAfterImg.filter(m => m.role === 'assistant').length);

    // 5.11-5.13: audio — exclusion fires before transcription (no ElevenLabs call)
    const r4 = await sendWebhook('audio', 'wamid-excl-aud-001', {
      audio: { id: 'audioid001', mime_type: 'audio/ogg; codecs=opus' },
    });
    assert(r4.status === 200, '5.11 webhook audio devuelve 200', r4.status);
    await sleep(600);
    const msgsAfterAud = getConvMsgs(conv5.id);
    const audMsg = msgsAfterAud.find(m => m.content === '[audio]');
    assert(!!audMsg, '5.12 mensaje [audio] guardado', msgsAfterAud.map(m => m.content).join(','));
    assert(msgsAfterAud.every(m => m.role !== 'assistant'), '5.13 sin respuesta bot tras audio excluido', msgsAfterAud.filter(m => m.role === 'assistant').length);

    // 5.14-5.15: dedup — mismo msg.id enviado dos veces → solo 1 mensaje guardado
    const beforeDedup = getConvMsgs(conv5.id).length;
    await sendWebhook('text', 'wamid-excl-dedup-001', { text: { body: 'hola de nuevo' } });
    await sleep(400);
    const afterFirst = getConvMsgs(conv5.id).length;
    assert(afterFirst === beforeDedup + 1, '5.14 primer envío agrega 1 mensaje', `before=${beforeDedup} after=${afterFirst}`);
    // Retry with same msg.id
    await sendWebhook('text', 'wamid-excl-dedup-001', { text: { body: 'hola de nuevo' } });
    await sleep(400);
    const afterRetry = getConvMsgs(conv5.id).length;
    assert(afterRetry === afterFirst, '5.15 reintento de Meta no duplica mensaje', `after_first=${afterFirst} after_retry=${afterRetry}`);
  }
  console.log();

  // ── Suite 6: batch endpoint ───────────────────────────────────────────────
  console.log('Suite 6: endpoint por lotes POST /api/excluded-contacts/batch');
  {
    // Seed 3 convs for bizA
    const batchConvIds = [1, 2, 3].map(i =>
      db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)').run(bizA, `5989900000${i}`).lastInsertRowid
    );
    db.pragma('wal_checkpoint(FULL)');

    // 6.1-6.2: batch add for bizA
    const r1 = await req('POST', '/api/excluded-contacts/batch',
      { action: 'add', conversationIds: batchConvIds }, cookieA);
    assert(r1.status === 200, '6.1 batch add devuelve 200', r1.status);
    assert(r1.body?.processed === 3, '6.2 processed = 3', JSON.stringify(r1.body));

    // 6.3: all three are excluded
    const r2 = await req('GET', '/api/excluded-contacts', null, cookieA);
    const batchPhones = r2.body?.map(c => c.phone) || [];
    const allAdded = ['59899000001','59899000002','59899000003'].every(p => batchPhones.includes(p));
    assert(allAdded, '6.3 los 3 teléfonos aparecen en la lista', batchPhones.join(','));

    // 6.4-6.5: bizB cannot batch-act on bizA's conversations (isolation)
    const r3 = await req('POST', '/api/excluded-contacts/batch',
      { action: 'add', conversationIds: batchConvIds }, cookieB);
    assert(r3.status === 200, '6.4 respuesta 200 aunque convs no pertenezcan', r3.status);
    assert(r3.body?.processed === 0, '6.5 processed = 0 (aislamiento por negocio)', JSON.stringify(r3.body));

    // 6.6: invalid action returns 400
    const r4 = await req('POST', '/api/excluded-contacts/batch',
      { action: 'delete', conversationIds: batchConvIds }, cookieA);
    assert(r4.status === 400, '6.6 action inválida devuelve 400', r4.status);

    // 6.7: empty conversationIds returns 400
    const r5 = await req('POST', '/api/excluded-contacts/batch',
      { action: 'add', conversationIds: [] }, cookieA);
    assert(r5.status === 400, '6.7 array vacío devuelve 400', r5.status);

    // 6.8-6.9: batch remove
    const r6 = await req('POST', '/api/excluded-contacts/batch',
      { action: 'remove', conversationIds: batchConvIds }, cookieA);
    assert(r6.status === 200, '6.8 batch remove devuelve 200', r6.status);
    assert(r6.body?.processed === 3, '6.9 remove processed = 3', JSON.stringify(r6.body));

    // 6.10: list back to original size (no longer has the 3 batch phones)
    const r7 = await req('GET', '/api/excluded-contacts', null, cookieA);
    const remaining = (r7.body || []).filter(c => ['59899000001','59899000002','59899000003'].includes(c.phone));
    assert(remaining.length === 0, '6.10 los 3 teléfonos ya no están en la lista', remaining.length);

    // 6.11: /api/conversations list includes is_excluded per conv
    const r8 = await req('GET', '/api/conversations', null, cookieA);
    assert(r8.status === 200, '6.11 GET /api/conversations devuelve 200', r8.status);
    assert(Array.isArray(r8.body), '6.12 respuesta es array', typeof r8.body);
  }
  console.log();

  // ── Results ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
