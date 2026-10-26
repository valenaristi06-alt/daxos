#!/usr/bin/env node
'use strict';
// Test HORARIO Y SALUDO — lee clave de .env.local, modelo de producción.
// Run: node scripts/test-horario.js

const path = require('path');
const fs   = require('fs');

// Carga .env.local sin dejar la clave en el historial de shell
try {
  const envPath = path.join(__dirname, '../.env.local');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch (_) {}

// Stub db para que claude.js cargue sin DB real
const dbStub = { getRuntimeConfig: () => null, logClaudeUsage: () => 0, logError: () => {} };
require.cache[require.resolve('../src/db')] = {
  id: require.resolve('../src/db'), filename: require.resolve('../src/db'),
  loaded: true, exports: dbStub,
};

const { buildSystemPrompt } = require('../src/claude');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6'; // mismo modelo que producción

function mockNow(hour, min = 0) {
  const d = new Date();
  d.setUTCHours(hour, min, 0, 0);
  return d;
}

const mockBusiness = {
  id: 0, name: 'Tienda Demo',
  business_context: 'Venta de ropa y accesorios en Montevideo.',
  pricing_info: null, website_summary: null,
  sales_examples: [], style_profile: null,
  survey_answers: {}, document_name: null,
};

async function callBot(client, hour, messages) {
  const runtimeCtx = { now: mockNow(hour), needsHuman: false, images: [], documents: [] };
  const { staticText, dynamicText } = buildSystemPrompt(mockBusiness, null, null, runtimeCtx);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 150,
    system: [
      { type: 'text', text: staticText },
      { type: 'text', text: dynamicText },
    ],
    messages,
  });
  return { reply: resp.content[0].text.trim(), timeLine: dynamicText.split('\n')[0] };
}

(async () => {
  // ── 1. Regla exacta ────────────────────────────────────────────────────────
  const { staticText: sampleStatic } = buildSystemPrompt(mockBusiness, null, null,
    { now: mockNow(12), needsHuman: false, images: [], documents: [] });
  const horarioRule = sampleStatic.match(/\nHORARIO Y SALUDO:.*$/s)?.[0]?.trim() || '';
  console.log('═══ REGLA HORARIO Y SALUDO (texto exacto en staticLines) ═══');
  console.log(horarioRule);
  console.log();

  // ── 2. Líneas de tiempo para los 4 horarios ───────────────────────────────
  console.log('═══ LÍNEAS DE TIEMPO GENERADAS ═══');
  for (const [h, label] of [[9,'09:00'],[15,'15:00'],[21,'21:00'],[2,'02:00']]) {
    const ctx = { now: mockNow(h), needsHuman: false, images: [], documents: [] };
    const { dynamicText } = buildSystemPrompt(mockBusiness, null, null, ctx);
    console.log(`${label}: ${dynamicText.split('\n')[0]}`);
  }
  console.log();

  // ── API calls ──────────────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.log('[Sin clave — saltando llamadas a API]'); return; }
  const client = new Anthropic({ apiKey });

  // ── 3. "Hola" a los 4 horarios ────────────────────────────────────────────
  console.log('═══ RESPUESTAS A "Hola" EN 4 HORARIOS ═══');
  for (const [h, label, expected] of [
    [9,  '09:00 mañana',    '"buen día"'],
    [15, '15:00 tarde',     '"buenas tardes"'],
    [21, '21:00 noche',     '"buenas noches"'],
    [2,  '02:00 madrugada', '"buenas noches"'],
  ]) {
    const { reply, timeLine } = await callBot(client, h, [
      { role: 'user', content: 'Hola' },
    ]);
    console.log(`\n── ${label} (esperado: ${expected}) ──`);
    console.log(`[tiempo] ${timeLine}`);
    console.log(`[bot]    ${reply}`);
  }

  // ── 4a. Conversación en curso — no debe repetir saludo ────────────────────
  console.log('\n\n═══ CASO (a): conversación en curso — bot NO debe repetir saludo ═══');
  {
    const { reply, timeLine } = await callBot(client, 9, [
      { role: 'user',      content: 'Hola' },
      { role: 'assistant', content: 'Buen día. ¿En qué te puedo ayudar?' },
      { role: 'user',      content: '¿Qué ropa tienen disponible?' },
    ]);
    console.log(`[tiempo] ${timeLine}`);
    console.log(`[bot]    ${reply}`);
  }

  // ── 4b. 8 horas después en la misma conv — cliente vuelve a saludar ───────
  console.log('\n═══ CASO (b): 8 horas después, cliente vuelve a saludar ═══');
  {
    // Historia de la mañana; ahora son las 21:00 (8h después)
    const { reply, timeLine } = await callBot(client, 21, [
      { role: 'user',      content: 'Hola, buenos días' },
      { role: 'assistant', content: 'Buen día. Tenemos remeras, pantalones y accesorios.' },
      { role: 'user',      content: 'Gracias, ya veo' },
      { role: 'assistant', content: 'Cualquier consulta me avisás.' },
      { role: 'user',      content: 'Hola, volví con otra consulta' },
    ]);
    console.log(`[tiempo] ${timeLine} (8h después de la primera interacción)`);
    console.log(`[bot]    ${reply}`);
  }

  // ── Costo tokens ──────────────────────────────────────────────────────────
  const approxTokens = Math.round(horarioRule.length / 4);
  console.log('\n═══ COSTO BLOQUE HORARIO Y SALUDO ═══');
  console.log(`~${approxTokens} tokens (${horarioRule.length} chars / 4)`);
  console.log(`Cache write: $${(approxTokens * 3.75 / 1_000_000).toFixed(7)}/vez`);
  console.log(`Cache read:  $${(approxTokens * 0.30 / 1_000_000).toFixed(7)}/msg`);
})().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
