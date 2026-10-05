#!/usr/bin/env node
'use strict';
// Tests for billing data feature (migration 006).
// Run: node scripts/test-billing.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3099;
const DB_DIR    = '/tmp/test-billing';
const ADMIN_EMAIL_ADDR = 'admin@test.com';
const ADMIN_PASS       = 'AdminPass1!test';
const BASE_URL         = `http://localhost:${TEST_PORT}`;

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

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie)  headers['Cookie'] = opts.cookie;
    if (opts.bearer)  headers['Authorization'] = `Bearer ${opts.bearer}`;
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
    try { const r = await req('GET', '/health'); if (r.status === 200) return; }
    catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}`); failed++; }
}

let db = null;
function dbGet(sql, ...params) { return db.prepare(sql).get(...params); }
function dbRun(sql, ...params) { return db.prepare(sql).run(...params); }

async function seedUser(email) {
  const r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  if (r.status !== 200) throw new Error(`register ${email} failed: ${JSON.stringify(r.body)}`);
  const cookie = r.setCookie?.[0]?.split(';')[0];
  await req('PUT', '/api/business', { name: `Biz-${email.split('@')[0]}` }, { cookie });
  return { cookie, email };
}

async function getAdminCookie() {
  // Register admin account if not exists (ignore 409)
  await req('POST', '/auth/register', { email: ADMIN_EMAIL_ADDR, password: ADMIN_PASS });
  const r = await req('POST', '/admin/auth/login', { email: ADMIN_EMAIL_ADDR, password: ADMIN_PASS });
  if (r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r.body)}`);
  return r.setCookie?.[0]?.split(';')[0];
}

