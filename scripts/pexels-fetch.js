// Busca y descarga videos VERTICALES de Pexels para los anuncios de Método Hana.
// Lee PEXELS_API_KEY de .env (no la imprime). Descarga candidatos + un thumbnail de cada uno
// a motor-anuncios/stock/_candidatos/ para curar a mano los 12 finales.
// Uso: node scripts/pexels-fetch.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'motor-anuncios', 'stock');
const CAND = path.join(OUT, '_candidatos');
fs.mkdirSync(CAND, { recursive: true });

// --- leer key sin imprimirla ---
function readKey() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) { console.error('FALTA .env con PEXELS_API_KEY'); process.exit(1); }
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('PEXELS_API_KEY'));
  if (!line) { console.error('FALTA PEXELS_API_KEY en .env'); process.exit(1); }
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
}
const KEY = readKey();

const QUERIES = [
  'mature woman squat home',
  'woman 50 exercise living room',
  'older woman stretching mat',
  'woman glute bridge',
  'senior woman wall push up',
  'woman yoga mat home',
];

function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return res(get(r.headers.location, headers)); }
      let d = []; r.on('data', c => d.push(c)); r.on('end', () => res({ status: r.statusCode, buf: Buffer.concat(d) }));
    }).on('error', rej);
  });
}
function download(url, dest) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(dest);
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); f.close(); return res(download(r.headers.location, dest)); }
      r.pipe(f); f.on('finish', () => f.close(() => res()));
    }).on('error', e => { fs.rmSync(dest, { force: true }); rej(e); });
  });
}

(async () => {
  const creditos = ['# Créditos de los videos (Pexels)', '', 'Candidatos descargados para curar. Dejá en motor-anuncios/stock/ solo los 12 finales.', ''];
  const seen = new Set();
  let n = 0;
  for (const q of QUERIES) {
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&size=medium&per_page=8`;
    const { status, buf } = await get(url, { Authorization: KEY });
    if (status !== 200) { console.error('query falló:', q, status); continue; }
    const data = JSON.parse(buf.toString());
    for (const v of (data.videos || [])) {
      if (seen.has(v.id)) continue; seen.add(v.id);
      // elegir un archivo vertical de ~1080 de alto
      const files = (v.video_files || []).filter(f => f.height > f.width);
      files.sort((a, b) => Math.abs((a.height || 0) - 1920) - Math.abs((b.height || 0) - 1920));
      const file = files[0];
      if (!file) continue;
      n++;
      const id = String(v.id);
      const clip = path.join(CAND, `cand-${id}.mp4`);
      const thumb = path.join(CAND, `cand-${id}.jpg`);
      try {
        await download(file.link, clip);
        if (v.image) await download(v.image, thumb);
        creditos.push(`- cand-${id}: ${v.user && v.user.name || 'autor'} · ${v.url} · query "${q}" · ${file.width}x${file.height}`);
        console.log('ok', id, q, file.width + 'x' + file.height);
      } catch (e) { console.error('fallo descarga', id, e.message); }
    }
  }
  fs.writeFileSync(path.join(CAND, 'creditos.md'), creditos.join('\n'));
  console.log(`\n${n} candidatos en ${CAND}. Revisá los thumbnails, quedate con 12 y movelos a motor-anuncios/stock/ como clip-01..12.mp4.`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
