require('dotenv').config({ path: '.env.local' });

const { convertToMp3 } = require('./audio');

const EL_TIMEOUT_MS = 15_000;
const STT_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url, opts, timeoutMs = EL_TIMEOUT_MS) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(tid);
  }
}

const API_KEY = process.env.ELEVENLABS_API_KEY;
const TTS_MODEL = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
// ELEVENLABS_BASE_URL is overridable for testing; never set in production
const BASE = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io') + '/v1';

function requireKey() {
  if (!API_KEY) throw new Error('ELEVENLABS_API_KEY not set in .env.local');
}

async function cloneVoice(name, fileBuffer) {
  requireKey();

  // Always convert to MP3 — ElevenLabs format support is not documented explicitly
  const mp3Buffer = await convertToMp3(fileBuffer);

  const form = new FormData();
  form.append('name', name);
  form.append('description', `Voz clonada para negocio: ${name}`);
  form.append('files', new Blob([mp3Buffer], { type: 'audio/mpeg' }), 'voice-sample.mp3');

  const res = await fetchWithTimeout(`${BASE}/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY },
    body: form,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`ElevenLabs clone error ${res.status}: ${JSON.stringify(data)}`);
  if (!data.voice_id) throw new Error('ElevenLabs did not return a voice_id');

  return data.voice_id;
}

function normalizeTtsText(text, { stripUrls = false } = {}) {
  // Strip markdown that ElevenLabs reads literally (*bold*, _italic_, etc.)
  let t = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  // v4 path: strip URLs before synthesis (they sound terrible when read aloud)
  if (stripUrls) {
    t = t.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  // Ensure terminal punctuation so ElevenLabs closes the intonation curve
  if (t && !/[.!?…]$/.test(t)) t += '.';
  return t;
}

// Allowed explicit model values stored in DB; anything else falls back to legacy path with a warning.
const ALLOWED_V4_MODELS = ['eleven_v4_turbo', 'eleven_v4'];
// The natural-voice recipe always runs on this model, whatever ELEVENLABS_MODEL_ID says.
const RECIPE_MODEL = 'eleven_multilingual_v2';

// Simple presets the owner picks in the panel. Defaults ('normal' + 'natural') are the
// natural-voice recipe every audio business gets when it never touches them.
const VOICE_SPEEDS = { lenta: 1.0, normal: 1.1, rapida: 1.18 };
// 'natural' is the Daxos natural-voice recipe (blind test 26/11, ronda 10): stability 0.45,
// style 0.3, similarity 0.85, speed 1.1. The other two move around it.
const VOICE_TONES = {
  tranquila: { stability: 0.6,  style: 0.15 },
  natural:   { stability: 0.45, style: 0.3 },
  expresiva: { stability: 0.35, style: 0.45 },
};
const MAX_PRONUNCIATIONS = 30;

// Ready-made voices a business can pick instead of recording its own. They are ElevenLabs
// library voices saved in the Daxos account, never a person's clone (Vale's voice is only
// for Daxos's own content). Same engine and settings as the cloned voices.
const VOICE_CATALOG = [
  { id: '9oPKasc15pfAbMr7N6Gs', nombre: 'Valeria', descripcion: 'Mujer joven, acento rioplatense' },
  { id: 'QK4xDwo9ESPHA4JNUpX3', nombre: 'Tomás',   descripcion: 'Hombre, acento rioplatense' },
  { id: 'akOBlaKhFd59YlK6xz9u', nombre: 'Lucía',   descripcion: 'Mujer, cálida, español neutro' },
  { id: 'pMoFWkOXRI86X7PmTzlS', nombre: 'María',   descripcion: 'Mujer, tranquila, español neutro' },
];
const CATALOG_SAMPLE_TEXT = 'Hola, gracias por escribirnos. Sí, lo tenemos disponible esta semana. ¿Querés que te pase precios y horarios?';
function isCatalogVoice(voiceId) { return VOICE_CATALOG.some(v => v.id === voiceId); }

// Parses the stored JSON (or an array) into a clean [{de, a}] list. Bad input → [].
function parsePronunciations(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list
    .filter(p => p && typeof p.de === 'string' && typeof p.a === 'string')
    .map(p => ({ de: p.de.trim().slice(0, 60), a: p.a.trim().slice(0, 80) }))
    .filter(p => p.de && p.a)
    .slice(0, MAX_PRONUNCIATIONS);
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Replaces whole words only, ignoring case ("whatsapp", "WhatsApp" → "guatsap"; "WhatsAppX" untouched).
function applyPronunciations(text, raw) {
  let t = text;
  for (const { de, a } of parsePronunciations(raw)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(de)}(?=$|[^\\p{L}\\p{N}])`, 'giu');
    t = t.replace(re, (_, pre) => pre + a);
  }
  return t;
}

