'use strict';

// Motor de lectura del configurador (Fase 1, sin pantalla).
// Recibe URL / texto / audio / imágenes y devuelve un BORRADOR con el esquema del
// panel: cada fila { field, value, source, confidence, needs_confirm }.
// Reglas duras:
//   - Si un dato no aparece, el campo queda vacío (no se emite). Nunca se inventa.
//   - Los precios SIEMPRE quedan marcados needs_confirm=1 ("a confirmar").
//   - Las claves de survey_answers.* y style_profile.* se validan contra listas blancas.
// El borrador no toca la configuración real de ningún negocio (eso es Fase 2 "Aplicar").
//
// Cliente Anthropic unificado para el CÓDIGO NUEVO de esta fase. Las llamadas Anthropic
// que ya existían (claude.js, demo chat) no se tocan.

const Anthropic = require('@anthropic-ai/sdk');
const { validateUrl, MAX_RESPONSE_BYTES, TIMEOUT_MS } = require('./ssrf');
const { transcribeAudio } = require('./elevenlabs');
const { findPrices } = require('./pricecap');

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';

// Esquema estructurado que devuelve el extractor (igual al del demo-generator).
const EXTRACT_SYSTEM = `Sos un extractor de información estructurada. A partir del texto de un sitio web, extraé información del negocio en JSON con esta forma exacta:

{
  "nombre":               "<nombre del negocio o null>",
  "rubro":                "<sector/industria en 2-4 palabras o null>",
  "descripcion":          "<qué hace el negocio, 1-2 oraciones, o null>",
  "servicios":            ["<servicio o producto 1>", "<servicio o producto 2>"] o [],
  "preguntas_frecuentes": ["<pregunta: respuesta breve>"] o [],
  "promos":               ["<promoción o descuento activo>"] o [],
  "sedes": [{"nombre": null, "direccion": null, "horario": null, "telefono": null}] o [],
  "ubicacion":            "<ciudad/país si se menciona o null>",
  "tono":                 "formal" | "informal" | "neutro",
  "publico":              "<a quiénes va dirigido, 1 oración, o null>"
}

Reglas:
- Si un dato no aparece claramente en el texto, usá null o [] (nunca inventes).
- Respondé SOLO con el JSON, sin explicaciones ni markdown.`;

// ─── Extracción estructurada (movida desde demo-generator; demo la reusa desde acá) ──
async function extractBusinessData(pages, logCost) {
  const combined = pages
    .map((p) => `=== ${p.url} ===\n${p.text}`)
    .join('\n\n')
    .slice(0, 30_000);

  const resp = await _client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 512,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: combined }],
  });

  const usage = resp.usage;
  if (logCost) logCost({ event: 'extract', inTokens: usage.input_tokens, outTokens: usage.output_tokens });

  const raw = resp.content[0]?.text?.trim() ?? '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

// Extrae el mismo esquema desde capturas (imágenes), p. ej. publicaciones de Instagram
// con precios. `images` = [{ base64, mediaType }]. Inyectable en tests vía opts.
async function extractFromImages(images, logCost) {
  const content = [
    { type: 'text', text: 'Extraé la información del negocio de estas capturas, con el mismo JSON pedido.' },
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 },
    })),
  ];
  const resp = await _client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 512,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const usage = resp.usage;
  if (logCost) logCost({ event: 'extract_images', inTokens: usage.input_tokens, outTokens: usage.output_tokens });
  const raw = resp.content[0]?.text?.trim() ?? '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

async function transcribeFromAudio(audios) {
  const parts = [];
  for (const a of audios || []) {
    const t = await transcribeAudio(a.buffer, a.contentType);
    if (t && t.trim()) parts.push(t.trim());
  }
  return parts.join('\n');
}

