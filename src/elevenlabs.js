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

// Simple presets the owner picks in the panel. Defaults ('normal' + 'natural') are exactly
// the settings Daxos always used, so a business that never touches them sounds the same.
// 'expresiva' + 'rapida' is the configuration used for the Daxos content videos.
const VOICE_SPEEDS = { lenta: 1.0, normal: 1.1, rapida: 1.18 };
const VOICE_TONES = {
  tranquila: { stability: 0.6,  style: 0.1 },
  natural:   { stability: 0.5,  style: 0.2 },
  expresiva: { stability: 0.45, style: 0.3 },
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
  if (model !== null && model !== undefined && !ALLOWED_V4_MODELS.includes(model) && !model.startsWith('eleven_v4')) {
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
  return { voice_id: d.voice_id, name: d.name };
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

async function transcribeAudio(buffer, contentType) {
  requireKey();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType || 'audio/ogg' }), 'audio.ogg');
  form.append('model_id', 'scribe_v1');
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
  _ttsBody: ttsBody,
  _normalizeTtsText: normalizeTtsText,
  _applyPronunciations: applyPronunciations,
};
