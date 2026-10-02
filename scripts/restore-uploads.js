#!/usr/bin/env node
'use strict';

// Loads .env.local when run locally; on Railway env vars are already set.
require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

// Resolve data dir the same way backup.js does — works on any mount point.
const DATA_DIR    = path.join(__dirname, '../data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

function makeS3() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket    = process.env.R2_BUCKET;
  if (!accountId || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('Missing R2 env vars (R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
    process.exit(1);
  }
  return new S3Client({
    region:   'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function main() {
  const targetKey = process.argv[2] || null; // optional: specific backup key
  const s3        = makeS3();
  const bucket    = process.env.R2_BUCKET;

  // Resolve which backup to restore
  let key;
  if (targetKey) {
    key = targetKey;
    console.log(`Restoring specified backup: ${key}`);
  } else {
    const res     = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'uploads-' }));
    const backups = (res.Contents || [])
      .filter(o => /^uploads-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/.test(o.Key))
      .sort((a, b) => a.Key.localeCompare(b.Key));
    if (!backups.length) {
      console.error('No uploads backups found in R2.');
      process.exit(1);
    }
    const latest = backups[backups.length - 1];
    key = latest.Key;
    console.log(`Latest backup: ${key} (${(latest.Size / 1024 / 1024).toFixed(2)} MB, ${latest.LastModified})`);
    console.log(`Total backups available: ${backups.length}`);
  }

  const stamp  = Date.now();
  const tmpTar = path.join(os.tmpdir(), `restore-uploads-${stamp}.tar.gz`);

  try {
    // Download
    process.stdout.write('Downloading from R2...');
    const dlRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(dlRes.Body, fs.createWriteStream(tmpTar));
    console.log(' done.');

    // Move current uploads/ to uploads-old (never delete)
    if (fs.existsSync(UPLOADS_DIR)) {
      const oldDir = fs.existsSync(path.join(DATA_DIR, 'uploads-old'))
        ? path.join(DATA_DIR, `uploads-old-${stamp}`)
        : path.join(DATA_DIR, 'uploads-old');
      fs.renameSync(UPLOADS_DIR, oldDir);
      console.log(`Moved existing uploads/ → ${path.basename(oldDir)}/`);
    }

    // Extract — tar archive contains uploads/ at root, so -C DATA_DIR recreates uploads/
    process.stdout.write('Extracting...');
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', tmpTar, '-C', DATA_DIR], err => {
        if (err) reject(err); else resolve();
      });
    });
    console.log(' done.');

    // Count restored files
    const count = countFiles(UPLOADS_DIR);
    console.log(`\nRestored ${count} files to ${UPLOADS_DIR}`);
    console.log('Done. Restart the server to pick up the restored files.');

  } finally {
    try { if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar); } catch (_) {}
  }
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += countFiles(path.join(dir, entry.name));
    } else {
      n++;
    }
  }
  return n;
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
