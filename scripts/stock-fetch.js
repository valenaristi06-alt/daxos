// Busca y descarga videos de Pixabay para los anuncios de Método Hana.
// Lee PIXABAY_API_KEY de .env (no la imprime). Descarga candidatos + extrae un frame
// (con ffmpeg) de cada uno a motor-anuncios/stock/_candidatos/ para curar a mano los finales.
// Prefiere verticales; los horizontales se recortan al centro a 9:16 en build-ads (norm()).
// Uso: node scripts/stock-fetch.js
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const C = require('./ff-config');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'motor-anuncios', 'stock');
const CAND = path.join(OUT, '_candidatos');
fs.mkdirSync(CAND, { recursive: true });

// --- leer key sin imprimirla ---
function readKey() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) { console.error('FALTA .env con PIXABAY_API_KEY'); process.exit(1); }
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('PIXABAY_API_KEY'));
  if (!line) { console.error('FALTA PIXABAY_API_KEY en .env'); process.exit(1); }
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
}
const KEY = readKey();

const QUERIES = [
  'woman exercise home',
  'mature woman fitness',
  'woman stretching mat',
  'senior woman exercise',
  'woman squat living room',
  'woman yoga home',
  'woman workout 50',
];

const MAX_PER_QUERY = 8; // candidatos a bajar por query (de los 50 que devuelve la API)

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return res(get(r.headers.location)); }
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
const ff = (args) => execFileSync(C.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

// elige el mejor archivo: prioriza verticales, luego ~1080 de alto
function pickFile(videos) {
  const files = Object.values(videos || {}).filter(v => v && v.url && v.width && v.height);
  if (!files.length) return null;
  const vert = files.filter(f => f.height > f.width);
  const pool = vert.length ? vert : files;
  // para verticales buscamos ~1920 de alto; para horizontales ~1080 de alto (se recorta a 9:16)
  const target = vert.length ? 1920 : 1080;
  pool.sort((a, b) => Math.abs(a.height - target) - Math.abs(b.height - target));
  return pool[0];
}

(async () => {
  const creditos = [
    '# Candidatos descargados (Pixabay)',
    '',
    'Frames en _candidatos/cand-<id>.jpg para curar. Los finales van a motor-anuncios/stock/ como clip-01..NN.mp4.',
    '',
  ];
  const seen = new Set();
  let n = 0;
  for (const q of QUERIES) {
    const url = `https://pixabay.com/api/videos/?key=${KEY}&q=${encodeURIComponent(q)}&per_page=50&safesearch=true`;
    const { status, buf } = await get(url);
    if (status !== 200) { console.error('query falló:', q, status); continue; }
    let data;
    try { data = JSON.parse(buf.toString()); } catch (e) { console.error('JSON inválido para', q); continue; }
    let took = 0;
    for (const v of (data.hits || [])) {
      if (took >= MAX_PER_QUERY) break;
      if (seen.has(v.id)) continue; seen.add(v.id);
      const file = pickFile(v.videos);
      if (!file) continue;
      took++; n++;
      const id = String(v.id);
      const clip = path.join(CAND, `cand-${id}.mp4`);
      const frame = path.join(CAND, `cand-${id}.jpg`);
      try {
        await download(file.url, clip);
        // frame de muestra a ~1s, escalado a 360 de ancho para curar liviano
        ff(['-ss', '1', '-i', clip, '-frames:v', '1', '-vf', 'scale=360:-2', frame]);
        const orient = file.height > file.width ? 'V' : 'H';
        creditos.push(`- cand-${id}: ${v.user || 'autor'} · https://pixabay.com/videos/?id=${v.id} · "${q}" · ${file.width}x${file.height} ${orient}`);
        console.log('ok', id, q, file.width + 'x' + file.height, orient);
      } catch (e) { console.error('fallo', id, e.message); }
    }
  }
  fs.writeFileSync(path.join(CAND, 'creditos.md'), creditos.join('\n'));
  console.log(`\n${n} candidatos en ${CAND}. Revisá los frames cand-*.jpg, quedate con los mejores y copialos a motor-anuncios/stock/ como clip-01..NN.mp4.`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
