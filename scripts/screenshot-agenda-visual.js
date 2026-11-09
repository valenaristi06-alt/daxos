'use strict';
/**
 * Playwright visual check for agenda.html:
 * - B.1: Month view on 360/390/430 — 7 columns visible, no horizontal overflow
 * - B.3a: Hour label not clipped on day view
 * - B.3b: Toggle touch target (mobile cancelled-toggle-mobile, desktop sidebar)
 * - B.3c: Month names lowercase in period title
 * - B.3d: Grid width stable when detail panel opens
 * Screenshots → /tmp/agenda-shots/
 *
 * Run: node scripts/screenshot-agenda-visual.js
 */

const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const { spawn, execSync } = require('child_process');
const { chromium, webkit } = require('playwright');

const TEST_PORT = 3267;
const DB_DIR    = '/tmp/test-agenda-visual';
const BASE      = `http://localhost:${TEST_PORT}`;
const SHOTS_DIR = '/tmp/agenda-shots';
const WORKTREE  = path.join(__dirname, '..');

fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });

let serverProc = null;
let passed = 0, failed = 0;
let userEmail = '';
const userPass = 'VizPass1!';

function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {}
    await sleep(500);
  }
  return false;
}

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: WORKTREE,
    env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 'vis-test-secret', NODE_ENV: '', RAILWAY_ENVIRONMENT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', d => { const s = String(d); if (s.startsWith('[migration]') || s.startsWith('[agenda]') || s.startsWith('[srv]')) return; process.stderr.write(s); });
  return proc;
}

async function setup() {
  serverProc = startServer();
  const started = await waitForServer();
  if (!started) throw new Error('Server did not start');
  await sleep(300);

  userEmail = `vis-${Date.now()}@t.com`;
  const r1 = await req('POST', '/auth/register', { email: userEmail, password: userPass });
  const cookie = r1.headers['set-cookie']?.[0]?.split(';')[0];
  if (!cookie) throw new Error('No cookie from register');

  await req('PUT', '/api/business', {
    name: 'Visual Test Biz',
    business_context: 'Test',
    business_hours: JSON.stringify({
      1:[['09:00','18:00']], 2:[['09:00','18:00']], 3:[['09:00','18:00']],
      4:[['09:00','18:00']], 5:[['09:00','18:00']], 6:[['09:00','13:00']],
    }),
  }, { cookie });

  const Database = require('better-sqlite3');
  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  db.prepare("UPDATE businesses SET plan='crecimiento', plan_paid_at=datetime('now'), agenda_enabled=1 WHERE name='Visual Test Biz'").run();
  db.close();

  await req('POST', '/api/agenda/services', { name: 'Consulta', durationMin: 30, sortOrder: 0 }, { cookie });

  const today = new Date().toISOString().slice(0, 10);
  await req('POST', '/api/agenda/appointments', {
    customerPhone: '59891000001', clientName: 'María García',
    date: today, time: '10:00',
  }, { cookie });
  await req('POST', '/api/agenda/appointments', {
    customerPhone: '59891000002', clientName: 'Carlos López',
    date: today, time: '11:30',
  }, { cookie });
}

// Login via Playwright UI form
async function loginInPage(page) {
  await page.fill('#email', userEmail);
  await page.fill('#password', userPass);
  await page.click('button[type=submit]');
  await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
  await sleep(400);
}

async function getAuthPage(browser, url, w, h) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: w, height: h });
  // Go to login first
  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
  await loginInPage(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  await sleep(600);
  return { page, ctx };
}

