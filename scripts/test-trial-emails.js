'use strict';
/**
 * End-of-trial emails (aviso, gracia, prueba terminada).
 *
 *  1. Texts: clear subject, working activation link, no internal costs, test prefix.
 *  2. Simulation is the default: nothing is sent or written until TRIAL_CHECK_DRY_RUN=0.
 *     The preview endpoint lists who would receive what (id, name, stage only).
 *  3. Real sending: each email goes ONCE per business and per stage, however many times
 *     the daily job runs and whether the stage was reached by the job or by a client
 *     message. Partner CRM, cortesía and paid accounts never receive them.
 *  4. A provider failure does not burn the stage: the next run retries.
 *  5. /admin/api/test-mails?only=trial sends the three emails to ADMIN_EMAIL.
 *
 * Emails go to a local mock of the provider (RESEND_BASE_URL) — nothing leaves the machine.
 * Run: node scripts/test-trial-emails.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const Database = require('better-sqlite3');

const DB_DIR = '/tmp/test-trial-emails';
const PORT = 3277, MAIL_PORT = 3278;
const TOKEN = 'test-trial-emails-token';
const ADMIN = 'admin@trial-test.com';
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const mails = [];           // { to, subject, html }
let failFor = null;         // recipient the mock rejects (provider failure)
const mailSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let m = null;
    try { m = JSON.parse(body); } catch (_) {}
    if (m && failFor && m.to[0] === failFor) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"provider down"}'); }
    if (m) mails.push({ to: m.to[0], subject: m.subject, html: m.html });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"mock"}');
  });
});
const mailsTo = to => mails.filter(m => m.to === to);
const stageOf = m => /está por terminar/.test(m.subject) ? 'warning' : /sigue respondiendo/.test(m.subject) ? 'grace' : /dejó de responder/.test(m.subject) ? 'ended' : 'other';

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (opts.testToken) headers['X-Test-Token'] = opts.testToken;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); } catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  // ── 1. Texts ───────────────────────────────────────────────────────────────
  console.log('\n--- 1. Email texts ---');
  {
    const realFetch = global.fetch;
    const sentBodies = [];
    global.fetch = async (url, opts) => { sentBodies.push({ url, ...JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
    process.env.RESEND_API_KEY = 'unit-key';
    const email = require('../src/email');
    const LINK = 'https://wa.me/59892052508?text=Quiero%20activar%20mi%20plan';
    const name = 'Café <Sol> & Cía';
    await email.sendTrialWarningEmail({ to: 'a@b.com', businessName: name, convCount: 120, convLimit: 150, dayNum: 11, dayLimit: 14 });
    await email.sendTrialGraceEmail({ to: 'a@b.com', businessName: name, graceConvsLeft: 25, graceHoursLeft: 71.2 });
    await email.sendTrialEndedEmail({ to: 'a@b.com', businessName: name });
    const [w, g, e] = sentBodies;
    ok('three different subjects', new Set(sentBodies.map(b => b.subject)).size === 3);
    ok('aviso: subject says the trial is about to end', /está por terminar/.test(w.subject) && w.subject.includes(name));
    ok('gracia: subject says it ended and the assistant keeps answering', /terminó/.test(g.subject) && /sigue respondiendo/.test(g.subject));
    ok('terminada: subject says the assistant stopped', /dejó de responder/.test(e.subject));
    for (const [label, b] of [['aviso', w], ['gracia', g], ['terminada', e]]) {
      ok(`${label}: activation link present and well-formed`, b.html.includes(`href="${LINK}"`) && /^https:\/\/wa\.me\/\d{11}\?text=[\w%]+$/.test(LINK));
      ok(`${label}: fallback phone number shown as text`, b.html.includes('+598 92 052 508'));
      ok(`${label}: no internal costs or amounts`, !/\$|USD|U\$S|costo|gasto|tokens?|d[oó]lar/i.test(b.html));
      ok(`${label}: business name escaped`, b.html.includes('Café &lt;Sol&gt; &amp; Cía') && !b.html.includes('<Sol>'));
      ok(`${label}: sent from the Daxos address to the owner`, b.from.includes('notificaciones@daxos.lat') && b.to[0] === 'a@b.com');
    }
    ok('aviso: shows progress and what happens next', w.html.includes('11 de 14') && w.html.includes('120 de 150') && w.html.includes('72 horas'));
    ok('gracia: shows what is left', g.html.includes('≈72 horas') && g.html.includes('25'));
    ok('terminada: tells what clients see and that nothing is lost', e.html.includes('alguien del negocio te va a contestar') && e.html.includes('siguen guardadas'));
    sentBodies.length = 0;
    await email.sendTrialEndedEmail({ to: 'a@b.com', businessName: 'X', subjectPrefix: '[PRUEBA] ' });
    ok('test prefix supported', sentBodies[0].subject.startsWith('[PRUEBA] '));
    delete process.env.RESEND_API_KEY;
    const skipped = await email.sendTrialEndedEmail({ to: 'a@b.com', businessName: 'X' });
    ok('without provider key: reports skipped, sends nothing', skipped?.skipped === true && sentBodies.length === 1);
    global.fetch = realFetch;
  }

  // ── Server ─────────────────────────────────────────────────────────────────
  await new Promise(r => mailSrv.listen(MAIL_PORT, r));
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 'trial-emails-secret', NODE_ENV: 'test', DAXOS_TEST_HARNESS: '1',
      RAILWAY_ENVIRONMENT: '', ADMIN_SET_WA_TOKEN: TOKEN, ADMIN_EMAIL: ADMIN, RESEND_API_KEY: 'test-key-not-real',
      RESEND_BASE_URL: `http://localhost:${MAIL_PORT}`, TRIAL_CHECK_DRY_RUN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', harnessToken = '';
  const ready = await new Promise(resolve => {
    const to = setTimeout(() => resolve(false), 15000);
    const onData = d => {
      out += String(d);
      const m = out.match(/\[test-harness\] token=([0-9a-f]{64})/);
      if (m) harnessToken = m[1];
      if (out.includes('Server running')) { clearTimeout(to); resolve(true); }
    };
    server.stdout.on('data', onData); server.stderr.on('data', onData);
  });
  ok('server started', ready, out.slice(-300));
  if (!ready) { server.kill('SIGTERM'); mailSrv.close(); process.exit(1); }
  await sleep(300);

  const sql = new Database(path.join(DB_DIR, 'daxos.db'));
  const flush = () => sql.pragma('wal_checkpoint(FULL)');

  // Registers an owner + business in trial. daysAgo = days since the trial started.
  async function seed(tag, { daysAgo = 0, set = {} } = {}) {
    const email = `${tag}@trial-test.com`;
    const reg = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
    const cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
    await req('PUT', '/api/business', { name: `Negocio ${tag}` }, { cookie });
    const id = sql.prepare('SELECT business_id FROM users WHERE email = ?').get(email).business_id;
    sql.prepare(`UPDATE businesses SET phone_number_id = ?, wa_provider = 'meta', response_delay = 0,
      trial_starts_at = datetime('now', ? || ' days'), trial_ends_at = datetime('now', ? || ' days') WHERE id = ?`)
      .run(`pnid-${id}`, String(-daysAgo), String(14 - daysAgo), id);
    for (const [k, v] of Object.entries(set)) sql.prepare(`UPDATE businesses SET ${k} = ? WHERE id = ?`).run(v, id);
    flush();
    return { id, email, name: `Negocio ${tag}` };
  }
  const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();
  const runJob = async (qs = '') => { const r = await req('POST', `/admin/api/run-trial-check${qs}`, null, { bearer: TOKEN }); await sleep(350); return r; };
  const preview = () => req('GET', '/admin/api/trial-emails/preview', null, { bearer: TOKEN });
  const biz = id => sql.prepare('SELECT * FROM businesses WHERE id = ?').get(id);

  try {
    const warn    = await seed('aviso',     { daysAgo: 11 });
    const graceOp = await seed('gracia-abre', { daysAgo: 14 });
    const graceAc = await seed('gracia-activa', { daysAgo: 14, set: { trial_grace_started_at: hoursAgo(10) } });
    const ended   = await seed('terminada', { daysAgo: 14, set: { trial_grace_started_at: hoursAgo(80) } });
    const direct  = await seed('corte-directo', { daysAgo: 25 });
    const fresh   = await seed('recien-empieza', { daysAgo: 2 });
    const crm     = await seed('socio-crm', { daysAgo: 25, set: { plan: 'crm' } });
    const cortesia = await seed('cortesia', { daysAgo: 25, set: { plan_cortesia: 1 } });
    const paid    = await seed('pago', { daysAgo: 25, set: { plan_paid_at: new Date().toISOString() } });

    // ── 2. Simulation by default ─────────────────────────────────────────────
    console.log('\n--- 2. Simulation is the default ---');
    const dry = await runJob();
    ok('job runs', dry.status === 200 && dry.body.ok);
    ok('simulation: no email sent', mails.length === 0);
    ok('simulation: nothing written', !biz(warn.id).trial_warned_at && !biz(graceOp.id).trial_grace_started_at &&
      sql.prepare("SELECT COUNT(*) n FROM owner_alert_log WHERE kind LIKE 'trial_email_%'").get().n === 0);
    ok('simulation log has business id and stage but no owner email', /\[trial-daily-dry\] biz=\d+ state=warning would-send=warning/.test(out) && !/\[trial-daily-dry\][^\n]*@/.test(out));

    const pv = await preview();
    const byId = Object.fromEntries((pv.body.businesses || []).map(b => [b.id, b]));
    ok('preview: reports that sending is off', pv.status === 200 && pv.body.sending_enabled === false);
    ok('preview: lists exactly the five businesses due an email', pv.body.count === 5 && [warn, graceOp, graceAc, ended, direct].every(b => byId[b.id]), JSON.stringify(pv.body));
    ok('preview: right stage for each', byId[warn.id]?.stage === 'warning' && byId[graceOp.id]?.stage === 'grace' && byId[graceAc.id]?.stage === 'grace' && byId[ended.id]?.stage === 'ended' && byId[direct.id]?.stage === 'ended');
    ok('preview: only id, name and stage', (pv.body.businesses || []).every(b => Object.keys(b).sort().join() === 'id,name,stage') && byId[warn.id].name === warn.name);
    ok('preview: partner CRM, cortesía, paid and early-trial accounts are not listed', ![crm, cortesia, paid, fresh].some(b => byId[b.id]));
    ok('preview sends nothing', mails.length === 0);
    ok('preview needs the admin token', (await req('GET', '/admin/api/trial-emails/preview')).status === 403);

    // ── 3. Real sending: once per business and per stage ─────────────────────
    console.log('\n--- 3. Real sending: once per business and stage ---');
    await runJob('?dry_run=0');
    ok('first real run: one email per due business (5)', mails.length === 5, `got ${mails.length}`);
    ok('aviso → warning email', mailsTo(warn.email).length === 1 && stageOf(mailsTo(warn.email)[0]) === 'warning');
    ok('gracia (opens now) → grace email', mailsTo(graceOp.email).length === 1 && stageOf(mailsTo(graceOp.email)[0]) === 'grace' && !!biz(graceOp.id).trial_grace_started_at);
    ok('gracia (already open) → grace email', mailsTo(graceAc.email).length === 1 && stageOf(mailsTo(graceAc.email)[0]) === 'grace');
    ok('gracia agotada → ended email', mailsTo(ended.email).length === 1 && stageOf(mailsTo(ended.email)[0]) === 'ended');
    ok('vencida hace mucho → ended email', mailsTo(direct.email).length === 1 && stageOf(mailsTo(direct.email)[0]) === 'ended');
    ok('partner CRM account gets nothing', mailsTo(crm.email).length === 0);
    ok('cortesía account gets nothing', mailsTo(cortesia.email).length === 0);
    ok('paid account gets nothing', mailsTo(paid.email).length === 0);
    ok('business early in its trial gets nothing', mailsTo(fresh.email).length === 0);

    for (let i = 0; i < 5; i++) await runJob('?dry_run=0');
    ok('five more runs the same day: still 5 emails in total (no repeats)', mails.length === 5, `got ${mails.length}`);

    // Next days: the job keeps running daily. Simulate by clearing the old 1/day marker.
    sql.prepare('UPDATE businesses SET trial_grace_notified_at = NULL').run(); flush();
    for (let i = 0; i < 3; i++) await runJob('?dry_run=0');
    ok('runs on following days: grace and ended are NOT re-sent daily', mails.length === 5, `got ${mails.length}`);
    ok('preview is empty once everything was sent', (await preview()).body.count === 0);

    // A business moves through the three stages: one email each, never repeated.
    console.log('\n--- Stage progression ---');
    sql.prepare("UPDATE businesses SET trial_starts_at = datetime('now', '-14 days'), trial_ends_at = datetime('now', '-1 hours') WHERE id = ?").run(warn.id); flush();
    await runJob('?dry_run=0'); await runJob('?dry_run=0');
    ok('aviso → gracia: one grace email', mailsTo(warn.email).map(stageOf).join() === 'warning,grace', mailsTo(warn.email).map(stageOf).join());
    sql.prepare('UPDATE businesses SET trial_grace_started_at = ? WHERE id = ?').run(hoursAgo(75), warn.id); flush();
    await runJob('?dry_run=0'); await runJob('?dry_run=0');
    ok('gracia → terminada: one ended email, three in total', mailsTo(warn.email).map(stageOf).join() === 'warning,grace,ended', mailsTo(warn.email).map(stageOf).join());

    // A restarted trial can be notified again.
    sql.prepare("UPDATE businesses SET trial_starts_at = datetime('now', '+1 seconds', '-11 days'), trial_ends_at = datetime('now', '+3 days'), trial_warned_at = NULL, trial_grace_started_at = NULL WHERE id = ?").run(direct.id); flush();
    await sleep(1200);
    await runJob('?dry_run=0');
    ok('restarted trial: the warning goes out for the new trial', mailsTo(direct.email).map(stageOf).join() === 'ended,warning', mailsTo(direct.email).map(stageOf).join());

    // ── 4. Provider failure → retried, not lost ──────────────────────────────
    console.log('\n--- 4. Provider failure ---');
    const flaky = await seed('proveedor-caido', { daysAgo: 25 });
    failFor = flaky.email;
    await runJob('?dry_run=0');
    ok('provider down: nothing delivered', mailsTo(flaky.email).length === 0);
    ok('provider down: business is still pending in the preview', (await preview()).body.businesses.some(b => b.id === flaky.id));
    failFor = null;
    await runJob('?dry_run=0'); await runJob('?dry_run=0');
    ok('provider back: sent once', mailsTo(flaky.email).length === 1 && stageOf(mailsTo(flaky.email)[0]) === 'ended');

    // ── Live path (a client writes) and the daily job share the same once-only rule ──
    console.log('\n--- Client message + daily job ---');
    const live = await seed('mensaje-cliente', { daysAgo: 14 });
    for (let i = 0; i < 3; i++) {
      await req('POST', '/test/mock-reply', { reply: 'Hola, ¿en qué te ayudo?' }, { testToken: harnessToken });
      await req('POST', '/test/inject-message', { businessId: live.id, customerPhone: `5989177700${i}`, text: 'hola' }, { testToken: harnessToken });
    }
    await sleep(400);
    ok('client message opens grace: one grace email', mailsTo(live.email).map(stageOf).join() === 'grace' && !!biz(live.id).trial_grace_started_at, mailsTo(live.email).map(stageOf).join());
    await runJob('?dry_run=0'); await runJob('?dry_run=0');
    ok('daily job afterwards does not send it again', mailsTo(live.email).length === 1);

    // ── 5. Test emails to the admin ──────────────────────────────────────────
    console.log('\n--- 5. Test emails to the admin account ---');
    const before = mails.length;
    const tm = await req('POST', '/admin/api/test-mails?only=trial', null, { bearer: TOKEN });
    await sleep(300);
    const test = mails.slice(before);
    ok('only=trial sends exactly the three trial emails', tm.status === 200 && Object.keys(tm.body).sort().join() === 'trial_aviso,trial_gracia,trial_terminada' && Object.values(tm.body).every(v => v === 'ok'), JSON.stringify(tm.body));
    ok('all three go to ADMIN_EMAIL with the [PRUEBA] prefix', test.length === 3 && test.every(m => m.to === ADMIN && m.subject.startsWith('[PRUEBA] ')));
    ok('one of each stage', test.map(stageOf).sort().join() === 'ended,grace,warning');
  } catch (e) {
    ok('run', false, e.stack || e.message);
  }

  sql.close(); server.kill('SIGTERM'); mailSrv.close();

  // ── 6. Notices sent before this change are not repeated ─────────────────────
  console.log('\n--- 6. History from the old "one per day" logic ---');
  {
    const HIST_DIR = `${DB_DIR}-history`;
    try { execSync(`rm -rf ${HIST_DIR}`); } catch (_) {}
    fs.mkdirSync(HIST_DIR, { recursive: true });
    process.env.DB_DIR = HIST_DIR;
    const dbPath = require.resolve('../src/db');
    delete require.cache[dbPath];
    let dbm = require('../src/db');
    const mk = name => dbm.upsertBusiness({ name }).id;
    const ids = { warned: mk('Ya avisado'), graced: mk('Ya en gracia avisado'), endedB: mk('Ya terminada avisada'), never: mk('Nunca avisado'), graceNoMail: mk('Gracia sin aviso') };
    dbm.closeDb();
    const raw = new Database(path.join(HIST_DIR, 'daxos.db'));
    const iso = h => new Date(Date.now() - h * 3_600_000).toISOString();
    const up = (id, f) => { for (const [k, v] of Object.entries(f)) raw.prepare(`UPDATE businesses SET ${k} = ? WHERE id = ?`).run(v, id); };
    for (const id of Object.values(ids)) up(id, { plan: 'arranque', trial_starts_at: iso(24 * 20), trial_ends_at: iso(24 * 6) });
    up(ids.warned, { trial_warned_at: iso(24 * 9), trial_grace_notified_at: iso(24 * 9) });
    up(ids.graced, { trial_grace_started_at: iso(30), trial_grace_notified_at: iso(30) });
    const endedAt = iso(20); // old code used the same instant for the client reply and the owner notice
    up(ids.endedB, { trial_grace_started_at: iso(100), trial_grace_notified_at: endedAt });
    raw.prepare('INSERT INTO conversations (business_id, customer_id, trial_ended_notified_at) VALUES (?, ?, ?)').run(ids.endedB, '59890000001', endedAt);
    up(ids.graceNoMail, { trial_warned_at: iso(31), trial_grace_started_at: iso(30), trial_grace_notified_at: iso(31) });
    raw.prepare("DELETE FROM owner_alert_log WHERE kind LIKE 'trial_email_%'").run();
    raw.prepare("DELETE FROM schema_migrations WHERE version = '033_trial_email_backfill'").run();
    raw.pragma('wal_checkpoint(FULL)'); raw.close();

    delete require.cache[dbPath];
    dbm = require('../src/db'); // runs the migration on the "old" database
    const start = iso(24 * 20);
    const sentBefore = (id, stage) => dbm.trialEmailAlreadySent(id, stage, start);
    ok('already warned → warning recorded as sent', sentBefore(ids.warned, 'warning') && !sentBefore(ids.warned, 'grace') && !sentBefore(ids.warned, 'ended'));
    ok('grace already notified → grace recorded as sent', sentBefore(ids.graced, 'grace') && !sentBefore(ids.graced, 'ended'));
    ok('ended already notified → ended recorded as sent', sentBefore(ids.endedB, 'ended'));
    ok('never notified → nothing recorded (will receive its email)', !['warning', 'grace', 'ended'].some(st => sentBefore(ids.never, st)));
    ok('grace opened without a notice → grace still pending', sentBefore(ids.graceNoMail, 'warning') && !sentBefore(ids.graceNoMail, 'grace'));
    ok('claim is granted once', dbm.claimTrialEmail(ids.never, 'ended', start) === true && dbm.claimTrialEmail(ids.never, 'ended', start) === false);
    dbm.releaseTrialEmail(ids.never, 'ended', start);
    ok('a released claim can be taken again', dbm.claimTrialEmail(ids.never, 'ended', start) === true);
    dbm.closeDb();
    delete require.cache[dbPath];
    dbm = require('../src/db');
    ok('migration runs once (no duplicate rows on restart)', dbm.trialEmailAlreadySent(ids.warned, 'warning', start) &&
      new Database(path.join(HIST_DIR, 'daxos.db'), { readonly: true }).prepare("SELECT COUNT(*) n FROM owner_alert_log WHERE business_id = ? AND kind = 'trial_email_warning'").get(ids.warned).n === 1);
    try { execSync(`rm -rf ${HIST_DIR}`); } catch (_) {}
  }

  console.log('\n================================================================');
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
