'use strict';

// Motor de lectura del configurador (Fase 1, sin pantalla).
// Recibe URL / texto / audio / imágenes y devuelve un BORRADOR con el esquema del
// panel: cada fila { field, value, source, confidence, needs_confirm }.
// Reglas duras:
//   - Si un dato no aparece, el campo queda vacío (no se emite). Nunca se inventa.
//   - Los precios SIEMPRE quedan marcados needs_confirm=1 ("a confirmar").
//   - Un teléfono común NO es teléfono de urgencias (solo si la web dice urgencias/24h).
//   - Promos/novedades NO son precios.
//   - Las claves de survey_answers.* y style_profile.* se validan contra listas blancas.
// El borrador no toca la configuración real de ningún negocio (eso es Fase 2 "Aplicar").

const Anthropic = require('@anthropic-ai/sdk');
const { validateUrl, MAX_RESPONSE_BYTES, TIMEOUT_MS } = require('./ssrf');
const { transcribeAudio } = require('./elevenlabs');
const { findPrices } = require('./pricecap');

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';

// Dos tools para que una lista larga de productos no le coma espacio al resto.
// INFO: todo menos los precios. El demo lee este subconjunto e ignora lo extra.
const INFO_TOOL = {
  name: 'cargar_info_negocio',
  description: 'Carga la información del negocio (SIN la lista de productos con precio). Completá TODO lo que aparezca en el texto: envíos, cambios/devoluciones, preguntas frecuentes, contacto, dirección, teléfonos, diferencial, tono. Si un dato no aparece claramente, dejalo null o []. NUNCA inventes.',
  input_schema: {
    type: 'object',
    properties: {
      nombre: { type: ['string', 'null'], description: 'nombre PROPIO del negocio (marca). Si solo aparece el rubro genérico (ej "veterinaria", "inmobiliaria"), dejá null.' },
      rubro: { type: ['string', 'null'], description: 'sector/industria en 2-4 palabras' },
      descripcion: { type: ['string', 'null'], description: 'qué hace el negocio, 1-2 oraciones' },
      servicios: { type: 'array', items: { type: 'string' }, description: 'productos o servicios (sin precio)' },
      promos: { type: 'array', items: { type: 'string' }, description: 'promociones o novedades (NO son precios)' },
      preguntas_frecuentes: { type: 'array', items: { type: 'string' }, description: '"pregunta: respuesta breve" y políticas' },
      horarios: { type: ['string', 'null'], description: 'horario de atención, texto literal' },
      telefono: { type: ['string', 'null'] },
      whatsapp: { type: ['string', 'null'] },
      es_urgencias: { type: 'boolean', description: 'true SOLO si la web menciona urgencias o atención 24 horas' },
      envios: { type: ['string', 'null'], description: 'cómo/dónde hace envíos y costos' },
      medios_pago: { type: ['string', 'null'] },
      cambios_devoluciones: { type: ['string', 'null'] },
      personalizados: { type: ['string', 'null'], description: 'productos a medida / personalizados y sus condiciones (ej: solo en madera)' },
      diferencial: { type: ['string', 'null'], description: 'qué diferencia al negocio / por qué elegirlo' },
      sedes: { type: 'array', items: { type: 'object', properties: { nombre: { type: ['string', 'null'] }, direccion: { type: ['string', 'null'] }, horario: { type: ['string', 'null'] }, telefono: { type: ['string', 'null'] } } } },
      ubicacion: { type: ['string', 'null'] },
      tono: { type: ['string', 'null'], description: 'formal | informal | neutro' },
      publico: { type: ['string', 'null'] },
    },
    required: [],
  },
};

