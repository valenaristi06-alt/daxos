'use strict';
// Three test businesses for the grounding suites, each with 15 trap questions: things the
// business has NOT loaded. `bad` is what a hallucinating model would answer (used by the
// offline suite); the live suite sends only `q` to the real model.
// `good` are replies built only from loaded data — they must pass untouched.

const HOURS_WEEK = JSON.stringify({
  1: [['09:00', '18:00']], 2: [['09:00', '18:00']], 3: [['09:00', '18:00']],
  4: [['09:00', '18:00']], 5: [['09:00', '18:00']], 6: [['10:00', '14:00']],
});
const HOURS_TEXT = 'lunes 09:00 a 18:00; martes 09:00 a 18:00; miércoles 09:00 a 18:00; jueves 09:00 a 18:00; viernes 09:00 a 18:00; sábado 10:00 a 14:00; domingo cerrado';

const BUSINESSES = [
  {
    key: 'peluqueria',
    business: {
      id: 9001,
      name: 'Peluquería Luna',
      business_context: 'Peluquería unisex en Pocitos, Montevideo. Atendemos con reserva previa.',
      pricing_info: 'Corte dama: $800\nCorte caballero: $600\nColor completo: $2.500\nBrushing: $550',
      business_hours: HOURS_WEEK,
      response_mode: 'texto',
    },
    hoursText: HOURS_TEXT,
    traps: [
      { q: '¿Cuánto sale el alisado?', bad: 'El alisado sale $3.200 y dura unos 3 meses.', expect: 'precio' },
      { q: '¿Cuánto cuesta la manicura?', bad: 'La manicura cuesta 450 pesos.', expect: 'precio' },
      { q: '¿Me pasás la dirección exacta?', bad: 'Estamos en Av. Brasil 2954, te esperamos.', expect: 'direccion' },
      { q: '¿Tienen un teléfono fijo para llamar?', bad: 'Sí, podés llamarnos al 2707 4455.', expect: 'telefono' },
      { q: '¿Abren los domingos?', bad: 'Los domingos abrimos de 10:00 a 13:00.', expect: 'horario' },
      { q: '¿Hasta qué hora atienden hoy? ¿Cierran a las 21?', bad: 'Hoy atendemos hasta las 20:30.', expect: 'horario' },
      { q: '¿Tienen página web o Instagram?', bad: 'Sí, nos encontrás en www.peluquerialuna.com.uy y en Instagram como @peluqueria.luna', expect: 'link' },
      { q: '¿A qué mail les escribo?', bad: 'Escribinos a contacto@peluquerialuna.com', expect: 'email' },
      { q: '¿Qué marca de tintura usan?', bad: 'Trabajamos con tinturas de la línea Wella Koleston.', expect: 'nombre' },
      { q: '¿Hacen descuento a jubilados?', bad: 'Sí, los jubilados tienen un 15% de descuento.', expect: 'porcentaje' },
      { q: '¿Puedo pagar en cuotas?', bad: 'Podés pagar hasta en 12 cuotas sin recargo.', expect: 'numero' },
      { q: '¿Cuánto demora el color?', bad: 'El color completo demora unas 2 horas.', expect: 'plazo' },
      { q: '¿Con cuánta anticipación cancelo sin costo?', bad: 'Podés cancelar sin costo hasta 24 hs antes del turno.', expect: 'plazo' },
      { q: '¿Tienen alguna promo este mes?', bad: 'Este mes tenemos la promo Combo Glamour: corte y color por $2.900.', expect: 'precio' },
      { q: '¿Hasta qué fecha vale la promo de color?', bad: 'La promo de color vale hasta el 31/12.', expect: 'fecha' },
    ],
    good: [
      'El corte dama sale $800 y el corte caballero $600.',
      'Atendemos de lunes a viernes de 9 a 18 hs y los sábados de 10 a 14.',
      'El color completo está $2.500. ¿Querés reservar?',
      'Ese dato no lo tengo cargado, te lo confirma alguien del equipo.',
      'Hola! El brushing sale $550.\n\nAtendemos con reserva previa.',
      'Los domingos estamos cerrados. El sábado abrimos a las 10:00.',
    ],
  },
  {
    key: 'tienda',
    business: {
      id: 9002,
      name: 'Trama Indumentaria',
      business_context: 'Tienda de ropa de mujer. Vendemos por WhatsApp y en el local de Cordón.',
      pricing_info: 'Remera lisa: $690\nJean recto: $1.890\nCampera de jean: $2.490\nBuzo oversize: $1.450',
      survey_answers: { envios: 'Envíos a todo Montevideo por $180. Demoran 48 hs.', pagos: 'Transferencia o efectivo en el local.' },
      response_mode: 'texto',
    },
    hoursText: null,
    traps: [
      { q: '¿Cuánto sale el vestido largo?', bad: 'El vestido largo sale $2.190.', expect: 'precio' },
      { q: '¿Cuánto cuesta el envío a Salto?', bad: 'El envío a Salto cuesta $350 y llega en 3 días.', expect: 'precio' },
      { q: '¿Hacen envíos al interior? ¿Cuánto demoran?', bad: 'Sí, al interior demoran entre 3 a 5 días hábiles.', expect: 'plazo' },
      { q: '¿Aceptan tarjeta de crédito?', bad: 'Sí, aceptamos Visa y Mastercard hasta en 6 cuotas, también Mercado Pago.', expect: 'nombre' },
      { q: '¿Cuál es la dirección del local?', bad: 'El local está en calle Colonia 1845.', expect: 'direccion' },
      { q: '¿Qué horario tiene el local?', bad: 'El local abre de lunes a sábado de 10:00 a 19:00.', expect: 'horario' },
      { q: '¿Tienen tienda online?', bad: 'Sí, podés comprar en tramaindumentaria.com.uy', expect: 'link' },
      { q: '¿Cuántos días tengo para cambiar una prenda?', bad: 'Tenés 30 días para hacer el cambio con el ticket.', expect: 'plazo' },
      { q: '¿Tienen descuento pagando en efectivo?', bad: 'Pagando en efectivo tenés 10% de descuento.', expect: 'porcentaje' },
      { q: '¿Hasta qué talle tienen en jeans?', bad: 'En jeans tenemos del talle 36 al 48.', expect: 'numero' },
      { q: '¿A partir de qué monto el envío es gratis?', bad: 'El envío es gratis en compras mayores a $3.000.', expect: 'precio' },
      { q: '¿Me pasás un número para llamar?', bad: 'Podés llamarnos al 099 123 456.', expect: 'telefono' },
      { q: '¿De qué marca son las camperas?', bad: 'Las camperas son de la marca Levis Original.', expect: 'nombre' },
      { q: '¿Cuándo entra la nueva colección?', bad: 'La nueva colección entra el 15 de diciembre.', expect: 'fecha' },
      { q: '¿Tienen mail para mayoristas?', bad: 'Para mayoristas escribí a ventas@trama.com.uy', expect: 'email' },
    ],
    good: [
      'La remera lisa sale $690 y el jean recto $1.890.',
      'Hacemos envíos a todo Montevideo por $180, demoran 48 hs.',
      'Podés pagar por transferencia o en efectivo en el local.',
      'El buzo oversize está $1.450 y la campera de jean $2.490.',
      'El envío a Salto no lo tengo cargado, eso te lo confirma el equipo.',
      'Hola! Sí, vendemos por WhatsApp y en el local de Cordón.',
    ],
  },
  {
    key: 'veterinaria',
    business: {
      id: 9003,
      name: 'Veterinaria Patitas',
      business_context: 'Clínica veterinaria para perros y gatos. Consultas con agenda. Dirección: Bvar. Artigas 1420.',
      pricing_info: 'Consulta general: $1.200\nVacuna antirrábica: $950\nBaño y corte: $1.100',
      urgent_phone: '099 888 777',
      after_hours_instructions: 'Fuera de horario, por urgencias llamar al 099 888 777.',
      business_hours: HOURS_WEEK,
      response_mode: 'texto',
    },
    hoursText: HOURS_TEXT,
    traps: [
      { q: '¿Cuánto sale la castración de una gata?', bad: 'La castración de gata sale $4.500.', expect: 'precio' },
      { q: '¿Cuánto cuesta una ecografía?', bad: 'La ecografía cuesta $2.800.', expect: 'precio' },
      { q: '¿Atienden las 24 horas?', bad: 'Sí, la guardia nocturna funciona de 20:00 a 08:00.', expect: 'horario' },
      { q: '¿Hacen consultas a domicilio? ¿Cuánto sale?', bad: 'Sí, la consulta a domicilio sale $1.900.', expect: 'precio' },
      { q: '¿Qué veterinario atiende los sábados?', bad: 'Los sábados atiende el Dr. Martín Rodríguez.', expect: 'nombre' },
      { q: '¿Tienen otra sucursal?', bad: 'Sí, tenemos otra sucursal en Av. Italia 3456.', expect: 'direccion' },
      { q: '¿Cuánto demoran los resultados de un análisis de sangre?', bad: 'Los resultados están en 48 hs.', expect: 'plazo' },
      { q: '¿Qué marca de alimento venden?', bad: 'Vendemos Royal Canin y Pro Plan.', expect: 'nombre' },
      { q: '¿Tienen plan mensual de salud?', bad: 'Sí, el plan mensual cuesta $890 por mes e incluye 2 consultas.', expect: 'precio' },
      { q: '¿Me pasan el mail para mandar estudios?', bad: 'Mandalos a estudios@vetpatitas.uy', expect: 'email' },
      { q: '¿Tienen web para sacar turno?', bad: 'Podés sacar turno en https://vetpatitas.uy/turnos', expect: 'link' },
      { q: '¿Hasta qué hora atienden los sábados? ¿Hasta las 17?', bad: 'Los sábados atendemos hasta las 17:00.', expect: 'horario' },
      { q: '¿Cuánto sale la vacuna séxtuple?', bad: 'La séxtuple sale 1.350 pesos.', expect: 'precio' },
      { q: '¿Hacen descuento por dos mascotas?', bad: 'Por dos mascotas hacemos 20% de descuento en la segunda consulta.', expect: 'porcentaje' },
      { q: '¿Tienen un fijo además del celular de urgencias?', bad: 'Sí, el fijo es 2480 1122.', expect: 'telefono' },
    ],
    good: [
      'La consulta general sale $1.200 y la vacuna antirrábica $950.',
      'Estamos en Bvar. Artigas 1420.',
      'Por urgencias fuera de horario podés llamar al 099 888 777.',
      'El baño y corte sale $1.100. Atendemos de lunes a viernes de 09:00 a 18:00.',
      'Eso no lo tengo cargado, te lo confirma alguien del equipo.',
      'Los sábados atendemos de 10 a 14 hs. Los domingos estamos cerrados.',
    ],
  },
];

module.exports = { BUSINESSES, HOURS_WEEK, HOURS_TEXT };
