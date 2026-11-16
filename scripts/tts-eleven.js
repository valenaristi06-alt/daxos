// Voz en off ElevenLabs para el anuncio Reto 21 días.
// Lee ELEVENLABS_API_KEY de .env (no la imprime).
// Subcomandos:
//   node scripts/tts-eleven.js list                 -> lista voces (nombre + labels), guarda voces/voces.json
//   node scripts/tts-eleven.js samples <id1,id2,id3> -> muestras de 10s a voces/sample-<name>.mp3
//   node scripts/tts-eleven.js final <voice_id>      -> VO completa con timestamps -> voces/vo-final.mp3 + words.json
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const VOCES = path.join(ROOT, 'motor-anuncios', 'voces');
fs.mkdirSync(VOCES, { recursive: true });

function readKey() {
  const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').find(l => l.startsWith('ELEVENLABS_API_KEY'));
  if (!line) { console.error('FALTA ELEVENLABS_API_KEY en .env'); process.exit(1); }
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
}
const KEY = readKey();
const MODEL = 'eleven_multilingual_v2';

const SCRIPT = 'Amiga, deberías empezar el reto de veintiún días de calistenia asiática. Son solo quince minutos al día, desde tu sala, sin saltos y sin equipo. Haces un test de un minuto y la app arma tu plan según tu edad y cómo te sientes. Si algo te molesta, tienes una versión más fácil de cada ejercicio. Empiezas el lunes y llegas a Año Nuevo sintiéndote más fuerte. Haz el test, es gratis.';
const SAMPLE = 'Hola, soy tu guía del Método Hana. Son solo quince minutos al día, desde tu sala, sin saltos y sin equipo.';

function req(method, pathname, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request({
      hostname: 'api.elevenlabs.io', path: pathname, method,
      headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) },
    }, resp => {
      let d = []; resp.on('data', c => d.push(c)); resp.on('end', () => res({ status: resp.statusCode, buf: Buffer.concat(d) }));
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

async function list() {
  const { status, buf } = await req('GET', '/v1/voices');
  if (status !== 200) { console.error('voices falló', status, buf.toString().slice(0, 300)); process.exit(1); }
  const voices = JSON.parse(buf.toString()).voices || [];
  fs.writeFileSync(path.join(VOCES, 'voces.json'), JSON.stringify(voices, null, 2));
  const rows = voices.map(v => {
    const l = v.labels || {};
    return { id: v.voice_id, name: v.name, gender: l.gender || '', age: l.age || '', accent: l.accent || '', desc: l.description || l.descriptive || '', uc: l.use_case || '' };
  });
  // prioriza femeninas
  rows.sort((a, b) => (a.gender === 'female' ? 0 : 1) - (b.gender === 'female' ? 0 : 1));
  rows.forEach(r => console.log(`${r.id}  | ${r.name.padEnd(16)} | ${r.gender.padEnd(6)} | ${r.age.padEnd(12)} | ${r.accent.padEnd(12)} | ${r.desc} | ${r.uc}`));
  console.log(`\n${rows.length} voces. Guardado voces/voces.json`);
}

function tts(voiceId, text, outMp3) {
  return req('POST', `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    text, model_id: MODEL,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  }).then(({ status, buf }) => {
    if (status !== 200) { console.error('tts falló', voiceId, status, buf.toString().slice(0, 200)); return false; }
    fs.writeFileSync(outMp3, buf); return true;
  });
}

async function samples(ids) {
  const voices = JSON.parse(fs.readFileSync(path.join(VOCES, 'voces.json'), 'utf8'));
  const nameOf = id => (voices.find(v => v.voice_id === id) || {}).name || id;
  for (const id of ids) {
    const name = nameOf(id).replace(/\s+/g, '-');
    const out = path.join(VOCES, `sample-${name}.mp3`);
    const ok = await tts(id, SAMPLE, out);
    if (ok) console.log('muestra:', path.relative(ROOT, out));
  }
}

async function final(voiceId) {
  // with-timestamps devuelve audio_base64 + alignment (chars con start/end)
  const { status, buf } = await req('POST', `/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    text: SCRIPT, model_id: MODEL,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  });
  if (status !== 200) { console.error('final falló', status, buf.toString().slice(0, 300)); process.exit(1); }
  const j = JSON.parse(buf.toString());
  const audio = Buffer.from(j.audio_base64, 'base64');
  fs.writeFileSync(path.join(VOCES, 'vo-final.mp3'), audio);
  // construir words.json desde alignment de caracteres
  const al = j.alignment || j.normalized_alignment;
  const chars = al.characters, starts = al.character_start_times_seconds, ends = al.character_end_times_seconds;
  const words = []; let cur = '', s = null, e = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      if (cur) { words.push({ word: cur, start: s, end: e }); cur = ''; s = null; }
    } else {
      if (s === null) s = starts[i];
      e = ends[i]; cur += ch;
    }
  }
  if (cur) words.push({ word: cur, start: s, end: e });
  fs.writeFileSync(path.join(VOCES, 'words.json'), JSON.stringify(words, null, 2));
  const dur = ends[ends.length - 1];
  console.log(`vo-final.mp3 (${dur.toFixed(1)}s) + words.json (${words.length} palabras)`);
}

// --- Voice Library (shared voices): buscar femeninas mexicanas ---
async function shared() {
  const params = 'gender=female&language=es&page_size=100';
  const { status, buf } = await req('GET', `/v1/shared-voices?${params}`);
  if (status !== 200) { console.error('shared falló', status, buf.toString().slice(0, 300)); process.exit(1); }
  const voices = JSON.parse(buf.toString()).voices || [];
  fs.writeFileSync(path.join(VOCES, 'shared.json'), JSON.stringify(voices, null, 2));
  const mx = voices.filter(v => {
    const s = `${v.accent || ''} ${v.locale || ''} ${v.language || ''} ${(v.verified_languages || []).map(x => x.locale || x.accent || '').join(' ')}`.toLowerCase();
    return s.includes('mx') || s.includes('mexic');
  });
  const show = (mx.length ? mx : voices).slice(0, 30);
  show.forEach(v => console.log(`${v.voice_id} | owner=${v.public_owner_id} | ${(v.name || '').padEnd(18)} | ${v.accent || ''} ${v.locale || ''} | age=${v.age || ''} | ${(v.descriptive || '')} | uc=${v.use_case || ''} | ${v.preview_url || ''}`));
  console.log(`\n${voices.length} femeninas es; ${mx.length} mexicanas. Guardado voces/shared.json`);
}

async function addShared(ownerId, voiceId, newName) {
  const { status, buf } = await req('POST', `/v1/voices/add/${ownerId}/${voiceId}`, { new_name: newName || 'Hana MX' });
  if (status !== 200) { console.error('add falló', status, buf.toString().slice(0, 300)); process.exit(1); }
  const j = JSON.parse(buf.toString());
  console.log('agregada. voice_id =', j.voice_id);
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'list') return list();
  if (cmd === 'shared') return shared();
  if (cmd === 'add') return addShared(process.argv[3], process.argv[4], process.argv[5]);
  if (cmd === 'samples') return samples((process.argv[3] || '').split(',').filter(Boolean));
  if (cmd === 'final') return final(process.argv[3]);
  console.error('uso: list | shared | add <owner> <voiceId> <name> | samples <ids> | final <id>');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
