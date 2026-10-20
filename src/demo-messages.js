'use strict';

// NOTE: followUp and blockedUrl appear truncated in the source spec — implemented verbatim.
const MSG = {
  askForUrl:
    '¡Hola! 👋 Te armo una demo de cómo atendería Daxos el WhatsApp de tu negocio, con tus datos reales.\n\nPasame el link de tu web y en menos de 1 minuto te la mando.',

  generating:
    'Recibido ✅ Estoy leyendo tu web y armando la demo. Dame menos de 1 minuto.',

  // {nombre} and {link} are template variables
  delivery: (nombre, link) =>
    `Lista tu demo de *${nombre}* 👇\n${link}\n\nProbala como si fueras un cliente: preguntale precios, horarios, lo que quieras.\n\nEs una simulación con lo que encontré en tu web, no está conectada a tu WhatsApp. Si algún dato está mal, lo podés corregir ahí mismo.\n\nSi te gusta, se prueba 14 días gratis, sin tarjeta: daxos.lat`,

  invalidUrl:
    'Para armarla necesito el link de tu web (por ejemplo, https://minegocio.com.uy). Si no tenés web, escribime "no tengo" y me pasás los datos por acá.',

  // NOTE: source spec for blockedUrl appears truncated after "https://minegocio." — implemented verbatim
  blockedUrl:
    'No pude abrir ese link. Revisá que sea la dirección de tu web (por ejemplo, https://minegocio.no tengo" y me pasás los datos por acá.',

  socialMedia:
    'Las redes sociales me bloquean la lectura. ¿Tenés una web? Si no, pegame acá lo que publicás: servicios, horarios, dirección y precios.',

  // Used for: jsOnly, scrape error, "no tengo" trigger, general read failure
  needsText:
    'No pude leer bien tu web (pasa con algunas páginas). Sin drama: pegame acá, en un solo mensaje, tus servicios o productos, horarios, dirección y precios si los tenés, y te armo la demo igual.',

  generationTimeout:
    'Se está demorando más de lo normal. Para no hacerte esperar: pegame acá tus servicios, horarios y precios, y te la armo con eso.',

  generationError:
    'No pude leer bien tu web (pasa con algunas páginas). Sin drama: pegame acá, en un solo mensaje, tus servicios o productos, horarios, dirección y precios si los tenés, y te armo la demo igual.',

  rateLimitPhone:
    'Ya armé varias demos desde este número hoy. Escribime mañana y seguimos. Si es urgente, decime y lo vemos.',

  rateLimitGlobal:
    'Ya armé varias demos desde este número hoy. Escribime mañana y seguimos. Si es urgente, decime y lo vemos.',

  textTooShort:
    'Necesito un poco más: contame qué servicios o productos ofrecen, horarios, dirección y precios si los tenés.',

  // NOTE: source spec for followUp appears truncated after "con t" — implemented verbatim
  followUp:
    '¿Pudiste probar la demo? Si te quedó alguna duda o querés ver cómo quedaría con tlo vemos.',

  chatLimitReached:
    'Llegaste al límite de mensajes de esta demo. Para seguir, activá tu plan en daxos.lat',
};

module.exports = { MSG };