// Descarga una página con el mismo guard SSRF que producción. Devuelve { url, text }.
async function fetchPage(rawUrl) {
  await validateUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(rawUrl, { signal: controller.signal, headers: { 'User-Agent': 'DaxosBot/1.0' } });
    const buf = Buffer.from(await res.arrayBuffer()).slice(0, MAX_RESPONSE_BYTES);
    const html = buf.toString('utf8');
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { url: rawUrl, text };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Mapeo esquema → borrador del panel ───────────────────────────────────────
const ALLOWED_STYLE_KEYS  = new Set(['tono', 'uso_emojis', 'largo_mensajes', 'forma_de_cerrar', 'caracteristicas', 'mensajes_separados']);
const ALLOWED_SURVEY_KEYS = new Set(['prioridad', 'objeciones_precio', 'sin_respuesta', 'turnos', 'pagos', 'entrega']);
const STYLE_TONO_VALUES   = new Set(['cercano', 'formal', 'directo', 'persuasivo', 'informativo']);
const TONO_MAP = { informal: 'cercano', neutro: 'informativo', formal: 'formal' };

function _validField(field) {
  const dot = field.indexOf('.');
  if (dot === -1) return true;
  const ns = field.slice(0, dot), key = field.slice(dot + 1);
  if (ns === 'style_profile')  return ALLOWED_STYLE_KEYS.has(key);
  if (ns === 'survey_answers') return ALLOWED_SURVEY_KEYS.has(key);
  return false; // namespace desconocido → se descarta, no se inventa
}

function _isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ||
         (Array.isArray(v) && v.length === 0);
}

// Pura y exportada para poder testearla sin red.
function mapToDraft(data, source = 'web') {
  const rows = [];
  const add = (field, value, confidence, needs_confirm = 0) => {
    if (_isEmpty(value)) return;              // dato ausente → campo vacío, nunca inventado
    if (!_validField(field)) return;         // clave no permitida → se descarta
    rows.push({ field, value: typeof value === 'string' ? value.trim() : value, source, confidence, needs_confirm });
  };

  add('name', data.nombre, 0.85);

  const ctx = [data.descripcion, data.publico ? `Público: ${data.publico}` : null].filter(Boolean).join(' ');
  add('business_context', ctx, 0.7);

  // Precios: solo líneas que REALMENTE contienen un precio en el texto extraído.
  // Siempre needs_confirm=1. Si no hay ningún precio, pricing_info queda vacío.
  const priceLines = [...(data.servicios || []), ...(data.promos || [])]
    .filter((s) => typeof s === 'string' && findPrices(s).length > 0);
  add('pricing_info', priceLines.join('\n'), 0.5, 1);

  const sedes = Array.isArray(data.sedes) ? data.sedes : [];
  const horario = sedes.map((s) => s && s.horario).find(Boolean);
  add('business_hours', horario, 0.45, 1); // texto libre; el dueño lo confirma/formatea

  const telefono = sedes.map((s) => s && s.telefono).find(Boolean);
  add('urgent_phone', telefono, 0.4);

  const tono = TONO_MAP[data.tono];
  if (tono && STYLE_TONO_VALUES.has(tono)) add('style_profile.tono', tono, 0.4);

  return rows;
}

// ─── Orquestador ──────────────────────────────────────────────────────────────
// inputs: { url, text, audios:[{buffer,contentType}], images:[{base64,mediaType}] }
// opts (inyectables para tests): extract, extractImages, transcribe, fetch, logCost
async function buildDraft(inputs = {}, opts = {}) {
  const { url, text, audios, images } = inputs;
  const extract       = opts.extract       || extractBusinessData;
  const extractImages = opts.extractImages || extractFromImages;
  const transcribe    = opts.transcribe    || transcribeFromAudio;
  const fetchFn       = opts.fetch         || fetchPage;

  const pages = [];
  if (url)  { const p = await fetchFn(url); if (p && p.text) pages.push(p); }
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

  // Dedupe por campo: primera aparición gana (web/texto antes que imagen).
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.field) ? false : (seen.add(r.field), true)));
}

module.exports = {
  extractBusinessData,     // reusado por demo-generator (misma función, misma llamada)
  extractFromImages,
  transcribeFromAudio,
  fetchPage,
  mapToDraft,
  buildDraft,
  ALLOWED_STYLE_KEYS,
  ALLOWED_SURVEY_KEYS,
};