// PRODUCTS: productos y precios. Distingue OFERTA (regular tachado + precio actual) de
// CONFLICTO (el mismo producto con dos precios ACTUALES distintos).
const PRODUCTS_TOOL = {
  name: 'cargar_productos',
  description: 'Cargá los productos con precio. "precio" = el precio ACTUAL que paga el cliente (si está en oferta, el de oferta). "precio_anterior" = el precio regular tachado SOLO si está en oferta, sino null. Marcá "conflicto"=true SOLO si el MISMO producto aparece con dos precios ACTUALES distintos (regular vs oferta NO es conflicto); en ese caso listá esos precios en "precios_conflicto". Un registro por producto. Solo con precio explícito. NUNCA inventes precios.',
  input_schema: {
    type: 'object',
    properties: {
      productos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nombre: { type: 'string' },
            precio: { type: ['string', 'null'], description: 'precio actual LITERAL. Conservá "desde", "a partir de" o rangos tal cual, ej "desde $900", "$500 a $800", "$1.750".' },
            precio_anterior: { type: ['string', 'null'], description: 'precio regular tachado si está en oferta, sino null' },
            conflicto: { type: 'boolean' },
            precios_conflicto: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: [],
  },
};

// Parseo robusto vía tool use. Captura stop_reason (para distinguir truncado por tokens).
async function _extractWithTool(messages, tool, { logCost, event, onDebug, maxTokens = 1200 } = {}) {
  const resp = await _client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: maxTokens,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages,
  });
  if (logCost) logCost({ event, inTokens: resp.usage.input_tokens, outTokens: resp.usage.output_tokens });

  const block = resp.content.find((c) => c.type === 'tool_use' && c.name === tool.name);
  if (block && block.input && typeof block.input === 'object') {
    if (onDebug) onDebug({ tool: tool.name, via: 'tool_use', stop_reason: resp.stop_reason, raw: JSON.stringify(block.input).slice(0, 2000), parsed: true });
    return block.input;
  }
  const textRaw = (resp.content.find((c) => c.type === 'text')?.text || '').trim();
  const cleaned = textRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  try {
    const data = JSON.parse(match ? match[0] : cleaned);
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('no es un objeto');
    if (onDebug) onDebug({ tool: tool.name, via: 'texto', stop_reason: resp.stop_reason, raw: textRaw.slice(0, 2000), parsed: true });
    return data;
  } catch (e) {
    if (onDebug) onDebug({ tool: tool.name, via: 'texto', stop_reason: resp.stop_reason, raw: textRaw.slice(0, 2000), parsed: false, error: e.message });
    console.error('[reader] no se pudo extraer JSON (' + tool.name + '):', e.message, '| raw[0..200]:', textRaw.slice(0, 200));
    return {};
  }
}

// Reusado por demo-generator (misma firma de 2 args). Hace 2 llamadas (info + productos)
// y las fusiona; el demo lee el subconjunto de INFO e ignora `productos`.
async function extractBusinessData(pages, logCost, opts = {}) {
  const combined = pages.map((p) => `=== ${p.url} ===\n${p.text}`).join('\n\n').slice(0, 30_000);
  const msgs = [{ role: 'user', content: combined }];
  const info = await _extractWithTool(msgs, INFO_TOOL, { logCost, event: 'extract_info', onDebug: opts.onDebug, maxTokens: 2000 });
  const prod = await _extractWithTool(msgs, PRODUCTS_TOOL, { logCost, event: 'extract_products', onDebug: opts.onDebug, maxTokens: 2000 });
  return { ...info, productos: Array.isArray(prod.productos) ? prod.productos : [] };
}

// Extrae desde capturas (imágenes). Una sola llamada con INFO (en capturas no suele
// haber catálogos largos).
async function extractFromImages(images, logCost, opts = {}) {
  const content = [
    { type: 'text', text: 'Extraé los datos del negocio de estas capturas usando la herramienta.' },
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 } })),
  ];
  return _extractWithTool([{ role: 'user', content }], INFO_TOOL, { logCost, event: 'extract_images', onDebug: opts.onDebug, maxTokens: 1200 });
}

async function transcribeFromAudio(audios) {
  const parts = [];
  for (const a of audios || []) {
    const t = await transcribeAudio(a.buffer, a.contentType);
    if (t && t.trim()) parts.push(t.trim());
  }
  return parts.join('\n');
}

