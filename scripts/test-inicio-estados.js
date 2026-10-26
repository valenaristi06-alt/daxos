'use strict';
/**
 * Playwright: verifica inicio.html para los 4 estados del seed.
 * Uso: node scripts/test-inicio-estados.js
 */
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const REPO    = path.join(__dirname, '..');
const DB_DIR  = path.join(REPO, 'data-local-test');
const PORT    = 3002; // usar 3002 para no chocar con local-seguro
const BASE    = `http://localhost:${PORT}`;
const EMAIL   = 'test@local.dev';
const PASS    = 'prueba1234';

const VIEWPORTS = [
  { name: '390', width: 390,  height: 844  },
  { name: '1440', width: 1440, height: 900 },
];

const ESTADOS = ['activo', 'vacio', 'desconectado', 'prueba'];

// ── helpers ──────────────────────────────────────────────────────────────────

function startServer(estado) {
  const env = {
    ...process.env,
    DB_DIR,
    NODE_ENV: 'development',
    PORT: String(PORT),
    SESSION_SECRET: 'test-secret-inicio-estados',
    SEED_ESTADO: estado,
    KAPSO_API_KEY: '',
    KAPSO_WEBHOOK_SECRET: '',
    KAPSO_PLATFORM_WEBHOOK_SECRET: '',
    RESEND_API_KEY: '',
    R2_ACCOUNT_ID: '',
    R2_BUCKET_NAME: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    META_SYSTEM_TOKEN: '',
    META_APP_SECRET: '',
    META_WEBHOOK_VERIFY_TOKEN: '',
    WHATSAPP_VERIFY_TOKEN: '',
    WA_HEALTH_ALERTS: '',
    MERCADOPAGO_ACCESS_TOKEN: '',
    MERCADOPAGO_WEBHOOK_SECRET: '',
    ELEVENLABS_API_KEY: '',
  };
  return spawn('node', ['src/server.js'], { cwd: REPO, env, stdio: 'pipe' });
}

async function waitReady(ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/auth/me`);
      if (res.status === 401 || res.status === 200) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server did not start in time');
}

function runSeed(estado) {
  execSync(`node scripts/seed-local.js`, {
    cwd: REPO,
    env: { ...process.env, DB_DIR, SEED_ESTADO: estado },
    stdio: 'pipe',
  });
}

async function login(page) {
  // Register (idempotent)
  await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  await page.goto(`${BASE}/login.html`);
  await page.fill('input[type="email"]',    EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/inicio.html`, { timeout: 8000 });
}

// ── DOM checks ────────────────────────────────────────────────────────────────

async function checkInicio(page) {
  // Wait for async render to finish
  await page.waitForFunction(() => {
    const h = document.getElementById('inicio-headline');
    return h && h.textContent && h.textContent !== '';
  }, { timeout: 8000 });

  const headline    = await page.$eval('#inicio-headline',  el => el.textContent.trim()).catch(() => '(no headline)');
  const bannerEl    = await page.$('#trial-banner');
  const bannerVis   = bannerEl ? await bannerEl.evaluate(el => el.style.display !== 'none' && el.offsetParent !== null) : false;
  const bannerText  = bannerVis ? await bannerEl.evaluate(el => el.textContent.trim().replace(/\s+/g, ' ')) : '';
  const waOk        = await page.$('.inicio-status-ok').then(el => !!el).catch(() => false);
  const waErr       = await page.$('.inicio-status-error').then(el => !!el).catch(() => false);
  const hasCard     = await page.$('.lc-card').then(el => !!el).catch(() => false);
  const hasEmpty    = await page.$('.lc-empty').then(el => !!el).catch(() => false);

  return { headline, bannerVis, bannerText, waOk, waErr, hasCard, hasEmpty };
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(DB_DIR, { recursive: true });

  const results = {};
  let passed = 0;
  let failed = 0;

  const browser = await chromium.launch();

  for (const estado of ESTADOS) {
    // Wipe DB so each estado starts clean
    const dbPath = path.join(DB_DIR, 'daxos.db');
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath);
      if (fs.existsSync(dbPath + '-wal'))  fs.rmSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm'))  fs.rmSync(dbPath + '-shm');
    }

    const srv = startServer(estado);
    let srvErrors = '';
    srv.stderr.on('data', d => { srvErrors += d.toString(); });

    try {
      await waitReady();
      runSeed(estado);

      results[estado] = {};
      for (const vp of VIEWPORTS) {
        const ctx  = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        try {
          await login(page);
          const r = await checkInicio(page);
          results[estado][vp.name] = r;
        } catch (err) {
          results[estado][vp.name] = { error: err.message };
          failed++;
        } finally {
          await ctx.close();
        }
      }
    } catch (err) {
      results[estado] = { error: err.message };
      failed++;
    } finally {
      srv.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 600));
    }
  }

  await browser.close();

  // ── tabla resultado ────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(80));
  console.log('RESULTADO: inicio.html — 4 estados × 2 viewports');
  console.log('─'.repeat(80));

  for (const estado of ESTADOS) {
    const r = results[estado];
    if (r.error) { console.log(`\n[${estado}] ERROR: ${r.error}`); failed++; continue; }
    console.log(`\n[${estado}]`);
    for (const vp of VIEWPORTS) {
      const d = r[vp.name];
      if (!d || d.error) { console.log(`  ${vp.name}px: ERROR ${d?.error || '?'}`); failed++; continue; }
      const wa     = d.waOk ? '✓ WA conectado' : d.waErr ? '✗ WA desconectado' : '? WA ?';
      const banner = d.bannerVis ? `⚠ banner="${d.bannerText.slice(0, 60)}"` : '— sin banner';
      const card   = d.hasCard ? '▣ tarjeta' : d.hasEmpty ? '○ vacío' : '? tarjeta?';
      console.log(`  ${vp.name}px: headline="${d.headline.slice(0, 50)}" | ${wa} | ${banner} | ${card}`);
      passed++;
    }
  }

  console.log('\n' + '─'.repeat(80));
  console.log(`${passed} OK, ${failed} FAIL`);
  console.log('─'.repeat(80) + '\n');

  process.exit(failed > 0 ? 1 : 0);
})();
