#!/usr/bin/env node
'use strict';
// Fase 2 — chat configurador. (1) Lógica pura de config-chat.js. (2) Endpoints con el
// server real + DB temporal (sin modelo: ingest usa _fakeDraft en NODE_ENV=test).

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3131;
const DB_DIR = '/tmp/test-config-chat';
let serverProc = null, passed = 0, failed = 0;
function cleanup() { if (serverProc) { try { serverProc.kill(); } catch (_) {} } try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {} }
process.on('exit', cleanup);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function assert(c, l) { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`); failed++; } }

function req(method, p, body, opts = {}) {
  return new Promise((res, rej) => {
    const headers = opts.headers || { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: p, method, headers }, (x) => {
      let d = ''; const sc = x.headers['set-cookie']; x.on('data', c => d += c);
      x.on('end', () => { try { res({ status: x.statusCode, body: JSON.parse(d), sc }); } catch { res({ status: x.statusCode, body: d, sc }); } });
    });
    r.on('error', rej);
    if (opts.raw) r.write(opts.raw); else if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
function multipart(fields) {
  const b = '----t' + Date.now(); const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${b}--\r\n`);
  const raw = parts.join('');
  return { raw, headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': Buffer.byteLength(raw) } };
}
function multipartFile(fields, fname, filename, ctype, content) {
  const b = '----t' + Date.now(); const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${b}\r\nContent-Disposition: form-data; name="${fname}"; filename="${filename}"\r\nContent-Type: ${ctype}\r\n\r\n${content}\r\n`);
  parts.push(`--${b}--\r\n`);
  const raw = parts.join('');
  return { raw, headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': Buffer.byteLength(raw) } };
}
async function waitUp() { for (let i = 0; i < 40; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch {} await sleep(500); } throw new Error('no server'); }

// ── (0) Lógica pura ──
function pureTests() {
  console.log('Suite (0): lógica pura config-chat.js');
  const cc = require('../src/config-chat');
  // nextQuestion: salta lo que ya está, orden correcto.
  let nq = cc.nextQuestion([], {});
  assert(nq && nq.id === 'que_vende', 'primera pregunta = qué vende');
  nq = cc.nextQuestion([{ field: 'business_context', value: 'x' }], {});
  assert(nq && nq.id === 'horario', 'con business_context → pregunta horario');
  nq = cc.nextQuestion([{ field: 'business_context', value: 'x' }, { field: 'business_hours', value: 'L-V' }, { field: 'pricing_info', value: '$1' }], { userPhone: '099' });
  assert(nq && nq.id === 'pagos', 'con contexto+horario+precios+tel → salta a pagos');
  const turnosQ = cc.nextQuestion([{ field: 'business_context', value: 'x' }, { field: 'business_hours', value: 'L' }, { field: 'da_precios', value: 'No' }, { field: 'user_phone', value: '099' }, { field: 'pagos_entregas', value: 'tarjeta' }], {});
  assert(turnosQ && turnosQ.id === 'turnos' && turnosQ.type === 'buttons', 'turnos es pregunta con botones');
  // summary agrupa como el panel.
  const sum = cc.summary([{ field: 'name', value: 'Mi Negocio', source: 'web' }, { field: 'pricing_info', value: '$1', source: 'web', needs_confirm: 1 }]);
  assert(sum[0].title === 'Tu negocio' && sum[0].items.length === 2, 'summary agrupa en "Tu negocio"');
  assert(sum[0].items.find(i => i.field === 'pricing_info').needs_confirm === true, 'precio marcado a confirmar');
  assert(sum[0].items[0].source === 'de tu web', 'origen traducido');
  // changePlan: diff solo de lo que cambia.
  const changes = cc.changePlan([{ field: 'name', value: 'Nuevo' }, { field: 'business_context', value: 'igual' }], { name: 'Viejo', business_context: 'igual' }, null);
  assert(changes.length === 1 && changes[0].field === 'name', 'changePlan detecta solo el cambio real');
  // applyAccepted respeta la lista aceptada.
  const writes = [];
  cc.applyAccepted(1, [{ field: 'name', value: 'A' }, { field: 'business_context', value: 'B' }], ['name'],
    { getBusinessById: () => ({ id: 1 }), upsertBusiness: (b) => writes.push(b), setUserPhone: () => {}, setBookingEnabled: () => {}, userId: 9 });
  assert(writes.length === 1 && writes[0].name === 'A' && writes[0].business_context === undefined, 'applyAccepted escribe solo name (no pisa business_context)');
}

async function main() {
  pureTests();

  execSync(`rm -rf ${DB_DIR}`); fs.mkdirSync(DB_DIR, { recursive: true });
  serverProc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 's', NODE_ENV: 'test', DAXOS_TEST_HARNESS: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  serverProc.stderr.on('data', d => { const s = String(d); if (/Error|throw/.test(s)) process.stderr.write('[srv] ' + s); });
  await waitUp(); await sleep(400);

  const Database = require('better-sqlite3');
  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  async function seed(email) {
    const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
    const cookie = r.sc[0].split(';')[0];
    await req('PUT', '/api/business', { name: 'Biz' }, { cookie });
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    return { cookie, userId: u.id, bizId: u.business_id };
  }

  // ── (a) Sin flag: nada cambia ──
  console.log('\nSuite (a): sin flag, nada cambia');
  const A = await seed('a@t.com');
  let st = await req('GET', '/api/config-chat/state', null, { cookie: A.cookie });
  assert(st.body.enabled === false, 'state.enabled=false sin flag');
  const ig = await req('POST', '/api/config-chat/ingest', null, { cookie: A.cookie, ...multipart({ text: 'hola' }) });
  assert(ig.status === 403, 'ingest sin flag → 403');
  const ap = await req('POST', '/api/config-chat/apply', {}, { cookie: A.cookie });
  assert(ap.status === 403, 'apply sin flag → 403');
  assert(db.prepare('SELECT config_chat_enabled FROM businesses WHERE id = ?').get(A.bizId).config_chat_enabled === 0, 'flag en 0 por defecto');

  // ── (b) Admin prende el flag; negocio nuevo configura ──
  console.log('\nSuite (b): flag on + flujo negocio nuevo');
  db.prepare('UPDATE businesses SET config_chat_enabled = 1 WHERE id = ?').run(A.bizId);
  st = await req('GET', '/api/config-chat/state', null, { cookie: A.cookie });
  assert(st.body.enabled === true, 'state.enabled=true con flag');
  assert(st.body.configured === false, 'negocio nuevo → configured=false');
  assert(st.body.next_question && st.body.next_question.id === 'que_vende', 'primera pregunta = qué vende');
  // ingest con borrador inyectado (sin modelo)
  const fake = JSON.stringify([
    { field: 'name', value: 'Tienda MV', source: 'web', confidence: 0.9 },
    { field: 'business_context', value: 'Vende muebles', source: 'web', confidence: 0.7 },
    { field: 'pricing_info', value: 'Silla — $100', source: 'web', confidence: 0.5, needs_confirm: 1 },
    { field: 'business_hours', value: 'Lun a Vie 9 a 18', source: 'web', confidence: 0.4 },
  ]);
  const ing = await req('POST', '/api/config-chat/ingest', null, { cookie: A.cookie, ...multipart({ _fakeDraft: fake }) });
  assert(ing.status === 200 && ing.body.draft.length === 4, 'ingest guarda 4 campos del borrador');
  assert(ing.body.next_question && ing.body.next_question.id === 'celular', 'siguiente pregunta = celular (lo demás ya está)');
  // responder celular
  let ans = await req('POST', '/api/config-chat/answer', { field: 'user_phone', value: '099111222' }, { cookie: A.cookie });
  assert(ans.body.next_question && ans.body.next_question.id === 'pagos', 'tras celular → pagos');
  await req('POST', '/api/config-chat/answer', { field: 'pagos_entregas', value: 'Tarjeta y envío' }, { cookie: A.cookie });
  await req('POST', '/api/config-chat/answer', { field: 'turnos', value: 'No' }, { cookie: A.cookie });
  await req('POST', '/api/config-chat/answer', { field: 'nunca_decir', value: 'Nada en especial' }, { cookie: A.cookie });
  ans = await req('POST', '/api/config-chat/answer', { field: 'sales_examples', value: 'Hola!\n¿Te ayudo?\nGracias' }, { cookie: A.cookie });
  assert(ans.body.next_question === null, 'respondido todo → no quedan preguntas');
  assert(ans.body.summary.find(b => b.title === 'Tu negocio'), '"Esto es lo que entendí" agrupado');

  // ── (c) Aplicar escribe en el panel ──
  console.log('\nSuite (c): aplicar escribe en el panel');
  const applied = await req('POST', '/api/config-chat/apply', {}, { cookie: A.cookie });
  assert(applied.status === 200, 'apply ok');
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(A.bizId);
  assert(biz.name === 'Tienda MV' && biz.business_context === 'Vende muebles' && /Silla/.test(biz.pricing_info), 'campos escritos en businesses');
  assert(/Pagos y entregas|Nunca/.test(biz.owner_rules || ''), 'owner_rules compone pagos/nunca');
  assert(db.prepare('SELECT phone FROM users WHERE id = ?').get(A.userId).phone === '099111222', 'user_phone guardado');
  assert(db.prepare("SELECT COUNT(*) n FROM config_drafts WHERE business_id = ? AND status='pending'").get(A.bizId).n === 0, 'borrador limpiado tras aplicar');

  // ── (d) Negocio ya configurado: diff, no pisa sin aceptar ──
  console.log('\nSuite (d): negocio configurado → cambios uno por uno');
  st = await req('GET', '/api/config-chat/state', null, { cookie: A.cookie });
  assert(st.body.configured === true, 'ahora configured=true');
  await req('POST', '/api/config-chat/ingest', null, { cookie: A.cookie, ...multipart({ _fakeDraft: JSON.stringify([{ field: 'name', value: 'Tienda MV 2', source: 'web' }]) }) });
  const chg = await req('GET', '/api/config-chat/changes', null, { cookie: A.cookie });
  assert(chg.body.changes.length === 1 && chg.body.changes[0].field === 'name' && chg.body.changes[0].to === 'Tienda MV 2', 'changes muestra solo el nombre');
  // aplicar SIN aceptar el cambio → no pisa
  await req('POST', '/api/config-chat/apply', { acceptedFields: [] }, { cookie: A.cookie });
  assert(db.prepare('SELECT name FROM businesses WHERE id = ?').get(A.bizId).name === 'Tienda MV', 'sin aceptar → NO pisó el nombre');

  // ── (e) Audio del dueño en TODOS los planes (incluido Arranque) ──
  // El límite por plan es para las respuestas con VOZ del bot, no para que el dueño
  // explique su negocio por audio. El ingest no gatea audio por plan.
  console.log('\nSuite (e): audio del dueño aceptado en todos los planes');
  const audioDraft = JSON.stringify([{ field: 'business_context', value: 'explicado por audio', source: 'audio' }]);
  for (const plan of ['arranque', 'crecimiento', 'a_medida']) {
    db.prepare('UPDATE businesses SET plan = ? WHERE id = ?').run(plan, A.bizId);
    const r = await req('POST', '/api/config-chat/ingest', null, { cookie: A.cookie, ...multipartFile({ _fakeDraft: audioDraft }, 'audio', 'nota.ogg', 'audio/ogg', 'bytesdeaudio') });
    assert(r.status === 200, `audio del dueño aceptado en plan ${plan}`);
  }
  // Las respuestas con voz del bot NO cambian: el gate sigue siendo planAllowsVoice
  // (crecimiento/a_medida) en dashboard.html; esta fase no lo tocó.
  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert(/planAllowsVoice\s*=\s*\['crecimiento',\s*'a_medida'\]/.test(dashHtml), 'gate de voz del bot (respuestas) intacto');

  // ── (f) Admin flag route ──
  console.log('\nSuite (f): ruta admin del flag');
  const noAdmin = await req('POST', `/admin/api/config-chat-flag/${A.bizId}`, { enabled: false }, { cookie: A.cookie });
  assert(noAdmin.status === 401 || noAdmin.status === 403, 'sin admin → bloqueado');

  console.log(`\n── Resultados ── passed=${passed} failed=${failed}`);
  db.close(); serverProc.kill();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); cleanup(); process.exit(1); });
