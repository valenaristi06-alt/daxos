'use strict';
/**
 * Grounding tests — the assistant never sends data that is not loaded.
 *
 *  1. Extraction/verification unit tests.
 *  2. 3 test businesses × 15 trap questions (things the business has NOT loaded):
 *     an invented reply is detected, regenerated once, and replaced by the fixed
 *     deferral when the model insists. The invented data never reaches the client.
 *  3. Replies built from loaded data pass untouched (no false positives).
 *  4. System prompt carries the explicit rule + weekly hours.
 *  5. End-to-end through processIncomingMessage (test harness): stored reply, owner
 *     flag and the review log.
 *
 * Offline: the model is mocked. The live version (real model, same 45 questions) is
 * scripts/test-grounding-live.js and is not part of run-all-suites.
 *
 * Run: node scripts/test-grounding.js
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { execSync, spawn } = require('child_process');

const DB_DIR = '/tmp/test-grounding';
const PORT = 3272;
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;

const { buildSources, findUngrounded, groundReply, FALLBACK_REPLY, summarizeViolations, buildCorrectionNote } = require('../src/grounding');
const { buildSystemPrompt } = require('../src/claude');
const { BUSINESSES, HOURS_WEEK } = require('./fixtures/grounding-businesses');

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

const NOW = new Date(Date.UTC(2026, 10, 25, 15, 0)); // miércoles 25/11/2026 (already UY-shifted)
const types = vs => vs.map(v => v.type);

(async () => {
  // ── 1. Unit ────────────────────────────────────────────────────────────────
  console.log('\n--- 1. Extraction and verification ---');
  {
    const src = buildSources({
      business: { name: 'Demo', pricing_info: 'Plan Base $1.500\nPlan Pro USD 40', business_context: 'Tel 2900 1122. Mail hola@demo.uy. Web https://demo.uy/planes. Entrega en 48 hs. Local en Av. Rivera 2233.' },
      runtimeCtx: { now: NOW, hoursText: 'lunes 09:00 a 18:00' },
      history: [{ role: 'user', content: 'Soy Carla, puedo ir el viernes a las 16?' }],
      userTexts: ['mi presupuesto es 3000 pesos'],
      customerPhone: '59899555666',
    });
    const v = t => findUngrounded(t, src);
    ok('loaded price passes ($1.500 = $1500)', v('Sale $1500.').length === 0);
    ok('loaded USD price passes', v('El Pro cuesta USD 40.').length === 0);
    ok('invented price flagged', types(v('Sale $1.800.')).includes('precio'));
    ok('price said by the customer passes', v('Con 3000 pesos te alcanza para el Plan Base.').length === 0);
    ok('loaded phone passes in another format', v('Llamá al 29001122.').length === 0);
    ok('invented phone flagged', types(v('Llamá al 2900 3344.')).includes('telefono'));
    ok('customer own phone passes', v('Te escribimos al 099 555 666.').length === 0);
    ok('loaded email passes', v('Escribí a hola@demo.uy').length === 0);
    ok('invented email flagged', types(v('Escribí a ventas@demo.uy')).includes('email'));
    ok('loaded link passes without protocol', v('Mirá demo.uy/planes').length === 0);
    ok('invented link flagged', types(v('Mirá demo.uy/ofertas')).includes('link'));
    ok('loaded address passes', v('Estamos en Av. Rivera 2233.').length === 0);
    ok('invented address flagged', types(v('Estamos en Av. Rivera 4000.')).includes('direccion'));
    ok('loaded hours pass (9 a 18)', v('Atendemos de 9 a 18 hs.').length === 0);
    ok('invented hour flagged', types(v('Cerramos a las 20:30.')).includes('horario'));
    ok('hour said by the customer passes', v('Dale Carla, el viernes a las 16 te esperamos.').length === 0);
    ok('loaded deadline passes (48 hs = 2 días)', v('La entrega demora 2 días.').length === 0);
    ok('invented deadline flagged', types(v('La entrega demora 5 días.')).includes('plazo'));
    ok('"un minuto" is not a deadline', v('Dame un minuto.').length === 0);
    ok('today/tomorrow dates pass', v('Mañana 26 de noviembre te confirmo.').length === 0);
    ok('invented date flagged', types(v('Llega el 20/12.')).includes('fecha'));
    ok('invented percentage flagged', types(v('Tenés 35% off.')).includes('porcentaje'));
    ok('invented product name flagged', types(v('También tenemos el Plan Platino.')).includes('nombre'));
    ok('loaded product name passes', v('Te recomiendo el Plan Pro.').length === 0);
    ok('sentence-initial capital is not a name', v('Perfecto. Gracias por escribir. Cualquier cosa avisame.').length === 0);
    ok('markers are ignored', v('[NEEDS_HUMAN]\nEso lo confirma el equipo. [BOOK_SLOT:T12]').length === 0);
    ok('image: only prices and contact data are checked',
      findUngrounded('Veo 12 unidades del modelo Zeta.', src, { hasImage: true }).length === 0 &&
      types(findUngrounded('Eso sale $999.', src, { hasImage: true })).includes('precio'));
    ok('prompt examples are NOT sources ($9.999 absent)', types(v('Sale $9.999')).includes('precio'));
    ok("today's day of the month cannot back a price", types(v('Sale $25.')).includes('precio') && types(v('Sale $25.000.')).includes('precio'));
    ok('total for N units passes when the quantity is written ($1.500 x 3)', v('Tres planes Base serían $4.500 en total.').length === 0);
    ok('same total without the quantity is NOT assumed', types(v('El plan Familiar sale $4.500.')).includes('precio'));
    ok('quantity may come from the client message', findUngrounded('Serían $6.000 en total.', buildSources({ business: { pricing_info: 'Plan Base $1.500' }, userTexts: ['quiero 4 planes base'] })).length === 0);
    ok('two units passes', v('Los dos juntos $3.000.').length === 0);
    ok('a total that is not a multiple or sum of loaded prices is flagged', types(v('En total serían $4.700.')).includes('precio'));
    ok('a number that is not written as a price is not a base for totals', types(v('Sale $4.466.')).includes('precio')); // 2233 (street number) x 2
    ok('subtotal then total in the same reply passes', v('Dos Base son $3.000, más el Pro USD 40.').length === 0 && v('Dos planes Base $3.000 y tres $4.500, en total $7.500.').length === 0);
    ok('subtotal + a loaded price passes', v('Dos Base son $3.000 y con otro más $4.500.').length === 0);
    ok('a round multiple of a loaded price is still an invention', types(v('Serían $30.000.')).includes('precio') && types(v('El plan Oro cuesta $6.000.')).includes('precio'));
    ok('English contractions are not names', v("Sure, I'll check and I'm here to help.").length === 0);
    ok('honorifics are not names', v('Buenas tardes Sra. Carla, lo vemos.').length === 0);
    const sum = summarizeViolations([{ type: 'telefono', value: '099 111 222' }, { type: 'precio', value: '$5' }]);
    ok('log summary hides phones', !sum.includes('099') && sum.includes('precio:$5'));
    ok('correction note names the data', buildCorrectionNote([{ type: 'precio', value: '$5' }]).includes('"$5" (precio)'));
  }

  // ── 2 + 3. Three businesses × 15 trap questions ────────────────────────────
  for (const b of BUSINESSES) {
    console.log(`\n--- 2. Trap questions: ${b.business.name} (${b.traps.length}) ---`);
    ok(`${b.key}: has 15 trap questions`, b.traps.length === 15);
    for (const trap of b.traps) {
      const sources = buildSources({ business: b.business, runtimeCtx: { now: NOW, hoursText: b.hoursText }, history: [], userTexts: [trap.q] });
      const found = findUngrounded(trap.bad, sources);
      ok(`${b.key}: detected — ${trap.q}`, types(found).includes(trap.expect), `got ${JSON.stringify(found)}`);

      // Model insists on inventing → fixed deferral, nothing invented reaches the client.
      let calls = 0, note = null;
      const insists = await groundReply({ reply: trap.bad, sources, regenerate: async (n) => { calls++; note = n; return trap.bad; } });
      const clientText = insists.reply.replace('[NEEDS_HUMAN]\n', '');
      ok(`${b.key}: replaced when model insists — ${trap.q}`,
        insists.action === 'replaced' && clientText === FALLBACK_REPLY && calls === 1 &&
        found.every(f => note.includes(f.value)) && findUngrounded(insists.reply, sources).length === 0,
        `action=${insists.action} calls=${calls}`);

      // Model corrects itself on the retry → the corrected reply is sent.
      const fixed = 'Ese dato no lo tengo cargado, te lo confirma alguien del equipo.';
      const corrected = await groundReply({ reply: trap.bad, sources, regenerate: async () => fixed });
      ok(`${b.key}: retry accepted — ${trap.q}`, corrected.action === 'regenerated' && corrected.reply === fixed);
    }

    console.log(`--- 3. Loaded data passes: ${b.business.name} ---`);
    for (const good of b.good) {
      const sources = buildSources({ business: b.business, runtimeCtx: { now: NOW, hoursText: b.hoursText }, history: [], userTexts: ['hola, ¿hacen envíos a Salto?'] });
      let calls = 0;
      const r = await groundReply({ reply: good, sources, regenerate: async () => { calls++; return good; } });
      ok(`${b.key}: untouched — ${good.slice(0, 50)}`, r.action === 'ok' && r.reply === good && calls === 0, JSON.stringify(r.first));
    }
  }

  // Modes + regeneration failure
  console.log('\n--- Modes ---');
  {
    const sources = buildSources({ business: BUSINESSES[0].business, runtimeCtx: { now: NOW } });
    const bad = 'El alisado sale $3.200.';
    const log = await groundReply({ reply: bad, sources, mode: 'log', regenerate: async () => { throw new Error('must not run'); } });
    ok('mode=log keeps the reply and reports', log.action === 'logged' && log.reply === bad && log.first.length === 1);
    const off = await groundReply({ reply: bad, sources, mode: 'off', regenerate: async () => '' });
    ok('mode=off skips the check', off.action === 'off' && off.reply === bad);
    const err = await groundReply({ reply: bad, sources, regenerate: async () => { throw new Error('api down'); } });
    ok('regeneration error → fixed deferral', err.action === 'replaced' && err.reply.endsWith(FALLBACK_REPLY));
  }

  // ── 4. System prompt ───────────────────────────────────────────────────────
  console.log('\n--- 4. System prompt ---');
  {
    const b = BUSINESSES[0];
    const p = buildSystemPrompt(b.business, null, null, { now: NOW, hoursText: b.hoursText });
    ok('explicit rule present', p.staticText.includes('LO QUE NO ESTÁ CARGADO NO SE AFIRMA'));
    ok('rule sits before the business data', p.staticText.indexOf('LO QUE NO ESTÁ CARGADO') < p.staticText.indexOf('PRECIOS Y SERVICIOS'));
    ok('weekly hours are given to the model', p.staticText.includes('HORARIOS DE ATENCIÓN') && p.staticText.includes('sábado 10:00 a 14:00'));
    ok('no hours block when none are loaded', !buildSystemPrompt(BUSINESSES[1].business, null, null, { now: NOW }).staticText.includes('HORARIOS DE ATENCIÓN'));
    ok('unlisted products must not be estimated', p.staticText.includes('no lo estimes ni lo calcules'));
    const retry = buildSystemPrompt(b.business, null, null, { now: NOW, groundingNote: 'CORRECCIÓN OBLIGATORIA: x' });
    ok('correction note goes in the dynamic block (cache kept)', retry.dynamicText.includes('CORRECCIÓN OBLIGATORIA') && !retry.staticText.includes('CORRECCIÓN OBLIGATORIA'));
    const capped = buildSystemPrompt(b.business, null, null, { now: NOW, priceCap: { max: 2, remaining: 0 } });
    ok('price-cap text no longer promises "te lo confirmo"', !/lo consultás con el equipo y se lo confirmás/.test(capped.dynamicText));
  }

  // ── 5. End-to-end through processIncomingMessage ───────────────────────────
  console.log('\n--- 5. End-to-end (test harness) ---');
  let token = '';
  function req(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      if (token) headers['X-Test-Token'] = token;
      const data = body ? JSON.stringify(body) : null;
      if (data) headers['Content-Length'] = Buffer.byteLength(data);
      const r = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method, headers }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); } catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); } });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 'grounding-secret', NODE_ENV: 'test', DAXOS_TEST_HARNESS: '1', RAILWAY_ENVIRONMENT: '', GROUNDING_MODE: '' },
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const ready = await new Promise(resolve => {
    const to = setTimeout(() => resolve(false), 15000);
    server.stdout.on('data', d => {
      out += String(d);
      const m = out.match(/\[test-harness\] token=([0-9a-f]{64})/);
      if (m) token = m[1];
      if (out.includes('Server running')) { clearTimeout(to); resolve(true); }
    });
  });
  ok('server started with harness', ready && !!token);

  if (ready && token) {
    try {
      await new Promise(r => setTimeout(r, 300));
      const reg = await req('POST', '/auth/register', { email: `g-${Date.now()}@t.com`, password: 'G1Pass1!x' });
      const cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
      const fx = BUSINESSES[0].business;
      await req('PUT', '/api/business', { name: fx.name, business_context: fx.business_context, pricing_info: fx.pricing_info, business_hours: HOURS_WEEK }, cookie);
      const bizId = (await req('GET', '/api/business', null, cookie)).body?.id;
      ok('business created', !!bizId);

      const Database = require('better-sqlite3');
      const sql = new Database(path.join(DB_DIR, 'daxos.db'));
      sql.prepare('UPDATE businesses SET response_delay = 0 WHERE id = ?').run(bizId);
      const phone = '59891777001';
      const lastAssistant = () => sql.prepare(`SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.business_id = ? AND c.customer_id = ? AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1`).get(bizId, phone)?.content;
      const conv = () => sql.prepare('SELECT id, needs_human FROM conversations WHERE business_id = ? AND customer_id = ?').get(bizId, phone);
      const logs = () => sql.prepare("SELECT message FROM error_log WHERE context = 'grounding' ORDER BY id").all().map(r => r.message);
      const send = async (text, replies) => {
        for (const reply of replies) await req('POST', '/test/mock-reply', { reply });
        return req('POST', '/test/inject-message', { businessId: bizId, customerPhone: phone, text });
      };

      // (a) loaded data → sent as is, no log
      const good = 'El corte dama sale $800 y atendemos de 9 a 18 hs.';
      await send('cuanto sale el corte?', [good]);
      ok('(a) grounded reply stored untouched', lastAssistant() === good, lastAssistant());
      ok('(a) nothing logged', logs().length === 0);
      ok('(a) owner not flagged', conv()?.needs_human === 0);

      // (b) invented price, model corrects on retry
      const fixed = 'El alisado no lo tengo cargado, te lo confirma alguien del equipo.';
      await send('cuanto sale el alisado?', ['El alisado sale $3.200.', fixed]);
      ok('(b) retry reply is the one stored', lastAssistant() === fixed, lastAssistant());
      ok('(b) logged as regenerated', logs().some(l => l.includes('action=regenerated') && l.includes('precio:$3.200')));

      // (c) model insists → fixed deferral + owner flagged + logged without personal data
      await send('y la manicura? pasame el telefono', ['La manicura sale $450, llamá al 2707 4455.', 'Sale $450, el teléfono es 2707 4455.']);
      ok('(c) client gets the fixed deferral', lastAssistant() === FALLBACK_REPLY, lastAssistant());
      ok('(c) invented data never stored', !/450|2707/.test(lastAssistant() || ''));
      ok('(c) conversation flagged for the owner', conv()?.needs_human === 1);
      const replaced = logs().find(l => l.includes('action=replaced'));
      ok('(c) logged as replaced with business and conversation ids', !!replaced && replaced.includes(`biz=${bizId}`) && replaced.includes(`conv=${conv().id}`));
      ok('(c) log has no customer phone and hides the invented phone', !!replaced && !replaced.includes(phone) && !replaced.includes('2707') && replaced.includes('telefono:[oculto]'));

      sql.close();
    } catch (e) {
      ok('end-to-end run', false, e.stack || e.message);
    }
  }
  server.kill('SIGTERM');

  console.log('\n================================================================');
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
