#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const Database = require('better-sqlite3');

function makeS3() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket    = process.env.R2_BUCKET;
  if (!accountId || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('Missing R2 env vars. Check .env.local');
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

async function verifyDb(s3) {
  const bucket  = process.env.R2_BUCKET;
  const res     = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'daxos-' }));
  const backups = (res.Contents || [])
    .filter(o => /^daxos-\d{4}-\d{2}-\d{2}-\d{4}\.db\.gz$/.test(o.Key))
    .sort((a, b) => a.Key.localeCompare(b.Key));

  if (!backups.length) {
    console.log('⚠️  No DB backups found in R2.');
    return;
  }

  const latest = backups[backups.length - 1];
  console.log(`DB backups in R2: ${backups.length}`);
  console.log(`Latest: ${latest.Key} (${(latest.Size / 1024 / 1024).toFixed(2)} MB, ${latest.LastModified})\n`);

  const stamp = Date.now();
  const tmpGz = path.join(os.tmpdir(), `verify-${stamp}.db.gz`);
  const tmpDb = path.join(os.tmpdir(), `verify-${stamp}.db`);

  try {
    process.stdout.write('  Downloading DB backup...');
    const dlRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latest.Key }));
    await pipeline(dlRes.Body, fs.createWriteStream(tmpGz));
    console.log(' done.');

    process.stdout.write('  Decompressing...');
    await pipeline(fs.createReadStream(tmpGz), zlib.createGunzip(), fs.createWriteStream(tmpDb));
    console.log(' done.\n');

    const db = new Database(tmpDb, { readonly: true });
    try {
      const integrity = db.pragma('integrity_check');
      const ok = integrity.length === 1 && integrity[0].integrity_check === 'ok';
      console.log(`  Integrity: ${ok ? '✓ ok' : '✗ FAILED — ' + JSON.stringify(integrity)}`);
      for (const table of ['businesses', 'conversations', 'messages', 'payments', 'pending_payments']) {
        try {
          const row = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get();
          console.log(`  ${table.padEnd(22)} ${row.n} rows`);
        } catch {
          console.log(`  ${table.padEnd(22)} (not found)`);
        }
      }
    } finally {
      db.close();
    }
  } finally {
    for (const f of [tmpGz, tmpDb]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  }
}

async function verifyUploads(s3) {
  const bucket  = process.env.R2_BUCKET;
  const res     = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'uploads-' }));
  const backups = (res.Contents || [])
    .filter(o => /^uploads-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/.test(o.Key))
    .sort((a, b) => a.Key.localeCompare(b.Key));

  if (!backups.length) {
    console.log('\n⚠️  No uploads backups found in R2.');
    return;
  }

  const latest = backups[backups.length - 1];
  console.log(`\nUploads backups in R2: ${backups.length}`);
  console.log(`Latest: ${latest.Key} (${(latest.Size / 1024 / 1024).toFixed(2)} MB, ${latest.LastModified})\n`);

  const stamp  = Date.now();
  const tmpTar = path.join(os.tmpdir(), `verify-uploads-${stamp}.tar.gz`);

  try {
    process.stdout.write('  Downloading uploads backup...');
    const dlRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latest.Key }));
    await pipeline(dlRes.Body, fs.createWriteStream(tmpTar));
    console.log(' done.');

    // List contents without extracting
    const listing = await new Promise((resolve, reject) => {
      execFile('tar', ['-tzf', tmpTar], (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });

    const files = listing.trim().split('\n').filter(l => l && !l.endsWith('/'));
    console.log(`  Files in archive:    ${files.length}`);
    if (files.length <= 10) {
      files.forEach(f => console.log(`    ${f}`));
    } else {
      files.slice(0, 5).forEach(f => console.log(`    ${f}`));
      console.log(`    ... and ${files.length - 5} more`);
    }
  } finally {
    try { if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar); } catch (_) {}
  }
}

async function main() {
  const s3 = makeS3();
  console.log('=== DB backup ===\n');
  await verifyDb(s3);
  console.log('\n=== Uploads backup ===');
  await verifyUploads(s3);
  console.log('\nDone. Production database was not touched.');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
