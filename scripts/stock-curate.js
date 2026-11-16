// Copia los clips curados de _candidatos/ a motor-anuncios/stock/ como clip-NN.mp4
// y escribe anuncios/creditos.md con autor + URL real (consulta API de Pixabay por id).
// Uso: node scripts/stock-curate.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const CAND = path.join(ROOT, 'motor-anuncios', 'stock', '_candidatos');
const STOCK = path.join(ROOT, 'motor-anuncios', 'stock');
const ADS = path.join(ROOT, 'anuncios');

function readKey() {
  const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').find(l => l.startsWith('PIXABAY_API_KEY'));
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
}
const KEY = readKey();

// ids curados, en orden de clip-01..NN (ver notas abajo)
const CHOSEN = [
  { id: '293082', note: 'mujer, yoga brazos arriba, sala luminosa, mat' },
  { id: '124251', note: 'mujer meditando, sala luminosa en casa' },
  { id: '293085', note: 'mujer ropa deportiva normal, en casa' },
  { id: '222279', note: 'mujer yoga/meditación frente a cámara, interior' },
  { id: '311688', note: 'mujer meditando con velas, interior cálido' },
  { id: '51784',  note: 'dos mujeres yoga en galería de casa' },
  { id: '32937',  note: 'grupo adultos mayores, tai chi en salón (calistenia asiática)' },
  { id: '129423', note: 'mujer tai chi ropa blanca (asiática)' },
  { id: '32934',  note: 'mujer ejercicio al aire libre, parque' },
  { id: '293079', note: 'clase de yoga, varias mujeres' },
  { id: '44098',  note: 'grupo mayores ejercicio suave al aire libre' },
];

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = []; r.on('data', c => d.push(c)); r.on('end', () => res({ status: r.statusCode, buf: Buffer.concat(d) }));
    }).on('error', rej);
  });
}

(async () => {
  const cred = [
    '# Créditos de los clips (Pixabay)',
    '',
    'Todos los clips son de Pixabay (licencia libre, sin atribución obligatoria; igual la dejamos).',
    '',
    '| Clip | Autor | URL |',
    '|---|---|---|',
  ];
  let i = 0;
  for (const { id, note } of CHOSEN) {
    i++;
    const src = path.join(CAND, `cand-${id}.mp4`);
    const dst = path.join(STOCK, `clip-${String(i).padStart(2, '0')}.mp4`);
    if (!fs.existsSync(src)) { console.error('FALTA', src); continue; }
    fs.copyFileSync(src, dst);
    // datos reales del autor + pageURL
    let user = 'Pixabay', page = `https://pixabay.com/videos/`;
    try {
      const { status, buf } = await get(`https://pixabay.com/api/videos/?key=${KEY}&id=${id}`);
      if (status === 200) {
        const h = (JSON.parse(buf.toString()).hits || [])[0];
        if (h) { user = h.user || user; page = h.pageURL || page; }
      }
    } catch (e) { /* deja defaults */ }
    cred.push(`| clip-${String(i).padStart(2, '0')} (${note}) | ${user} | ${page} |`);
    console.log(`clip-${String(i).padStart(2, '0')} <- cand-${id}  (${user})`);
  }
  fs.mkdirSync(ADS, { recursive: true });
  fs.writeFileSync(path.join(ADS, 'creditos.md'), cred.join('\n') + '\n');
  console.log(`\n${i} clips copiados a motor-anuncios/stock/. Créditos en anuncios/creditos.md`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
