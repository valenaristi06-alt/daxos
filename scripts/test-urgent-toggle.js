#!/usr/bin/env node
'use strict';
// Verifica que el interruptor de urgencia cambia texto y que el valor se recoge correctamente.
// Run: node scripts/test-urgent-toggle.js

const { chromium } = require('playwright');

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<style>
  :root {
    --text: #e5e7eb; --muted: #9ca3af; --muted-2: #6b7280;
    --surface: #1f2937; --border-2: #4b5563; --accent: #f97316;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111827; color: var(--text); font-family: system-ui, sans-serif; padding: 24px; }
  .bh-day-label { display:flex; align-items:center; gap:8px; cursor:pointer; }
  .bh-day-label input[type="checkbox"] { display:none; }
  .bh-day-sw {
    width:36px; height:20px; background:var(--border-2);
    border-radius:20px; position:relative; flex-shrink:0; transition:background 0.15s;
  }
  .bh-day-sw::after {
    content:''; position:absolute; width:14px; height:14px; border-radius:50%;
    background:#fff; top:3px; left:3px; transition:left 0.15s;
  }
  .bh-day-label input:checked + .bh-day-sw { background:var(--accent); }
  .bh-day-label input:checked + .bh-day-sw::after { left:19px; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;gap:10px">
  <label class="bh-day-label" style="min-width:unset;margin:0">
    <input type="checkbox" id="urgent_alert_enabled" />
    <span class="bh-day-sw"></span>
  </label>
  <span id="urgent-alert-label" style="font-size:13px;color:var(--muted)">Apagado</span>
</div>
<script>
  document.getElementById('urgent_alert_enabled').addEventListener('change', function () {
    document.getElementById('urgent-alert-label').textContent = this.checked ? 'Activado' : 'Apagado';
  });
</script>
</body>
</html>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 200 });
  await page.setContent(HTML, { waitUntil: 'load' });

  let passed = 0, failed = 0;
  async function assert(desc, fn) {
    const result = await fn();
    if (result === true) { console.log(`  ✓ ${desc}`); passed++; }
    else { console.error(`  ✗ ${desc}: ${result}`); failed++; }
  }

  // Estado inicial
  console.log('\n── Estado inicial ──');
  await assert('label = "Apagado"',          async () => await page.textContent('#urgent-alert-label') === 'Apagado' || `"${await page.textContent('#urgent-alert-label')}"`);
  await assert('checkbox no chequeado',       async () => !await page.isChecked('#urgent_alert_enabled') || 'estaba chequeado');

  // Clic en el interruptor → Activado
  console.log('\n── Clic 1: activar ──');
  await page.click('label.bh-day-label');
  await page.waitForTimeout(100);
  await assert('label = "Activado"',         async () => await page.textContent('#urgent-alert-label') === 'Activado' || `"${await page.textContent('#urgent-alert-label')}"`);
  await assert('checkbox chequeado',          async () => await page.isChecked('#urgent_alert_enabled') || 'no chequeado');
  await assert('valor para payload = 1',      async () => { const v = await page.evaluate(() => document.getElementById('urgent_alert_enabled').checked ? 1 : 0); return v === 1 || `valor=${v}`; });

  // Clic de vuelta → Apagado
  console.log('\n── Clic 2: desactivar ──');
  await page.click('label.bh-day-label');
  await page.waitForTimeout(100);
  await assert('label = "Apagado"',          async () => await page.textContent('#urgent-alert-label') === 'Apagado' || `"${await page.textContent('#urgent-alert-label')}"`);
  await assert('checkbox no chequeado',       async () => !await page.isChecked('#urgent_alert_enabled') || 'estaba chequeado');
  await assert('valor para payload = 0',      async () => { const v = await page.evaluate(() => document.getElementById('urgent_alert_enabled').checked ? 1 : 0); return v === 0 || `valor=${v}`; });

  // Carga inicial con b.urgent_alert_enabled = 1 (simula loadBusiness)
  console.log('\n── Carga desde negocio (urgent_alert_enabled=1) ──');
  await page.evaluate(() => {
    const el = document.getElementById('urgent_alert_enabled');
    const on = true;
    el.checked = on;
    document.getElementById('urgent-alert-label').textContent = on ? 'Activado' : 'Apagado';
  });
  await assert('label cargado = "Activado"', async () => await page.textContent('#urgent-alert-label') === 'Activado' || `"${await page.textContent('#urgent-alert-label')}"`);
  await assert('checkbox cargado chequeado', async () => await page.isChecked('#urgent_alert_enabled') || 'no chequeado');

  await browser.close();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
