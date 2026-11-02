/**
 * Real-model test for split-message feature.
 * Runs 10 conversations of 3+ turns with mensajes_separados=true.
 * Reports: how often "|||" is used, whether it stops mid-conversation, bad splits.
 *
 * Usage: node scripts/test-split-claude.js
 * Requires ANTHROPIC_API_KEY in .env
 */

require('dotenv').config();
const { generateReply } = require('../src/claude');

const business = {
  id: 99,
  name: 'Tienda Ejemplo',
  whatsapp_number: '+59899000001',
  sales_examples: [
    'Hola, estamos para ayudarte. Tenemos variedades de productos a precios muy accesibles.',
    'Enviamos a todo el país. El envío gratis aplica en compras mayores a $1.500.',
    'Nuestro horario es lunes a viernes de 9 a 18 hs, sábados de 9 a 13.',
  ],
  survey_answers: {
    direccion: 'Rivera 1234 esq. Yaguarón, Montevideo',
    telefono: '099 555 333',
    email: 'ventas@tiendaejemplo.com.uy',
    envio: 'Gratis en compras sobre $1.500',
    precios: 'Remeras desde $650, pantalones desde $1.200, buzos desde $1.800',
    horario: 'Lunes a viernes 9-18, sábados 9-13',
  },
  style_profile: {
    tono: 'amigable',
    uso_emojis: 'moderado',
    largo_mensajes: 'medio',
    forma_de_cerrar: 'cordial',
    caracteristicas: [],
    mensajes_separados: true,
  },
  response_mode: 'texto',
  business_context: 'Tienda de ropa y accesorios en Montevideo.',
  owner_rules: null,
};

const conversations = [
  {
    label: 'Consulta precio + lista de productos',
    turns: [
      '¿Cuánto salen las remeras?',
      '¿Y los buzos? ¿Tienen talles grandes?',
      'Perfecto, ¿cómo hago para comprar? ¿Tienen local físico?',
    ],
  },
  {
    label: 'Envío + dirección + teléfono',
    turns: [
      '¿Hacen envíos a Canelones?',
      '¿Cuánto cuesta el envío?',
      '¿Me podés dar el teléfono y dirección del local?',
    ],
  },
  {
    label: 'Horarios y consulta general',
    turns: [
      '¿A qué hora abren los sábados?',
      '¿Y los domingos?',
      'Gracias, una última consulta: ¿aceptan tarjeta de crédito?',
    ],
  },
  {
    label: 'Consulta sobre URL / web',
    turns: [
      '¿Tienen página web para ver los productos?',
      'Ah buenísimo, ¿puedo pagar online?',
      '¿El pago con tarjeta tiene recargo?',
    ],
  },
  {
    label: 'Lista de productos disponibles',
    turns: [
      '¿Qué productos tienen disponibles?',
      '¿Y de damas también?',
      '¿Me podés dar precios de todo?',
    ],
  },
  {
    label: 'Conversación corta que no requiere split',
    turns: [
      'Hola',
      'Gracias',
      '👍',
    ],
  },
  {
    label: 'Consulta técnica larga',
    turns: [
      '¿Tienen política de cambios y devoluciones? ¿Cómo funciona?',
      '¿Y si el producto viene con fallas de fábrica?',
      '¿Cuánto tiempo tengo para reclamar?',
    ],
  },
  {
    label: 'Pedido con dirección completa',
    turns: [
      'Quiero hacer un pedido. ¿A qué dirección me lo mandan?',
      'Mi dirección es Bulevar Artigas 2345 apto 304, Montevideo',
      '¿Cuándo llega?',
    ],
  },
  {
    label: 'Múltiples preguntas en un turno',
    turns: [
      '¿Tienen remeras? ¿Y pantalones? ¿Qué precio tienen? ¿Tienen en talle L?',
      '¿Pueden enviar mañana?',
      '¿Aceptan Mercado Pago?',
    ],
  },
  {
    label: 'Seguimiento de conversación previa',
    turns: [
      'Ayer hablamos sobre una remera azul, ¿la reservaron para mí?',
      '¿Cuánto me sale con envío incluido?',
      'Perfecto, ¿me podés confirmar el precio total y la dirección de envío que tienen?',
    ],
  },
];

