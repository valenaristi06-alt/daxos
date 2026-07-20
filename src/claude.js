require('dotenv').config({ path: '.env.local' });

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(business) {
  const lines = [
    `Sos el asistente de ventas de "${business.name}".`,
    `Respondé siempre en el idioma que usa el cliente.`,
  ];

  if (business.sales_examples && business.sales_examples.length > 0) {
    lines.push(
      '\nTono y estilo — estos son ejemplos de cómo habla el negocio. Imitá ese tono en cada respuesta:',
      ...business.sales_examples.map((ex, i) => `${i + 1}. ${ex}`)
    );
  }

  if (business.style_profile) {
    const p = business.style_profile;
    lines.push(
      '\n== Perfil de estilo detectado automáticamente ==',
      `Tono: ${p.tono}`,
      `Uso de emojis: ${p.uso_emojis}`,
      `Largo de mensajes: ${p.largo_mensajes}`,
      `Forma de cerrar: ${p.forma_de_cerrar}`,
      `Características: ${(p.caracteristicas || []).join(', ')}`,
      'Usá este perfil como guía adicional al redactar cada respuesta.'
    );
  }

  if (business.survey_answers && Object.keys(business.survey_answers).length > 0) {
    lines.push('\nInformación del negocio:');
    for (const [key, val] of Object.entries(business.survey_answers)) {
      lines.push(`- ${key}: ${val}`);
    }
  }

  lines.push('\nSé breve, amable y enfocado en ayudar al cliente a comprar o consultar.');

  return lines.join('\n');
}

async function generateReply(business, history, newMessage) {
  const systemPrompt = buildSystemPrompt(business);

  const messages = [
    ...history.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    })),
    { role: 'user', content: newMessage },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
}

async function analyzeStyle(examples) {
  const prompt = `Vas a analizar el estilo de comunicación de un negocio a partir de ejemplos reales de mensajes de venta. Devolvé ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones.

Ejemplos de mensajes:
---
${examples.join('\n---\n')}
---

Analizá el estilo y devolvé este JSON con exactamente estas claves:

{
  "tono": "<una de: cercano | formal | directo | persuasivo | informativo>",
  "uso_emojis": "<una de: ninguno | moderado | frecuente>",
  "largo_mensajes": "<una de: corto | medio | largo>",
  "forma_de_cerrar": "<una de: con pregunta | con llamado a la acción | abierto | mixto>",
  "caracteristicas": ["<rasgo 1 en máx 5 palabras>", "<rasgo 2>", "<rasgo 3>"]
}

Reglas:
- Solo los valores de las opciones listadas, sin inventar otros.
- "caracteristicas" es un array de exactamente 3 strings cortos que describen rasgos distintivos del estilo.
- No agregues comentarios, markdown ni texto fuera del JSON.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text.trim();
  const profile = JSON.parse(raw);

  // Validate required keys exist
  const required = ['tono', 'uso_emojis', 'largo_mensajes', 'forma_de_cerrar', 'caracteristicas'];
  for (const key of required) {
    if (!(key in profile)) throw new Error(`Missing key in style profile: ${key}`);
  }
  if (!Array.isArray(profile.caracteristicas)) throw new Error('caracteristicas must be array');

  return profile;
}

module.exports = { generateReply, analyzeStyle };
