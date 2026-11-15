// Builds test.html (local, relative paths) and landing-store-paste.html (self-contained data URIs).
const fs = require('fs');
const path = require('path');

const block = fs.readFileSync('landing-metodo-hana.html', 'utf8');

// ---------- test.html (local preview) ----------
const test = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Método Hana — Test local</title>
<style>html,body{margin:0;padding:0;background:#efe7ea}</style>
<script>
window.fbq=function(){try{console.log("[fbq]",Array.prototype.slice.call(arguments).join(" | "));}catch(e){}};
</script>
</head>
<body>
${block.replace(/\{\{price\}\}/g, 'MX$ 399')}
</body>
</html>`;
fs.writeFileSync('test.html', test);
console.log('test.html', (Buffer.byteLength(test) / 1024).toFixed(1) + 'KB');

// ---------- landing-store-paste.html (self-contained) ----------
function dataURI(file, mime) {
  const b = fs.readFileSync(file);
  return `data:${mime};base64,${b.toString('base64')}`;
}
// only images actually referenced by the landing
const imgFiles = ['hero.webp','grupo.webp','biotipo-endo.webp','biotipo-meso.webp','biotipo-ecto.webp',
  'mov-sentadilla.webp','mov-flex.webp','app-mockup.webp'];

const assets = {};
for (const f of imgFiles) {
  if (!fs.existsSync('img/' + f)) { console.log('MISSING img/' + f); continue; }
  assets[f] = dataURI('img/' + f, 'image/webp');
}

const LIMIT = 1.5 * 1024 * 1024;
const videoURI = dataURI('video/demo.mp4', 'video/mp4');

function buildPaste(videoSrc) {
  const head = '<script>window.HANA_ASSETS=' + JSON.stringify(assets) + ';'
    + (videoSrc ? 'window.HANA_VIDEO=' + JSON.stringify(videoSrc) + ';' : '') + '</script>\n';
  return head + block;
}

// try with embedded video first
let paste = buildPaste(videoURI);
let videoMode;
if (Buffer.byteLength(paste) <= LIMIT) {
  videoMode = 'embedded';
} else {
  // too heavy: point video at a VIDEO_SRC constant the user replaces
  const note = '<!-- El video superó 1,5 MB embebido. Reemplazá VIDEO_SRC por la URL pública de demo.mp4. -->\n'
    + '<script>window.VIDEO_SRC="https://TU-CDN/demo.mp4";</script>\n';
  paste = note + buildPaste(null).replace('<script>window.HANA_ASSETS', '<script>window.HANA_VIDEO=window.VIDEO_SRC;window.HANA_ASSETS');
  videoMode = 'external (VIDEO_SRC)';
}

fs.writeFileSync('landing-store-paste.html', paste);
const kb = (Buffer.byteLength(paste) / 1024);
console.log('landing-store-paste.html', kb.toFixed(1) + 'KB', 'video=' + videoMode);
console.log('price token intact :', paste.includes('{{price}}'));
console.log('HANA25 coupon       :', paste.includes('/checkout?cupon=HANA25'));
console.log('#hana scope intact  :', paste.includes('<div id="hana">'));
console.log('no relative img left:', !/src="img\//.test(paste));
console.log('no relative vid left:', !/src="video\//.test(paste));
