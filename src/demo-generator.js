'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCRAPE_MODEL   = 'claude-haiku-4-5-20251001';
const CHAT_MODEL     = process.env.DEMO_CHAT_MODEL || 'claude-sonnet-4-6';
const MAX_CHAT_MSGS  = 10;

// ─── Data extraction ──────────────────────────────────────────────────────────

const EXTRACT_SYSTEM = `Sos un extractor de información estructurada. A partir del texto de un sitio web, extraé información del negocio en JSON con esta forma exacta:

{
  "nombre":       "<nombre del negocio o null>",
  "rubro":        "<sector/industria en 2-4 palabras o null>",
  "descripcion":  "<qué hace el negocio, 1-2 oraciones, o null>",
  "servicios":    ["<servicio 1>", "<servicio 2>"] o [],
  "ubicacion":    "<ciudad/país si se menciona o null>",
  "tono":         "formal" | "informal" | "neutro",
  "publico":      "<a quiénes va dirigido, 1 oración, o null>"
}

Reglas:
- Si un dato no aparece claramente en el texto, usá null (nunca inventes).
- Respondé SOLO con el JSON, sin explicaciones ni markdown.`;

async function extractBusinessData(pages, logCost) {
  const combined = pages
    .map((p) => `=== ${p.url} ===\n${p.text}`)
    .join('\n\n')
    .slice(0, 30_000);

  const resp = await client.messages.create({
    model: SCRAPE_MODEL,
    max_tokens: 512,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: combined }],
  });

  const usage = resp.usage;
  if (logCost) logCost({ event: 'extract', inTokens: usage.input_tokens, outTokens: usage.output_tokens });

  const raw = resp.content[0]?.text?.trim() ?? '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Demo system prompt ───────────────────────────────────────────────────────

function buildDemoSystemPrompt(data) {
  const nombre      = data.nombre      ?? 'este negocio';
  const rubro       = data.rubro       ?? 'negocio';
  const descripcion = data.descripcion ?? '';
  const servicios   = (data.servicios ?? []).join(', ') || 'no especificados';
  const ubicacion   = data.ubicacion   ? `Ubicación: ${data.ubicacion}.` : '';
  const publico     = data.publico     ? `Público objetivo: ${data.publico}.` : '';
  const tono        = data.tono        ?? 'neutro';

  return `Sos el asistente virtual de ${nombre}, un negocio de ${rubro}.
${descripcion}
Servicios: ${servicios}.
${ubicacion}
${publico}

Respondé en tono ${tono}. Sé útil, conciso y orientado al cliente. Si no sabés algo sobre el negocio, decí que no tenés esa información disponible en este momento. No inventes datos.

Esta es una demo de Daxos. Si el usuario pregunta cómo activar este asistente para su negocio, mencioná que puede hacerlo en daxos.ai.`;
}

// ─── Demo chat ────────────────────────────────────────────────────────────────

async function generateDemoChatReply(data, conversationHistory, userMessage, logCost) {
  const systemPrompt = buildDemoSystemPrompt(data);

  const messages = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const resp = await client.messages.create({
    model: CHAT_MODEL,
    max_tokens: 400,
    system: systemPrompt,
    messages,
  });

  const usage = resp.usage;
  if (logCost) logCost({ event: 'chat', inTokens: usage.input_tokens, outTokens: usage.output_tokens });

  return resp.content[0]?.text?.trim() ?? '';
}

module.exports = { extractBusinessData, buildDemoSystemPrompt, generateDemoChatReply, MAX_CHAT_MSGS };
