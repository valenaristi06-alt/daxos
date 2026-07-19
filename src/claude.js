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

module.exports = { generateReply };
