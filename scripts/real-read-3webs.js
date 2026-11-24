#!/usr/bin/env node
'use strict';
// Prueba del lector (Fase 1) con modelo REAL sobre 3 webs. NO imprime la clave.
// Uso normal:  ANTHROPIC_API_KEY=... node scripts/real-read-3webs.js <url1> <url2> <url3>
// Diagnóstico: ANTHROPIC_API_KEY=... node scripts/real-read-3webs.js --debug <url1> <url2> <url3>
// Requiere estar sobre un checkout que tenga src/reader.js (rama main).

let reader;
try {
  reader = require('../src/reader');
} catch (e) {
  console.error('No se pudo cargar src/reader.js. Corré desde un checkout de main.');
  console.error(e.message);
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Falta ANTHROPIC_API_KEY en el entorno.');
  process.exit(1);
}

// Campos del panel que PUEDEN salir de una web (denominador del %). Sin website_url
// (es la URL que pasa el dueño). Con los que la spec dice que salen de la web.
const WEB_FIELDS = [
  'name', 'business_context', 'pricing_info', 'business_hours', 'urgent_phone', 'style_profile.tono',
  'owner_rules', 'reference_docs', 'survey_answers.objeciones_precio', 'after_hours_instructions',
];
const NOT_MAPPED_YET = ['owner_rules', 'reference_docs', 'survey_answers.objeciones_precio', 'after_hours_instructions'];

const IN = 1 / 1e6, OUT = 5 / 1e6; // Haiku 4.5: US$1/MTok in, US$5/MTok out

let args = process.argv.slice(2);
const DEBUG = args.includes('--debug');
const urls = args.filter((a) => a !== '--debug');
if (urls.length < 1) {
  console.error('Pasá al menos 1 URL: node scripts/real-read-3webs.js [--debug] <url> [url2] [url3]');
  process.exit(1);
}

async function runNormal() {
  console.log('Denominador del %: ' + WEB_FIELDS.length + ' campos web-derivables.');
  console.log('Aún NO mapeados por buildDraft (cuentan vacíos): ' + NOT_MAPPED_YET.join(', ') + '.');
  let total = 0;
  for (const url of urls) {
    let cost = 0;
    const logCost = ({ inTokens = 0, outTokens = 0 }) => { cost += inTokens * IN + outTokens * OUT; };
    console.log('\n### ' + url);
    let rows;
    try { rows = await reader.buildDraft({ url }, { logCost }); }
    catch (e) { console.log('  NO SE PUDO LEER: ' + e.message); continue; }
    total += cost;
    for (const r of rows) {
      const v = String(r.value).replace(/\s+/g, ' ').slice(0, 90);
      console.log('  ' + r.field + ' [' + r.source + ', conf ' + r.confidence + (r.needs_confirm ? ', A CONFIRMAR' : '') + ']: ' + v);
    }
    const have = new Set(rows.map((r) => r.field));
    const filled = WEB_FIELDS.filter((f) => have.has(f));
    const empty = WEB_FIELDS.filter((f) => !have.has(f));
    console.log('  LLENÓ (' + filled.length + '/' + WEB_FIELDS.length + '): ' + (filled.join(', ') || 'ninguno'));
    console.log('  VACÍOS: ' + (empty.join(', ') || 'ninguno'));
    console.log('  % web-derivables: ' + Math.round((filled.length / WEB_FIELDS.length) * 100) + '%');
    console.log('  costo lectura: US$' + cost.toFixed(4));
  }
  console.log('\n=== costo total 3 lecturas: US$' + total.toFixed(4) + ' ===');
}

// Diagnóstico: usa el MISMO extractor del lector (tool use), pero muestra todo:
// chars de texto limpio, objeto/raw del modelo (2000 chars), vía (tool_use/texto),
// errores de parseo, y las filas que produce mapToDraft.
async function runDebug() {
  for (const url of urls) {
    console.log('\n######## ' + url);
    let pages;
    try {
      pages = await reader.fetchSite(url);
    } catch (e) {
      console.log('  FETCH FALLÓ: ' + e.message);
      continue;
    }
    console.log('  páginas leídas (portada + subpáginas): ' + pages.length);
    for (const p of pages) console.log('    - ' + p.url + ' (' + p.text.length + ' chars)');
    const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
    console.log('  texto portada[0..300]: ' + (pages[0] ? pages[0].text.slice(0, 300) : ''));
    if (!totalChars) { console.log('  (sin texto útil — SPA/JS, bloqueo de bots o dominio estacionado)'); continue; }

    let cost = 0;
    const logCost = ({ inTokens = 0, outTokens = 0 }) => { cost += inTokens * IN + outTokens * OUT; };
    let data;
    try {
      data = await reader.extractBusinessData(pages, logCost, {
        onDebug: (d) => {
          console.log('  [' + d.tool + '] vía: ' + d.via + ' | stop_reason: ' + d.stop_reason + ' | parsed: ' + d.parsed + (d.error ? (' | error: ' + d.error) : ''));
          console.log('  --- objeto/raw [' + d.tool + '] [0..2000] ---');
          console.log(d.raw);
          console.log('  --- fin ---');
        },
      });
    } catch (e) {
      console.log('  EXTRACCIÓN FALLÓ: ' + e.message);
      continue;
    }
    console.log('  claves del objeto: ' + Object.keys(data).join(', '));
    const rows = reader.mapToDraft(data, 'web');
    console.log('  mapToDraft → ' + rows.length + ' filas:');
    for (const r of rows) {
      console.log('    ' + r.field + ' [' + r.source + (r.needs_confirm ? ', a confirmar' : '') + ']: ' + String(r.value).replace(/\s+/g, ' ').slice(0, 90));
    }
    console.log('  costo lectura: US$' + cost.toFixed(4));
  }
}

(DEBUG ? runDebug() : runNormal())
  .then(() => console.log('\nListo.'))
  .catch((e) => { console.error('ERROR:', e.message, '\n', e.stack || ''); process.exit(1); });
