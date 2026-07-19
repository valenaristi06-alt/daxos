const { sendWhatsAppMessage } = require('../src/whatsapp');

// Número de prueba en formato E.164 (ej: +59899123456)
const TEST_NUMBER = process.argv[2];

if (!TEST_NUMBER) {
  console.error('Uso: node scripts/test-whatsapp.js +59899XXXXXX');
  process.exit(1);
}

async function main() {
  console.log(`Enviando mensaje de prueba a ${TEST_NUMBER}...`);
  try {
    const result = await sendWhatsAppMessage(
      TEST_NUMBER,
      '¡Hola! Este es un mensaje de prueba del sistema Daxos. Si lo recibiste, la integración con WhatsApp funciona correctamente.'
    );
    console.log('Enviado correctamente:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
