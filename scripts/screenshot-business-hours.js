#!/usr/bin/env node
'use strict';
// Takes a screenshot of the business hours section of dashboard.html
// rendered standalone (no server needed — uses file:// with injected mock data).
// Usage: node scripts/screenshot-business-hours.js

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const OUT = path.join(__dirname, '..', 'tmp-bh-screenshot.png');
const HTML = path.join(__dirname, '..', 'public', 'dashboard.html');

// We build a minimal self-contained HTML that includes only the business-hours
// section and its CSS/JS, with mock data pre-loaded.
const MOCK_BH = JSON.stringify({
  1: [['09:00','19:00']],
  2: [['09:00','13:00'],['16:00','20:00']], // 2 tramos
  3: [['09:00','19:00']],
  4: [['09:00','19:00']],
  5: [['09:00','19:00']],
  // 6 = Sábado OFF
  // 0 = Domingo OFF
});

const MOCK_AFTER = 'Si es una urgencia, llamá al 099 000 000. Si no, te respondemos cuando abramos.';
const MOCK_PHONE = '099 000 000';

const fullHtml = fs.readFileSync(HTML, 'utf8');

// Extract the business-hours CSS block
const bhCssMatch = fullHtml.match(/\/\* ── Business hours ── \*\/([\s\S]*?)@media \(max-width: 420px\)[^}]*\}[^}]*\}/);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 900 });

  // Build standalone page
  const standalone = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  :root {
    --text: #e5e7eb;
    --muted: #9ca3af;
    --muted-2: #6b7280;
    --surface: #1f2937;
    --surface-2: #374151;
    --border: #374151;
    --border-2: #4b5563;
    --accent: #f97316;
    --accent-dim: rgba(249,115,22,0.15);
    --sans: system-ui, sans-serif;
    --mono: 'SFMono-Regular', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111827; color: var(--text); font-family: var(--sans); padding: 24px 16px; }
  .field-label { display:block; font-size:11px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted-2); margin-bottom:8px; }
  .field-hint { display:block; font-size:11px; color:var(--muted); margin-bottom:8px; font-style:italic; }
  .tag-optional { font-size:9px; font-weight:500; background:#374151; color:#9ca3af; padding:2px 6px; border-radius:3px; text-transform:uppercase; letter-spacing:0.06em; margin-left:6px; vertical-align:middle; }
  .subsection { margin-bottom:20px; margin-top:32px; }
  input[type="text"], input[type="tel"], textarea {
    width:100%; padding:11px 14px; background:var(--surface); border:1px solid var(--border-2);
    border-radius:4px; color:var(--text); font-family:var(--sans); font-size:14px; outline:none;
  }
  textarea { resize:vertical; min-height:64px; line-height:1.6; font-family:var(--mono); font-size:13px; }
  /* Business hours */
  #bh-days { margin-top: 10px; }
  .bh-row { display:flex; align-items:flex-start; gap:12px; padding:8px 0; border-bottom:1px solid var(--border); }
  .bh-row:last-child { border-bottom:none; }
  .bh-day-label { display:flex; align-items:center; gap:8px; min-width:106px; cursor:pointer; }
  .bh-day-label input[type="checkbox"] { display:none; }
  .bh-day-sw { width:36px; height:20px; background:var(--border-2); border-radius:20px; position:relative; flex-shrink:0; }
  .bh-day-sw::after { content:''; position:absolute; width:14px; height:14px; border-radius:50%; background:#fff; top:3px; left:3px; }
  .bh-day-label input:checked + .bh-day-sw { background:var(--accent); }
  .bh-day-label input:checked + .bh-day-sw::after { left:19px; }
  .bh-day-name { font-size:13px; color:var(--text); }
  .bh-slots { flex:1; display:flex; flex-direction:column; gap:6px; }
  .bh-slot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  input[type="time"].bh-t { width:106px; padding:5px 8px; font-size:13px; background:var(--surface); border:1px solid var(--border-2); border-radius:4px; color:var(--text); }
  .bh-sep { font-size:13px; color:var(--muted); }
  .bh-add-btn, .bh-rm-btn { font-size:11px; padding:3px 8px; background:transparent; border:1px solid var(--border-2); border-radius:4px; color:var(--muted); cursor:pointer; }
  @media (max-width:420px) { .bh-row { flex-direction:column; gap:6px; } .bh-day-label { min-width:unset; } }
</style>
</head>
<body>
<div class="subsection">
  <label class="field-label">Horario de atención <span class="tag-optional">Opcional</span></label>
  <span class="field-hint">El bot avisará si está abierto o cerrado cuando el cliente escriba. Dejalo vacío si atendés siempre.</span>
  <div id="bh-days"></div>
</div>
<div class="subsection">
  <label class="field-label" for="after_hours_instructions">Qué hacer cuando estamos cerrados <span class="tag-optional">Opcional</span></label>
  <span class="field-hint">El bot usa este texto cuando el cliente escribe fuera del horario configurado.</span>
  <textarea id="after_hours_instructions" rows="2">${MOCK_AFTER}</textarea>
</div>
<div class="subsection">
  <label class="field-label" for="urgent_phone">Teléfono de urgencias fuera de horario <span class="tag-optional">Opcional</span></label>
  <span class="field-hint">Si el cliente tiene una urgencia fuera de horario, el bot indica este número.</span>
  <input id="urgent_phone" type="tel" value="${MOCK_PHONE}" />
</div>
<script>
const BH_DAYS = [
  { day: 1, label: 'Lunes' },
  { day: 2, label: 'Martes' },
  { day: 3, label: 'Miércoles' },
  { day: 4, label: 'Jueves' },
  { day: 5, label: 'Viernes' },
  { day: 6, label: 'Sábado' },
  { day: 0, label: 'Domingo' },
];
function buildBhRow({ day, label }) {
  const row = document.createElement('div');
  row.className = 'bh-row';
  row.dataset.day = day;
  row.innerHTML = \`
    <label class="bh-day-label">
      <input type="checkbox" class="bh-day-check" />
      <span class="bh-day-sw"></span>
      <span class="bh-day-name">\${label}</span>
    </label>
    <div class="bh-slots" style="display:none">
      <div class="bh-slot bh-slot1">
        <input type="time" class="bh-t bh-t-start" value="09:00" />
        <span class="bh-sep">–</span>
        <input type="time" class="bh-t bh-t-end" value="18:00" />
        <button type="button" class="bh-add-btn">+ tramo</button>
      </div>
      <div class="bh-slot bh-slot2" style="display:none">
        <input type="time" class="bh-t bh-t-start2" value="16:00" />
        <span class="bh-sep">–</span>
        <input type="time" class="bh-t bh-t-end2" value="20:00" />
        <button type="button" class="bh-rm-btn">✕</button>
      </div>
    </div>
  \`;
  const check = row.querySelector('.bh-day-check');
  const slots = row.querySelector('.bh-slots');
  const slot2 = row.querySelector('.bh-slot2');
  const addBtn = row.querySelector('.bh-add-btn');
  const rmBtn = row.querySelector('.bh-rm-btn');
  check.addEventListener('change', () => {
    slots.style.display = check.checked ? 'flex' : 'none';
    if (check.checked) slots.style.flexDirection = 'column';
  });
  addBtn.addEventListener('click', () => { slot2.style.display = 'flex'; addBtn.style.display = 'none'; });
  rmBtn.addEventListener('click', () => { slot2.style.display = 'none'; addBtn.style.display = ''; });
  return row;
}
const bhContainer = document.getElementById('bh-days');
BH_DAYS.forEach(d => bhContainer.appendChild(buildBhRow(d)));

// Load mock data
const bh = ${JSON.stringify(MOCK_BH)};
const bhParsed = JSON.parse(bh);
BH_DAYS.forEach(({ day }) => {
  const row = bhContainer.querySelector('[data-day="' + day + '"]');
  const check = row.querySelector('.bh-day-check');
  const slots = row.querySelector('.bh-slots');
  const slot2 = row.querySelector('.bh-slot2');
  const addBtn = row.querySelector('.bh-add-btn');
  const s1 = row.querySelector('.bh-t-start');
  const e1 = row.querySelector('.bh-t-end');
  const s2 = row.querySelector('.bh-t-start2');
  const e2 = row.querySelector('.bh-t-end2');
  const daySlots = bhParsed[day];
  if (daySlots && daySlots.length > 0) {
    check.checked = true;
    slots.style.display = 'flex';
    slots.style.flexDirection = 'column';
    s1.value = daySlots[0][0];
    e1.value = daySlots[0][1];
    if (daySlots.length > 1) {
      slot2.style.display = 'flex';
      addBtn.style.display = 'none';
      s2.value = daySlots[1][0];
      e2.value = daySlots[1][1];
    }
  }
});
</script>
</body>
</html>`;

  await page.setContent(standalone, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  // Screenshot full page
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  console.log('Screenshot saved:', OUT);
})();
