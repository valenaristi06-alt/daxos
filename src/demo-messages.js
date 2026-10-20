'use strict';

const MSG = {
  // Demo flow – WhatsApp messages
  askForUrl:
    '¡Hola! Para generar tu demo personalizado, enviame la URL de tu sitio web (ej: https://tuempresa.com).',

  generating:
    '⏳ Generando tu demo... esto tarda unos segundos.',

  generationTimeout:
    'Tardó más de lo esperado. Intentalo de nuevo en unos minutos.',

  generationError:
    'No pude generar el demo en este momento. Intentalo de nuevo más tarde.',

  invalidUrl:
    'La URL no parece válida. Enviame una dirección completa, por ejemplo: https://tuempresa.com',

  blockedUrl:
    'No puedo acceder a esa URL. Probá con otra dirección pública.',

  jsOnly:
    'El sitio requiere JavaScript para cargar contenido y no pude extraer información. Probá con otra URL o contactanos para ayudarte.',

  rateLimitIp:
    'Ya generaste varios demos hoy desde esta conexión. Volvé mañana.',

  rateLimitPhone:
    'Ya generaste varios demos hoy desde este número. Volvé mañana.',

  rateLimitGlobal:
    'Muchas demos generadas hoy. Intentalo de nuevo mañana.',

  existingClient:
    null, // silently skip — existing clients handled by normal assistant

  demoReady: (url) =>
    `¡Tu demo está listo! 🎉\n\nPodés verlo acá: ${url}\n\nTambién podés chatear con él directamente por acá si querés probarlo.`,

  followUp:
    '¿Pudiste ver tu demo? Si tenés dudas o querés activar Daxos para tu negocio, avisame 🚀',

  // Demo chat – when user messages demo via WhatsApp after receiving link
  chatError:
    'Ocurrió un error al procesar tu mensaje. Intentá de nuevo.',

  chatLimitReached:
    'Llegaste al límite de mensajes de esta demo. Para seguir, activá tu plan en daxos.ai',
};

module.exports = { MSG };