// Descarga cruda con el mismo guard SSRF que producción. Devuelve { url, html }.
async function _fetchRaw(rawUrl) {
  await validateUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(rawUrl, { signal: controller.signal, headers: { 'User-Agent': 'DaxosBot/1.0' } });
    const buf = Buffer.from(await res.arrayBuffer()).slice(0, MAX_RESPONSE_BYTES);
    return { url: rawUrl, html: buf.toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

// Una sola página, con el texto ya limpio. (Lo usa el modo --debug.)
async function fetchPage(rawUrl) {
  const { url, html } = await _fetchRaw(rawUrl);
  return { url, text: cleanHtml(html) };
}

// Links del mismo dominio cuyo href o texto mencionan secciones útiles del negocio.
const RELEVANT_LINK_RE = /contacto|env[ií]os?|preguntas|faq|nosotros|precios?|servicios?|tienda|shop/i;
function extractLinks(html, baseUrl, max = 5) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const out = [], seen = new Set();
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ');
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    if (!RELEVANT_LINK_RE.test(href) && !RELEVANT_LINK_RE.test(text)) continue;
    let abs;
    try { abs = new URL(href, baseUrl); } catch { continue; }
    if (abs.hostname !== base.hostname) continue;        // solo el mismo dominio
    abs.hash = '';
    const u = abs.href;
    if (u === base.href || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// Portada + hasta `max` subpáginas relevantes del mismo dominio. Devuelve [{url,text},...].
// opts.fetchRaw es inyectable para tests (nunca web en vivo en los tests).
async function fetchSite(rawUrl, opts = {}) {
  const fetchRaw = opts.fetchRaw || _fetchRaw;
  const max = opts.max || 5;
  const home = await fetchRaw(rawUrl);
  const pages = [{ url: home.url || rawUrl, text: cleanHtml(home.html || '') }];
  const links = extractLinks(home.html || '', home.url || rawUrl, max);
  for (const link of links) {
    try {
      const sub = await fetchRaw(link);
      const text = cleanHtml(sub.html || '');
      if (text) pages.push({ url: link, text });
    } catch (_) { /* subpágina caída: se saltea, no rompe */ }
  }
  return pages;
}

function cleanHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Mapeo esquema → borrador del panel ───────────────────────────────────────
const ALLOWED_STYLE_KEYS  = new Set(['tono', 'uso_emojis', 'largo_mensajes', 'forma_de_cerrar', 'caracteristicas', 'mensajes_separados']);
const ALLOWED_SURVEY_KEYS = new Set(['prioridad', 'objeciones_precio', 'sin_respuesta', 'turnos', 'pagos', 'entrega']);
const STYLE_TONO_VALUES   = new Set(['cercano', 'formal', 'directo', 'persuasivo', 'informativo']);
const TONO_MAP = { informal: 'cercano', neutro: 'informativo', formal: 'formal' };
// Palabras de rubro genérico que NO son un nombre propio de negocio.
const GENERIC_NAMES = new Set([
  'veterinaria', 'inmobiliaria', 'estetica', 'estética', 'peluqueria', 'peluquería',
  'ferreteria', 'ferretería', 'farmacia', 'restaurante', 'tienda', 'comercio', 'negocio',
  'clinica', 'clínica', 'consultorio', 'gimnasio', 'barberia', 'barbería', 'panaderia',
  'panadería', 'kiosco', 'almacen', 'almacén',
]);

function _validField(field) {
  const dot = field.indexOf('.');
  if (dot === -1) return true;
  const ns = field.slice(0, dot), key = field.slice(dot + 1);
  if (ns === 'style_profile')  return ALLOWED_STYLE_KEYS.has(key);
  if (ns === 'survey_answers') return ALLOWED_SURVEY_KEYS.has(key);
  return false;
}

function _isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ||
         (Array.isArray(v) && v.length === 0);
}

// Pura y exportada para testear sin red.
function mapToDraft(data, source = 'web') {
  const rows = [];
  const add = (field, value, confidence, needs_confirm = 0) => {
    if (_isEmpty(value)) return;
    if (!_validField(field)) return;
    rows.push({ field, value: typeof value === 'string' ? value.trim() : value, source, confidence, needs_confirm });
  };

  // name = nombre PROPIO del negocio. Si es solo el rubro genérico (ej "Veterinaria"),
  // queda vacío: lo pregunta la Fase 2. Nunca un genérico.
  let nombre = data.nombre;
  if (nombre) {
    const n = String(nombre).trim().toLowerCase();
    const rub = String(data.rubro || '').trim().toLowerCase();
    if (n === rub || GENERIC_NAMES.has(n)) nombre = null;
  }
  add('name', nombre, 0.85);

  // ¿Qué hacés o vendés? + datos de contacto que la web muestra (dirección, teléfono),
  // para que el asistente los tenga a mano. El panel no tiene campo propio de contacto.
  const ctx = [
    data.descripcion,
    data.publico ? `Público: ${data.publico}` : null,
    data.ubicacion ? `Dirección: ${data.ubicacion}` : null,
    data.telefono ? `Teléfono: ${data.telefono}` : null,
    data.whatsapp ? `WhatsApp: ${data.whatsapp}` : null,
  ].filter(Boolean).join(' ');
  add('business_context', ctx, 0.7);

  // Precios. Preferimos la lista estructurada de productos (con conflicto si hay 2 precios).
  // NUNCA promos. Siempre needs_confirm=1.
  let priceLines = [];
  if (Array.isArray(data.productos) && data.productos.length) {
    for (const p of data.productos) {
      if (!p || !p.nombre) continue;
      // Conflicto real: 2+ precios ACTUALES distintos para el mismo producto.
      if (p.conflicto === true) {
        const cz = [...new Set((p.precios_conflicto || []).map((x) => String(x).trim()).filter(Boolean))];
        if (cz.length > 1) { priceLines.push(`${p.nombre} — ${cz.join(' / ')}  [precio en conflicto, confirmar]`); continue; }
      }
      const precio = p.precio != null ? String(p.precio).trim() : '';
      if (!precio) continue;
      const anterior = p.precio_anterior != null ? String(p.precio_anterior).trim() : '';
      // Oferta (regular tachado + precio actual) NO es conflicto: se guarda el actual con la nota.
      priceLines.push(anterior && anterior !== precio
        ? `${p.nombre} — ${precio}  [en oferta, antes ${anterior}]`
        : `${p.nombre} — ${precio}`);
    }
  } else {
    // Fallback (tests / esquema viejo): strings con precio, sin promos.
    priceLines = [...(data.productos_precios || []), ...(data.servicios || [])]
      .filter((s) => typeof s === 'string' && findPrices(s).length > 0);
  }
  add('pricing_info', [...new Set(priceLines)].join('\n'), 0.5, 1);

  const sedes = Array.isArray(data.sedes) ? data.sedes : [];
  const horario = data.horarios || sedes.map((s) => s && s.horario).find(Boolean);
  add('business_hours', horario, 0.45, 1);

  // Teléfono de urgencias SOLO si la web habla de urgencias/24h.
  const anyPhone = sedes.map((s) => s && s.telefono).find(Boolean) || data.telefono || data.whatsapp;
  if (data.es_urgencias === true) add('urgent_phone', anyPhone, 0.4);

  const tono = TONO_MAP[data.tono];
  if (tono && STYLE_TONO_VALUES.has(tono)) add('style_profile.tono', tono, 0.4);

  // Instrucciones libres (Reglas): envíos, pagos, cambios/devoluciones.
  const rules = [];
  if (!_isEmpty(data.envios)) rules.push(`Envíos: ${data.envios}`);
  if (!_isEmpty(data.medios_pago)) rules.push(`Medios de pago: ${data.medios_pago}`);
  if (!_isEmpty(data.cambios_devoluciones)) rules.push(`Cambios y devoluciones: ${data.cambios_devoluciones}`);
  if (!_isEmpty(data.personalizados)) rules.push(`A medida / personalizados: ${data.personalizados}`);
  add('owner_rules', rules.join('\n'), 0.4);

  // Documentos que el asistente lee: preguntas frecuentes / políticas.
  add('reference_docs', (data.preguntas_frecuentes || []).filter(Boolean).join('\n'), 0.4);

  // Qué decís cuando es caro: el diferencial del negocio.
  add('survey_answers.objeciones_precio', data.diferencial, 0.4);

  // Qué hacer cuando cerrados: se redacta con el horario (+ urgencias si corresponde).
  if (!_isEmpty(horario)) {
    let ah = `Fuera de nuestro horario de atención (${String(horario).trim()}) te respondemos apenas reabrimos.`;
    if (data.es_urgencias === true && !_isEmpty(anyPhone)) ah += ` Si es una urgencia, comunicate al ${anyPhone}.`;
    add('after_hours_instructions', ah, 0.4);
  }

  return rows;
}

// ─── Orquestador ──────────────────────────────────────────────────────────────
async function buildDraft(inputs = {}, opts = {}) {
  const { url, text, audios, images } = inputs;
  const extract       = opts.extract       || extractBusinessData;
  const extractImages = opts.extractImages || extractFromImages;
  const transcribe    = opts.transcribe    || transcribeFromAudio;
  const fetchFn       = opts.fetch         || fetchSite; // portada + subpáginas del dominio

  const pages = [];
  if (url) {
    const got = await fetchFn(url);                       // puede ser una página o un array
    for (const p of (Array.isArray(got) ? got : [got])) if (p && p.text) pages.push(p);
  }
  if (text && text.trim()) pages.push({ url: 'texto', text });
  if (audios && audios.length) {
    const t = await transcribe(audios);
    if (t && t.trim()) pages.push({ url: 'audio', text: t });
  }

  const primarySource = url ? 'web' : text ? 'texto' : audios && audios.length ? 'audio' : 'web';

  const rows = [];
  if (pages.length) rows.push(...mapToDraft(await extract(pages, opts.logCost), primarySource));
  if (images && images.length) rows.push(...mapToDraft(await extractImages(images, opts.logCost), 'imagen'));
  if (url) rows.push({ field: 'website_url', value: url, source: 'texto', confidence: 1, needs_confirm: 0 });

  const seen = new Set();
  return rows.filter((r) => (seen.has(r.field) ? false : (seen.add(r.field), true)));
}

module.exports = {
  extractBusinessData,
  extractFromImages,
  transcribeFromAudio,
  fetchPage,
  fetchSite,
  extractLinks,
  cleanHtml,
  mapToDraft,
  buildDraft,
  ALLOWED_STYLE_KEYS,
  ALLOWED_SURVEY_KEYS,
  INFO_TOOL,
  PRODUCTS_TOOL,
  EXTRACT_MODEL,
};
