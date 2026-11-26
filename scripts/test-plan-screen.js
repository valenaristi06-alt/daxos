'use strict';
/**
 * "Activar mi plan" → plans screen in the panel (/dashboard.html#planes).
 *
 *  1. Every trial email and owner WhatsApp notice points there; no WhatsApp link.
 *  2. Logged out: the panel sends the owner to log in and back to the plans screen.
 *  3. The screen shows Arranque, Crecimiento and Negocio, each with its Mercado Pago
 *     button, plan prices only, and "Pagá con este mismo email: <owner email>".
 *  4. Shown in every trial stage (also while the trial is still running), no duplicate
 *     cards with the trial banner, nothing for partner CRM / cortesía accounts.
 *  5. Inicio's "Activar mi plan" buttons go to the screen, not to WhatsApp.
 *
 * Real browser (Playwright, Chromium). Run: node scripts/test-plan-screen.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');

const DB_DIR = '/tmp/test-plan-screen';
const PORT = 3285;
const BASE = `http://localhost:${PORT}`;
try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
fs.mkdirSync(DB_DIR, { recursive: true });

let passed = 0, failed = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PLANS_URL = 'https://daxos.lat/dashboard.html#planes';
const MP = { arranque: 'https://mpago.la/21dFEqv', crecimiento: 'https://mpago.la/1p6rYFk', a_medida: 'https://mpago.la/1D3SSYi' };

function req(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
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

(async () => {
  // ── 1. Links in emails and WhatsApp notices ───────────────────────────────
  console.log('\n--- 1. Every "Activar mi plan" points to the plans screen ---');
  {
    const realFetch = global.fetch;
    const bodies = [];
    global.fetch = async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, status: 200 }; };
    process.env.RESEND_API_KEY = 'unit';
    delete process.env.APP_URL;
    const email = require('../src/email');
    await email.sendTrialWarningEmail({ to: 'duena@negocio.uy', businessName: 'X', convCount: 120, convLimit: 150, dayNum: 11, dayLimit: 14 });
    await email.sendTrialGraceEmail({ to: 'duena@negocio.uy', businessName: 'X', graceConvsLeft: 25, graceHoursLeft: 72 });
    await email.sendTrialEndedEmail({ to: 'duena@negocio.uy', businessName: 'X' });
    for (const b of bodies) {
      ok(`email "${b.subject.split(' —')[0]}": button → plans screen, no WhatsApp`, b.html.includes(`href="${PLANS_URL}"`) && !/wa\.me|whatsapp\.com/i.test(b.html));
      ok(`email "${b.subject.split(' —')[0]}": names the owner's email to pay with`, b.html.includes('duena@negocio.uy'));
    }
    global.fetch = realFetch;
    const srv = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    ok('owner WhatsApp trial notices use the plans screen', /const TRIAL_ACTIVATE_LINK = `\$\{process\.env\.APP_URL \|\| 'https:\/\/daxos\.lat'\}\/dashboard\.html#planes`/.test(srv));
    const activationWa = /wa\.me\/59892052508\?text=Quiero%20activar/;
    ok('no "activar mi plan" WhatsApp link left in server, emails, panel or inicio',
      !['src/server.js', 'src/email.js', 'public/dashboard.html', 'public/inicio.html'].some(f => activationWa.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))));
  }

  // ── Server + browser ──────────────────────────────────────────────────────
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_DIR, SESSION_SECRET: 'plan-screen-secret', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const ready = await new Promise(resolve => {
    const to = setTimeout(() => resolve(false), 15000);
    const onData = d => { out += String(d); if (out.includes('Server running')) { clearTimeout(to); resolve(true); } };
    server.stdout.on('data', onData); server.stderr.on('data', onData);
  });
  ok('server started', ready, out.slice(-300));
  let browser = null;
  if (ready) {
    try {
      await sleep(300);
      const sql = new Database(path.join(DB_DIR, 'daxos.db'));
      const PASS = 'Plan1Pass!x';
      async function owner(tag, set = {}) {
        const email = `${tag}@plan-test.com`;
        const reg = await req('POST', '/auth/register', { email, password: PASS });
        const cookie = reg.headers['set-cookie']?.[0]?.split(';')[0];
        await req('PUT', '/api/business', { name: `Negocio ${tag}` }, cookie);
        const id = sql.prepare('SELECT business_id FROM users WHERE email = ?').get(email).business_id;
        for (const [k, v] of Object.entries(set)) sql.prepare(`UPDATE businesses SET ${k} = ? WHERE id = ?`).run(v, id);
        sql.pragma('wal_checkpoint(FULL)');
        return { email, id };
      }
      const running = await owner('en-prueba', { trial_starts_at: new Date(Date.now() - 3 * 864e5).toISOString(), trial_ends_at: new Date(Date.now() + 11 * 864e5).toISOString() });
      const ended = await owner('vencida', { trial_starts_at: new Date(Date.now() - 20 * 864e5).toISOString(), trial_ends_at: new Date(Date.now() - 6 * 864e5).toISOString() });
      const partner = await owner('socio', { plan: 'crm' });

      browser = await chromium.launch({ headless: true });
      async function login(page, email) {
        await page.fill('#email', email);
        await page.fill('#password', PASS);
        await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('button[type="submit"]')]);
      }
      async function readScreen(page) {
        await page.waitForSelector('#planes:not([hidden])', { timeout: 8000 });
        return page.evaluate(() => {
          const sec = document.getElementById('planes');
          return {
            text: sec.innerText,
            links: [...sec.querySelectorAll('a.plan-upgrade-btn')].map(a => ({ plan: a.dataset.plan, href: a.href, label: a.textContent.trim() })),
            names: [...sec.querySelectorAll('.plan-upgrade-name')].map(e => e.textContent.trim()),
            emailLine: sec.querySelector('.plan-pay-email')?.innerText || '',
            inView: sec.getBoundingClientRect().top < window.innerHeight,
            bannerCards: document.querySelectorAll('#trial-banner .plan-upgrade-card').length,
            url: location.pathname + location.hash,
          };
        });
      }

      // ── 2 + 3. Logged out → login → back to the plans screen ───────────────
      console.log('\n--- 2. Logged out: login and back to the plans screen ---');
      for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        const ctx = await browser.newContext({ viewport: vp });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/dashboard.html#planes`);
        await page.waitForURL(/\/login\.html/, { timeout: 8000 });
        const next = new URL(page.url()).searchParams.get('next');
        ok(`${vp.width}px: sent to login with the plans screen as "next"`, next === '/dashboard.html#planes', page.url());
        await login(page, running.email);
        const sc = await readScreen(page);
        // The panel already tidied its URL to /dashboard (same page); the #planes part must survive.
        ok(`${vp.width}px: back on the plans screen after login`, /^\/dashboard(\.html)?#planes$/.test(sc.url), sc.url);
        console.log('\n--- 3. The screen ---');
        ok(`${vp.width}px: three plans, in order`, sc.names.join() === 'Arranque,Crecimiento,Negocio', sc.names.join());
        ok(`${vp.width}px: each has its Mercado Pago button`, sc.links.length === 3 && sc.links.every(l => l.href === MP[l.plan] && l.label === 'Pagar →'), JSON.stringify(sc.links));
        ok(`${vp.width}px: plan prices shown`, ['$2.990', '$5.990', '$12.990'].every(p => sc.text.includes(p)));
        ok(`${vp.width}px: no internal costs`, !/USD|U\$S|costo|gasto|tokens?|d[oó]lar/i.test(sc.text));
        ok(`${vp.width}px: "Pagá con este mismo email: <owner email>" above the buttons`, sc.emailLine === `Pagá con este mismo email: ${running.email}`, sc.emailLine);
        ok(`${vp.width}px: email line comes before the plan buttons`, await page.evaluate(() => {
          const e = document.querySelector('#planes .plan-pay-email'), g = document.querySelector('#planes .plan-upgrade-grid');
          return !!(e && g && (e.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING));
        }));
        ok(`${vp.width}px: screen scrolled into view`, sc.inView);
        ok(`${vp.width}px: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        await page.screenshot({ path: path.join(DB_DIR, `planes-${vp.width}.png`), fullPage: false });
        await ctx.close();
      }

      // ── 4. Stages and accounts ─────────────────────────────────────────────
      console.log('\n--- 4. Every stage, no duplicates, partner accounts ---');
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/login.html?next=${encodeURIComponent('/dashboard.html#planes')}`);
        await login(page, ended.email);
        const sc = await readScreen(page);
        ok('trial ended: plans screen shown with the owner email', sc.links.length === 3 && sc.emailLine.endsWith(ended.email));
        ok('trial ended: banner keeps its message but not a second set of cards', sc.bannerCards === 0 && (await page.textContent('#trial-banner')).includes('terminó'));
        await page.goto(`${BASE}/dashboard.html`);
        await page.waitForSelector('#trial-banner .plan-upgrade-card', { timeout: 8000 });
        ok('without #planes: banner shows the cards as before (with the owner email)', !(await page.isVisible('#planes')) && (await page.textContent('#trial-banner .plan-pay-email')).includes(ended.email));
        await page.evaluate(() => { location.hash = '#planes'; });
        await page.waitForSelector('#planes:not([hidden])', { timeout: 5000 });
        ok('opening #planes from inside the panel works too', (await page.$$eval('#planes a.plan-upgrade-btn', a => a.length)) === 3);
        await ctx.close();
      }
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/login.html?next=${encodeURIComponent('/dashboard.html#planes')}`);
        await login(page, partner.email);
        await page.waitForSelector('#planes:not([hidden])', { timeout: 8000 });
        ok('partner CRM account: no payment buttons', (await page.$$eval('#planes a.plan-upgrade-btn', a => a.length)) === 0);
        await ctx.close();
      }
      ok('login refuses other destinations (open redirect guard kept)', await (async () => {
        const ctx = await browser.newContext(); const page = await ctx.newPage();
        await page.goto(`${BASE}/login.html?next=${encodeURIComponent('//evil.example/x#planes')}`);
        await login(page, running.email);
        const u = new URL(page.url()); await ctx.close();
        return u.host === `localhost:${PORT}` && u.pathname === '/inicio.html';
      })());

      // ── 5. Inicio ──────────────────────────────────────────────────────────
      console.log('\n--- 5. Inicio ---');
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/login.html`);
        await login(page, ended.email);
        await page.waitForSelector('#trial-banner .trial-action', { timeout: 8000 });
        const href = await page.getAttribute('#trial-banner .trial-action', 'href');
        ok('inicio: "Activar mi plan" → plans screen', href === '/dashboard.html#planes', href);
        await Promise.all([page.waitForNavigation(), page.click('#trial-banner .trial-action')]);
        const sc = await readScreen(page);
        ok('inicio: clicking it opens the plans screen', sc.links.length === 3);
        await ctx.close();
      }
      sql.close();
    } catch (e) {
      ok('browser run', false, e.stack || e.message);
    }
  }
  if (browser) await browser.close();
  server.kill('SIGTERM');

  console.log('\n================================================================');
  console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