// Business row → opts for generateAudioBuffer. One place so every call site sounds the same.
function voiceOptsFor(business) {
  return {
    model: business.voice_tts_model,
    stability: business.voice_stability,
    speed: business.voice_speed,
    tone: business.voice_tone,
    pronunciations: business.voice_pronunciations,
  };
}

// opts = { model?, stability?, speed?, tone?, pronunciations? }
// stability (admin override) wins over the tone preset's stability.
function ttsBody(text, opts = {}) {
  let { model, stability } = opts;

  // Validate model: only NULL or an explicitly allowed value; unknown → warn + legacy
  if (model !== null && model !== undefined && model !== RECIPE_MODEL && !ALLOWED_V4_MODELS.includes(model) && !model.startsWith('eleven_v4')) {
    console.error(`[elevenlabs:voice_tts_model] unknown model "${model}" — falling back to default`);
    model = null;
  }

  // Validate stability: must be 0–1 or null; out of range → warn + default
  if (stability !== null && stability !== undefined) {
    if (typeof stability !== 'number' || stability < 0 || stability > 1) {
      console.error(`[elevenlabs:voice_stability] value ${stability} out of range 0–1 — using default`);
      stability = null;
    }
  }

  const tone  = VOICE_TONES[opts.tone] || null;
  const speed = VOICE_SPEEDS[opts.speed] ?? VOICE_SPEEDS.normal;
  const spoken = applyPronunciations(text, opts.pronunciations);
  const resolvedModel = model || TTS_MODEL;

  if (resolvedModel.startsWith('eleven_v4')) {
    return JSON.stringify({
      text: normalizeTtsText(spoken, { stripUrls: true }),
      model_id: resolvedModel,
      voice_settings: {
        stability: stability ?? tone?.stability ?? 0.35,
        similarity_boost: 0.75,
        ...(opts.speed && VOICE_SPEEDS[opts.speed] ? { speed } : {}),
      },
    });
  }

  // Legacy path. speed goes inside voice_settings: ElevenLabs ignores a top-level "speed"
  // (measured 26/11: top-level 0.7 sounded the same as none), so the 1.1 never applied.
  return JSON.stringify({
    text: normalizeTtsText(spoken),
    model_id: resolvedModel,
    voice_settings: {
      stability: stability ?? (tone || VOICE_TONES.natural).stability,
      similarity_boost: 0.85,
      style: (tone || VOICE_TONES.natural).style,
      use_speaker_boost: true,
      speed,
    },
  });
}

// Checks that a voice exists in this ElevenLabs account. Returns { voice_id, name } or throws.
async function getVoice(voiceId) {
  requireKey();
  const res = await fetchWithTimeout(`${BASE}/voices/${encodeURIComponent(voiceId)}`, {
    method: 'GET',
    headers: { 'xi-api-key': API_KEY },
  });
  if (!res.ok) throw new Error(`ElevenLabs voice ${res.status}`);
  const d = await res.json();
  return { voice_id: d.voice_id, name: d.name, category: d.category || null };
}

const DEFAULT_PREVIEW_TEXT = 'Hola, así sonará tu asistente de ventas. ¿En qué te puedo ayudar hoy?';

// opts: same as ttsBody (lets the owner hear settings before saving them).
async function generatePreview(voiceId, opts = {}, text = DEFAULT_PREVIEW_TEXT) {
  requireKey();

  const res = await fetchWithTimeout(`${BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Accept': 'audio/mpeg', 'Content-Type': 'application/json' },
    body: ttsBody(text || DEFAULT_PREVIEW_TEXT, opts),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${err}`);
  }

  return res; // caller pipes the response body
}

