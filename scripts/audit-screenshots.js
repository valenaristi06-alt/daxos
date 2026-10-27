#!/usr/bin/env node
'use strict';
// Toma capturas para auditoría UX. Levanta servidor estático + mockea API.
// Run: node scripts/audit-screenshots.js

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { chromium } = require('playwright');

const PUBLIC = path.join(__dirname, '..', 'public');
const OUT    = path.join(__dirname, '..', 'tmp-audit-screenshots');
fs.mkdirSync(OUT, { recursive: true });

// ── Static server ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(PUBLIC, urlPath === '/' ? '/index.html' : urlPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = 19421;
const BASE = `http://localhost:${PORT}`;

// Mock data
const MOCK_USER = { id: 1, email: 'maria@ejemplo.com', business_id: 1, plan: 'arranque' };
const MOCK_BH = JSON.stringify({
  1: [['09:00','19:00']], 2: [['09:00','19:00']], 3: [['09:00','19:00']],
  4: [['09:00','19:00']], 5: [['09:00','19:00']], 6: [['09:00','13:00']],
});
const MOCK_BUSINESS = {
  id: 1, name: 'Veterinaria Los Pinos',
  business_context: 'Veterinaria en Montevideo. Atendemos perros y gatos. Consultas, cirugías, vacunación. Lunes a sábado.',
  pricing_info: 'Consulta general: $700\nVacuna antirrábica: $500\nCastración macho: $2.800\nCastración hembra: $3.500',
  sales_examples: 'Hola! ¿Con qué te podemos ayudar hoy?\n\nLa consulta queda en $700 y la damos el mismo día si hay lugar.',
  pause_keywords: 'hablar con alguien, reclamo, cancelar',
  urgent_keywords: 'sangra, emergencia, atropellado',
  owner_phone: '+598 91 234 567',
  whatsapp_number: '+598 99 123 456',
  priority: 'generar_confianza',
  message_length: 'medio',
  response_mode: 'texto',
  sin_respuesta: 'recordatorio_24h',
  response_delay: 5,
  booking_enabled: 1,
  weekly_summary_enabled: 1,
  urgent_alert_enabled: 1,
  business_hours: MOCK_BH,
  after_hours_instructions: 'Si es urgencia, llevá al animal a Clínica de Urgencias, Av. Italia 3456.',
  urgent_phone: '099 555 123',
  booking_calendar_url: null,
  website_url: null,
  whatsapp_verified: true,
  whatsapp_connected: true,
  phone_number_id: '1234567890',
  waba_id: '9876543210',
  wa_payment_confirmed: 0,
};
const MOCK_STATS = { messages_24h: 47, unique_clients_today: 12, derivations_today: 3 };
const MOCK_CHART = [
  { date: '2026-10-19', count: 32 },{ date: '2026-10-20', count: 45 },
  { date: '2026-10-21', count: 28 },{ date: '2026-10-22', count: 60 },
  { date: '2026-10-23', count: 41 },{ date: '2026-10-24', count: 18 },
  { date: '2026-10-25', count: 47 },
];
const MOCK_CONVERSATIONS = [
  { id: 101, customer_id: '+59891234567', last_message: 'Mi perro sangra de la pata, ¿qué hago?', last_msg_at: new Date(Date.now()-1800000).toISOString(), needs_human: 0, needs_attention: 0, is_excluded: 0, label: null, tags: [] },
  { id: 102, customer_id: '+59899876543', last_message: '¿Cuánto sale la castración de un macho?', last_msg_at: new Date(Date.now()-5400000).toISOString(), needs_human: 0, needs_attention: 0, is_excluded: 0, label: 'prospecto', tags: [] },
  { id: 103, customer_id: '+59898111222', last_message: 'Quiero hablar con una persona del equipo', last_msg_at: new Date(Date.now()-10800000).toISOString(), needs_human: 1, needs_attention: 1, is_excluded: 0, label: null, tags: [] },
  { id: 104, customer_id: '+59891777888', last_message: '¿Tienen vacunas antirrábicas disponibles esta semana?', last_msg_at: new Date(Date.now()-86400000).toISOString(), needs_human: 0, needs_attention: 0, is_excluded: 1, label: 'cliente', tags: [] },
  { id: 105, customer_id: '+59893002003', last_message: 'Buenas! ¿Atienden el sábado?', last_msg_at: new Date(Date.now()-90000000).toISOString(), needs_human: 0, needs_attention: 0, is_excluded: 0, label: null, tags: [] },
];
const MOCK_MESSAGES = [
  { id: 1, role: 'user',      content: 'Mi perro sangra de la pata, ¿qué hago?', created_at: new Date(Date.now()-900000).toISOString() },
  { id: 2, role: 'assistant', content: 'Primero presioná la zona con una tela limpia. Si no para de sangrar o es herida profunda, llevalo de inmediato. ¿Qué tan profunda parece?', created_at: new Date(Date.now()-850000).toISOString() },
  { id: 3, role: 'user',      content: 'Bastante profunda creo, necesito hablar con alguien', created_at: new Date(Date.now()-800000).toISOString() },
  { id: 4, role: 'assistant', content: 'Entendido, paso la conversación con el equipo.', created_at: new Date(Date.now()-750000).toISOString() },
];