const SEPARATOR = '|||';
const BAD_SPLIT_PATTERNS = [
  // Price mid-number
  /\$[\d.,]+\s*\|\|\||\|\|\|\s*[\d.,]+/,
  // URL mid-split
  /https?:\/\/[^\s]*\|\|\||\/\/\|\|\|/i,
  // Phone mid-split
  /\d{3}\s*\|\|\||\|\|\|\s*\d{3}/,
  // Address number split
  /\d+,?\s*\|\|\||\|\|\|\s*[a-z]{2,}/i,
];

async function runConversation(conv) {
  const history = [];
  const results = [];
  const runtimeCtx = { now: new Date(Date.now() - 3 * 60 * 60 * 1000), needsHuman: false, images: [], documents: [] };

  for (const userMsg of conv.turns) {
    const rawReply = await generateReply(business, history, userMsg, null, null, runtimeCtx);
    const hasSeparator = rawReply.includes(SEPARATOR);
    const badSplit = BAD_SPLIT_PATTERNS.some(re => re.test(rawReply));
    const parts = hasSeparator ? rawReply.split(SEPARATOR).map(p => p.trim()).filter(Boolean) : [rawReply];

    results.push({
      user: userMsg,
      rawReply,
      hasSeparator,
      partCount: parts.length,
      badSplit,
    });

    history.push({ role: 'user', content: userMsg });
    history.push({ role: 'assistant', content: rawReply });
  }
  return results;
}

async function main() {
  console.log('=== Split-message real-model test ===\n');
  console.log(`Conversations: ${conversations.length}, turns per conv: 3+`);
  console.log(`Model: claude-sonnet-4-6, mensajes_separados: true\n`);

  let totalTurns = 0;
  let turnsWithSplit = 0;
  let badSplits = 0;
  const allResults = [];

  for (const conv of conversations) {
    console.log(`\n── ${conv.label} ──`);
    let results;
    try {
      results = await runConversation(conv);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      continue;
    }

    for (const r of results) {
      totalTurns++;
      if (r.hasSeparator) turnsWithSplit++;
      if (r.badSplit) badSplits++;
      allResults.push({ conv: conv.label, ...r });

      const flag = r.badSplit ? ' ⚠️ BAD SPLIT' : '';
      const parts = r.hasSeparator ? ` (${r.partCount} parts)` : '';
      console.log(`  User: "${r.user.slice(0, 60)}"`);
      console.log(`  Bot: ${r.hasSeparator ? '[SPLIT]' : '[SINGLE]'}${parts}${flag}`);
      if (r.hasSeparator) {
        r.rawReply.split(SEPARATOR).map((p, i) => p.trim()).filter(Boolean).forEach((p, i) => {
          console.log(`    Part ${i + 1}: "${p.slice(0, 80)}${p.length > 80 ? '...' : ''}"`);
        });
      } else {
        console.log(`  "${r.rawReply.slice(0, 100)}${r.rawReply.length > 100 ? '...' : ''}"`);
      }
      console.log();
    }
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Total turns:         ${totalTurns}`);
  console.log(`Turns with "|||":    ${turnsWithSplit} (${Math.round(turnsWithSplit / totalTurns * 100)}%)`);
  console.log(`Bad splits detected: ${badSplits}`);
  console.log();

  if (badSplits > 0) {
    console.log('⚠️  BAD SPLITS:');
    allResults.filter(r => r.badSplit).forEach(r => {
      console.log(`  [${r.conv}] "${r.user}"`);
      console.log(`  Raw: ${r.rawReply}`);
    });
  }

  if (badSplits === 0) {
    console.log('✓ No bad splits detected (prices, addresses, phones, URLs all intact).');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
