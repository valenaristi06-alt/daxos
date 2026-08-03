require('dotenv').config({ path: '.env.local' });

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(business, label) {
  const lines = [
    `Sos el asistente de ventas de "${business.name}".`,
    `Respondé siempre en el idioma que usa el cliente.`,
  ];

  if (business.business_context) {
    lines.push(`\nContexto del negocio: ${business.business_context}`);
  }

  if (business.pricing_info) {
    lines.push(`\nPRECIOS Y SERVICIOS — información oficial cargada por el dueño del negocio. Usá estos datos para responder cualquier consulta sobre precios, planes o servicios de forma directa y confiada. Si la pregunta del cliente está cubierta aquí, respondé con estos datos y NO uses [NEEDS_HUMAN]:\n${business.pricing_info}`);
  }

  if (business.website_summary) {
    lines.push(`\nInformación extraída automáticamente del sitio web del negocio (puede estar desactualizada — priorizá lo que el dueño escribió a mano): ${business.website_summary}`);
  }

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

  if (label) {
    const labelCtx = {
      cliente:        'Este contacto ya es cliente. Priorizá soporte, fidelización y atención post-venta. No hagas venta agresiva.',
      prospecto:      'Este contacto es un prospecto interesado. Guialo con información, generá confianza y acompañalo hacia la decisión de compra.',
      no_interesado:  'Este contacto indicó que no está interesado. Sé cordial, no presiones, dejá la puerta abierta sin insistir.',
    };
    if (labelCtx[label]) lines.push(`\nContexto del contacto: ${labelCtx[label]}`);
  }

  if (business.document_name) {
    lines.push(`\nDocumento disponible: el negocio tiene un archivo "${business.document_name}" (catálogo / lista de precios / información del negocio). Si el cliente pide explícitamente ese documento, su catálogo, lista de precios o algo similar, iniciá tu respuesta con [SEND_DOC] en una línea separada y luego continuá con tu mensaje. Solo usá [SEND_DOC] cuando el pedido sea claro y directo — no lo uses por las dudas.`);
  }

  lines.push('\nSé breve, amable y enfocado en ayudar al cliente a comprar o consultar.');
  lines.push('\nDERIVACIÓN: Si el cliente pregunta algo que requiere información específica que no está en el contexto del negocio (precios exactos, disponibilidad, datos de contacto, condiciones particulares, etc.) y no podés dar una respuesta útil y confiable, iniciá tu respuesta con [NEEDS_HUMAN] en una línea separada, seguido de un mensaje amable al cliente indicando que vas a derivarlo con una persona. Solo usá [NEEDS_HUMAN] cuando realmente no tenés los datos necesarios — no lo uses por dudas menores o cuando puedas dar una respuesta útil aunque sea parcial.');
  lines.push('\nFORMATO OBLIGATORIO: Nunca uses markdown. Sin asteriscos, sin negritas, sin cursivas, sin guiones de lista, sin numeración, sin títulos con #. Escribí en texto plano, como un mensaje real de WhatsApp.');

  return lines.join('\n');
}

async function generateReply(business, history, newMessage, label = null) {
  const systemPrompt = buildSystemPrompt(business, label);

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
  const joined = examples.join('\n---\n');
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  const emojiCount = (joined.match(emojiRegex) || []).length;
  const emojiHint = emojiCount === 0
    ? 'Los ejemplos no contienen ningún emoji — el valor DEBE ser "ninguno".'
    : emojiCount <= 3
    ? `Los ejemplos contienen ${emojiCount} emoji(s) en total — el valor debe ser "moderado".`
    : `Los ejemplos contienen ${emojiCount} emojis — el valor debe ser "frecuente".`;

  const prompt = `Vas a analizar el estilo de comunicación de un negocio a partir de ejemplos reales de mensajes de venta. Devolvé ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones.

Ejemplos de mensajes:
---
${joined}
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
- CRÍTICO para uso_emojis: ${emojiHint}
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

async function summarizeWebsite(text) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Resumí en 2-3 líneas qué hace o vende este negocio, basándote en el texto extraído de su sitio web. Solo el resumen, sin introducción:\n\n${text.slice(0, 4000)}`,
    }],
  });
  return response.content[0].text.trim();
}

module.exports = { generateReply, analyzeStyle, summarizeWebsite };
