'use strict';

// Fuente única de verdad del silencio del bot: switch del dueño (bot_paused) o
// silencio temporal de admin (silent_until). Puro, sin dependencias de server.js,
// para que lo pueda usar también la capa de envío (whatsapp.js) sin ciclos.

function parseSqliteUtc(s) {
  if (!s) return null;
  return new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z').getTime();
}

function isBotMuted(business) {
  if (!business) return false;
  if (business.bot_paused) return true;
  if (business.silent_until) {
    const ms = parseSqliteUtc(business.silent_until);
    if (ms && Date.now() < ms) return true;
  }
  return false;
}

module.exports = { isBotMuted, parseSqliteUtc };
