const { generateReply } = require('../src/claude');

const business = {
  id: 1,
  name: 'Panadería El Horno',
  whatsapp_number: '+59899000001',
  sales_examples: [
    '¡Hola! Tenemos medialunas recién salidas del horno, ¿te mandamos una docena?',
    'Claro que sí, el pan integral lo hacemos todos los días desde las 7am. ¡Es riquísimo!',
    'Hacemos envíos a todo Montevideo de lunes a sábado. ¡Pedí ahora y lo tenés en 2 horas!',
  ],
  survey_answers: {
    horario: 'Lunes a sábado de 7am a 8pm, domingo de 8am a 1pm',
    delivery: 'Sí, envíos gratis en compras mayores a $500',
    especialidades: 'Medialunas, pan integral, chipá, facturas',
  },
  response_mode: 'texto',
};

const history = [];

const newMessage = '¿Tienen chipá? ¿Cuánto sale la docena?';

async function main() {
  console.log('Business:', business.name);
  console.log('Customer asks:', newMessage);
  console.log('\nGenerating reply...\n');

  try {
    const reply = await generateReply(business, history, newMessage);
    console.log('Reply:', reply);

    console.log('\n--- Second turn (with history) ---');
    const history2 = [{ role: 'user', content: newMessage }, { role: 'assistant', content: reply }];
    const followup = '¿Hacen envíos los domingos?';
    console.log('Customer asks:', followup);
    const reply2 = await generateReply(business, history2, followup);
    console.log('Reply:', reply2);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
