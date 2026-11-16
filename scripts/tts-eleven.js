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
const SHORT_SCRIPT = 'El reto de veintiún días de calistenia asiática. Quince minutos al día, desde tu sala, sin saltos. Haz el test, es gratis.';
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

async function finalGen(voiceId, text, mp3Name, wordsName) {
  // with-timestamps devuelve audio_base64 + alignment (chars con start/end)
  const { status, buf } = await req('POST', `/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    text, model_id: MODEL,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  });
  if (status !== 200) { console.error('final falló', status, buf.toString().slice(0, 300)); process.exit(1); }
  const j = JSON.parse(buf.toString());
  fs.writeFileSync(path.join(VOCES, mp3Name), Buffer.from(j.audio_base64, 'base64'));
  // construir words desde alignment de caracteres
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
  fs.writeFileSync(path.join(VOCES, wordsName), JSON.stringify(words, null, 2));
  console.log(`${mp3Name} (${ends[ends.length - 1].toFixed(1)}s) + ${wordsName} (${words.length} palabras)`);
}
const final = (v) => finalGen(v, SCRIPT, 'vo-final.mp3', 'words.json');
const shortVo = (v) => finalGen(v, SHORT_SCRIPT, 'vo-short.mp3', 'words-short.json');

// --- guiones exactos (forma hablada) para forced alignment ---
const UGC_SCRIPTS = {
  A: 'Amiga, si te cuesta arrancar con el ejercicio, prueba esto. Se llama calistenia asiática: movimientos lentos, sin saltos y sin equipo. Son quince minutos al día desde tu sala. Haces un test de un minuto y la app te arma un plan de veintiún días. Y si algo te molesta, cada ejercicio tiene versión fácil. El test es gratis, está aquí abajo.',
  B: 'Si quieres llegar a Año Nuevo sintiéndote más fuerte, empieza esta semana. Son veintiún días de calistenia asiática, quince minutos al día, sin gimnasio. Respondes un test de un minuto y te arma el plan según tu edad y cómo te sientes. Haz el test, es gratis.',
};

// --- Forced alignment: alinea el texto exacto al audio (timestamps por palabra) ---
async function align(audioPath, variant, outName) {
  const text = UGC_SCRIPTS[variant];
  if (!text) { console.error('variante desconocida:', variant); process.exit(1); }
  const { body, contentType } = multipart({ text }, 'file', audioPath);
  const resp = await new Promise((res, rej) => {
    const r = https.request({
      hostname: 'api.elevenlabs.io', path: '/v1/forced-alignment', method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': contentType, 'Content-Length': body.length },
    }, resp => { let d = []; resp.on('data', c => d.push(c)); resp.on('end', () => res({ status: resp.statusCode, buf: Buffer.concat(d) })); });
    r.on('error', rej); r.write(body); r.end();
  });
  if (resp.status !== 200) { console.error('align falló', resp.status, resp.buf.toString().slice(0, 240)); process.exit(1); }
  const j = JSON.parse(resp.buf.toString());
  const words = (j.words || []).filter(w => w.text && w.text.trim()).map(w => ({ word: w.text.trim(), start: w.start, end: w.end }));
  const outPath = path.join(path.dirname(audioPath), outName || `words-${variant}-align.json`);
  fs.writeFileSync(outPath, JSON.stringify(words, null, 2));
  console.log(`align ok: ${words.length} palabras -> ${path.relative(ROOT, outPath)}`);
  console.log('primeras:', words.slice(0, 6).map(w => `${w.word}(${w.start.toFixed(2)})`).join(' '));
  return words;
}

// --- Speech-to-text (Scribe): timestamps por palabra del audio del UGC ---
function multipart(fields, fileField, filePath) {
  const boundary = '----hana' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  const fileBuf = fs.readFileSync(filePath);
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${path.basename(filePath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
function sttRequest(filePath) {
  const { body, contentType } = multipart({ model_id: 'scribe_v1', timestamps_granularity: 'word' }, 'file', filePath);
  return new Promise((res, rej) => {
    const r = https.request({
      hostname: 'api.elevenlabs.io', path: '/v1/speech-to-text', method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': contentType, 'Content-Length': body.length },
    }, resp => { let d = []; resp.on('data', c => d.push(c)); resp.on('end', () => res({ status: resp.statusCode, buf: Buffer.concat(d) })); });
    r.on('error', rej); r.write(body); r.end();
  });
}
async function stt(filePath, outName) {
  const { status, buf } = await sttRequest(filePath);
  if (status !== 200) { console.error('stt falló', status, buf.toString().slice(0, 240)); process.exit(1); }
  const j = JSON.parse(buf.toString());
  const words = (j.words || []).filter(w => w.type === 'word' || !w.type).map(w => ({ word: w.text, start: w.start, end: w.end }));
  if (outName) fs.writeFileSync(path.join(path.dirname(filePath), outName), JSON.stringify(words, null, 2));
  console.log(`stt ok: ${words.length} palabras. texto:`, (j.text || '').slice(0, 120));
  if (words.length) console.log('primeras:', words.slice(0, 6).map(w => `${w.word}(${w.start.toFixed(2)})`).join(' '));
  return words;
}

// --- Sound Effects API: pop / swoosh / ding para los cortes del UGC ---
async function sfx() {
  const SFX = path.join(ROOT, 'motor-anuncios', 'ugc', 'sfx');
  fs.mkdirSync(SFX, { recursive: true });
  const items = [
    { name: 'pop.mp3', text: 'soft UI pop', dur: 0.6 },
    { name: 'swoosh.mp3', text: 'fast swoosh transition', dur: 0.8 },
    { name: 'ding.mp3', text: 'light notification ding', dur: 0.9 },
  ];
  for (const it of items) {
    const { status, buf } = await req('POST', '/v1/sound-generation', { text: it.text, duration_seconds: it.dur, prompt_influence: 0.3 });
    if (status !== 200) { console.error('sfx falló', it.name, status, buf.toString().slice(0, 160)); continue; }
    fs.writeFileSync(path.join(SFX, it.name), buf);
    console.log('sfx:', path.relative(ROOT, path.join(SFX, it.name)), `(${buf.length} bytes)`);
  }
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
  if (cmd === 'short') return shortVo(process.argv[3]);
  if (cmd === 'sfx') return sfx();
  if (cmd === 'stt') return stt(process.argv[3], process.argv[4]);
  if (cmd === 'align') return align(process.argv[3], process.argv[4], process.argv[5]);
  console.error('uso: list | shared | add <owner> <voiceId> <name> | samples <ids> | final <id> | short <id> | sfx');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
