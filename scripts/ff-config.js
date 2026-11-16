// Rutas de herramientas del proyecto (ffmpeg empaquetado + Poppins desde npm).
const path = require('path');
const root = path.join(__dirname, '..');

function tryResolve(mod, fallback) {
  try { return require(mod); } catch (e) { return fallback; }
}

const FFMPEG = tryResolve('ffmpeg-static', path.join(root, 'node_modules/ffmpeg-static/ffmpeg'));
const fontDir = path.join(root, 'node_modules/@expo-google-fonts/poppins');

module.exports = {
  FFMPEG,
  FONT_BLACK: path.join(fontDir, '900Black/Poppins_900Black.ttf'),
  FONT_EXTRABOLD: path.join(fontDir, '800ExtraBold/Poppins_800ExtraBold.ttf'),
  FONT_BOLD: path.join(fontDir, '700Bold/Poppins_700Bold.ttf'),
  FONT_SEMIBOLD: path.join(fontDir, '600SemiBold/Poppins_600SemiBold.ttf'),
  // paleta de marca
  PLUM: '0x4a2a4f', ACC: '0xc2456a', SOFT: '0xfbe9ee', INK: '0x1d1520',
  // zona segura de Reels (alto)
  SAFE_TOP: 280, SAFE_BOT: 1250,
};