async function main() {
  console.log('Starting server on port', TEST_PORT, '...');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_DIR,
      SESSION_SECRET: 'billing-test-secret',
      ADMIN_EMAIL: ADMIN_EMAIL_ADDR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  await waitForServer();
  console.log('Server up.\n');
  await sleep(500);

  const Database = require('better-sqlite3');
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(path.join(DB_DIR, 'daxos.db'));

  // ── Suite 1: save and read complete billing data ──
  console.log('Suite 1: save and read complete billing data');
  {
    const { cookie } = await seedUser('billing1@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa S.A.',
      billing_rut: '123456789012',
      billing_address: '18 de Julio 1234',
      billing_email: 'factura@empresa.com',
    }, { cookie });
    assert(r.status === 200, 'PUT /api/business/billing returns 200');
    assert(r.body.billing_requires_invoice === 1, 'billing_requires_invoice=1 persisted');
    assert(r.body.billing_legal_name === 'Empresa S.A.', 'billing_legal_name persisted');
    assert(r.body.billing_rut === '123456789012', 'billing_rut persisted');
    assert(r.body.billing_address === '18 de Julio 1234', 'billing_address persisted');
    assert(r.body.billing_email === 'factura@empresa.com', 'billing_email persisted');

    // Verify GET /api/business also returns billing fields
    const get = await req('GET', '/api/business', null, { cookie });
    assert(get.body.billing_rut === '123456789012', 'GET /api/business returns billing_rut');
  }

  // ── Suite 2: RUT with letters → 400 ──
  console.log('\nSuite 2: RUT with letters → 400');
  {
    const { cookie } = await seedUser('billing2@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa',
      billing_rut: 'AB3456789012',
    }, { cookie });
    assert(r.status === 400, 'RUT with letters → 400');
    assert(r.body.field === 'billing_rut', 'error field = billing_rut');
  }

  // ── Suite 3: RUT with 11 digits → 400 ──
  console.log('\nSuite 3: RUT with 11 digits → 400');
  {
    const { cookie } = await seedUser('billing3@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa',
      billing_rut: '12345678901',
    }, { cookie });
    assert(r.status === 400, 'RUT with 11 digits → 400');
    assert(r.body.field === 'billing_rut', 'error field = billing_rut (11 digits)');
  }

  // ── Suite 4: RUT with 12 digits → 200 ──
  console.log('\nSuite 4: RUT with 12 digits → 200');
  {
    const { cookie } = await seedUser('billing4@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa',
      billing_rut: '123456789012',
    }, { cookie });
    assert(r.status === 200, '12-digit RUT → 200');
  }

  // ── Suite 5: billing_requires_invoice=1, empty razón social → 400 ──
  console.log('\nSuite 5: requires_invoice=1, empty razón social → 400');
  {
    const { cookie } = await seedUser('billing5@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: '',
    }, { cookie });
    assert(r.status === 400, 'empty razón social → 400');
    assert(r.body.field === 'billing_legal_name', 'error field = billing_legal_name');
  }

  // ── Suite 6: invalid email → 400 ──
  console.log('\nSuite 6: invalid email → 400');
  {
    const { cookie } = await seedUser('billing6@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa',
      billing_email: 'not-an-email',
    }, { cookie });
    assert(r.status === 400, 'invalid email → 400');
    assert(r.body.field === 'billing_email', 'error field = billing_email');
  }

  // ── Suite 7 (test a): bizId in body ignored — session user's business always used ──
  console.log('\nSuite 7 (a): body bizId ignored, session biz always used');
  {
    const { cookie: cookieA } = await seedUser('billinga@test.com');
    const { cookie: cookieB } = await seedUser('billingb@test.com');
    // B saves billing data for itself
    await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa B',
      billing_rut: '999999999999',
      billing_address: 'Dirección B',
      billing_email: 'b@empresa.com',
    }, { cookie: cookieB });

    const userB = dbGet("SELECT * FROM users WHERE email = 'billingb@test.com'");
    const bizBId = userB.business_id;

    // A tries to write to B's business by including B's id — should be ignored
    await req('PUT', '/api/business/billing', {
      id: bizBId,                  // B's id in body — must be ignored
      billing_requires_invoice: 1,
      billing_legal_name: 'ATAQUE',
      billing_rut: '000000000000',
      billing_address: 'Ataque',
      billing_email: 'ataque@empresa.com',
    }, { cookie: cookieA });

    // B's data must be unchanged
    const bizB = dbGet('SELECT * FROM businesses WHERE id = ?', bizBId);
    assert(bizB.billing_legal_name === 'Empresa B', 'B billing_legal_name untouched after A send');
    assert(bizB.billing_rut === '999999999999', 'B billing_rut untouched after A send');
  }

  // ── Suite 8 (c): /admin/api/businesses does NOT expose billing PII ──
  console.log('\nSuite 8 (c): admin businesses list has no billing PII');
  {
    const adminCookie = await getAdminCookie();
    const listRes = await req('GET', '/admin/api/businesses', null, { cookie: adminCookie });
    assert(listRes.status === 200, 'admin businesses list ok');
    assert(Array.isArray(listRes.body), 'response is array');
    if (Array.isArray(listRes.body)) {
      const hasPii = listRes.body.some(b =>
        'billing_legal_name' in b || 'billing_rut' in b || 'billing_address' in b || 'billing_email' in b
      );
      assert(!hasPii, 'list does not contain billing_legal_name/rut/address/email');
      const hasFlag = listRes.body.some(b => 'billing_requires_invoice' in b);
      assert(hasFlag, 'list contains billing_requires_invoice flag');
    }
  }

  // ── Suite 9 (d): RUT with spaces and dashes → cleaned and accepted ──
  console.log('\nSuite 9 (d): RUT with spaces/dashes → cleaned');
  {
    const { cookie } = await seedUser('billingd@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa D',
      billing_rut: '12 345.678-9012',
    }, { cookie });
    assert(r.status === 200, 'RUT with spaces/dots/dashes → 200 after cleaning');
    assert(r.body.billing_rut === '123456789012', 'cleaned RUT stored as 12 digits');
  }

  // ── Suite 10 (e): admin email throttle persists in DB (not lost on restart) ──
  console.log('\nSuite 10 (e): billing_notified_at persisted in DB (DB-based throttle)');
  {
    const { cookie } = await seedUser('billinge@test.com');
    // First complete save → billing_notified_at should be set
    await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa E',
      billing_rut: '123456789012',
      billing_address: 'Dirección E',
      billing_email: 'e@empresa.com',
    }, { cookie });

    const user = dbGet("SELECT * FROM users WHERE email = 'billinge@test.com'");
    const biz = dbGet('SELECT * FROM businesses WHERE id = ?', user.business_id);
    assert(!!biz.billing_notified_at, 'billing_notified_at set in DB after first complete save');

    // Simulate "server restart" by reading billing_notified_at from DB directly
    // A second save on the same day must NOT update billing_notified_at
    const firstNotified = biz.billing_notified_at;
    await sleep(50);
    await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa E',
      billing_rut: '123456789012',
      billing_address: 'Dirección E actualizada',
      billing_email: 'e@empresa.com',
    }, { cookie });

    const biz2 = dbGet('SELECT * FROM businesses WHERE id = ?', user.business_id);
    assert(biz2.billing_notified_at === firstNotified, 'billing_notified_at unchanged on same-day second save (DB throttle)');
  }

  // ── Suite 11 (f): unchecked checkbox + empty fields → 200 OK ──
  console.log('\nSuite 11 (f): requires_invoice=0, empty fields → 200 OK');
  {
    const { cookie } = await seedUser('billingf@test.com');
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 0,
      billing_legal_name: null,
      billing_rut: null,
      billing_address: null,
      billing_email: null,
    }, { cookie });
    assert(r.status === 200, 'requires_invoice=0 + empty fields → 200');
    assert(r.body.billing_requires_invoice === 0, 'billing_requires_invoice stored as 0');
  }

  // ── Suite 12: previously saved fields preserved when checkbox unchecked ──
  console.log('\nSuite 12: uncheck preserves existing data, no mail');
  {
    const { cookie } = await seedUser('billingg@test.com');
    await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 1,
      billing_legal_name: 'Empresa G',
      billing_rut: '123456789012',
      billing_address: 'Dir G',
      billing_email: 'g@empresa.com',
    }, { cookie });

    // Uncheck — pass same fields; server saves them without validation
    const r = await req('PUT', '/api/business/billing', {
      billing_requires_invoice: 0,
      billing_legal_name: 'Empresa G',
      billing_rut: '123456789012',
      billing_address: 'Dir G',
      billing_email: 'g@empresa.com',
    }, { cookie });
    assert(r.status === 200, 'uncheck with existing fields → 200');
    assert(r.body.billing_requires_invoice === 0, 'billing_requires_invoice stored as 0');
    assert(r.body.billing_legal_name === 'Empresa G', 'billing_legal_name preserved when unchecked');
  }

  // ── Done ──
  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
