#!/usr/bin/env node
'use strict';
// Tests del motor de lectura (Fase 1). Modelo SIMULADO (inyectado), nunca web en vivo.
// Fixture: scripts/fixtures/artesanias-myv.html.
// Condiciones: con la web de Artesanías llena ≥70% de los campos objetivo SIN inventar
// ningún precio; y un dato ausente queda vacío (no inventado).

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_DIR = '/tmp/test-reader-db';
execSync(`rm -rf ${DB_DIR}`); fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;

const reader = require('../src/reader');
const db     = require('../src/db');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'artesanias-myv.html'), 'utf8');
const fixtureText = fixtureHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Campos objetivo que el motor puede llenar desde la web/texto (denominador del %).
const TARGET_FIELDS = ['name', 'business_context', 'website_url', 'pricing_info', 'business_hours', 'urgent_phone', 'style_profile.tono'];
function coverage(rows) {
  const have = new Set(rows.map(r => r.field));
  const filled = TARGET_FIELDS.filter(f => have.has(f));
  return { pct: Math.round((filled.length / TARGET_FIELDS.length) * 100), filled };
}

// Extractor simulado: lo que el modelo "devolvería" leyendo la fixture de Artesanías.
// Los precios SON los de la fixture (no inventados). Sin teléfono (como pasa seguido en IG/web).
const mockArtesanias = async () => ({
  nombre: 'Artesanías MYV',
  rubro: 'muebles artesanales',
  descripcion: 'Muebles de jardín y decoración en madera, hechos a mano. Trabajan por encargo y envían a todo el país.',
  servicios: ['Hamaca con techo — $4.500', 'Banco de jardín de madera — $2.800', 'Buda decorativo tallado — $900', 'Set de maceteros (x3) — $1.200'],
  preguntas_frecuentes: [],
  promos: ['Promo del mes: 10% off en bancos de jardín.'],
  sedes: [{ nombre: null, direccion: 'Salto, Uruguay', horario: 'Lunes a sábado de 9 a 18 hs', telefono: null }],
  ubicacion: 'Salto, Uruguay',
  tono: 'informal',
  publico: 'Personas que buscan muebles y decoración de jardín.',
});

(async () => {
  // ── (a) Cobertura ≥70% con la web de Artesanías, sin inventar precios ──
  console.log('Suite (a): cobertura con la web de Artesanías');
  const rows = await reader.buildDraft(
    { url: 'https://artesaniasmyv.uy', text: fixtureText },
    { extract: mockArtesanias, fetch: async (u) => ({ url: u, text: fixtureText }) }
  );
  const cov = coverage(rows);
  console.log(`     campos llenados: ${cov.filled.join(', ')} → ${cov.pct}%`);
  assert(cov.pct >= 70, `llena ≥70% de los campos objetivo (${cov.pct}%)`);

  const pricing = rows.find(r => r.field === 'pricing_info');
  assert(!!pricing, 'pricing_info presente (hay precios en la web)');
  assert(pricing && pricing.needs_confirm === 1, 'pricing_info queda "a confirmar" (needs_confirm=1)');
  // Ningún precio inventado: cada precio del borrador aparece textual en la fixture.
  const priceTokens = (pricing?.value.match(/\$[\d.]+/g) || []);
  const allReal = priceTokens.length > 0 && priceTokens.every(p => fixtureText.includes(p));
  assert(allReal, `ningún precio inventado (${priceTokens.join(', ')} están en la web)`);
  assert(rows.find(r => r.field === 'website_url'), 'website_url tomado de lo que pegó el dueño');
  assert(rows.every(r => r.source && r.confidence != null), 'cada campo lleva origen y confianza');

  // ── (b) Un dato que no está queda vacío (no inventado) ──
  console.log('Suite (b): dato ausente → vacío');
  const mockSinDatos = async () => ({
    nombre: null, descripcion: null, servicios: [], promos: [],
    sedes: [{ nombre: null, direccion: null, horario: null, telefono: null }],
    tono: 'neutro', publico: null,
  });
  const rows2 = await reader.buildDraft({ text: 'hola' }, { extract: mockSinDatos });
  assert(!rows2.find(r => r.field === 'name'), 'sin nombre → no se emite name');
  assert(!rows2.find(r => r.field === 'business_hours'), 'sin horario → no se emite business_hours');
  assert(!rows2.find(r => r.field === 'pricing_info'), 'sin precios → no se inventa pricing_info');
  assert(!rows2.find(r => r.field === 'urgent_phone'), 'sin teléfono → no se emite urgent_phone');

  // ── (c) Validación de claves survey_answers / style_profile ──
  console.log('Suite (c): validación de claves');
  const okTono = reader.mapToDraft({ tono: 'informal' }, 'web').find(r => r.field === 'style_profile.tono');
  assert(okTono && okTono.value === 'cercano', 'tono informal → style_profile.tono=cercano (clave válida)');
  const badTono = reader.mapToDraft({ tono: 'xyz' }, 'web').find(r => r.field === 'style_profile.tono');
  assert(!badTono, 'tono fuera de la lista → no se emite (no se inventa)');

  // ── (d) Persistencia en tabla aparte (no toca businesses) ──
  console.log('Suite (d): borrador en config_drafts');
  const biz = db.upsertBusiness({ name: 'Artesanías MYV (test)' });
  const bizId = biz.id;
  db.saveConfigDraft(bizId, rows);
  const saved = db.getConfigDraft(bizId);
  assert(saved.length === rows.length, `borrador guardado (${saved.length} filas)`);
  assert(saved.every(r => r.status === 'pending'), 'filas quedan en estado pending');
  // No tocó la config real del negocio.
  assert(db.getBusinessById(bizId).business_context == null, 'la config real del negocio NO cambió (business_context sigue vacío)');
  db.saveConfigDraft(bizId, [{ field: 'name', value: 'X', source: 'web', confidence: 1 }]);
  assert(db.getConfigDraft(bizId).length === 1, 'guardar de nuevo reemplaza el borrador pending');
  db.clearConfigDraft(bizId);
  assert(db.getConfigDraft(bizId).length === 0, 'clearConfigDraft limpia el borrador');

  // ── (e) El demo-generator reusa el mismo extractBusinessData del reader ──
  console.log('Suite (e): demo-generator usa el reader');
  const demo = require('../src/demo-generator');
  assert(typeof demo.extractBusinessData === 'function', 'demo-generator exporta extractBusinessData');
  assert(demo.extractBusinessData === reader.extractBusinessData, 'es la MISMA función del reader (demo sigue igual)');

  console.log(`\n── Resultados ── passed=${passed} failed=${failed}`);
  db.closeDb && db.closeDb();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
