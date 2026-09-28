const Anthropic = require('@anthropic-ai/sdk');
const { getRuntimeConfig } = require('./db');

let _localConfig = null;
try { _localConfig = require('./config.local'); } catch (_) {}

function initAnthropicKey() {} // kept so server.js import doesn't break

function getClient() {
  const fromFile   = _localConfig?.ANTHROPIC_API_KEY;
  const fromGlobal = globalThis.__DAXOS_ENV?.ANTHROPIC_API_KEY;
  const fromEnv    = process.env.ANTHROPIC_API_KEY;
  const fromDB     = (!fromFile && !fromGlobal && !fromEnv) ? getRuntimeConfig('ANTHROPIC_API_KEY') : null;
  const apiKey     = fromFile || fromGlobal || fromEnv || fromDB;
  console.log('[claude:getClient] PID=' + process.pid +
    ' file=' + (fromFile ? 'present(' + fromFile.length + ')' : 'absent') +
    ' global=' + (fromGlobal ? 'present(' + fromGlobal.length + ')' : 'MISSING') +
    ' env=' + (fromEnv ? 'present(' + fromEnv.length + ')' : 'MISSING') +
    ' db=' + (fromDB != null ? 'present(' + fromDB.length + ')' : 'skipped/MISSING'));
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not found in config.local, globalThis, process.env, or DB');
  return new Anthropic({ apiKey });
}

