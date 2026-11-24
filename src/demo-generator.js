'use strict';

const Anthropic = require('@anthropic-ai/sdk');
// La extracción estructurada ahora vive en el motor de lectura (Fase 1).
// El demo la reusa desde ahí: misma función, misma llamada a Anthropic, sin cambios.
const { extractBusinessData } = require('./reader');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CHAT_MODEL     = process.env.DEMO_CHAT_MODEL || 'claude-sonnet-4-6';
const MAX_CHAT_MSGS  = 10;

// ─── Demo system prompt ───────────────────────────────────────────────────────

function buildDemoSystemPrompt(data) {
  const nombre      = data.nombre      ?? 'este negocio';
  const rubro       = data.rubro       ?? 'negocio';
  const descripcion = data.descripcion ?? '';
  const servicios   = (data.servicios ?? []).join(', ') || 'no especificados';
  const ubicacion   = data.ubicacion   ? `Ubicación: ${data.ubicacion}.` : '';
  const publico     = data.publico     ? `Público objetivo: ${data.publico}.` : '';
  const tono        = data.tono        ?? 'neutro';
  const faqs        = (data.preguntas_frecuentes ?? []).length
    ? `Preguntas frecuentes: ${data.preguntas_frecuentes.join(' | ')}.` : '';
  const promos      = (data.promos ?? []).length
    ? `Promociones activas: ${data.promos.join(', ')}.` : '';
  const sedes       = (data.sedes ?? []).filter(s => s.direccion || s.horario || s.telefono);
  const sedesStr    = sedes.length
    ? 'Sedes: ' + sedes.map(s => [s.nombre, s.direccion, s.horario, s.telefono].filter(Boolean).join(', ')).join(' | ') + '.'
    : '';

  return `Sos el asistente virtual de ${nombre}, un negocio de ${rubro}.
${descripcion}
Servicios: ${servicios}.
${faqs}
${promos}
${sedesStr}
${ubicacion}
${publico}

Respondé en tono ${tono}. Sé útil, conciso y orientado al cliente. Si no sabés algo sobre el negocio, decí que no tenés esa información disponible en este momento. No inventes datos.

Esta es una demo de Daxos. Si el usuario pregunta cómo activar este asistente para su negocio, mencioná que puede hacerlo en daxos.lat.`;
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
