require('dotenv').config({ path: '.env.local' });

const API_KEY = process.env.ELEVENLABS_API_KEY;
const BASE = 'https://api.elevenlabs.io/v1';

function requireKey() {
  if (!API_KEY) throw new Error('ELEVENLABS_API_KEY not set in .env.local');
}

async function cloneVoice(name, fileBuffer, mimeType) {
  requireKey();

  const form = new FormData();
  form.append('name', name);
  form.append('description', `Voz clonada para negocio: ${name}`);
  form.append('files', new Blob([fileBuffer], { type: mimeType }), 'voice-sample.mp3');

  const res = await fetch(`${BASE}/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY },
    body: form,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`ElevenLabs clone error ${res.status}: ${JSON.stringify(data)}`);
  if (!data.voice_id) throw new Error('ElevenLabs did not return a voice_id');

  return data.voice_id;
}

async function generatePreview(voiceId) {
  requireKey();

  const res = await fetch(`${BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: 'Hola, así sonará tu asistente de ventas. ¿En qué te puedo ayudar hoy?',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${err}`);
  }

  return res; // caller pipes the response body
}

module.exports = { cloneVoice, generatePreview };
