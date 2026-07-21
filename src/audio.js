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
      .format('ogg')
      .on('error', reject)
      .pipe(output);
  });
}

module.exports = { convertToMp3, convertToOgg };
