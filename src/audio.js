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
      .audioBitrate('32k') // 32 kbps Opus mono: clearer voice, still a native-looking 16 kHz note
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

// Joins mp3 clips with `gapMs` of silence between them and normalises loudness (EBU R128,
// -16 LUFS — voice-note level). Clips go through temp files: ffmpeg can't read several pipes.
async function concatWithGaps(buffers, gapMs = 250) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFile } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daxos-tts-'));
  try {
    const inputs = buffers.map((b, i) => {
      const f = path.join(dir, `p${i}.mp3`);
      fs.writeFileSync(f, b);
      return f;
    });
    const out = path.join(dir, 'out.mp3');
    const n = inputs.length;
    let fc = '';
    for (let i = 0; i < n; i++) {
      fc += `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[a${i}];`;
      if (i < n - 1) fc += `anullsrc=r=44100:cl=mono,atrim=duration=${(gapMs / 1000).toFixed(3)}[g${i}];`;
    }
    const seq = [];
    for (let i = 0; i < n; i++) { seq.push(`[a${i}]`); if (i < n - 1) seq.push(`[g${i}]`); }
    fc += `${seq.join('')}concat=n=${seq.length}:v=0:a=1[c];[c]loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    inputs.forEach(f => args.push('-i', f));
    args.push('-filter_complex', fc, '-map', '[out]', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', out);
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { timeout: 30_000 }, (err, _so, se) => err ? reject(new Error(`ffmpeg concat: ${String(se || err.message).slice(0, 300)}`)) : resolve());
    });
    return fs.readFileSync(out);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { concatWithGaps, convertToMp3, convertToOgg, analyzeVoiceNote };