async function main() {
  console.log('\n--- Setup server ---');
  try {
    await setup();
    console.log(`  ✓ server ready (${userEmail})`);
  } catch (e) {
    console.error('  ✗ setup failed:', e.message);
    if (serverProc) serverProc.kill('SIGTERM');
    process.exit(1);
  }

  const agendaUrl = `${BASE}/agenda.html`;

  // ── Chromium tests ────────────────────────────────────────────────────────
  console.log('\n--- Chromium ---');
  const browser = await chromium.launch({ headless: true });

  // B.1 — Month view on 360/390/430
  console.log('\n--- B.1: Month view mobile ---');
  for (const w of [360, 390, 430]) {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, w, 844);
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(500); } catch {}

    await page.screenshot({ path: path.join(SHOTS_DIR, `mes-${w}-chromium.png`) });
    console.log(`  📸 /tmp/agenda-shots/mes-${w}-chromium.png`);

    const overflow = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      winWidth: window.innerWidth,
      gridCols: (() => {
        const cells = document.querySelectorAll('.month-dow-hdr');
        const rects = Array.from(cells).map(c => c.getBoundingClientRect());
        return { count: cells.length, widths: rects.map(r => Math.round(r.width)) };
      })(),
    }));
    ok(`B.1 no horizontal overflow @${w}px`, overflow.docWidth <= overflow.winWidth,
      `scrollWidth=${overflow.docWidth} > innerWidth=${overflow.winWidth}`);
    if (overflow.gridCols.count > 0) {
      ok(`B.1 all 7 columns visible @${w}px`, overflow.gridCols.count === 7,
        `got ${overflow.gridCols.count}`);
      const minW = Math.min(...overflow.gridCols.widths);
      ok(`B.1 no clipped column @${w}px (min=${minW}px)`, minW >= 30,
        `widths: ${overflow.gridCols.widths.join(',')}`);
    }
    await ctx.close();
  }

  // Required screenshots
  console.log('\n--- Required screenshots ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 390, 844);
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(400); } catch {}
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mes-390.png') });
    console.log('  📸 /tmp/agenda-shots/mes-390.png');
    try { await page.click('#btn-view-day', { timeout: 3000 }); await sleep(300); } catch {}
    await page.screenshot({ path: path.join(SHOTS_DIR, 'dia-390.png') });
    console.log('  📸 /tmp/agenda-shots/dia-390.png');
    await ctx.close();
  }
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 1280, 900);
    try { await page.click('#btn-view-week', { timeout: 3000 }); await sleep(400); } catch {}
    await page.screenshot({ path: path.join(SHOTS_DIR, 'semana-1280.png') });
    console.log('  📸 /tmp/agenda-shots/semana-1280.png');
    try { await page.click('#btn-view-day', { timeout: 3000 }); await sleep(300); } catch {}
    // Try to open detail panel
    const aptBlock = page.locator('.apt-block').first();
    if (await aptBlock.count() > 0) { await aptBlock.click(); await sleep(400); }
    await page.screenshot({ path: path.join(SHOTS_DIR, 'dia-1280-panel.png') });
    console.log('  📸 /tmp/agenda-shots/dia-1280-panel.png');
    await ctx.close();
  }

  // B.3a — Hour label not clipped
  console.log('\n--- B.3a: Hour label not clipped ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 390, 844);
    await sleep(300);
    const issues = await page.evaluate(() => {
      const labels = document.querySelectorAll('.timeline-hour-label');
      return Array.from(labels).filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < 0 || r.right > window.innerWidth;
      }).map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, text: el.textContent.trim() }));
    });
    ok('B.3a hour labels not clipped on 390px', issues.length === 0,
      issues.length > 0 ? JSON.stringify(issues[0]) : '');
    await ctx.close();
  }

  // B.3b — Toggle touch target (mobile)
  console.log('\n--- B.3b: Toggle touch target (mobile) ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 390, 844);
    await sleep(400);
    const info = await page.evaluate(() => {
      // Mobile version visible on <1024px
      const mobileWrap = document.getElementById('cancelled-toggle-mobile');
      const mobileTrack = mobileWrap ? mobileWrap.querySelector('.cancelled-toggle-track') : null;
      const wr = mobileWrap ? mobileWrap.getBoundingClientRect() : null;
      const tr = mobileTrack ? mobileTrack.getBoundingClientRect() : null;
      return {
        mobileVisible: mobileWrap ? (mobileWrap.offsetParent !== null && getComputedStyle(mobileWrap).display !== 'none') : false,
        wrapH: wr ? Math.round(wr.height) : 0,
        trackW: tr ? Math.round(tr.width) : 0,
        trackH: tr ? Math.round(tr.height) : 0,
      };
    });
    ok('B.3b mobile cancelled toggle visible at 390px', info.mobileVisible, `visible=${info.mobileVisible}`);
    ok('B.3b mobile toggle wrap ≥44px tall', info.wrapH >= 44, `got ${info.wrapH}px`);
    ok('B.3b mobile toggle track ≥40px wide', info.trackW >= 40, `got ${info.trackW}px`);
    ok('B.3b mobile toggle track ≥22px tall', info.trackH >= 22, `got ${info.trackH}px`);
    await ctx.close();
  }

  // B.3b desktop — sidebar toggle at 1280px
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 1280, 900);
    await sleep(300);
    const info = await page.evaluate(() => {
      const wrap = document.querySelector('.agenda-sidebar-bottom .cancelled-toggle-wrap');
      const track = wrap ? wrap.querySelector('.cancelled-toggle-track') : null;
      const wr = wrap ? wrap.getBoundingClientRect() : null;
      const tr = track ? track.getBoundingClientRect() : null;
      return {
        wrapH: wr ? Math.round(wr.height) : 0,
        trackW: tr ? Math.round(tr.width) : 0,
        trackH: tr ? Math.round(tr.height) : 0,
      };
    });
    ok('B.3b desktop sidebar toggle ≥40px wide', info.trackW >= 40, `got ${info.trackW}px`);
    ok('B.3b desktop sidebar toggle ≥22px tall', info.trackH >= 22, `got ${info.trackH}px`);
    await ctx.close();
  }

  // B.3c — Month names lowercase
  console.log('\n--- B.3c: Month names lowercase ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 1280, 900);
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(400); } catch {}
    const title = await page.locator('#agenda-date-label').textContent();
    const startsLower = title.length > 0 && title[0] === title[0].toLowerCase();
    ok('B.3c period title starts lowercase', startsLower, `got: "${title}"`);
    // Should contain a month name
    const monthFound = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'].some(m => title.toLowerCase().includes(m));
    ok('B.3c period title contains a month name', monthFound, `title: "${title}"`);
    await ctx.close();
  }

  // B.3d — Grid width stable when panel opens
  console.log('\n--- B.3d: Grid width stable when panel opens ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 1280, 900);
    await sleep(400);
    const before = await page.evaluate(() => {
      const c = document.querySelector('.agenda-content');
      return c ? Math.round(c.getBoundingClientRect().width) : null;
    });
    const aptBlocks = await page.locator('.apt-block').count();
    if (aptBlocks > 0 && before !== null) {
      await page.locator('.apt-block').first().click();
      await sleep(400);
      const after = await page.evaluate(() => {
        const c = document.querySelector('.agenda-content');
        return c ? Math.round(c.getBoundingClientRect().width) : null;
      });
      ok('B.3d grid width unchanged after panel open', before === after,
        `before=${before} after=${after}`);
    } else {
      console.log(`  (appointments: ${aptBlocks}, before: ${before})`);
      ok('B.3d apt blocks found in view', aptBlocks > 0, `count=${aptBlocks}`);
    }
    await ctx.close();
  }

  // B.1r — toggle visibility after resize without page reload
  console.log('\n--- B.1r: Mobile toggle CSS responsive (resize, no reload) ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 1280, 900);
    await sleep(400);

    // At 1280px: mobile toggle must be display:none (media query), desktop visible
    const at1280 = await page.evaluate(() => {
      const mobile = document.getElementById('cancelled-toggle-mobile');
      const desktopSidebar = document.querySelector('.agenda-left-sidebar');
      return {
        mobileDisplay: mobile ? getComputedStyle(mobile).display : 'missing',
        desktopSidebarDisplay: desktopSidebar ? getComputedStyle(desktopSidebar).display : 'missing',
      };
    });
    ok('B.1r 1280px: mobile toggle hidden by CSS media query',
      at1280.mobileDisplay === 'none', `display="${at1280.mobileDisplay}"`);
    ok('B.1r 1280px: desktop sidebar visible',
      at1280.desktopSidebarDisplay !== 'none', `display="${at1280.desktopSidebarDisplay}"`);

    // Resize to 390 WITHOUT reload
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);

    const at390 = await page.evaluate(() => {
      const mobile = document.getElementById('cancelled-toggle-mobile');
      return {
        mobileDisplay: mobile ? getComputedStyle(mobile).display : 'missing',
        mobileInlineStyle: mobile ? (mobile.style.display || '(empty)') : 'missing',
      };
    });
    ok('B.1r 390px (no reload): mobile toggle CSS display is flex',
      at390.mobileDisplay === 'flex', `display="${at390.mobileDisplay}"`);
    ok('B.1r 390px (no reload): no inline style overriding CSS',
      at390.mobileInlineStyle === '(empty)', `inline="${at390.mobileInlineStyle}"`);

    // Resize back to 1280 WITHOUT reload
    await page.setViewportSize({ width: 1280, height: 900 });
    await sleep(200);

    const at1280b = await page.evaluate(() => {
      const mobile = document.getElementById('cancelled-toggle-mobile');
      return { mobileDisplay: mobile ? getComputedStyle(mobile).display : 'missing' };
    });
    ok('B.1r 1280px (re-expand, no reload): mobile toggle hidden again',
      at1280b.mobileDisplay === 'none', `display="${at1280b.mobileDisplay}"`);

    await ctx.close();
  }

  // B.3d mobile — sheet close button exists and works
  console.log('\n--- B.3d mobile: Sheet close button ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 390, 844);
    await sleep(300);

    const closeBtnExists = await page.locator('#sheet-close').count() > 0;
    ok('B.3d mobile: #sheet-close button exists in DOM', closeBtnExists);

    if (closeBtnExists) {
      const apts = await page.locator('.apt-block').count();
      if (apts > 0) {
        await page.locator('.apt-block').first().click();
        await sleep(400);

        const sheetOpen = await page.evaluate(() =>
          document.getElementById('apt-sheet')?.classList.contains('open') ?? false);
        ok('B.3d mobile: sheet opens on apt-block click', sheetOpen);

        if (sheetOpen) {
          await page.locator('#sheet-close').click();
          await sleep(300);
          const sheetClosed = await page.evaluate(() =>
            !(document.getElementById('apt-sheet')?.classList.contains('open') ?? true));
          ok('B.3d mobile: #sheet-close closes the sheet', sheetClosed);
        }
      } else {
        ok('B.3d mobile: apt-blocks found for sheet test', false, 'count=0');
      }
    }

    await ctx.close();
  }

  // T2 — New visual checks (Tarea 2)
  console.log('\n--- T2.1a: Title scrollWidth <= clientWidth (no truncation) ---');
  for (const w of [360, 390, 430]) {
    for (const viewBtn of ['#btn-view-month', '#btn-view-day']) {
      const { page, ctx } = await getAuthPage(browser, agendaUrl, w, 844);
      try { await page.click(viewBtn, { timeout: 3000 }); await sleep(400); } catch {}
      const info = await page.evaluate(() => {
        const el = document.getElementById('agenda-date-label');
        return el ? { sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent.trim() } : null;
      });
      const viewName = viewBtn.includes('month') ? 'Mes' : 'Día';
      ok(`T2.1a title no truncation @${w}px ${viewName}`,
        !info || info.sw <= info.cw + 1,
        info ? `scrollWidth=${info.sw} > clientWidth=${info.cw} text="${info.text}"` : 'element missing');
      await ctx.close();
    }
  }

  console.log('\n--- T2.1b: View selector right edge ≤ viewportWidth-16 ---');
  for (const w of [360, 390, 430]) {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, w, 844);
    await sleep(300);
    const info = await page.evaluate(() => {
      const toggle = document.querySelector('.view-toggle');
      const r = toggle ? toggle.getBoundingClientRect() : null;
      return r ? { right: Math.round(r.right), vw: window.innerWidth } : null;
    });
    ok(`T2.1b selector right ≤ vw-16 @${w}px`,
      !info || info.right <= info.vw - 16,
      info ? `right=${info.right} vw=${info.vw} margin=${info.vw - info.right}px` : 'element missing');
    await ctx.close();
  }

  console.log('\n--- T2.3: Month → Day shows selected date, not day 1 ---');
  {
    const { page, ctx } = await getAuthPage(browser, agendaUrl, 390, 844);
    await sleep(300);
    // Get current date shown in day view (before switching to month)
    const dayLabel = await page.locator('#agenda-date-label').textContent();
    // Switch to month view
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(400); } catch {}
    // Switch back to day view
    try { await page.click('#btn-view-day', { timeout: 3000 }); await sleep(400); } catch {}
    const dayLabelAfter = await page.locator('#agenda-date-label').textContent();
    // Both labels should show today's date, not "1 de …"
    const startsWithOne = /^[A-Za-záéíóú]+ 1 de /i.test(dayLabelAfter);
    ok('T2.3 month→day: not showing day 1 after return', !startsWithOne,
      `label after return="${dayLabelAfter}"`);
    ok('T2.3 month→day: same label before and after', dayLabel === dayLabelAfter,
      `before="${dayLabel}" after="${dayLabelAfter}"`);
    await ctx.close();
  }

  console.log('\n--- T2.4: First hour label not hidden by header (Día + Semana @1280) ---');
  {
    // Day view
    const { page: pd, ctx: cd } = await getAuthPage(browser, agendaUrl, 1280, 900);
    await sleep(300);
    const dayInfo = await pd.evaluate(() => {
      const labels = document.querySelectorAll('.timeline-hour-label');
      if (!labels.length) return null;
      const first = labels[0];
      const tl = document.querySelector('.timeline-wrap');
      return {
        labelTop: Math.round(first.getBoundingClientRect().top),
        wrapTop:  Math.round(tl ? tl.getBoundingClientRect().top : 0),
      };
    });
    if (dayInfo) {
      ok('T2.4 day: first hour label below timeline-wrap top',
        dayInfo.labelTop >= dayInfo.wrapTop,
        `labelTop=${dayInfo.labelTop} wrapTop=${dayInfo.wrapTop}`);
    } else {
      ok('T2.4 day: .timeline-hour-label elements found', false, 'none found');
    }
    await cd.close();
  }
  {
    // Week view
    const { page: pw, ctx: cw } = await getAuthPage(browser, agendaUrl, 1280, 900);
    try { await pw.click('#btn-view-week', { timeout: 3000 }); await sleep(500); } catch {}
    const weekInfo = await pw.evaluate(() => {
      const hdrRow = document.getElementById('week-header-row');
      const ticks  = document.querySelectorAll('.week-axis-tick');
      if (!hdrRow || !ticks.length) return null;
      return {
        hdrBottom:  Math.round(hdrRow.getBoundingClientRect().bottom),
        firstTop:   Math.round(ticks[0].getBoundingClientRect().top),
      };
    });
    if (weekInfo) {
      ok('T2.4 week: first axis-tick top ≥ header bottom',
        weekInfo.firstTop >= weekInfo.hdrBottom,
        `tick.top=${weekInfo.firstTop} hdr.bottom=${weekInfo.hdrBottom}`);
    } else {
      ok('T2.4 week: week-header-row and axis-ticks found', false, 'elements missing');
    }
    await cw.close();
  }

  await browser.close();

  // ── WebKit (Safari) ───────────────────────────────────────────────────────
  console.log('\n--- WebKit (Safari) ---');
  const wkBrowser = await webkit.launch({ headless: true });

  for (const w of [360, 390]) {
    const { page, ctx } = await getAuthPage(wkBrowser, agendaUrl, w, 844);
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(500); } catch {}
    const ov = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    }));
    ok(`B.1 WebKit no overflow @${w}px`, ov.docW <= ov.winW,
      `scrollWidth=${ov.docW}`);
    await ctx.close();
  }

  // B.3b WebKit mobile toggle
  {
    const { page, ctx } = await getAuthPage(wkBrowser, agendaUrl, 390, 844);
    await sleep(400);
    const info = await page.evaluate(() => {
      const t = document.getElementById('cancelled-toggle-mobile');
      const track = t ? t.querySelector('.cancelled-toggle-track') : null;
      const r = track ? track.getBoundingClientRect() : null;
      return { visible: t ? (t.offsetParent !== null) : false, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
    });
    ok('B.3b WebKit mobile toggle visible', info.visible);
    ok('B.3b WebKit toggle track ≥40px', info.w >= 40, `got ${info.w}px`);
    await ctx.close();
  }

  // T2 WebKit: title not truncated + selector in bounds
  console.log('\n--- T2 WebKit: title + selector ---');
  for (const w of [360, 390]) {
    const { page, ctx } = await getAuthPage(wkBrowser, agendaUrl, w, 844);
    await sleep(300);
    const info = await page.evaluate(() => {
      const title  = document.getElementById('agenda-date-label');
      const toggle = document.querySelector('.view-toggle');
      const tr = toggle ? toggle.getBoundingClientRect() : null;
      return {
        titleSW: title ? title.scrollWidth : 0,
        titleCW: title ? title.clientWidth : 0,
        toggleRight: tr ? Math.round(tr.right) : 0,
        vw: window.innerWidth,
      };
    });
    ok(`T2 WebKit title no truncation @${w}px`, info.titleSW <= info.titleCW + 1,
      `sw=${info.titleSW} cw=${info.titleCW}`);
    ok(`T2 WebKit selector right ≤ vw-16 @${w}px`, info.toggleRight <= info.vw - 16,
      `right=${info.toggleRight} vw=${info.vw}`);
    await ctx.close();
  }

  // T2.3 WebKit: month→day date restoration
  {
    const { page, ctx } = await getAuthPage(wkBrowser, agendaUrl, 390, 844);
    await sleep(300);
    const before = await page.locator('#agenda-date-label').textContent();
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(400); } catch {}
    try { await page.click('#btn-view-day', { timeout: 3000 }); await sleep(400); } catch {}
    const after = await page.locator('#agenda-date-label').textContent();
    ok('T2.3 WebKit: month→day restores date', before === after,
      `before="${before}" after="${after}"`);
    await ctx.close();
  }

  await wkBrowser.close();

  // ── Required screenshots (clean /tmp/agenda-shots/ first) ─────────────────
  console.log('\n--- Regenerating screenshots ---');
  fs.readdirSync(SHOTS_DIR).forEach(f => { try { fs.unlinkSync(path.join(SHOTS_DIR, f)); } catch (_) {} });

  const shotBrowser = await chromium.launch({ headless: true });
  for (const w of [360, 390]) {
    const { page, ctx } = await getAuthPage(shotBrowser, agendaUrl, w, 844);
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(500); } catch {}
    await page.screenshot({ path: path.join(SHOTS_DIR, `mes-${w}.png`) });
    console.log(`  📸 mes-${w}.png`);
    await ctx.close();
  }
  {
    const { page, ctx } = await getAuthPage(shotBrowser, agendaUrl, 390, 844);
    // Switch month then back to day — screenshots the day view after the fix
    try { await page.click('#btn-view-month', { timeout: 3000 }); await sleep(300); } catch {}
    try { await page.click('#btn-view-day', { timeout: 3000 }); await sleep(400); } catch {}
    await page.screenshot({ path: path.join(SHOTS_DIR, 'dia-390.png') });
    console.log('  📸 dia-390.png (after month→day)');
    await ctx.close();
  }
  {
    const { page, ctx } = await getAuthPage(shotBrowser, agendaUrl, 1280, 900);
    try { await page.click('#btn-view-week', { timeout: 3000 }); await sleep(500); } catch {}
    // Scroll to top so first hour label is visible
    await page.evaluate(() => {
      const wrap = document.getElementById('week-grid-wrap');
      if (wrap) wrap.scrollTop = 0;
    });
    await sleep(200);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'semana-1280.png') });
    console.log('  📸 semana-1280.png (scrolled to top)');
    await ctx.close();
  }
  await shotBrowser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log(`${passed + failed} visual checks — ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');
  console.log('Screenshots in /tmp/agenda-shots/:');
  fs.readdirSync(SHOTS_DIR).sort().forEach(f => console.log('  /tmp/agenda-shots/' + f));
}

main()
  .catch(e => { console.error('Fatal:', e.message); process.exit(1); })
  .finally(() => {
    if (serverProc) serverProc.kill('SIGTERM');
    try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {}
  });