const _audioCache = new Map();
const _AUDIO_CACHE_MAX = 200;

// opts: see voiceOptsFor(business). The cache key is the full request body, so changing a
// setting never serves an audio made with the old one.
async function generateAudioBuffer(voiceId, text, opts = {}) {
  requireKey();
  const body = ttsBody(text, opts);
  const cacheKey = `${voiceId}|${body}`;
  if (_audioCache.has(cacheKey)) {
    console.log(`[elevenlabs:cache-hit] voiceId=${voiceId} chars=${text.length}`);
    return _audioCache.get(cacheKey);
  }

  const res = await fetchWithTimeout(`${BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Accept': 'audio/mpeg', 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${err}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (_audioCache.size >= _AUDIO_CACHE_MAX) {
    _audioCache.delete(_audioCache.keys().next().value);
  }
  _audioCache.set(cacheKey, buf);
  return buf;
}

// ── Natural-voice recipe ────────────────────────────────────────────────────
// Sentence by sentence, each with the text around it as context (previous_text everywhere,
// next_text everywhere except the last sentence, so the message closes with a falling
// intonation), N takes per sentence, the take whose transcription best matches the text
// wins, 250 ms of silence between sentences and loudness normalisation. Chosen in the blind
// tests of 26/11 (ronda 9: receta A; ronda 10: variante 1).
const RECIPE_TAKES = 4;
const SENTENCE_GAP_MS = 250;
const RECIPE_CONCURRENCY = Math.max(1, parseInt(process.env.ELEVENLABS_CONCURRENCY || '4', 10));
const RECIPE_STT_MODEL = process.env.ELEVENLABS_STT_PICK_MODEL || 'scribe_v2';
const MIN_SENTENCE_CHARS = 12;
const MAX_SENTENCES = 8;
// Bitrate of the takes (mp3_44100_128) — bytes → seconds without decoding.
const TAKE_BYTES_PER_SEC = 128000 / 8;

// Splits on . ! ? … followed by a space. A short capitalised word with a period ("Dr.",
// "Sra.", "Av.") is an abbreviation, not the end of a sentence. Very short pieces are glued
// to the next one, and the tail is merged so there are at most MAX_SENTENCES.
function splitSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = [];
  let start = 0;
  const re = /[.!?…]+["»)]*\s+/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const end = m.index + m[0].length;
    const chunk = t.slice(start, end).trim();
    const lastWord = chunk.split(' ').pop();
    if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{0,3}\.$/.test(lastWord) && m[0].trim() === '.') continue;
    parts.push(chunk);
    start = end;
  }
  if (start < t.length) parts.push(t.slice(start).trim());

  const merged = [];
  for (const p of parts) {
    if (merged.length && merged[merged.length - 1].length < MIN_SENTENCE_CHARS) {
      merged[merged.length - 1] += ' ' + p;
    } else merged.push(p);
  }
  if (merged.length > 1 && merged[merged.length - 1].length < MIN_SENTENCE_CHARS) {
    const last = merged.pop();
    merged[merged.length - 1] += ' ' + last;
  }
  while (merged.length > MAX_SENTENCES) {
    const last = merged.pop();
    merged[merged.length - 1] += ' ' + last;
  }
  return merged.map(p => normalizeTtsText(p));
}

const _normWords = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(Boolean);

// 1 = transcription identical to the text, 0 = nothing in common (word-level edit distance).
function wordSimilarity(a, b) {
  const x = _normWords(a), y = _normWords(b);
  if (!x.length) return y.length ? 0 : 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.max(0, 1 - prev[y.length] / x.length);
}

// Expected length of a sentence at a given speed. Fitted on the brisk takes of the
// Valentin-IVC2 recipe calibration (26/11, 36 takes): ~0.17 s + 0.048 s per character at
// speed 1.1. The mean of all takes (0.057 s/char) is pulled up by the dragged takes, so the
// fast side is the target.
const EXPECTED_BASE_SEC = 0.17;
const EXPECTED_SEC_PER_CHAR_AT_1_1 = 0.048;
// A take this much longer than expected is "dragged" and dropped when another one fits.
const SLOW_TAKE_RATIO = 1.15;
// Takes whose transcription is this close to the best one count as equally clean.
const SIMILARITY_MARGIN = 0.1;

function expectedSeconds(text, speed = 1.1) {
  return EXPECTED_BASE_SEC + String(text).length * EXPECTED_SEC_PER_CHAR_AT_1_1 * (1.1 / (speed || 1.1));
}

// Best take:
//   1) transcription: keep the takes that read the text as well as the best one (± margin);
//   2) drop dragged takes (longer than expected × 1.15) when another one is left;
//   3) the one closest to the expected duration wins; ties → better transcription.
// If every transcription fails, steps 2–3 still choose by duration.
function pickBestTake(sentence, takes, transcripts, speed = 1.1) {
  const secs = takes.map(b => b.length / TAKE_BYTES_PER_SEC);
  const sims = transcripts.map(t => (t == null ? null : wordSimilarity(sentence, t)));
  const expected = expectedSeconds(sentence, speed);
  let idx = takes.map((_, k) => k);
  const known = idx.filter(k => sims[k] != null);
  if (known.length) {
    const top = Math.max(...known.map(k => sims[k]));
    idx = known.filter(k => sims[k] >= top - SIMILARITY_MARGIN);
  }
  const notSlow = idx.filter(k => secs[k] <= expected * SLOW_TAKE_RATIO);
  if (notSlow.length) idx = notSlow;
  idx.sort((a, b) => Math.abs(secs[a] - expected) - Math.abs(secs[b] - expected) || (sims[b] ?? -1) - (sims[a] ?? -1));
  return idx[0];
}

// Runs async jobs with at most `limit` in flight. Keeps result order.
async function runPool(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

function _isQuotaError(status, body) {
  return /quota_exceeded|insufficient.*credit|exceeds your quota/i.test(body || '') || status === 402;
}

// One TTS request with up to 2 retries on 429/5xx. Quota errors mark the account as out of
// credits so the bot answers in text until the next check.
async function ttsRequest(voiceId, bodyObj) {
  requireKey();
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(`${BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Accept': 'audio/mpeg', 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const err = await res.text().catch(() => '');
    if (_isQuotaError(res.status, err)) {
      markCreditsExhausted();
      throw new Error(`ElevenLabs TTS quota ${res.status}: ${err.slice(0, 200)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    throw new Error(`ElevenLabs TTS error ${res.status}: ${err.slice(0, 300)}`);
  }
}

// Builds the audio for a whole reply with the natural recipe.
// Returns { mp3, billedChars, sttSeconds, sentences, takes }.
// opts: voiceOptsFor(business). takes: 4 normally, 1 when the account is low on credits.
async function generateNaturalAudio(voiceId, text, opts = {}, { takes = RECIPE_TAKES } = {}) {
  requireKey();
  const { concatWithGaps } = require('./audio');
  // Pronunciations go first on the whole text: "Dr. = doctor" must not split a sentence.
  const spoken = applyPronunciations(text, opts.pronunciations);
  const sentences = splitSentences(spoken);
  if (!sentences.length) throw new Error('empty text');
  // Exactly the blind-test recipe: multilingual_v2 pinned (an ELEVENLABS_MODEL_ID env var
  // must not swap the model under it) and no admin stability override (a v4-era value such
  // as 0.35 would beat the recipe's 0.45). Owner presets (speed/tone) still apply.
  const baseOpts = naturalOpts(opts);

  const cacheKey = `natural|${voiceId}|${takes}|${ttsBody(spoken, baseOpts)}`;
  if (_audioCache.has(cacheKey)) {
    console.log(`[elevenlabs:cache-hit] voiceId=${voiceId} chars=${text.length}`);
    return { ..._audioCache.get(cacheKey), billedChars: 0, sttSeconds: 0, cached: true };
  }

  const bodies = sentences.map((s, i) => {
    const b = JSON.parse(ttsBody(s, baseOpts));
    const prev = sentences.slice(0, i).join(' ');
    const next = sentences.slice(i + 1).join(' ');
    if (prev) b.previous_text = prev;
    if (next) b.next_text = next; // never on the last sentence → closing intonation
    return b;
  });

  const jobs = [];
  bodies.forEach((b, i) => { for (let k = 0; k < takes; k++) jobs.push(() => ttsRequest(voiceId, b).then(buf => ({ i, buf }))); });
  const results = await runPool(jobs, RECIPE_CONCURRENCY);
  const bySentence = sentences.map(() => []);
  results.forEach(r => bySentence[r.i].push(r.buf));
  const billedChars = bodies.reduce((a, b) => a + b.text.length * takes, 0);

  let sttSeconds = 0;
  const picked = await Promise.all(bySentence.map(async (bufs, i) => {
    if (bufs.length === 1) return bufs[0];
    sttSeconds += bufs.reduce((a, b) => a + b.length / TAKE_BYTES_PER_SEC, 0);
    const transcripts = await Promise.all(bufs.map(b =>
      transcribeAudio(b, 'audio/mpeg', RECIPE_STT_MODEL).catch(e => { _noteSttFailure(e); return null; })));
    return bufs[pickBestTake(bodies[i].text, bufs, transcripts, bodies[i].voice_settings?.speed)];
  }));

  const mp3 = await concatWithGaps(picked, SENTENCE_GAP_MS);
  const out = { mp3, sentences: sentences.length, takes };
  if (_audioCache.size >= _AUDIO_CACHE_MAX) _audioCache.delete(_audioCache.keys().next().value);
  _audioCache.set(cacheKey, out);
  noteCreditsUsed(billedChars);
  return { ...out, billedChars, sttSeconds };
}

function naturalOpts(opts = {}) {
  return { ...opts, pronunciations: null, model: RECIPE_MODEL, stability: null };
}

// Scribe failing on every take means the "best take" is always the first one: say so once.
let _sttFailureLogged = false;
function _noteSttFailure(e) {
  if (_sttFailureLogged) return;
  _sttFailureLogged = true;
  console.error('[elevenlabs:recipe] transcription failed, using the first take:', e.message);
}

// True when this business's audio goes through the natural recipe (not the v4 single call).
function usesNaturalRecipe(opts = {}) {
  const m = opts.model;
  return !(m && String(m).startsWith('eleven_v4'));
}

// ── ElevenLabs account credits ──────────────────────────────────────────────
// Cached view of /user/subscription so the send path never waits on it more than once
// every few minutes. Between checks the chars Daxos spends are added locally.
const CREDIT_MAX_AGE_MS = 5 * 60_000;
const _credit = { at: 0, count: 0, limit: 0, reset: null, exhausted: false };
let _onCreditsExhausted = null;

function onCreditsExhausted(fn) { _onCreditsExhausted = fn; }

function markCreditsExhausted() {
  const was = _credit.exhausted;
  _credit.exhausted = true;
  _credit.at = Date.now();
  if (!was && _onCreditsExhausted) { try { _onCreditsExhausted(); } catch (_) {} }
}

function noteCreditsUsed(chars) { if (chars > 0) _credit.count += chars; }

function _creditView() {
  const known = _credit.limit > 0;
  const remaining = known ? Math.max(0, _credit.limit - _credit.count) : null;
  return {
    known,
    count: _credit.count,
    limit: _credit.limit,
    remaining,
    remainingRatio: known ? remaining / _credit.limit : null,
    exhausted: _credit.exhausted || (known && remaining <= 0),
    reset: _credit.reset,
  };
}

// Refreshes when older than maxAgeMs (0 = always). On error keeps the last known state.
async function getCreditState({ maxAgeMs = CREDIT_MAX_AGE_MS } = {}) {
  if (API_KEY && Date.now() - _credit.at >= maxAgeMs) {
    try {
      const u = await getSubscriptionUsage();
      _credit.count = u.character_count;
      _credit.limit = u.character_limit;
      _credit.reset = u.next_reset_unix;
      _credit.exhausted = u.character_limit > 0 && u.character_count >= u.character_limit;
      _credit.at = Date.now();
    } catch (e) {
      _credit.at = Date.now() - maxAgeMs + 60_000; // retry in a minute, not on every message
      // A key without the user_read permission can never read the credits: the 20% / 100%
      // rules then stay off. Logged once per process so it shows in Railway.
      if (/missing_permissions|user_read/.test(e.message)) {
        if (!_credit.permissionLogged) {
          _credit.permissionLogged = true;
          console.error('[elevenlabs:credits] API key lacks user_read — credit checks disabled until the key gets that permission');
        }
      } else {
        console.error('[elevenlabs:credits]', e.message);
      }
    }
  }
  return _creditView();
}

// How a reply should go out given the account credits:
//   'text' (out of credits / not enough for this reply), 1 take (< 20% left), or the full recipe.
const LOW_CREDIT_RATIO = 0.2;
function planTakes(credit, charsNeeded) {
  if (credit.exhausted) return { mode: 'text', reason: 'credits_exhausted' };
  if (credit.known && credit.remaining < charsNeeded) return { mode: 'text', reason: 'credits_insufficient' };
  if (credit.known && credit.remainingRatio < LOW_CREDIT_RATIO) return { mode: 'audio', takes: 1, reason: 'credits_low' };
  return { mode: 'audio', takes: RECIPE_TAKES };
}

function _resetCreditStateForTests() {
  Object.assign(_credit, { at: 0, count: 0, limit: 0, reset: null, exhausted: false });
}

async function deleteVoice(voiceId) {
  requireKey();
  const res = await fetchWithTimeout(`${BASE}/voices/${voiceId}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': API_KEY },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs delete voice error ${res.status}: ${err}`);
  }
}

async function transcribeAudio(buffer, contentType, model = 'scribe_v1') {
  requireKey();
  const form = new FormData();
  const fname = (contentType || '').includes('mpeg') ? 'audio.mp3' : 'audio.ogg';
  form.append('file', new Blob([buffer], { type: contentType || 'audio/ogg' }), fname);
  form.append('model_id', model);
  form.append('language_code', 'spa');
  // No Content-Type header — let fetch set it with the multipart boundary
  const res = await fetchWithTimeout(`${BASE}/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY.trim() },
    body: form,
  }, STT_TIMEOUT_MS);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`ElevenLabs STT ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

// Account-level character usage for the current billing period. Used to alert the admin
// when the ElevenLabs account nears its limit. Never logs the API key.
async function getSubscriptionUsage() {
  requireKey();
  const res = await fetchWithTimeout(`${BASE}/user/subscription`, {
    method: 'GET',
    headers: { 'xi-api-key': API_KEY },
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`ElevenLabs subscription ${res.status}: ${err.slice(0, 200)}`);
  }
  const d = await res.json();
  return {
    character_count: Number(d.character_count) || 0,
    character_limit: Number(d.character_limit) || 0,
    next_reset_unix: d.next_character_count_reset_unix ?? null,
  };
}

module.exports = {
  cloneVoice, generatePreview, generateAudioBuffer, deleteVoice, transcribeAudio, getSubscriptionUsage,
  getVoice, voiceOptsFor, VOICE_CATALOG, CATALOG_SAMPLE_TEXT, isCatalogVoice, parsePronunciations, VOICE_SPEEDS, VOICE_TONES, MAX_PRONUNCIATIONS,
  // Exported for unit tests only — not part of the public API
  generateNaturalAudio, usesNaturalRecipe, getCreditState, planTakes, onCreditsExhausted, markCreditsExhausted,
  RECIPE_TAKES, LOW_CREDIT_RATIO,
  _ttsBody: ttsBody,
  _naturalOpts: naturalOpts,
  RECIPE_MODEL,
  _splitSentences: splitSentences,
  _wordSimilarity: wordSimilarity,
  _pickBestTake: pickBestTake,
  _expectedSeconds: expectedSeconds,
  _resetCreditStateForTests,
  _normalizeTtsText: normalizeTtsText,
  _applyPronunciations: applyPronunciations,
};
