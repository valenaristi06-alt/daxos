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

  // ── (f) Esquema ampliado + reglas de mapeo ──
  console.log('Suite (f): esquema ampliado y reglas');
  const full = {
    nombre: 'Tienda X', descripcion: 'Vende cosas', publico: null,
    productos_precios: ['Silla — $100', 'Mesa — $250'],
    servicios: ['Silla', 'Mesa'],
    promos: ['Promo: $999 de regalo solo hoy'],
    preguntas_frecuentes: ['¿Hacen envíos?: sí', 'Política de cambios: 30 días'],
    horarios: 'Lun a Vie 9 a 18', telefono: '099111222', whatsapp: null,
    es_urgencias: false,
    envios: 'a todo el país', medios_pago: 'tarjeta y efectivo', cambios_devoluciones: 'hasta 30 días',
    diferencial: 'hechos a mano en Uruguay', tono: 'formal',
  };
  const rf = reader.mapToDraft(full, 'web');
  const get = (f) => rf.find((r) => r.field === f);
  assert(get('owner_rules') && /Env[íi]os/.test(get('owner_rules').value) && /Medios de pago/.test(get('owner_rules').value), 'owner_rules junta envíos + pagos + cambios');
  assert(!!get('reference_docs'), 'reference_docs toma las preguntas frecuentes/políticas');
  assert(get('survey_answers.objeciones_precio')?.value === 'hechos a mano en Uruguay', 'objeciones_precio = diferencial');
  assert(!!get('after_hours_instructions'), 'after_hours_instructions se redacta con el horario');
  const pr = get('pricing_info');
  assert(pr && pr.value.includes('$100') && pr.value.includes('$250'), 'pricing_info toma productos_precios literales');
  assert(pr && !pr.value.includes('$999'), 'las promos NO entran como precio');
  assert(!get('urgent_phone'), 'teléfono común NO es urgencias (es_urgencias=false)');
  const rfU = reader.mapToDraft({ ...full, es_urgencias: true }, 'web');
  assert(rfU.find((r) => r.field === 'urgent_phone')?.value === '099111222', 'con es_urgencias=true sí hay teléfono de urgencias');

  // ── (h) Crawling: portada + subpáginas relevantes del mismo dominio ──
  console.log('Suite (h): crawling de subpáginas');
  const base = 'https://artesaniasmyv.uy/';
  const homeHtml = `
    <a href="/envios/">Envíos</a>
    <a href="/contacto/">Contacto</a>
    <a href="https://facebook.com/x">Externo</a>
    <a href="mailto:a@b.com">Mail</a>
    <a href="/preguntas-frecuentes/">Preguntas frecuentes</a>
    <a href="/blog/">Novedades</a>`;
  const links = reader.extractLinks(homeHtml, base);
  assert(links.length === 3, 'toma solo los 3 links relevantes del mismo dominio');
  assert(links.some(l => /envios/.test(l)) && links.some(l => /contacto/.test(l)) && links.some(l => /preguntas/.test(l)), 'incluye envíos, contacto y FAQ');
  assert(!links.some(l => /facebook\.com/.test(l)), 'excluye dominios externos');
  assert(!links.some(l => /blog/.test(l)), 'excluye links sin palabra clave');

  const RAW = {
    [base]: homeHtml + '<p>Artesanías MYV, muebles de madera.</p>',
    'https://artesaniasmyv.uy/envios/': '<p>Hacemos envíos a todo el país, costo según zona.</p>',
    'https://artesaniasmyv.uy/contacto/': '<p>Tel 099 111 222. Salto, Uruguay.</p>',
    'https://artesaniasmyv.uy/preguntas-frecuentes/': '<p>¿Aceptan tarjeta? Sí.</p>',
  };
  const pages = await reader.fetchSite(base, { fetchRaw: async (u) => ({ url: u, html: RAW[u] || '' }) });
  assert(pages.length === 4, 'fetchSite devuelve portada + 3 subpáginas');
  assert(pages[0].url === base, 'la portada va primera');
  assert(pages.some(p => /env[íi]os a todo el país/i.test(p.text)), 'el texto de /envios/ entra en el material');

  // ── (i) Precios: oferta ≠ conflicto ──
  console.log('Suite (i): oferta vs conflicto de precios');
  const conf = reader.mapToDraft({ productos: [
    { nombre: 'Buda Panzón', conflicto: true, precios_conflicto: ['$1.750', '$2.100'] },
    { nombre: 'Loto Grande', precio: '$3.250', precio_anterior: '$4.990' },
    { nombre: 'Sillón Java', precio: '$13.490' },
  ] }, 'web');
  const pconf = conf.find((r) => r.field === 'pricing_info');
  assert(pconf && /Buda Panzón — \$1\.750 \/ \$2\.100  \[precio en conflicto, confirmar\]/.test(pconf.value), '2 precios actuales distintos → conflicto, sin elegir');
  assert(pconf && /Loto Grande — \$3\.250  \[en oferta, antes \$4\.990\]/.test(pconf.value), 'oferta: guarda el precio actual con nota "antes $X" (NO conflicto)');
  assert(pconf && !/Loto Grande.*conflicto/.test(pconf.value), 'la oferta no se marca como conflicto');
  assert(pconf && /Sillón Java — \$13\.490/.test(pconf.value) && !/Sillón Java.*(conflicto|oferta)/.test(pconf.value), 'precio único → normal');
  assert(pconf && pconf.needs_confirm === 1, 'precios siempre a confirmar');

  // ── (g) Dominio estacionado / página vacía → todo vacío ──
  console.log('Suite (g): dominio estacionado → vacío');
  assert(reader.mapToDraft({}, 'web').length === 0, 'objeto vacío → 0 campos (nada inventado)');
  assert(reader.mapToDraft({ nombre: null, servicios: [], promos: [], sedes: [] }, 'web').length === 0, 'todo null/[] → 0 campos');

  // ── (j) Respuesta REAL de Artesanías (fixture) → mapeo esperado ──
  console.log('Suite (j): fixture real de Artesanías');
  const real = require('./fixtures/artesanias-real.json');
  const rr = reader.mapToDraft(real, 'web');
  const gr = (f) => rr.find((r) => r.field === f);
  assert(gr('name')?.value === 'Artesanías MYV', 'name correcto');
  const prj = gr('pricing_info');
  assert(prj && prj.needs_confirm === 1, 'pricing_info a confirmar');
  for (const n of ['Buda Panzón', 'Loto Gigante', 'Tibetano Mediano', 'Virgen Milagrosa']) {
    assert(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*\\[precio en conflicto, confirmar\\]').test(prj.value), `conflicto marcado: ${n}`);
  }
  assert(/\[en oferta, antes \$/.test(prj.value), 'al menos un producto en oferta con nota "antes $X"');
  const or = gr('owner_rules')?.value || '';
  assert(/1 a 7 d[ií]as/i.test(or), 'owner_rules: envío 1 a 7 días hábiles');
  assert(/no incluido|se calcula|aparte/i.test(or), 'owner_rules: costo de envío aparte');
  assert(/7 d[ií]as/i.test(or) && /24 ?h(oras)?/i.test(or), 'owner_rules: cambios 7 días + daño 24 horas');
  assert(/madera/i.test(or), 'owner_rules: a medida solo en madera');
  assert(!!gr('reference_docs') && !!gr('survey_answers.objeciones_precio'), 'reference_docs y objeciones_precio presentes');
  assert(!gr('business_hours') && !gr('urgent_phone'), 'horarios y urgencias vacíos (no están en la web) — correcto');

  // ── (k) Nombre genérico vacío + precios con "desde"/rangos ──
  console.log('Suite (k): nombre genérico y precios literales');
  assert(!reader.mapToDraft({ nombre: 'Veterinaria', rubro: 'Veterinaria' }).find((r) => r.field === 'name'), 'nombre = rubro → name vacío (no genérico)');
  assert(!reader.mapToDraft({ nombre: 'Inmobiliaria' }).find((r) => r.field === 'name'), 'nombre genérico (lista) → name vacío');
  assert(reader.mapToDraft({ nombre: 'Veterinaria Patitas', rubro: 'Veterinaria' }).find((r) => r.field === 'name')?.value === 'Veterinaria Patitas', 'nombre propio → se conserva');
  const pk = reader.mapToDraft({ productos: [
    { nombre: 'Vacunas', precio: 'desde $900' },
    { nombre: 'Baño', precio: '$500 a $800' },
    { nombre: 'Corte', precio: 'a partir de $700' },
  ] }).find((r) => r.field === 'pricing_info');
  assert(/Vacunas — desde \$900/.test(pk.value), 'conserva "desde"');
  assert(/Baño — \$500 a \$800/.test(pk.value), 'conserva el rango tal cual');
  assert(/Corte — a partir de \$700/.test(pk.value), 'conserva "a partir de"');

  console.log(`\n── Resultados ── passed=${passed} failed=${failed}`);
  db.closeDb && db.closeDb();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
