const { upsertBusiness, getBusinessByWhatsappNumber } = require('../src/db');

const business = upsertBusiness({
  name: 'Clínica Dental Prueba',
  whatsapp_number: '1289706364217205',
  sales_examples: [
    '¡Hola! Gracias por escribirnos 😊 En Clínica Dental Prueba tenemos todo lo que necesitás para tu sonrisa. ¿En qué te puedo ayudar hoy?',
    'Nuestras limpiezas dentales quedan desde $1.200. Incluyen revisación completa y radiografía si es necesario. ¿Querés que te agendemos?',
    '¡Claro que sí! Los blanqueamientos los hacemos con tecnología LED y el resultado dura hasta 2 años. Muchos pacientes quedan encantados 🦷✨ ¿Te gustaría saber el precio?',
    'Entiendo tu consulta. Nuestros turnos de urgencia los atendemos el mismo día si llamás antes de las 10am. ¿Tenés mucho dolor?',
    'Perfecto, te agendo para el miércoles a las 15hs con el Dr. Ramírez. Te mandamos un recordatorio el día anterior. ¡Nos vemos!',
  ],
  survey_answers: {
    tipo_negocio: 'Clínica odontológica',
    ubicacion: 'Buenos Aires, Argentina',
    servicios: 'Limpiezas, blanqueamiento, ortodoncia, implantes, urgencias',
    publico_objetivo: 'Familias y adultos que buscan atención dental de calidad a buen precio',
    tono: 'Cálido, profesional, cercano. Usamos emojis con moderación.',
    horario: 'Lunes a viernes 9-19hs, sábados 9-13hs',
  },
  response_mode: 'texto',
});

console.log('Negocio cargado:');
console.log(JSON.stringify(business, null, 2));

// Verificar lookup por phone_number_id
const found = getBusinessByWhatsappNumber('1289706364217205');
console.log('\nLookup por phone_number_id:', found ? '✓ OK' : '✗ NO ENCONTRADO');