async function setupMockRoutes(page, { mockBusiness = MOCK_BUSINESS } = {}) {
  // Inject mock fetch at JS level — more reliable than Playwright route globs
  await page.addInitScript(({ user, business, stats, chart, conversations, messages }) => {
    const origFetch = window.fetch.bind(window);
    window.fetch = function(url, opts) {
      const u = typeof url === 'string' ? url : url.url || '';
      const path = u.replace(/^https?:\/\/[^/]+/, '');
      if (path === '/auth/me')                      return Promise.resolve(new Response(JSON.stringify(user),    { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/api/business' && (!opts || opts.method === undefined || opts.method === 'GET'))
                                                    return Promise.resolve(new Response(JSON.stringify(business), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/api/stats/today')              return Promise.resolve(new Response(JSON.stringify(stats),   { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/api/stats/messages-daily')     return Promise.resolve(new Response(JSON.stringify(chart),   { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (/^\/api\/conversations\/\d+\/messages/.test(path)) return Promise.resolve(new Response(JSON.stringify(messages), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (/^\/api\/conversations\/\d+$/.test(path)) return Promise.resolve(new Response(JSON.stringify(conversations[0]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/api/conversations')            return Promise.resolve(new Response(JSON.stringify(conversations), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/api/images')                   return Promise.resolve(new Response('[]',             { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/api/documents')                return Promise.resolve(new Response('[]',             { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/api/excluded')                 return Promise.resolve(new Response(JSON.stringify(['+59899111222','+59898333444']), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path.startsWith('/api/'))                 return Promise.resolve(new Response('{}',             { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return origFetch(url, opts);
    };
    // Also pre-set localStorage for "prueba done" so checklist shows tick
    localStorage.setItem('daxos_preview_done_1', '1');
  }, {
    user: MOCK_USER,
    business: mockBusiness,
    stats: { messages24h: 47, uniqueClientsToday: 12, pausedToday: 3, resolvedToday: 8 },
    chart: MOCK_CHART.map(d => ({ day: d.date, count: d.count })),
    conversations: MOCK_CONVERSATIONS,
    messages: MOCK_MESSAGES,
  });
}

async function shot(page, name, { fullPage = false } = {}) {
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage });
  console.log('  →', p);
}

async function run() {
  await new Promise(r => server.listen(PORT, r));

  const browser = await chromium.launch({ headless: true });

  const VIEWPORTS = [
    { w: 390,  label: 'mobile' },
    { w: 1440, label: 'desktop' },
  ];

  for (const { w, label } of VIEWPORTS) {
    console.log(`\n=== ${label} (${w}px) ===`);
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });

    // ── 1. INICIO (trial activo) ───────────────────────────────────────
    console.log('Inicio (trial activo)...');
    {
      const p = await ctx.newPage();
      await setupMockRoutes(p);
      await p.goto(`${BASE}/inicio.html`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1500);
      await shot(p, `01-inicio-${label}`);
      await p.close();
    }

    // ── 1b. INICIO (trial vencido) ─────────────────────────────────────
    if (label === 'desktop') {
      console.log('Inicio (trial vencido)...');
      const expiredBiz = {
        ...MOCK_BUSINESS,
        plan: 'arranque',
        plan_paid_at: null,
        trial_starts_at: '2026-10-01T00:00:00Z',
        trial_ends_at:   '2026-10-15T00:00:00Z',
        trial_grace_started_at: null,
        trial_conv_count: 0,
        trial_conv_limit: 150,
      };
      const p = await ctx.newPage();
      await setupMockRoutes(p, { mockBusiness: expiredBiz });
      await p.goto(`${BASE}/inicio.html`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1500);
      await shot(p, `01-inicio-trial-vencido-desktop`);
      await p.close();
    }

    // ── 2. CONFIGURACIÓN ────────────────────────────────────────────────
    console.log('Configuración...');
    {
      const p = await ctx.newPage();
      await setupMockRoutes(p);
      await p.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1500);

      // Top: Tu negocio (full page first, then viewport shots per section)
      await shot(p, `02a-config-negocio-${label}`, { fullPage: true });

      // Scroll to Cómo habla
      await p.evaluate(() => {
        const all = [...document.querySelectorAll('*')];
        const el = all.find(e => /cómo habla/i.test(e.textContent) && e.children.length <= 2);
        if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
      await p.waitForTimeout(300);
      await shot(p, `02b-config-habla-${label}`);

      // Scroll to Cómo actúa
      await p.evaluate(() => {
        const all = [...document.querySelectorAll('*')];
        const el = all.find(e => /cómo actúa/i.test(e.textContent) && e.children.length <= 2);
        if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
      await p.waitForTimeout(300);
      await shot(p, `02c-config-actua-${label}`);

      // Scroll to Horario
      await p.evaluate(() => {
        const el = document.getElementById('bh-days');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      await p.waitForTimeout(300);
      await shot(p, `02d-config-horario-${label}`);

      // Scroll to Contactos excluidos / bottom
      await p.evaluate(() => {
        const all = [...document.querySelectorAll('*')];
        const el = all.find(e => /contactos excluidos/i.test(e.textContent) && e.children.length <= 3);
        if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
        else window.scrollTo(0, document.body.scrollHeight);
      });
      await p.waitForTimeout(300);
      await shot(p, `02e-config-excluidos-${label}`);

      await p.close();
    }

    // ── 3. CONVERSACIONES ──────────────────────────────────────────────
    console.log('Conversaciones...');
    {
      const p = await ctx.newPage();
      await setupMockRoutes(p);
      await p.goto(`${BASE}/conversations.html`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1500);
      await shot(p, `03-conversaciones-${label}`);
      await p.close();
    }

    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\nCapturas guardadas en: ${OUT}`);
  fs.readdirSync(OUT).sort().forEach(f => console.log(' ', f));
}

run().catch(err => { console.error(err); server.close(); process.exit(1); });
