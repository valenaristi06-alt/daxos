'use strict';
/**
 * "Te lo confirma alguien del equipo" → the owner must find out.
 *
 * Every time the assistant tells a client that the team will confirm something (its own
 * wording, the [DATO_PENDIENTE] marker, or the anti-invention check replacing the reply):
 *   - the conversation is marked for attention (needs_human),
 *   - the owner is told what the client asked,
 *   - at most ONE notice per conversation every 2 hours.
 *
 * Emails go to a local mock of the provider. Run: node scripts/test-pending-data-alert.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const Database = require('better-sqlite3');

const DB_DIR = '/tmp/test-pending-data-alert';
const PORT = 3283, MAIL_PORT = 3284;
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = `${DB_DIR}/unit`;

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const mails = [];
const mailSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    try { const m = JSON.parse(body); mails.push({ to: m.to[0], subject: m.subject, html: m.html }); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"mock"}');
  });
});

(async () => {
  // ── Unit ───────────────────────────────────────────────────────────────────
  console.log('\n--- Detection and prompt ---');
  const { isTeamDeferral, FALLBACK_REPLY } = require('../src/grounding');
  const { buildSystemPrompt } = require('../src/claude');
  for (const t of [
    'Eso te lo confirma alguien del equipo.', FALLBACK_REPLY, 'Los horarios te los paso por acá en breve.',
    'Eso lo tiene que confirmar el equipo directamente.', 'Ese dato no lo tengo cargado, el equipo te avisa.',
    'Alguien del equipo te va a contactar.', 'No tengo la dirección, se la consulto al equipo.',
  ]) ok(`deferral detected: ${t}`, isTeamDeferral(t));
  for (const t of ['El corte sale $800.', 'Somos un equipo de 5 personas, te esperamos.', 'Hola, ¿en qué te ayudo?', 'Atendemos de 9 a 18.', 'Te paso el catálogo.'])
    ok(`normal reply is not a deferral: ${t}`, !isTeamDeferral(t));
  ok('prompt asks the model to flag pending data', buildSystemPrompt({ id: 1, name: 'X' }, null, null, {}).staticText.includes('[DATO_PENDIENTE]'));

  // ── Server ─────────────────────────────────────────────────────────────────
  await new Promise(r => mailSrv.listen(MAIL_PORT, r));
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 'pending-secret', NODE_ENV: 'test', DAXOS_TEST_HARNESS: '1',
      RAILWAY_ENVIRONMENT: '', RESEND_API_KEY: 'test-key-not-real', RESEND_BASE_URL: `http://localhost:${MAIL_PORT}`, GROUNDING_MODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', token = '';
  const ready = await new Promise(resolve => {
    const to = setTimeout(() => resolve(false), 15000);
    const onData = d => {
      out += String(d);
      const m = out.match(/\[test-harness\] token=([0-9a-f]{64})/);
      if (m) token = m[1];
      if (out.includes('Server running')) { clearTimeout(to); resolve(true); }
    };
    server.stdout.on('data', onData); server.stderr.on('data', onData);
  });
  ok('server started', ready && !!token, out.slice(-300));

  function req(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'X-Test-Token': token };
      if (cookie) headers.Cookie = cookie;
      const data = body ? JSON.stringify(body) : null;
      if (data) headers['Content-Length'] = Buffer.byteLength(data);
      const r = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method, headers }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); } catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); } });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  }

  if (ready && token) {
    try {
      await sleep(300);
      const OWNER = `dueno-${Date.now()}@pending-test.com`;
      const reg = await req('POST', '/auth/register', { email: OWNER, password: 'P1Pass1!x' });
      const cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
      await req('PUT', '/api/business', { name: 'Peluquería Luna', pricing_info: 'Corte dama: $800' }, cookie);
      const bizId = (await req('GET', '/api/business', null, cookie)).body?.id;
      const sql = new Database(path.join(DB_DIR, 'daxos.db'));
      sql.prepare('UPDATE businesses SET response_delay = 0 WHERE id = ?').run(bizId);
      sql.pragma('wal_checkpoint(FULL)');

      const conv = phone => sql.prepare('SELECT id, needs_human, needs_attention FROM conversations WHERE business_id = ? AND customer_id = ?').get(bizId, phone);
      const lastAssistant = phone => sql.prepare(`SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.business_id = ? AND c.customer_id = ? AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1`).get(bizId, phone)?.content;
      const alerts = phone => sql.prepare("SELECT COUNT(*) n FROM owner_alert_log WHERE conversation_id = ? AND kind = 'data_pending'").get(conv(phone).id).n;
      // Only attention notices count here (the owner also gets unrelated emails, e.g. on signup).
      const ownerMails = () => mails.filter(m => m.to === OWNER && /Dato sin cargar|pausada/.test(m.subject));
      const send = async (phone, text, replies) => {
        for (const reply of replies) await req('POST', '/test/mock-reply', { reply });
        await req('POST', '/test/inject-message', { businessId: bizId, customerPhone: phone, text });
        await sleep(350);
      };
      const A = '59891880001', B = '59891880002', C = '59891880003', D = '59891880004';

      console.log('\n--- Notice to the owner ---');
      await send(A, 'cuanto sale el corte?', ['El corte dama sale $800.']);
      if (process.env.DEBUG_MAILS) console.log(mails.map(m => `${m.to} | ${m.subject}`));
      ok('normal answer: no notice, not marked', ownerMails().length === 0 && conv(A).needs_human === 0);

      await send(A, '¿tienen estacionamiento para clientes?', ['Ese dato no lo tengo cargado, te lo confirma alguien del equipo.']);
      ok('deferral: owner notified once', ownerMails().length === 1, `mails=${ownerMails().length}`);
      ok('notice carries what the client asked', ownerMails()[0]?.html.includes('¿tienen estacionamiento para clientes?'));
      ok('notice says data is missing, not that the conversation was paused', /Dato sin cargar/.test(ownerMails()[0]?.subject || '') && !/pausó la conversación/.test(ownerMails()[0]?.html || '') && /cargás en el panel/.test(ownerMails()[0]?.html || ''));
      ok('conversation marked for attention', conv(A).needs_human === 1);
      ok('the assistant keeps answering (conversation not paused)', conv(A).needs_attention === 0);
      ok('client got the reply as written', lastAssistant(A) === 'Ese dato no lo tengo cargado, te lo confirma alguien del equipo.');

      console.log('\n--- At most one notice per conversation every 2 hours ---');
      await send(A, '¿y aceptan tarjeta?', ['Eso también te lo confirma el equipo.']);
      await send(A, '¿hacen domicilio?', ['Lo tiene que confirmar el equipo.\n[DATO_PENDIENTE]']);
      await send(A, '¿cuánto sale el alisado?', ['El alisado sale $3.200.', 'Sale $3.200.']); // check replaces it
      ok('three more deferrals within 2 h: still one notice', ownerMails().length === 1 && alerts(A) === 1, `mails=${ownerMails().length}`);
      ok('throttled deferrals are logged', sql.prepare("SELECT COUNT(*) n FROM error_log WHERE context = 'data-pending-alert' AND message LIKE '%throttled%'").get().n === 3);
      ok('conversation stays marked', conv(A).needs_human === 1);

      // 2 hours later
      sql.prepare("UPDATE owner_alert_log SET sent_at = sent_at - 7300 WHERE kind = 'data_pending'").run(); sql.pragma('wal_checkpoint(FULL)');
      await send(A, '¿tienen wifi?', ['Eso te lo confirma alguien del equipo.']);
      ok('after 2 h: a new notice with the new question', ownerMails().length === 2 && ownerMails()[1].html.includes('¿tienen wifi?'));
      await send(A, '¿y aire acondicionado?', ['Te lo confirma el equipo.']);
      ok('and throttled again right after', ownerMails().length === 2);

      console.log('\n--- Each trigger, on its own conversation ---');
      await send(B, '¿venden shampoo?', ['Lo veo y te digo.\n[DATO_PENDIENTE]']);
      ok('marker alone triggers the notice', ownerMails().length === 3 && conv(B).needs_human === 1);
      ok('marker never reaches the client', lastAssistant(B) === 'Lo veo y te digo.', JSON.stringify(lastAssistant(B)));

      await send(C, '¿cuánto sale la manicura?', ['La manicura sale $450.', 'Sale $450.']);
      ok('anti-invention replacement triggers the notice', ownerMails().length === 4 && lastAssistant(C) === FALLBACK_REPLY && conv(C).needs_human === 1);
      ok('one conversation does not throttle another', alerts(B) === 1 && alerts(C) === 1);

      await send(D, 'necesito hablar con alguien', ['[NEEDS_HUMAN]\nYa le aviso a alguien del equipo para que te contacte.']);
      ok('[NEEDS_HUMAN] with a deferral: exactly one notice (not two)', ownerMails().length === 5 && conv(D).needs_human === 1);
      await send(D, 'hola?', ['Ya avisé, alguien del equipo se va a comunicar.']);
      ok('reminding the client does not re-notify within 2 h', ownerMails().length === 5);

      const E = '59891880005';
      await send(E, 'quiero hablar con una persona', ['[NEEDS_HUMAN]\nEntiendo, ya lo derivo.']);
      ok('plain [NEEDS_HUMAN] (no deferral text) still notifies as before', ownerMails().length === 6 && /pausó la conversación/.test(ownerMails()[5].html));
      sql.close();
    } catch (e) {
      ok('run', false, e.stack || e.message);
    }
  }
  server.kill('SIGTERM'); mailSrv.close();

  console.log('\n================================================================');
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