// Returns { staticText, dynamicText } to enable prompt caching.
// staticText: stable per business+label+bookingEnabled — cached with cache_control ephemeral.
// dynamicText: changes per message (current time, booking step, needsHuman) — not cached.
function buildSystemPrompt(business, label, bookingContext = null, runtimeCtx = null) {
  const staticLines = [
    `Sos el asistente de ventas de "${business.name}".`,
    `Respondé siempre en el idioma que usa el cliente.`,
  ];

  if (business.business_context) {
    staticLines.push(`\nContexto del negocio: ${business.business_context}`);
  }

  if (business.pricing_info) {
    staticLines.push(`\nPRECIOS Y SERVICIOS — información oficial cargada por el dueño del negocio. Usá estos datos para responder cualquier consulta sobre precios, planes o servicios de forma directa y confiada. Si la pregunta del cliente está cubierta aquí, respondé con estos datos y NO uses [NEEDS_HUMAN]:\n${business.pricing_info}`);
  }

  if (business.website_summary) {
    staticLines.push(`\nInformación extraída automáticamente del sitio web del negocio (puede estar desactualizada — priorizá lo que el dueño escribió a mano): ${business.website_summary}`);
  }

  if (business.sales_examples && business.sales_examples.length > 0) {
    staticLines.push(
      '\nTono y estilo — estos son ejemplos de cómo habla el negocio. Imitá ese tono en cada respuesta:',
      ...business.sales_examples.map((ex, i) => `${i + 1}. ${ex}`)
    );
  }

  if (business.style_profile) {
    const p = business.style_profile;
    staticLines.push(
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
    staticLines.push('\nInformación del negocio:');
    for (const [key, val] of Object.entries(business.survey_answers)) {
      if (val !== null && val !== undefined && val !== '') staticLines.push(`- ${key}: ${val}`);
    }
  }

  if (label) {
    const labelCtx = {
      cliente:        'Este contacto ya es cliente. Priorizá soporte, fidelización y atención post-venta. No hagas venta agresiva.',
      prospecto:      'Este contacto es un prospecto interesado. Guialo con información, generá confianza y acompañalo hacia la decisión de compra.',
      no_interesado:  'Este contacto indicó que no está interesado. Sé cordial, no presiones, dejá la puerta abierta sin insistir.',
    };
    if (labelCtx[label]) staticLines.push(`\nContexto del contacto: ${labelCtx[label]}`);
  }

  if (business.document_name) {
    staticLines.push(`\nDocumento disponible: el negocio tiene un archivo "${business.document_name}" (catálogo / lista de precios / información del negocio). Si el cliente pide explícitamente ese documento, su catálogo, lista de precios o algo similar, iniciá tu respuesta con [SEND_DOC] en una línea separada y luego continuá con tu mensaje. Solo usá [SEND_DOC] cuando el pedido sea claro y directo — no lo uses por las dudas.`);
  }

  staticLines.push('\nSé breve, amable y enfocado en ayudar al cliente a comprar o consultar.');
  staticLines.push('\nESTILO — reglas obligatorias:\n- Prohibido usar frases de relleno de IA: "Buena pregunta", "Excelente pregunta", "Claro que sí", "Por supuesto", "Con gusto", "Desde luego". Respondé directo.\n- No cierres siempre con la misma pregunta. Variá el cierre según el contexto: a veces cerrá con una pregunta relevante, a veces con información, a veces sin pregunta. Nunca uses el mismo cierre dos veces seguidas.');

  // Booking trigger (no active state) is stable — goes in static block
  if (bookingContext?.enabled && !bookingContext.state) {
    staticLines.push(
      '\nTURNOS: Este negocio permite agendar turnos. ' +
      'Si el cliente pide de forma clara y explícita sacar un turno, reservar una cita o agendar ' +
      '(ejemplos: "quiero sacar turno", "me podés agendar", "cómo reservo una cita", "quiero pedir un turno"), ' +
      'iniciá tu respuesta con [WANTS_BOOKING] en una línea separada, luego pedile al cliente su nombre completo. ' +
      'IMPORTANTE — esto NO es pedido de turno: preguntas sobre horarios de atención ("¿atienden los sábados?", "¿a qué hora abren?"), ' +
      'preguntas sobre disponibilidad ("¿tienen lugar?", "¿hay turnos?"), o cualquier consulta donde el cliente no diga explícitamente que quiere agendar. ' +
      'Si hay alguna duda, respondé normal y esperá a que el cliente lo pida claro.'
    );
  }

  if (runtimeCtx?.images?.length > 0) {
    const labels = runtimeCtx.images.map(img => `[${img.label}]`).join(', ');
    staticLines.push(`\nIMÁGENES DISPONIBLES: Tenés estas imágenes para enviar si el cliente las pide o si ayuda a la venta: ${labels}. Si querés enviar una, usá exactamente: [ENVIAR_IMAGEN: <label exacto>]. Solo podés enviar UNA imagen por respuesta. Solo usala si el cliente la pidió o si claramente ayuda a la venta — no la mandes por las dudas. POSICIÓN DEL TAG: si ponés el tag al FINAL del mensaje, la imagen se envía después del texto. Si ponés el tag al INICIO del mensaje (antes de cualquier texto), la imagen se envía primero. En la mayoría de los casos el tag va al final.`);
  }

  if (runtimeCtx?.documents?.length > 0) {
    const imageNote = runtimeCtx?.images?.length > 0
      ? ` IMPORTANTE: si algún documento indica enviar una imagen, usá el tag [ENVIAR_IMAGEN: <label exacto>] con la etiqueta exacta de la lista de imágenes de arriba — no describas la imagen ni la menciones de otra forma.`
      : '';
    staticLines.push(`\nDOCUMENTOS DE REFERENCIA${imageNote}

CÓMO USAR ESTOS DOCUMENTOS — leé esto antes de leer el documento:

Si el documento contiene un guion, script o flujo de ventas (preguntas en orden, pasos numerados, secuencia de calificación), ese orden define el flujo principal de la conversación. Seguilo tal como está escrito — el negocio lo diseñó así.

Si el documento es información de referencia (precios, servicios, contexto del negocio), usalo para responder preguntas del cliente — no como pasos a ejecutar en secuencia.

PROHIBIDO:
- Copiar o parafrasear frases del documento casi textualmente — usá tus propias palabras, en el estilo del negocio
- Saltar pasos del guion sin razón, o inventar preguntas que no están en él
- Hacer preguntas que el cliente ya respondió en el historial de esta conversación
- Reiniciar el flujo desde el principio si ya aparece completo en el historial — un "Sí", "Me interesa" o cualquier respuesta afirmativa a una pregunta de cierre es una RESPUESTA al cierre, no un nuevo inicio. En ese caso, avanzá al siguiente paso concreto (precio, agendar, link, etc.)

CÓMO HACERLO BIEN:
1. Mirá el historial completo. Identificá en qué paso del guion está la conversación y qué información del cliente ya tenés.
2. Avanzá al próximo paso del guion que aún no fue respondido — no al primero de la lista.
3. Parafraseá el contenido del guion con tus propias palabras, en el estilo configurado del negocio.
4. Si el cliente pregunta algo fuera del guion (precio, disponibilidad, etc.), respondé con la información disponible y retomá el flujo.`);
    for (const doc of runtimeCtx.documents) {
      staticLines.push(`\n=== ${doc.name} ===\n${doc.text}`);
    }
  }

  staticLines.push('\nDERIVACIÓN: Usá [NEEDS_HUMAN] solo cuando el cliente necesite una respuesta que vos no podés dar y que el dueño del negocio sí puede dar en ese momento (ej: confirmar disponibilidad en tiempo real, autorizar una excepción, dar un dato privado). NO uses [NEEDS_HUMAN] para preguntas operativas básicas que el negocio simplemente no cargó: horarios de atención, dirección, formas de pago, zona de cobertura. Para esas, reconocé que no tenés el dato y decí que alguien del equipo se lo va a confirmar — no hables en primera persona como si vos fueras a confirmarlo, porque eso no va a pasar automáticamente. Ejemplos válidos: "eso te lo confirma alguien del equipo", "los horarios te los paso por acá en breve", "eso lo tiene que confirmar el equipo directamente". NO digas "te lo confirmo enseguida", "dame un momento", "ya te averiguo" — implican que la respuesta llega en segundos y no es honesto. Si en un mensaje posterior el cliente vuelve a preguntar por ese mismo dato que no llegó, ahí sí usá [NEEDS_HUMAN] para que el dueño lo atienda directamente.\nFORMATO DE [NEEDS_HUMAN]: el marcador va SIEMPRE al inicio del mensaje, antes de cualquier texto. Estructura exacta: [NEEDS_HUMAN] en la primera línea, luego el mensaje de derivación al cliente. Después del mensaje de derivación NO agregues ningún texto adicional, ni preguntas de cierre, ni frases como "¿Alguna duda?" o "Estoy acá para ayudarte". El mensaje termina ahí.');
  staticLines.push('\nFORMATO OBLIGATORIO: Nunca uses markdown. Sin asteriscos, sin negritas, sin cursivas, sin guiones de lista, sin numeración, sin títulos con #. Escribí en texto plano, como un mensaje real de WhatsApp.');

  // Dynamic lines — change per message, must NOT be included in the cached block
  const dynamicLines = [];

  if (runtimeCtx?.now) {
    const d = runtimeCtx.now; // Date already offset to Montevideo (UTC-3)
    const days   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const timeStr = `${days[d.getUTCDay()]} ${d.getUTCDate()} de ${months[d.getUTCMonth()]} de ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    dynamicLines.push(`Fecha y hora actual en Montevideo: ${timeStr}.`);
  }

  // Active booking step instructions — change as the conversation progresses
  if (bookingContext?.enabled && bookingContext.state) {
    const state = bookingContext.state;
    if (state.step === 'collecting_name') {
      dynamicLines.push(
        '\nMODO TURNO — PASO 1 (NOMBRE):',
        'El cliente está en proceso de pedir un turno. Necesitás su nombre completo.',
        '- Si el mensaje actual contiene un nombre claro, usalo, confirmalo con una frase breve, preguntá el motivo de la consulta, ' +
        'y agregá al FINAL de tu respuesta en una línea separada: [BOOKING_NAME: <nombre que detectaste>]',
        '- Si el mensaje no tiene un nombre claro, pedíselo brevemente.',
        '- Si el cliente cambia de tema (pregunta algo no relacionado, dice que no quiere más, etc.), ' +
        'iniciá tu respuesta con [CANCEL_BOOKING] y respondé lo que preguntó normalmente.'
      );
    } else if (state.step === 'collecting_reason') {
      dynamicLines.push(
        `\nMODO TURNO — PASO 2 (MOTIVO): Nombre del cliente: ${state.name}`,
        'Necesitás saber el motivo de la consulta o el servicio que busca.',
        '- Si el mensaje contiene un motivo claro, confirmalo brevemente, pedí que proponga 2 o 3 horarios que le vengan bien (con día y hora), ' +
        'y agregá al FINAL: [BOOKING_REASON: <motivo que detectaste>]',
        '- Si no hay motivo claro, pedíselo.',
        '- Si el cliente cambia de tema, iniciá con [CANCEL_BOOKING] y respondé lo que preguntó.'
      );
    } else if (state.step === 'collecting_slots') {
      dynamicLines.push(
        `\nMODO TURNO — PASO 3 (HORARIOS): ${state.name} — ${state.reason}`,
        'Necesitás que el cliente proponga entre 2 y 3 horarios posibles.',
        '- Si el mensaje contiene horarios con día y/u hora, confimalos, decile que vas a avisar al dueño y que te va a responder en breve. ' +
        'Agregá al FINAL: [BOOKING_SLOTS: <horario 1> | <horario 2> | <horario 3>] (podés omitir el 3ro si solo dio 2).',
        '- Si no hay horarios claros, pedí que proponga 2 o 3 opciones con día y hora aproximada.',
        '- Si el cliente cambia de tema, iniciá con [CANCEL_BOOKING] y respondé lo que preguntó.'
      );
    } else if (state.step === 'waiting_owner') {
      dynamicLines.push(
        `\nMODO TURNO — EN ESPERA: ${state.name} tiene un pedido de turno esperando confirmación del dueño.`,
        'Si el cliente pregunta por el estado de su turno, avisale que el dueño todavía no confirmó y que le vas a avisar en cuanto pueda.',
        'No retomes el proceso de pedido de turno — ya está registrado.',
        'Respondé cualquier otra consulta normalmente.'
      );
    }
  }

  if (runtimeCtx?.needsHuman) {
    dynamicLines.push('\nATENCIÓN: Ya avisaste al equipo del negocio sobre esta conversación. Seguí respondiendo lo que puedas con la información disponible. Si el cliente pregunta por la consulta que requería atención humana, recordale brevemente que ya avisaste y que alguien del equipo se va a comunicar. NO vuelvas a emitir [NEEDS_HUMAN] — ya está registrado.');
  }

  return { staticText: staticLines.join('\n'), dynamicText: dynamicLines.join('\n') };
}

async function generateReply(business, history, newMessage, label = null, bookingContext = null, runtimeCtx = null) {
  const { staticText, dynamicText } = buildSystemPrompt(business, label, bookingContext, runtimeCtx);

  // Build system blocks: static part is marked for caching, dynamic part is always fresh.
  // Anthropic caches everything up to and including the block with cache_control.
  const systemBlocks = [
    { type: 'text', text: staticText, cache_control: { type: 'ephemeral' } },
  ];
  if (dynamicText) {
    systemBlocks.push({ type: 'text', text: dynamicText });
  }

  const messages = [
    ...history.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    })),
    { role: 'user', content: newMessage },
  ];

  let response;
  try {
    response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemBlocks,
      messages,
    });
  } catch (err) {
    console.error('[claude] generateReply error:', err?.status ?? 'no-status', err?.message, err?.stack?.split('\n')[1]);
    const friendly = new Error('El asistente no está disponible en este momento. Intentá de nuevo en unos segundos.');
    friendly.cause = err;
    throw friendly;
  }

  const u = response.usage;
  console.log(
    `[claude:cache] biz=${business.id} in=${u.input_tokens} out=${u.output_tokens}` +
    ` cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}`
  );

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

  const response = await getClient().messages.create({
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
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Resumí en 2-3 líneas qué hace o vende este negocio, basándote en el texto extraído de su sitio web. Solo el resumen, sin introducción:\n\n${text.slice(0, 4000)}`,
    }],
  });
  return response.content[0].text.trim();
}

module.exports = { initAnthropicKey, generateReply, analyzeStyle, summarizeWebsite };
