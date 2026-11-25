const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

function convertToMp3(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const input = new PassThrough();
    input.end(buffer);

    const output = new PassThrough();
    output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);

    ffmpeg(input)
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .format('mp3')
      .on('error', reject)
      .pipe(output);
  });
}

function convertToOgg(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const input = new PassThrough();
    input.end(buffer);

    const output = new PassThrough();
    output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);

    ffmpeg(input)
      .audioCodec('libopus')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('16k')
      .outputOptions([
        '-application voip',
        '-vbr off',
        '-map_metadata -1',
      ])
      .format('ogg')
      .on('error', reject)
      .pipe(output);
  });
}

const WAVEFORM_POINTS = 64;
const WAVEFORM_PCM_RATE = 8000;

/**
 * Duration and waveform of a voice note, in the shape WhatsApp clients draw:
 * 64 points, each 0–100, scaled to the loudest block.
 * Baileys only computes this itself when the optional `audio-decode` package is
 * installed (it is not), so without it voice notes arrive with a flat line.
 * @returns {Promise<{ seconds: number, waveform: Uint8Array }>}
 */
function analyzeVoiceNote(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const input = new PassThrough();
    input.end(buffer);

    const output = new PassThrough();
    output.on('data', chunk => chunks.push(chunk));
    output.on('error', reject);
    output.on('end', () => {
      const pcm = Buffer.concat(chunks);
      const samples = Math.floor(pcm.length / 2);
      if (samples < WAVEFORM_POINTS) return reject(new Error('audio too short to analyze'));
      const block = Math.floor(samples / WAVEFORM_POINTS);
      const avg = new Array(WAVEFORM_POINTS);
      let max = 0;
      for (let i = 0; i < WAVEFORM_POINTS; i++) {
        let sum = 0;
        for (let j = 0; j < block; j++) sum += Math.abs(pcm.readInt16LE((i * block + j) * 2));
        avg[i] = sum / block;
        if (avg[i] > max) max = avg[i];
      }
      resolve({
        seconds: Math.max(1, Math.round(samples / WAVEFORM_PCM_RATE)),
        waveform: Uint8Array.from(avg, v => (max > 0 ? Math.floor(100 * v / max) : 0)),
      });
    });

    ffmpeg(input)
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(WAVEFORM_PCM_RATE)
      .format('s16le')
      .on('error', reject)
      .pipe(output);
  });
}

module.exports = { convertToMp3, convertToOgg, analyzeVoiceNote };
